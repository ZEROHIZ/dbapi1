# Solve Doubao Session Inactivity (Bug 17) via Fingerprint Browser

## Goal Description
当前项目遇到的 **Bug 17: `-2001` 错误 (Session Keep-Alive)**，核心问题不是单纯的 Cookie 过期，而是豆包服务端会结合前端页面行为判断 Session 是否“近期在真实浏览器环境中活跃过”。

现有实现只是定时请求接口，无法触发前端页面中的完整执行链路，因此即使 `sessionid` 仍然有效，也可能因为“长期没有浏览器侧活跃”而触发 `-2001`。

结合已知现象:
- 使用比特浏览器重新打开豆包页面后，账号在一段时间内可以恢复调用。
- 这说明“打开过真实页面”本身很可能就是关键条件之一。

因此，这个方案的目标不是“凭空修复失效会话”，而是：
- 先准备一个可被自动化控制的指纹浏览器环境；
- 再验证“打开豆包页面一次，是否能在接下来的一段时间内恢复 API 可用性”；
- 只有验证通过后，才把浏览器保活正式并入服务端定时任务。

## Technical Direction
计划采用 **[`adryfish/fingerprint-chromium`](https://github.com/adryfish/fingerprint-chromium)** 作为底层浏览器内核，并通过 `puppeteer-core` 驱动。

选择它的原因：
1. 上游直接提供 Windows ZIP、Windows 安装包、Linux `tar.xz` 和 AppImage 发布物，适合本地和服务器环境落地。
2. 支持 `--fingerprint` 参数，以及新版本提供的 `--disable-spoofing=...` 细粒度参数，便于后续试验不同指纹策略。
3. 我们只需要“自动打开豆包页面并挂载会话”，不需要像 Ant Browser 那样的桌面管理界面。

## Implementation Strategy

### Phase 0: Prepare Browser Runtime First
在任何代码集成之前，先把浏览器本体准备好。

针对当前环境补充说明：
- 你的宿主机是 Windows，但当前项目的 Docker 运行时仍然是 Linux 容器。
- 这意味着“最终可用”的安装目标应当是 **Linux 版 `fingerprint-chromium`**。
- Windows 版浏览器只适合作为宿主机上的辅助验证手段，不能代替容器内验证。

新增内容：
- [NEW] `scripts/setup-fingerprint-chromium.ps1`
  - 自动获取 GitHub 最新 release。
  - 在 Windows 开发机下载 `windows_x64.zip`。
  - 解压到仓库本地缓存目录，例如 `.cache/fingerprint-chromium/<version>/`。
  - 输出可执行文件路径，供后续 POC 和正式集成使用。
- [NEW] `scripts/setup-fingerprint-chromium.sh`
  - 自动获取 GitHub 最新 release。
  - 在 Linux / Docker 环境下载 `x86_64_linux.tar.xz`。
  - 解压到仓库本地缓存目录，例如 `.cache/fingerprint-chromium/<version>/`。
  - 输出 Linux 可执行文件路径，供容器内 POC 使用。

说明：
- 这一步是“先安装，再测试”，不再跳过环境准备直接写集成代码。
- 仓库内只保留安装脚本，不提交浏览器二进制。

### Phase 1: Do a Focused POC Before Integration
在确认浏览器可启动后，先做单点验证，不直接改生产保活逻辑。

新增内容：
- [NEW] `scripts/verify-browser-keepalive.ts`
  - 通过 `puppeteer-core` 指定 `executablePath` 启动 `fingerprint-chromium`。
  - 打开 `https://www.doubao.com/chat/`。
  - 注入指定账号的 `sessionid` / `sessionid_ss` Cookie。
  - 等待页面稳定加载，必要时补充短暂驻留时间，确保前端逻辑有机会执行。
  - 输出页面加载结果、关键响应状态、保活完成时间点。

POC 目标：
- 验证“打开豆包页面一次”是否真的能让该账号在之后一段时间内恢复 API 可用性。
- 验证是否必须使用有界面模式，还是 `headless` 也能达到同样效果。

### Phase 2: Integrate Only After POC Passes
如果 POC 通过，再把浏览器逻辑并入正式服务。

新增内容：
- [NEW] `src/lib/browser-manager.ts`
  - 统一管理 `puppeteer-core` 和浏览器生命周期。
  - 维护单例 Browser 实例，而不是每个账号开一个进程。
  - 为每次保活创建独立 Page，并按队列串行处理账号，避免内存失控。
  - 允许配置启动参数，例如 `--fingerprint`、`--disable-spoofing=gpu`。

修改内容：
- [MODIFY] `src/lib/account-manager.ts`
  - 替换当前仅靠 HTTP GET 的 `keepAliveAccount` 实现。
  - 保留现有 `checkAccountHealth` 作为轻量健康检查，不和浏览器保活混为一谈。
  - 在 `keepAliveAllAccounts()` 中调用 `BrowserManager` 串行执行真实页面保活。

- [MODIFY] `package.json`
  - 增加 `puppeteer-core` 依赖。

### Phase 3: Deployment and Container Support
浏览器集成稳定后，再处理部署侧问题。

修改内容：
- [MODIFY] `Dockerfile`
  - 当前运行时镜像是 `node:lts-alpine`，浏览器兼容性风险高。
  - 优先评估切换到 Debian/Ubuntu slim 运行时镜像。
  - 明确补齐 Chromium 运行依赖，而不是把 Alpine 兼容留作隐含前提。

新增配置项：
- `browserExecutablePath`
- `browserHeadless`
- `browserTimeoutMs`
- `browserKeepAliveEnabled`
- `browserLaunchArgs`

## Current Repository Mapping
当前需要替换或补充的关键位置：
- 现有保活逻辑在 `src/lib/account-manager.ts` 的 `keepAliveAllAccounts()` / `keepAliveAccount()`。
- 当前只做 HTTP 请求探活，没有真实浏览器访问。
- 当前 `Dockerfile` 使用 `node:lts-alpine`，这会成为后续浏览器运行的部署风险点。

## Verification Plan

### Step 1: Runtime Preparation Verification
1. 如果在宿主机临时验证，执行 `scripts/setup-fingerprint-chromium.ps1`。
2. 如果走 Docker 或容器内真实链路，执行 `scripts/setup-fingerprint-chromium.sh`。
3. 确认浏览器已下载并解压成功。
4. 记录最终可执行文件路径。

### Step 2: POC Verification
1. 使用当前仍有效、但容易在闲置后触发 `-2001` 的 `sessionid`。
2. 运行 `scripts/verify-browser-keepalive.ts`，让浏览器真实打开豆包页面。
3. 记录“打开页面完成”的绝对时间。
4. 在此之后通过 API 发起请求，观察 `-2001` 是否消失，以及恢复窗口持续多久。
5. 分别验证有界面模式和无头模式，确定最终运行策略。

### Step 3: Integration Verification
1. 将 POC 逻辑接入正式 `keepAlive` 定时任务。
2. 观察多个账号顺序保活时的内存占用和耗时。
3. 验证在保活执行后的若干分钟内，账号是否持续可用。

## Decision Rule
只有当 POC 明确证明“真实打开豆包页面”可以稳定延缓或消除 `-2001` 时，才继续做正式集成。

如果 POC 失败，则停止在主服务内集成，转而重新评估：
- 是否必须使用有界面模式；
- 是否需要保留浏览器常驻，而不是短开短关；
- 是否还需要补充其他页面动作，而不只是打开 `/chat/`。
