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

// ===== Tool Calling 模拟支持 =====

const TOOL_CALL_START = "<<<tool_call>>>";
const TOOL_CALL_END = "<<<end_tool_call>>>";

/**
 * 将 OpenAI 格式的 tools 数组转换为 system prompt 文本
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
                        const required = fn.parameters.required?.includes(k) ? "(必填)" : "(可选)";
                        return `    - ${k} (${v.type || "any"}) ${required}: ${v.description || ""}`;
                    })
                    .join("\n");
                desc += "\n  参数:\n" + params;
            }
            return desc;
        })
        .join("\n\n");

    return `你是一个具备动作执行能力的自主智能体（Agent）。你可以通过调用工具来直接操作和解决问题，而不仅仅是提供建议或解释。

你有以下工具可以使用。请仔细阅读工具说明，当你认为调用工具能更有效地解决用户需求时，**必须优先使用工具**。调用工具时，请严格按以下格式输出（可以一次调用多个工具）：

${TOOL_CALL_START}
{"name": "工具名称", "arguments": {"参数名": "参数值"}}
${TOOL_CALL_END}

可用工具列表：
${toolDescriptions}

重要规则（必须严格遵守）：
1. **行动优先**：如果用户请求的任务（如读写文件、运行命令、查询实时信息）可以通过上述工具完成，请**直接输出工具调用标记**。严禁仅在回复中写出步骤而不进行实际调用。
2. **严禁废话**：如果可以调用工具，请简短说明理由后立即调用。不要输出长篇累牍的操作指南或免责声明。
3. **格式严谨**：arguments 必须是有效的 JSON 对象。
4. **决策权**：只有在没有任何工具能胜任，或者用户明确要求仅进行纯文字交流时，才进行普通回复。`;
}

/**
 * 从模型输出文本中检测并提取 tool_call
 * 返回 null 表示没有检测到工具调用
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
            logger.warn(`[ToolCall] 解析工具调用 JSON 失败: ${match[1]}`);
        }
        // 从文本中移除工具调用标记
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
    return `mf-${util.generateRandomString({length: 34,})}-${util.generateRandomString({length: 6,})}`;
}

/**
 * 清洗 Base64 字符串
 */
function cleanBase64(text: string): string {
    if (!text) return "";
    let t = text;
    while (true) {
        const start = t.indexOf("data:image/");
        if (start === -1) break;
        const end = t.indexOf(",", start);
        if (end === -1) break;
        // 寻找下一个双引号或结束标记
        let nextQuote = t.indexOf('"', end);
        if (nextQuote === -1) nextQuote = t.length;
        t = t.slice(0, start) + "[BASE64_IMAGE]" + t.slice(nextQuote);
    }
    return t;
}

/**
 * 生成cookie
 */
 

/**
 * 请求doubao
 *
 * @param method 请求方法
 * @param uri 请求路径
 * @param context 账号上下文信息
 * @param options 请求配置
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
            Authorization: `Bearer ${token}`,
            "X-Flow-Trace": `04-${util.uuid()}-${util.uuid().substring(0, 16)}-01`,
            ...(options.headers || {}),
        },
        timeout: 15000,
        validateStatus: () => true,
        ..._.omit(options, "params", "headers"),
    };

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

/**
 * 同步对话补全
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param account 账号信息对象或refreshToken字符串
 * @param assistantId 智能体ID，默认使用Doubao原版
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

        const response = await request("post", "/samantha/chat/completion", context, {
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

        // 记录用量统计 (排除 Base64 字符串以减少 Token 计算开销和误报)
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
                (err) => !refConvId && console.error('移除会话失败：', err)
            );
        }

        return answer;
    })().catch((err) => {
        logger.error(`Response error: ${err.message || String(err)}`);
        throw err;
    });
}

/**
 * 流式对话补全
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param account 账号信息对象或refreshToken字符串
 * @param assistantId 智能体ID，默认使用Doubao原版
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
        logger.info(`收到 ${messages.length} 条消息（流式）`);
        const context = normalizeAccount(account);

        const refFileUrls = extractRefFileUrls(messages);
        const refs = refFileUrls.length
            ? await Promise.all(
                refFileUrls.map((fileUrl) => uploadFile(fileUrl, context))
            )
            : [];

        if (!/[0-9a-zA-Z]{24}/.test(refConvId)) refConvId = "";

        const response = await request("post", "/samantha/chat/completion", context, {
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
        logger.error(`Stream response error: ${err.message || String(err)}`);
        throw err;
    });
}

/**
 * 提取消息中引用的文件URL
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
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

    logger.info("本次请求上传：" + urls.length + "个文件");
    return urls;
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

function truncateForLog(s: string, max = 200): string {
    if (!s) return "";
    if (s.length <= max) return s;
    return s.slice(0, max) + `…[+${s.length - max}]`;
}

/**
 * 消息预处理
 *
 * 由于接口只取第一条消息，此处会将多条消息合并为一条，实现多轮对话效果
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refs 参考文件列表
 * @param isRefConv 是否为引用会话
 * @param tools OpenAI格式的工具定义（可选）
 */
function messagesPrepare(messages: any[], refs: any[], isRefConv = false, tools?: any[]) {
    // 注入 tools system prompt
    if (tools && tools.length > 0) {
        const toolPrompt = buildToolSystemPrompt(tools);
        if (toolPrompt) {
            messages = [{ role: "system", content: toolPrompt }, ...messages];
            logger.info("[ToolCall] 已注入工具定义 system prompt");
        }
    }

    // 将 tool role 消息转换为 user 消息
    messages = messages.map((msg: any) => {
        if (msg.role === "tool") {
            return {
                role: "user",
                content: `[工具调用结果] 函数 "${msg.name || "unknown"}" 返回:\n${msg.content}`,
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
        logger.info("\n透传内容：\n" + maskBase64InString(content));
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
                content: "关注用户最新发送文件和消息",
                role: "system",
            };
            messages.splice(messages.length - 1, 0, newFileMessage);
            logger.info("注入提升尾部文件注意力system prompt");
        } else {
            // 由于注入会导致设定污染，暂时注释
            // let newTextMessage = {
            //   content: "关注用户最新的消息",
            //   role: "system",
            // };
            // messages.splice(messages.length - 1, 0, newTextMessage);
            // logger.info("注入提升尾部消息注意力system prompt");
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
        logger.info("\n对话合并：\n" + (content.length > 2000 ? content.slice(0, 2000) + `...[+${content.length - 2000} chars]` : content));
    }

    const safeRefs = Array.isArray(refs) ? refs.filter(Boolean) : [];
    const fileRefs = safeRefs.filter((ref: any) => !(ref && (ref.width || ref.height)));
    const rawImageRefs = safeRefs.filter((ref: any) => ref && (ref.width || ref.height));
    const imageRefs = rawImageRefs.filter((ref: any) => {
        const key = ref?.file_url?.url || "";
        return typeof key === "string" && /^tos-cn-i-/.test(key);
    });
    if (rawImageRefs.length !== imageRefs.length) {
        logger.warn(`[attachments] 有 ${rawImageRefs.length - imageRefs.length} 个图片未能上传成功，已忽略`);
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

    logger.info(`[attachments] count=${attachments.length}`);


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
            dataUriPattern.lastIndex = start; // 重置正则位置
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
        logger.info(`[content] 有图片，使用最后一条消息文本，len=${finalContent.length}`);
    } else {
        finalContent = cleanBase64(content);
        const contentPreview = finalContent.length > 500 ? finalContent.slice(0, 500) + "..." : finalContent;
        logger.info(`[finalContent] len=${finalContent.length}, preview: ${contentPreview}`);
    }

    logger.info(`引用资源：files=${fileRefs.length}, images=${imageRefs.length}`);

    const result = [
        {
            content: JSON.stringify({text: finalContent}),
            content_type: 2001,
            attachments,
            references: [],
        },
    ];
    logger.info("[messagesPrepare] 最终发送内容 (已脱敏): " + JSON.stringify(result).substring(0, 500));
    return result;
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

    const result = await axios.head(fileUrl, {
        timeout: 15000,
        validateStatus: () => true,
    });
    if (result.status >= 400)
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
    logger.info(`[UploadAuth] serviceId=${data?.service_id}, upload_host=${data?.upload_host}`);
    if (!data || !data.upload_auth_token)
        throw new APIException(EX.API_REQUEST_FAILED, "prepare_upload missing credentials");
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
 * @param context 账号上下文（需要一致的 deviceId/webId 才能通过上传鉴权）
 * @param isVideoImage 是否是用于视频图像
 */
async function uploadFile(
    fileUrl: string,
    context: AccountContext | string,
    isVideoImage: boolean = false
) {
    // 兼容旧调用方式：如果传入的是字符串，则转换为 AccountContext
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
                "Referer": "https://www.doubao.com",
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
        const auth = await acquireUploadAuth(ctx, isImage ? 2 : 1);
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
        // 为图片返回 null，后续会被过滤，不构造 attachments；非图片则允许占位
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
                        return `![生成图片${i + 1}](${url})\n原图: ${ori}`;
                    })
                    .join("\n\n");
                data.choices[0].message.content += (data.choices[0].message.content ? "\n\n" : "") + `【图片生成完成：共${imgs.length}张】\n` + md;
            }

            // 检测并处理 tool_call
            const toolResult = parseToolCalls(data.choices[0].message.content);
            if (toolResult) {
                logger.info(`[ToolCall] 检测到 ${toolResult.toolCalls.length} 个工具调用`);
                (data.choices[0].message as any).tool_calls = toolResult.toolCalls;
                data.choices[0].message.content = toolResult.textContent || null as any;
                data.choices[0].finish_reason = "tool_calls";
            }
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
                    throw new Error(`Stream response invalid: ${rawResult.event_data}`);
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
            if (buffer.toString().indexOf('�') != -1) {
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
                reject(new APIException(EX.API_REQUEST_FAILED, "RETRY_GENERATION_EMPTY: 会话 ID 为空且内容为空，说明生成识别需重试"));
                return;
            }
            resolve(data);
        });
    });
}

/**
 * 创建转换流
 *
 * 将流格式转换为gpt兼容流格式
 *
 * @param stream 消息流
 * @param endCallback 传输结束回调
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
    // 当有 tools 时，缓冲所有文本以在结束时检测 tool_call
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

    // 流结束时的统一处理函数
    const flushToolBuffer = () => {
        let finalCompletionText = completionText;
        if (isBuffering && toolBuffer) {
            finalCompletionText = toolBuffer; // 如果缓冲了，则用缓冲的内容
            const toolResult = parseToolCalls(toolBuffer);
            if (toolResult) {
                // 检测到工具调用，发送 tool_calls 格式的 chunk
                logger.info(`[ToolCall][Stream] 检测到 ${toolResult.toolCalls.length} 个工具调用`);
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
                // 发送每个 tool_call
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
                
                // 记录用量并发送 usage
                const promptTokens = TokenCounter.estimateTokens(promptText);
                const completionTokens = TokenCounter.estimateTokens(finalCompletionText);
                if (account && account.id) {
                    AccountManager.updateAccountUsage(account.id, "chat", promptTokens, completionTokens);
                    TokenCounter.recordUsage(account.id, promptTokens, completionTokens);
                }

                // 发送结束 chunk，finish_reason 为 tool_calls，包含 usage
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
                // 没有检测到工具调用，将缓冲的文本作为普通内容发送
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
        
        // 记录用量
        const promptTokens = TokenCounter.estimateTokens(promptText);
        const completionTokens = TokenCounter.estimateTokens(finalCompletionText);
        if (account && account.id) {
            AccountManager.updateAccountUsage(account.id, "chat", promptTokens, completionTokens);
            TokenCounter.recordUsage(account.id, promptTokens, completionTokens);
        }

        // 常规结束，带上 usage
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
            const rawResult = _.attempt(() => JSON.parse(event.data));
            if (_.isError(rawResult))
                throw new Error(`Stream response invalid: ${event.data}`);

            if (rawResult.code)
                throw new APIException(EX.API_REQUEST_FAILED, `[请求doubao失败]: ${rawResult.code}-${rawResult.message}`);
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
                throw new Error(`Stream response invalid: ${rawResult.event_data}`);
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
                    const url = img?.image_preview?.url || img?.image_thumb?.url || img?.image_ori?.url;
                    const ori = img?.image_ori?.url || url;
                    if (key && url && !emittedImageKeys.has(key)) {
                        emittedImageKeys.add(key);
                        const idx = emittedImageKeys.size;
                        const md = `![生成图片${idx}](${url})\n原图: ${ori}\n`;
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

                    // 有 tools 时缓冲文本，等待流结束后统一处理
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
        if (buffer.toString().indexOf('�') != -1) {
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
 * Token切分
 *
 * @param authorization 认证字符串
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
    createCompletion,
    createCompletionStream,
    getTokenLiveStatus,
    tokenSplit,
};
