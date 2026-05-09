# 进度日志

## 2026-05-09

### 已完成
- 安装并验证了 Windows 版 `fingerprint-chromium`
- 编写并迭代了 `scripts/verify-browser-keepalive.mjs`
- 验证了有头/无头模式都可打开真实豆包页面
- 验证了仅使用 `sessionid` 无法稳定支撑服务端生图请求
- 验证了浏览器真实打开后会生成更多 Cookie 和本地状态
- 按用户最新判断，切换到“手动登录浏览器档案”方案

### 当前结论
- 新浏览器 + 注入 `sessionid` 不是最终方案
- 需要引入“浏览器档案账号管理”

### 下一步
- 产出专项规划文档
- 设计新的账号字段与后台页面交互
- 规划浏览器打开、登录、指纹展示、12 小时测活流程

## 2026-05-09（执行）

### 新增完成
- 扩展了 `src/lib/account-manager.ts`，为浏览器档案账号增加持久化字段与定时探活入口。
- 新增 `src/lib/browser-profile-manager.ts`，支持：
  - 打开持久化浏览器档案
  - 抓取 Cookie / localStorage / sessionStorage 快照
  - 汇总指纹摘要
  - 对豆包账号信息接口做探活
- 扩展了 `src/api/routes/admin.ts`，新增浏览器账号后台接口。
- 扩展了 `public/admin.html`，新增“浏览器账号”页面、表格操作、弹窗和指纹详情查看。
- 在系统设置中增加：
  - 默认浏览器可执行文件路径
  - 浏览器探活周期（小时）

### 验证结果
- `npm run build` 通过
- 已对 `public/admin.html` 内联脚本做 `node --check` 语法检查，通过

### 暂留项
- 真实浏览器态尚未接入聊天/生图/视频/音乐请求链
- 浏览器账号目前仅用于档案管理、状态同步和探活，不进入现有调度池

## 2026-05-09（修复）

### 修复
- 修正浏览器账号创建逻辑：`manual_browser_login` 模式允许空 token 创建，不再返回空数组。
- 精简浏览器账号创建弹窗，只保留“账号名称”和“备注”，其余参数走默认值。
- 增加前端校验：账号名称为空时直接提示，不再发请求。

### 验证
- `npm run build` 通过
- `public/admin.html` 内联脚本语法检查通过

## 2026-05-09（浏览器路径与展示收口）

### 修复
- 修正浏览器可执行文件解析：
  - 空路径不再被错误解析成项目根目录
  - 如果路径为空或指向目录，会自动扫描 `.cache/fingerprint-chromium/**/chrome.exe`
  - `openProfile()` 现在会等待真实 `spawn` 成功，失败则直接报错，不再假成功
- 收窄浏览器账号前端展示：
  - 列表仅显示 `sessionid` 摘要
  - 去掉 `ttwid`、`sid_guard`、`uid_tt` 摘要
  - 指纹详情只返回按 `README-ZH.md` “指纹支持”整理后的支持项
- 扩展浏览器指纹采集：
  - `userAgent`
  - 操作系统 / 平台
  - 音频能力
  - 插件列表
  - CPU 核心数
  - 内存
  - WebGL 图像/元数据
  - 字体能力
  - Canvas 图像/文本能力
  - ClientRects 能力
  - WebRTC 能力
  - 语言支持
  - 时区支持

### 验证
- `npm run build` 通过
