/**
 * @file music.ts
 * @description 音乐生成路由，处理音乐生成同步及异步的流式与非流式请求。
 */

import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import music from "@/api/controllers/music.ts";
import AccountManager from "@/lib/account-manager.ts";
import APIException from "@/lib/exceptions/APIException.ts";
import FailureBody from "@/lib/response/FailureBody.ts";

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

            while (attempt < maxRetries) {
                attempt++;
                try {
                    if (isPooled) {
                        account = await AccountManager.acquireToken("music");
                    } else if (matchedAccount) {
                        AccountManager.lockAccount(matchedAccount, 'music');
                    }

                    const params = {
                        model,
                        prompt: body.prompt,
                        lyric: body.lyric,
                        theme: body.theme,
                        mood: body.mood,
                        genre: body.genre,
                        gender: body.gender,
                        generation_type: body.generation_type
                    };

                    if (body.stream) {
                        const s = await music.createMusicCompletionStream(params, account, undefined, 0, autoDelete);
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
                    }

                    const result = await music.createMusicCompletion(params, account, undefined, 0, autoDelete);
                    if (isPooled) AccountManager.releaseToken(account.token);
                    else if (matchedAccount) AccountManager.releaseToken(matchedAccount.token);
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

            if (lastError instanceof APIException) {
                return new Response(new FailureBody(lastError), { statusCode: lastError.httpStatusCode });
            }
            throw lastError;
        }
    }
};
