docker run -d --init --name doubao-free-api123 -p 7000:8000 -e ADMIN_PASSWORD=123456 -e SERVER_PORT=8000 -e TZ=Asia/Shanghai -v "${PWD}/data:/app/data" -v "${PWD}/logs:/app/logs" --restart always ghcr.io/zerohiz/dbapi:3.1
# API 接口文档

本文档详细说明了对话、绘图、视频生成、音乐生成接口的请求与返回格式。

## 鉴权 (Authentication)

所有接口均需要在 Header 中设置 `Authorization`。

**方式一：指定 SessionID**
```http
Authorization: Bearer [你的sessionid]
```

**方式二：使用账号池 (自动轮询)**
```http
Authorization: Bearer pooled
```

---

## 1. 对话补全 (Chat Completions) 

支持文本对话及图文多模态对话，完全兼容 OpenAI 格式。

**接口地址**: `POST /v1/chat/completions`

### 1.1 纯文本对话

**请求示例**:
```json
{
    "model": "doubao",
    "messages": [
        {
            "role": "user",
            "content": "你好，请自我介绍一下"
        }
    ],
    "stream": false,
    "auto_delete": true
}
```

### 1.2 图文对话 (多模态)

支持在单条消息中传入多张图片，所有图片会一次性上传并发送。

**请求示例（多图）**:
```json
{
  "model": "doubao",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "比较这两张图片有什么不同？"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "https://example.com/image1.jpg"
          }
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "https://example.com/image2.jpg"
          }
        }
      ]
    }
  ],
  "stream": false,
  "auto_delete": false
}
```

**响应示例**:
```json
{
    "id": "397193850645250",
    "model": "doubao",
    "object": "chat.completion",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "我叫豆包呀，能陪你聊天、帮你答疑解惑呢。"
            },
            "finish_reason": "stop"
        }
    ],
    "created": 1733300587
}
```

### 1.3 工具调用 (Tool Calling)

支持 OpenAI 标准的 `tools` 和 `tool_choice` 参数。

**请求示例**:
```json
{
    "model": "doubao",
    "messages": [
        {
            "role": "user",
            "content": "帮我查一下北京的天气"
        }
    ],
    "tools": [
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "获取指定城市的天气状况",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "location": { "type": "string", "description": "城市名称" }
                    },
                    "required": ["location"]
                }
            }
        }
    ],
    "tool_choice": "auto"
}
```

---

## 2. 图片生成 (Image Generations)

支持文生图和图生图。

**接口地址**: `POST /v1/images/generations`

### 2.1 文生图 (Text to Image)

**请求示例**:
```json
{
    "model": "Seedream 4.0", // 可选
    "prompt": "一只可爱的赛博朋克风格猫咪",
    "ratio": "1:1", // size/ratio 比例: 1:1, 16:9, 9:16 等
    "style": "通用", // 风格: 通用, 卡通, 3D 等
    "stream": false,
    "auto_delete": true
}
```

### 2.2 图生图 (Image to Image)

支持单张或多张参考图。`image` 可以是字符串或字符串数组。
如果不指定 `ratio`，将自动根据第一张参考图的尺寸推断最接近的标准比例。

**单图请求示例**:
```json
{
    "model": "Seedream 4.0",
    "prompt": "变成卡通风格",
    "image": "https://example.com/original.jpg",
    "stream": false
}
```

**多图请求示例**:
```json
{
    "model": "Seedream 4.0",
    "prompt": "把两张图片融合成一张",
    "image": [
        "https://example.com/image1.jpg",
        "https://example.com/image2.jpg"
    ],
    "stream": false
}
```

**响应示例**:
```json
{
    "id": "30868724412460802",
    "model": "Seedream 4.0",
    "object": "chat.completion",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "以下是为您生成的图片：\n![image](https://p3-flow-imagex-sign/1.jpg)",
                "images": [
                    "https://p3-flow-imagex-sign/1.jpg"
                ]
            },
            "finish_reason": "stop"
        }
    ],
    "created": 1763985148
}
### 2.3 即梦模型生成 (Jimeng / Dreamina)

即梦模型完美对齐标准 OpenAI `/v1/images/generations` 与 `/v1/video/generations` 接口。只需在请求体中传入即梦模型 ID 即可自动完成跨区域调度与高精渲染。

**常用即梦图像模型列表**：
- `jimeng-5.0` (即梦 5.0 旗舰图像模型)
- `jimeng-4.6` (即梦 4.6 增强图像模型)
- `jimeng-4.5` (即梦 4.5 常用图像模型)
- `nanobanana` (Gemini Flash Image)

**即梦生图请求示例**:
```json
{
    "model": "jimeng-5.0",
    "prompt": "一只写实风格的橘猫趴在古朴的木质窗台上晒太阳",
    "ratio": "16:9",
    "stream": false
}
```

---

## 3. 视频生成 (Video Generations)

支持文生视频和图生视频，全自动接入 Samantha AISpace 提取 1080p 超清无水印直链。

**接口地址**: `POST /v1/video/generations`

### 3.1 模型参数说明

| 参数名 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `model` | string | 是 | 可选模型别名：<br>- `sdmini` 或 `seedance_v2.0_mini`（Seedance 2.0 Mini 快速生成）<br>- `sdfast`、`seedance_v2.0_std` 或 `seedance_v2.0`（Seedance 2.0 标准版） |
| `prompt` | string | 是 | 视频画面提示词 |
| `image` | string \| string[] | 否 | 参考图（图生视频），支持单张或多张图片 URL / Base64 Data URL |
| `ratio` | string | 否 | 视频输出比例，例如 `"16:9"`（默认）、`"9:16"`、`"1:1"` |
| `duration` | number | 否 | 视频生成时长（秒），例如 `5` 或 `10` |
| `stream` | boolean | 否 | 是否开启流式返回（默认 `false`） |
| `auto_delete` | boolean | 否 | 完成后是否自动清理豆包临时会话（默认 `false`） |

### 3.2 文生视频 (Text to Video)

**请求示例**:
```json
{
    "model": "sdmini", // 可选 sdmini / seedance_v2.0
    "prompt": "海浪拍打沙滩，夕阳西下，镜头缓慢推进",
    "ratio": "16:9",
    "duration": 5, // 视频生成时长（秒）
    "stream": false,
    "auto_delete": false
}
```

### 3.3 图生视频 (Image to Video)

**请求示例**:
```json
{
    "model": "seedance_v2.0", 
    "prompt": "让画面动起来，镜头拉远",
    "image": "https://example.com/start_frame.jpg", // 首帧图片 (URL 或 Base64)
    "ratio": "16:9",
    "duration": 5,
    "stream": false
}
```

**响应示例**:
```json
{
    "id": "73568724412460123",
    "model": "seedance_v2.0",
    "object": "chat.completion",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "![视频封面](https://cover-url.jpg)\n视频链接: https://v11-videoweb-download.doubao.com/...",
                "videos": [
                    {
                        "vid": "v0269cg10004d...",
                        "cover": "https://cover-url.jpg",
                        "url": "https://v11-videoweb-download.doubao.com/..." // 自动解析提取的 1080p 超清无水印直链
                    }
                ]
            },
            "finish_reason": "stop"
        }
    ],
}
```

### 3.4 即梦视频模型生成 (Jimeng Video)

支持通过 `POST /v1/video/generations` 调用即梦前沿视频模型。

**常用即梦视频模型列表**：
- `jimeng-video-seedance-2.0` (即梦视频 Seedance 2.0 旗舰版)
- `jimeng-video-seedance-2.0-fast` (即梦视频 Seedance 2.0 极速版)
- `jimeng-video-3.5-pro` (即梦视频 3.5 Pro)
- `jimeng-video-veo3.1` (Veo 3.1 视频模型)
- `jimeng-video-sora2` (Sora 2 视频模型)

**请求示例**:
```json
{
    "model": "jimeng-video-seedance-2.0",
    "prompt": "海浪拍打沙滩，夕阳西下，镜头缓慢推进",
    "ratio": "16:9",
    "duration": 5,
    "stream": false
}
```

### 2.3 OpenAI 兼容格式 (opendoubao)

将 `model` 设置为 `opendoubao` 时，接口将完全对齐 OpenAI DALL-E 接口规范，适用于 Open WebUI、LobeChat、One API 等标准 OpenAI 客户端。

> **内部映射**：`opendoubao` 会自动路由至 `doubao-image` 账号池（即 Seedream 系列模型），无需额外配置。

**参数说明**：

| 字段 | 说明 |
|:---|:---|
| `model` | 固定填写 `opendoubao` 以启用 OpenAI 兼容模式 |
| `prompt` | 图片生成提示词 |
| `size` | **支持两种格式**：① 比例格式如 `"16:9"`、`"1:1"`、`"9:16"` 直接使用；② 分辨率格式如 `"1024x1792"` 将自动换算为最接近的标准比例（此处为 `"9:16"`） |
| `n` | 生成数量参数（仅用于对齐 OpenAI 协议，实际数量由模型决定，通常 1~4 张） |
| `response_format` | `"url"`（默认）或 `"b64_json"`（服务端自动下载图片并转为 Base64 返回） |
| `image` | 参考图（图生图），可传 URL、Base64 Data URL，支持单张或数组多张 |

**文生图请求示例**：
```json
{
    "model": "opendoubao",
    "prompt": "一只漂浮在太空里的猫",
    "size": "16:9",
    "response_format": "url"
}
```

**多图图生图请求示例**：
```json
{
    "model": "opendoubao",
    "prompt": "将两张参考图融合，生成一个赛博朋克风格猫咪",
    "image": [
        "https://example.com/image1.jpg",
        "data:image/jpeg;base64,/9j/4AAQ..."
    ],
    "size": "1024x1024",
    "response_format": "url"
}
```

**响应示例（URL 格式）**：
```json
{
    "created": 1763985148,
    "data": [
        { "url": "https://p3-flow-imagex-sign/1.jpg" },
        { "url": "https://p3-flow-imagex-sign/2.jpg" }
    ]
}
```

**响应示例（b64_json 格式）**：
```json
{
    "created": 1763985148,
    "data": [
        { "b64_json": "iVBORw0KGgoAAAANSUhEUgAA..." },
        { "b64_json": "iVBORw0KGgoAAAANSUhEUgAA..." }
    ]
}
```

---

## 4. 音乐生成 (Music Generations)

支持通过豆包音乐能力生成歌曲。服务端会先创建音乐生成会话，再从会话结果中提取 `video_id`，并调用豆包音乐媒体接口换取可播放音频链接。

**接口地址**: `POST /v1/music/generations`

### 4.1 参数说明

| 参数 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `prompt` | 是 | 无 | 歌曲生成提示词。 |
| `model` | 否 | `doubao-music` | 音乐模型名称或已配置的模型 ID。 |
| `lyric` | 否 | 空字符串 | 已有歌词。留空时默认让 AI 写词。 |
| `theme` | 否 | 空字符串 | 主题或参考风格，例如“流行”“民谣”“某某风格”。 |
| `mood` | 否 | `Happy` | 情绪，例如 `Happy`、`Sad`。 |
| `genre` | 否 | `Pop` | 曲风，例如 `Pop`、`Rock`、`Folk`。 |
| `gender` | 否 | `Female` | 音色，例如 `Female`、`Male`。 |
| `generation_type` | 否 | 自动判断 | 留空时，`lyric` 为空使用 `AI_lyric`，否则使用 `text_to_music`。 |
| `stream` | 否 | `false` | 是否以 SSE 形式返回。 |
| `auto_delete` | 否 | `true` | 生成完成并拿到结果后是否删除豆包会话；如需保留会话，传 `false`。 |

### 4.2 请求示例

```json
{
    "model": "doubao-music",
    "prompt": "创作一首流行歌曲，表达快乐的情绪，使用女声演唱",
    "theme": "流行音乐",
    "mood": "Happy",
    "genre": "Pop",
    "gender": "Female",
    "auto_delete": true,
    "stream": false
}
```

最小请求只需要 `prompt`：

```json
{
    "prompt": "写一首轻快的流行歌曲"
}
```

### 4.3 响应示例

```json
{
    "id": "38423666951945218",
    "model": "doubao-music",
    "object": "chat.completion",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "音乐 1\n音频链接: https://example.com/audio.mp4",
                "music": [
                    {
                        "video_id": "v0369cg10004d7o0i5qljhtdtlgsl3qg",
                        "url": "https://example.com/audio.mp4",
                        "cover": ""
                    }
                ]
            },
            "finish_reason": "stop"
        }
    ],
    "created": 1777338653,
    "usage": {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0
    }
}
```

### 4.4 超时与重试

音乐生成会轮询最多 2 分钟。如果 2 分钟内没有拿到有效音频链接，服务端会按 `RETRY_GENERATION_EMPTY` 处理，外层路由会进行重试。多次重试仍失败时返回错误。

---

## 5. 异步图片/视频/音乐生成与本地保存

异步接口会立即返回任务 ID，服务端在后台调用原有图片/视频/音乐生成逻辑。生成成功后会自动下载结果文件到本地：

- 图片：`data/media/images/`
- 视频：`data/media/videos/`
- 音乐：`data/media/music/`
- 任务记录：`data/media/tasks.json`

原有同步和流式接口保持不变。

### 5.1 异步图片生成

**接口地址**: `POST /v1/images/generations/async`

**请求参数**与 `POST /v1/images/generations` 基本一致，`stream` 会被服务端强制按 `false` 处理。

#### 4.1.1 参数说明

| 参数 | 适用场景 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | 文生图、图生图、多图图生图 | 是 | 无 | 图片模型名称或已配置的模型 ID，例如 `Seedream 4.0`、`doubao-image`。 |
| `prompt` | 文生图、图生图、多图图生图 | 是 | 无 | 生成提示词。 |
| `image` | 图生图、多图图生图 | 图生图时必填；文生图不填 | 无 | 单图传字符串，多图传字符串数组。字符串支持 URL 或 Base64 Data URL。 |
| `ratio` | 文生图、图生图、多图图生图 | 否 | 文生图默认 `1:1`；图生图不传时会尝试按第一张参考图尺寸自动推断，推断失败则 `1:1` | 图片比例，例如 `1:1`、`16:9`、`9:16`。 |
| `size` | 文生图、图生图、多图图生图 | 否 | 无 | 兼容 OpenAI 参数；如果同时传 `size` 和 `ratio`，优先使用 `size` 作为比例值。 |
| `style` | 文生图、图生图、多图图生图 | 否 | `auto` | 图片风格。 |
| `auto_delete` | 文生图、图生图、多图图生图 | 否 | `true` | 生成完成并拿到结果后是否删除豆包会话。 |
| `stream` | 文生图、图生图、多图图生图 | 否 | 强制 `false` | 异步接口不走流式返回，即使传入也会按非流式处理。 |

#### 4.1.2 异步文生图

**最小请求**:
```json
{
  "model": "Seedream 4.0",
  "prompt": "一张未来城市夜景，电影感，高细节"
}
```

**完整请求示例**:
```json
{
  "model": "Seedream 4.0",
  "prompt": "一张未来城市夜景，电影感，高细节",
  "ratio": "16:9",
  "style": "auto",
  "auto_delete": true
}
```

#### 4.1.3 异步图生图（单图参考）

**最小请求**:
```json
{
  "model": "Seedream 4.0",
  "prompt": "把这张图改成写实电影海报风格，保留主体结构",
  "image": "https://example.com/original.jpg"
}
```

**完整请求示例**:
```json
{
  "model": "Seedream 4.0",
  "prompt": "把这张图改成写实电影海报风格，保留主体结构",
  "image": "https://example.com/original.jpg",
  "ratio": "1:1",
  "style": "auto",
  "auto_delete": true
}
```

#### 4.1.4 异步多图图生图

**最小请求**:
```json
{
  "model": "Seedream 4.0",
  "prompt": "融合两张参考图的主体与色彩，生成一张统一风格的新图",
  "image": [
    "https://example.com/reference-1.jpg",
    "https://example.com/reference-2.jpg"
  ]
}
```

**完整请求示例**:
```json
{
  "model": "Seedream 4.0",
  "prompt": "融合两张参考图的主体与色彩，生成一张统一风格的新图",
  "image": [
    "https://example.com/reference-1.jpg",
    "https://example.com/reference-2.jpg"
  ],
  "ratio": "16:9",
  "style": "auto",
  "auto_delete": true
}
```

`image` 支持 URL、Base64 Data URL；多图时传字符串数组。

**提交响应示例**:
```json
{
  "code": 0,
  "message": "OK",
  "data": {
    "task_id": "media-1763985200000-a1b2c3d4",
    "status": "queued",
    "query_url": "/v1/generations/tasks/media-1763985200000-a1b2c3d4"
  }
}
```

### 5.2 异步视频生成

**接口地址**: `POST /v1/video/generations/async`

**请求参数**与 `POST /v1/video/generations` 基本一致，`stream` 会被服务端强制按 `false` 处理。

#### 4.2.1 参数说明

| 参数 | 适用场景 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | 文生视频、图生视频、多图图生视频 | 是 | 无 | 视频模型名称，可选：`sdmini` / `seedance_v2.0_mini`（Seedance 2.0 Mini），或 `sdfast` / `seedance_v2.0` / `seedance_v2.0_std`（Seedance 2.0 标准版）。 |
| `prompt` | 文生视频、图生视频、多图图生视频 | 是 | 无 | 视频生成提示词。 |
| `duration` | 文生视频、图生视频、多图图生视频 | 是 | 无 | 视频生成时长（秒），例如 `10`。 |
| `image` | 图生视频、多图图生视频 | 图生视频时必填；文生视频不填 | 无 | 单图传字符串，多图传字符串数组。字符串支持 URL 或 Base64 Data URL。 |
| `ratio` | 文生视频、图生视频、多图图生视频 | 否 | `16:9` | 视频比例。 |
| `auto_delete` | 文生视频、图生视频、多图图生视频 | 否 | `false` | 生成完成并拿到结果后是否删除豆包会话。 |
| `stream` | 文生视频、图生视频、多图图生视频 | 否 | 强制 `false` | 异步接口不走流式返回，即使传入也会按非流式处理。 |

#### 4.2.2 异步文生视频

**请求示例**:
```json
{
  "model": "sdmini",
  "prompt": "海浪拍打沙滩，夕阳西下，镜头缓慢推进",
  "ratio": "16:9",
  "duration": 10,
  "auto_delete": false
}
```

#### 4.2.3 异步图生视频（单图参考）

**请求示例**:
```json
{
  "model": "sdmini",
  "prompt": "让画面动起来，镜头缓慢推进，主体保持清晰",
  "image": "https://example.com/start-frame.jpg",
  "ratio": "16:9",
  "duration": 10,
  "auto_delete": false
}
```

#### 4.2.4 异步多图图生视频

**请求示例**:
```json
{
  "model": "sdmini",
  "prompt": "参考多张图片的主体和氛围生成视频，镜头缓慢推进",
  "image": [
    "https://example.com/start-frame-1.jpg",
    "https://example.com/start-frame-2.jpg"
  ],
  "ratio": "16:9",
  "duration": 10,
  "auto_delete": false
}
```

视频的 `image` 支持单个字符串或字符串数组，字符串可为 URL 或 Base64 Data URL。

**提交响应示例**:
```json
{
  "code": 0,
  "message": "OK",
  "data": {
    "task_id": "media-1763985200000-v9x8y7z6",
    "status": "queued",
    "query_url": "/v1/generations/tasks/media-1763985200000-v9x8y7z6"
  }
}
```

### 5.3 异步音乐生成

**接口地址**: `POST /v1/music/generations/async`

**请求参数**与 `POST /v1/music/generations` 基本一致，`stream` 会被服务端强制按 `false` 处理。

#### 5.3.1 参数说明

| 参数 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `prompt` | 是 | 无 | 歌曲生成提示词。 |
| `model` | 否 | `doubao-music` | 音乐模型名称或已配置的模型 ID。 |
| `lyric` | 否 | 空字符串 | 已有歌词。留空时默认让 AI 写词。 |
| `theme` | 否 | 空字符串 | 主题或参考风格。 |
| `mood` | 否 | `Happy` | 情绪。 |
| `genre` | 否 | `Pop` | 曲风。 |
| `gender` | 否 | `Female` | 音色。 |
| `generation_type` | 否 | 自动判断 | 留空时，`lyric` 为空使用 `AI_lyric`，否则使用 `text_to_music`。 |
| `auto_delete` | 否 | `true` | 生成完成并拿到结果后是否删除豆包会话；如需保留会话，传 `false`。 |
| `stream` | 否 | 强制 `false` | 异步接口不走流式返回。 |

#### 5.3.2 请求示例

```json
{
  "model": "doubao-music",
  "prompt": "创作一首流行歌曲，表达快乐的情绪，使用女声演唱",
  "theme": "流行音乐",
  "mood": "Happy",
  "genre": "Pop",
  "gender": "Female",
  "auto_delete": true
}
```

最小请求：

```json
{
  "prompt": "写一首轻快的流行歌曲"
}
```

#### 5.3.3 提交响应示例

```json
{
  "code": 0,
  "message": "OK",
  "data": {
    "task_id": "media-1763985200000-a1b2c3d4",
    "status": "queued",
    "query_url": "/v1/generations/tasks/media-1763985200000-a1b2c3d4"
  }
}
```

生成成功后，任务查询结果中的 `media` 会包含本地保存后的音乐文件，`local_url` 形如：

```text
/v1/generations/media/music/media-1763985200000-a1b2c3d4-1.mp4
```

音乐生成内部最多轮询 2 分钟；2 分钟内没有拿到有效音频链接会按失败处理并触发重试。

### 5.4 查询异步任务

**接口地址**: `GET /v1/generations/tasks/{task_id}`

**POST 查询接口**: `POST /v1/generations/tasks/query`

```json
{
  "task_id": "media-1763985200000-a1b2c3d4"
}
```

**NewAPI 兼容查询方式**:

如果 NewAPI 无法发起 `GET` 或自定义查询路径，可以继续走标准图片生成路径：

```http
POST /v1/images/generations
```

请求体：

```json
{
  "model": "async-task-query",
  "task_id": "media-1763985200000-a1b2c3d4",
  "stream": false
}
```

如果调用端不方便传额外字段，也可以把任务 ID 放在 `prompt` 字段：

```json
{
  "model": "async-task-query",
  "prompt": "media-1763985200000-a1b2c3d4",
  "stream": false
}
```

NewAPI 渠道的 Base URL 仍然填写到 `/v1`，例如：

```text
http://你的服务地址:5566/v1
```

**提交任务返回** 和 **查询任务返回** 不是同一种结构：

- 提交任务：只返回 `task_id`、`status`、`query_url`
- 查询任务：只返回任务状态、错误信息和媒体链接，不返回完整上游结果，避免响应体过大

**状态说明**:
- `queued`: 已创建，等待后台执行
- `running`: 正在生成或下载本地文件
- `succeeded`: 已完成
- `failed`: 失败，查看 `error`

**查询响应示例**:
```json
{
  "code": 0,
  "message": "OK",
  "data": {
    "task_id": "media-1763985200000-a1b2c3d4",
    "type": "image",
    "status": "succeeded",
    "error": null,
    "media": [
      {
        "type": "image",
        "url": "https://p3-flow-imagex-sign/1.jpg",
        "local_url": "/v1/generations/media/images/media-1763985200000-a1b2c3d4-1.jpg",
        "local_path": "data/media/images/media-1763985200000-a1b2c3d4-1.jpg",
        "filename": "media-1763985200000-a1b2c3d4-1.jpg",
        "size": 123456,
        "mime_type": "image/jpeg"
      }
    ]
  }
}
```

视频任务的 `media` 结构相同，`type` 为 `video`，`local_url` 形如：

```text
/v1/generations/media/videos/media-1763985200000-v9x8y7z6-1.mp4
```

不建议返回 Base64：Base64 会比二进制文件大约多 33% 体积，并增加服务端内存和 CPU 消耗。返回 `local_url` 下载链接更省资源。

### 5.5 清理本地媒体文件

后台 Web 端“危险区域”新增“清理本地媒体文件”按钮，也可以直接调用管理接口。

**接口地址**: `POST /admin/media/clear`

**鉴权**: 需要 `Authorization: Bearer [ADMIN_PASSWORD]`

**说明**: 删除 `data/media/images/`、`data/media/videos/`、`data/media/music/` 下的文件，并清空 `data/media/tasks.json` 任务记录。

---

## 6. 获取可用模型 (List Models)

获取当前系统中所有可用的模型列表，包括文本、图片、视频以及音乐生成模型。

**接口地址**: `GET /v1/models`

**响应示例**:
```json
{
  "data": [
    { "id": "doubao", "object": "model", "owned_by": "doubao-free-api" },
    { "id": "doubao-video", "object": "model", "owned_by": "doubao-free-api" },
    { "id": "doubao-music", "object": "model", "owned_by": "doubao-free-api" },
    { "id": "doubao-image", "object": "model", "owned_by": "doubao-free-api" },
    { "id": "Seedream 4.0", "object": "model", "owned_by": "doubao-free-api" },
    { "id": "Seedream 4.2", "object": "model", "owned_by": "doubao-free-api" },
    { "id": "Seedream 4.5", "object": "model", "owned_by": "doubao-free-api" }
  ]
}
```

**模型选择建议**:
- **图片生成**: 默认使用 `doubao-image` (即 Seedream 4.0)。若需使用新版本，请求时将 `model` 设置为 `Seedream 4.2` 或 `Seedream 4.5` 即可。
- **视频生成**: 默认使用 `doubao-video`。
- **音乐生成**: 默认使用 `doubao-music`。

---

## 7. Session 状态检查 (Token Check)

检查指定的 SessionID (Token) 是否仍然存活（有效）。

**接口地址**: `POST /token/check`

**请求参数**:
- `token`: 需要检查的 SessionID。

**请求示例**:
```json
{
    "token": "your-session-id-here"
}
```

**响应示例**:
```json
{
    "live": true
}
```

---

## 8. 工具与管理 (Utilities)

### 8.1 健康检查 (Ping)
- **地址**: `GET /ping`
- **响应**: `"pong"`

### 8.2 版本查询
- **地址**: `GET /admin/version`
- **响应**: `{"version": "4.2"}`

### 8.3 远程重启 (Restart)
- **地址**: `POST /admin/restart`
- **说明**: 远程强制重启服务进程。此操作会延迟 1 秒后执行 `process.exit(0)`，需配合 Docker 的 `--restart always` 或 PM2 等进程守护工具使用。
- **鉴权**: 需在 Header 中设置 `Authorization: Bearer [ADMIN_PASSWORD]`。

**请求示例**:
```http
POST /admin/restart
Authorization: Bearer your_admin_password
```

**响应示例**:
```json
{
    "message": "Restarting service..."
}
```

---

## 9. 错误处理 (Error Handling)

当接口返回非 200 状态码时，会返回统一的错误 JSON 格式。

**组件结构**:
- `code`: 系统内部错误码或 API 业务错误码（如 `-2001`）。
- `message`: 详细的错误描述。
- `statusCode`: 建议的 HTTP 状态码。

**响应示例**:
```json
{
    "code": -2001,
    "message": "[请求doubao失败]: 内容安全检测未通过",
    "data": null,
    "statusCode": 500
}
```

> [!TIP]
> 如果您在使用账号池 (`pooled`) 时遇到错误，系统会自动尝试更换账号重试（最多 3 次），直到返回成功或达到重试上限。
