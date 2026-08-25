/**
 * @file register-default-providers.ts
 * @description 自动注册默认的渠道驱动 (Doubao, Miaoxiang, Jimeng, OpenAI)。
 */

import providerRegistry from "./provider-registry.ts";
import miaoxiangmusic from "@/api/controllers/miaoxiangmusic.ts";
import music from "@/api/controllers/music.ts";

export function initDefaultProviders() {
    // 1. 注册 豆包 (Doubao) 渠道驱动
    providerRegistry.registerDriver({
        id: "doubao",
        name: "豆包 (Doubao)",
        description: "API 原生 SESSION / 官方网页服务",
        capabilities: ["chat", "image", "video", "music"],
        defaultModels: ["doubao", "doubao-pro", "doubao-image", "doubao-video", "doubao-music"],
        async createCompletion(params: any, account: any, options: any = {}) {
            return await music.createMusicCompletion(params, account, options.assistantId, options.retryCount, options.autoDelete);
        },
        async createCompletionStream(params: any, account: any, options: any = {}) {
            return await music.createMusicCompletionStream(params, account, options.assistantId, options.retryCount, options.autoDelete);
        }
    });

    // 2. 注册 抖音妙响 (Miaoxiang) 渠道驱动
    providerRegistry.registerDriver({
        id: "miaoxiang",
        name: "抖音妙响 (Miaoxiang)",
        description: "抖音妙响 API 原生 SESSION / Astra 音乐",
        capabilities: ["music"],
        defaultModels: miaoxiangmusic.MIAOXIANG_MODELS.map(m => m.modelName),
        async createCompletion(params: any, account: any, options: any = {}) {
            return await miaoxiangmusic.createMusicCompletion(params, account, options.assistantId, options.retryCount, options.autoDelete);
        },
        async createCompletionStream(params: any, account: any, options: any = {}) {
            return await miaoxiangmusic.createMusicCompletionStream(params, account, options.assistantId, options.retryCount, options.autoDelete);
        }
    });

    // 3. 注册 即梦 (Jimeng) 渠道驱动
    providerRegistry.registerDriver({
        id: "jimeng",
        name: "即梦 (Jimeng)",
        description: "即梦 API / SESSIONID 会话",
        capabilities: ["image", "video"],
        defaultModels: ["jimeng-4.0", "jimeng-video-seedance-2.0-fast", "jimeng-video-3.0-fast"],
        async createCompletion() {
            throw new Error("Jimeng operations are handled via media task manager");
        }
    });

    // 4. 注册 OpenAI 渠道驱动
    providerRegistry.registerDriver({
        id: "openai",
        name: "OpenAI",
        description: "三方兼容代理 API",
        capabilities: ["chat", "image", "video"],
        defaultModels: ["gpt-4o", "dall-e-3"],
        async createCompletion() {
            throw new Error("OpenAI operations are handled via openai proxy");
        }
    });
}
