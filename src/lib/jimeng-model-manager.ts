/**
 * @file jimeng-model-manager.ts
 * @description 即梦模型管理器，负责即梦模型在不同区域（CN/US/ASIA）的上游映射关系管理与持久化。
 */

import fs from "fs-extra";
import path from "path";
import logger from "./logger.ts";

const DATA_DIR = path.join(process.cwd(), "data");
const MODELS_FILE = path.join(DATA_DIR, "jimeng-models.json");

export interface JimengModelConfig {
    id: string;
    object: "model";
    type: "image" | "video";
    enabled: boolean;
    mappings: {
        cn: string;
        us: string;
        asia: string;
    };
    description?: string;
}

class JimengModelManager {
    private models: JimengModelConfig[] = [];

    constructor() {
        this.loadModels();
    }

    private async loadModels() {
        try {
            if (await fs.pathExists(MODELS_FILE)) {
                this.models = await fs.readJson(MODELS_FILE);
            } else {
                // 初始化默认即梦模型
                this.models = [
                    {
                        id: "jimeng-5.0",
                        object: "model",
                        type: "image",
                        enabled: true,
                        mappings: { cn: "high_aes_general_v50", us: "", asia: "high_aes_general_v50" },
                        description: "即梦 5.0 图像模型"
                    },
                    {
                        id: "jimeng-4.6",
                        object: "model",
                        type: "image",
                        enabled: true,
                        mappings: { cn: "high_aes_general_v42", us: "", asia: "high_aes_general_v42" },
                        description: "即梦 4.6 图像模型"
                    },
                    {
                        id: "jimeng-4.5",
                        object: "model",
                        type: "image",
                        enabled: true,
                        mappings: { cn: "high_aes_general_v40l", us: "high_aes_general_v40l", asia: "high_aes_general_v40l" },
                        description: "即梦 4.5 图像模型"
                    },
                    {
                        id: "jimeng-4.1",
                        object: "model",
                        type: "image",
                        enabled: true,
                        mappings: { cn: "high_aes_general_v41", us: "high_aes_general_v41", asia: "high_aes_general_v41" },
                        description: "即梦 4.1 图像模型"
                    },
                    {
                        id: "jimeng-4.0",
                        object: "model",
                        type: "image",
                        enabled: true,
                        mappings: { cn: "high_aes_general_v40", us: "high_aes_general_v40", asia: "high_aes_general_v40" },
                        description: "即梦 4.0 图像模型"
                    },
                    {
                        id: "jimeng-3.1",
                        object: "model",
                        type: "image",
                        enabled: true,
                        mappings: { cn: "high_aes_general_v30l_art_fangzhou:general_v3.0_18b", us: "", asia: "" },
                        description: "即梦 3.1 图像模型"
                    },
                    {
                        id: "jimeng-3.0",
                        object: "model",
                        type: "image",
                        enabled: true,
                        mappings: { cn: "high_aes_general_v30l:general_v3.0_18b", us: "high_aes_general_v30l:general_v3.0_18b", asia: "high_aes_general_v30l:general_v3.0_18b" },
                        description: "即梦 3.0 图像模型"
                    },
                    {
                        id: "nanobanana",
                        object: "model",
                        type: "image",
                        enabled: true,
                        mappings: { cn: "", us: "external_model_gemini_flash_image_v25", asia: "external_model_gemini_flash_image_v25" },
                        description: "Gemini Flash Image"
                    },
                    {
                        id: "nanobananapro",
                        object: "model",
                        type: "image",
                        enabled: true,
                        mappings: { cn: "", us: "dreamina_image_lib_1", asia: "dreamina_image_lib_1" },
                        description: "Dreamina Image Lib"
                    },
                    {
                        id: "jimeng-video-seedance-2.0",
                        object: "model",
                        type: "video",
                        enabled: true,
                        mappings: { cn: "dreamina_seedance_40_pro", us: "", asia: "" },
                        description: "即梦视频 Seedance 2.0"
                    },
                    {
                        id: "jimeng-video-seedance-2.0-fast",
                        object: "model",
                        type: "video",
                        enabled: true,
                        mappings: { cn: "dreamina_seedance_40", us: "", asia: "" },
                        description: "即梦视频 Seedance 2.0 Fast"
                    },
                    {
                        id: "jimeng-video-3.5-pro",
                        object: "model",
                        type: "video",
                        enabled: true,
                        mappings: { cn: "dreamina_ic_generate_video_model_vgfm_3.5_pro", us: "dreamina_ic_generate_video_model_vgfm_3.5_pro", asia: "dreamina_ic_generate_video_model_vgfm_3.5_pro" },
                        description: "即梦视频 3.5 Pro"
                    },
                    {
                        id: "jimeng-video-3.0-pro",
                        object: "model",
                        type: "video",
                        enabled: true,
                        mappings: { cn: "dreamina_ic_generate_video_model_vgfm_3.0_pro", us: "", asia: "dreamina_ic_generate_video_model_vgfm_3.0_pro" },
                        description: "即梦视频 3.0 Pro"
                    },
                    {
                        id: "jimeng-video-3.0",
                        object: "model",
                        type: "video",
                        enabled: true,
                        mappings: { cn: "dreamina_ic_generate_video_model_vgfm_3.0", us: "dreamina_ic_generate_video_model_vgfm_3.0", asia: "dreamina_ic_generate_video_model_vgfm_3.0" },
                        description: "即梦视频 3.0"
                    },
                    {
                        id: "jimeng-video-3.0-fast",
                        object: "model",
                        type: "video",
                        enabled: true,
                        mappings: { cn: "dreamina_ic_generate_video_model_vgfm_3.0_fast", us: "", asia: "dreamina_ic_generate_video_model_vgfm_3.0_fast" },
                        description: "即梦视频 3.0 Fast"
                    },
                    {
                        id: "jimeng-video-2.0",
                        object: "model",
                        type: "video",
                        enabled: true,
                        mappings: { cn: "dreamina_ic_generate_video_model_vgfm_lite", us: "", asia: "dreamina_ic_generate_video_model_vgfm_lite" },
                        description: "即梦视频 2.0"
                    },
                    {
                        id: "jimeng-video-2.0-pro",
                        object: "model",
                        type: "video",
                        enabled: true,
                        mappings: { cn: "dreamina_ic_generate_video_model_vgfm1.0", us: "", asia: "dreamina_ic_generate_video_model_vgfm1.0" },
                        description: "即梦视频 2.0 Pro"
                    },
                    {
                        id: "jimeng-video-veo3",
                        object: "model",
                        type: "video",
                        enabled: true,
                        mappings: { cn: "", us: "", asia: "dreamina_veo3_generate_video" },
                        description: "Veo3 视频生成"
                    },
                    {
                        id: "jimeng-video-veo3.1",
                        object: "model",
                        type: "video",
                        enabled: true,
                        mappings: { cn: "", us: "", asia: "dreamina_veo3.1_generate_video" },
                        description: "Veo3.1 视频生成"
                    },
                    {
                        id: "jimeng-video-sora2",
                        object: "model",
                        type: "video",
                        enabled: true,
                        mappings: { cn: "", us: "", asia: "dreamina_sora2_generate_video" },
                        description: "Sora2 视频生成"
                    }
                ];
                await this.saveModels();
            }
        } catch (e) {
            logger.error("加载即梦模型配置文件失败:", e);
        }
    }

    public async saveModels() {
        try {
            await fs.writeJson(MODELS_FILE, this.models, { spaces: 2 });
        } catch (e) {
            logger.error("保存即梦模型配置文件失败:", e);
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

    public async addOrUpdateModel(config: JimengModelConfig) {
        const index = this.models.findIndex(m => m.id === config.id);
        if (index !== -1) {
            this.models[index] = { ...this.models[index], ...config };
        } else {
            this.models.push(config);
        }
        await this.saveModels();
    }

    public async deleteModel(id: string) {
        this.models = this.models.filter(m => m.id !== id);
        await this.saveModels();
    }
}

export default new JimengModelManager();
