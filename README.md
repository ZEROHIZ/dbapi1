# Doubao AI Free 服务

[![](https://img.shields.io/github/license/llm-red-team/doubao-free-api.svg)](LICENSE)
![](https://img.shields.io/github/stars/llm-red-team/doubao-free-api.svg)
![](https://img.shields.io/github/forks/llm-red-team/doubao-free-api.svg)
![](https://img.shields.io/docker/pulls/vinlic/doubao-free-api.svg)

支持高速流式输出、支持多轮对话、支持联网搜索、支持文生图（已支持）、支持图生图（已支持）、支持图文解读（已支持），零配置部署，多路token支持，自动清理会话痕迹。

与OpenAI接口完全兼容。

## 目录

* [免责声明](#免责声明)
* [接入准备](#接入准备)
  * [智能体接入](#智能体接入)
  * [多账号接入](#多账号接入)
* [Docker部署](#Docker部署)
  * [Docker-compose部署](#Docker-compose部署)
* [Render部署](#Render部署)
* [Vercel部署](#Vercel部署)
* [原生部署](#原生部署)
* [推荐使用客户端](#推荐使用客户端)
* [接口列表](#接口列表)
  * [对话补全](#对话补全)
  * [图文对话补全](#图文对话补全)
  * [文生图](#文生图)
  * [图生图](#图生图)
  * [sessionid存活检测](#sessionid存活检测)
* [注意事项](#注意事项)
  * [Nginx反代优化](#Nginx反代优化)
  * [Token统计](#Token统计)
* [Star History](#star-history)
  
## 免责声明

**逆向API是不稳定的，建议前往火山引擎官方 https://www.volcengine.com/product/doubao 付费使用API，避免封禁的风险。**

**本组织和个人不接受任何资金捐助和交易，此项目是纯粹研究交流学习性质！**

**仅限自用，禁止对外提供服务或商用，避免对官方造成服务压力，否则风险自担！**

**仅限自用，禁止对外提供服务或商用，避免对官方造成服务压力，否则风险自担！**

**仅限自用，禁止对外提供服务或商用，避免对官方造成服务压力，否则风险自担！**

## 接入准备

从 [豆包](https://www.doubao.com/) 获取sessionid

进入豆包登录账号，然后F12打开开发者工具，从Application > Cookies中找到`sessionid`的值，这将作为Authorization的Bearer Token值：`Authorization: Bearer sessionid`

![example0](./doc/example-0.png)

### 多账号管理与自动化轮询

项目现已支持 **可视化管理后台**。您不再需要每次请求都手动拼接长长的 Token 字符串。

1. **进入后台**：如果使用 Windows 启动脚本，访问 `http://你的IP:5566/admin`；如果你自行指定了端口，则按实际端口访问。
2. **添加账号**：在界面中录入 `sessionid`，并设置每个账号的生图、视频每日限额。
3. **启用池化**：调用 API 时，只需在 Header 中设置 `Authorization: Bearer pooled`，系统将自动在空闲且有额度的账号中进行轮询，并处理排队和冷却逻辑。

---

## Docker 部署

为了保证账号数据不丢失，**必须**将容器内的 `/app/data` 目录挂载到宿主机。

### 方式一：Docker Run

```shell
docker run -d \
  --init \
  --name doubao-free-api \
  -p 8000:8000 \
  -e TZ=Asia/Shanghai \
  -v $(pwd)/data:/app/data \
  --restart always \
  ghcr.io/zerohiz/dbapi:3.6
```

### 方式二：Docker-compose 部署 (推荐)

```yaml
version: '3'

services:
  doubao-free-api:
    container_name: doubao-free-api
    image: ghcr.io/zerohiz/dbapi:3.6
    restart: always
    ports:
      - "8000:8000"
    environment:
      - TZ=Asia/Shanghai
    volumes:
      - ./data:/app/data
```

Docker 镜像适合普通 API 服务部署。浏览器档案的“打开浏览器手动登录”功能需要宿主 Windows 桌面会话，Docker/Linux/WSL/无桌面服务器环境不支持后台一键弹出可视浏览器。

### Windows 源码运行说明

如果是在 Windows 上直接 `git clone` 源码运行，仓库里**不会自带浏览器二进制**，也**不会在启动服务时自动下载**。

推荐直接使用仓库根目录的启动脚本，它会在**首次运行时自动下载** `fingerprint-chromium`，后续复用本地缓存，并以前台方式启动服务：

```bat
start-windows-5566.bat
```

启动后默认访问地址：

```text
http://127.0.0.1:5566/
http://127.0.0.1:5566/admin
```

需要先手动下载一次 `fingerprint-chromium`，推荐直接执行仓库自带脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-fingerprint-chromium.ps1
```

下载完成后，程序会优先自动查找 `.cache/fingerprint-chromium/**/chrome.exe`；如果你放在别的位置，也可以在后台“系统设置”里填写 `browserExecutablePath`。

浏览器账号的手动登录流程请使用 Windows 宿主机直接运行本项目。Docker、Linux 服务器、WSL 或 Windows Service 这类无桌面会话环境只能跑普通 API 服务，不支持“打开浏览器”按钮。

---

## 平台部署注意事项

### Render 部署
Render 支持持久化磁盘（Disks）。如果您在 Render 部署，请为其挂载一个挂载路径为 `/app/data` 的 Disk，否则每次重启都会清空已添加的账号。

### Vercel 部署
**注意**：Vercel 是完全**无状态**的。虽然您可以部署成功，但通过 `/admin` 界面添加的账号在 Vercel 实例重启（通常几分钟一次）后会全部消失。建议 Vercel 用户仍使用传统的 Header 传参方式。

---

## 接口列表

### 鉴权 (Authentication)

* **池化模式 (推荐)**：使用管理员在后台配置的账号池。
  `Authorization: Bearer pooled`
* **手动模式**：使用请求中携带的 Token。
  `Authorization: Bearer [sessionid]`

### 对话补全
**POST /v1/chat/completions** (兼容 OpenAI)

### 绘图生成 (支持图生图)
**POST /v1/images/generations**

### 视频生成 (支持图生视频)
**POST /v1/video/generations** (详见 API_DOCUMENTATION.md)

### 图文对话补全
图文对话补全接口，与openai的 [chat-completions-api](https://platform.openai.com/docs/guides/text-generation/chat-completions-api) 兼容。

**POST /v1/chat/completions**

✨ 图文功能：支持发送图片进行多模态对话！

**请求数据（图片请求）：**
```json
{
  "model": "doubao",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "这张图片里有什么？"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "https://example.com/image.jpg"
          }
        }
      ]
    }
  ],
  "stream": false
}
```

**请求数据（Base64请求）：**
```json
{
  "model": "doubao",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "请描述这张图片"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/jpeg;base64,/9j/4AAQSkZJRg..."
          }
        }
      ]
    }
  ]
}
```

### 兼容格式：
```json
// 格式 1: image_url（OpenAI 标准格式）
{
  "type": "image_url",
  "image_url": {
    "url": "https://example.com/image.jpg"
  }
}

// 格式 2: image
{
  "type": "image",
  "image_url": "https://example.com/image.jpg"
}

// 格式 3: file
{
  "type": "file",
  "file_url": {
    "url": "https://example.com/image.jpg"
  }
}
```

**响应数据**：
```json
{
    // 如果想获得原生多轮对话体验，此id，你可以传入到下一轮对话的conversation_id来接续上下文
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

### 文生图

**POST** `/v1/images/generations`

**请求参数**:
```json
{
    "model": "Seedream 4.0", //模型
    "prompt": "机器猫", //提示词
    "ratio": "1:1", //比例
    "style": "卡通", //风格
    "stream": false //流式输出
}
```

**响应数据**：
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
                "content": "我将根据参考图生成一张1:1比例的卡通风格图片。\n\n以下是为你生成的图片：\n",
                "images": [
                    "https://p3-flow-imagex-sign/1.jpg",
                ]
            },
            "finish_reason": "stop"
        }
    ],
    "created": 1763985148
}
```

### 图生图

**POST** `/v1/images/generations`

**请求参数**:
```json
{
    "model": "Seedream 4.0", //模型
    "prompt": "机器猫", //提示词
    "image": "https://example.com/image.jpg",
    "ratio": "1:1", //比例
    "style": "卡通", //风格
    "stream": false //流式输出
}
```

**响应数据**：
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
                "content": "我将根据参考图生成一张1:1比例的卡通风格图片。以下是为你生成的图片：",
                "images": [
                    "https://p3-flow-imagex-sign/1.jpg",
                ]
            },
            "finish_reason": "stop"
        }
    ],
    "created": 1763985148
}
```

### sessionid存活检测

检测sessionid是否存活，如果存活live未true，否则为false，请不要频繁（小于10分钟）调用此接口。

**POST /token/check**

请求数据：
```json
{
    "token": "6750e5af32eb15976..."
}
```

响应数据：
```json
{
    "live": true
}
```

## 注意事项

### Nginx反代优化

如果您正在使用Nginx反向代理doubao-free-api，请添加以下配置项优化流的输出效果，优化体验感。

```nginx
# 关闭代理缓冲。当设置为off时，Nginx会立即将客户端请求发送到后端服务器，并立即将从后端服务器接收到的响应发送回客户端。
proxy_buffering off;
# 启用分块传输编码。分块传输编码允许服务器为动态生成的内容分块发送数据，而不需要预先知道内容的大小。
chunked_transfer_encoding on;
# 开启TCP_NOPUSH，这告诉Nginx在数据包发送到客户端之前，尽可能地发送数据。这通常在sendfile使用时配合使用，可以提高网络效率。
tcp_nopush on;
# 开启TCP_NODELAY，这告诉Nginx不延迟发送数据，立即发送小数据包。在某些情况下，这可以减少网络的延迟。
tcp_nodelay on;
# 设置保持连接的超时时间，这里设置为120秒。如果在这段时间内，客户端和服务器之间没有进一步的通信，连接将被关闭。
keepalive_timeout 120;
```

### Token统计

由于推理侧不在doubao-free-api，因此token不可统计，将以固定数字返回。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=LLM-Red-Team/doubao-free-api&type=Date)](https://star-history.com/#LLM-Red-Team/doubao-free-api&Date)
