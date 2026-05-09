# 浏览器登录式账号管理方案

## 目标
把当前“手填 `sessionid`”的账号接入方式，升级为“浏览器档案登录式”账号管理：
- 每个账号对应一个独立浏览器档案
- 可从后台手动打开指定浏览器档案进行登录
- 后台表格展示该档案的指纹/设备信息
- 支持 12 小时一次测活
- 为后续把真实浏览器态同步回 API 调用链路提供数据基础

## 背景结论
已有验证表明：
- “向新浏览器注入 `sessionid`”可以打开页面，但不能保证服务端生图成功
- “浏览器真实打开后”会生成额外 Cookie、本地存储和设备标识
- 服务端当前请求链路只使用 `sessionid + 随机 deviceId/webId`，与真实登录档案不一致

因此，新方案要把“浏览器档案”提升为一等实体，而不是继续围绕 `sessionid` 打补丁。

## 产品形态

### 后台新增页面
建议在现有 `public/admin.html` 中新增一个页面分区：
- 页面名：`浏览器账号`
- 导航位置：与“账号”“模型”“设置”并列

### 列表表格字段
每条浏览器账号建议展示：
- 账号名称
- 档案 ID
- 浏览器类型
- 档案路径
- 登录状态
- 最近测活结果
- 最近测活时间
- `sessionid` 摘要
- `web_id`
- `device_id`
- `ttwid` 摘要
- `sid_guard` 摘要
- `uid_tt` 摘要
- 指纹摘要
- 备注

### 每行操作
- `打开浏览器`
- `查看指纹`
- `刷新状态`
- `立即测活`
- `禁用/启用`
- `删除档案`

## 核心设计

### 1. 浏览器账号实体
建议新增 `BrowserProfileAccount` 概念，可先复用 `accounts.json` 扩展字段，后续再拆独立文件。

建议新增字段：
- `authMode`: `manual_browser_login | sessionid_only`
- `browserProfileId`
- `browserUserDataDir`
- `browserExecutablePath`
- `browserType`
- `browserFingerprint`
- `browserFingerprintSeed`
- `browserCookies`
- `browserStorageState`
- `lastBrowserOpenAt`
- `lastProbeAt`
- `lastProbeResult`
- `lastProbeError`
- `lastLoginDetectedAt`
- `sessionIdSource`

其中：
- `browserCookies` 保存必要 Cookie 快照
- `browserStorageState` 保存必要 localStorage/sessionStorage 快照
- `browserFingerprint` 存储后台可展示的摘要信息，而不是只存原始 JSON

### 2. 浏览器档案目录策略
每个账号一个固定目录，例如：
- `.cache/fingerprint-chromium/profiles/<profile-id>/`

要求：
- 后台“打开浏览器”始终复用同一目录
- 不再通过临时浏览器注入登录态
- 手动登录一次后，后续打开应自动带出原状态

### 3. 测活策略
12 小时一次，默认串行执行。

测活分两层：
- 轻量层：读取本地档案状态，检查是否仍有关键 Cookie
- 实际层：复用该档案打开豆包页面，等待页面稳定，再抓取关键状态

测活结果至少记录：
- 是否可进入登录后页面
- 是否拿到关键 Cookie
- 是否拿到 `web_id`
- 是否返回账号信息
- 如果失败，失败阶段和错误摘要

### 4. 指纹信息展示
后台不需要展示全部低层参数，但应展示能帮助定位问题的摘要：
- 浏览器版本
- User-Agent
- `navigator.webdriver`
- 屏幕尺寸 / 窗口尺寸
- `web_id`
- `device_id`
- `ttwid` 是否存在
- `sid_guard` 是否存在
- localStorage 关键键列表

指纹详情建议支持弹窗查看 JSON。

## 后端实施计划

### A. 账号模型扩展
修改：
- `src/lib/account-manager.ts`

新增职责：
- 保存浏览器账号附加字段
- 提供获取/更新浏览器档案状态的方法
- 记录测活时间和测活结果

### B. 浏览器管理器
新增：
- `src/lib/browser-profile-manager.ts`

职责：
- 按账号打开对应 `userDataDir`
- 支持“手动登录模式”
- 支持读取 Cookie / localStorage / 指纹摘要
- 支持最大化打开、前台显示
- 支持测活后回收进程

### C. 后台接口
修改：
- `src/api/routes/admin.ts`

建议新增接口：
- `GET /admin/browser-accounts`
- `POST /admin/browser-accounts`
- `POST /admin/browser-accounts/:id/open`
- `POST /admin/browser-accounts/:id/probe`
- `GET /admin/browser-accounts/:id/fingerprint`
- `POST /admin/browser-accounts/:id/sync-state`
- `DELETE /admin/browser-accounts/:id`

### D. 定时任务
可先放在：
- `AccountManager.init()`

建议新增：
- `browserProbeIntervalHours`
- 默认值 `12`

## 前端实施计划

### 页面结构
在 `public/admin.html` 中新增：
- 导航项 `浏览器账号`
- 列表表格区
- 指纹详情弹窗
- 新建/编辑档案弹窗

### 交互流

#### 新增账号
1. 点击“新增浏览器账号”
2. 填写名称、备注、浏览器路径
3. 系统生成 `profile-id` 和档案目录
4. 保存后可点击“打开浏览器”

#### 手动登录
1. 点击“打开浏览器”
2. 系统以前台方式打开对应浏览器档案
3. 用户手动登录豆包
4. 回到后台点击“刷新状态”或“立即测活”
5. 系统抓取并展示当前关键状态

#### 测活
1. 点击“立即测活”
2. 后台复用该档案打开豆包页面
3. 抓取关键状态并更新列表

## 风险与注意事项

### 风险 1：账号与机器绑定
已有现象表明，登录态可能和具体机器/档案/设备态绑定。
结论：
- 同一个账号不能假设可在任意机器上直接复用
- 后续需要把“这台机器上的登录档案”作为状态源

### 风险 2：当前单文件后台页面复杂度过高
`public/admin.html` 已较大，继续追加功能会增加维护成本。
建议：
- 本轮先在单文件中增量实现
- 若功能继续扩张，再拆分后台前端结构

### 风险 3：生产环境与本机环境差异
当前先以 Windows 本机档案方案为主。
后续需要单独确认：
- 生产 Docker 是否实际跑 Windows 容器
- 浏览器是否也应运行在宿主机而非容器内

## 推荐实施顺序
1. 扩展账号数据模型，支持浏览器档案字段
2. 新建 `browser-profile-manager.ts`
3. 新增后台接口：创建档案、打开浏览器、立即测活、查看指纹
4. 在 `admin.html` 新增“浏览器账号”页面和表格
5. 跑通“手动登录 -> 刷新状态 -> 立即测活”
6. 再把真实浏览器态接入生图请求链路

## 验收标准
- 后台可创建多个浏览器账号档案
- 每个档案都可一键打开到对应浏览器
- 用户手动登录后，再次打开仍保留登录状态
- 后台表格能看到关键指纹与状态摘要
- 12 小时测活任务能执行并更新结果
- 后续生图请求可基于该浏览器档案继续验证是否恢复可用
