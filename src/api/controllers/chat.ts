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
import AccountManager from "@/lib/account-manager.ts";
import TokenCounter from "@/lib/token-counter.ts";


// 豆包模型名称
const MODEL_NAME = "doubao";
// 默认助手 ID
const DEFAULT_ASSISTANT_ID = "497858";
// 版本代码
const VERSION_CODE = "20800";
// PC 版本号 (模拟特定版本的 PC 客户端行为)
const PC_VERSION = "2.44.0";

// 账号上下文接口，保存会话所需的各种 ID 和 Token
interface AccountContext {
    token: string;
    deviceId: string;
    webId: string;
    userId: string;
}

// 最大重试次数
const MAX_RETRY_COUNT = 3;
// 重试延迟 (毫秒)
const RETRY_DELAY = 5000;
// 伪造浏览器请求头 (Fake Headers)
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
// 文件上传最大限制 (100MB)
const FILE_MAX_SIZE = 100 * 1024 * 1024;

// ===== 工具调用 (Tool Calling) 逻辑支持 =====

const TOOL_CALL_START = "<<<tool_call>>>";
const TOOL_CALL_END = "<<<end_tool_call>>>";

/**
 * 将 OpenAI 的 tools 格式转换为提示词，并注入到 system prompt 中
 */
function buildToolSystemPrompt(tools: any[]): string {
    if (!tools || !tools.length) return "";
    const toolDescriptions = tools
        .filter((t: any) => t?.type === "function" && t?.function)
        .map((t: any) => {
            const fn = t.function;
            let desc = `- **${fn.name}**`;
            if (fn.description) desc += `: ${fn.description}`;
            if (fn.parameters?.properties) {
                const params = Object.entries(fn.parameters.properties)
                    .map(([k, v]: [string, any]) => {
                        const required = fn.parameters.required?.includes(k) ? "(required)" : "(optional)";
                        return `    - ${k} (${v.type || "any"}) ${required}: ${v.description || ""}`;
                    })
                    .join("\n");
                desc += "\n  Params:\n" + params;
            }
            return desc;
        })
        .join("\n\n");

    return `You are an action-oriented assistant with tool-calling capability. Use tools when they are the most direct way to complete the user request.

Tool call format:
${TOOL_CALL_START}
{"name":"tool_name","arguments":{"key":"value"}}
${TOOL_CALL_END}

Available tools:
${toolDescriptions}

Rules:
1. Prefer tool calls for concrete actions.
2. Keep normal text concise when a tool call is needed.
3. Arguments must be valid JSON.
4. If no tool fits, reply normally.`;
}

/**
 * 解析文本中的工具调用 tool_call
 * 返回 null 如果未解析到工具调用则返回 null，此时应按普通对话处理
 */
function parseToolCalls(text: string): { toolCalls: any[]; textContent: string } | null {
    if (!text || !text.includes(TOOL_CALL_START)) return null;

    const toolCalls: any[] = [];
    let textContent = text;
    const regex = new RegExp(
        `${escapeRegex(TOOL_CALL_START)}\\s*([\\s\\S]*?)\\s*${escapeRegex(TOOL_CALL_END)}`,
        "g"
    );
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
        try {
            const parsed = JSON.parse(match[1].trim());
            toolCalls.push({
                id: `call_${crypto.randomBytes(12).toString("hex")}`,
                type: "function",
                function: {
                    name: parsed.name,
                    arguments: typeof parsed.arguments === "string"
                        ? parsed.arguments
                        : JSON.stringify(parsed.arguments || {}),
                },
            });
        } catch (e) {
            logger.warn(`[工具调用] 解析 JSON 失败: ${match[1]}`);
        }
        // 移除已经成功解析的工具调用文本，避免在最终输出中重复显示内容
        textContent = textContent.replace(match[0], "");
    }

    if (!toolCalls.length) return null;

    textContent = textContent.trim();
    return { toolCalls, textContent };
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 获取 Access Token (用于 API 请求鉴权)
 *
 * 豆包的 Access Token 获取逻辑，目前直接返回 refreshToken
 *
 * @param refreshToken 刷新令牌
 */
async function acquireToken(refreshToken: string): Promise<string> {
    return refreshToken;
}

/**
 * 生成随机 msToken
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
 * 生成随机 a_bogus 参数
 */
function generateFakeABogus() {
    return `mf-${util.generateRandomString({length: 34,})}-${util.generateRandomString({length: 6,})}`;
}

/**
 * 清理文本中的 Base64 图片数据，避免日志过长
 */
function cleanBase64(text: string): string {
    if (!text) return "";
    let t = text;
    while (true) {
        const start = t.indexOf("data:image/");
        if (start === -1) break;
        const end = t.indexOf(",", start);
        if (end === -1) break;
        // 检测并获取会话中的图片引用信息
        let nextQuote = t.indexOf('"', end);
        if (nextQuote === -1) nextQuote = t.length;
        t = t.slice(0, start) + "[BASE64_IMAGE]" + t.slice(nextQuote);
    }
    return t;
}

/**
 * 生成 Cookie 字符串
 */
function generateCookie(refreshToken: string) {
    return [
        `sessionid=${refreshToken}`,
        `sessionid_ss=${refreshToken}`,
    ].join("; ");
}

/**
 * 豆包 API 请求封装
 *
 * @param method 请求方法
 * @param uri 请求路径
 * @param context 账号上下文
 * @param options 其他选项
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

    logRequest(requestConfig.method || method, requestConfig.url || uri, requestConfig.params, requestConfig.headers, requestConfig.data);

    const response = await axios.request(requestConfig);
    // 如果是流响应，则直接返回响应对象
    if (options.responseType == "stream")
        return response;
    return checkResult(response);
}

/**
 * 检查响应结果，提取数据或抛出异常
 */
function checkResult(result: AxiosResponse) {
    if (!result.data) return null;
    const { code, msg, data } = result.data;
    if (!_.isFinite(code)) return result.data;
    if (code === 0) return data;
    throw new APIException(EX.API_REQUEST_FAILED, `[豆包请求失败]: ${msg || "未知错误"}`);
}

/**
 * 删除会话逻辑
 *
 * 该函数负责清理已生成的会话，以保持账户环境整洁。
 *
 * @param convId 会话 ID
 * @param context 账号上下文
 */
async function removeConversation(
    convId: string,
    context: AccountContext
) {
    if (!convId || convId === "0") {
        logger.warn("跳过删除会话，因为 convId 为空或无效");
        return;
    }
    try {
        const params = {
            msToken: generateFakeMsToken(),
            a_bogus: generateFakeABogus()
        };

        // 提取引用文件 URL
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
        logger.success(`会话已删除: ${convId}`);
    } catch (err) {
        logger.error(`删除会话失败: ${convId}`, err);
    }
}



/**
 * 获取会话信息 (探测请求)
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

/**
 * 创建非流式响应
 *
 * @param messages 聊天消息列表
 * @param account 账户上下文 (包含 refreshToken 等)
 * @param assistantId 助手 ID (默认为豆包)
 * @param retryCount 重试次数
 */
async function createCompletion(
    messages: any[],
    account: any,
    assistantId = DEFAULT_ASSISTANT_ID,
    refConvId = "",
    retryCount = 0,
    tools?: any[],
    autoDelete = true,
    modelId = MODEL_NAME
) {
    return (async () => {
        logger.info(`收到 ${messages.length} 条消息`);
        const context = normalizeAccount(account);

        const refFileUrls = extractRefFileUrls(messages);
        const refs = refFileUrls.length
            ? await Promise.all(
                refFileUrls.map((fileUrl) => uploadFile(fileUrl, context))
            )
            : [];

        if (!/[0-9a-zA-Z]{24}/.test(refConvId)) refConvId = "";

        let response;
        if (modelId === "doubao-pro") {
            const prepared = messagesPrepare(messages, refs, !!refConvId, tools);
            let finalContent = "";
            try {
                const parsed = JSON.parse(prepared[0].content);
                finalContent = parsed.text || "";
            } catch {
                finalContent = prepared[0].content || "";
            }

            const localMsgId = util.uuid();
            const blockId = util.uuid();
            const uniqueKey = util.uuid();
            const timeMs = Date.now();
            const timeSec = Math.floor(timeMs / 1000);

            const proData = {
                client_meta: {
                    local_conversation_id: `local_16${util.generateRandomString({length: 14, charset: "numeric"})}`,
                    conversation_id: "0",
                    bot_id: "7338286299411103781",
                    last_section_id: "",
                    last_message_index: null
                },
                messages: [
                    {
                        local_message_id: localMsgId,
                        content_block: [
                            {
                                block_type: 10000,
                                content: {
                                    text_block: {
                                        text: finalContent,
                                        icon_url: "",
                                        icon_url_dark: "",
                                        summary: ""
                                    },
                                    pc_event_block: ""
                                },
                                block_id: blockId,
                                parent_id: "",
                                meta_info: [],
                                append_fields: []
                            }
                        ],
                        message_status: 0
                    }
                ],
                option: {
                    send_message_scene: "",
                    create_time_ms: timeMs,
                    collect_id: "",
                    is_audio: false,
                    answer_with_suggest: false,
                    tts_switch: false,
                    need_deep_think: 3,
                    click_clear_context: false,
                    from_suggest: false,
                    is_regen: false,
                    is_replace: false,
                    disable_sse_cache: false,
                    select_text_action: "",
                    resend_for_regen: false,
                    scene_type: 0,
                    unique_key: uniqueKey,
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
                        req_create_time_sec: timeSec,
                        append_sse_event_scene: 0
                    },
                    message_storage_type: 0
                },
                ext: {
                    use_deep_think: "3",
                    fp: "verify_mo74hegl_65XSbmNq_VzEk_4xVN_82vA_eSxvgTxd2Jbb",
                    collection_id: "",
                    conversation_init_option: "{\"need_ack_conversation\":true}",
                    commerce_credit_config_enable: "0",
                    sub_conv_firstmet_type: "1"
                }
            };

            response = await request("post", "/chat/completion", context, {
                data: proData,
                headers: {
                    Referer: "https://www.doubao.com/chat/",
                    "agw-js-conv": "str, str",
                },
                timeout: 300000,
                responseType: "stream"
            });
        } else {
            response = await request("post", "/samantha/chat/completion", context, {
                data: {
                    messages: messagesPrepare(messages, refs, !!refConvId, tools),
                    completion_option: {
                        is_regen: false,
                        with_suggest: true,
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
        }
        const contentType = response.headers["content-type"] || "";
        if (contentType.indexOf("text/event-stream") == -1) {
            response.data.on("data", (buffer) => logger.error(buffer.toString()));
            throw new APIException(
                EX.API_REQUEST_FAILED,
                `Stream response Content-Type invalid: ${response.headers["content-type"]}`
            );
        }

        const streamStartTime = util.timestamp();
        const answer = await receiveStream(response.data, modelId);
        logger.success(
            `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
        );

        // 处理消息中的附件 (如图片 Base64 等)，并注入文件引用信息
        const cleanPromptText = cleanBase64(messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join(""));
        const promptTokens = TokenCounter.estimateTokens(cleanPromptText);
        const completionText = answer.choices[0].message.content;
        const completionTokens = TokenCounter.estimateTokens(completionText);
        
        answer.usage = {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens
        };

        if (account && account.id) {
            AccountManager.updateAccountUsage(account.id, "chat", promptTokens, completionTokens);
            TokenCounter.recordUsage(account.id, promptTokens, completionTokens);
        }

        if (autoDelete) {
            removeConversation(answer.id, context).catch(
                (err) => !refConvId && console.error("删除会话失败", err)
            );
        }

        return answer;
    })().catch((err) => {
        logger.error(`响应错误: ${err.message || String(err)}`);
        throw err;
    });
}

async function probeCompletion(
    account: any,
    prompt = "1",
    modelId = MODEL_NAME
) {
    const context = normalizeAccount(account);
    const response = await request("post", "/samantha/chat/completion", context, {
        data: {
            messages: messagesPrepare([{ role: "user", content: prompt }], [], false),
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
            evaluate_option: { web_ab_params: "" },
            section_id: `26${util.generateRandomString({ length: 16, charset: "numeric" })}`,
            conversation_id: "0",
            local_conversation_id: `local_16${util.generateRandomString({ length: 14, charset: "numeric" })}`,
            local_message_id: util.uuid()
        },
        headers: {
            Referer: "https://www.doubao.com/chat/",
            "agw-js-conv": "str, str",
        },
        timeout: 45000,
        responseType: "stream"
    });

    const contentType = response.headers["content-type"] || "";
    if (contentType.indexOf("text/event-stream") === -1) {
        try {
            if (response.data && typeof response.data.destroy === "function") {
                response.data.destroy();
            }
        } catch {}
        throw new APIException(
            EX.API_REQUEST_FAILED,
            `流响应 Content-Type 异常: ${response.headers["content-type"]}`
        );
    }

    const result = await receiveProbeStream(response.data, modelId);
    if (result.id) {
        removeConversation(result.id, context).catch(
            (err) => logger.error(`探测会话删除失败: ${err?.message || err}`)
        );
    }
    return result;
}

/**
 * 创建流式响应
 *
 * @param messages 聊天消息列表
 * @param account 账户上下文 (包含 refreshToken 等)
 * @param assistantId 助手 ID (默认为豆包)
 * @param retryCount 重试次数
 */
async function createCompletionStream(
    messages: any[],
    account: any,
    assistantId = DEFAULT_ASSISTANT_ID,
    refConvId = "",
    retryCount = 0,
    tools?: any[],
    autoDelete = true,
    modelId = MODEL_NAME
) {
    return (async () => {
        logger.info(`收到 ${messages.length} 条消息 (流式)`);
        const context = normalizeAccount(account);

        const refFileUrls = extractRefFileUrls(messages);
        const refs = refFileUrls.length
            ? await Promise.all(
                refFileUrls.map((fileUrl) => uploadFile(fileUrl, context))
            )
            : [];

        if (!/[0-9a-zA-Z]{24}/.test(refConvId)) refConvId = "";

        let response;
        if (modelId === "doubao-pro") {
            const prepared = messagesPrepare(messages, refs, !!refConvId, tools);
            let finalContent = "";
            try {
                const parsed = JSON.parse(prepared[0].content);
                finalContent = parsed.text || "";
            } catch {
                finalContent = prepared[0].content || "";
            }

            const localMsgId = util.uuid();
            const blockId = util.uuid();
            const uniqueKey = util.uuid();
            const timeMs = Date.now();
            const timeSec = Math.floor(timeMs / 1000);

            const proData = {
                client_meta: {
                    local_conversation_id: `local_16${util.generateRandomString({length: 14, charset: "numeric"})}`,
                    conversation_id: "0",
                    bot_id: "7338286299411103781",
                    last_section_id: "",
                    last_message_index: null
                },
                messages: [
                    {
                        local_message_id: localMsgId,
                        content_block: [
                            {
                                block_type: 10000,
                                content: {
                                    text_block: {
                                        text: finalContent,
                                        icon_url: "",
                                        icon_url_dark: "",
                                        summary: ""
                                    },
                                    pc_event_block: ""
                                },
                                block_id: blockId,
                                parent_id: "",
                                meta_info: [],
                                append_fields: []
                            }
                        ],
                        message_status: 0
                    }
                ],
                option: {
                    send_message_scene: "",
                    create_time_ms: timeMs,
                    collect_id: "",
                    is_audio: false,
                    answer_with_suggest: false,
                    tts_switch: false,
                    need_deep_think: 3,
                    click_clear_context: false,
                    from_suggest: false,
                    is_regen: false,
                    is_replace: false,
                    disable_sse_cache: false,
                    select_text_action: "",
                    resend_for_regen: false,
                    scene_type: 0,
                    unique_key: uniqueKey,
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
                        req_create_time_sec: timeSec,
                        append_sse_event_scene: 0
                    },
                    message_storage_type: 0
                },
                ext: {
                    use_deep_think: "3",
                    fp: "verify_mo74hegl_65XSbmNq_VzEk_4xVN_82vA_eSxvgTxd2Jbb",
                    collection_id: "",
                    conversation_init_option: "{\"need_ack_conversation\":true}",
                    commerce_credit_config_enable: "0",
                    sub_conv_firstmet_type: "1"
                }
            };

            response = await request("post", "/chat/completion", context, {
                data: proData,
                headers: {
                    Referer: "https://www.doubao.com/chat/",
                    "agw-js-conv": "str, str",
                },
                timeout: 300000,
                responseType: "stream"
            });
        } else {
            response = await request("post", "/samantha/chat/completion", context, {
                data: {
                    messages: messagesPrepare(messages, refs, !!refConvId, tools),
                    completion_option: {
                        is_regen: false,
                        with_suggest: true,
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
        }

        if (response.status !== 200) {
            let errorMsg = `HTTP ${response.status} ${response.statusText}`;
            if (response.data && response.data.on) {
                // 尝试从响应流中读取错误信息 (如果存在)
                const errData = await new Promise((resolve) => {
                    response.data.once("data", (chunk: Buffer) => resolve(chunk.toString()));
                    setTimeout(() => resolve("timeout"), 1000);
                });
                errorMsg += ` - ${errData}`;
            }
            throw new APIException(EX.API_REQUEST_FAILED, `[豆包请求失败]: ${errorMsg}`);
        }
        const contentType = response.headers["content-type"] || "";
        if (contentType.indexOf("text/event-stream") == -1) {
            logger.error(
                `Invalid response Content-Type:`,
                response.headers["content-type"]
            );
            response.data.on("data", (buffer) => logger.error(buffer.toString()));
            const transStream = new PassThrough();
            transStream.end(
                `data: ${JSON.stringify({
                    id: "",
                    model: MODEL_NAME,
                    object: "chat.completion.chunk",
                    choices: [
                        {
                            index: 0,
                            delta: {
                                role: "assistant",
                                content: "流式响应已结束，但未收到任何内容。",
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
        const promptText = messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join("");
        return createTransStream(response.data, (convId: string) => {

            logger.success(
                `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
            );
            removeConversation(convId, context).catch(
                (err) => !refConvId && console.error(err)
            );
        }, !!(tools && tools.length), account, promptText, autoDelete, modelId);
    })().catch((err) => {
        logger.error(`流响应错误: ${err.message || String(err)}`);
        throw err;
    });
}

async function receiveProbeStream(stream: any, modelId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const data = {
            id: "",
            model: modelId || MODEL_NAME,
            object: "chat.completion",
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: "" },
                    finish_reason: "stop",
                },
            ],
            created: util.unixTimestamp(),
        };
        let settled = false;
        const timeout = setTimeout(() => {
            settle(
                reject,
                new APIException(EX.API_REQUEST_FAILED, "探测流请求超时")
            );
        }, 45000);

        const cleanup = () => {
            clearTimeout(timeout);
            stream.removeListener("data", onData);
            stream.removeListener("error", onError);
            stream.removeListener("close", onClose);
            stream.removeListener("end", onClose);
            try {
                if (!stream.destroyed && typeof stream.destroy === "function") {
                    stream.destroy();
                }
            } catch {}
        };

        const settle = (fn: (value?: any) => void, value?: any) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn(value);
        };

        const parser = createParser((event) => {
            try {
                if (event.type !== "event" || settled) return;
                const rawResult = _.attempt(() => JSON.parse(event.data));
                if (_.isError(rawResult)) {
                    throw new Error(`流响应格式异常: ${event.data}`);
                }
                if (rawResult.code) {
                    throw new APIException(EX.API_REQUEST_FAILED, `[豆包请求失败]: ${rawResult.code}-${rawResult.message}`);
                }
                if (rawResult.event_type === 2005 && rawResult.conversation_id && !data.id) {
                    data.id = rawResult.conversation_id;
                    return;
                }
                if (rawResult.event_type === 2003) {
                    if (rawResult.conversation_id && !data.id) {
                        data.id = rawResult.conversation_id;
                    }
                    settle(resolve, data);
                    return;
                }
                if (rawResult.event_type !== 2001) return;
                const result = _.attempt(() => JSON.parse(rawResult.event_data));
                if (_.isError(result)) {
                    throw new Error(`流响应数据解析异常: ${rawResult.event_data}`);
                }
                if (!data.id && result.conversation_id) {
                    data.id = result.conversation_id;
                }
                const message = result.message;
                if (!message?.content) {
                    if (result.is_finish) settle(resolve, data);
                    return;
                }
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
                if (text) {
                    data.choices[0].message.content += text;
                    settle(resolve, data);
                    return;
                }
                if (result.is_finish) {
                    settle(resolve, data);
                }
            } catch (err) {
                logger.error(err);
                settle(reject, err);
            }
        });

        const onData = (buffer: Buffer) => {
            parser.feed(buffer.toString());
        };
        const onError = (err: any) => settle(reject, err);
        const onClose = () => settle(resolve, data);

        stream.on("data", onData);
        stream.once("error", onError);
        stream.once("close", onClose);
        stream.once("end", onClose);
    });
}

/**
 * 从消息中提取引用的文件/图片 URL
 *
 * @param messages 聊天消息列表
 */
function extractRefFileUrls(messages: any[]) {
    const urls: string[] = [];
    if (!messages.length) return urls;

    const lastMessage = messages[messages.length - 1];

    const normalizeCandidate = (maybe: any): string | null => {
        if (!maybe || typeof maybe !== "string") return null;
        if (util.isBASE64Data(maybe)) return maybe;
        if (util.isBASE64(maybe) && maybe.length > 500) {
            try {
                const buf = Buffer.from(maybe, "base64");
                if (buf && buf.length > 4) {
                    const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
                    const jpg = buf[0] === 0xff && buf[1] === 0xd8;
                    const gif = buf.slice(0, 6).toString() === "GIF87a" || buf.slice(0, 6).toString() === "GIF89a";
                    const webp = buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP";
                    const mime = png ? "image/png" : jpg ? "image/jpeg" : gif ? "image/gif" : webp ? "image/webp" : "application/octet-stream";
                    return `data:${mime};base64,${maybe}`;
                }
            } catch (_) { /* ignore */
            }
        }
        return util.isURL(maybe) ? maybe : null;
    };

    if (Array.isArray(lastMessage.content)) {
        lastMessage.content.forEach((v: any) => {
            if (typeof v === "string") {
                const u = normalizeCandidate(v);
                if (u) urls.push(u);
                return;
            }
            if (!_.isObject(v)) return;
            const type = v["type"];
            if (type === "file" && _.isObject(v["file_url"]) && _.isString(v["file_url"]["url"])) {
                const u = normalizeCandidate(v["file_url"]["url"]);
                if (u) urls.push(u);
                return;
            }
            if (["image_url", "input_image", "image"].includes(type)) {
                const raw = _.get(v, ["image_url", "url"]) || v["image_url"];
                if (_.isString(raw)) {
                    const u = normalizeCandidate(raw);
                    if (u) urls.push(u);
                }
            }
        });
    }

    logger.info("找到 " + urls.length + " 个引用文件 URL");
    return urls;
}

/**
 * 掩码字符串中的 Base64 数据，防止日志过长。支持 data:URI 格式。
 * @param s
 */
function maskBase64InString(s: string): string {
    if (!s) return s;
    try {
        let t = s;
        // 处理 data:xxx;base64, 格式的内容掩码
        t = t.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/g, (m) => {
            return `data:...;base64,[OMITTED,len=${m.length}]`;
        });
        // 掩码超长 base64-like 字符串
        t = t.replace(/[A-Za-z0-9+/=]{500,}/g, (m) => `[[OMITTED_BASE64 len=${m.length}]]`);
        return t;
    } catch {
        return s;
    }
}

function truncateForLog(s: string, max = 200): string {
    if (!s) return "";
    if (s.length <= max) return s;
    return s.slice(0, max) + `...[剩余 ${s.length - max} 字符]`;
}

/**
 * 消息预处理逻辑
 *
 * 豆包的对话 API 需要将消息转换为其特定的格式，包括处理 Base64 图片/文件、
 * 注入工具调用的系统提示词、以及构造符合其接口要求的 JSON 结构。
 *
 * @param messages 原始消息列表 (OpenAI 格式)
 * @param refs 已经上传的文件/图片引用列表
 * @param isRefConv 是否是引用对话
 * @param tools 工具定义列表
 */
function messagesPrepare(messages: any[], refs: any[], isRefConv = false, tools?: any[]) {
    // 注入工具定义的系统提示词 (Tool system prompt)
    if (tools && tools.length > 0) {
        const toolPrompt = buildToolSystemPrompt(tools);
        if (toolPrompt) {
            messages = [{ role: "system", content: toolPrompt }, ...messages];
            logger.info("[工具调用] 已注入 tools 系统提示词到 system prompt");
        }
    }

    // 将 tool 角色消息转换为 user 消息，并提示是工具返回结果
    messages = messages.map((msg: any) => {
        if (msg.role === "tool") {
            return {
                role: "user",
                content: `[工具调用返回] 调用了函数 "${msg.name || "未知"}" 的结果如下:\n${msg.content}`,
            };
        }
        return msg;
    });

    let content;
    if (isRefConv || messages.length < 2) {
        content = messages.reduce((content, message) => {
            if (_.isArray(message.content)) {
                return message.content.reduce((_content, v) => {
                    if (!_.isObject(v) || v["type"] != "text") return _content;
                    return _content + (v["text"] || "") + "\n";
                }, content);
            }
            return content + `${message.content}\n`;
        }, "");
        logger.info("\n构建的 Prompt 内容:\n" + maskBase64InString(content));
    } else {
        let latestMessage = messages[messages.length - 1];
        let hasFileOrImage =
            Array.isArray(latestMessage.content) &&
            latestMessage.content.some(
                (v) =>
                    typeof v === "object" && ["file", "image_url"].includes(v["type"])
            );
        if (hasFileOrImage) {
            let newFileMessage = {
                content: "已自动检测并上传对话中的文件/图片，请结合附件内容进行回答。",
                role: "system",
            };
            messages.splice(messages.length - 1, 0, newFileMessage);
            logger.info("已注入文件/图片引导 system prompt");
        } else {
            // 如果需要注入纯文本引导提示词，可以在这里处理
            // let newTextMessage = {
            //   content: "[系统提示词] 自动处理上传附件相关的引导内容",
            //   role: "system",
            // };
            // messages.splice(messages.length - 1, 0, newTextMessage);
            // logger.info("已自动注入文件/图片引导 system prompt");
        }
        const cleanTextContent = (text: string): string => {
            if (!text) return "";
            let t = text;
            t = t.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/g, "");
            t = t.replace(/[A-Za-z0-9+/=]{500,}/g, "");
            t = t
                .split(/\r?\n/)
                .filter((line) => {
                    const trimmed = (line || "").trim();
                    if (trimmed.length > 300 && util.isBASE64(trimmed)) return false;
                    return true;
                })
                .join("\n");
            return t;
        };

        content = (
            messages.reduce((content, message) => {
                const role = message.role
                    .replace("system", "<|im_start|>system")
                    .replace("assistant", "<|im_start|>assistant")
                    .replace("user", "<|im_start|>user");
                if (_.isArray(message.content)) {
                    return message.content.reduce((_content, v) => {
                        if (!_.isObject(v) || v["type"] != "text") return _content;
                        const textPart = cleanTextContent(v["text"] || "");
                        return _content + (`${role}\n` + textPart) + "\n";
                    }, content);
                }
                const textPart = cleanTextContent(message.content || "");
                return (content += `${role}\n${textPart}\n`) + '<|im_end|>\n';
            }, "")
        )
            .replace(/\!\[.+\]\(.+\)/g, "")
            .replace(/\/mnt\/data\/.+/g, "");
        logger.info("\n最终 Prompt 预览:\n" + (content.length > 2000 ? content.slice(0, 2000) + `...[+${content.length - 2000} 字符]` : content));
    }

    const safeRefs = Array.isArray(refs) ? refs.filter(Boolean) : [];
    const fileRefs = safeRefs.filter((ref: any) => !(ref && (ref.width || ref.height)));
    const rawImageRefs = safeRefs.filter((ref: any) => ref && (ref.width || ref.height));
    const imageRefs = rawImageRefs.filter((ref: any) => {
        const key = ref?.file_url?.url || "";
        return typeof key === "string" && /^tos-cn-i-/.test(key);
    });
    if (rawImageRefs.length !== imageRefs.length) {
        logger.warn(`[附件管理] 跳过了 ${rawImageRefs.length - imageRefs.length} 张不支持的图片引用`);
    }
    const attachments = imageRefs.map((ref: any) => ({
        type: "vlm_image",
        identifier: util.uuid(),
        name: ref.name || (ref.file_url?.url?.split("/").pop() || `image.${ref.ext || "png"}`),
        key: ref.file_url?.url,
        file_review_state: 3,
        file_parse_state: 3,
        option: {width: ref.width || 1, height: ref.height || 1},
    }));

    logger.info(`[附件管理] 数量=${attachments.length}`);


    const lastMsg = messages[messages.length - 1] || {};
    let lastText = "";
    if (Array.isArray(lastMsg.content)) {
        lastText = lastMsg.content
            .filter((v: any) => v && v.type === "text")
            .map((v: any) => v.text || "")
            .join("\n");
    } else if (typeof lastMsg.content === "string") {
        lastText = lastMsg.content;
    }

    const cleanBase64 = (text: string): string => {
        if (!text) return "";
        let t = text;

        const dataUriPattern = /data:[^;]+;base64,/g;
        let match;
        while ((match = dataUriPattern.exec(t)) !== null) {
            const start = match.index;
            const prefix = match[0];
            let end = start + prefix.length;
            while (end < t.length && /[A-Za-z0-9+/=]/.test(t[end])) {
                end++;
            }
            t = t.slice(0, start) + t.slice(end);
            dataUriPattern.lastIndex = start; // 重新搜索，避免漏掉连续的 DataURI
        }

        const lines = t.split(/\r?\n/);
        const cleanedLines = lines.filter((line) => {
            const trimmed = line.trim();
            if (trimmed.length > 200) {
                const base64Chars = (trimmed.match(/[A-Za-z0-9+/=]/g) || []).length;
                if (base64Chars > trimmed.length * 0.9) {
                    return false;
                }
            }
            return true;
        });

        return cleanedLines.join("\n").trim();
    };

    const hasImages = attachments.length > 0;

    const cleanedLastText = cleanBase64(lastText);
    let finalContent: string;
    if (hasImages) {
        finalContent = cleanedLastText;
        logger.info(`[内容处理] 检测到图片，清理 Base64 后的文本长度为: len=${finalContent.length}`);
    } else {
        finalContent = cleanBase64(content);
        const contentPreview = finalContent.length > 500 ? finalContent.slice(0, 500) + "..." : finalContent;
        logger.info(`[最终内容] 长度=${finalContent.length}, 预览: ${contentPreview}`);
    }

    logger.info(`处理完成: 文件数=${fileRefs.length}, 图片数=${imageRefs.length}`);

    const result = [
        {
            content: JSON.stringify({text: finalContent}),
            content_type: 2001,
            attachments,
            references: [],
        },
    ];
    logger.info("[messagesPrepare] 构建的消息结构 (已掩码 Base64): " + JSON.stringify(result).substring(0, 500));
    return result;
}

/**
 * 验证文件 URL 是否有效 (HEAD 请求)
 *
 * @param fileUrl 文件 URL
 */
async function checkFileUrl(fileUrl: string) {
    if (util.isBASE64Data(fileUrl)) return;

    const safeUrl = (url: string) => {
        if (util.isBASE64Data(url) || (util.isBASE64(url) && url.length > 300)) {
            return "[base64 data omitted]";
        }
        return url.length > 200 ? url.slice(0, 200) + "..." : url;
    };

    const result = await axios.head(fileUrl, {
        timeout: 15000,
        validateStatus: () => true,
    });
    if (result.status >= 400)
        throw new APIException(
            EX.API_FILE_URL_INVALID,
            `File ${safeUrl(fileUrl)} is not valid: [${result.status}] ${result.statusText}`
        );
    // 获取文件大小并验证是否超过限制
    if (result.headers && result.headers["content-length"]) {
        const fileSize = parseInt(result.headers["content-length"], 10);
        if (fileSize > FILE_MAX_SIZE)
            throw new APIException(
                EX.API_FILE_EXECEEDS_SIZE,
                `File ${safeUrl(fileUrl)} is not valid`
            );
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
    logger.info(`[上传授权] serviceId=${data?.service_id}, upload_host=${data?.upload_host}`);
    if (!data || !data.upload_auth_token)
        throw new APIException(EX.API_REQUEST_FAILED, "[上传预处理失败]: 无法获取上传凭证");
    return {
        serviceId: data.service_id as string,
        uploadHost: data.upload_host as string,
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
    logger.info(`[ImageX 申请上传] host=${uploadHost}, serviceId=${serviceId}`);
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
    logger.info(`[ImageX 申请] 状态=${res.status}, 是否有结果=${hasResult}, 是否有地址=${hasUA}`);
    if (!hasResult || !hasUA) {
        logger.warn(`[ImageX.Apply] response body: ${JSON.stringify(body).slice(0, 1000)}`);
        throw new APIException(EX.API_REQUEST_FAILED, "ImageX 申请上传失败");
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
        throw new APIException(EX.API_REQUEST_FAILED, "ImageX 申请响应缺少必要字段");
    }
    logger.info(`[ImageX 申请] 解析成功: storeUri=${storeInfo.StoreUri}, tosHost=${tosHost}`);
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

        const body = res.data || {};
        const code = body?.code;
        logger.info(`[TOS 上传] 状态: status=${res.status}, code=${code}, 响应: ${JSON.stringify(body).slice(0, 200)}`);

        if (res.status >= 300 || (code !== 2000 && String(code) !== "2000")) {
            logger.warn(`[TOS 上传] 异常: status=${res.status}, code=${code}`);
            throw new APIException(EX.API_REQUEST_FAILED, `TOS 上传失败: 状态=${res.status}, 错误码=${code}`);
        }
    } catch (err: any) {
        const status = err?.response?.status;
        const data = err?.response?.data;
        logger.warn(`[TOS 上传] 错误状态=${status}, 响应内容=${typeof data === 'string' ? data.slice(0, 500) : JSON.stringify(data || {}).slice(0, 500)}`);
        throw err;
    }
}


function sniffImageSize(buf: Buffer, mimeType?: string): { width: number; height: number } | null {
    try {
        if (!buf || buf.length < 16) return null;
        if ((mimeType && /png/i.test(mimeType)) || (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) {
            if (buf.length >= 24) {
                const width = buf.readUInt32BE(16);
                const height = buf.readUInt32BE(20);
                if (width > 0 && height > 0) return {width, height};
            }
        }
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
                        const height = buf.readUInt16BE(i + 5);
                        const width = buf.readUInt16BE(i + 7);
                        if (width > 0 && height > 0) return {width, height};
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
                    const width = wMinus1 + 1;
                    const height = hMinus1 + 1;
                    if (width > 0 && height > 0) return {width, height};
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

    logger.info(`[ImageX 提交] 状态: status=${res.status}, uriStatus=${uriStatus}`);
    logger.info(`[ImageX 提交] 响应内容: ${JSON.stringify(body).slice(0, 500)}`);

    if (res.status >= 300 || (uriStatus !== 2000 && String(uriStatus) !== "2000")) {
        throw new APIException(EX.API_REQUEST_FAILED, `ImageX 提交上传失败: 状态=${res.status}, 响应状态=${uriStatus}`);
    }
    return body;
}


/**
 * 上传文件到豆包服务器 (ImageX 平台)
 *
 * @param fileUrl 文件 URL 或 Base64 数据
 * @param context 账户上下文，包含 deviceId/webId 等鉴权信息
 * @param isVideoImage 是否是视频生成中的图片引用
 */
async function uploadFile(
    fileUrl: string,
    context: AccountContext | string,
    isVideoImage: boolean = false
) {
    // 归一化账户上下文，支持传入 refreshToken 字符串或 AccountContext 对象
    const ctx: AccountContext = typeof context === 'string' ? normalizeAccount(context) : context;
    await checkFileUrl(fileUrl);

    let filename: string, fileData: Buffer, mimeType: string | undefined, extFromMime: string | undefined;
    if (util.isBASE64Data(fileUrl)) {
        mimeType = util.extractBASE64DataFormat(fileUrl);
        extFromMime = mime.getExtension(mimeType || "") || undefined;
        filename = `${util.uuid()}.${extFromMime || "bin"}`;
        fileData = Buffer.from(util.removeBASE64DataHeader(fileUrl), "base64");
    }
    else {
        // 从文件名或 URL 参数中提取扩展名
        const ALLOWED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'svg'];
        
        // 支持的图片扩展名列表
        try {
            const urlObj = new URL(fileUrl);
            filename = path.basename(urlObj.pathname);
            // 处理 URL 后的参数信息 (如 format 格式推断)
            const formatParam = urlObj.searchParams.get('format');
            if (formatParam) {
                const formatExt = formatParam.replace(/^\./, '').toLowerCase();
                if (ALLOWED_IMAGE_EXTENSIONS.includes(formatExt)) {
                    extFromMime = formatExt;
                    logger.info(`[文件上传] 从 URL 参数推断文件格式: ${formatExt}`);
                }
            }
        } catch {
            filename = path.basename(fileUrl.split('?')[0]);
        }

        // 模拟浏览器行为，设置 headers 以绕过部分 CDN 的防盗链或 403 限制
        const resp = await axios.get(fileUrl, {
            responseType: "arraybuffer",
            maxContentLength: FILE_MAX_SIZE,
            timeout: 60000,
            headers: {
                "User-Agent": FAKE_HEADERS["User-Agent"],
                "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
                "Referer": "https://www.doubao.com",
            },
        });
        fileData = resp.data as Buffer;
        
        // 优先从 HTTP 响应头中获取正确的 MIME 类型和扩展名
        const respContentType = resp.headers?.["content-type"];
        if (respContentType && /^image\//.test(respContentType)) {
            mimeType = respContentType.split(';')[0].trim();
            const inferredExt = mime.getExtension(mimeType);
            if (inferredExt && ALLOWED_IMAGE_EXTENSIONS.includes(inferredExt)) {
                extFromMime = extFromMime || inferredExt;
                logger.info(`[文件上传] 从 Content-Type 推断 MIME: mime=${mimeType}, ext=${extFromMime}`);
            }
        }
    }

    mimeType = mimeType || mime.getType(filename) || "application/octet-stream";
    const isImage = /^image\//.test(mimeType);
    const ext = (extFromMime || path.extname(filename).replace(/^\./, "") || (mime.getExtension(mimeType) || "bin")).toLowerCase();

    try {
        const auth = await acquireUploadAuth(ctx, isImage ? 2 : 1);
        logger.info(`成功获取 ${isImage ? "图片" : "文件"} 上传凭证 (STS)`);

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
        logger.info(`文件已上传到 TOS: ${apply.storeUri}`);

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
                logger.info(`[ImageX 提交] 成功: ${apply.storeUri}, 状态=${uriStatus}`);
            } catch (err: any) {
                const msg = err?.message || String(err || "");
                logger.warn(`[ImageX.Commit] 图片上传提交确认失败: ${msg}`);
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
            logger.warn(`上传过程中发生错误，请检查权限或参数: ${safeMsg}`);
        } catch {
            logger.warn("文件上传失败，已忽略该文件");
        }
        // 如果上传失败，图片返回 null (由调用方过滤)，普通文件返回占位地址以免中断对话流程
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
 * 接收非流式响应，并在其中检测并提取图片信息
 *
 * @param stream 响应数据流
 */
async function receiveStream(stream: any, modelId?: string): Promise<any> {
    let temp = Buffer.from('');
    const images: Array<{ key?: string; preview?: string; ori?: string; thumb?: string }> = [];
    const emittedImageKeys = new Set<string>();
    return new Promise((resolve, reject) => {
        const data = {
            id: "",
            model: modelId || MODEL_NAME,
            object: "chat.completion",
            choices: [
                {
                    index: 0,
                    message: {role: "assistant", content: ""},
                    finish_reason: "stop",
                },
            ],
            created: util.unixTimestamp(),
        };
        let isEnd = false;
        const finalize = () => {
            data.choices[0].message.content = data.choices[0].message.content.replace(/\n$/, "");
            const imgs = images.filter(Boolean);
            if (imgs.length) {
                const md = imgs
                    .map((img, i) => {
                        const url = img.preview || img.ori || img.thumb;
                        const ori = img.ori || url;
                        return `![生成图片${i + 1}](${url})\n原图地址: ${ori}`;
                    })
                    .join("\n\n");
                data.choices[0].message.content += (data.choices[0].message.content ? "\n\n" : "") + `[内容处理] 检测到豆包生成了 ${imgs.length} 张图片:\n` + md;
            }

            // 检测并提取工具调用 (tool_call) 结构
            const toolResult = parseToolCalls(data.choices[0].message.content);
            if (toolResult) {
                logger.info(`[工具调用] 检测到 ${toolResult.toolCalls.length} 个工具调用`);
                (data.choices[0].message as any).tool_calls = toolResult.toolCalls;
                data.choices[0].message.content = toolResult.textContent || null as any;
                data.choices[0].finish_reason = "tool_calls";
            }
        };
        const parser = createParser((event) => {
            try {
                if (event.type !== "event" || isEnd) return;

                // --- 适配 doubao-pro 新版 SSE 格式 ---
                if (event.event === "CHUNK_DELTA") {
                    const rawResult = _.attempt(() => JSON.parse(event.data));
                    if (!_.isError(rawResult) && typeof rawResult.text === "string") {
                        data.choices[0].message.content += rawResult.text;
                    }
                    return;
                }
                if (event.event === "STREAM_MSG_NOTIFY" || event.event === "FULL_MSG_NOTIFY") {
                    return;
                }
                if (event.event === "STREAM_CHUNK") {
                    const rawResult = _.attempt(() => JSON.parse(event.data));
                    if (!_.isError(rawResult) && Array.isArray(rawResult.patch_op)) {
                        let text = "";
                        for (const op of rawResult.patch_op) {
                            const val = op.patch_value;
                            if (!val) continue;
                            if (Array.isArray(val.content_block)) {
                                for (const block of val.content_block) {
                                    if (block.content && block.content.text_block && typeof block.content.text_block.text === "string") {
                                        text += block.content.text_block.text;
                                    }
                                }
                            }
                        }
                        if (text) {
                            data.choices[0].message.content += text;
                        }
                    }
                    return;
                }
                // ------------------------------------

                const rawResult = _.attempt(() => JSON.parse(event.data));
                if (_.isError(rawResult))
                    throw new Error(`流响应无效: ${event.data}`);
                
                if (rawResult.code)
                    throw new APIException(EX.API_REQUEST_FAILED, `[豆包请求失败]: ${rawResult.code}-${rawResult.message}`);
                if (rawResult.event_type == 2003) {
                    isEnd = true;
                    if (rawResult.conversation_id && !data.id) {
                        data.id = rawResult.conversation_id;
                    }
                    finalize();
                    return resolve(data);
                }
                if (rawResult.event_type == 2005) {
                    if (rawResult.conversation_id) {
                        data.id = rawResult.conversation_id;
                    }
                    return;
                }
                if (rawResult.event_type != 2001)
                    return;
                const result = _.attempt(() => JSON.parse(rawResult.event_data));
                if (_.isError(result))
                    throw new Error(`流响应无效: ${rawResult.event_data}`);
                if (result.is_finish) {
                    isEnd = true;
                    finalize();
                    return resolve(data);
                }
                if (!data.id && result.conversation_id)
                    data.id = result.conversation_id;
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
                    if (!_.isError(payload) && payload && Array.isArray(payload.creations)) {
                        payload.creations.forEach((c: any) => {
                            const img = c?.image || {};
                            const key = img?.key as string | undefined;
                            const preview = img?.image_preview?.url || img?.image_thumb?.url;
                            const ori = img?.image_ori?.url;
                            if (key && !emittedImageKeys.has(key)) {
                                emittedImageKeys.add(key);
                                images.push({key, preview, ori, thumb: img?.image_thumb?.url});
                            }
                        });
                    }
                }
            } catch (err) {
                logger.error(err);
                reject(err);
            }
        });
        stream.on("data", (buffer) => {
            if (buffer.toString().indexOf("�") != -1) {
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
            if (!data.id && !data.choices[0].message.content && images.length === 0) {
                reject(new APIException(EX.API_REQUEST_FAILED, "豆包返回内容为空，可能需要重试"));
                return;
            }
            resolve(data);
        });
    });
}

/**
 * 创建转换流 (SSE 格式)
 *
 * 豆包的原始 SSE 流格式与 OpenAI 不同，需要将其解析并重新封装为标准的 OpenAI 格式流输出。
 *
 * @param stream 原始响应流
 * @param endCallback 完成后的回调函数
 */
function createTransStream(
    stream: any,
    endCallback?: Function,
    hasTools = false,
    account?: any,
    promptText = "",
    autoDelete = true,
    modelId?: string
) {
    const finalModelName = modelId || MODEL_NAME;
    let convId = "";
    let temp = Buffer.from('');
    const created = util.unixTimestamp();
    let imageNoticeSent = false;
    const emittedImageKeys = new Set<string>();
    const transStream = new PassThrough();
    // 针对 tools 开启缓存：因为工具调用的 JSON 可能会被拆分成多个 SSE chunk 发送，
    // 需要缓存完整的文本内容后再检测是否包含完整的 tool_call 结构。
    let toolBuffer = "";
    let completionText = "";
    const isBuffering = hasTools;

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

    // 将缓存的工具调用结果写入流并计算 Token 使用量
    const flushToolBuffer = () => {
        let finalCompletionText = completionText;
        if (isBuffering && toolBuffer) {
            finalCompletionText = toolBuffer; // 缓存模式下，最终文本为完整缓存内容
            const toolResult = parseToolCalls(toolBuffer);
            if (toolResult) {
                // 成功解析出工具调用，发送对应的 tool_calls chunk
                logger.info(`[工具调用][流] 检测到 ${toolResult.toolCalls.length} 个工具调用`);
                if (toolResult.textContent) {
                    transStream.write(`data: ${JSON.stringify({
                        id: convId,
                        model: MODEL_NAME,
                        object: "chat.completion.chunk",
                        choices: [{
                            index: 0,
                            delta: {role: "assistant", content: toolResult.textContent},
                            finish_reason: null,
                        }],
                        created,
                    })}\n\n`);
                }
                // 遍历并发送每个 tool_call
                for (const tc of toolResult.toolCalls) {
                    transStream.write(`data: ${JSON.stringify({
                        id: convId,
                        model: MODEL_NAME,
                        object: "chat.completion.chunk",
                        choices: [{
                            index: 0,
                            delta: {
                                role: "assistant",
                                tool_calls: [tc],
                            },
                            finish_reason: null,
                        }],
                        created,
                    })}\n\n`);
                }
                
                // 记录并统计 Token 使用量 (usage)
                const promptTokens = TokenCounter.estimateTokens(promptText);
                const completionTokens = TokenCounter.estimateTokens(finalCompletionText);
                if (account && account.id) {
                    AccountManager.updateAccountUsage(account.id, "chat", promptTokens, completionTokens);
                    TokenCounter.recordUsage(account.id, promptTokens, completionTokens);
                }

                // 发送结束 chunk，带上 finish_reason 和 usage
                transStream.write(`data: ${JSON.stringify({
                    id: convId,
                    model: MODEL_NAME,
                    object: "chat.completion.chunk",
                    choices: [{
                        index: 0,
                        delta: {},
                        finish_reason: "tool_calls",
                    }],
                    usage: {
                        prompt_tokens: promptTokens,
                        completion_tokens: completionTokens,
                        total_tokens: promptTokens + completionTokens
                    },
                    created,
                })}\n\n`);
                !transStream.closed && transStream.end("data: [DONE]\n\n");
                endCallback && endCallback(convId);
                return;
            } else {
                // 未解析出工具调用，将缓存内容作为普通文本发送
                transStream.write(`data: ${JSON.stringify({
                    id: convId,
                    model: MODEL_NAME,
                    object: "chat.completion.chunk",
                    choices: [{
                        index: 0,
                        delta: {role: "assistant", content: toolBuffer},
                        finish_reason: null,
                    }],
                    created,
                })}\n\n`);
            }
        }
        
        // 记录 Token 使用量
        const promptTokens = TokenCounter.estimateTokens(promptText);
        const completionTokens = TokenCounter.estimateTokens(finalCompletionText);
        if (account && account.id) {
            AccountManager.updateAccountUsage(account.id, "chat", promptTokens, completionTokens);
            TokenCounter.recordUsage(account.id, promptTokens, completionTokens);
        }

        // 发送最终的结束 chunk 和 usage
        transStream.write(`data: ${JSON.stringify({
            id: convId,
            model: finalModelName,
            object: "chat.completion.chunk",
            choices: [{
                index: 0,
                delta: {role: "assistant", content: ""},
                finish_reason: "stop",
            }],
            usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens
            },
            created,
        })}\n\n`);
        !transStream.closed && transStream.end("data: [DONE]\n\n");
        endCallback && endCallback(convId);
    };
    const parser = createParser((event) => {
        try {
            if (event.type !== "event") return;
            
            logger.info(`[SSE Debug] Type: ${event.type}, Event: ${event.event}, Data length: ${event.data.length}`);

            // --- 适配 doubao-pro 新版 SSE 格式 ---
            if (event.event === "CHUNK_DELTA") {
                const rawResult = _.attempt(() => JSON.parse(event.data));
                if (!_.isError(rawResult) && typeof rawResult.text === "string") {
                    const text = rawResult.text;
                    logger.info(`[SSE Debug] Extracted text: ${text}`);
                    completionText += text;
                    if (isBuffering) {
                        toolBuffer += text;
                    } else {
                        transStream.write(`data: ${JSON.stringify({
                            id: convId,
                            model: finalModelName,
                            object: "chat.completion.chunk",
                            choices: [{ index: 0, delta: {role: "assistant", content: text}, finish_reason: null }],
                            created,
                        })}\n\n`);
                    }
                } else {
                    logger.error(`[SSE Debug] Failed to parse CHUNK_DELTA: ${event.data}`);
                }
                return;
            }
            if (event.event === "STREAM_CHUNK") {
                const rawResult = _.attempt(() => JSON.parse(event.data));
                if (!_.isError(rawResult) && Array.isArray(rawResult.patch_op)) {
                    let text = "";
                    for (const op of rawResult.patch_op) {
                        const val = op.patch_value;
                        if (!val) continue;
                        if (Array.isArray(val.content_block)) {
                            for (const block of val.content_block) {
                                if (block.content && block.content.text_block && typeof block.content.text_block.text === "string") {
                                    text += block.content.text_block.text;
                                }
                            }
                        }
                    }
                    if (text) {
                        completionText += text;
                        if (isBuffering) {
                            toolBuffer += text;
                        } else {
                            transStream.write(`data: ${JSON.stringify({
                                id: convId,
                                model: finalModelName,
                                object: "chat.completion.chunk",
                                choices: [{ index: 0, delta: {role: "assistant", content: text}, finish_reason: null }],
                                created,
                            })}\n\n`);
                        }
                    }
                }
                return;
            }
            if (event.event === "FULL_MSG_NOTIFY" || event.event === "STREAM_MSG_NOTIFY") {
                // 可以从这里面解析出 conversation_id
                const rawResult = _.attempt(() => JSON.parse(event.data));
                if (!_.isError(rawResult)) {
                    const cid = rawResult?.meta?.conversation_id || rawResult?.message?.conversation_id;
                    if (cid && !convId) convId = cid;
                }
                return;
            }
            if (event.event === "STREAM_CHUNK") {
                // 防止重复，直接忽略
                return;
            }
            // ------------------------------------

            const rawResult = _.attempt(() => JSON.parse(event.data));
            if (_.isError(rawResult))
                throw new Error(`流响应无效: ${event.data}`);

            if (rawResult.code)
                throw new APIException(EX.API_REQUEST_FAILED, `[豆包请求失败]: ${rawResult.code}-${rawResult.message}`);
            if (rawResult.event_type == 2003) {
                if (rawResult.conversation_id && !convId) {
                    convId = rawResult.conversation_id;
                }
                flushToolBuffer();
                return;
            }
            if (rawResult.event_type == 2005) {
                if (rawResult.conversation_id && !convId) {
                    convId = rawResult.conversation_id;
                }
                return;
            }
            if (rawResult.event_type != 2001) {
                return;
            }
            const result = _.attempt(() => JSON.parse(rawResult.event_data));
            if (_.isError(result))
                throw new Error(`流响应无效: ${rawResult.event_data}`);
            if (!convId)
                convId = result.conversation_id;
            if (result.is_finish) {
                flushToolBuffer();
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
                    const notice = `\n[正在生成图片，检测到 ${creations.length} 张...]\n`;
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
                    const url = img?.image_preview?.url || img?.image_thumb?.url || img?.image_ori?.url;
                    const ori = img?.image_ori?.url || url;
                    if (key && url && !emittedImageKeys.has(key)) {
                        emittedImageKeys.add(key);
                        const idx = emittedImageKeys.size;
                        const md = `![生成图片${idx}](${url})\n原图地址: ${ori}\n`;
                        transStream.write(`data: ${JSON.stringify({
                            id: convId,
                            model: finalModelName,
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
                completionText += text;
                if (isBuffering) {

                    // 如果开启了 tools 缓存，将文本累加到 toolBuffer 中用于后续解析工具调用 JSON
                    toolBuffer += text;
                } else {
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
            }
        } catch (err) {
            logger.error(err);
            !transStream.closed && transStream.end("\n\n");
        }
    });
    stream.on("data", (buffer) => {
        if (buffer.toString().indexOf("�") != -1) {
            temp = Buffer.concat([temp, buffer]);
            return;
        }
        if (temp.length > 0) {
            buffer = Buffer.concat([temp, buffer]);
            temp = Buffer.from('');
        }
        parser.feed(buffer.toString());
    });
    stream.once(
        "error",
        () => !transStream.closed && transStream.end("data: [DONE]\n\n")
    );
    stream.once(
        "close",
        () => !transStream.closed && transStream.end("data: [DONE]\n\n")
    );
    return transStream;
}

/**
 * Token 分隔处理
 *
 * @param authorization 认证头字符串
 */
function tokenSplit(authorization: string) {
    return authorization.replace("Bearer ", "").split(",");
}

/**
 * 获取 Token 存活状态 (验证 refreshToken 是否有效)
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
    createCompletion,
    createCompletionStream,
    probeCompletion,
    getTokenLiveStatus,
    tokenSplit,
};
