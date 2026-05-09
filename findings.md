# 发现记录

## 2026-05-09

### 1. 仅注入 `sessionid` 不足以复用浏览器态
- 通过 `sessionid`/`sessionid_ss` 注入到新浏览器环境，可以打开豆包页面
- 但服务端仅带 `sessionid` 发起生图请求，仍然会触发 `-2001`
- 说明校验至少还涉及设备态、浏览器档案态或额外 Cookie/本地存储

### 2. 浏览器真实打开后会生成更多状态
- Cookie 层：
  - `ttwid`
  - `sid_guard`
  - `uid_tt`
  - `uid_tt_ss`
  - `s_v_web_id`
  - `session_tlb_tag`
  - `odin_tt`
- 存储层：
  - `samantha_web_web_id`
  - `flow_tea_user_id`
  - `__tea_session_id_497858`
  - `xmst`
  - `__msuuid__`

### 3. 自动化标记可以弱化，但不是根因
- 去掉 `--enable-automation`
- 增加 `--disable-blink-features=AutomationControlled`
- 注入 `navigator.webdriver = undefined`
- 有头模式可强制最大化
- 即便如此，服务端单带 `sessionid` 生图仍失败

### 4. 更合理的方向是“浏览器档案登录”
- 用户反馈比特浏览器中手动登录后，后续只需正常打开浏览器即可
- 这更符合“浏览器档案维持状态”的模型，而不是“会话值注入”的模型

### 5. 当前仓库已有可复用基础
- 后台页面：`public/admin.html`
- 后台接口：`src/api/routes/admin.ts`
- 账号持久化：`data/accounts.json`
- 现有账号字段已包含：
  - `deviceId`
  - `webId`
  - `userId`
- 但没有浏览器档案路径、指纹摘要、最近测活结果、浏览器类型等字段

### 6. 同一份账号数据即可承载浏览器档案元信息
- 不需要额外新建第二份持久化文件，也可以先在现有账号结构上扩展浏览器档案字段
- 这样后续把浏览器真实登录态接回请求链时，迁移成本更低
- 为兼容历史数据，`accounts.json` 需要同时支持：
  - 旧版纯数组结构
  - 新版对象结构（当前已实现为 `{ accounts: [...] }`）

### 7. 浏览器账号应先与现有调度池隔离
- 在“真实浏览器态接入请求链”完成前，浏览器账号如果直接进入当前调度池，会退回到仅 `sessionid + deviceId/webId` 的旧调用方式
- 这会造成“后台显示已登录，但实际调用仍失败”的误导
- 因此本轮实现中，浏览器账号只负责：
  - 持久化档案管理
  - 手动打开登录
  - 状态同步
  - 定时/手动探活
