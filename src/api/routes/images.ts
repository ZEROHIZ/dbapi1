import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import SuccessfulBody from '@/lib/response/SuccessfulBody.ts';
import images from '@/api/controllers/images.ts';
import openaiProxy from '@/api/controllers/openai-proxy.ts';
import AccountManager from '@/lib/account-manager.ts';
import APIException from '@/lib/exceptions/APIException.ts';
import FailureBody from '@/lib/response/FailureBody.ts';
import mediaTaskManager from '@/lib/media-task-manager.ts';


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
                    return new Response({ code: 400, message: "task_id or prompt is required", data: null }, { statusCode: 400 });
                }
                const task = await mediaTaskManager.getPublicTask(taskId.trim());
                if (!task) {
                    return new Response({ code: 404, message: "Task not found", data: null }, { statusCode: 404 });
                }
                return new SuccessfulBody(task);
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
