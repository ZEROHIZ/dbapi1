# 新渠道 (Provider) 动态插件接入规范与指南

本指南旨在说明如何在系统中接入一个新的渠道/平台（例如 Suno、Kling、Sora 或自定义三方 API），使得**后端自动注册、路由自动分发、前端下拉框自动显示**，无需修改前端 UI 代码。

---

## 核心架构原理

系统采用了 **渠道驱动注册架构 (Provider Plugin Architecture)**：

```
┌─────────────────────────────────────────────────────────────┐
│                 渠道驱动注册中心 (ProviderRegistry)           │
├───────────────┬─────────────────┬──────────────┬────────────┤
│ doubaoDriver  │ miaoxiangDriver │ jimengDriver │ YourDriver │
└───────┬───────┴────────┬────────┴──────┬───────┴─────┬──────┘
        │                │               │             │
        ▼                ▼               ▼             ▼
┌─────────────────────────────────────────────────────────────┐
│ GET /v1/admin/providers ──> 前端下拉框动态渲染选项 (无需修改前端)│
└─────────────────────────────────────────────────────────────┘
```

---

## 新接入渠道 3 步走指南

假设我们要接入一个新的音乐平台 `suno`：

### 步骤 1：创建核心控制器逻辑
在 `src/api/controllers/` 目录下创建你的控制器逻辑，例如 `src/api/controllers/sunomusic.ts`：

```typescript
/**
 * @file sunomusic.ts
 * @description Suno 音乐生成控制器逻辑
 */

export default {
    async createMusicCompletion(params: any, account: any) {
        // 实现你的 3 阶段生成逻辑或三方 API 请求
        return {
            id: "suno-123456",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: params.model || "suno-v3.5",
            choices: [{
                index: 0,
                message: {
                    role: "assistant",
                    content: "生成成功！",
                    music: {
                        url: "https://example.com/audio.mp3",
                        title: "Suno Track"
                    }
                },
                finish_reason: "stop"
            }]
        };
    }
};
```

---

### 步骤 2：定义渠道 Driver 并注册
打开 `src/lib/register-default-providers.ts`，调用 `providerRegistry.registerDriver()` 注册你的新驱动：

```typescript
import providerRegistry from "./provider-registry.ts";
import sunomusic from "@/api/controllers/sunomusic.ts";

// 在 initDefaultProviders() 函数末尾追加：
providerRegistry.registerDriver({
    id: "suno",                             // 渠道唯一标识 (小写)
    name: "Suno 音乐 (Suno AI)",            // 前端下拉框显示的名称
    description: "Suno AI 官方 / 三方音乐 API", // 前端下拉框显示的描述
    capabilities: ["music"],               // 支持的能力: "chat" | "image" | "video" | "music"
    defaultModels: ["suno-v3.5", "suno-v4"],// 默认拥有的模型
    
    // 同步生成回调
    async createCompletion(params: any, account: any, options: any = {}) {
        return await sunomusic.createMusicCompletion(params, account);
    },
    
    // (可选) 流式生成回调
    async createCompletionStream(params: any, account: any, options: any = {}) {
        // 返回 NodeJS ReadableStream
    }
});
```

---

### 步骤 3：(可选) 注册默认模型到模型库
如果希望系统模型接口 `/v1/models` 也能自动查到新模型，在 `data/models.json` 中添加模型配置：

```json
  {
    "id": "suno-v3.5",
    "backendModel": "suno-v3.5",
    "object": "model",
    "owned_by": "suno",
    "type": "music",
    "enabled": true
  }
```

---

## 路由自动分发说明

在路由中（例如 `src/api/routes/music.ts` 或 `media.ts`），只需要根据 `account.type` 调用 `ProviderRegistry` 即可实现零 `if-else` 分发：

```typescript
import providerRegistry from "@/lib/provider-registry.ts";

// 自动根据账号类型调用对应的驱动生成
const driver = providerRegistry.getDriver(account.type);
if (driver) {
    return await driver.createCompletion(params, account);
}
```

---

## 接入完成效果
完成上述 3 步后：
1. **打开后台管理面板 -> 添加渠道 API**。
2. 展开“渠道类型”下拉菜单，**无需刷新或改动前端代码**，`Suno 音乐 (Suno AI)` 就会自动呈现在下拉列表中！
3. 选择该类型并填入账号或 API Key 后，后台与分发器会自动将其路由至 `sunomusic.ts` 执行。
