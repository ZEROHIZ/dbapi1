/**
 * @file video.ts
 * @description 视频生成路由，处理视频生成的流式与非流式请求、模型映射解析、即梦视频生成、OpenAI 代理中转、风控安全拦截及全流程请求日志落盘。
 */

import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import video from '@/api/controllers/video.ts';
import openaiProxy from '@/api/controllers/openai-proxy.ts';
import AccountManager from '@/lib/account-manager.ts';
import APIException from '@/lib/exceptions/APIException.ts';
import FailureBody from '@/lib/response/FailureBody.ts';
import EX from '@/lib/consts/exceptions.ts';
import jimengVideos from '@/jimeng/controllers/videos.ts';
import JimengModelManager from '@/lib/jimeng-model-manager.ts';
import util from '@/lib/util.ts';
import requestLogger from '@/lib/request-logger.ts';


interface VideoCompletionRequestBody {
    prompt: string;
    ratio?: string;
    model: string;
    image?: string | string[];
    stream: boolean;
    auto_delete?: boolean;
    duration: number;
}

export default {
    prefix: '/v1/video',

    post: {
        /**
         * 视频生成接口
         * 路径：/v1/video/generations
         */
        '/generations': async (request: Request) => {
            const requestStartTime = Date.now();
            request
                .validate('body.prompt', _.isString)
                .validate('body.ratio', (v) => _.isUndefined(v) || _.isString(v))
                .validate('body.model', _.isString)
                .validate('body.duration', _.isNumber)
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
                auto_delete,
                duration
            } = request.body as VideoCompletionRequestBody;
            const autoDelete = _.isBoolean(auto_delete) ? auto_delete : false;

            const routeModel = (model === "sdmini" || model === "sdfast") ? "doubao-video" : model;

            let assistantId = routeModel && /^[a-z0-9]{24,}$/.test(routeModel) ? routeModel : undefined;
            if (!assistantId && account) {
                const mapped = AccountManager.getMappedModel(account.id, routeModel);
                if (mapped && /^[a-z0-9]{24,}$/.test(mapped)) {
                    assistantId = mapped;
                }
            }

            const videoParams = {
                prompt,
                ratio: ratio || "16:9",
                model,
                image,
                duration
            };

            let matchedAccount: any = null;
            if (!isPooled && typeof account === 'string') {
                matchedAccount = AccountManager.getAccountByToken(account);
                if (matchedAccount) {
                    account = matchedAccount;
                }
            }

            const globalMappedModel = AccountManager.getMappedModel(matchedAccount?.id || "", model || "");
            const isJimeng = JimengModelManager.getEnabledModels().some(m => m.id === model || m.id === globalMappedModel) || 
                             (model && model.startsWith('jimeng-')) || 
                             (model && model.startsWith('jimeng-video-')) ||
                             (globalMappedModel && globalMappedModel.startsWith('jimeng-')) ||
                             (globalMappedModel && globalMappedModel.startsWith('jimeng-video-'));

            if (isJimeng) {
                let targetAccount = account;
                if (isPooled) {
                    targetAccount = await AccountManager.acquireToken('jimeng' as any, model);
                } else if (matchedAccount) {
                    AccountManager.lockAccount(matchedAccount, 'jimeng' as any);
                }
                
                try {
                    const resolvedJimengModel = AccountManager.getMappedModel(targetAccount?.id || "", model || "");
                    const filePaths = Array.isArray(image) ? image : (image ? [image] : []);
                    const generatedVideoUrl = await jimengVideos.generateVideo(
                        resolvedJimengModel || model || "",
                        prompt,
                        {
                            ratio: ratio || "1:1",
                            resolution: "720p",
                            duration: 5,
                            filePaths,
                            files: request.files,
                            httpRequest: request,
                            functionMode: request.body.functionMode || "first_last_frames"
                        },
                        targetAccount.token
                    );
                    
                    await AccountManager.updateAccountUsage(targetAccount.id, 'video');
                    
                    if (isPooled) AccountManager.releaseToken(targetAccount.token);
                    else if (matchedAccount) AccountManager.releaseToken(matchedAccount.token);
                    
                    const durationSec = Number(((Date.now() - requestStartTime) / 1000).toFixed(2));
                    const tokenSummary = targetAccount ? AccountManager.getAccountDisplayName(targetAccount.id) : '即梦视频渠道';
                    requestLogger.addLog({
                        action: 'generate_video',
                        model: model || 'jimeng',
                        tokenSummary,
                        accountId: targetAccount?.id,
                        status: 'completed',
                        progress: '100%',
                        statusCode: 200,
                        summary: '即梦视频生成完成',
                        duration: durationSec,
                        requestData: { model, prompt, ratio: request.body.ratio, duration: request.body.duration },
                        responseData: { url: generatedVideoUrl }
                    }).catch(() => {});

                    const response_format = request.body.response_format || "url";
                    if (response_format === "b64_json") {
                        const videoBase64 = await util.fetchFileBASE64(generatedVideoUrl);
                        return {
                            created: util.unixTimestamp(),
                            data: [{
                                b64_json: videoBase64,
                                revised_prompt: prompt
                            }]
                        };
                    } else {
                        return {
                            created: util.unixTimestamp(),
                            data: [{
                                url: generatedVideoUrl,
                                revised_prompt: prompt
                            }]
                        };
                    }
                } catch (err: any) {
                    if (isPooled && targetAccount) AccountManager.releaseToken(targetAccount.token);
                    else if (matchedAccount) AccountManager.releaseToken(matchedAccount.token);

                    const durationSec = Number(((Date.now() - requestStartTime) / 1000).toFixed(2));
                    const tokenSummary = targetAccount ? AccountManager.getAccountDisplayName(targetAccount.id) : '即梦视频渠道';
                    const statusCode = err?.httpStatusCode || err?.statusCode || err?.status || 500;
                    const errorMsg = err?.message || '即梦视频生成失败';

                    requestLogger.addLog({
                        action: 'generate_video',
                        model: model || 'jimeng',
                        tokenSummary,
                        accountId: targetAccount?.id,
                        status: 'failed',
                        progress: '100%',
                        statusCode: typeof statusCode === 'number' && statusCode >= 100 && statusCode < 600 ? statusCode : 500,
                        summary: errorMsg,
                        duration: durationSec,
                        requestData: { model, prompt, ratio: request.body.ratio, duration: request.body.duration },
                        responseData: { error: errorMsg, stack: err?.stack }
                    }).catch(() => {});

                    if (err instanceof APIException) {
                        return new Response(new FailureBody(err), { statusCode: err.httpStatusCode });
                    }
                    throw err;
                }
            }

            let maxRetries = 3;
            let attempt = 0;
            let lastError: any;
            let streamLogged = false;

            while (attempt < maxRetries) {
                attempt++;
                try {
                    if (isPooled) {
                        account = await AccountManager.acquireToken('video', routeModel);
                    } else if (matchedAccount) {
                        AccountManager.lockAccount(matchedAccount, 'video');
                    }
                    if (account && account.type === 'openai') {
                        const result = await openaiProxy.proxyVideo(request.body, account);
                        if (isPooled) AccountManager.releaseToken(account.token);
                        else if (matchedAccount) AccountManager.releaseToken(matchedAccount.token);

                        const durationSec = Number(((Date.now() - requestStartTime) / 1000).toFixed(2));
                        const targetAcc = account || matchedAccount;
                        const accountId = targetAcc?.id;
                        const tokenSummary = targetAcc ? AccountManager.getAccountDisplayName(targetAcc.id) : 'OpenAI 渠道';

                        requestLogger.addLog({
                            action: 'generate_video',
                            model: model || 'openai',
                            tokenSummary,
                            accountId,
                            status: 'completed',
                            progress: '100%',
                            statusCode: 200,
                            summary: '视频生成完成 (OpenAI)',
                            duration: durationSec,
                            requestData: videoParams,
                            responseData: result
                        }).catch(() => {});

                        return result;
                    }

                    const resolvedVideoParams = {
                        ...videoParams,
                        model: AccountManager.getMappedModel(account?.id || "", model || "")
                    };

                    if (stream) {
                        const startTime = Date.now();
                        const s = await video.createVideoCompletionStream(resolvedVideoParams, account, assistantId, 0, autoDelete);
                        const token = isPooled ? account.token : matchedAccount?.token;
                        let released = false;
                        let logged = false;

                        const handleFinish = (status: "completed" | "failed") => {
                            if (!logged) {
                                logged = true;
                                streamLogged = true;
                                const durationSec = Number(((Date.now() - startTime) / 1000).toFixed(2));
                                const targetAcc = account || matchedAccount;
                                const accountId = targetAcc?.id;
                                const tokenSummary = targetAcc ? AccountManager.getAccountDisplayName(targetAcc.id) : '匿名 Token';

                                requestLogger.addLog({
                                    action: 'generate_video',
                                    model: model || 'doubao-video',
                                    tokenSummary,
                                    accountId,
                                    status,
                                    progress: '100%',
                                    statusCode: status === 'completed' ? 200 : 500,
                                    summary: status === 'completed' ? '视频流式生成完成' : '视频流式生成失败',
                                    duration: durationSec,
                                    requestData: videoParams,
                                    responseData: status === 'completed' ? '[流式视频响应]' : '[流式视频生成异常]'
                                }).catch(() => {});
                            }

                            if (!released && token) {
                                released = true;
                                AccountManager.releaseToken(token);
                            }
                        };

                        s.on('end', () => handleFinish('completed'));
                        s.on('error', () => handleFinish('failed'));
                        s.on('close', () => handleFinish('completed'));

                        return new Response(s, {
                            type: "text/event-stream",
                            headers: {
                                "Cache-Control": "no-cache, no-transform",
                                "Connection": "keep-alive",
                                "X-Accel-Buffering": "no"
                            }
                        });
                    } else {
                        const startTime = Date.now();
                        const result = await video.createVideoCompletion(resolvedVideoParams, account, assistantId, 0, autoDelete);
                        if (isPooled) AccountManager.releaseToken(account.token);
                        else if (matchedAccount) AccountManager.releaseToken(matchedAccount.token);

                        const targetAcc = account || matchedAccount;
                        const accountId = targetAcc?.id;
                        const tokenSummary = targetAcc ? AccountManager.getAccountDisplayName(targetAcc.id) : '匿名 Token';

                        requestLogger.addLog({
                            action: 'generate_video',
                            model: model || 'doubao-video',
                            tokenSummary,
                            accountId,
                            status: 'completed',
                            progress: '100%',
                            statusCode: 200,
                            summary: '视频结果已返回',
                            duration: Number(((Date.now() - requestStartTime) / 1000).toFixed(2)),
                            requestData: videoParams,
                            responseData: result
                        }).catch(() => {});

                        return result;
                    }
                } catch (err: any) {
                    lastError = err;
                    
                    // 如果是安全审核、侵权、违规、肖像保护或版权受限等风控错误，释放账号并向客户端直接返回标准 JSON 错误，决不重试
                    if (
                        err instanceof APIException ||
                        (err.message && (
                            err.message.includes("侵权") ||
                            err.message.includes("违规") ||
                            err.message.includes("内容安全") ||
                            err.message.includes("肖像保护") ||
                            err.message.includes("版权限制") ||
                            err.message.includes("无法返回该内容")
                        ))
                    ) {
                        if (isPooled && account) {
                            AccountManager.releaseToken(account.token);
                        } else if (matchedAccount) {
                            AccountManager.releaseToken(matchedAccount.token);
                        }
                        const apiErr = (err instanceof APIException) ? err : new APIException(EX.API_REQUEST_FAILED, err.message);

                        const durationSec = Number(((Date.now() - requestStartTime) / 1000).toFixed(2));
                        const targetAcc = account || matchedAccount;
                        const accountId = targetAcc?.id;
                        const tokenSummary = targetAcc ? AccountManager.getAccountDisplayName(targetAcc.id) : (isPooled ? '账号池' : '匿名 Token');

                        requestLogger.addLog({
                            action: 'generate_video',
                            model: model || 'doubao-video',
                            tokenSummary,
                            accountId,
                            status: 'failed',
                            progress: '100%',
                            statusCode: apiErr.httpStatusCode || 500,
                            summary: apiErr.message || '视频内容安全或风控审核未通过',
                            duration: durationSec,
                            requestData: videoParams,
                            responseData: { error: apiErr.message, stack: err.stack }
                        }).catch(() => {});

                        return new Response(new FailureBody(apiErr), { statusCode: apiErr.httpStatusCode || 500 });
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

            const durationSec = Number(((Date.now() - requestStartTime) / 1000).toFixed(2));
            const targetAcc = account || matchedAccount;
            const accountId = targetAcc?.id;
            const tokenSummary = targetAcc ? AccountManager.getAccountDisplayName(targetAcc.id) : (isPooled ? '账号池' : '匿名 Token');
            const statusCode = lastError?.httpStatusCode || lastError?.errcode || lastError?.status || lastError?.statusCode || 500;
            const errorMsg = lastError?.message || '视频生成失败';

            if (!streamLogged) {
                requestLogger.addLog({
                    action: 'generate_video',
                    model: model || 'doubao-video',
                    tokenSummary,
                    accountId,
                    status: 'failed',
                    progress: '100%',
                    statusCode: typeof statusCode === 'number' && statusCode >= 100 && statusCode < 600 ? statusCode : 500,
                    summary: errorMsg,
                    duration: durationSec,
                    requestData: videoParams,
                    responseData: { error: errorMsg, stack: lastError?.stack }
                }).catch(() => {});
            }

            if (lastError instanceof APIException) {
                return new Response(new FailureBody(lastError), { statusCode: lastError.httpStatusCode });
            }
            throw lastError;
        }
    }
};
