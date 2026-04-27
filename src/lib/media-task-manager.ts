import path from "path";
import fs from "fs-extra";
import axios from "axios";
import mime from "mime";

import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";

type MediaType = "image" | "video";
type TaskStatus = "queued" | "running" | "succeeded" | "failed";

export interface LocalMediaItem {
    type: MediaType;
    source_url?: string;
    local_path: string;
    filename: string;
    size: number;
    mime_type?: string;
}

export interface MediaTask {
    id: string;
    type: MediaType;
    status: TaskStatus;
    request: any;
    result?: any;
    media: LocalMediaItem[];
    error?: string;
    created_at: string;
    started_at?: string;
    completed_at?: string;
}

const MEDIA_DIR = path.join(process.cwd(), "data", "media");
const IMAGE_DIR = path.join(MEDIA_DIR, "images");
const VIDEO_DIR = path.join(MEDIA_DIR, "videos");
const TASKS_FILE = path.join(MEDIA_DIR, "tasks.json");
const MEDIA_URL_PREFIX = "/v1/generations/media";

let tasks: Record<string, MediaTask> | null = null;
let saveQueue = Promise.resolve();

async function ensureStore() {
    await fs.ensureDir(IMAGE_DIR);
    await fs.ensureDir(VIDEO_DIR);
    if (!await fs.pathExists(TASKS_FILE)) {
        await fs.writeJson(TASKS_FILE, {}, { spaces: 2 });
    }
    if (!tasks) {
        tasks = await fs.readJson(TASKS_FILE).catch(() => ({}));
    }
}

async function saveTasks() {
    await ensureStore();
    saveQueue = saveQueue.then(() => fs.writeJson(TASKS_FILE, tasks || {}, { spaces: 2 }));
    await saveQueue;
}

function cloneTask(task: MediaTask) {
    return JSON.parse(JSON.stringify(task));
}

function buildMediaUrl(item: LocalMediaItem) {
    const folder = item.type === "image" ? "images" : "videos";
    return `${MEDIA_URL_PREFIX}/${folder}/${encodeURIComponent(item.filename)}`;
}

function toPublicTask(task: MediaTask) {
    return {
        task_id: task.id,
        type: task.type,
        status: task.status,
        error: task.error || null,
        media: task.media.map(item => ({
            type: item.type,
            url: item.source_url,
            local_url: buildMediaUrl(item),
            local_path: item.local_path,
            filename: item.filename,
            size: item.size,
            mime_type: item.mime_type
        }))
    };
}

function getMessage(result: any) {
    return result?.choices?.[0]?.message || {};
}

function extractMediaSources(type: MediaType, result: any) {
    const message = getMessage(result);
    if (type === "image") {
        const urls = new Set<string>();
        if (Array.isArray(message.images)) {
            message.images.filter(Boolean).forEach((url: string) => urls.add(url));
        }
        if (Array.isArray(result?.data)) {
            result.data.forEach((item: any) => {
                if (item?.url) urls.add(item.url);
                if (item?.b64_json) urls.add(`data:image/png;base64,${item.b64_json}`);
            });
        }
        return [...urls].map(url => ({ type, url }));
    }

    const videos = Array.isArray(message.videos) ? message.videos : [];
    return videos
        .map((item: any) => item?.url)
        .filter(Boolean)
        .map((url: string) => ({ type, url }));
}

function inferExtension(url: string, contentType?: string, fallback = "bin") {
    const typeExt = contentType ? mime.getExtension(contentType.split(";")[0].trim()) : "";
    if (typeExt) return typeExt;
    try {
        const urlExt = path.extname(new URL(url).pathname).replace(/^\./, "");
        if (urlExt) return urlExt;
    } catch {
        // ignore invalid URLs such as data URIs
    }
    return fallback;
}

async function saveDataUri(dataUri: string, taskId: string, index: number, type: MediaType): Promise<LocalMediaItem> {
    const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error("Invalid base64 media data");
    const mimeType = match[1];
    const buffer = Buffer.from(match[2], "base64");
    const ext = inferExtension(dataUri, mimeType, type === "image" ? "png" : "mp4");
    const filename = `${taskId}-${index + 1}.${ext}`;
    const dir = type === "image" ? IMAGE_DIR : VIDEO_DIR;
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, buffer);
    return {
        type,
        source_url: "data-uri",
        local_path: path.relative(process.cwd(), filePath).replace(/\\/g, "/"),
        filename,
        size: buffer.length,
        mime_type: mimeType
    };
}

async function downloadMedia(url: string, taskId: string, index: number, type: MediaType): Promise<LocalMediaItem> {
    if (url.startsWith("data:")) {
        return saveDataUri(url, taskId, index, type);
    }

    const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 120000,
        maxContentLength: 1024 * 1024 * 1024,
        headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept": type === "image" ? "image/*,*/*;q=0.8" : "video/*,*/*;q=0.8"
        }
    });
    const contentType = response.headers?.["content-type"];
    const buffer = Buffer.from(response.data);
    const ext = inferExtension(url, contentType, type === "image" ? "png" : "mp4");
    const filename = `${taskId}-${index + 1}.${ext}`;
    const dir = type === "image" ? IMAGE_DIR : VIDEO_DIR;
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, buffer);
    return {
        type,
        source_url: url,
        local_path: path.relative(process.cwd(), filePath).replace(/\\/g, "/"),
        filename,
        size: buffer.length,
        mime_type: contentType
    };
}

async function runTask(taskId: string, executor: () => Promise<any>) {
    await ensureStore();
    const task = tasks?.[taskId];
    if (!task) return;

    task.status = "running";
    task.started_at = new Date().toISOString();
    await saveTasks();

    try {
        const result = await executor();
        const sources = extractMediaSources(task.type, result);
        const media = await Promise.all(
            sources.map((source, index) => downloadMedia(source.url, task.id, index, source.type))
        );

        task.status = "succeeded";
        task.result = result;
        task.media = media;
        task.completed_at = new Date().toISOString();
        await saveTasks();
        logger.success(`[MediaTask] ${task.id} completed, files=${media.length}`);
    } catch (err: any) {
        task.status = "failed";
        task.error = err?.message || String(err);
        task.completed_at = new Date().toISOString();
        await saveTasks();
        logger.error(`[MediaTask] ${task.id} failed: ${task.error}`);
    }
}

async function createTask(type: MediaType, requestBody: any, executor: () => Promise<any>) {
    await ensureStore();
    const id = `media-${Date.now()}-${util.generateRandomString({ length: 8, charset: "alphanumeric" }).toLowerCase()}`;
    const task: MediaTask = {
        id,
        type,
        status: "queued",
        request: requestBody,
        media: [],
        created_at: new Date().toISOString()
    };
    tasks![id] = task;
    await saveTasks();

    setImmediate(() => {
        runTask(id, executor).catch(err => logger.error(`[MediaTask] runner crashed: ${err?.stack || err}`));
    });

    return cloneTask(task);
}

async function getTask(id: string) {
    await ensureStore();
    const task = tasks?.[id];
    return task ? cloneTask(task) : null;
}

async function getPublicTask(id: string) {
    await ensureStore();
    const task = tasks?.[id];
    return task ? toPublicTask(task) : null;
}

async function getMediaFile(folder: string, filename: string) {
    await ensureStore();
    if (!["images", "videos"].includes(folder)) return null;
    const safeName = path.basename(filename);
    if (!safeName || safeName !== filename) return null;
    const baseDir = folder === "images" ? IMAGE_DIR : VIDEO_DIR;
    const filePath = path.join(baseDir, safeName);
    if (!await fs.pathExists(filePath)) return null;
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    return {
        path: filePath,
        size: stat.size,
        mime_type: mime.getType(filePath) || "application/octet-stream"
    };
}

async function clearLocalMedia() {
    await ensureStore();
    await fs.emptyDir(IMAGE_DIR);
    await fs.emptyDir(VIDEO_DIR);
    tasks = {};
    await saveTasks();
    return {
        images_dir: path.relative(process.cwd(), IMAGE_DIR).replace(/\\/g, "/"),
        videos_dir: path.relative(process.cwd(), VIDEO_DIR).replace(/\\/g, "/"),
        tasks_file: path.relative(process.cwd(), TASKS_FILE).replace(/\\/g, "/")
    };
}

export default {
    createTask,
    getTask,
    getPublicTask,
    getMediaFile,
    clearLocalMedia,
    paths: {
        mediaDir: MEDIA_DIR,
        imageDir: IMAGE_DIR,
        videoDir: VIDEO_DIR,
        tasksFile: TASKS_FILE
    }
};
