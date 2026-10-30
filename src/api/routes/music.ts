/**
 * @file music.ts
 * @description 音乐生成路由，处理音乐生成流式与非流式请求、模型映射解析、抖音妙响与豆包音乐生成、失败重试及全流程请求日志落盘。
 */

import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import music from "@/api/controllers/music.ts";
import miaoxiangmusic from "@/api/controllers/miaoxiangmusic.ts";
import AccountManager from "@/lib/account-manager.ts";
import APIException from "@/lib/exceptions/APIException.ts";
import FailureBody from "@/lib/response/FailureBody.ts";
import requestLogger from "@/lib/request-logger.ts";

function isMiaoxiangModel(model?: string, accountId?: string): boolean {
    if (!model) return false;
    const resolved = AccountManager.getMappedModel(accountId || "", model) || model;
    if (resolved === "doubao-music" || resolved === "default") return false;
    if (resolved.includes("miaoxiang")) return true;
    const normalized = resolved.trim().toLowerCase().replace(/\s+/g, "");
    return miaoxiangmusic.MIAOXIANG_MODELS.some(m => m.modelName.toLowerCase().replace(/\s+/g, "") === normalized);
}

interface MusicCompletionRequestBody {
    model?: string;
    prompt: string;
    lyric?: string;
    theme?: string;
    mood?: string;
    genre?: string;
    gender?: string;
    generation_type?: string;
    stream?: boolean;
    auto_delete?: boolean;
}

export default {
    prefix: "/v1/music",

    post: {
        "/generations": async (request: Request) => {
            const requestStartTime = Date.now();
            request
                .validate("body.prompt", _.isString)
                .validate("body.model", (v) => _.isUndefined(v) || _.isString(v))
                .validate("body.lyric", (v) => _.isUndefined(v) || _.isString(v))
                .validate("body.theme", (v) => _.isUndefined(v) || _.isString(v))
                .validate("body.mood", (v) => _.isUndefined(v) || _.isString(v))
                .validate("body.genre", (v) => _.isUndefined(v) || _.isString(v))
                .validate("body.gender", (v) => _.isUndefined(v) || _.isString(v))
                .validate("body.generation_type", (v) => _.isUndefined(v) || _.isString(v))
                .validate("body.stream", (v) => _.isUndefined(v) || _.isBoolean(v))
                .validate("headers.authorization", _.isString);

            const authHeader = request.headers.authorization || "";
            let account: any;
            let isPooled = false;

            if (authHeader.includes("pooled") || authHeader.length < 20) {
                isPooled = true;
            } else {
                const tokens = music.tokenSplit(authHeader);
                account = _.sample(tokens) || "";
                if (!account) {
                    throw new Error("Invalid Authorization Token");
                }
            }

            const body = request.body as MusicCompletionRequestBody;
            const model = body.model || "doubao-music";
            const autoDelete = _.isBoolean(body.auto_delete) ? body.auto_delete : true;
            const useMiaoxiang = isMiaoxiangModel(model);
            const targetController = useMiaoxiang ? miaoxiangmusic : music;

            let matchedAccount: any = null;
            if (!isPooled && typeof account === 'string') {
                matchedAccount = AccountManager.getAccountByToken(account);
                if (matchedAccount) {
                    account = matchedAccount;
                }
            }

            let attempt = 0;
            const maxRetries = 3;
            let lastError: any;
            let streamLogged = false;

            const requestParams = {
                model,
                prompt: body.prompt,
                lyric: body.lyric,
                theme: body.theme,
                mood: body.mood,
                genre: body.genre,
                gender: body.gender,
                generation_type: body.generation_type
            };

            while (attempt < maxRetries) {
                attempt++;
                try {
                    if (isPooled) {
                        account = await AccountManager.acquireToken("music", model);
                    } else if (matchedAccount) {
                        AccountManager.lockAccount(matchedAccount, 'music');
                    }

                    const resolvedModel = AccountManager.getMappedModel(account?.id || "", model);
                    const activeController = isMiaoxiangModel(resolvedModel, account?.id) ? miaoxiangmusic : targetController;
                    const resolvedRequestParams = {
                        ...requestParams,
                        model: resolvedModel
                    };

                    if (body.stream) {
                        const startTime = Date.now();
                        const s = await activeController.createMusicCompletionStream(resolvedRequestParams, account, undefined, 0, autoDelete);
                        const token = isPooled ? account.token : matchedAccount?.token;
                        let released = false;
                        let logged = false;

                        const handleFinish = (status: "completed" | "failed") => {
                            if (!logged) {
                                logged = true;
                                streamLogged = true;
                                const duration = Number(((Date.now() - startTime) / 1000).toFixed(2));
                                const targetAcc = account || matchedAccount;
                                const accountId = targetAcc?.id;
                                const tokenSummary = targetAcc ? AccountManager.getAccountDisplayName(targetAcc.id) : '匿名 Token';

                                requestLogger.addLog({
                                    action: 'generate_music',
                                    model: model || 'doubao-music',
                                    tokenSummary,
                                    accountId,
                                    status,
                                    progress: '100%',
                                    statusCode: status === 'completed' ? 200 : 500,
                                    summary: status === 'completed' ? '音乐流式生成完成' : '音乐流式生成失败',
                                    duration,
                                    requestData: requestParams,
                                    responseData: status === 'completed' ? '[流式音乐响应]' : '[流式音乐生成异常]'
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
                    }

                    const startTime = Date.now();
                    const result = await activeController.createMusicCompletion(resolvedRequestParams, account, undefined, 0, autoDelete);
                    if (isPooled) AccountManager.releaseToken(account.token);
                    else if (matchedAccount) AccountManager.releaseToken(matchedAccount.token);

                    const targetAcc = account || matchedAccount;
                    if (targetAcc?.id) {
                        await AccountManager.updateAccountUsage(targetAcc.id, 'music');
                    }
                    const accountId = targetAcc?.id;
                    const tokenSummary = targetAcc ? AccountManager.getAccountDisplayName(targetAcc.id) : '匿名 Token';

                    requestLogger.addLog({
                        action: 'generate_music',
                        model: model || 'doubao-music',
                        tokenSummary,
                        accountId,
                        status: 'completed',
                        progress: '100%',
                        statusCode: 200,
                        summary: '音乐结果已返回',
                        duration: Number(((Date.now() - requestStartTime) / 1000).toFixed(2)),
                        requestData: requestParams,
                        responseData: result
                    }).catch(() => {});

                    return result;
                } catch (err: any) {
                    lastError = err;
                    let policyAction = "error";
                    const statusCode = err.errcode || err.status || err.statusCode || err.response?.status;

                    if (isPooled && account) {
                        if (statusCode) {
                            policyAction = AccountManager.applyResponsePolicy(account.id, statusCode);
                        }
                        AccountManager.releaseToken(account.token);
                    } else if (matchedAccount) {
                        AccountManager.releaseToken(matchedAccount.token);
                    }

                    if (err.message && err.message.includes("RETRY_GENERATION_EMPTY")) {
                        policyAction = "retry";
                    }

                    if (err.message && (err.message.includes("RETRY_GENERATION_LIMIT") || err.message.includes("生成次数已经达到上限"))) {
                        policyAction = "retry";
                        const targetAccount = isPooled ? account : matchedAccount;
                        if (targetAccount) {
                            targetAccount.usageMusic = targetAccount.limitMusic > 0 ? targetAccount.limitMusic : 99999;
                            await AccountManager.saveAccounts();
                            const l = require('@/lib/logger.ts').default;
                            l.warn(`[API] 账号 [${targetAccount.name}] 达到音乐生成次数上限，已更新用量并保存`);
                        }
                    }

                    if (policyAction === "retry" && attempt < maxRetries) {
                        continue;
                    }
                    throw err;
                }
            }

            const duration = Number(((Date.now() - requestStartTime) / 1000).toFixed(2));
            const targetAcc = account || matchedAccount;
            const accountId = targetAcc?.id;
            const tokenSummary = targetAcc ? AccountManager.getAccountDisplayName(targetAcc.id) : (isPooled ? '账号池' : '匿名 Token');
            const statusCode = lastError?.httpStatusCode || lastError?.errcode || lastError?.status || lastError?.statusCode || 500;
            const errorMsg = lastError?.message || '音乐生成失败';

            if (!streamLogged) {
                requestLogger.addLog({
                    action: 'generate_music',
                    model: model || 'doubao-music',
                    tokenSummary,
                    accountId,
                    status: 'failed',
                    progress: '100%',
                    statusCode: typeof statusCode === 'number' && statusCode >= 100 && statusCode < 600 ? statusCode : 500,
                    summary: errorMsg,
                    duration,
                    requestData: requestParams,
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
