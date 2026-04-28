import { PassThrough } from "stream";
import crypto from "crypto";
import _ from "lodash";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import { createParser } from "eventsource-parser";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import { logRequest } from "@/lib/debug-logger.ts";
import AccountManager from "@/lib/account-manager.ts";
import TokenCounter from "@/lib/token-counter.ts";

const MODEL_NAME = "doubao-music";
const DEFAULT_ASSISTANT_ID = "497858";
const VERSION_CODE = "20800";
const PC_VERSION = "2.44.0";

interface AccountContext {
    token: string;
    deviceId: string;
    webId: string;
    userId: string;
}

interface MusicParams {
    model?: string;
    prompt: string;
    lyric?: string;
    theme?: string;
    mood?: string;
    genre?: string;
    gender?: string;
    generation_type?: string;
}

export interface MusicItem {
    video_id?: string;
    url?: string;
    cover?: string;
    title?: string;
    lyric?: string;
}

const FAKE_HEADERS = {
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-control": "no-cache",
    "Last-event-id": "undefined",
    Origin: "https://www.doubao.com",
    Pragma: "no-cache",
    Priority: "u=1, i",
    Referer: "https://www.doubao.com",
    "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
};

function normalizeAccount(account: string | any): AccountContext {
    if (typeof account === "string") {
        return {
            token: account,
            deviceId: `7${util.generateRandomString({ length: 18, charset: "numeric" })}`,
            webId: `7${util.generateRandomString({ length: 18, charset: "numeric" })}`,
            userId: util.uuid(false)
        };
    }
    return {
        token: account.token,
        deviceId: account.deviceId || `7${util.generateRandomString({ length: 18, charset: "numeric" })}`,
        webId: account.webId || `7${util.generateRandomString({ length: 18, charset: "numeric" })}`,
        userId: account.userId || util.uuid(false)
    };
}

async function acquireToken(refreshToken: string): Promise<string> {
    return refreshToken;
}

function generateFakeMsToken() {
    return crypto.randomBytes(96)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
}

function generateFakeABogus() {
    return `mf-${util.generateRandomString({ length: 34 })}-${util.generateRandomString({ length: 6 })}`;
}

function generateCookie(refreshToken: string) {
    return [
        `sessionid=${refreshToken}`,
        `sessionid_ss=${refreshToken}`,
    ].join("; ");
}

async function removeConversation(convId: string, context: AccountContext) {
    if (!convId || convId === "0") return;
    try {
        await request("POST", "/samantha/thread/delete", context, {
            params: {
                msToken: generateFakeMsToken(),
                a_bogus: generateFakeABogus()
            },
            data: {
                conversation_id: convId
            },
            headers: {
                Referer: `https://www.doubao.com/chat/${convId}`,
                "agw-js-conv": "str"
            }
        });
        logger.success(`[Music] 会话 ${convId} 删除成功`);
    } catch (err) {
        logger.error(`[Music] 删除会话 ${convId} 失败:`, err);
    }
}

async function request(method: string, uri: string, context: AccountContext, options: AxiosRequestConfig = {}) {
    const token = await acquireToken(context.token);
    const requestConfig: AxiosRequestConfig = {
        method,
        url: `https://www.doubao.com${uri}`,
        params: {
            aid: DEFAULT_ASSISTANT_ID,
            device_id: context.deviceId,
            device_platform: "web",
            language: "zh",
            pc_version: PC_VERSION,
            pkg_type: "release_version",
            real_aid: DEFAULT_ASSISTANT_ID,
            region: "CN",
            samantha_web: 1,
            sys_region: "CN",
            tea_uuid: context.webId,
            "use-olympus-account": 1,
            version_code: VERSION_CODE,
            web_id: context.webId,
            web_tab_id: util.uuid(),
            ...(options.params || {})
        },
        headers: {
            ...FAKE_HEADERS,
            Cookie: generateCookie(token),
            "X-Flow-Trace": `04-${util.uuid()}-${util.uuid().substring(0, 16)}-01`,
            ...(options.headers || {}),
        },
        timeout: 15000,
        validateStatus: () => true,
        ..._.omit(options, "params", "headers"),
    };

    logger.info(`[Music Request] DeviceID: ${context.deviceId} | WebID: ${context.webId}`);
    logRequest(requestConfig.method || method, requestConfig.url || uri, requestConfig.params, requestConfig.headers, requestConfig.data);

    const response = await axios.request(requestConfig);
    if (options.responseType === "stream") return response;
    return checkResult(response);
}

function checkResult(result: AxiosResponse) {
    if (!result.data) return null;
    const { code, msg, data } = result.data;
    if (!_.isFinite(code)) return result.data;
    if (code === 0) return data;
    throw new APIException(EX.API_REQUEST_FAILED, `[请求doubao失败]: ${msg || "未知错误"}`);
}

function tokenSplit(authorization: string) {
    return authorization.replace("Bearer ", "").split(",");
}

function extractConversationId(raw: string) {
    if (!raw) return "";
    const match = raw.match(/\\?"conversation_id\\?":\\?"(\d+)\\?"/);
    return match?.[1] || "";
}

function parseMaybeJson(value: any): any {
    if (typeof value !== "string") return value;
    const parsed = _.attempt(() => JSON.parse(value));
    return _.isError(parsed) ? value : parsed;
}

function walk(value: any, visitor: (obj: any) => void) {
    if (!value || typeof value !== "object") return;
    visitor(value);
    if (Array.isArray(value)) {
        value.forEach(item => walk(item, visitor));
        return;
    }
    Object.values(value).forEach(item => walk(parseMaybeJson(item), visitor));
}

function collectVideoIds(payload: any) {
    const ids = new Set<string>();
    if (typeof payload === "string") {
        const matches = payload.match(/\bv\d[0-9a-z]{20,}\b/g) || [];
        matches.forEach(id => ids.add(id));
    }
    walk(parseMaybeJson(payload), (obj) => {
        const candidates = [
            obj.video_id,
            obj.videoId,
            obj.vid,
            obj.video?.video_id,
            obj.video?.vid,
            obj.music?.video_id,
            obj.music?.vid,
            obj.bigmusic?.video_id,
            obj.bigmusic?.vid,
        ];
        candidates
            .filter((id) => typeof id === "string" && /^v\d[0-9a-z]{20,}$/.test(id))
            .forEach((id) => ids.add(id));
    });
    return [...ids];
}

function firstString(...values: any[]) {
    return values.find((v) => typeof v === "string" && v.trim().length > 0);
}

function collectMusicUrls(payload: any) {
    const urls = new Set<string>();
    walk(parseMaybeJson(payload), (obj) => {
        [
            obj.url,
            obj.play_url,
            obj.audio_url,
            obj.music_url,
            obj.video_url,
            obj.download_url,
            obj.main_url,
            obj.main,
            obj.play_addr?.url,
            obj.play_addr?.uri,
            obj.audio?.url,
            obj.audio?.play_url,
            obj.video?.url,
            obj.video?.play_url,
        ]
            .filter((url) => typeof url === "string" && /^https?:\/\//i.test(url))
            .forEach((url) => urls.add(url));
    });
    return [...urls];
}

function buildMusicItem(videoId: string, payload: any): MusicItem {
    const urls = collectMusicUrls(payload);
    let cover = "";
    walk(parseMaybeJson(payload), (obj) => {
        cover = cover || firstString(
            obj.cover,
            obj.cover_url,
            obj.image_url,
            obj.video_cover?.url,
            obj.cover?.image_preview?.url,
            obj.cover?.image_thumb?.url,
        ) || "";
    });
    return _.pickBy({
        video_id: videoId,
        url: urls[0],
        cover: cover || undefined,
        title: firstString(payload?.title, payload?.name, payload?.music?.title),
        lyric: firstString(payload?.lyric, payload?.lyrics, payload?.music?.lyric)
    }, (value) => value !== undefined && value !== "") as MusicItem;
}

async function getMusicVideo(videoId: string, context: AccountContext, convId = ""): Promise<MusicItem> {
    const response = await request("POST", "/alice/media/bigmusic/get_video", context, {
        params: {
            msToken: generateFakeMsToken(),
            a_bogus: generateFakeABogus()
        },
        data: { video_id: videoId },
        headers: {
            Accept: "application/json, text/plain, */*",
            "Content-Type": "application/json",
            Referer: convId ? `https://www.doubao.com/chat/${convId}` : "https://www.doubao.com/chat/",
            "agw-js-conv": "str"
        },
        timeout: 60000
    });
    return buildMusicItem(videoId, response);
}

async function pollForMusicResult(convId: string, context: AccountContext, timeoutMs = 120000): Promise<MusicItem[]> {
    const startTime = Date.now();
    const emitted = new Set<string>();

    while (Date.now() - startTime < timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const response = await request("POST", "/im/chain/single", context, {
            params: {
                version_code: VERSION_CODE,
                language: "zh",
                device_platform: "web",
                aid: DEFAULT_ASSISTANT_ID,
                device_id: context.deviceId,
                web_id: context.webId,
                web_tab_id: util.uuid(),
            },
            data: {
                cmd: 3100,
                uplink_body: {
                    pull_singe_chain_uplink_body: {
                        conversation_id: convId,
                        anchor_index: 9007199254740991,
                        conversation_type: 3,
                        direction: 1,
                        limit: 20,
                        ext: { pull_single_chain_scene: "multi_device_red_dot_sync" },
                        filter: { index_list: [] },
                    },
                },
                sequence_id: util.uuid(),
                channel: 2,
                version: "1",
            },
            headers: {
                "Content-Type": "application/json; encoding=utf-8"
            }
        });

        const messages = response?.downlink_body?.pull_singe_chain_downlink_body?.messages || [];
        const ids = new Set<string>();
        for (const msg of messages) {
            collectVideoIds(msg.content).forEach(id => ids.add(id));
        }

        const items: MusicItem[] = [];
        for (const id of ids) {
            if (emitted.has(id)) continue;
            emitted.add(id);
            const item = await getMusicVideo(id, context, convId);
            if (item.url) items.push(item);
        }
        if (items.length > 0) return items;
    }

    return [];
}

async function receiveInitialStream(stream: any): Promise<{ id: string; content: string; videoIds: string[] }> {
    let temp = Buffer.from("");
    const videoIds = new Set<string>();

    return new Promise((resolve, reject) => {
        const data = { id: "", content: "" };
        let isEnd = false;
        const finish = () => resolve({ ...data, videoIds: [...videoIds] });

        const parser = createParser((event) => {
            try {
                if (event.type !== "event" || isEnd) return;
                const rawResult = _.attempt(() => JSON.parse(event.data));
                if (_.isError(rawResult)) return;
                if (rawResult.code) {
                    throw new APIException(EX.API_REQUEST_FAILED, `[请求doubao失败]: ${rawResult.code}-${rawResult.message}`);
                }
                collectVideoIds(rawResult).forEach(id => videoIds.add(id));
                if (rawResult.conversation_id && !data.id) data.id = rawResult.conversation_id;
                if (rawResult.event_type === 2003) {
                    isEnd = true;
                    return finish();
                }
                if (rawResult.event_type !== 2001) return;
                const result = parseMaybeJson(rawResult.event_data);
                collectVideoIds(result).forEach(id => videoIds.add(id));
                if (result?.conversation_id && !data.id) data.id = result.conversation_id;
                if (result?.is_finish) {
                    isEnd = true;
                    return finish();
                }
                const message = result?.message;
                if (!message?.content) return;
                const content = parseMaybeJson(message.content);
                collectVideoIds(content).forEach(id => videoIds.add(id));
                const text = typeof content === "string"
                    ? content
                    : firstString(content?.text, content?.delta?.text, content?.content);
                if (text) data.content += text;
            } catch (err) {
                reject(err);
            }
        });

        stream.on("data", (buffer: Buffer) => {
            const bufferStr = buffer.toString();
            if (!data.id) {
                const id = extractConversationId(bufferStr);
                if (id) data.id = id;
            }
            collectVideoIds(bufferStr).forEach(id => videoIds.add(id));
            if (bufferStr.indexOf("锟?") !== -1) {
                temp = Buffer.concat([temp, buffer]);
                return;
            }
            if (temp.length > 0) {
                buffer = Buffer.concat([temp, buffer]);
                temp = Buffer.from("");
            }
            parser.feed(buffer.toString());
        });
        stream.once("error", (err: any) => reject(err));
        stream.once("close", () => finish());
    });
}

function buildMusicResponse(convId: string, content: string, music: MusicItem[]) {
    const md = music
        .map((item, index) => {
            const title = item.title || `音乐 ${index + 1}`;
            const lines = [`${title}`];
            if (item.cover) lines.push(`![cover](${item.cover})`);
            if (item.url) lines.push(`音频链接: ${item.url}`);
            return lines.join("\n");
        })
        .join("\n\n");

    return {
        id: convId,
        model: MODEL_NAME,
        object: "chat.completion",
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content: md || content,
                    music
                },
                finish_reason: "stop",
            },
        ],
        created: util.unixTimestamp(),
        usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
        }
    };
}

async function createMusicCompletion(
    musicParams: MusicParams,
    account: any,
    assistantId = DEFAULT_ASSISTANT_ID,
    retryCount = 0,
    autoDelete = true
) {
    const context = normalizeAccount(account);
    const contentJson = JSON.stringify({
        text: musicParams.prompt,
        lyric: musicParams.lyric || "",
        theme: musicParams.theme || "",
        mood: musicParams.mood || "Happy",
        genre: musicParams.genre || "Pop",
        gender: musicParams.gender || "Female",
        generation_type: musicParams.generation_type || (musicParams.lyric ? "text_to_music" : "AI_lyric")
    });

    const response = await request("post", "/samantha/chat/completion", context, {
        data: {
            messages: [{ content: contentJson, content_type: 2005 }],
            completion_option: {
                is_regen: false,
                with_suggest: true,
                need_create_conversation: true,
                launch_stage: 1,
                is_replace: false,
                is_delete: false,
                is_ai_playground: false,
                message_from: 0,
                action_bar_skill_id: 9,
                use_auto_cot: false,
                resend_for_regen: false,
                enable_commerce_credit: false,
                event_id: "0"
            },
            evaluate_option: { web_ab_params: "" },
            conversation_id: "0",
            local_conversation_id: `local_${util.generateRandomString({ length: 16, charset: "numeric" })}`,
            local_message_id: util.uuid()
        },
        headers: {
            Referer: "https://www.doubao.com/chat/",
            "agw-js-conv": "str, str",
        },
        timeout: 300000,
        responseType: "stream"
    });

    const contentType = response.headers["content-type"] || "";
    if (contentType.indexOf("text/event-stream") === -1) {
        throw new APIException(EX.API_REQUEST_FAILED, `Stream response Content-Type invalid: ${contentType}`);
    }

    const initial = await receiveInitialStream(response.data);
    if (!initial.id) {
        throw new APIException(EX.API_REQUEST_FAILED, "RETRY_GENERATION_EMPTY: 音乐会话 ID 为空");
    }

    let music: MusicItem[] = [];
    for (const id of initial.videoIds) {
        const item = await getMusicVideo(id, context, initial.id);
        if (item.url) music.push(item);
    }
    if (music.length === 0) {
        music = await pollForMusicResult(initial.id, context, 120000);
    }
    if (music.length === 0) {
        throw new APIException(EX.API_REQUEST_FAILED, "RETRY_GENERATION_EMPTY: 音乐生成 2 分钟内未返回有效音频链接");
    }

    const promptTokens = TokenCounter.estimateTokens(musicParams.prompt || "");
    const completionTokens = TokenCounter.estimateTokens(initial.content || "");
    if (account?.id) {
        TokenCounter.recordUsage(account.id, promptTokens, completionTokens);
    }

    if (autoDelete) {
        removeConversation(initial.id, context).catch(err => logger.error(`[Music] 删除会话失败: ${err?.message || err}`));
    }

    return buildMusicResponse(initial.id, initial.content, music);
}

async function createMusicCompletionStream(
    musicParams: MusicParams,
    account: any,
    assistantId = DEFAULT_ASSISTANT_ID,
    retryCount = 0,
    autoDelete = true
) {
    const result = await createMusicCompletion(musicParams, account, assistantId, retryCount, autoDelete);
    const stream = new PassThrough();
    stream.write(`data: ${JSON.stringify({
        id: result.id,
        model: MODEL_NAME,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: result.choices[0].message.content }, finish_reason: null }],
        created: result.created
    })}\n\n`);
    stream.end(`data: ${JSON.stringify({
        id: result.id,
        model: MODEL_NAME,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: result.usage,
        created: result.created
    })}\n\ndata: [DONE]\n\n`);
    return stream;
}

async function getTokenLiveStatus(refreshToken: string) {
    const context = normalizeAccount(refreshToken);
    const result = await request("POST", "/passport/account/info/v2", context, {
        params: { account_sdk_source: "web" }
    });
    return !!(result && (result as any).user_id);
}

export default {
    createMusicCompletion,
    createMusicCompletionStream,
    getTokenLiveStatus,
    tokenSplit,
};
