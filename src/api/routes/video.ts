/**
 * @file video.ts
 * @description 视频生成路由，处理视频生成同步及异步的流式与非流式请求。
 */

import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import video from '@/api/controllers/video.ts';
import openaiProxy from '@/api/controllers/openai-proxy.ts';
import AccountManager from '@/lib/account-manager.ts';
import APIException from '@/lib/exceptions/APIException.ts';
import FailureBody from '@/lib/response/FailureBody.ts';


interface VideoCompletionRequestBody {
    prompt: string;
    ratio?: string;
    model?: string;
    image?: string | string[];
    stream: boolean;
    auto_delete?: boolean;
}

export default {
    prefix: '/v1/video',

    post: {
        /**
         * 视频生成接口
         * 路径：/v1/video/generations
         */
        '/generations': async (request: Request) => {
            request
                .validate('body.prompt', _.isString)
                .validate('body.ratio', (v) => _.isUndefined(v) || _.isString(v))
                .validate('body.model', (v) => _.isUndefined(v) || _.isString(v))
                .validate('body.image', (v) => _.isUndefined(v) || _.isString(v) || (_.isArray(v) && v.every(_.isString)))
                .validate('body.stream', _.isBoolean)
                .validate('headers.authorization', _.isString);

            const authHeader = request.headers.authorization || "";
            let account: any;
            let isPooled = false;

            if (authHeader.includes("pooled") || authHeader.length < 20) {
                isPooled = true;
            } else {
                const tokens = video.tokenSplit(authHeader);
                account = _.sample(tokens) || "";
                if (!account) {
                    throw new Error('无效的Authorization Token');
                }
            }

            const {
                prompt,
                ratio,
                model,
                stream,
                image,
                auto_delete
            } = request.body as VideoCompletionRequestBody;
            const autoDelete = _.isBoolean(auto_delete) ? auto_delete : false;

            let assistantId = model && /^[a-z0-9]{24,}$/.test(model) ? model : undefined;
            if (!assistantId && account) {
                const mapped = AccountManager.getMappedModel(account.id, model);
                if (mapped && /^[a-z0-9]{24,}$/.test(mapped)) {
                    assistantId = mapped;
                }
            }

            const videoParams = {
                prompt,
                ratio: ratio || "16:9",
                model,
                image
            };

            let matchedAccount: any = null;
            if (!isPooled && typeof account === 'string') {
                matchedAccount = AccountManager.getAccountByToken(account);
                if (matchedAccount) {
                    account = matchedAccount;
                }
            }

            let maxRetries = 3;
            let attempt = 0;
            let lastError: any;

            while (attempt < maxRetries) {
                attempt++;
                try {
                    if (isPooled) {
                        account = await AccountManager.acquireToken('video', model);
                    } else if (matchedAccount) {
                        AccountManager.lockAccount(matchedAccount, 'video');
                    }
                    if (account && account.type === 'openai') {
                        const result = await openaiProxy.proxyVideo(request.body, account);
                        if (isPooled) AccountManager.releaseToken(account.token);
                        else if (matchedAccount) AccountManager.releaseToken(matchedAccount.token);
                        return result;
                    }

                    if (stream) {

                        const s = await video.createVideoCompletionStream(videoParams, account, assistantId, 0, autoDelete);
                        const token = isPooled ? account.token : matchedAccount?.token;
                        if (token) {
                            let released = false;
                            const release = () => {
                                if (released) return;
                                released = true;
                                AccountManager.releaseToken(token);
                            };
                            s.on('end', release);
                            s.on('error', release);
                            s.on('close', release);
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
                        const result = await video.createVideoCompletion(videoParams, account, assistantId, 0, autoDelete);
                        if (isPooled) AccountManager.releaseToken(account.token);
                        else if (matchedAccount) AccountManager.releaseToken(matchedAccount.token);
                        return result;
                    }
                } catch (err: any) {
                    lastError = err;
                    
                    // 如果是安全审核、肖像保护或版权受限等永久性风控错误，直接释放账号并抛出，决不重试
                    if (err.message && (err.message.includes("内容安全") || err.message.includes("肖像保护") || err.message.includes("版权限制") || err.message.includes("版权"))) {
                        if (isPooled && account) {
                            AccountManager.releaseToken(account.token);
                        } else if (matchedAccount) {
                            AccountManager.releaseToken(matchedAccount.token);
                        }
                        throw err;
                    }

                    let policyAction = 'error';
                    const statusCode = err.errcode || err.status || err.statusCode || err.response?.status;
                    
                    if (isPooled && account) {
                        if (statusCode) {
                            policyAction = AccountManager.applyResponsePolicy(account.id, statusCode);
                        }
                        AccountManager.releaseToken(account.token);
                    } else if (matchedAccount) {
                        AccountManager.releaseToken(matchedAccount.token);
                    }

                    if (err.message && err.message.includes('RETRY_GENERATION_EMPTY')) {
                        policyAction = 'retry';
                    }

                    if (err.message && (err.message.includes('RETRY_GENERATION_LIMIT') || err.message.includes('生成次数已经达到上限'))) {
                        policyAction = 'retry';
                        const targetAccount = isPooled ? account : matchedAccount;
                        if (targetAccount) {
                            targetAccount.usageVideo = targetAccount.limitVideo > 0 ? targetAccount.limitVideo : 99999;
                            await AccountManager.saveAccounts();
                            const l = require('@/lib/logger.ts').default;
                            l.warn(`[API] 账号 [${targetAccount.name}] 达到视频生成次数上限，已更新用量并保存`);
                        }
                    }

                    if (policyAction === 'retry' && attempt < maxRetries) {
                        const l = require('@/lib/logger.ts').default;
                        l.warn(`[API] 策略触发重试视频 (第 ${attempt}/${maxRetries} 次): ${statusCode || err.message}`);
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
