import fs from "fs-extra";
import path from "path";
import logger from "./logger.ts";

const DATA_DIR = path.join(process.cwd(), "data");
const MODELS_FILE = path.join(DATA_DIR, "models.json");

export interface ModelConfig {
    id: string;
    object: "model";
    owned_by: string;
    backendModel?: string; // 默认对应的上游模型名称
    type: "chat" | "image" | "video" | "music";
    defaultParams?: Record<string, any>;
    enabled: boolean;
}

export const DEFAULT_MIAOXIANG_MODELS: ModelConfig[] = [
    { id: "Sway i5.0", object: "model", owned_by: "douyin-miaoxiang", backendModel: "Sway i5.0", type: "music", enabled: true },
    { id: "SeedMusic i4.0", object: "model", owned_by: "douyin-miaoxiang", backendModel: "SeedMusic i4.0", type: "music", enabled: true },
    { id: "TemPolor i3.5", object: "model", owned_by: "douyin-miaoxiang", backendModel: "TemPolor i3.5", type: "music", enabled: true },
    { id: "Sodance v2.0", object: "model", owned_by: "douyin-miaoxiang", backendModel: "Sodance v2.0", type: "music", enabled: true },
    { id: "MiniMax v2.6", object: "model", owned_by: "douyin-miaoxiang", backendModel: "MiniMax v2.6", type: "music", enabled: true },
    { id: "TemPolor v4.1a", object: "model", owned_by: "douyin-miaoxiang", backendModel: "TemPolor v4.1a", type: "music", enabled: true },
    { id: "音潮 v3.0", object: "model", owned_by: "douyin-miaoxiang", backendModel: "音潮 v3.0", type: "music", enabled: true },
    { id: "SeedMusic v4.3+", object: "model", owned_by: "douyin-miaoxiang", backendModel: "SeedMusic v4.3+", type: "music", enabled: true },
    { id: "TemPolor v4.0", object: "model", owned_by: "douyin-miaoxiang", backendModel: "TemPolor v4.0", type: "music", enabled: true },
    { id: "Sway v5.5", object: "model", owned_by: "douyin-miaoxiang", backendModel: "Sway v5.5", type: "music", enabled: true }
];

class ModelManager {
    private models: ModelConfig[] = [];

    constructor() {
        this.loadModels();
    }

    private async loadModels() {
        try {
            if (await fs.pathExists(MODELS_FILE)) {
                this.models = await fs.readJson(MODELS_FILE);
            } else {
                // 初始化默认模型
                this.models = [
                    { id: "doubao", object: "model", owned_by: "doubao-free-api", type: "chat", enabled: true },
                    { id: "doubao-pro", object: "model", owned_by: "doubao-free-api", type: "chat", enabled: true },
                    { id: "doubao-image", object: "model", owned_by: "doubao-free-api", backendModel: "Seedream 4.0", type: "image", enabled: true },
                    { id: "doubao-video", object: "model", owned_by: "doubao-free-api", type: "video", enabled: true },
                    { id: "doubao-music", object: "model", owned_by: "doubao-free-api", type: "music", enabled: true },
                    { id: "Seedream 4.0", object: "model", owned_by: "doubao-free-api", backendModel: "Seedream 4.0", type: "image", enabled: true },
                    { id: "Seedream 4.2", object: "model", owned_by: "doubao-free-api", backendModel: "Seedream 4.2", type: "image", enabled: true },
                    { id: "Seedream 4.5", object: "model", owned_by: "doubao-free-api", backendModel: "Seedream 4.5", type: "image", enabled: true }
                ];
            }

            // 自动补齐预置的抖音妙响模型与修正错误类型
            let modified = false;
            for (const m of DEFAULT_MIAOXIANG_MODELS) {
                if (!this.models.some(item => item.id === m.id)) {
                    this.models.push(m);
                    modified = true;
                }
            }
            for (const item of this.models) {
                if (item.id === "doubao-image" && item.type === "chat") {
                    item.type = "image";
                    modified = true;
                } else if (item.id === "doubao-video" && item.type === "chat") {
                    item.type = "video";
                    modified = true;
                } else if (item.id === "doubao-music" && item.type === "chat") {
                    item.type = "music";
                    modified = true;
                }
            }
            if (modified || !(await fs.pathExists(MODELS_FILE))) {
                await this.saveModels();
            }
        } catch (e) {
            logger.error("加载模型配置文件失败:", e);
        }
    }

    public saveModels() {
        try {
            return fs.writeJson(MODELS_FILE, this.models, { spaces: 2 });
        } catch (e) {
            logger.error("保存模型配置文件失败:", e);
        }
    }

    public getEnabledModels() {
        return this.models.filter(m => m.enabled);
    }

    public getAllModels() {
        return this.models;
    }

    public getModelConfig(modelId: string) {
        return this.models.find(m => m.id === modelId);
    }

    public async addModel(config: ModelConfig) {
        this.models.push(config);
        await this.saveModels();
    }

    public async updateModel(id: string, updates: Partial<ModelConfig>) {
        const index = this.models.findIndex(m => m.id === id);
        if (index !== -1) {
            this.models[index] = { ...this.models[index], ...updates };
            await this.saveModels();
            return true;
        }
        return false;
    }

    public async addOrUpdateModel(config: ModelConfig, mergeProviders: boolean = true) {
        const index = this.models.findIndex(m => m.id === config.id);
        if (index !== -1) {
            const existing = this.models[index];
            if (mergeProviders) {
                // 合并模式（如账号模型同步）：仅更新并去重 owned_by 关联提供者，强力保留用户设置的 type、backendModel、enabled、defaultParams 等核心字段！
                let newOwnedBy = existing.owned_by || "";
                if (config.owned_by) {
                    const providers = [
                        ...newOwnedBy.split(/[,，]/).map(p => p.trim()),
                        ...config.owned_by.split(/[,，]/).map(p => p.trim())
                    ].filter(p => p.length > 0);
                    newOwnedBy = [...new Set(providers)].join(', ');
                }
                this.models[index] = { 
                    ...existing, 
                    owned_by: newOwnedBy 
                };
            } else {
                // 手动修改覆盖模式（如后台模型管理保存）
                this.models[index] = { 
                    ...existing, 
                    ...config 
                };
            }
        } else {
            this.models.push(config);
        }
        await this.saveModels();
        // 触发双向同步：更新账号的支持模型列表
        import("./account-manager.ts").then(m => {
            m.default.syncAccountModelsWithModelProviders();
        }).catch(err => {
            logger.error("[ModelManager] 触发账号模型同步失败:", err);
        });
    }

    public async deleteModel(id: string) {
        this.models = this.models.filter(m => m.id !== id);
        await this.saveModels();
    }

    /**
     * 从所有模型中移除特定的提供者名称
     * @param providerName 提供者名称（渠道名）
     */
    public async removeProviderFromAllModels(providerName: string) {
        if (!providerName) return;
        let modified = false;
        const target = providerName.toLowerCase();

        this.models.forEach(model => {
            if (!model.owned_by) return;
            const providers = model.owned_by.split(/[,，]/).map(p => p.trim());
            const filtered = providers.filter(p => p.toLowerCase() !== target);
            
            if (filtered.length !== providers.length) {
                model.owned_by = filtered.join(', ');
                modified = true;
            }
        });

        if (modified) {
            await this.saveModels();
            logger.info(`[ModelManager] 已从所有模型中移除提供者: ${providerName}`);
        }
    }

    /**
     * 获取指定提供者支持的所有模型 ID
     * @param providerName 提供者名称
     */
    public getModelsByProvider(providerName: string): string[] {
        if (!providerName) return [];
        const target = providerName.toLowerCase();
        return this.models
            .filter(m => {
                if (!m.owned_by) return false;
                return m.owned_by.split(/[,，]/).some(p => p.trim().toLowerCase() === target);
            })
            .map(m => m.id);
    }
}

export default new ModelManager();
