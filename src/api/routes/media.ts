/**
 * @file media.ts
 * @description 异步多媒体生成路由（图片、视频、音乐），负责异步任务创建、模型映射解析、账号池调度与任务状态查询。
 */

import _ from "lodash";
import fs from "fs-extra";

import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import SuccessfulBody from "@/lib/response/SuccessfulBody.ts";
import mediaTaskManager from "@/lib/media-task-manager.ts";
import images from "@/api/controllers/images.ts";
import video from "@/api/controllers/video.ts";
import music from "@/api/controllers/music.ts";
import miaoxiangmusic from "@/api/controllers/miaoxiangmusic.ts";
import openaiProxy from "@/api/controllers/openai-proxy.ts";
import AccountManager from "@/lib/account-manager.ts";
import requestLogger from "@/lib/request-logger.ts";

function isMiaoxiangModel(model?: string, accountId?: string): boolean {
    if (!model) return false;
    const resolved = AccountManager.getMappedModel(accountId || "", model) || model;
    if (resolved === "doubao-music" || resolved === "default") return false;
    if (resolved.includes("miaoxiang")) return true;
    const normalized = resolved.trim().toLowerCase().replace(/\s+/g, "");
    return miaoxiangmusic.MIAOXIANG_MODELS.some(m => m.modelName.toLowerCase().replace(/\s+/g, "") === normalized);
}

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

async function getMusicAccount(authHeader: string, model?: string): Promise<{ account: any; pooled: boolean }> {
    if (authHeader.includes("pooled") || authHeader.length < 20) {
        return {
            account: await AccountManager.acquireToken("music", model),
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
                requestLogger.addLog({
                    action: "generate_image",
                    model: request.body.model,
                    tokenSummary: "系统额度已尽",
                    status: "failed",
                    progress: "100%",
                    statusCode: 403,
                    summary: `[异步生图 403] 今日系统额度已耗尽，或无活跃渠道支持 [image:${request.body.model}]`,
                    duration: 0,
                    requestData: request.body,
                    responseData: { error: `今日系统额度已耗尽，或无活跃渠道支持模型 [image:${request.body.model}]` }
                }).catch(() => {});
                return new Response({ 
                    code: 403, 
                    message: `今日系统额度已耗尽，或无活跃渠道支持模型 [image:${request.body.model}]`, 
                    data: null 
                }, { statusCode: 403 });
            }

            const body = { ...request.body, stream: false };
            const startTime = Date.now();
            const logEntry = await requestLogger.addLog({
                action: "generate_image",
                model: body.model,
                tokenSummary: "调度排队中...",
                status: "running",
                progress: "0%",
                statusCode: 200,
                summary: `[异步生图-提交] ${body.prompt?.substring(0, 60) || ""}`,
                duration: 0,
                requestData: body,
                responseData: { status: "queued" }
            });

            const task = await mediaTaskManager.createTask("image", body, async () => {
                return runWithRetries(async () => {
                    const authHeader = request.headers.authorization || "";
                    const { account, pooled } = await getImageAccount(authHeader, body.model);
                    const matchedAccount = (!pooled && typeof account !== 'string') ? account : null;
                    const accountDisplay = AccountManager.getAccountDisplayName(matchedAccount?.id || account?.id || "") || (account?.name || (pooled ? "公共渠道池" : "自选渠道"));
                    try {
                        if (matchedAccount) {
                            AccountManager.lockAccount(matchedAccount, "image");
                        }
                        let result: any;
                        if (pooled && account.type === "openai") {
                            result = await openaiProxy.proxyImage(body, account);
                        } else {
                            const assistantId = getAssistantId(account, body.model);
                            result = await images.createImageCompletion({
                                model: body.model,
                                prompt: body.prompt,
                                ratio: body.size || body.ratio,
                                style: body.style || "auto",
                                referenceImage: body.image
                            }, account, assistantId, 0, _.isBoolean(body.auto_delete) ? body.auto_delete : true);
                        }

                        const duration = Number(((Date.now() - startTime) / 1000).toFixed(2));
                        requestLogger.updateLog(logEntry.id, {
                            status: "completed",
                            progress: "100%",
                            duration,
                            accountId: matchedAccount?.id || account?.id,
                            tokenSummary: accountDisplay,
                            summary: `[异步生图-完成] ${body.prompt?.substring(0, 60) || ""}`,
                            responseData: result
                        }).catch(() => {});

                        return result;
                    } catch (err: any) {
                        const duration = Number(((Date.now() - startTime) / 1000).toFixed(2));
                        requestLogger.updateLog(logEntry.id, {
                            status: "failed",
                            progress: "100%",
                            duration,
                            statusCode: 500,
                            accountId: matchedAccount?.id || account?.id,
                            tokenSummary: accountDisplay,
                            summary: `[异步生图-失败] ${err.message || String(err)}`,
                            responseData: { error: err.message || String(err) }
                        }).catch(() => {});

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

            requestLogger.updateLog(logEntry.id, {
                responseData: {
                    task_id: task.id,
                    status: task.status,
                    query_url: `/v1/generations/tasks/${task.id}`
                }
            }).catch(() => {});

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
                .validate("body.model", _.isString)
                .validate("body.duration", _.isNumber)
                .validate("body.image", (v) => _.isUndefined(v) || _.isString(v) || (_.isArray(v) && v.every(_.isString)))
                .validate("headers.authorization", _.isString);

            const body = { ...request.body, stream: false };
            const model = body.model;
            const routeModel = (model === "sdmini" || model === "sdfast") ? "doubao-video" : model;

            const remaining = AccountManager.getTotalRemainingUsage("video", routeModel);
            if (remaining <= 0) {
                requestLogger.addLog({
                    action: "generate_video",
                    model: model,
                    tokenSummary: "系统额度已尽",
                    status: "failed",
                    progress: "100%",
                    statusCode: 403,
                    summary: `[异步视频 403] 今日系统额度已耗尽，或无活跃渠道支持 [video:${model}]`,
                    duration: 0,
                    requestData: request.body,
                    responseData: { error: `今日系统额度已耗尽，或无活跃渠道支持模型 [video:${model}]` }
                }).catch(() => {});
                return new Response({ 
                    code: 403, 
                    message: `今日系统额度已耗尽，或无活跃渠道支持模型 [video:${model}]`, 
                    data: null 
                }, { statusCode: 403 });
            }

            const startTime = Date.now();
            const logEntry = await requestLogger.addLog({
                action: "generate_video",
                model: model,
                tokenSummary: "调度排队中...",
                status: "running",
                progress: "0%",
                statusCode: 200,
                summary: `[异步视频-提交] ${body.prompt?.substring(0, 60) || ""}`,
                duration: 0,
                requestData: body,
                responseData: { status: "queued" }
            });

            const task = await mediaTaskManager.createTask("video", body, async () => {
                return runWithRetries(async () => {
                    const authHeader = request.headers.authorization || "";
                    const { account, pooled } = await getVideoAccount(authHeader, routeModel);
                    const matchedAccount = (!pooled && typeof account !== 'string') ? account : null;
                    const accountDisplay = AccountManager.getAccountDisplayName(matchedAccount?.id || account?.id || "") || (account?.name || (pooled ? "公共渠道池" : "自选渠道"));
                    try {
                        if (matchedAccount) {
                            AccountManager.lockAccount(matchedAccount, "video");
                        }
                        let result: any;
                        if (pooled && account.type === "openai") {
                            result = await openaiProxy.proxyVideo(body, account);
                        } else {
                            const assistantId = getAssistantId(account, routeModel);
                            const resolvedModel = AccountManager.getMappedModel(account?.id || "", model);
                            result = await video.createVideoCompletion({
                                model: resolvedModel,
                                prompt: body.prompt,
                                ratio: body.ratio || "16:9",
                                image: body.image,
                                duration: body.duration
                            }, account, assistantId, 0, _.isBoolean(body.auto_delete) ? body.auto_delete : false);
                        }

                        const duration = Number(((Date.now() - startTime) / 1000).toFixed(2));
                        requestLogger.updateLog(logEntry.id, {
                            status: "completed",
                            progress: "100%",
                            duration,
                            accountId: matchedAccount?.id || account?.id,
                            tokenSummary: accountDisplay,
                            summary: `[异步视频-完成] ${body.prompt?.substring(0, 60) || ""}`,
                            responseData: result
                        }).catch(() => {});

                        return result;
                    } catch (err: any) {
                        const duration = Number(((Date.now() - startTime) / 1000).toFixed(2));
                        requestLogger.updateLog(logEntry.id, {
                            status: "failed",
                            progress: "100%",
                            duration,
                            statusCode: 500,
                            accountId: matchedAccount?.id || account?.id,
                            tokenSummary: accountDisplay,
                            summary: `[异步视频-失败] ${err.message || String(err)}`,
                            responseData: { error: err.message || String(err) }
                        }).catch(() => {});

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

            requestLogger.updateLog(logEntry.id, {
                responseData: {
                    task_id: task.id,
                    status: task.status,
                    query_url: `/v1/generations/tasks/${task.id}`
                }
            }).catch(() => {});

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
                requestLogger.addLog({
                    action: "generate_music",
                    model: model,
                    tokenSummary: "系统额度已尽",
                    status: "failed",
                    progress: "100%",
                    statusCode: 403,
                    summary: `[异步音乐 403] 今日系统额度已耗尽，或无活跃渠道支持 [music:${model}]`,
                    duration: 0,
                    requestData: request.body,
                    responseData: { error: `今日系统额度已耗尽，或无活跃渠道支持模型 [music:${model}]` }
                }).catch(() => {});
                return new Response({ 
                    code: 403, 
                    message: `今日系统额度已耗尽，或无活跃渠道支持模型 [music:${model}]`, 
                    data: null 
                }, { statusCode: 403 });
            }

            const startTime = Date.now();
            const logEntry = await requestLogger.addLog({
                action: "generate_music",
                model: model,
                tokenSummary: "调度排队中...",
                status: "running",
                progress: "0%",
                statusCode: 200,
                summary: `[异步音乐-提交] ${body.prompt?.substring(0, 60) || ""}`,
                duration: 0,
                requestData: body,
                responseData: { status: "queued" }
            });

            const task = await mediaTaskManager.createTask("music", body, async () => {
                return runWithRetries(async () => {
                    const authHeader = request.headers.authorization || "";
                    const { account, pooled } = await getMusicAccount(authHeader, model);
                    const matchedAccount = (!pooled && typeof account !== 'string') ? account : null;
                    const accountDisplay = AccountManager.getAccountDisplayName(matchedAccount?.id || account?.id || "") || (account?.name || (pooled ? "公共渠道池" : "自选渠道"));
                    try {
                        if (matchedAccount) {
                            AccountManager.lockAccount(matchedAccount, "music");
                        }
                        const resolvedModel = AccountManager.getMappedModel(account?.id || "", model);
                        const targetController = isMiaoxiangModel(resolvedModel, account?.id) ? miaoxiangmusic : music;
                        const result = await targetController.createMusicCompletion({
                            model: resolvedModel,
                            prompt: body.prompt,
                            lyric: body.lyric,
                            theme: body.theme,
                            mood: body.mood,
                            genre: body.genre,
                            gender: body.gender,
                            generation_type: body.generation_type
                        }, account, undefined, 0, _.isBoolean(body.auto_delete) ? body.auto_delete : true);

                        const duration = Number(((Date.now() - startTime) / 1000).toFixed(2));
                        requestLogger.updateLog(logEntry.id, {
                            status: "completed",
                            progress: "100%",
                            duration,
                            accountId: matchedAccount?.id || account?.id,
                            tokenSummary: accountDisplay,
                            summary: `[异步音乐-完成] ${body.prompt?.substring(0, 60) || ""}`,
                            responseData: result
                        }).catch(() => {});

                        return result;
                    } catch (err: any) {
                        const duration = Number(((Date.now() - startTime) / 1000).toFixed(2));
                        requestLogger.updateLog(logEntry.id, {
                            status: "failed",
                            progress: "100%",
                            duration,
                            statusCode: 500,
                            accountId: matchedAccount?.id || account?.id,
                            tokenSummary: accountDisplay,
                            summary: `[异步音乐-失败] ${err.message || String(err)}`,
                            responseData: { error: err.message || String(err) }
                        }).catch(() => {});

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

            requestLogger.updateLog(logEntry.id, {
                responseData: {
                    task_id: task.id,
                    status: task.status,
                    query_url: `/v1/generations/tasks/${task.id}`
                }
            }).catch(() => {});

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
