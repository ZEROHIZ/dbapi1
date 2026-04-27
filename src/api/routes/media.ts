import _ from "lodash";
import fs from "fs-extra";

import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import SuccessfulBody from "@/lib/response/SuccessfulBody.ts";
import mediaTaskManager from "@/lib/media-task-manager.ts";
import images from "@/api/controllers/images.ts";
import video from "@/api/controllers/video.ts";
import openaiProxy from "@/api/controllers/openai-proxy.ts";
import AccountManager from "@/lib/account-manager.ts";

async function getImageAccount(authHeader: string, model: string) {
    if (authHeader.includes("pooled") || authHeader.length < 20) {
        return {
            account: await AccountManager.acquireToken("image", model),
            pooled: true
        };
    }

    const tokens = images.tokenSplit(authHeader);
    const account = _.sample(tokens) || "";
    if (!account) throw new Error("Invalid Authorization Token");
    return { account, pooled: false };
}

async function getVideoAccount(authHeader: string, model?: string) {
    if (authHeader.includes("pooled") || authHeader.length < 20) {
        return {
            account: await AccountManager.acquireToken("video", model),
            pooled: true
        };
    }

    const tokens = video.tokenSplit(authHeader);
    const account = _.sample(tokens) || "";
    if (!account) throw new Error("Invalid Authorization Token");
    return { account, pooled: false };
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
    return text.includes("RETRY_GENERATION_EMPTY");
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

            const body = { ...request.body, stream: false };
            const task = await mediaTaskManager.createTask("image", body, async () => {
                return runWithRetries(async () => {
                    const authHeader = request.headers.authorization || "";
                    const { account, pooled } = await getImageAccount(authHeader, body.model);
                    try {
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
                    } finally {
                        if (pooled && account?.token) AccountManager.releaseToken(account.token);
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
            const task = await mediaTaskManager.createTask("video", body, async () => {
                return runWithRetries(async () => {
                    const authHeader = request.headers.authorization || "";
                    const { account, pooled } = await getVideoAccount(authHeader, model);
                    try {
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
                    } finally {
                        if (pooled && account?.token) AccountManager.releaseToken(account.token);
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
