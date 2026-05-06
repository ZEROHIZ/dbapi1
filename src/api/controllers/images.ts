import {PassThrough} from "stream";
import crypto from "crypto";
import path from "path";
import _ from "lodash";
import mime from "mime";
import axios, {AxiosRequestConfig, AxiosResponse} from "axios";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import {createParser} from "eventsource-parser";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import { logRequest } from "@/lib/debug-logger.ts";
import TokenCounter from "@/lib/token-counter.ts";
import AccountManager from "@/lib/account-manager.ts";

// 模型名称
const MODEL_NAME = "doubao";
// 默认的AgentID
const DEFAULT_ASSISTANT_ID = "497858";
// 版本号
const VERSION_CODE = "20800";
// PC版本（对齐网页端）
const PC_VERSION = "2.44.0";

// 定义账号上下文接口，用于传递指纹信息
interface AccountContext {
    token: string;
    deviceId: string;
    webId: string;
    userId: string;
}

/**
 * 格式化账号信息，确保拥有指纹
 */
function normalizeAccount(account: string | any): AccountContext {
    if (typeof account === "string") {
        return {
            token: account,
            deviceId: `7${util.generateRandomString({length: 18, charset: "numeric"})}`,
            webId: `7${util.generateRandomString({length: 18, charset: "numeric"})}`,
            userId: util.uuid(false)
        };
    }
    return {
        token: account.token,
        deviceId: account.deviceId || `7${util.generateRandomString({length: 18, charset: "numeric"})}`,
        webId: account.webId || `7${util.generateRandomString({length: 18, charset: "numeric"})}`,
        userId: account.userId || util.uuid(false)
    };
}

// 最大重试次数
const MAX_RETRY_COUNT = 3;
// 重试延迟
const RETRY_DELAY = 5000;
// 伪装headers
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
// 文件最大大小
const FILE_MAX_SIZE = 100 * 1024 * 1024;

/**
 * 获取缓存中的access_token
 *
 * 目前doubao的access_token是固定的，暂无刷新功能
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function acquireToken(refreshToken: string): Promise<string> {
    return refreshToken;
}

/**
 * 生成伪msToken
 */
function generateFakeMsToken() {
    const bytes = crypto.randomBytes(96);
    return bytes
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
}

/**
 * 生成伪a_bogus
 */
function generateFakeABogus() {
    return `mf-${util.generateRandomString({
        length: 34,
    })}-${util.generateRandomString({
        length: 6,
    })}`;
}

/**
 * 生成cookie
 */
function generateCookie(refreshToken: string) {
    return [
        `sessionid=${refreshToken}`,
        `sessionid_ss=${refreshToken}`,
    ].join("; ");
}

/**
 * 请求doubao
 *
 * @param method 请求方法
 * @param uri 请求路径
 * @param context 账号上下文
 * @param options 请求选项
 */
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

    logger.info(`[Image Request] DeviceID: ${context.deviceId} | WebID: ${context.webId}`);
    logRequest(requestConfig.method || method, requestConfig.url || uri, requestConfig.params, requestConfig.headers, requestConfig.data);

    const response = await axios.request(requestConfig);
    // 流式响应直接返回response
    if (options.responseType == "stream")
        return response;
    return checkResult(response);
}

/**
 * 校验请求结果
 */
function checkResult(result: AxiosResponse) {
    if (!result.data) return null;
    const { code, msg, data } = result.data;
    if (!_.isFinite(code)) return result.data;
    if (code === 0) return data;
    throw new APIException(EX.API_REQUEST_FAILED, `[请求doubao失败]: ${msg || '未知错误'}`);
}

/**
 * 移除会话
 *
 * 在对话流传输完毕后移除会话，避免创建的会话出现在用户的对话列表中
 *
 * @param convId 会话ID
 * @param context 账号上下文
 */
async function removeConversation(
    convId: string,
    context: AccountContext
) {
    if (!convId || convId === "0") {
        logger.warn(`会话 ID 为空，跳过删除逻辑。`);
        return;
    }
    try {
        // 添加必要的查询参数
        const params = {
            msToken: generateFakeMsToken(),
            a_bogus: generateFakeABogus()
        };

        // 添加必要的请求头
        const headers = {
            Referer: `https://www.doubao.com/chat/${convId}`,
            "Agw-js-conv": "str",
            "Sec-Ch-Ua": "\"Not;A=Brand\";v=\"99\", \"Google Chrome\";v=\"139\", \"Chromium\";v=\"139\""
        };

        await request("POST", "/samantha/thread/delete", context, {
            data: {
                conversation_id: convId
            },
            params,
            headers
        });
        logger.success(`会话 ${convId} 删除成功`);
    } catch (err) {
        logger.error(`删除会话 ${convId} 失败:`, err);
    }
}

/**
 * 根据图片宽高自动推断最接近的标准比例
 */
function detectRatio(width: number, height: number): string {
    const r = width / height;
    const ratios = [
        { ratio: "1:1", value: 1 },
        { ratio: "16:9", value: 16 / 9 },
        { ratio: "9:16", value: 9 / 16 },
        { ratio: "4:3", value: 4 / 3 },
        { ratio: "3:4", value: 3 / 4 },
        { ratio: "3:2", value: 3 / 2 },
        { ratio: "2:3", value: 2 / 3 },
    ];
    let closest = ratios[0];
    let minDiff = Math.abs(r - closest.value);
    for (const entry of ratios) {
        const diff = Math.abs(r - entry.value);
        if (diff < minDiff) {
            minDiff = diff;
            closest = entry;
        }
    }
    return closest.ratio;
}

function createRetryGenerationEmpty(reason: string) {
    return new APIException(EX.API_REQUEST_FAILED, `RETRY_GENERATION_EMPTY: ${reason}`);
}

function isReasonableImageDimension(value: number) {
    return Number.isInteger(value) && value > 0 && value <= 20000;
}

function normalizeImageSize(width?: number, height?: number): { width: number; height: number } | null {
    if (!isReasonableImageDimension(width || 0) || !isReasonableImageDimension(height || 0)) {
        return null;
    }
    return { width: width as number, height: height as number };
}

function getConfiguredImageGenerationDelayMs() {
    const rawDelay = AccountManager.getSettings().imageGenerationDelayMs;
    const delayMs = Number.isFinite(rawDelay) ? Number(rawDelay) : 0;
    return Math.max(0, delayMs);
}

async function waitBeforeImageGenerationIfNeeded() {
    const delayMs = getConfiguredImageGenerationDelayMs();
    if (delayMs <= 0) {
        return;
    }
    logger.info(`参考图已就绪，等待 ${delayMs}ms 后再发起图片生成`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
}

function extractConversationId(raw: string) {
    if (!raw) return "";
    const match = raw.match(/\\?"conversation_id\\?":\\?"(\d+)\\?"/);
    return match?.[1] || "";
}

function extractImageUrlsFromCreations(payload: any, emittedImageKeys: Set<string>) {
    const imageUrls: string[] = [];
    if (!payload || !Array.isArray(payload.creations)) {
        return imageUrls;
    }
    payload.creations.forEach((creation: any) => {
        const img = creation?.image || {};
        const key = img?.key as string | undefined;
        // 优先使用 image_ori_raw (原图无水印)，依次降级
        const finalUrl = img?.image_ori_raw?.url || img?.image_ori?.url || img?.image_preview?.url || img?.image_thumb?.url;
        if (key && finalUrl && !emittedImageKeys.has(key)) {
            emittedImageKeys.add(key);
            imageUrls.push(finalUrl);
        }
    });
    return imageUrls;
}

async function pollForImageResult(convId: string, context: AccountContext, timeoutMs: number = 180000): Promise<string[]> {
    const defaultTimeout = AccountManager.getSettings().videoTimeout || 180000;
    const finalTimeout = timeoutMs > 0 ? timeoutMs : defaultTimeout;
    const startTime = Date.now();
    const emittedImageKeys = new Set<string>();
    let retryCount = 0;

    while (Date.now() - startTime < finalTimeout) {
        try {
            await new Promise(resolve => setTimeout(resolve, 5000));

            const params = {
                version_code: VERSION_CODE,
                language: 'zh',
                device_platform: 'web',
                aid: DEFAULT_ASSISTANT_ID,
                device_id: context.deviceId,
                web_id: context.webId,
                web_tab_id: util.uuid(),
            };

            const postData = {
                cmd: 3100,
                uplink_body: {
                    pull_singe_chain_uplink_body: {
                        conversation_id: convId,
                        anchor_index: 9007199254740991,
                        conversation_type: 3,
                        direction: 1,
                        limit: 20,
                        ext: {
                            pull_single_chain_scene: 'multi_device_red_dot_sync',
                        },
                        filter: {
                            index_list: [],
                        },
                    },
                },
                sequence_id: util.uuid(),
                channel: 2,
                version: '1',
            };

            logger.info(`[轮询图片] 请求参数: convId=${convId}, cmd=3100`);
            const response = await request("POST", "/im/chain/single", context, {
                params,
                data: postData,
                headers: {
                    "Content-Type": "application/json; encoding=utf-8"
                }
            });

            if (response?.downlink_body?.pull_singe_chain_downlink_body) {
                const messages = response.downlink_body.pull_singe_chain_downlink_body.messages || [];
                logger.info(`[轮询图片] 获取到 ${messages.length} 条消息`);
                const imageUrls: string[] = [];

                for (const msg of messages) {
                    let contentObj: any = null;
                    if (typeof msg.content === 'string') {
                        contentObj = _.attempt(() => JSON.parse(msg.content));
                    } else {
                        contentObj = msg.content;
                    }
                    if (_.isError(contentObj) || !contentObj) continue;

                    const directUrls = extractImageUrlsFromCreations(contentObj, emittedImageKeys);
                    if (directUrls.length > 0) {
                        imageUrls.push(...directUrls);
                    }

                    const blocks = Array.isArray(contentObj) ? contentObj : (contentObj.content_block || []);
                    for (const block of blocks) {
                        if (block?.block_type !== 2074) continue;
                        const blockUrls = extractImageUrlsFromCreations(block?.content?.creation_block, emittedImageKeys);
                        if (blockUrls.length > 0) {
                            imageUrls.push(...blockUrls);
                        }
                    }
                }

                if (imageUrls.length > 0) {
                    logger.success(`轮询成功，获取到 ${imageUrls.length} 张图片`);
                    return imageUrls;
                }
            }

            logger.info(`[轮询图片] 第 ${++retryCount} 次尝试，暂无结果...`);
        } catch (err) {
            logger.error(`[轮询图片] 出错:`, err);
        }
    }

    return [];
}

/**
 * 同步图片生成补全（对齐官方请求格式，新增extra字段）
 * @param imageParams 图片生成参数 {model, prompt, ratio, style, referenceImage, genModel?: string}
 * @param account 账号信息对象或refreshToken字符串
 * @param assistantId 智能体ID
 * @param retryCount 重试次数
 */
async function createImageCompletion(
    imageParams: {
        model: string;
        prompt: string;
        ratio?: string;
        style: string;
        referenceImage?: string | string[];
        genModel?: string;
    },
    account: any,
    assistantId = DEFAULT_ASSISTANT_ID,
    retryCount = 0,
    autoDelete = true
) {
    return (async () => {
        let {prompt, ratio, style, referenceImage, model, genModel} = imageParams;
        if (!genModel) {
            genModel = AccountManager.getMappedModel((account as any).id, model);
        }
        logger.info(`收到图片生成请求：prompt=${prompt}, ratio=${ratio}, style=${style}, 参考图=${!!referenceImage}, 生图模型=${genModel}`);
        const context = normalizeAccount(account);

        let attachments: any[] = [];
        if (referenceImage) {
            const refImages = Array.isArray(referenceImage) ? referenceImage : [referenceImage];
            try {
                const uploadResults = await Promise.all(
                    refImages.map(img => uploadFile(img, context))
                );
                for (const refImage of uploadResults) {
                    if (refImage && refImage.file_url?.url) {
                        attachments.push({
                            type: "image",
                            key: refImage.file_url.url,
                            extra: {
                                refer_types: "overall"
                            },
                            identifier: util.uuid(),
                        });
                        logger.info(`参考图上传成功：${refImage.file_url.url}`);
                    }
                }
                if (!ratio && uploadResults.length > 0 && uploadResults[0]) {
                    const firstImage = uploadResults[0];
                    const size = normalizeImageSize(firstImage.width, firstImage.height);
                    if (size) {
                        ratio = detectRatio(size.width, size.height);
                        logger.info(`根据参考图尺寸自动设置比例: ${ratio} (${size.width}x${size.height})`);
                    } else {
                        logger.warn(`参考图尺寸异常，跳过自动比例推断: ${firstImage.width}x${firstImage.height}`);
                    }
                }
            } catch (err: any) {
                logger.error(`参考图上传失败：${err.message}`);
                throw new APIException(EX.API_REQUEST_FAILED, "参考图上传失败");
            }
        }
        if (!ratio) ratio = "1:1";

        if (attachments.length > 0) {
            await waitBeforeImageGenerationIfNeeded();
        }

        const contentJson = JSON.stringify({
            text: `帮我生成图片：${prompt}\n风格：${style}\n比例：${ratio}`,
            model: genModel,
            template_type: "placeholder",
            use_creation: false
        });

        const imageMessage = [
            {
                content: contentJson,
                content_type: 2009,
                attachments: attachments,
            },
        ];

        const response = await request("post", "/samantha/chat/completion", context, {
            data: {
                messages: imageMessage,
                completion_option: {
                    is_regen: false,
                    with_suggest: false,
                    need_create_conversation: true,
                    launch_stage: 1,
                    is_replace: false,
                    is_delete: false,
                    message_from: 0,
                    action_bar_skill_id: 3,
                    use_auto_cot: false,
                    resend_for_regen: false,
                    enable_commerce_credit: false,
                    event_id: "0"
                },
                evaluate_option: {
                    web_ab_params: ""
                },
                conversation_id: "0",
                local_conversation_id: `local_${util.generateRandomString({length: 16, charset: "numeric"})}`,
                local_message_id: util.uuid()
            },
            headers: {
                Referer: "https://www.doubao.com/chat/",
                "agw-js-conv": "str, str",
            },
            timeout: 300000,
            responseType: "stream"
        });

        if (response.status !== 200) {
            let errorMsg = `HTTP ${response.status} ${response.statusText}`;
            if (response.data && response.data.on) {
                const errData = await new Promise((resolve) => {
                    response.data.once("data", (chunk: Buffer) => resolve(chunk.toString()));
                    setTimeout(() => resolve("timeout"), 1000);
                });
                errorMsg += ` - ${errData}`;
            }
            throw new APIException(EX.API_REQUEST_FAILED, `[请求doubao失败]: ${errorMsg}`);
        }
        const contentType = response.headers["content-type"] || "";
        if (contentType.indexOf("text/event-stream") === -1) {
            response.data.on("data", (buffer) => logger.error(buffer.toString()));
            throw new APIException(
                EX.API_REQUEST_FAILED,
                `Stream response Content-Type invalid: ${response.headers["content-type"]}`
            );
        }

        const streamStartTime = util.timestamp();
        const answer = await receiveStream(response.data);
        if (!answer.id) {
            logger.warn(`图片生成流提前结束，未获取到会话 ID，耗时 ${util.timestamp() - streamStartTime}ms`);
            throw createRetryGenerationEmpty("会话 ID 为空，说明生成失败需重试");
        }

        if (!Array.isArray(answer.choices[0].message.images) || answer.choices[0].message.images.length === 0) {
            logger.warn(`图片生成流结束但未拿到图片，进入轮询补偿：convId=${answer.id}`);
            const polledImages = await pollForImageResult(answer.id, context);
            if (polledImages.length === 0) {
                logger.warn(`图片轮询超时仍无结果：convId=${answer.id}`);
                throw createRetryGenerationEmpty("会话 ID 已获取但未返回最终图片，轮询后仍无结果需重试");
            }
            answer.choices[0].message.images = polledImages;
        }

        logger.success(`图片生成完成 ${util.timestamp() - streamStartTime}ms，convId=${answer.id}，images=${answer.choices[0].message.images.length}`);

        const accountId = (account as any).id;
        if (accountId) {
            AccountManager.updateAccountUsage(accountId, 'image', 0, 0);
            TokenCounter.recordUsage(accountId, 0, 0);
        }
        answer.usage = {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
        };

        if (autoDelete) {
            removeConversation(answer.id, context).catch(
                (err) => console.error('移除图片生成会话失败：', err)
            );
        }

        return answer;
    })().catch((err) => {
        logger.error(`图片生成流响应错误: ${err.stack || String(err)}`);
        throw err;
    });
}

/**
 * 流式图片生成补全（新增参考图支持）
 * @param imageParams 图片生成参数 {model, prompt, ratio, style, referenceImage}
 * @param account 账号信息对象或refreshToken字符串
 * @param assistantId 智能体ID
 * @param retryCount 重试次数
 */
async function createImageCompletionStream(
    imageParams: { model: string; prompt: string; ratio?: string; style: string; referenceImage?: string | string[]; genModel?: string },
    account: any,
    assistantId = DEFAULT_ASSISTANT_ID,
    retryCount = 0,
    autoDelete = true
) {
    return (async () => {
        let {prompt, ratio, style, referenceImage, model, genModel} = imageParams;
        if (!genModel) {
            genModel = AccountManager.getMappedModel((account as any).id, model);
        }
        logger.info(`收到流式图片生成请求：prompt=${prompt}, ratio=${ratio}, style=${style}, 参考图=${!!referenceImage}, 生图模型=${genModel}`);
        const context = normalizeAccount(account);

        let attachments: any[] = [];
        if (referenceImage) {
            const refImages = Array.isArray(referenceImage) ? referenceImage : [referenceImage];
            try {
                const uploadResults = await Promise.all(
                    refImages.map(img => uploadFile(img, context))
                );
                for (const refImage of uploadResults) {
                    if (refImage && refImage.file_url?.url) {
                        attachments.push({
                            type: "vlm_image",
                            identifier: util.uuid(),
                            name: refImage.name || "reference-image.png",
                            key: refImage.file_url.url,
                            file_review_state: 3,
                            file_parse_state: 3,
                            option: {width: refImage.width || 1, height: refImage.height || 1},
                        });
                        logger.info(`参考图上传成功：${refImage.file_url.url}`);
                    }
                }
                if (!ratio && uploadResults.length > 0 && uploadResults[0]) {
                    const firstImage = uploadResults[0];
                    const size = normalizeImageSize(firstImage.width, firstImage.height);
                    if (size) {
                        ratio = detectRatio(size.width, size.height);
                        logger.info(`根据参考图尺寸自动设置比例: ${ratio} (${size.width}x${size.height})`);
                    } else {
                        logger.warn(`参考图尺寸异常，跳过自动比例推断: ${firstImage.width}x${firstImage.height}`);
                    }
                }
            } catch (err: any) {
                logger.error(`参考图上传失败：${err.message}`);
                throw new APIException(EX.API_REQUEST_FAILED, "参考图上传失败");
            }
        }
        if (!ratio) ratio = "1:1"; // 最终默认值

        if (attachments.length > 0) {
            await waitBeforeImageGenerationIfNeeded();
        }

        const imageMessage = [
            {
                content: JSON.stringify({
                    text: `${prompt}\n风格：${style}\n比例：${ratio}`,
                    model: genModel,
                    template_type: "placeholder",
                    use_creation: false
                }),
                content_type: 2009,
                attachments: attachments, // 注入参考图
                references: [],
            },
        ];

        const response = await request("post", "/samantha/chat/completion", context, {
            data: {
                messages: imageMessage,
                completion_option: {
                    is_regen: false,
                    with_suggest: false,
                    need_create_conversation: true,
                    launch_stage: 1,
                    is_replace: false,
                    is_delete: false,
                    message_from: 0,
                    action_bar_skill_id: 0,
                    use_deep_think: false,
                    use_auto_cot: false,
                    resend_for_regen: false,
                    enable_commerce_credit: false,
                    event_id: "0"
                },
                evaluate_option: {web_ab_params: ""},
                section_id: `26${util.generateRandomString({length: 16, charset: "numeric"})}`,
                conversation_id: "0",
                local_conversation_id: `local_16${util.generateRandomString({length: 14, charset: "numeric"})}`,
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
            logger.error(`无效的响应Content-Type: ${response.headers["content-type"]}`);
            response.data.on("data", (buffer) => logger.error(buffer.toString()));
            const transStream = new PassThrough();
            transStream.end(
                `data: ${JSON.stringify({
                    id: "",
                    model: MODEL_NAME,
                    object: "image.completion.chunk",
                    choices: [
                        {
                            index: 0,
                            delta: {
                                content: "服务暂时不可用，第三方响应错误",
                            },
                            finish_reason: "stop",
                        },
                    ],
                    created: util.unixTimestamp(),
                })}\n\n`
            );
            return transStream;
        }

        const streamStartTime = util.timestamp();
        return createTransStream(response.data, context, ({ convId, imageCount, success, reason }) => {
            if (success) {
                logger.success(`流式图片生成完成 ${util.timestamp() - streamStartTime}ms，convId=${convId}，images=${imageCount}`);
                const accountId = (account as any).id;
                if (accountId) {
                    AccountManager.updateAccountUsage(accountId, 'image', 0, 0);
                    TokenCounter.recordUsage(accountId, 0, 0);
                }
                if (autoDelete) {
                    removeConversation(convId, context).catch(
                        (err) => console.error(err)
                    );
                }
                return;
            }
            logger.warn(`流式图片生成失败 ${util.timestamp() - streamStartTime}ms，convId=${convId || 'EMPTY'}，reason=${reason || 'unknown'}`);
        }, account, autoDelete);
    })().catch((err) => {
        logger.error(`流式图片生成响应错误: ${err.stack || String(err)}`);
        throw err;
    });
}

/**
 * 日志脱敏：避免打印出图片的 base64 或 data:URI
 * @param s
 */
function maskBase64InString(s: string): string {
    if (!s) return s;
    try {
        let t = s;
        // 掩码 data:xxx;base64, 后面的内容
        t = t.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/g, (m) => {
            return `data:...;base64,[OMITTED,len=${m.length}]`;
        });
        // 掩码超长的 base64-like 字符串
        t = t.replace(/[A-Za-z0-9+/=]{500,}/g, (m) => `[[OMITTED_BASE64 len=${m.length}]]`);
        return t;
    } catch {
        return s;
    }
}

/**
 * 预检查文件URL有效性
 *
 * @param fileUrl 文件URL
 */
async function checkFileUrl(fileUrl: string) {
    if (util.isBASE64Data(fileUrl)) return;

    const safeUrl = (url: string) => {
        if (util.isBASE64Data(url) || (util.isBASE64(url) && url.length > 300)) {
            return "[base64 data omitted]";
        }
        return url.length > 200 ? url.slice(0, 200) + "..." : url;
    };

    try {
        const result = await axios.head(fileUrl, {
            timeout: 15000,
            validateStatus: () => true,
            headers: {
                "User-Agent": FAKE_HEADERS["User-Agent"],
                "Accept": "*/*",
            },
        });
        // 忽略 405 Method Not Allowed，因为部分服务器（如字节CDN）禁用HEAD请求
        if (result.status >= 400 && result.status !== 405)
            throw new APIException(
                EX.API_FILE_URL_INVALID,
                `File ${safeUrl(fileUrl)} is not valid: [${result.status}] ${result.statusText}`
            );
        // 检查文件大小
        if (result.headers && result.headers["content-length"]) {
            const fileSize = parseInt(result.headers["content-length"], 10);
            if (fileSize > FILE_MAX_SIZE)
                throw new APIException(
                    EX.API_FILE_EXECEEDS_SIZE,
                    `File ${safeUrl(fileUrl)} is not valid`
                );
        }
    } catch (err: any) {
        // 如果是网络错误而非状态码错误，视情况决定是否阻断，这里暂时放行让GET尝试
        logger.warn(`[checkFileUrl] HEAD request failed: ${err.message}, will try GET download anyway.`);
    }
}

const IMAGEX_REGION = "cn-north-1";
const IMAGEX_SERVICE = "imagex";

function rfc3986Encode(str: string) {
    return encodeURIComponent(str).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function sha256Hex(data: any) {
    return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key: any, data: string) {
    return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function amzDates(date = new Date()) {
    const pad = (n: number) => (n < 10 ? "0" + n : String(n));
    const yyyy = date.getUTCFullYear();
    const mm = pad(date.getUTCMonth() + 1);
    const dd = pad(date.getUTCDate());
    const HH = pad(date.getUTCHours());
    const MM = pad(date.getUTCMinutes());
    const SS = pad(date.getUTCSeconds());
    const dateStamp = `${yyyy}${mm}${dd}`;
    const amzDate = `${dateStamp}T${HH}${MM}${SS}Z`;
    return {amzDate, dateStamp};
}

function canonicalQuery(params: Record<string, string>) {
    const keys = Object.keys(params).sort();
    return keys
        .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(params[k] ?? "")}`)
        .join("&");
}

function buildAuthorization(
    method: "GET" | "POST",
    host: string,
    path: string,
    params: Record<string, string>,
    sessionToken: string,
    accessKey: string,
    secretKey: string,
    region = IMAGEX_REGION,
    service = IMAGEX_SERVICE,
    opts?: { payloadHash?: string; signContentSha256?: boolean }
) {
    const {amzDate, dateStamp} = amzDates();
    const canonicalQS = canonicalQuery(params);

    const headersMap: Record<string, string> = {
        host,
        "x-amz-date": amzDate,
    };
    if (sessionToken) headersMap["x-amz-security-token"] = sessionToken;
    const payloadHash = opts?.payloadHash ?? sha256Hex("");
    if (opts?.signContentSha256) headersMap["x-amz-content-sha256"] = payloadHash;

    // Build canonical headers in sorted order
    const headerNames = Object.keys(headersMap).sort();
    const canonicalHeaders = headerNames.map((k) => `${k}:${headersMap[k]}\n`).join("");
    const signedHeaders = headerNames.join(";");

    const canonicalRequest = [
        method,
        path,
        canonicalQS,
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join("\n");

    const algorithm = "AWS4-HMAC-SHA256";
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
        algorithm,
        amzDate,
        credentialScope,
        sha256Hex(canonicalRequest),
    ].join("\n");

    const kDate = hmac("AWS4" + secretKey, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, "aws4_request");
    const signature = crypto
        .createHmac("sha256", kSigning as any)
        .update(stringToSign, "utf8")
        .digest("hex");
    const credential = `${accessKey}/${credentialScope}`;
    const authorization = `${algorithm} Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {authorization, amzDate, payloadHash};
}

async function acquireUploadAuth(context: AccountContext, resourceType: number) {
    const data: any = await request("post", "/alice/resource/prepare_upload", context, {
        data: {tenant_id: "5", scene_id: "5", resource_type: resourceType},
        headers: {"agw-js-conv": "str"},
    });
    logger.info(`[UploadAuth] serviceId=${data?.service_id}, upload_host=${data?.upload_host}`);
    if (!data || !data.upload_auth_token)
        throw new APIException(EX.API_REQUEST_FAILED, "prepare_upload missing credentials");
    return {
        serviceId: data.service_id as string,
        uploadHost: data.upload_host as string, // imagex.bytedanceapi.com
        accessKey: data.upload_auth_token.access_key as string,
        secretKey: data.upload_auth_token.secret_key as string,
        sessionToken: data.upload_auth_token.session_token as string,
    };
}

async function applyImageUpload(
    serviceId: string,
    uploadHost: string,
    accessKey: string,
    secretKey: string,
    sessionToken: string,
    fileSize: number,
    fileExtension: string
) {
    const params = {
        Action: "ApplyImageUpload",
        Version: "2018-08-01",
        ServiceId: serviceId,
        NeedFallback: "true",
        UploadNum: "1",
        FileSize: String(fileSize),
        FileExtension: fileExtension.startsWith(".") ? fileExtension : `.${fileExtension}`,
    } as Record<string, string>;
    const {authorization, amzDate} = buildAuthorization(
        "GET",
        uploadHost,
        "/",
        params,
        sessionToken,
        accessKey,
        secretKey
    );
    const url = `https://${uploadHost}/?${canonicalQuery(params)}`;
    logger.info(`[ImageX.Apply] host=${uploadHost}, serviceId=${serviceId}, params=${JSON.stringify(params)}`);
    const res = await axios.get(url, {
        headers: {
            "x-amz-date": amzDate,
            "x-amz-security-token": sessionToken,
            "X-Security-Token": sessionToken,
            authorization,
        },
        timeout: 30000,
    });
    const body = res.data || {};
    const hasResult = !!body.Result;
    const hasUA = !!(body.Result && body.Result.UploadAddress);
    logger.info(`[ImageX.Apply] status=${res.status}, hasResult=${hasResult}, hasUploadAddress=${hasUA}`);
    if (!hasResult || !hasUA) {
        logger.warn(`[ImageX.Apply] response body: ${JSON.stringify(body).slice(0, 1000)}`);
        throw new APIException(EX.API_REQUEST_FAILED, "ApplyImageUpload failed");
    }
    const uploadAddress = body.Result.UploadAddress;
    const storeInfo = Array.isArray(uploadAddress.StoreInfos) ? uploadAddress.StoreInfos[0] : null;
    const tosHost = Array.isArray(uploadAddress.UploadHosts) && uploadAddress.UploadHosts[0];
    const sessionKey = (uploadAddress && uploadAddress.SessionKey)
        || (body.Result && body.Result.SessionKey)
        || (body.Result && body.Result.InnerUploadAddress && Array.isArray(body.Result.InnerUploadAddress.UploadNodes) && body.Result.InnerUploadAddress.UploadNodes[0] && body.Result.InnerUploadAddress.UploadNodes[0].SessionKey)
        || "";
    if (!storeInfo || !storeInfo.StoreUri || !storeInfo.Auth || !tosHost) {
        logger.warn(`[ImageX.Apply] invalid fields: storeInfo=${!!storeInfo}, storeUri=${!!(storeInfo && storeInfo.StoreUri)}, auth=${!!(storeInfo && storeInfo.Auth)}, tosHost=${!!tosHost}, sessionKey_present=${!!sessionKey}`);
        logger.warn(`[ImageX.Apply] response body: ${JSON.stringify(body).slice(0, 2000)}`);
        throw new APIException(EX.API_REQUEST_FAILED, "ApplyImageUpload response missing fields");
    }
    logger.info(`[ImageX.Apply] parsed ok: storeUri=${storeInfo.StoreUri}, tosHost=${tosHost}, sessionKey_len=${String(sessionKey).length}`);
    return {
        storeUri: storeInfo.StoreUri as string,
        auth: storeInfo.Auth as string,
        tosHost: tosHost as string,
        sessionKey
    };
}

async function uploadToTos(tosHost: string, storeUri: string, auth: string, fileData: Buffer, mimeType: string) {
    const crc = (util.crc32(fileData) >>> 0).toString(16).padStart(8, '0');
    const url = `https://${tosHost}/upload/v1/${storeUri}`;
    try {
        const res = await axios.post(url, fileData, {
            headers: {
                Authorization: auth,
                "Content-CRC32": crc,
                "Content-Type": mimeType || "application/octet-stream",
            },
            timeout: 60000,
            maxContentLength: FILE_MAX_SIZE,
        });

        // 检查响应
        const body = res.data || {};
        const code = body?.code;
        logger.info(`[TOS.Upload] 响应: status=${res.status}, code=${code}, body=${JSON.stringify(body).slice(0, 200)}`);

        if (res.status >= 300 || (code !== 2000 && String(code) !== "2000")) {
            logger.warn(`[TOS.Upload] 失败: status=${res.status}, code=${code}`);
            throw new APIException(EX.API_REQUEST_FAILED, `TOS upload failed: status=${res.status}, code=${code}`);
        }
    } catch (err: any) {
        const status = err?.response?.status;
        const data = err?.response?.data;
        logger.warn(`[TOS.Upload] error status=${status}, body=${typeof data === 'string' ? data.slice(0, 500) : JSON.stringify(data || {}).slice(0, 500)}`);
        throw err;
    }
}


function sniffImageSize(buf: Buffer, mimeType?: string): { width: number; height: number } | null {
    try {
        if (!buf || buf.length < 16) return null;
        // PNG
        if ((mimeType && /png/i.test(mimeType)) || (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) {
            if (buf.length >= 24) {
                const size = normalizeImageSize(buf.readUInt32BE(16), buf.readUInt32BE(20));
                if (size) return size;
            }
        }
        // JPEG
        if ((mimeType && /jpe?g/i.test(mimeType)) || (buf[0] === 0xff && buf[1] === 0xd8)) {
            let i = 2;
            while (i + 9 < buf.length) {
                if (buf[i] !== 0xff) {
                    i++;
                    continue;
                }
                const marker = buf[i + 1];
                const len = buf.readUInt16BE(i + 2);
                if ([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF].includes(marker)) {
                    if (i + 9 <= buf.length) {
                        const size = normalizeImageSize(buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5));
                        if (size) return size;
                    }
                    break;
                }
                i += 2 + len;
            }
        }

        if ((mimeType && /webp/i.test(mimeType)) || (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.slice(8, 12).toString("ascii") === "WEBP")) {
            let p = 12;
            while (p + 8 <= buf.length) {
                const chunk = buf.slice(p, p + 4).toString("ascii");
                const size = buf.readUInt32LE(p + 4);
                if (chunk === "VP8X" && p + 18 <= buf.length) {
                    const wMinus1 = (buf[p + 12] | (buf[p + 13] << 8) | (buf[p + 14] << 16)) >>> 0;
                    const hMinus1 = (buf[p + 15] | (buf[p + 16] << 8) | (buf[p + 17] << 16)) >>> 0;
                    const size = normalizeImageSize(wMinus1 + 1, hMinus1 + 1);
                    if (size) return size;
                }
                p += 8 + size + (size % 2);
            }
        }
    } catch {
    }
    return null;
}

async function commitImageUpload(
    serviceId: string,
    uploadHost: string,
    accessKey: string,
    secretKey: string,
    sessionToken: string,
    storeUri: string,
    auth: string,
    tosHost: string
) {
    const params = {
        Action: "CommitImageUpload",
        Version: "2018-08-01",
        ServiceId: serviceId,
    } as Record<string, string>;

    const sessionKeyObj = {
        accountType: "ImageX",
        appId: "",
        bizType: "",
        fileType: "image",
        legal: "",
        storeInfos: JSON.stringify([{
            StoreUri: storeUri,
            Auth: auth,
            UploadID: "",
            UploadHeader: null,
            StorageHeader: null
        }]),
        uploadHost: tosHost,
        uri: storeUri,
        userId: ""
    };
    const sessionKey = Buffer.from(JSON.stringify(sessionKeyObj)).toString("base64");

    const bodyObj = {SessionKey: sessionKey};
    const bodyStr = JSON.stringify(bodyObj);
    const payloadHash = sha256Hex(bodyStr);

    const {authorization, amzDate} = buildAuthorization(
        "POST",
        uploadHost,
        "/",
        params,
        sessionToken,
        accessKey,
        secretKey,
        IMAGEX_REGION,
        IMAGEX_SERVICE,
        {payloadHash, signContentSha256: true}
    );
    const url = `https://${uploadHost}/?${canonicalQuery(params)}`;
    const headers = {
        "x-amz-date": amzDate,
        "x-amz-security-token": sessionToken,
        "x-amz-content-sha256": payloadHash,
        "content-type": "application/json",
        authorization,
    } as Record<string, string>;

    const res = await axios.post(url, bodyStr, {headers, timeout: 30000});
    const body = res.data || {};
    const uriStatus = body?.Result?.Results?.[0]?.UriStatus;

    logger.info(`[ImageX.Commit] 响应: status=${res.status}, uriStatus=${uriStatus}`);
    logger.info(`[ImageX.Commit] 响应体: ${JSON.stringify(body).slice(0, 500)}`);

    if (res.status >= 300 || (uriStatus !== 2000 && String(uriStatus) !== "2000")) {
        throw new APIException(EX.API_REQUEST_FAILED, `CommitImageUpload failed: status=${res.status}, uriStatus=${uriStatus}`);
    }
    return body;
}


/**
 * 上传文件
 *
 * @param fileUrl 文件URL
 * @param context 账号上下文
 * @param isVideoImage 是否是用于视频图像
 */
async function uploadFile(
    fileUrl: string,
    context: AccountContext,
    isVideoImage: boolean = false
) {
    await checkFileUrl(fileUrl);

    let filename: string, fileData: Buffer, mimeType: string | undefined, extFromMime: string | undefined;
    if (util.isBASE64Data(fileUrl)) {
        mimeType = util.extractBASE64DataFormat(fileUrl);
        extFromMime = mime.getExtension(mimeType || "") || undefined;
        filename = `${util.uuid()}.${extFromMime || "bin"}`;
        fileData = Buffer.from(util.removeBASE64DataHeader(fileUrl), "base64");
    } else {
        // 允许的图片后缀白名单
        const ALLOWED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'svg'];
        
        // 去除查询参数获取纯净文件名
        try {
            const urlObj = new URL(fileUrl);
            filename = path.basename(urlObj.pathname);
            // 尝试从 URL 查询参数中获取 format 信息（如 format=.webp）
            const formatParam = urlObj.searchParams.get('format');
            if (formatParam) {
                const formatExt = formatParam.replace(/^\./, '').toLowerCase();
                if (ALLOWED_IMAGE_EXTENSIONS.includes(formatExt)) {
                    extFromMime = formatExt;
                    logger.info(`[uploadFile] 从 URL format 参数推断扩展名: ${formatExt}`);
                }
            }
        } catch {
            filename = path.basename(fileUrl.split('?')[0]);
        }
        
        // 下载远程图片时，携带浏览器 headers 以避免被 CDN 拦截（如字节跳动 CDN 会返回 403）
        const resp = await axios.get(fileUrl, {
            responseType: "arraybuffer",
            maxContentLength: FILE_MAX_SIZE,
            timeout: 60000,
            headers: {
                "User-Agent": FAKE_HEADERS["User-Agent"],
                "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
                "Accept-Encoding": "gzip, deflate, br",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            },
        });
        fileData = resp.data as Buffer;
        
        // 优先从响应头 Content-Type 推断 MIME 类型
        const respContentType = resp.headers?.["content-type"];
        if (respContentType && /^image\//.test(respContentType)) {
            mimeType = respContentType.split(';')[0].trim();
            const inferredExt = mime.getExtension(mimeType);
            if (inferredExt && ALLOWED_IMAGE_EXTENSIONS.includes(inferredExt)) {
                extFromMime = extFromMime || inferredExt;
                logger.info(`[uploadFile] 从响应 Content-Type 推断: mime=${mimeType}, ext=${extFromMime}`);
            }
        }
    }

    mimeType = mimeType || mime.getType(filename) || "application/octet-stream";
    const isImage = /^image\//.test(mimeType);
    const ext = (extFromMime || path.extname(filename).replace(/^\./, "") || (mime.getExtension(mimeType) || "bin")).toLowerCase();

    try {
        const auth = await acquireUploadAuth(context, isImage ? 2 : 1);
        logger.info(`STS acquired for ${isImage ? "image" : "file"}`);

        const apply = await applyImageUpload(
            auth.serviceId,
            auth.uploadHost,
            auth.accessKey,
            auth.secretKey,
            auth.sessionToken,
            fileData.length,
            `.${ext}`
        );

        await uploadToTos(apply.tosHost, apply.storeUri, apply.auth, fileData, mimeType);
        logger.info(`上传完成: ${apply.storeUri}`);

        if (isImage) {
            try {
                const commitRes = await commitImageUpload(
                    auth.serviceId,
                    auth.uploadHost,
                    auth.accessKey,
                    auth.secretKey,
                    auth.sessionToken,
                    apply.storeUri,
                    apply.auth,
                    apply.tosHost
                );
                const uriStatus = commitRes?.Result?.Results?.[0]?.UriStatus;
                logger.info(`[ImageX.Commit] 完成: ${apply.storeUri}, status=${uriStatus}`);
            } catch (err: any) {
                const msg = err?.message || String(err || "");
                logger.warn(`[ImageX.Commit] 失败，但继续: ${msg}`);
            }
        }

        const size = isImage ? sniffImageSize(fileData, mimeType) : null;

        const ref: any = {
            file_url: {url: apply.storeUri},
            name: filename,
            ext,
            kind: isImage ? "image" : "file",
            ...(isImage ? {width: (size?.width || 1), height: (size?.height || 1)} : {}),
        };
        return ref;
    } catch (e: any) {
        const msg = (e && e.message) ? e.message : String(e || "");
        try {
            // @ts-ignore
            const safeMsg = typeof maskBase64InString === 'function' ? maskBase64InString(msg) : msg;
            logger.warn(`上传失败，已忽略该图片: ${safeMsg}`);
        } catch {
            logger.warn(`上传失败，已忽略该图片`);
        }
        if (isImage) return null as any;
        const fallback: any = {
            file_url: {url: "upload-failed://placeholder"},
            name: filename,
            ext,
            kind: "file",
        };
        return fallback;
    }
}


/**
 * 从流接收完整的消息内容
 *
 * @param stream 消息流
 */
async function receiveStream(stream: any): Promise<any> {
    let temp = Buffer.from('');
    const imageUrls: string[] = [];
    const emittedImageKeys = new Set<string>();
    return new Promise((resolve, reject) => {
        const data = {
            id: "",
            model: MODEL_NAME,
            object: "chat.completion",
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: "",
                        images: [] as string[]
                    },
                    finish_reason: "stop",
                },
            ],
            created: util.unixTimestamp(),
        };
        let isEnd = false;
        const finalize = () => {
            data.choices[0].message.content = data.choices[0].message.content.replace(/\n$/, "");
            data.choices[0].message.images = imageUrls;
        };
        const parser = createParser((event) => {
            try {
                if (event.type !== "event" || isEnd) return;
                const rawResult = _.attempt(() => JSON.parse(event.data));
                if (_.isError(rawResult))
                    throw new Error(`Stream response invalid: ${event.data}`);
                if (rawResult.code)
                    throw new APIException(EX.API_REQUEST_FAILED, `[请求doubao失败]: ${rawResult.code}-${rawResult.message}`);
                if (rawResult.event_type == 2003) {
                    isEnd = true;
                    finalize();
                    return resolve(data);
                }
                if (rawResult.event_type != 2001)
                    return;
                const result = _.attempt(() => JSON.parse(rawResult.event_data));
                if (_.isError(result))
                    throw new Error(`Stream response invalid: ${rawResult.event_data}`);
                if (!data.id && result.conversation_id)
                    data.id = result.conversation_id;
                if (result.is_finish) {
                    isEnd = true;
                    finalize();
                    return resolve(data);
                }
                const message = result.message;
                if (!message || !message.content)
                    return;
                let text = "";
                const parsed = _.attempt(() => JSON.parse(message.content));
                if (!_.isError(parsed)) {
                    if (typeof parsed === "string") text = parsed;
                    else if (typeof parsed.text === "string") text = parsed.text;
                    else if (parsed.delta && typeof parsed.delta.text === "string") text = parsed.delta.text;
                    else if (typeof parsed.content === "string") text = parsed.content;
                } else if (typeof message.content === "string") {
                    text = message.content;
                }
                if (text)
                    data.choices[0].message.content += text;
                const ctype = message.content_type;
                if (ctype === 2074) {
                    const payload = _.isError(parsed) ? _.attempt(() => JSON.parse(message.content)) : parsed;
                    if (!_.isError(payload)) {
                        imageUrls.push(...extractImageUrlsFromCreations(payload, emittedImageKeys));
                    }
                }
            } catch (err) {
                logger.error(err);
                reject(err);
            }
        });
        stream.on("data", (buffer) => {
            const bufferStr = buffer.toString();
            if (!data.id) {
                const extractedId = extractConversationId(bufferStr);
                if (extractedId) data.id = extractedId;
            }
            if (bufferStr.indexOf('�') !== -1) {
                temp = Buffer.concat([temp, buffer]);
                return;
            }
            if (temp.length > 0) {
                buffer = Buffer.concat([temp, buffer]);
                temp = Buffer.from('');
            }
            parser.feed(buffer.toString());
        });
        stream.once("error", (err) => reject(err));
        stream.once("close", () => {
            finalize();
            if (!data.id) {
                reject(createRetryGenerationEmpty("会话 ID 为空，说明生成失败需重试"));
                return;
            }
            resolve(data);
        });
    });
}

/**
 * 创建转换流
 * 将流格式转换为gpt兼容流格式
 * @param stream 消息流
 * @param endCallback 传输结束回调
 */
type StreamImageEndCallback = (result: { convId: string; imageCount: number; success: boolean; reason?: string }) => void;

function createTransStream(stream: any, context: AccountContext, endCallback?: StreamImageEndCallback, hasTools = false, account?: any, promptText = "", autoDelete = true) {
    let convId = "";
    let temp = Buffer.from('');
    const created = util.unixTimestamp();
    const emittedImageKeys = new Set<string>();
    const transStream = new PassThrough();
    let imageNoticeSent = false;
    let usageSent = false;
    let finishing = false;
    let pendingPoll: Promise<void> | null = null;

    const finishSuccess = () => {
        if (usageSent || transStream.closed) return;
        transStream.write(`data: ${JSON.stringify({
            id: convId,
            model: MODEL_NAME,
            object: "chat.completion.chunk",
            choices: [
                {
                    index: 0,
                    delta: {},
                    finish_reason: "stop",
                },
            ],
            usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0
            },
            created,
        })}\n\n`);
        usageSent = true;
        !transStream.closed && transStream.end("data: [DONE]\n\n");
        endCallback && endCallback({ convId, imageCount: emittedImageKeys.size, success: true });
    };

    const finishFailure = (reason: string) => {
        if (transStream.closed) return;
        logger.warn(`[Image Stream] ${reason}`);
        transStream.write(`data: ${JSON.stringify({
            id: convId,
            model: MODEL_NAME,
            object: "chat.completion.chunk",
            choices: [
                {
                    index: 0,
                    delta: { role: "assistant", content: `\n[图片生成失败] ${reason}\n` },
                    finish_reason: "stop",
                },
            ],
            created,
        })}\n\n`);
        !transStream.closed && transStream.end("data: [DONE]\n\n");
        endCallback && endCallback({ convId, imageCount: emittedImageKeys.size, success: false, reason });
    };

    const flushPolledImages = async () => {
        if (finishing) return;
        finishing = true;
        if (!convId) {
            finishFailure("会话 ID 为空，已终止并等待外层重试");
            return;
        }
        if (emittedImageKeys.size > 0) {
            finishSuccess();
            return;
        }
        try {
            logger.warn(`[Image Stream] 首段流未返回图片，进入轮询补偿：convId=${convId}`);
            const polledImages = await pollForImageResult(convId, context);
            if (polledImages.length === 0) {
                finishFailure("已获取会话 ID，但轮询后仍未返回最终图片");
                return;
            }
            polledImages.forEach((url, index) => {
                const pseudoKey = `polled-${index}-${url}`;
                if (emittedImageKeys.has(pseudoKey)) return;
                emittedImageKeys.add(pseudoKey);
                transStream.write(`data: ${JSON.stringify({
                    id: convId,
                    model: MODEL_NAME,
                    object: "chat.completion.chunk",
                    choices: [
                        {
                            index: 0,
                            delta: { role: "assistant", content: `${url}\n` },
                            finish_reason: null,
                        },
                    ],
                    created,
                })}\n\n`);
            });
            finishSuccess();
        } catch (err: any) {
            finishFailure(err?.message || "轮询图片失败");
        }
    };

    const scheduleFinalize = () => {
        if (pendingPoll) return;
        pendingPoll = flushPolledImages().finally(() => {
            pendingPoll = null;
        });
    };

    !transStream.closed &&
    transStream.write(
        `data: ${JSON.stringify({
            id: convId,
            model: MODEL_NAME,
            object: "chat.completion.chunk",
            choices: [
                {
                    index: 0,
                    delta: {role: "assistant", content: ""},
                    finish_reason: null,
                },
            ],
            created,
        })}\n\n`
    );
    const parser = createParser((event) => {
        try {
            if (event.type !== "event") return;
            const rawResult = _.attempt(() => JSON.parse(event.data));
            if (_.isError(rawResult))
                throw new Error(`Stream response invalid: ${event.data}`);
            if (rawResult.code)
                throw new APIException(EX.API_REQUEST_FAILED, `[请求doubao失败]: ${rawResult.code}-${rawResult.message}`);
            if (rawResult.event_type == 2003) {
                scheduleFinalize();
                return;
            }
            if (rawResult.event_type != 2001) {
                return;
            }
            const result = _.attempt(() => JSON.parse(rawResult.event_data));
            if (_.isError(result))
                throw new Error(`Stream response invalid: ${rawResult.event_data}`);
            if (!convId)
                convId = result.conversation_id;
            if (result.is_finish) {
                scheduleFinalize();
                return;
            }
            const message = result.message;
            if (!message || !message.content)
                return;

            const content = _.attempt(() => JSON.parse(message.content));
            const ctype = message.content_type;
            if (ctype === 2074 && !_.isError(content)) {
                const creations = Array.isArray((content as any).creations) ? (content as any).creations : [];
                if (!imageNoticeSent && creations.length) {
                    const notice = `\n[图片生成中（共${creations.length}张）...]\n`;
                    transStream.write(`data: ${JSON.stringify({
                        id: convId,
                        model: MODEL_NAME,
                        object: "chat.completion.chunk",
                        choices: [
                            {
                                index: 0,
                                delta: {role: "assistant", content: notice},
                                finish_reason: null,
                            },
                        ],
                        created,
                    })}\n\n`);
                    imageNoticeSent = true;
                }
                for (const c of creations) {
                    const img = c?.image || {};
                    const key = img?.key as string | undefined;
                    // 优先提取无水印原图
                    const url = img?.image_ori_raw?.url || img?.image_ori?.url || img?.image_preview?.url || img?.image_thumb?.url;
                    if (key && url && !emittedImageKeys.has(key)) {
                        emittedImageKeys.add(key);
                        const md = `${url}\n`;
                        transStream.write(`data: ${JSON.stringify({
                            id: convId,
                            model: MODEL_NAME,
                            object: "chat.completion.chunk",
                            choices: [
                                {
                                    index: 0,
                                    delta: {role: "assistant", content: md},
                                    finish_reason: null,
                                },
                            ],
                            created,
                        })}\n\n`);
                    }
                }
            }

            let text = "";
            if (!_.isError(content)) {
                if (typeof content === "string") text = content;
                else if (typeof (content as any).text === "string") text = (content as any).text;
                else if ((content as any).delta && typeof (content as any).delta.text === "string") text = (content as any).delta.text;
                else if (typeof (content as any).content === "string") text = (content as any).content;
            } else if (typeof message.content === "string") {
                text = message.content;
            }
            if (text) {
                transStream.write(`data: ${JSON.stringify({
                    id: convId,
                    model: MODEL_NAME,
                    object: "chat.completion.chunk",
                    choices: [
                        {
                            index: 0,
                            delta: {role: "assistant", content: text},
                            finish_reason: null,
                        },
                    ],
                    created,
                })}\n\n`);
            }
        } catch (err) {
            logger.error(err);
            finishFailure(err instanceof Error ? err.message : String(err));
        }
    });
    stream.on("data", (buffer) => {
        const bufferStr = buffer.toString();
        if (!convId) {
            const extractedId = extractConversationId(bufferStr);
            if (extractedId) convId = extractedId;
        }
        if (bufferStr.indexOf('�') != -1) {
            temp = Buffer.concat([temp, buffer]);
            return;
        }
        if (temp.length > 0) {
            buffer = Buffer.concat([temp, buffer]);
            temp = Buffer.from('');
        }
        parser.feed(buffer.toString());
    });
    stream.once("error", () => scheduleFinalize());
    stream.once("close", () => scheduleFinalize());
    return transStream;
}

function tokenSplit(authorization: string) {
    return authorization.replace("Bearer ", "").split(",");
}

/**
 * 获取Token存活状态
 */
async function getTokenLiveStatus(refreshToken: string) {
    const context = normalizeAccount(refreshToken);
    const result = await request("POST", "/passport/account/info/v2", context, {
        params: {
            account_sdk_source: "web"
        }
    });
    try {
        return !!(result && (result as any).user_id);
    } catch (err) {
        return false;
    }
}

export default {
    createImageCompletion,
    createImageCompletionStream,
    getTokenLiveStatus,
    tokenSplit,
    uploadFile,
};
