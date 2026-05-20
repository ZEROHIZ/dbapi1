import { PassThrough } from "stream";
import crypto from "crypto";
import path from "path";
import _ from "lodash";
import mime from "mime";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import fs from "fs"; // 移到顶部

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from "eventsource-parser";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import { logRequest } from "@/lib/debug-logger.ts";
import { appendDumpText, dumpObject } from "@/lib/debug-dumper.ts";
import images from "@/api/controllers/images.ts";
import TokenCounter from "@/lib/token-counter.ts";
import AccountManager from "@/lib/account-manager.ts";

// 模型名称
const MODEL_NAME = "doubao-video";
// 默认的AgentID (视频可能使用不同的ID，暂时复用或使用通用ID)
const DEFAULT_ASSISTANT_ID = "497858";
// 版本号
const VERSION_CODE = "20800";
// PC版本
const PC_VERSION = "2.44.0";

// 定义账号上下文接口，用于传递指纹信息
interface AccountContext {
    token: string;
    deviceId: string;
    webId: string;
    userId: string;
}

type VideoReferenceImage = string | string[];

// 最大重试次数
const MAX_RETRY_COUNT = 0; // 调试阶段关闭重试，避免浪费额度
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

/**
 * 格式化账号信息
 */
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

/**
 * 获取缓存中的access_token
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
    return `mf-${util.generateRandomString({ length: 34, })}-${util.generateRandomString({ length: 6, })}`;
}

/**
 * 移除会话
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
            ...(options.headers || {})
        },
        timeout: 15000,
        validateStatus: () => true,
        ..._.omit(options, "params", "headers"),
    };

    logger.info(`[Video Request] DeviceID: ${context.deviceId} | WebID: ${context.webId}`);
    logRequest(requestConfig.method || method, requestConfig.url || uri, requestConfig.params, requestConfig.headers, requestConfig.data);

    const response = await axios.request(requestConfig);
    if (options.responseType == "stream")
        return response;
    return checkResult(response);
}


/**
 * 获取无水印视频播放信息
 */
async function getVideoPlayInfo(vid: string, context: AccountContext) {
    try {
        const params = {
            msToken: generateFakeMsToken(),
            a_bogus: generateFakeABogus()
        };
        const response = await request("POST", "/samantha/video/get_play_info", context, {
            params,
            data: { vid }
        });
        if (response && response.play_infos && Array.isArray(response.play_infos)) {
            // 优先找 1080p，如果没有则取最后一个（通常是最高画质）
            const best = response.play_infos.find((p: any) => p.definition === '1080p') || response.play_infos[response.play_infos.length - 1];
            if (best && best.main) {
                return best.main;
            }
        }
    } catch (err) {
        logger.error(`[Video] 获取无水印地址失败: ${err.message}`);
    }
    return null;
}

/**
 * 轮询会话获取视频结果
 * @param convId 会话ID
 * @param context 账号上下文
 * @param timeoutMs 超时时间
 */
async function pollForVideoResult(convId: string, context: AccountContext, timeoutMs: number = 180000): Promise<any[]> {
    if (!convId || convId === "0") {
        logger.warn("[轮询视频] convId 为空，跳过轮询");
        return [];
    }

    const defaultTimeout = AccountManager.getSettings().videoTimeout || 180000;
    const finalTimeout = timeoutMs > 0 ? timeoutMs : defaultTimeout;
    const startTime = Date.now();
    let retryCount = 0;

    while (Date.now() - startTime < finalTimeout) {
        try {
            await new Promise(resolve => setTimeout(resolve, 5000)); // 每5秒轮询一次

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
                        anchor_index: 9007199254740991, // Max safe integer
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

            logger.info(`[轮询视频] 请求参数: convId=${convId}, cmd=3100`);

            // 使用 IM 专用接口
            const response = await request("POST", "/im/chain/single", context, {
                params,
                data: postData,
                headers: {
                    "Content-Type": "application/json; encoding=utf-8"
                }
            });

            // 解析响应
            if (response && response.downlink_body && response.downlink_body.pull_singe_chain_downlink_body) {
                const messages = response.downlink_body.pull_singe_chain_downlink_body.messages || [];
                logger.info(`[轮询视频] 获取到 ${messages.length} 条消息`);

                const videos: any[] = [];
                const emittedKeys = new Set<string>();

                for (const msg of messages) {
                    // 检查 content_type: 9999 或其他可能包含 block 的类型
                    // 并且 content 包含 block_type: 2074
                    let contentObj: any = null;
                    if (typeof msg.content === 'string') {
                        contentObj = _.attempt(() => JSON.parse(msg.content));
                    } else {
                        contentObj = msg.content;
                    }

                    if (_.isError(contentObj) || !contentObj) continue;

                    // 检查 content 数组中的 block
                    const blocks = Array.isArray(contentObj) ? contentObj : (contentObj.content_block || []);

                    for (const block of blocks) {
                        if (block.block_type === 2074) {
                            const creationBlock = block.content?.creation_block;
                            if (creationBlock && Array.isArray(creationBlock.creations)) {
                                for (const c of creationBlock.creations) {
                                    const vidObj = c?.video;
                                    if (vidObj) {
                                        const vid = vidObj.vid;
                                        if (vid && !emittedKeys.has(vid)) {
                                            emittedKeys.add(vid);

                                            // 尝试获取无水印地址
                                            let finalUrl = vidObj.download_url || vidObj.video_url;
                                            const noWatermarkUrl = await getVideoPlayInfo(vid, context);
                                            if (noWatermarkUrl) {
                                                finalUrl = noWatermarkUrl;
                                                logger.success(`[Video] 成功获取无水印地址: ${vid}`);
                                            }

                                            videos.push({
                                                vid,
                                                cover: vidObj.cover?.image_preview?.url || vidObj.cover?.image_thumb?.url || vidObj.cover?.key,
                                                url: finalUrl
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                if (videos.length > 0) {
                    logger.success(`轮询成功，获取到 ${videos.length} 个视频`);
                    return videos;
                }
            }
            logger.info(`[轮询视频] 第 ${++retryCount} 次尝试，暂无结果...`);

        } catch (err) {
            logger.error(`[轮询视频] 出错:`, err);
        }
    }
    return [];
}


/**
 * 同步视频生成
 * @param videoParams { prompt, ratio, model, image }
 * @param account 账号信息
 */
async function createVideoCompletion(
    videoParams: { model: string; prompt: string; ratio: string; image?: VideoReferenceImage },
    account: any,
    assistantId = DEFAULT_ASSISTANT_ID,
    retryCount = 0,
    autoDelete = false
) {
    return (async () => {
        const { prompt, ratio, image } = videoParams;
        logger.info(`收到视频生成请求：prompt=${prompt}, ratio=${ratio}, image=${!!image}`);
        const context = normalizeAccount(account);

        let attachments: any[] = [];
        if (image) {
            try {
                const refImages = Array.isArray(image) ? image : [image];
                const uploadResults = await Promise.all(
                    refImages.map(img => images.uploadFile(img, context as any))
                );
                for (const refImage of uploadResults) {
                    if (refImage && refImage.file_url?.url) {
                        attachments.push({
                            type: "image",
                            key: refImage.file_url.url,
                            extra: { refer_types: "overall" },
                            identifier: util.uuid(),
                            width: refImage.width,
                            height: refImage.height,
                        });
                        logger.info(`参考图上传成功：${refImage.file_url.url}`);
                    }
                }
            } catch (err: any) {
                logger.error(`参考图上传失败：${err.message}`);
                throw new APIException(EX.API_REQUEST_FAILED, "参考图上传失败");
            }
        }

        // 构造多模态统一内容块 content_block
        const contentBlocks = [];
        if (attachments && attachments.length > 0) {
            const mappedAttachments = attachments.map(att => ({
                type: 1,
                identifier: att.identifier || util.uuid(),
                image: {
                    name: path.basename(att.key) || "ref_image.png",
                    uri: att.key, // 豆包的 tos URI
                    image_ori: {
                        url: "",
                        width: att.width || 1536,  // 使用真实的图片宽度
                        height: att.height || 1024, // 使用真实的图片高度
                        format: "",
                        url_formats: {}
                    }
                },
                parse_state: 0,
                review_state: 1,
                upload_status: 1,
                progress: 100,
                src: ""
            }));

            contentBlocks.push({
                block_type: 10052,
                content: {
                    attachment_block: {
                        attachments: mappedAttachments
                    },
                    pc_event_block: ""
                },
                block_id: util.uuid(),
                parent_id: "",
                meta_info: [],
                append_fields: []
            });
        }

        // 剧本词文本块
        contentBlocks.push({
            block_type: 10000,
            content: {
                text_block: {
                    text: `帮我生成视频：比例 「${ratio || "16:9"}」${prompt}`,
                    icon_url: "",
                    icon_url_dark: "",
                    summary: ""
                },
                pc_event_block: ""
            },
            block_id: util.uuid(),
            parent_id: "",
            meta_info: [],
            append_fields: []
        });

        const videoMessage = [
            {
                local_message_id: util.uuid(),
                content_block: contentBlocks,
                message_status: 0
            }
        ];

        const response = await request("post", "/chat/completion", context, {
            data: {
                client_meta: {
                    local_conversation_id: `local_${util.generateRandomString({ length: 16, charset: "numeric" })}`,
                    conversation_id: "",
                    bot_id: "7338286299411103781",
                    last_section_id: "",
                    last_message_index: null
                },
                messages: videoMessage,
                completion_option: {
                    is_regen: false,
                    with_suggest: false,
                    need_create_conversation: true,
                    launch_stage: 1,
                    is_replace: false,
                    is_delete: false,
                    message_from: 0,
                    action_bar_skill_id: 17,
                    use_auto_cot: false,
                    resend_for_regen: false,
                    enable_commerce_credit: false,
                    event_id: "0"
                },
                chat_ability: {
                    ability_type: 17,
                    ability_param: JSON.stringify({ ratio: ratio || "16:9" })
                },
                option: {
                    send_message_scene: "",
                    create_time_ms: Date.now(),
                    collect_id: "",
                    is_audio: false,
                    answer_with_suggest: false,
                    tts_switch: false,
                    need_deep_think: 0,
                    click_clear_context: false,
                    from_suggest: false,
                    is_regen: false,
                    is_replace: false,
                    disable_sse_cache: false,
                    select_text_action: "",
                    resend_for_regen: false,
                    scene_type: 0,
                    unique_key: util.uuid(),
                    start_seq: 0,
                    need_create_conversation: true,
                    conversation_init_option: {
                        need_ack_conversation: true
                    },
                    regen_query_id: [],
                    edit_query_id: [],
                    regen_instruction: "",
                    no_replace_for_regen: false,
                    message_from: 0,
                    shared_app_name: "",
                    shared_app_id: "",
                    sse_recv_event_options: {
                        support_chunk_delta: true
                    },
                    is_ai_playground: false,
                    recovery_option: {
                        is_recovery: false,
                        req_create_time_sec: Math.floor(Date.now() / 1000),
                        append_sse_event_scene: 0
                    },
                    message_storage_type: 0
                },
                ext: {
                    answer_with_suggest: "0",
                    fp: context.webId || "verify_mo74hegl_65XSbmNq_VzEk_4xVN_82vA_eSxvgTxd2Jbb",
                    collection_id: "",
                    conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
                    commerce_credit_config_enable: "0",
                    sub_conv_firstmet_type: "1"
                }
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
            response.data.on("data", (buffer: any) => logger.error(buffer.toString()));
            throw new APIException(
                EX.API_REQUEST_FAILED,
                `Stream response Content-Type invalid: ${contentType}`
            );
        }

        const streamStartTime = util.timestamp();
        // 1. 先通过流式接口获取会话ID
        const initialAnswer = await receiveStream(response.data);
        const convId = initialAnswer.id;

        logger.info(`视频生成会话创建成功 ID=${convId}，开始轮询结果...`);

        if (!convId || convId === "0") {
            throw new APIException(
                EX.API_REQUEST_FAILED,
                "RETRY_GENERATION_EMPTY: 视频生成未返回会话ID，已终止轮询"
            );
        }

        // 2. 轮询获取真实视频地址
        const settings = AccountManager.getSettings();
        const videos = await pollForVideoResult(convId, context, settings.videoTimeout);

        // 3. 更新返回结果与记录用量（只有成功拿到真实 URL 才可以算次数）
        if (videos.length > 0) {
            const md = videos.map((v, i) => {
                return `![视频封面${i + 1}](${v.cover})
视频链接: ${v.url}`;
            }).join("\n\n");
            // 覆盖之前的“生成中”提示
            initialAnswer.choices[0].message.content = md;
            initialAnswer.choices[0].message.videos = videos;

            // 成功时后扣费累加次数
            const accountId = (account as any).id;
            if (accountId) {
                AccountManager.updateAccountUsage(accountId, 'video', 0, 0);
                TokenCounter.recordUsage(accountId, 0, 0);
            }
        } else {
            initialAnswer.choices[0].message.content += "\n\n(获取视频结果超时，请稍后在历史记录中查看)";
        }

        if (autoDelete) {
            removeConversation(convId, context).catch(
                (err) => console.error('移除视频生成会话失败：', err)
            );
        }

        return initialAnswer;
    })().catch((err) => {
        logger.error(`视频生成流响应错误: ${err.stack || String(err)}`);
        throw err;
    });
}

/**
 * 流式视频生成
 * @param videoParams { prompt, ratio, model, image }
 * @param account 账号信息
 */
async function createVideoCompletionStream(
    videoParams: { model: string; prompt: string; ratio: string; image?: VideoReferenceImage },
    account: any,
    assistantId = DEFAULT_ASSISTANT_ID,
    retryCount = 0,
    autoDelete = false
) {
    return (async () => {
        const { prompt, ratio, image } = videoParams;
        logger.info(`收到流式视频生成请求：prompt=${prompt}, ratio=${ratio}, image=${!!image}`);
        const context = normalizeAccount(account);

        let attachments: any[] = [];
        if (image) {
            try {
                const refImages = Array.isArray(image) ? image : [image];
                const uploadResults = await Promise.all(
                    refImages.map(img => images.uploadFile(img, context as any))
                );
                for (const refImage of uploadResults) {
                    if (refImage && refImage.file_url?.url) {
                        attachments.push({
                            type: "image",
                            key: refImage.file_url.url,
                            extra: { refer_types: "overall" },
                            identifier: util.uuid(),
                            width: refImage.width,
                            height: refImage.height,
                        });
                        logger.info(`参考图上传成功：${refImage.file_url.url} | 尺寸: ${refImage.width}x${refImage.height}`);
                    }
                }
            } catch (err: any) {
                logger.error(`参考图上传失败：${err.message}`);
                throw new APIException(EX.API_REQUEST_FAILED, "参考图上传失败");
            }
        }

        // 构造多模态统一内容块 content_block
        const contentBlocks = [];
        if (attachments && attachments.length > 0) {
            const mappedAttachments = attachments.map(att => ({
                type: 1,
                identifier: att.identifier || util.uuid(),
                image: {
                    name: path.basename(att.key) || "ref_image.png",
                    uri: att.key, // 豆包的 tos URI
                    image_ori: {
                        url: "",
                        width: att.width || 1536,  // 使用真实的图片宽度
                        height: att.height || 1024, // 使用真实的图片高度
                        format: "",
                        url_formats: {}
                    }
                },
                parse_state: 0,
                review_state: 1,
                upload_status: 1,
                progress: 100,
                src: ""
            }));

            contentBlocks.push({
                block_type: 10052,
                content: {
                    attachment_block: {
                        attachments: mappedAttachments
                    },
                    pc_event_block: ""
                },
                block_id: util.uuid(),
                parent_id: "",
                meta_info: [],
                append_fields: []
            });
        }

        // 剧本词文本块
        contentBlocks.push({
            block_type: 10000,
            content: {
                text_block: {
                    text: `帮我生成视频：比例 「${ratio || "16:9"}」${prompt}`,
                    icon_url: "",
                    icon_url_dark: "",
                    summary: ""
                },
                pc_event_block: ""
            },
            block_id: util.uuid(),
            parent_id: "",
            meta_info: [],
            append_fields: []
        });

        const videoMessage = [
            {
                local_message_id: util.uuid(),
                content_block: contentBlocks,
                message_status: 0
            }
        ];

        const response = await request("post", "/chat/completion", context, {
            data: {
                messages: videoMessage,
                completion_option: {
                    is_regen: false,
                    with_suggest: false,
                    need_create_conversation: true,
                    launch_stage: 1,
                    is_replace: false,
                    is_delete: false,
                    message_from: 0,
                    action_bar_skill_id: 17,
                    use_auto_cot: false,
                    resend_for_regen: false,
                    enable_commerce_credit: false,
                    event_id: "0"
                },
                chat_ability: {
                    ability_type: 17,
                    ability_param: JSON.stringify({ ratio: ratio || "16:9" })
                },
                option: {
                    send_message_scene: "",
                    create_time_ms: Date.now(),
                    collect_id: "",
                    is_audio: false,
                    answer_with_suggest: false,
                    tts_switch: false,
                    need_deep_think: 0,
                    click_clear_context: false,
                    from_suggest: false,
                    is_regen: false,
                    is_replace: false,
                    disable_sse_cache: false,
                    select_text_action: "",
                    resend_for_regen: false,
                    scene_type: 0,
                    unique_key: util.uuid(),
                    start_seq: 0,
                    need_create_conversation: true,
                    conversation_init_option: {
                        need_ack_conversation: true
                    },
                    regen_query_id: [],
                    edit_query_id: [],
                    regen_instruction: "",
                    no_replace_for_regen: false,
                    message_from: 0,
                    shared_app_name: "",
                    shared_app_id: "",
                    sse_recv_event_options: {
                        support_chunk_delta: true
                    },
                    is_ai_playground: false,
                    recovery_option: {
                        is_recovery: false,
                        req_create_time_sec: Math.floor(Date.now() / 1000),
                        append_sse_event_scene: 0
                    },
                    message_storage_type: 0
                },
                ext: {
                    answer_with_suggest: "0",
                    fp: context.webId || "verify_mo74hegl_65XSbmNq_VzEk_4xVN_82vA_eSxvgTxd2Jbb",
                    collection_id: "",
                    conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
                    commerce_credit_config_enable: "0",
                    sub_conv_firstmet_type: "1"
                },
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

        if (response.status !== 200) {
            let errorMsg = `HTTP ${response.status} ${response.statusText}`;
            if (response.data && response.data.on) {
                // 如果是流，读取一点数据看是否有错误
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
            logger.error(`无效的响应Content-Type: ${contentType}`);
            response.data.on("data", (buffer: any) => logger.error(buffer.toString()));
            const transStream = new PassThrough();
            transStream.end(
                `data: ${JSON.stringify({
                    id: "",
                    model: MODEL_NAME,
                    object: "video.completion.chunk",
                    choices: [
                        {
                            index: 0,
                            delta: { content: "服务暂时不可用，第三方响应错误" },
                            finish_reason: "stop",
                        },
                    ],
                    created: util.unixTimestamp(),
                })}\n\n`
            );
            return transStream;
        }

        const streamStartTime = util.timestamp();
        return createTransStream(response.data, (convId: string) => {
            logger.success(
                `流式视频生成传输完成 ${util.timestamp() - streamStartTime}ms`
            );
            // 记录用量
            const accountId = (account as any).id;
            if (accountId) {
                AccountManager.updateAccountUsage(accountId, 'video', 0, 0);
                TokenCounter.recordUsage(accountId, 0, 0);
            }
            if (autoDelete) {
                removeConversation(convId, context).catch(
                    (err) => console.error(err)
                );
            }
        }, context, account, autoDelete);
    })().catch((err) => {
        logger.error(`流式视频生成响应错误: ${err.stack || String(err)}`);
        throw err;
    });
}

function checkResult(result: AxiosResponse) {
    if (!result.data) return null;
    const { code, msg, data } = result.data;
    if (!_.isFinite(code)) return result.data;
    if (code === 0) return data;
    throw new APIException(EX.API_REQUEST_FAILED, `[请求doubao失败]: ${msg}`);
}

/**
 * 从流接收完整的消息内容
 */

async function receiveStream(stream: any): Promise<any> {
    const logPath = path.join(process.cwd(), "debug_video_trace.log");

    // 写入开始标记
    fs.appendFileSync(logPath, `\n\n--- [${new Date().toISOString()}] NEW STREAM START ---
`);

    let temp = Buffer.from('');
    const videos: Array<{ vid?: string; cover?: string; url?: string }> = [];
    const emittedKeys = new Set<string>();

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
                        videos: [] as any[]
                    },
                    finish_reason: "stop",
                },
            ],
            created: util.unixTimestamp(),
            usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0
            },
        };
        let isEnd = false;
        const finalize = () => {
            fs.appendFileSync(logPath, `[FINALIZE] Final ID: ${data.id}, Videos Count: ${videos.length}\n`);
            data.choices[0].message.content = (data.choices[0].message.content || "").replace(/\n$/, "");
            if (videos.length > 0) {
                data.choices[0].message.videos = videos;
                const md = videos.map((v, i) => {
                    return `![视频封面${i + 1}](${v.cover})
视频链接: ${v.url || "生成中(请稍后查看)"}`;
                }).join("\n\n");
                data.choices[0].message.content += (data.choices[0].message.content ? "\n\n" : "") + md;
            }
        };

        const parser = createParser((event) => {
            try {
                if (event.type !== "event" || isEnd) return;
                const rawStr = (event as any).data;

                // --- 1. 暴力正则提取 ID (增强版，支持转义引号) ---
                if (!data.id && rawStr) {
                    // 匹配 "conversation_id":"数字" 或 \"conversation_id\":\"数字\"
                    const match = rawStr.match(/\\?"conversation_id\\?":\\?"(\d+)\\?"/);
                    if (match && match[1]) {
                        data.id = match[1];
                        fs.appendFileSync(logPath, `[MATCH SUCCESS] Regex caught ID: ${data.id}\n`);
                        logger.success(`[Video] 暴力抓取成功: ${data.id}`);
                    }
                }

                const rawResult = _.attempt(() => JSON.parse(rawStr));
                if (_.isError(rawResult)) return;

                if (rawResult.code)
                    throw new APIException(EX.API_REQUEST_FAILED, `[请求doubao失败]: ${rawResult.code}-${rawResult.message}`);

                if (rawResult.event_type == 2003) {
                    isEnd = true;
                    finalize();
                    return resolve(data);
                }

                if (rawResult.event_type != 2001) return;

                const result = _.attempt(() => typeof rawResult.event_data === 'string' ? JSON.parse(rawResult.event_data) : rawResult.event_data);
                if (_.isError(result)) return;

                if (result.is_finish) {
                    isEnd = true;
                    finalize();
                    return resolve(data);
                }

                const message = result.message;
                if (!message || !message.content) return;

                let text = "";
                const parsed = _.attempt(() => JSON.parse(message.content));
                if (!_.isError(parsed)) {
                    if (typeof parsed === "string") text = parsed;
                    else if (typeof parsed.text === "string") text = parsed.text;
                    else if (parsed.delta && typeof parsed.delta.text === "string") text = parsed.delta.text;
                } else if (typeof message.content === "string") {
                    text = message.content;
                }
                if (text) data.choices[0].message.content += text;

                const ctype = message.content_type;
                if (ctype === 2074) {
                    const payload = _.isError(parsed) ? _.attempt(() => JSON.parse(message.content)) : parsed;
                    if (!_.isError(payload) && payload && Array.isArray(payload.creations)) {
                        payload.creations.forEach((c: any) => {
                            const vidObj = c?.video;
                            if (vidObj) {
                                const vid = vidObj.vid;
                                const cover = vidObj.video_cover?.url;
                                const url = vidObj.video_url;
                                if (vid && !emittedKeys.has(vid)) {
                                    emittedKeys.add(vid);
                                    videos.push({ vid, cover, url });
                                    fs.appendFileSync(logPath, `[VIDEO INFO FOUND] VID: ${vid}\n`);
                                }
                            }
                        });
                    }
                }
            } catch (err) {
                fs.appendFileSync(logPath, `[PARSER ERROR] ${err.message}\n`);
                reject(err);
            }
        });

        stream.on("data", (buffer: any) => {
            const bufferStr = buffer.toString();
            // 1. 记录原始块（必须第一时间记录）
            fs.appendFileSync(logPath, `[RAW CHUNK RECEIVED] len=${bufferStr.length}, content=${bufferStr}\n`);

            // 2. 立即进行正则提取 ID，并记录结果
            const match = bufferStr.match(/\\?"conversation_id\\?":\\?"(\d+)\\?"/);
            if (match && match[1]) {
                const capturedId = match[1];
                if (!data.id) data.id = capturedId;
                fs.appendFileSync(logPath, `[REGEX MATCH SUCCESS] Found ID: ${capturedId}\n`);
                logger.info(`[Video] 抓取到 ID: ${capturedId}`);
            } else {
                fs.appendFileSync(logPath, `[REGEX MATCH FAIL] This chunk contains no ID\n`);
            }

            // 3. 喂给解析器并记录
            fs.appendFileSync(logPath, `[FEEDING PARSER]...\n`);
            parser.feed(bufferStr);
        });
        stream.once("error", (err: any) => {
            fs.appendFileSync(logPath, `[STREAM ERROR] ${err.stack}\n`);
            reject(err);
        });
        stream.once("close", () => {
            fs.appendFileSync(logPath, `[STREAM CLOSED]\n`);
            finalize();
            if (!data.id && !data.choices[0].message.content && videos.length === 0) {
                reject(new APIException(EX.API_REQUEST_FAILED, "RETRY_GENERATION_EMPTY: 会话 ID 为空且内容为空，说明生成识别需重试"));
                return;
            }
            resolve(data);
        });
    });
}

/**
 * 创建转换流 (SSE)
 */
function createTransStream(stream: any, endCallback?: Function, context?: any, account?: any, autoDelete = false) {
    let convId = "";
    let usageSent = false;
    let temp = Buffer.from('');
    const created = util.unixTimestamp();
    const emittedKeys = new Set<string>();
    const transStream = new PassThrough();

    // 异步任务追踪
    const pendingTasks: Promise<void>[] = [];
    let isInputFinished = false;

    const safeClose = async () => {
        try {
            await Promise.all(pendingTasks);
        } catch (e) {
            logger.error(`[Video] 等待异步任务失败: ${e}`);
        }
        if (!usageSent && !transStream.closed) {
            transStream.write(`data: ${JSON.stringify({
                id: convId,
                model: MODEL_NAME,
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                },
                created,
            })}\n\n`);
            usageSent = true;
        }
        if (!transStream.closed) {
            transStream.end("data: [DONE]\n\n");
        }
        endCallback && endCallback(convId);
    };

    const checkAndClose = () => {
        if (isInputFinished) {
            safeClose();
        }
    };

    // 初始包
    !transStream.closed && transStream.write(
        `data: ${JSON.stringify({
            id: convId,
            model: MODEL_NAME,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
            created,
        })} 

`
    );

    const parser = createParser((event) => {
        try {
            if (event.type !== "event") return;
            const rawResult = _.attempt(() => JSON.parse(event.data));
            if (_.isError(rawResult)) return;

            if (rawResult.event_type == 2003) {
                transStream.write(`data: ${JSON.stringify({
                    id: convId,
                    model: MODEL_NAME,
                    object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }],
                    created,
                })} 

`);
                isInputFinished = true;
                checkAndClose();
                return;
            }

            if (rawResult.event_type != 2001) return;

            const result = _.attempt(() => JSON.parse(rawResult.event_data));
            if (_.isError(result)) return;

            if (!convId) convId = result.conversation_id;

            if (result.is_finish) {
                transStream.write(`data: ${JSON.stringify({
                    id: convId,
                    model: MODEL_NAME,
                    object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }],
                    created,
                })} 

`);
                isInputFinished = true;
                checkAndClose();
                return;
            }

            const message = result.message;
            if (!message || !message.content) return;

            // 解析内容
            const content = _.attempt(() => JSON.parse(message.content));

            // 检查视频生成信息
            if (message.content_type === 2074 && !_.isError(content)) {
                const creations = Array.isArray((content as any).creations) ? (content as any).creations : [];
                for (const c of creations) {
                    const vidObj = c?.video;
                    if (vidObj) {
                        const vid = vidObj.vid;
                        const cover = vidObj.video_cover?.url;
                        const url = vidObj.video_url; // 如果直接有
                        if (vid && !emittedKeys.has(vid)) {
                            emittedKeys.add(vid);

                            // 异步获取无水印地址
                            const task = (async () => {
                                let finalUrl = url || `(ID: ${vid})`;
                                if (context) {
                                    const noWatermark = await getVideoPlayInfo(vid, context);
                                    if (noWatermark) finalUrl = noWatermark;
                                }

                                const md = `![视频封面](${cover})
视频链接: ${finalUrl}
`;
                                if (!transStream.closed) {
                                    transStream.write(`data: ${JSON.stringify({
                                        id: convId,
                                        model: MODEL_NAME,
                                        object: "chat.completion.chunk",
                                        choices: [{ index: 0, delta: { role: "assistant", content: md }, finish_reason: null }],
                                        created,
                                    })} 

`);
                                }
                            })();
                            pendingTasks.push(task);
                        }
                    }
                }
            }

            // 解析文本
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
                    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
                    created,
                })} 

`);
            }

        } catch (err) {
            logger.error(err);
            if (!transStream.closed) transStream.end("\n\n");
        }
    });

    stream.on("data", (buffer: any) => {
        if (buffer.toString().indexOf('') !== -1) {
            temp = Buffer.concat([temp, buffer]);
            return;
        }
        if (temp.length > 0) {
            buffer = Buffer.concat([temp, buffer]);
            temp = Buffer.from('');
        }
        parser.feed(buffer.toString());
    });
    stream.once("error", () => {
        isInputFinished = true;
        checkAndClose();
    });
    stream.once("close", () => {
        isInputFinished = true;
        checkAndClose();
    });
    return transStream;
}

/**
 * Token切分
 */
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
    createVideoCompletion,
    createVideoCompletionStream,
    getTokenLiveStatus,
    removeConversation,
    tokenSplit,
};
