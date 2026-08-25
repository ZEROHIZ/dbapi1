/**
 * @file miaoxiangmusic.ts
 * @description 抖音妙响 (Music Astra / music.douyin.com) 音乐创作控制器。
 * 核心功能：
 *   1. 映射妙响模型对照表 (SupportModels)，准确划分纯音乐 BGM (Sway i5.0, SeedMusic i4.0, TemPolor i3.5) 与 歌曲模式。
 *   2. 阶段一：向 /studio_api/create-studio-task 发送音乐创作任务，获得 TaskID。
 *   3. 阶段二：轮询 /studio_api/assets/work?TaskID=...&UserWorkType=2 监测渲染进度 (支持系统超时配置)。
 *   4. 阶段三：调用 /studio_api/video/get-vid-play-info 传入完工 VID，提取高清晰度 .mp3 播放/下载直链并组装 OpenAI 规范响应。
 */

import { PassThrough } from "stream";
import crypto from "crypto";
import _ from "lodash";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import { logRequest } from "@/lib/debug-logger.ts";
import TokenCounter from "@/lib/token-counter.ts";
import systemConfig from "@/lib/configs/system-config.ts";
import { MusicItem } from "./music.ts";

export interface MiaoxiangModelSpec {
    modelName: string;
    modelType: number;
    supportBGM: boolean;
    modelVersion?: string;
}

/**
 * 妙响模型映射表（基于 tests/数据/妙想模型.json）
 * 纯音乐 BGM 模型限定为 3 个：Sway i5.0 (8)、SeedMusic i4.0 (3)、TemPolor i3.5 (6)
 */
export const MIAOXIANG_MODELS: MiaoxiangModelSpec[] = [
    { modelName: "Sway i5.0", modelType: 8, supportBGM: true, modelVersion: "V5" },
    { modelName: "SeedMusic i4.0", modelType: 3, supportBGM: true, modelVersion: "v5.0" },
    { modelName: "TemPolor i3.5", modelType: 6, supportBGM: true, modelVersion: "TemPolor i3.5" },
    { modelName: "Sodance v2.0", modelType: 9, supportBGM: false, modelVersion: "v2.0" },
    { modelName: "MiniMax v2.6", modelType: 10, supportBGM: false, modelVersion: "music-2.6" },
    { modelName: "TemPolor v4.1a", modelType: 5, supportBGM: false, modelVersion: "TemPolor v4.1a" },
    { modelName: "音潮 v3.0", modelType: 1, supportBGM: false, modelVersion: "v3.0" },
    { modelName: "SeedMusic v4.3+", modelType: 2, supportBGM: false, modelVersion: "v4.3" },
    { modelName: "TemPolor v4.0", modelType: 4, supportBGM: false, modelVersion: "TemPolor v4.0" },
    { modelName: "Sway v5.5", modelType: 7, supportBGM: false, modelVersion: "V5_5" }
];

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

const FAKE_HEADERS = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Content-Type": "application/json",
    Origin: "https://music.douyin.com",
    Referer: "https://music.douyin.com/studio/create",
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

/**
 * 匹配妙响模型 Spec
 * 若未传入、或为 doubao-music / default 等非妙响专属名字，则默认映射至 Sway i5.0 (ModelType 8)
 */
export function findMiaoxiangModel(modelName?: string): MiaoxiangModelSpec {
    if (!modelName || modelName === "doubao-music" || modelName === "default") {
        return MIAOXIANG_MODELS[0]; // 默认 Sway i5.0
    }

    const normalized = modelName.trim().toLowerCase();
    const matched = MIAOXIANG_MODELS.find(m => 
        m.modelName.toLowerCase() === normalized || 
        m.modelName.replace(/\s+/g, "").toLowerCase() === normalized.replace(/\s+/g, "")
    );

    return matched || MIAOXIANG_MODELS[0];
}

async function request(method: string, uri: string, context: AccountContext, options: AxiosRequestConfig = {}) {
    const requestConfig: AxiosRequestConfig = {
        method,
        url: `https://music.douyin.com${uri}`,
        params: {
            msToken: generateFakeMsToken(),
            a_bogus: generateFakeABogus(),
            ...(options.params || {})
        },
        headers: {
            ...FAKE_HEADERS,
            Cookie: generateCookie(context.token),
            ...(options.headers || {}),
        },
        timeout: 20000,
        validateStatus: () => true,
        ..._.omit(options, "params", "headers"),
    };

    logger.info(`[Miaoxiang Music Request] ${method.toUpperCase()} ${uri}`);
    logRequest(requestConfig.method || method, requestConfig.url || uri, requestConfig.params, requestConfig.headers, requestConfig.data);

    const response = await axios.request(requestConfig);
    return checkResult(response);
}

function checkResult(result: AxiosResponse) {
    if (!result.data) return null;
    const { baseResp, data, errorCode, errorMsg } = result.data;
    if (baseResp && baseResp.errorCode !== 0) {
        throw new APIException(EX.API_REQUEST_FAILED, `[请求抖音妙响失败]: ${baseResp.errorMsg || baseResp.errorCode}`);
    }
    if (_.isFinite(errorCode) && errorCode !== 0) {
        throw new APIException(EX.API_REQUEST_FAILED, `[请求抖音妙响失败]: ${errorMsg || errorCode}`);
    }
    return data !== undefined ? data : result.data;
}

function tokenSplit(authorization: string) {
    return authorization.replace("Bearer ", "").split(",");
}

/**
 * 阶段一：提交妙响创作任务 (POST /studio_api/create-studio-task)
 */
async function createStudioTask(musicParams: MusicParams, modelSpec: MiaoxiangModelSpec, context: AccountContext): Promise<string> {
    const jsonBody = {
        TaskType: 46,
        StudioInspiredCreationParams: {
            BGM: modelSpec.supportBGM,
            Prompt: musicParams.prompt,
            StudioCreationModel: modelTypeToCreationModel(modelSpec.modelType),
            Lyric: musicParams.lyric || ""
        }
    };

    const res = await request("POST", "/studio_api/create-studio-task", context, {
        data: jsonBody
    });

    const taskId = res?.TaskID || res?.task_id || "";
    if (!taskId) {
        throw new APIException(EX.API_REQUEST_FAILED, "RETRY_GENERATION_EMPTY: 妙响提交任务未能获取有效 TaskID");
    }
    logger.info(`[Miaoxiang] 创作任务提交成功，TaskID: ${taskId}`);
    return taskId;
}

function modelTypeToCreationModel(modelType: number): number {
    return modelType;
}

interface CompletedWork {
    vid: string;
    workId: string;
    title?: string;
    cover?: string;
    summary?: string;
    lyrics?: string;
}

import AccountManager from "@/lib/account-manager.ts";

/**
 * 阶段二：轮询作品渲染进度 (GET /studio_api/assets/work)
 * 优先读取系统配置 AccountManager.getSettings().musicTimeout (默认 180 秒)
 */
async function pollForCompletedWorks(taskId: string, context: AccountContext): Promise<CompletedWork[]> {
    const startTime = Date.now();
    const settings = AccountManager.getSettings();
    const timeoutMs = settings.musicTimeout || systemConfig.musicTimeout || 180000;

    logger.info(`[Miaoxiang] 开始轮询资产状态，超时限制: ${timeoutMs / 1000} 秒...`);

    while (Date.now() - startTime < timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        try {
            const res = await request("GET", "/studio_api/assets/work", context, {
                params: {
                    TaskID: taskId,
                    UserWorkType: "2"
                }
            });

            const userWorks = res?.UserWorks || [];
            const completed: CompletedWork[] = [];

            for (const w of userWorks) {
                const status = w.Status;
                const vid = w.VID || "";
                if (status === 3 && vid) {
                    completed.push({
                        vid,
                        workId: w.WorkID || "",
                        title: w.Title || "",
                        cover: w.CoverInfo?.Large || w.CoverInfo?.Thumb || w.Cover || "",
                        summary: w.Summary || "",
                        lyrics: w.LyricsDetail?.Lrc || w.Lyrics || ""
                    });
                }
            }

            if (completed.length > 0) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                logger.success(`[Miaoxiang] 任务 ${taskId} 渲染完成！耗时 ${elapsed} 秒，已获取 ${completed.length} 个完工 VID`);
                return completed;
            }
        } catch (err: any) {
            logger.warn(`[Miaoxiang] 轮询 TaskID ${taskId} 遇到临时错误: ${err?.message || err}`);
        }
    }

    throw new APIException(EX.API_REQUEST_FAILED, `RETRY_GENERATION_EMPTY: 妙响音乐生成在 ${timeoutMs / 1000} 秒内未渲染完成`);
}

/**
 * 阶段三：通过 VID 批量调取 get-vid-play-info 提取 MP3 直链并组装 MusicItem
 */
async function fetchMp3PlayInfos(completedWorks: CompletedWork[], context: AccountContext): Promise<MusicItem[]> {
    const vids = completedWorks.map(w => w.vid);
    const res = await request("POST", "/studio_api/video/get-vid-play-info", context, {
        data: { Vids: vids }
    });

    const mp3Urls = res?.VideoInfos?.Mp3PlayUrls || {};
    const originUrls = res?.OriginPlayUrls || {};

    const items: MusicItem[] = [];
    for (const w of completedWorks) {
        const playUrl = mp3Urls[w.vid] || originUrls[w.vid] || "";
        if (playUrl) {
            items.push({
                video_id: w.vid,
                url: playUrl,
                cover: w.cover,
                title: w.title,
                lyric: w.lyrics
            });
        }
    }

    return items;
}

function buildMusicResponse(convId: string, modelName: string, music: MusicItem[]) {
    const md = music
        .map((item, index) => {
            const title = item.title || `妙响音乐 ${index + 1}`;
            const lines = [`### 🎵 ${title}`];
            if (item.cover) lines.push(`![cover](${item.cover})`);
            if (item.url) lines.push(`音频播放与下载地址: ${item.url}`);
            if (item.lyric) lines.push(`\n**歌词详情**:\n\`\`\`lrc\n${item.lyric}\n\`\`\``);
            return lines.join("\n\n");
        })
        .join("\n\n---\n\n");

    return {
        id: convId,
        model: modelName,
        object: "chat.completion",
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content: md,
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

/**
 * 主入口：创建妙响音乐生成任务 (非流式响应)
 */
async function createMusicCompletion(
    musicParams: MusicParams,
    account: any,
    assistantId?: string,
    retryCount = 0,
    autoDelete = true
) {
    const context = normalizeAccount(account);
    const modelSpec = findMiaoxiangModel(musicParams.model);
    
    logger.info(`[Miaoxiang Music] 开始生成音乐，模型: ${modelSpec.modelName} (ModelType: ${modelSpec.modelType}, PureBGM: ${modelSpec.supportBGM})`);

    // 1. 提交任务获取 TaskID
    const taskId = await createStudioTask(musicParams, modelSpec, context);

    // 2. 轮询获取已完成的 VID 列表
    const completedWorks = await pollForCompletedWorks(taskId, context);

    // 3. 获取 .mp3 直链
    const musicItems = await fetchMp3PlayInfos(completedWorks, context);

    if (musicItems.length === 0) {
        throw new APIException(EX.API_REQUEST_FAILED, "RETRY_GENERATION_EMPTY: 未能成功解析出 MP3 播放链接");
    }

    const promptTokens = TokenCounter.estimateTokens(musicParams.prompt || "");
    if (account?.id) {
        TokenCounter.recordUsage(account.id, promptTokens, 0);
    }

    return buildMusicResponse(taskId, modelSpec.modelName, musicItems);
}

/**
 * 主入口：创建妙响音乐生成任务 (SSE 流式包装响应)
 */
async function createMusicCompletionStream(
    musicParams: MusicParams,
    account: any,
    assistantId?: string,
    retryCount = 0,
    autoDelete = true
) {
    const result = await createMusicCompletion(musicParams, account, assistantId, retryCount, autoDelete);
    const stream = new PassThrough();
    
    stream.write(`data: ${JSON.stringify({
        id: result.id,
        model: result.model,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: result.choices[0].message.content }, finish_reason: null }],
        created: result.created
    })}\n\n`);
    
    stream.end(`data: ${JSON.stringify({
        id: result.id,
        model: result.model,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: result.usage,
        created: result.created
    })}\n\ndata: [DONE]\n\n`);
    
    return stream;
}

async function getTokenLiveStatus(refreshToken: string) {
    const context = normalizeAccount(refreshToken);
    try {
        const result = await request("GET", "/studio_api/assets/work", context, {
            params: { UserWorkType: "2" }
        });
        return !!result;
    } catch {
        return false;
    }
}

export default {
    createMusicCompletion,
    createMusicCompletionStream,
    getTokenLiveStatus,
    tokenSplit,
    MIAOXIANG_MODELS,
    findMiaoxiangModel,
};
