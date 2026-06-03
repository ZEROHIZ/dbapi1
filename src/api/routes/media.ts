import _ from "lodash";
import fs from "fs-extra";

import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import SuccessfulBody from "@/lib/response/SuccessfulBody.ts";
import mediaTaskManager from "@/lib/media-task-manager.ts";
import images from "@/api/controllers/images.ts";
import video from "@/api/controllers/video.ts";
import music from "@/api/controllers/music.ts";
import openaiProxy from "@/api/controllers/openai-proxy.ts";
import AccountManager from "@/lib/account-manager.ts";

async function getImageAccount(authHeader: string, model: string): Promise<{ account: any; pooled: boolean }> {
    if (authHeader.includes("pooled") || authHeader.length < 20) {
        return {
            account: await AccountManager.acquireToken("image", model),
            pooled: true
        };
    }

    const tokens = images.tokenSplit(authHeader);
    const rawToken = _.sample(tokens) || "";
    if (!rawToken) throw new Error("Invalid Authorization Token");
    const matchedAccount = AccountManager.getAccountByToken(rawToken);
    return { account: matchedAccount || rawToken, pooled: false };
}

async function getVideoAccount(authHeader: string, model?: string): Promise<{ account: any; pooled: boolean }> {
    if (authHeader.includes("pooled") || authHeader.length < 20) {
        return {
            account: await AccountManager.acquireToken("video", model),
            pooled: true
        };
    }

    const tokens = video.tokenSplit(authHeader);
    const rawToken = _.sample(tokens) || "";
    if (!rawToken) throw new Error("Invalid Authorization Token");
    const matchedAccount = AccountManager.getAccountByToken(rawToken);
    return { account: matchedAccount || rawToken, pooled: false };
}

async function getMusicAccount(authHeader: string): Promise<{ account: any; pooled: boolean }> {
    if (authHeader.includes("pooled") || authHeader.length < 20) {
        return {
            account: await AccountManager.acquireToken("music"),
            pooled: true
        };
    }

    const tokens = music.tokenSplit(authHeader);
    const rawToken = _.sample(tokens) || "";
    if (!rawToken) throw new Error("Invalid Authorization Token");
    const matchedAccount = AccountManager.getAccountByToken(rawToken);
    return { account: matchedAccount || rawToken, pooled: false };
}

function getAssistantId(account: any, model?: string) {
    let assistantId = model && /^[a-z0-9]{24,}$/.test(model) ? model : undefined;
    if (!assistantId && account && typeof account !== "string") {
        const mapped = AccountManager.getMappedModel(account.id, model || "");
        if (mapped && /^[a-z0-9]{24,}$/.test(mapped)) assistantId = mapped;
    }
    return assistantId;
}

function shouldRetryGeneration(err: any) {
    const text = [err?.message, err?.stack, String(err || "")].filter(Boolean).join("\n");
    return text.includes("RETRY_GENERATION_EMPTY") || text.includes("RETRY_GENERATION_LIMIT");
}

async function runWithRetries(executor: () => Promise<any>, maxRetries = 3) {
    let lastError: any;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await executor();
        } catch (err: any) {
            lastError = err;
            if (attempt < maxRetries && shouldRetryGeneration(err)) {
                continue;
            }
            throw err;
        }
    }
    throw lastError;
}

export default {
    prefix: "/v1",
    post: {
        "/generations/tasks/query": async (request: Request) => {
            request.validate("headers.authorization", _.isString);
            const taskId = request.body?.task_id || request.body?.id || request.body?.prompt;
            if (!_.isString(taskId) || !taskId.trim()) {
                return new Response({ code: 400, message: "task_id is required", data: null }, { statusCode: 400 });
            }
            const task = await mediaTaskManager.getPublicTask(taskId.trim());
            if (!task) {
                return new Response({ code: 404, message: "Task not found", data: null }, { statusCode: 404 });
            }
            return new SuccessfulBody(task);
        },
        "/images/generations/async": async (request: Request) => {
            request
                .validate("body.model", _.isString)
                .validate("body.prompt", _.isString)
                .validate("body.ratio", (v) => _.isUndefined(v) || _.isString(v))
                .validate("body.size", (v) => _.isUndefined(v) || _.isString(v))
                .validate("body.style", (v) => _.isUndefined(v) || _.isString(v))
                .validate("body.image", (v) => _.isUndefined(v) || _.isString(v) || (_.isArray(v) && v.every(_.isString)))
                .validate("headers.authorization", _.isString);

            const authHeader = request.headers.authorization || "";
            const remaining = AccountManager.getTotalRemainingUsage("image", request.body.model);
            if (remaining <= 0) {
                return new Response({ 
                    code: 403, 
                    message: `今日系统额度已耗尽，或无活跃渠道支持模型 [image:${request.body.model}]`, 
                    data: null 
                }, { statusCode: 403 });
            }

            const body = { ...request.body, stream: false };
            const task = await mediaTaskManager.createTask("image", body, async () => {
                return runWithRetries(async () => {
                    const authHeader = request.headers.authorization || "";
                    const { account, pooled } = await getImageAccount(authHeader, body.model);
                    const matchedAccount = (!pooled && typeof account !== 'string') ? account : null;
                    try {
                        if (matchedAccount) {
                            AccountManager.lockAccount(matchedAccount, "image");
                        }
                        if (pooled && account.type === "openai") {
                            return await openaiProxy.proxyImage(body, account);
                        }
                        const assistantId = getAssistantId(account, body.model);
                        return await images.createImageCompletion({
                            model: body.model,
                            prompt: body.prompt,
                            ratio: body.size || body.ratio,
                            style: body.style || "auto",
                            referenceImage: body.image
                        }, account, assistantId, 0, _.isBoolean(body.auto_delete) ? body.auto_delete : true);
                    } catch (err: any) {
                        if (err.message && (err.message.includes("RETRY_GENERATION_LIMIT") || err.message.includes("生成次数已经达到上限"))) {
                            const targetAccount = pooled ? account : matchedAccount;
                            if (targetAccount) {
                                targetAccount.usageImage = targetAccount.limitImage > 0 ? targetAccount.limitImage : 99999;
                                await AccountManager.saveAccounts();
                                const l = require('@/lib/logger.ts').default;
                                l.warn(`[API] 账号 [${targetAccount.name}] 达到图片生成次数上限，已更新用量并保存`);
                            }
                        }
                        throw err;
                    } finally {
                        if (pooled && account?.token) AccountManager.releaseToken(account.token);
                        else if (matchedAccount) AccountManager.releaseToken(matchedAccount.token);
                    }
                });
            });

            return new SuccessfulBody({
                task_id: task.id,
                status: task.status,
                query_url: `/v1/generations/tasks/${task.id}`
            });
        },
        "/video/generations/async": async (request: Request) => {
            request
                .validate("body.prompt", _.isString)
                .validate("body.ratio", (v) => _.isUndefined(v) || _.isString(v))
                .validate("body.model", (v) => _.isUndefined(v) || _.isString(v))
                .validate("body.image", (v) => _.isUndefined(v) || _.isString(v) || (_.isArray(v) && v.every(_.isString)))
                .validate("headers.authorization", _.isString);

            const body = { ...request.body, stream: false };
            const model = body.model || "doubao-video";

            const remaining = AccountManager.getTotalRemainingUsage("video", model);
            if (remaining <= 0) {
                return new Response({ 
                    code: 403, 
                    message: `今日系统额度已耗尽，或无活跃渠道支持模型 [video:${model}]`, 
                    data: null 
                }, { statusCode: 403 });
            }

            const task = await mediaTaskManager.createTask("video", body, async () => {
                return runWithRetries(async () => {
                    const authHeader = request.headers.authorization || "";
                    const { account, pooled } = await getVideoAccount(authHeader, model);
                    const matchedAccount = (!pooled && typeof account !== 'string') ? account : null;
                    try {
                        if (matchedAccount) {
                            AccountManager.lockAccount(matchedAccount, "video");
                        }
                        if (pooled && account.type === "openai") {
                            return await openaiProxy.proxyVideo(body, account);
                        }
                        const assistantId = getAssistantId(account, model);
                        return await video.createVideoCompletion({
                            model,
                            prompt: body.prompt,
                            ratio: body.ratio || "16:9",
                            image: body.image
                        }, account, assistantId, 0, _.isBoolean(body.auto_delete) ? body.auto_delete : false);
                    } catch (err: any) {
                        if (err.message && (err.message.includes("RETRY_GENERATION_LIMIT") || err.message.includes("生成次数已经达到上限"))) {
                            const targetAccount = pooled ? account : matchedAccount;
                            if (targetAccount) {
                                targetAccount.usageVideo = targetAccount.limitVideo > 0 ? targetAccount.limitVideo : 99999;
                                await AccountManager.saveAccounts();
                                const l = require('@/lib/logger.ts').default;
                                l.warn(`[API] 账号 [${targetAccount.name}] 达到视频生成次数上限，已更新用量并保存`);
                            }
                        }
                        throw err;
                    } finally {
                        if (pooled && account?.token) AccountManager.releaseToken(account.token);
                        else if (matchedAccount) AccountManager.releaseToken(matchedAccount.token);
                    }
                });
            });

            return new SuccessfulBody({
                task_id: task.id,
                status: task.status,
                query_url: `/v1/generations/tasks/${task.id}`
            });
        },
        "/music/generations/async": async (request: Request) => {
            request
                .validate("body.prompt", _.isString)
                .validate("body.model", (v) => _.isUndefined(v) || _.isString(v))
                .validate("body.lyric", (v) => _.isUndefined(v) || _.isString(v))
                .validate("body.theme", (v) => _.isUndefined(v) || _.isString(v))
                .validate("body.mood", (v) => _.isUndefined(v) || _.isString(v))
                .validate("body.genre", (v) => _.isUndefined(v) || _.isString(v))
                .validate("body.gender", (v) => _.isUndefined(v) || _.isString(v))
                .validate("body.generation_type", (v) => _.isUndefined(v) || _.isString(v))
                .validate("headers.authorization", _.isString);

            const body = { ...request.body, stream: false };
            const model = body.model || "doubao-music";

            const remaining = AccountManager.getTotalRemainingUsage("music", model);
            if (remaining <= 0) {
                return new Response({ 
                    code: 403, 
                    message: `今日系统额度已耗尽，或无活跃渠道支持模型 [music:${model}]`, 
                    data: null 
                }, { statusCode: 403 });
            }

            const task = await mediaTaskManager.createTask("music", body, async () => {
                return runWithRetries(async () => {
                    const authHeader = request.headers.authorization || "";
                    const { account, pooled } = await getMusicAccount(authHeader);
                    const matchedAccount = (!pooled && typeof account !== 'string') ? account : null;
                    try {
                        if (matchedAccount) {
                            AccountManager.lockAccount(matchedAccount, "music");
                        }
                        return await music.createMusicCompletion({
                            model,
                            prompt: body.prompt,
                            lyric: body.lyric,
                            theme: body.theme,
                            mood: body.mood,
                            genre: body.genre,
                            gender: body.gender,
                            generation_type: body.generation_type
                        }, account, undefined, 0, _.isBoolean(body.auto_delete) ? body.auto_delete : true);
                    } catch (err: any) {
                        if (err.message && (err.message.includes("RETRY_GENERATION_LIMIT") || err.message.includes("生成次数已经达到上限"))) {
                            const targetAccount = pooled ? account : matchedAccount;
                            if (targetAccount) {
                                targetAccount.usageMusic = targetAccount.limitMusic > 0 ? targetAccount.limitMusic : 99999;
                                await AccountManager.saveAccounts();
                                const l = require('@/lib/logger.ts').default;
                                l.warn(`[API] 账号 [${targetAccount.name}] 达到音乐生成次数上限，已更新用量并保存`);
                            }
                        }
                        throw err;
                    } finally {
                        if (pooled && account?.token) AccountManager.releaseToken(account.token);
                        else if (matchedAccount) AccountManager.releaseToken(matchedAccount.token);
                    }
                });
            });

            return new SuccessfulBody({
                task_id: task.id,
                status: task.status,
                query_url: `/v1/generations/tasks/${task.id}`
            });
        }
    },
    get: {
        "/generations/tasks/:task_id": async (request: Request) => {
            const task = await mediaTaskManager.getPublicTask(request.params.task_id);
            if (!task) {
                return new Response({ code: 404, message: "Task not found", data: null }, { statusCode: 404 });
            }
            return new SuccessfulBody(task);
        },
        "/generations/media/:folder/:filename": async (request: Request) => {
            const file = await mediaTaskManager.getMediaFile(request.params.folder, request.params.filename);
            if (!file) {
                return new Response({ code: 404, message: "Media file not found", data: null }, { statusCode: 404 });
            }
            return new Response(fs.createReadStream(file.path), {
                type: file.mime_type,
                size: file.size,
                headers: {
                    "Content-Disposition": `inline; filename="${request.params.filename.replace(/"/g, "")}"`
                }
            });
        }
    }
};
