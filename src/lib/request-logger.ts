/**
 * @file request-logger.ts
 * @description 结构化 API 请求与响应日志管理器，负责收集、存储及持久化每次 API 调用的操作、耗时、分配账号、请求体与响应结果。
 */

import fs from "fs-extra";
import path from "path";
import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import { format as dateFormat } from "date-fns";

const DATA_DIR = path.join(process.cwd(), "data");
const REQUEST_LOGS_FILE = path.join(DATA_DIR, "request-logs.json");
const MAX_LOG_ENTRIES = 1000;

export interface RequestLogEntry {
    id: number;
    action: string;
    model: string;
    tokenSummary: string;
    status: "completed" | "failed" | "running";
    progress: string;
    statusCode: number;
    summary: string;
    duration: number; // 秒，保留两位小数
    timestamp: string;
    requestData: any;
    responseData: any;
}

class RequestLoggerManager {
    private logs: RequestLogEntry[] = [];
    private nextId: number = 1;
    private saveQueue: Promise<void> = Promise.resolve();

    constructor() {
        this.init();
    }

    private async init() {
        try {
            await fs.ensureDir(DATA_DIR);
            if (await fs.pathExists(REQUEST_LOGS_FILE)) {
                const stored = await fs.readJson(REQUEST_LOGS_FILE);
                if (Array.isArray(stored)) {
                    // 仅保留包含标准 action 属性的结构化日志，过滤掉旧版系统底层自动记录的格式不符条目
                    this.logs = stored.filter(l => l && typeof l === 'object' && typeof l.action === 'string' && l.action.length > 0);
                    if (this.logs.length > 0) {
                        const maxId = Math.max(...this.logs.map(l => Number(l.id) || 0));
                        this.nextId = maxId + 1;
                    }
                }
            }
        } catch (e) {
            logger.error("[RequestLogger] 加载请求日志文件失败:", e);
            this.logs = [];
        }
    }

    private async saveLogs(): Promise<void> {
        this.saveQueue = this.saveQueue.then(async () => {
            try {
                await fs.writeJson(REQUEST_LOGS_FILE, this.logs, { spaces: 2 });
            } catch (e) {
                logger.error("[RequestLogger] 保存请求日志文件失败:", e);
            }
        });
        return this.saveQueue;
    }

    /**
     * 清理敏感或超长 Base64 字符串
     */
    private sanitizePayload(data: any): any {
        if (!data) return data;
        try {
            const str = JSON.stringify(data);
            if (!str) return data;

            // 替换 base64
            const cleaned = str.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "[BASE64_IMAGE_DATA]")
                               .replace(/"b64_json":\s*"[A-Za-z0-9+/=]{100,}"/g, '"b64_json": "[BASE64_OMITTED]"');
            
            return JSON.parse(cleaned);
        } catch {
            return data;
        }
    }

    /**
     * 添加新的 API 请求调用日志
     */
    public async addLog(entry: Omit<RequestLogEntry, "id" | "timestamp">): Promise<RequestLogEntry> {
        const id = this.nextId++;
        const timestamp = dateFormat(new Date(), "yyyy/MM/dd HH:mm:ss");

        const newEntry: RequestLogEntry = {
            ...entry,
            id,
            timestamp,
            requestData: this.sanitizePayload(entry.requestData),
            responseData: this.sanitizePayload(entry.responseData)
        };

        // 插到列表最前面
        this.logs.unshift(newEntry);

        // 控制保留上限
        if (this.logs.length > MAX_LOG_ENTRIES) {
            this.logs = this.logs.slice(0, MAX_LOG_ENTRIES);
        }

        await this.saveLogs();
        return newEntry;
    }

    /**
     * 获取日志列表（支持分页、模型筛选及分类搜索）
     */
    public getLogs(query: {
        page?: number;
        pageSize?: number;
        keyword?: string;
        action?: string;
        status?: string;
    } = {}) {
        let result = [...this.logs];

        if (query.action && query.action !== "all") {
            result = result.filter(l => l.action === query.action);
        }

        if (query.status && query.status !== "all") {
            result = result.filter(l => l.status === query.status);
        }

        if (query.keyword) {
            const kw = query.keyword.toLowerCase();
            result = result.filter(l =>
                l.model?.toLowerCase().includes(kw) ||
                l.tokenSummary?.toLowerCase().includes(kw) ||
                l.summary?.toLowerCase().includes(kw) ||
                l.action?.toLowerCase().includes(kw)
            );
        }

        const page = Math.max(1, Number(query.page || 1));
        const pageSize = Math.max(1, Math.min(100, Number(query.pageSize || 20)));
        const total = result.length;
        const totalPages = Math.ceil(total / pageSize);
        const startIndex = (page - 1) * pageSize;
        const items = result.slice(startIndex, startIndex + pageSize);

        return {
            items,
            total,
            page,
            pageSize,
            totalPages
        };
    }

    /**
     * 获取单条日志详情
     */
    public getLogById(id: number): RequestLogEntry | null {
        return this.logs.find(l => l.id === id) || null;
    }

    /**
     * 清空所有请求日志
     */
    public async clearLogs(): Promise<void> {
        this.logs = [];
        await this.saveLogs();
    }
}

export default new RequestLoggerManager();
