/**
 * @file video.ts
 * @description 视频生成服务控制器。
 * 核心职责：
 * 1. 封装向豆包（Doubao）发送的文生视频/图生视频（多模态）请求。
 * 2. 维持与豆包的消息拉取及状态轮询（IM-based polling），保证无水印视频的准确抓取与后置用量扣减。
 * 3. 实时审查轮询期间豆包返回的警告消息（包含侵权、违规、版权受限、肖像保护/真实人脸等），在触发安全策略时快速中断并向客户端报告错误。
 */
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
const PC_VERSION = "3.29.7";

/**
 * 映射前端输入的模型名到豆包官方模型名
 */
function mapModelName(model?: string): string {
    if (!model) {
        throw new APIException(EX.API_REQUEST_FAILED, "model parameter is required");
    }
    const lower = model.toLowerCase();
    if (lower === "sdmini" || lower === "seedance_v2.0_mini") {
        return "seedance_v2.0_mini";
    }
    if (lower === "sdfast" || lower === "seedance_v2.0_std" || lower === "seedance_v2.0") {
        return "seedance_v2.0";
    }
    throw new APIException(EX.API_REQUEST_FAILED, `Unsupported model: ${model}. Supported models are: sdmini, sdfast, seedance_v2.0_mini, seedance_v2.0, seedance_v2.0_std`);
}

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
            doubao_device_platform: "web",
            doubao_pc_version: PC_VERSION,
            language: "zh",
            pc_version: PC_VERSION,
            pkg_type: "release_version",
            real_aid: DEFAULT_ASSISTANT_ID,
            region: "CN",
            samantha_web: 1,
            sys_region: "CN",
            tea_uuid: context.webId,
            tz_name: "Asia/Shanghai",
            "use-olympus-account": 1,
            version_code: VERSION_CODE,
            web_id: context.webId,
            web_platform: "browser",
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
function stripVideoWatermarkUrl(url: string): string {
    if (!url) return url;
    let clean = url.replace(/([?&])lr=video_gen_watermark[^&]*/g, '$1');
    clean = clean.replace(/\?&/, '?').replace(/&&+/g, '&').replace(/[?&]$/, '');
    return clean;
}

/**
 * 通过 Samantha 空间 3 步 API 获取真正的无水印高清视频下载地址
 */
async function getVideoPlayInfo(vid: string, context: AccountContext): Promise<string | null> {
    try {
        const queryParams = {
            aid: DEFAULT_ASSISTANT_ID,
            device_platform: "web",
            samantha_web: 1,
            "use-olympus-account": 1,
            version_code: VERSION_CODE,
            pkg_type: "release_version"
        };

        // 1. 获取 '我的创作' 文件夹根节点 ID
        const homepageRes = await request("POST", "/samantha/aispace/homepage", context, {
            params: queryParams,
            data: {}
        });

        const children = homepageRes?.children || homepageRes?.data?.children || [];
        let cid: string | null = null;
        for (const item of children) {
            if (item.name === "我的创作" || item.allow_delete === false) {
                cid = item.id;
                break;
            }
        }
        if (!cid && children.length > 0) {
            cid = children[0].id;
        }

        if (!cid) {
            logger.warn(`[Video] 未找到创作文件夹，无法获取无水印地址 vid=${vid}`);
            return null;
        }

        // 2. 获取文件夹下的作品节点 nid
        const nodeInfoRes = await request("POST", "/samantha/aispace/node_info", context, {
            params: queryParams,
            data: {
                node_id: cid,
                need_full_path: true,
                size: 50,
                sort_param: { need_sort_config: true, sort_order: 1, sort_type: 0 }
            }
        });

        const nodeChildren = nodeInfoRes?.children || nodeInfoRes?.data?.children || [];
        let nid: string | null = null;
        for (const node of nodeChildren) {
            const key = String(node.key || "");
            if (key === vid || key.includes(vid) || String(node.vid || "") === vid) {
                nid = node.id;
                break;
            }
        }

        if (!nid && nodeChildren.length > 0) {
            nid = nodeChildren[0].id;
        }

        if (!nid) {
            logger.warn(`[Video] 未在空间节点匹配到 vid=${vid}`);
            return null;
        }

        // 3. 获取无水印直链 (videoweb-download.doubao.com)
        const downloadInfoRes = await request("POST", "/samantha/aispace/get_download_info", context, {
            params: queryParams,
            data: {
                requests: [{ node_id: nid }]
            }
        });

        const downloadInfos = downloadInfoRes?.download_infos || downloadInfoRes?.data?.download_infos || [];
        if (downloadInfos.length > 0 && downloadInfos[0].main_url) {
            const unwatermarkedUrl = downloadInfos[0].main_url;
            logger.success(`[Video] 成功通过 AISpace 3步 API 获取到无水印视频直链: ${vid}`);
            return unwatermarkedUrl;
        }
    } catch (err: any) {
        logger.error(`[Video] 通过 AISpace 获取无水印地址失败: ${err.message}`);
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
                    // 安全审查与肖像保护/违规拦截检测
                    const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || "");
                    if (isViolationMessage(contentStr)) {
                        logger.error(`[Video 违规/侵权] 轮询消息链检测到安全风控/版权拦截: ${contentStr}`);
                        throw new APIException(
                            EX.API_REQUEST_FAILED,
                            "生成内容中疑似包含侵权 / 违规内容，无法返回该内容，换个主题再试试，生成额度未扣除。"
                        );
                    }
                    if (contentStr.includes("今天的生成次数已经达到上限") || contentStr.includes("生成次数已经达到上限")) {
                        logger.error(`[Video] 今天的生成次数已经达到上限`);
                        throw new APIException(
                            EX.API_REQUEST_FAILED,
                            "RETRY_GENERATION_LIMIT: 今天的生成次数已经达到上限，请换个账号或明天再试。"
                        );
                    }
                    if (isGeneratingMessage(contentStr)) {
                        const waitTime = extractWaitTimeText(contentStr);
                        logger.info(`[Video] 轮询抓取到渲染状态 (convId=${convId}): 预计等待 ${waitTime}`);
                    }

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
                                            } else {
                                                finalUrl = stripVideoWatermarkUrl(finalUrl);
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
            if (err instanceof APIException) {
                throw err;
            }
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
    videoParams: { model: string; prompt: string; ratio: string; image?: VideoReferenceImage; duration: number },
    account: any,
    assistantId = DEFAULT_ASSISTANT_ID,
    retryCount = 0,
    autoDelete = false
) {
    return (async () => {
        const { prompt, ratio, image, model, duration } = videoParams;
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
                    ability_param: JSON.stringify({
                        ratio: ratio || "16:9",
                        model: mapModelName(model),
                        duration: Number(duration)
                    })
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
                    is_from_click_option: false,
                    is_from_click_softlink: false,
                    disable_sse_cache: false,
                    select_text_action: "",
                    is_select_text: false,
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
                    is_old_user: true,
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
                user_context: []
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
        let currentAnswer = await receiveStream(response.data);
        const convId = currentAnswer.id;

        logger.info(`[Video] 视频生成会话创建成功 ID=${convId}`);

        if (!convId || convId === "0") {
            throw new APIException(
                EX.API_REQUEST_FAILED,
                "RETRY_GENERATION_EMPTY: 视频生成未返回会话ID，已终止轮询"
            );
        }

        // 步骤 1: 如果触发了【确认生成】按钮授权卡片，自动发送二次按钮点击确认请求
        if (currentAnswer.creationBtnRelyInfo) {
            const btnConfirmAns = await sendVideoConfirmRequest(convId, currentAnswer.creationBtnRelyInfo, videoParams, context);
            if (btnConfirmAns && btnConfirmAns.choices && btnConfirmAns.choices[0]?.message?.content) {
                currentAnswer = btnConfirmAns;
            }
        }

        let currentText = currentAnswer.choices[0]?.message?.content || "";

        // 步骤 2: 检查是否触发违规/侵权/肖像保护阻断
        if (isViolationMessage(currentText)) {
            logger.error(`[Video 违规/侵权] 内容触发安全风控或版权限制 (convId=${convId}): ${currentText}`);
            throw new APIException(
                EX.API_REQUEST_FAILED,
                "生成内容中疑似包含侵权 / 违规内容，无法返回该内容，换个主题再试试，生成额度未扣除。"
            );
        }

        // 步骤 3: 如果当前文本既非“正在生成”又非“违规/侵权”，说明豆包在要求确认参数或免责声明，自动补发免责确认文本
        if (!isGeneratingMessage(currentText) && currentText.trim().length > 0) {
            logger.info(`[Video] 收到澄清/参数确认提示: "${currentText.substring(0, 80)}..."`);
            const defaultConfirmText = "我已获得人物授权，一切侵权风险自行承担，继续生成";
            const textConfirmAns = await sendTextConfirmRequest(convId, defaultConfirmText, videoParams, context);
            if (textConfirmAns && textConfirmAns.choices && textConfirmAns.choices[0]?.message?.content) {
                currentAnswer = textConfirmAns;
                currentText = currentAnswer.choices[0]?.message?.content || "";
            }
        }

        // 步骤 4: 再次二次校验确认后的文本状态
        if (isViolationMessage(currentText)) {
            logger.error(`[Video 违规/侵权] 内容触发安全风控或版权限制 (convId=${convId}): ${currentText}`);
            throw new APIException(
                EX.API_REQUEST_FAILED,
                "生成内容中疑似包含侵权 / 违规内容，无法返回该内容，换个主题再试试，生成额度未扣除。"
            );
        }

        if (isGeneratingMessage(currentText)) {
            const waitTime = extractWaitTimeText(currentText);
            logger.info(`[Video] 任务已成功提交至豆包渲染引擎 (convId=${convId}) | 预计等待时间: ${waitTime}`);
        } else {
            logger.info(`[Video] 会话初始化完成 (convId=${convId})，进入后台轮询...`);
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
            currentAnswer.choices[0].message.content = md;
            currentAnswer.choices[0].message.videos = videos;

            // 成功时后扣费累加次数
            const accountId = (account as any).id;
            if (accountId) {
                AccountManager.updateAccountUsage(accountId, 'video', 0, 0);
                TokenCounter.recordUsage(accountId, 0, 0);
            }
        } else {
            throw new APIException(
                EX.API_REQUEST_FAILED,
                "获取视频结果超时，请稍后在历史记录中查看"
            );
        }

        if (autoDelete) {
            removeConversation(convId, context).catch(
                (err) => console.error('移除视频生成会话失败：', err)
            );
        }

        return currentAnswer;
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
    videoParams: { model: string; prompt: string; ratio: string; image?: VideoReferenceImage; duration: number },
    account: any,
    assistantId = DEFAULT_ASSISTANT_ID,
    retryCount = 0,
    autoDelete = false
) {
    return (async () => {
        const { prompt, ratio, image, model, duration } = videoParams;
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
                    ability_param: JSON.stringify({
                        ratio: ratio || "16:9",
                        model: mapModelName(model),
                        duration: Number(duration)
                    })
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
                    is_from_click_option: false,
                    is_from_click_softlink: false,
                    disable_sse_cache: false,
                    select_text_action: "",
                    is_select_text: false,
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
                    is_old_user: true,
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
                user_context: [],
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
 * 从 SSE Chunk 中提取 creation_btn_rely_info
 */
function extractCreationBtnRelyInfo(str: string): string | null {
    if (!str || !str.includes("creation_btn_rely_info")) return null;
    try {
        const match = str.match(/\\?"creation_btn_rely_info\\?"\s*:\s*\\?"((?:\\.|[^"])+)\\?"/);
        if (match && match[1]) {
            let val = match[1];
            val = val.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            return val;
        }
    } catch (e) {
        logger.error(`[Video] 解析 creation_btn_rely_info 失败:`, e);
    }
    return null;
}

/**
 * 判断视频生成响应文本是否属于“正在生成”标志
 */
function isGeneratingMessage(text: string): boolean {
    if (!text) return false;
    return (
        (text.includes("本次使用") && text.includes("生成")) ||
        text.includes("视频生成好后") ||
        text.includes("这就为您生成视频") ||
        text.includes("大约需要") ||
        text.includes("预计等待")
    );
}

/**
 * 判断视频生成响应文本是否属于违规/侵权/风控拦截标志
 */
function isViolationMessage(text: string): boolean {
    if (!text) return false;
    return (
        text.includes("疑似包含侵权") ||
        text.includes("侵权 / 违规") ||
        text.includes("换个主题再试试") ||
        text.includes("无法返回该内容") ||
        text.includes("生成额度未扣除") ||
        text.includes("出于肖像保护考虑") ||
        text.includes("不支持上传真实人脸") ||
        text.includes("真实人脸素材")
    );
}

/**
 * 提取生成提示中的预计等待时间
 */
function extractWaitTimeText(text: string): string {
    if (!text) return "预计 1-3 分钟";
    const match = text.match(/(?:预计等待|大约需要|需要)\s*([0-9\-\s~～分钟秒]+)/);
    if (match && match[1]) {
        return match[1].trim();
    }
    return "已提交渲染 (预计 1-10 分钟)";
}

/**
 * 自动发送视频生成授权二次确认请求（按钮点击协议）
 */
async function sendVideoConfirmRequest(
    convId: string,
    creationBtnRelyInfo: string,
    videoParams: { model: string; prompt: string; ratio: string; duration: number },
    context: AccountContext
): Promise<any> {
    logger.info(`[Video] 触发授权卡片【确认生成】，发送按钮点击协议 (convId=${convId})...`);
    const { ratio, model, duration } = videoParams;
    const contentBlocks = [
        {
            block_type: 10000,
            content: {
                text_block: {
                    text: "确认生成",
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
        }
    ];

    const confirmMessage = [
        {
            local_message_id: util.uuid(),
            content_block: contentBlocks,
            message_status: 0
        }
    ];

    const localConvId = `local_${util.generateRandomString({ length: 16, charset: "numeric" })}`;

    try {
        const response: any = await request("post", "/chat/completion", context, {
            data: {
                client_meta: {
                    local_conversation_id: localConvId,
                    conversation_id: convId,
                    bot_id: "7338286299411103781",
                    last_section_id: "",
                    last_message_index: null
                },
                conversation_id: convId,
                local_conversation_id: localConvId,
                local_message_id: util.uuid(),
                messages: confirmMessage,
                completion_option: {
                    is_regen: false,
                    with_suggest: false,
                    need_create_conversation: false,
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
                    ability_param: JSON.stringify({
                        ratio: ratio || "16:9",
                        model: mapModelName(model),
                        duration: Number(duration)
                    })
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
                    is_from_click_option: true,
                    is_from_click_softlink: false,
                    disable_sse_cache: false,
                    select_text_action: "",
                    is_select_text: false,
                    resend_for_regen: false,
                    scene_type: 0,
                    unique_key: util.uuid(),
                    start_seq: 0,
                    need_create_conversation: false,
                    conversation_init_option: {
                        need_ack_conversation: false
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
                    is_old_user: true,
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
                    conversation_init_option: JSON.stringify({ need_ack_conversation: false }),
                    commerce_credit_config_enable: "0",
                    sub_conv_firstmet_type: "1",
                    creation_btn_rely_info: creationBtnRelyInfo
                },
                user_context: []
            },
            headers: {
                Referer: `https://www.doubao.com/chat/${convId}`,
                "agw-js-conv": "str, str",
            },
            timeout: 300000,
            responseType: "stream"
        });

        if (response && response.data) {
            const res = await receiveStream(response.data);
            logger.success(`[Video] 按钮授权【确认生成】发送成功！convId=${convId}`);
            return res;
        }
    } catch (err: any) {
        logger.error(`[Video] 按钮授权【确认生成】发送失败: ${err.message}`);
    }
    return null;
}

/**
 * 发送免责/文本确认消息（“我已获得人物授权，一切侵权风险自行承担，继续生成”）
 */
async function sendTextConfirmRequest(
    convId: string,
    confirmText: string,
    videoParams: { model: string; prompt: string; ratio: string; duration: number },
    context: AccountContext
): Promise<any> {
    logger.info(`[Video] 收到澄清/参数确认提示，发送文本确认消息 (convId=${convId}): "${confirmText}"...`);
    const { ratio, model, duration } = videoParams;
    const contentBlocks = [
        {
            block_type: 10000,
            content: {
                text_block: {
                    text: confirmText,
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
        }
    ];

    const confirmMessage = [
        {
            local_message_id: util.uuid(),
            content_block: contentBlocks,
            message_status: 0
        }
    ];

    const localConvId = `local_${util.generateRandomString({ length: 16, charset: "numeric" })}`;

    try {
        const response: any = await request("post", "/chat/completion", context, {
            data: {
                client_meta: {
                    local_conversation_id: localConvId,
                    conversation_id: convId,
                    bot_id: "7338286299411103781",
                    last_section_id: "",
                    last_message_index: null
                },
                conversation_id: convId,
                local_conversation_id: localConvId,
                local_message_id: util.uuid(),
                messages: confirmMessage,
                completion_option: {
                    is_regen: false,
                    with_suggest: false,
                    need_create_conversation: false,
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
                    ability_param: JSON.stringify({
                        ratio: ratio || "16:9",
                        model: mapModelName(model),
                        duration: Number(duration)
                    })
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
                    is_from_click_option: false,
                    is_from_click_softlink: false,
                    disable_sse_cache: false,
                    select_text_action: "",
                    is_select_text: false,
                    resend_for_regen: false,
                    scene_type: 0,
                    unique_key: util.uuid(),
                    start_seq: 0,
                    need_create_conversation: false,
                    conversation_init_option: {
                        need_ack_conversation: false
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
                    is_old_user: true,
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
                    conversation_init_option: JSON.stringify({ need_ack_conversation: false }),
                    commerce_credit_config_enable: "0",
                    sub_conv_firstmet_type: "1"
                },
                user_context: []
            },
            headers: {
                Referer: `https://www.doubao.com/chat/${convId}`,
                "agw-js-conv": "str, str",
            },
            timeout: 300000,
            responseType: "stream"
        });

        if (response && response.data) {
            const res = await receiveStream(response.data);
            logger.success(`[Video] 免责确认文本发送成功！convId=${convId}`);
            return res;
        }
    } catch (err: any) {
        logger.error(`[Video] 免责确认文本发送失败: ${err.message}`);
    }
    return null;
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

                const errCode = rawResult.error_code || rawResult.code;
                const errMsg = rawResult.error_msg || rawResult.message || rawResult.msg;
                if (errCode || (event as any).event === "STREAM_ERROR") {
                    const detailMsg = errMsg ? `${errCode || ""}-${errMsg}` : "触发频率限制/人机验证";
                    logger.error(`[请求doubao失败]: ${detailMsg}`);
                    throw new APIException(
                        EX.API_REQUEST_FAILED,
                        `[请求doubao失败]: ${detailMsg} (账号触发豆包频率限制 rate limited 或验证码，请稍后再试或更换账号)`
                    );
                }

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
                const contentStr = typeof message.content === 'string' ? message.content : JSON.stringify(message.content || "");
                if (contentStr.includes("今天的生成次数已经达到上限") || contentStr.includes("生成次数已经达到上限")) {
                    throw new APIException(
                        EX.API_REQUEST_FAILED,
                        "RETRY_GENERATION_LIMIT: 今天的生成次数已经达到上限，请换个账号或明天再试。"
                    );
                }

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

        let creationBtnRelyInfo: string | null = null;

        stream.on("data", (buffer: any) => {
            const bufferStr = buffer.toString();
            // 1. 记录原始块（必须第一时间记录）
            fs.appendFileSync(logPath, `[RAW CHUNK RECEIVED] len=${bufferStr.length}, content=${bufferStr}\n`);

            // 提取二次授权确认信息
            if (!creationBtnRelyInfo) {
                const info = extractCreationBtnRelyInfo(bufferStr);
                if (info) creationBtnRelyInfo = info;
            }

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
            if (creationBtnRelyInfo) {
                (data as any).creationBtnRelyInfo = creationBtnRelyInfo;
            }
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

            const errCode = rawResult.error_code || rawResult.code;
            if (errCode || (event as any).event === "STREAM_ERROR") {
                const errMsg = rawResult.error_msg || rawResult.message || "rate limited";
                logger.error(`[流式视频生成失败]: ${errCode || ""}-${errMsg}`);
                transStream.write(`data: ${JSON.stringify({
                    id: convId,
                    model: MODEL_NAME,
                    object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: { role: "assistant", content: `[服务错误]: 账号触发风控限制 (${errMsg})` }, finish_reason: "stop" }],
                    created,
                })}\n\n`);
                isInputFinished = true;
                checkAndClose();
                return;
            }

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
        try {
            const tracePath = path.join(process.cwd(), "debug_video_trace.log");
            fs.appendFileSync(tracePath, `[TRANS STREAM RAW CHUNK] len=${buffer.length}, content=${buffer.toString()}\n`);
        } catch (e) {}

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
