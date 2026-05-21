import _ from 'lodash';
import axios from 'axios';
import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import SuccessfulBody from '@/lib/response/SuccessfulBody.ts';
import images from '@/api/controllers/images.ts';
import openaiProxy from '@/api/controllers/openai-proxy.ts';
import AccountManager from '@/lib/account-manager.ts';
import APIException from '@/lib/exceptions/APIException.ts';
import FailureBody from '@/lib/response/FailureBody.ts';
import mediaTaskManager from '@/lib/media-task-manager.ts';

// 将 size 解析并映射为标准比例
function parseSizeToRatio(size?: string): string | undefined {
    if (!size) return undefined;
    if (/^\d+:\d+$/.test(size)) {
        return size;
    }
    const match = size.match(/^(\d+)[xX](\d+)$/);
    if (match) {
        const width = parseInt(match[1], 10);
        const height = parseInt(match[2], 10);
        if (width > 0 && height > 0) {
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
    }
    return undefined;
}

// 下载图片并转换为 Base64 编码
async function getUrlAsBase64(url: string): Promise<string> {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return Buffer.from(response.data).toString('base64');
}

// 定义图片生成请求体的类型（可选，增强类型提示）
interface ImageCompletionRequestBody {
    model: string;
    prompt: string;
    ratio?: string;
    style?: string;
    stream?: boolean;
    n?: number;
    size?: string;
    response_format?: string;
    auto_delete?: boolean;
}

export default {
    // 接口前缀
    prefix: '/v1/images',

    // POST请求路由
    post: {
        /**
         * 文生图生成接口
         * 路径：/v1/images/generations
         * 请求体：{model, prompt, ratio, style, stream}
         */
        '/generations': async (request: Request) => {
            if (request.body?.model === "async-task-query") {
                request.validate('headers.authorization', _.isString);
                const taskId = request.body.task_id || request.body.prompt;
                if (!_.isString(taskId) || !taskId.trim()) {
                    return new Response({ 
                        code: 400, 
                        message: "task_id or prompt is required for model 'async-task-query'. Please ensure the initial request was successful and returned a valid task_id.", 
                        data: null 
                    }, { statusCode: 400 });
                }
                const task = await mediaTaskManager.getPublicTask(taskId.trim());
                if (!task) {
                    return new Response({ code: 404, message: "Task not found", data: null }, { statusCode: 404 });
                }
                return new SuccessfulBody(task);
            }

            // 处理 opendoubao 兼容模式
            const originalModel = request.body?.model;
            const isOpenDoubao = originalModel === 'opendoubao';
            let opendoubaoFormat = 'url';
            if (isOpenDoubao) {
                // 读取全局设置中配置的内部生图模型，未配置则默认 doubao-image
                const targetModel = AccountManager.getSettings().opendoubaoModel || 'doubao-image';
                request.body.model = targetModel;
                request.body.stream = false; // 强制非流式响应
                
                if (request.body.size) {
                    const mappedRatio = parseSizeToRatio(request.body.size);
                    if (mappedRatio) {
                        request.body.ratio = mappedRatio;
                    }
                    delete request.body.size; // 清理原有的 size 键，防止干扰后续的 size || ratio 解构
                }
                
                if (request.body.response_format) {
                    opendoubaoFormat = request.body.response_format;
                }
            }

            // 1. 扩展参数校验：image为可选字符串（URL/Base64）
            request
                .validate('body.model', _.isString)
                .validate('body.prompt', _.isString)
                .validate('body.ratio', (v) => _.isUndefined(v) || _.isString(v))
                .validate('body.style', (v) => _.isUndefined(v) || _.isString(v))
                .validate('body.stream', _.isBoolean)
                .validate('headers.authorization', _.isString)
                .validate('body.image', (v) => _.isUndefined(v) || _.isString(v) || (_.isArray(v) && v.every(_.isString))); // 参考图为可选字符串或字符串数组

            // 2. 处理Token
            const authHeader = request.headers.authorization || "";
            let account: any;
            let isPooled = false;

            if (authHeader.includes("pooled") || authHeader.length < 20) {
                isPooled = true;
            } else {
                const tokens = images.tokenSplit(authHeader);
                account = _.sample(tokens) || "";
                if (!account) {
                    throw new Error('无效的Authorization Token');
                }
            }

            // 3. 解构参数：新增image字段
            const {
                model,
                prompt,
                ratio, // Keep ratio for backward compatibility if not using size
                style,
                stream,
                image: referenceImage,
                n, // Added
                size, // Added
                response_format, // Added
                auto_delete // Added
            } = request.body as ImageCompletionRequestBody & { image?: string | string[] };

            const autoDelete = _.isBoolean(auto_delete) ? auto_delete : true; // Determine autoDelete value
            let assistantId = model && /^[a-z0-9]{24,}$/.test(model) ? model : undefined;
            if (!assistantId && account) {
                const mapped = AccountManager.getMappedModel(account.id, model);
                if (mapped && /^[a-z0-9]{24,}$/.test(mapped)) {
                    assistantId = mapped;
                }
            }

            // 5. 组装参数：传递参考图 (This block is now partially redundant due to direct passing in createImageCompletion calls)
            const imageParams = {
                model,
                prompt,
                ratio: size || ratio || "1:1", // Prioritize size, then ratio, then default
                style: style || "auto", // Prioritize style, then default
                referenceImage,
                n,
                response_format
            };

            const maxRetries = 3;
            let attempt = 0;
            let lastError: any;

            while (attempt < maxRetries) {
                attempt++;
                try {
                    if (isPooled) {
                        account = await AccountManager.acquireToken('image', model);
                    }
                    if (isPooled && account.type === 'openai') {
                        const result = await openaiProxy.proxyImage(request.body, account);
                        if (isPooled) AccountManager.releaseToken(account.token);
                        return result;
                    }

                    if (stream) {
                        const s = await images.createImageCompletionStream({
                            model,
                            prompt,
                            ratio: size || ratio, // 不设默认值，由 controller 根据参考图尺寸决定
                            style: style || "auto",
                            referenceImage
                        }, account, assistantId, 0, autoDelete);
                        if (isPooled) {
                            const token = account.token;
                            s.on('end', () => AccountManager.releaseToken(token));
                            s.on('error', () => AccountManager.releaseToken(token));
                        }
                        return new Response(s, {
                            type: "text/event-stream",
                            headers: {
                                "Cache-Control": "no-cache, no-transform",
                                "Connection": "keep-alive",
                                "X-Accel-Buffering": "no"
                            }
                        });
                    } else {
                        const result = await images.createImageCompletion({
                            model,
                            prompt,
                            ratio: size || ratio, // 不设默认值，由 controller 根据参考图尺寸决定
                            style: style || "auto",
                            referenceImage
                        }, account, assistantId, 0, autoDelete);
                        if (isPooled) AccountManager.releaseToken(account.token);

                        if (isOpenDoubao) {
                            // 格式化输出为 OpenAI 标准格式
                            const imageUrls = result.choices?.[0]?.message?.images || [];
                            const data = [];
                            if (opendoubaoFormat === 'b64_json') {
                                for (const url of imageUrls) {
                                    try {
                                        const b64 = await getUrlAsBase64(url);
                                        data.push({ b64_json: b64 });
                                    } catch (err: any) {
                                        const l = require('@/lib/logger.ts').default;
                                        l.error(`[API] 转换图片为 Base64 失败: ${err.message}`);
                                        data.push({ url }); // 转换失败则回退为 url
                                    }
                                }
                            } else {
                                for (const url of imageUrls) {
                                    data.push({ url });
                                }
                            }
                            return {
                                created: result.created || Math.floor(Date.now() / 1000),
                                data: data
                            };
                        }

                        return result;
                    }
                } catch (err: any) {
                    lastError = err;
                    let policyAction = 'error';
                    const statusCode = err.errcode || err.status || err.statusCode || err.response?.status;
                    
                    if (isPooled && account) {
                        if (statusCode) {
                            policyAction = AccountManager.applyResponsePolicy(account.id, statusCode);
                        }
                        AccountManager.releaseToken(account.token);
                    }

                    if (err.message && err.message.includes('RETRY_GENERATION_EMPTY')) {
                        policyAction = 'retry';
                    }

                    if (policyAction === 'retry' && attempt < maxRetries) {
                        const l = require('@/lib/logger.ts').default;
                        l.warn(`[API] 策略触发重图试 (第 ${attempt}/${maxRetries} 次): ${statusCode || err.message}`);
                        continue;
                    }
                    throw err;
                }
            }
            if (lastError instanceof APIException) {
                return new Response(new FailureBody(lastError), { statusCode: lastError.httpStatusCode });
            }
            throw lastError;
        }
    }
};
