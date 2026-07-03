# Bug 修复经验总结

## 1. 问题描述：账号泄露导致系统无限排队 (Account Leak)

在使用账号池（Pooled accounts）进行 API 请求时，发现系统运行一段时间后，所有请求都会卡在“等待队列”中，不再真正向大模型后端发送请求，后台日志持续显示 `[AccountManager] 暂无空闲账号，请求进入队列`。

## 2. 根本原因分析

在实现“跨账号重试逻辑”时，代码逻辑出现了 **重复锁定 (Double Lock)** 的错误：

```typescript
// --- 错误逻辑示意图 ---
// 1. 循环外锁定了一个账号
account = await AccountManager.acquireToken('chat'); 
isPooled = true;

while (attempt < maxRetries) {
    try {
        if (isPooled) {
            // 2. 循环内又锁定了一个账号（覆盖了上一个变量，但上一个账号在管理器中仍是 BUSY）
            account = await AccountManager.acquireToken('chat'); 
        }
        // ... 执行业务 ...
        // 3. 释放账号（只释放了最后锁定的那一个）
        AccountManager.releaseToken(account.token);
    } catch (err) {
        // ... 释放账号 ...
        AccountManager.releaseToken(account.token);
    }
}
```

每个请求都会锁定 2 个账号，但只会释放最后 1 个。这导致账号池中的账号数量迅速被耗尽，状态全部变为永久的 `BUSY`，从而引发系统性死锁。

## 3. 经验与教训

### A. 资源分配与释放必须成对且唯一
在编写涉及“资源池”（如数据库连接池、账号池、线程池）的代码时，必须严格检查 **Acquire (获取)** 和 **Release (释放)** 的配对关系。
- 尤其是在带有 `while` 或 `for` 的重试循环中，资源获取应**仅存在于循环内部**，或者在循环外获取后由循环多次复用（但不应在内外各获取一次）。

### B. 观察“状态机”异常
当发现系统出现“明明有资源却提示资源耗尽”的情况时，第一时间怀疑 **资源泄露 (Resource Leak)**。
- 本案例中，通过查看 `statusCounts` 发现 `idle` 为 0，而 `busy` 占据了所有账号，尽管当时并没有正在进行的请求。

### C. 谨慎对待状态覆盖
如果一个变量（如 `account`）被重新赋值，要检查旧值所代表的资源是否已经妥善处理。在异步操作中，这种覆盖往往是由于重构代码时未删除旧逻辑片段导致的。

## 4. 改进措施

- **代码审计**：在合并涉及资源操作的 PR 时，重点检查循环体的内外边界。
- **监控增强**：建议在管理后台增加一个“重置所有账号状态”的按钮，用于紧急情况下强制清除 `BUSY` 锁。
- **超时保护**：在 `AccountManager` 中，可以为 `BUSY` 状态设置一个“最大锁定时间”（TTL），如果超过 10 分钟未释放则自动强制释放。

---

## 5. 管理后台交互卡死与状态同步异常 (Admin UI Freeze)

### 问题现象
在“账号管理”页面点击“启动”或“停止”按钮后，页面操作逻辑发生紊乱：
1. 其他操作按钮（编辑、清除、暂停）变得无法点击。
2. 按钮状态（如从“启动”变为“停止”）需要手动刷新页面才能显示。
3. 统计分析页面在该操作后无法加载出数据。
4. 控制台报错 `ReferenceError: currentPageDesc is not defined`。

### 根本原因
1. **Vue 实例挂载崩溃**：在 `admin.html` 的 Vue 逻辑中，遗漏了某些响应式变量（如 `currentPageDesc`）的声明。由于 Vue 3 在遇到未定义变量引用时可能会中断渲染循环，导致后续的 UI 逻辑和生命周期挂钩无法正常执行。
2. **图标库冲突与 DOM 阻塞**：Lucide 图标库在动态渲染（特别是与 Vue 的 `v-html` 或频繁更新的列表结合）时，由于异步加载图标，可能会导致 DOM 重绘冲突，表现为 UI 线程瞬间阻塞，使用户感觉“卡死”。
3. **缺乏自动状态同步**：操作请求成功后，前端未主动触发 `fetchAccounts()` 或 `fetchStats()` 请求，导致本地数据与后端实际状态脱节。

### 经验与教训
- **Vue 开发规范**：所有在模板中使用的变量，必须在 `setup()` 或 `data` 中显式初始化，即使初始值为 `null` 或空字符串。
- **使用原生 SVG 替代字体/第三方图标库**：对于高频操作的 UI 界面，优先使用内嵌 SVG 字符串，以消除第三方库带来的副作用和渲染延迟。
- **操作后的主动刷新机制**：在执行完“启动/停止”等改变后端状态的操作后，务必在 `.then()` 回调中添加数据重刷逻辑，确保 UI 能够即时响应状态变更。
- **前端错误监控**：管理后台这类单页应用，一定要打开控制台查看是否有未捕获的 Reference Error，这通常是导致 UI 操作失效的首要原因。
83: ### 根本原因
84: 后端 `ModelManager` 仅提供了一个 `getModels()` 方法，该方法统一过滤了所有未启用的模型。管理后台路由直接复用了这个过滤后的方法，导致管理界面也只能看到“启用中”的模型。
85: 

---

## 6. 模型管理不可见性问题 (Model Management UI Visibility)

### 问题现象
当某个模型被禁用（`enabled: false`）后，在管理后台的模型列表中彻底消失，导致管理员无法找回或重新启用该模型。

### 根本原因
后端 `ModelManager` 仅提供了一个 `getModels()` 方法，该方法统一过滤了所有未启用的模型。管理后台路由直接复用了这个过滤后的方法，导致管理界面也只能看到“启用中”的模型。

### 经验与教训
- **区分业务数据与管理数据**：系统内部逻辑（如 AI 调用）应使用过滤后的“活跃”数据集，但管理界面（Admin UI）通常需要访问“全量”数据集以支持启用/禁用等状态转换操作。
- **状态可见性原则**：任何可以被禁用的实体，在管理系统里都必须有一个“查看已禁用”的入口，否则会造成数据“永久丢失”的错觉。

### 改进措施
- **后端接口分层**：将 `ModelManager` 的方法拆分为 `getEnabledModels()` (业务用) 和 `getAllModels()` (管理用)。
- **UI 交互优化**：在列表页增加“启用/禁用”一键开关和“状态筛选标签页”。

---

## Bug #5: 批量添加渠道时命名拆分错误

**日期**：2026-03-16

### 问题描述
批量添加多个 Token/Key 时，系统会将每个 Key 创建为独立的渠道并追加序号（如 `22-1`, `22-2`, `22-3`），而用户期望的是一个渠道 `22` 下包含多个 Key。

### 根本原因
`AccountManager.addAccount` 在批量模式下，将渠道名拼接了序号 (`${name}-${index}`)，导致每个 Key 看起来是独立渠道。缺少"备注"字段来区分同一渠道下的不同 Key。

### 修复方案
- 批量添加时，所有 Key **共享同一个渠道名称**，不再追加序号。
- 新增 `remark` 字段（如 `Key 1`, `Key 2`），用于区分同渠道下的不同 Key。
- 渠道列表中显示备注，方便用户识别。

### 经验与教训
- **层级关系要清晰**：渠道是逻辑分组单位，Key 是具体的认证凭据。不应将两者混为一谈。
- **批量操作要保持一致性**：批量创建的实体应共享父级属性（名称），而不是自动拆分为独立实体。

---

## Bug #6: Vue 3 响应式解构导致查询参数丢失

**日期**：2026-03-16

### 问题描述
在模型管理界面中，当用户修改“公开调用名”(Model ID) 并保存时，后端没有如期触发 ID 的修改，而是直接新增了一个模型，或者报错未找到原模型。即便发送了网络请求，URL 上的 `?oldId=` 始终为 `undefined` 或空。

### 根本原因
Vue 3 的 `setup(props)` 和组合式 API 中，试图用普通变量（非 `ref` 或非 `reactive` 属性）保存页面组件的状态（例如 `let originalModelId = ''`），并在异步或子方法中引用它。当双向绑定的表单执行回调时，由于非响应式变量的值引用丢失或发生遮蔽，拼接到 URL 上的 `oldId` 变为 undefined 导致后端无法识别“旧模型 ID”，进而执行了普通的 `addModel` 操作而不是重命名（删除旧的，添加新的）。

### 修复方案
将原本的普通变量声明改写为真正的响应式代理 `const originalModelId = ref('')`，并且在赋值时严格使用 `originalModelId.value = m.id`。

### 经验与教训
- **Vue 3 组合式 API 陷阱**：凡是需要在模板事件或异步请求中被读取的组件级状态缓存，必须使用 `ref` 包裹，切勿使用普通的 `let` 或 `const`。只有被挂载并且响应式的变量，才能在后续的交互中安全保留并传递正确的值。

---

## Bug #7: 模型隐式同步覆盖原配置缺陷

### 问题描述
在添加“渠道”时，如果在“支持模型”的输入框里填写了一个系统库（`ModelManager`）中**已经存在**的模型，系统的隐式同步函数（`syncModels`）会直接用默认值覆盖并重写原来的 `backendModel`, `type` 等配置，导致模型管理里的高级设置丢失。

### 根本原因
`AccountManager.syncModels` 中仅仅构造了一个全新的 `ModelConfig` 并调用 `addOrUpdateModel`。而 `addOrUpdateModel` 中使用了对象展开语法 `{ ...existing, ...config }`，这导致新传入的硬编码属性（如 `type: "chat"`）彻底覆写了持久化的旧属性。

### 修复方案
在 `syncModels` 中，首先通过 `ModelManager.getModelConfig(id)` 获取此模型当前是否已存在。在通过 `addOrUpdateModel` 同步时，利用空值合并或逻辑或操作符，**优先保留 existing 里的值**。并且确保对于**全新**的模型，将其 `backendModel` 默认值设置为它的 `id`，以满足用户的期待（避免空映射带来困扰）。
```typescript
{
   ...
   backendModel: existing?.backendModel || id,
   type: existing?.type || "chat"
}
```

### 经验与教训
- **防覆盖保护与增量更新**：在使用展开语法合并对象时，必须极为小心右侧配置对象的“副作用”。隐式自动生成实体的逻辑必须设计为“增量补充模式”，在任何情况下都不能静默覆盖用户手动更改过的重要设置。
---

---

## Bug #8: 模型名称包含 / 时被错误分割

**日期**：2026-03-16

### 问题描述
用户反馈在渠道管理页面添加模型时，模型名称如 `MiniMax/MiniMax-M2.5` 会被错误地分割成 `MiniMax` 和 `MiniMax-M2.5`。这是由于系统在处理模型列表、提供者列表和同步逻辑时，误将 `/` 作为了分隔符。

### 根本原因
前端 `admin.html` 和后端 `account-manager.ts`、`model-manager.ts` 中多处使用了 `split(/[,，/]/)` 这种正则分割逻辑。原本意图是支持英文逗号、中文逗号和斜杠作为分隔符，但忽略了斜杠在某些厂商（如 MiniMax, DeepSeek）的模型正式名称中是合法的组成部分。

### 修复方案
将所有涉及模型 ID 和提供者列表处理的分割逻辑从 `split(/[,，/]/)` 修改为 `split(/[,，]/)`。
- 仅支持英文逗号 `,` 和中文逗号 `，` 作为分隔符。
- 允许模型名称中包含斜杠 `/`。

### 经验与教训
- **分隔符选择要谨慎**：在定义配置项的分隔符时，必须确保分隔符本身不会出现在合法的配置值中。
- **尊重厂商命名规范**：不同 AI 厂商的模型命名风格各异，包含斜杠、点、中划线等特殊字符非常常见。不可主观臆断。
- **全栈一致性**：这类涉及前后端传递和解析的逻辑，必须在全链路（Frontend, Route, Manager, Persist）保持分割策略完全一致。

---

## Bug #9: 请求/响应载荷在日志中缺失

**日期**：2026-03-16

### 问题描述
管理员在排查 API 响应问题（如 `indexOf of undefined`）时，发现日志中仅记录了请求方法、路径、耗时和状态码，完全缺失了具体的请求数据（DATA）和返回内容（REPLY），导致无法准确定位是哪个字段或接口返回引起的问题。

### 根本原因
`server.ts` 中的 `#requestProcessing` 方法在记录日志时，仅提取了 `request.method` 和 `request.url`，并未将 `request.body` 和 route handler 返回的 `response.body` 写入 `logger`。

### 修复方案
在 `#requestProcessing` 中增加以下逻辑：
- 在调用业务路由前，如果 `config.system.requestLog` 开启且 `request.body` 不为空，记录 `DATA: ...`。
- 在业务路由返回后，如果 `config.system.requestLog` 开启且 `response.body` 存在，记录 `REPLY: ...`（对象会自动 JSON 序列化）。

### 经验与教训
- **可观测性是调试的基石**：全链路的 Trace 必须包含核心数据（Payload），尤其是在处理像 AI 接口这种协议复杂、非结构化输出多的场景。
- **日志脱敏与截断**：由于请求/响应可能包含大段 Base64（如图片/视频），在记录 Payload 时必须确保底层的 `logger` 或清洗函数（如 `sanitizeLogString`）已经具备了自动屏蔽 Base64 和截断超长字符串的能力，防止日志文件瞬间爆满或由于过长字符串导致日志分析工具崩溃。
---

## Bug #10: OpenAI 代理路由账号泄露 (OpenAI Proxy Account Leak)

**日期**：2026-03-16

### 问题描述
用户反馈如果只有 1 个账号，第一个请求处理完后，第二个请求一直处于排队中，且对应的账号显示一直处于“繁忙”中。

### 根本原因
在 `chat.ts`、`images.ts` 和 `video.ts` 的路由处理逻辑中，针对 `isPooled`（池化账号）逻辑，如果账号类型属于 `openai`（第三方兼容渠道），系统调用 `openaiProxy` 后直接返回了 response，但**遗漏了调用 `AccountManager.releaseToken(account.token)`**。这导致该账号的状态被锁定为 `BUSY` 且永远不会恢复，后续请求因此无法获取到可用账号而进入无限排队。

### 修复方案
在所有涉及 `openaiProxy` 调用的地方，确保先等待（await）请求完成，显式调用 `releaseToken` 释放账号后，再返回结果。

```typescript
if (isPooled && account.type === 'openai') {
    const result = await openaiProxy.proxyChat(request.body, account);
    if (isPooled) AccountManager.releaseToken(account.token); // 确保释放
    return result;
}
```

### 经验与教训
- **资源生命周期管理**：在使用“获取-释放”模式（Acquire-Release）管理资源时，务必检查所有的退出路径（包括正常返回和异常抛出）。
- **统一模式优于分散逻辑**：不同类型的账号（原生/代理）共用一套排队逻辑时，应确保它们在资源回收阶段的行为完全一致。
- **重代码审视**：在进行“最小代码修改”时，不能只关注 API 调用，还要审视配套的状态管理逻辑。

---

## 11. 视频生成同步轮询超时问题 (Video Generation Polling Timeout)

**日期**：2026-03-17

### 问题现象
视频生成接口在同步模式下，由于硬编码的轮询超时时间（180s）较短，导致在视频生成较慢时经常出现超时报错。用户无法根据实际需求调整等待时间。

### 根本原因
在 `src/api/controllers/video.ts` 的 `pollForVideoResult` 函数中，超时时间被硬编码为 `180000` ms。同时，管理后台缺乏对该参数的配置项。

### 修复方案
---

## Bug #12: 图生图URL上传失败 + 图文对话图片不可见

**日期**：2026-03-21

### 问题描述
1. 图生图传入字节CDN链接时，服务端返回"参考图上传失败"（错误码 -2001）
2. 图文多模态对话时，图片无法被AI识别（上传静默失败，AI回复"看不到图片"）；另外 `models.json` 中缺少 `doubao` 模型条目导致 chat 路由返回 404

### 根本原因
1. **图生图 URL 403**：`images.ts` 的 `uploadFile` 在通过 `axios.get` 下载远程图片时，没有携带浏览器 `User-Agent`/`Referer` 等 headers。字节跳动 CDN 对无 UA 的请求直接返回 403 Forbidden，导致下载失败，进而"参考图上传失败"。
2. **图文对话图片上传失败**：`chat.ts` 的 `acquireUploadAuth(refreshToken: string)` 函数将纯字符串 `token` 直接传给 `request(method, uri, context: AccountContext)`，但 `request()` 期望第3个参数是 `AccountContext` 对象。当字符串被当作对象访问时，`context.token` 为 `undefined`，导致 Cookie 中 `sessionid=undefined`，鉴权失败返回"登录已过期，请重新登录"。同时 `chat.ts` 也缺少下载 URL 图片时的浏览器 headers。
3. **Chat 404**：`data/models.json` 中没有 id 为 `"doubao"` 的模型条目，但测试脚本和前端默认使用 `model: "doubao"`，导致 `chat.ts` 路由的 `ModelManager.getModelConfig("doubao")` 返回 `undefined`，直接 404。

### 修复方案
1. `images.ts` 和 `chat.ts` 的 `uploadFile` 中，`axios.get` 下载远程图片时携带 `User-Agent`/`Accept`/`Referer` 浏览器 headers。
2. `chat.ts` 的 `uploadFile` 改为接受完整 `AccountContext` 对象（而非纯 token 字符串），确保 deviceId/webId 与主请求一致。
3. `data/models.json` 添加 `{ id: "doubao", type: "chat" }` 条目。
4. 增加图片后缀白名单和 Content-Type/URL参数 MIME 推断。

### 经验与教训
- **下载外部资源必须伪装浏览器**：对于 CDN 托管的资源（尤其是字节跳动），服务端下载时必须携带合法的 `User-Agent`，否则会被拦截 403。
- **上下文一致性原则**：涉及多步鉴权的 API（如先上传再发送消息），所有步骤必须使用相同的 `deviceId`/`webId` 等指纹信息，不能在中间步骤重新生成随机值。
- **配置完整性**：确保 `models.json` 包含所有会被 API 客户端使用的模型 ID。

1. **数据模型扩展**：在 `AccountManager.ts` 的 `Settings` 接口中新增 `videoTimeout` 字段，并设置默认值为 `180000`。
2. **控制器逻辑优化**：修改 `pollForVideoResult`，优先从全局设置中获取超时时间，并在 `createVideoCompletion` 中透传该配置。
3. **前端配置接入**：在 `admin.html` 的系统设置页面增加“视频生成超时 (ms)”输入框，实现参数的可视化配置与持久化。

### 经验与教训
- **参数解耦与可配置化**：对于耗时较长、环境依赖性强的业务逻辑（如视频/图片生成），其超时与等待频率不应硬编码，应通过配置系统下发，以便根据具体模型或硬件性能进行动态调整。
- **配置一致性**：新增配置项时，需确保全链路（从持久化 JSON 到 Manager 实例，再到 REST 路由，最后到前端 UI）的字段名称和单位保持严格一致，避免理解歧义。

---

## Bug #13: 图生图/图文对话仅支持单张图片

**日期**：2026-04-21

### 问题描述
1. 图生图只能传入单张参考图，无法同时上传多张图片进行融合/对比生成。
2. 图生图的 `ratio` 默认为 `1:1`，与上传图片的实际尺寸不匹配。

### 根本原因
1. `routes/images.ts` 校验器将 `image` 限定为 `string`，控制器 `createImageCompletion`/`createImageCompletionStream` 也仅处理单个字符串。
2. 路由层硬编码 `ratio: size || ratio || "1:1"`，未根据上传图片的实际尺寸推断比例。

### 修复方案
1. **路由校验**：`body.image` 同时接受 `string` 和 `string[]`。
2. **控制器多图**：将 `referenceImage` 统一为数组处理，使用 `Promise.all` 并行上传所有图片。
3. **比例自动推断**：新增 `detectRatio(width, height)` 函数，根据第一张图片尺寸匹配最接近的标准比例（1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3）。
4. **图文对话**：`chat.ts` 的 `extractRefFileUrls` 已原生支持从最后一条消息中提取多个 `image_url`，无需额外修改。

### 经验与教训
- **参数类型兼容性**：API 接口设计时，对于可能为单值或多值的参数（如文件上传），应从一开始就设计为 `T | T[]` 类型，避免后续破坏性变更。
- **默认值应智能化**：像 `ratio` 这类与输入内容紧密相关的参数，其默认值应优先从输入内容中推断（如图片尺寸），而不是硬编码一个固定值。

---

## Bug #14: 渠道备注 (Remark) 字段重启后丢失

**日期**：2026-04-21

### 问题描述
用户在管理后台为账号设置的“备注”信息，在项目重启或 Docker 容器重新运行后会消失，而其他信息（如限额、模型列表）均能正常保留。

### 根本原因
在 `src/lib/account-manager.ts` 的 `saveAccounts()` 方法中，定义持久化 JSON 结构的映射逻辑时，遗漏了 `remark: a.remark` 字段。导致每次保存 `accounts.json` 时，备注信息都没有被写入磁盘，重启后自然无法加载。

### 修复方案
在 `AccountManager.saveAccounts` 的字段映射列表中补充 `remark: a.remark`。

### 经验与教训
- **持久化同步检查**：在新增数据模型字段时，必须同步检查“读取（Load）”和“保存（Save）”两个环节。特别是在手动指定保存字段列表的情况下，极易遗漏新字段。
- **回归测试**：所有的配置项修改都应包含“重启测试”，以验证数据持久性是否符合预期。


---

## Bug #15: 连续使用时流式响应空返回且提前删除会话 (Premature Session Deletion)

**日期**：2026-04-22

### 问题描述
用户反馈在“连续使用”系统时，会出现 API 响应瞬间完成（如 11ms）但内容为空的情况。随后系统日志显示“删除会话失败：系统错误”。

### 根本原因
1. **状态码校验缺失**：在 `chat.ts` 和 `images.ts` 中，发起流式请求后未校验 HTTP 状态码。如果被豆包限速（429）或封禁（403），后端返回的可能是 JSON 错误信息而非流，或者是一个空流。系统误将其当作合法流开始处理。
2. **激进的清理逻辑**：系统的 `endCallback` 在流关闭时立即触发 `removeConversation`。如果流因为错误而瞬间关闭，且没有获取到有效的 `conversation_id`，清理函数会尝试删除一个空 ID，导致豆包返回“系统错误”。
3. **空返回导致的误判**：`receiveStream` 在流关闭时直接 `resolve`，没有检查是否真的收到了消息。

### 修复方案
1. **前置状态校验**：在处理流之前，检查 `response.status === 200`。非 200 状态直接抛出异常。
2. **删除保护**：在 `removeConversation` 中增加判断，如果 `convId` 为空或是 `"0"`，则取消请求。
3. **流异常检测**：如果流在极短时间内（如 100ms 内）且在没有任何有效事件（如 2001, 2003, 2005）的情况下关闭，应记录为错误而非成功。

### 经验与教训
- **不可信任的流成功**：流的“关闭”并不代表“成功”。必须通过业务上的标志位（如 `is_finish`）或收到的数据量来判定。
- **保护清理接口**：对于删除等写操作，必须确保操作对象（ID）有效，避免发送无效请求导致额外的后端压力和误导性报错。

---

## Bug #16: 远程重启接口缺失文档

**日期**：2026-04-24

### 问题描述
系统实现了 `/admin/restart` 接口用于远程重启服务，但 `API_DOCUMENTATION.md` 中未包含该接口的说明，导致用户不知道如何使用此功能。

### 根本原因
在新功能开发中，仅实现了后端逻辑和管理后台 UI，由于疏忽未同步更新 API 文档。

### 修复方案
在 `API_DOCUMENTATION.md` 的“工具与管理 (Utilities)”章节中增加了 `/admin/restart` 接口的详细说明，包括请求方法、鉴权要求和行为描述。

### 经验与教训
- **文档驱动开发 (DDD)**：在完成核心逻辑后，应立即更新对应的接口文档。
- **全链路检查**：新功能上线前，应核对代码、UI 和文档三者的一致性。

---

## Bug #17: 不打开浏览器时 Session 失效导致 -2001 错误 (Session Keep-Alive)

**日期**：2026-05-06

### 问题描述
当不打开豆包账号对应的浏览器（如比特浏览器）时，API 请求会持续报 `-2001` 错误（`RETRY_GENERATION_EMPTY: 会话 ID 为空`）。SSE 流在 0-1ms 内立刻结束，没有返回 conversation_id。重新打开浏览器后恢复正常，且 sessionid 本身并没有变化。

用户使用比特浏览器免费版（最多 10 个窗口），但账号数量超过 10 个，多出的账号因无法打开浏览器而无法使用。

### 根本原因
豆包服务端对 session 有**活跃度检测**机制。浏览器打开时会通过定时请求、WebSocket 心跳等方式保持 session 的"活跃"状态。当浏览器关闭后，session 因长时间无活动被标记为"不活跃"，导致 `/samantha/chat/completion` 等核心 API 拒绝请求，返回空的 SSE 流。

关键特征：
- sessionid 本身不会过期或变化
- 重新打开浏览器立即恢复（不需要重新登录）
- 说明不是 token 过期，而是服务端对 session 活跃度的判断

### 修复方案
在 `account-manager.ts` 中新增 **Session Keep-Alive（会话保活）** 机制：

1. **Settings 接口**新增 `enableKeepAlive`（默认 true）和 `keepAliveIntervalMinutes`（默认 5 分钟）
2. **定时任务**每隔指定间隔向 `https://www.doubao.com/im/conversation/info` 发送轻量级 GET 请求
3. **保活请求**携带完整的 `sessionid` 和浏览器 UA，模拟浏览器的活跃行为
4. **健康监控**保活失败时标记账号为 `unhealthy` 并记录日志

配置示例（`data/settings.json`）：
```json
{
  "enableKeepAlive": true,
  "keepAliveIntervalMinutes": 5
}
```

### 经验与教训
- **Session 活跃度 ≠ Token 有效性**：即使 token 未过期，服务端仍可能因 session 无活动而降级其权限。对于此类逆向工程项目，必须理解目标平台的 session 管理策略。
- **定时心跳是通用解决方案**：对于需要模拟浏览器行为的场景，定时发送轻量级 HTTP 请求是替代保持浏览器窗口的最简方案。
- **默认开启保护机制**：保活功能默认开启（`enableKeepAlive !== false`），避免用户忘记配置而导致问题复现。
---

## Bug #18: AI 生图结果带有水印 (Watermark Removal)

**日期**：2026-05-06

### 问题描述
豆包 AI 生成的图片默认带有官方水印（位于右下角）。用户希望通过 API 获取的是无水印的原图。网页版通过脚本 Hook `JSON.parse` 可以发现数据中其实存在无水印的版本，但 API 之前只提取了常规的 `image_ori.url`。

### 根本原因
豆包后端在返回图片生成结果（`creations` 数组）时，每个图片对象包含多个 URL 字段：
- `image_ori.url`: 标准原图（通常带水印）
- `image_preview.url`: 预览图（带水印，压缩）
- `image_thumb.url`: 缩略图（带水印，小图）
- `image_ori_raw.url`: **原始无水印图（真正的源文件）**

之前的代码逻辑在提取 URL 时按顺序尝试 `image_ori` -> `image_preview` -> `image_thumb`，忽略了 `image_ori_raw`。

### 修复方案
在 `images.ts` 控制器中修改图片提取逻辑：

1.  **优先提取逻辑**：在 `extractImageUrlsFromCreations` 和 `createTransStream` 中，将提取顺序改为：
    `image_ori_raw.url` (最高优先级) -> `image_ori.url` -> `image_preview.url` -> `image_thumb.url`
2.  **代码实现**：
    ```typescript
    const finalUrl = img?.image_ori_raw?.url || img?.image_ori?.url || img?.image_preview?.url || img?.image_thumb?.url;
    ```
3.  **结果**：API 返回给客户端的 Markdown 链接或 JSON URL 列表现在指向无水印的原始文件。

### 经验与教训
- **深入挖掘返回报文**：逆向协议时，返回 JSON 中的每个字段都值得仔细检查，往往隐藏着高级功能（如无水印图、高清链接等）。
- **字段命名规律**：通常带有 `raw`、`source`、`original` 字样的字段更有可能指向未经过滤或处理的原始资源。
- **前后端一致性**：通过分析浏览器插件/脚本的 Hook 逻辑，可以快速定位后端响应中的关键字段，提高开发效率。

# [NEW] Browser-Related Server Memory Leak (浏览器后台进程管理内存泄露)

## 1. 问题描述
当用户在管理后台点击“打开浏览器”后，服务器进程的内存占用会持续上涨，即使关闭浏览器后上涨也不会停止。涨的是 Node.js 服务器进程本身的内存，而不是浏览器进程。

## 2. 根本原因分析
1. **外部进程调用缺少超时控制**：`BrowserProfileManager` 中的 `getProcessesByUserDataDir`、`getProcessDetails` 和 `killProcessTree` 等方法调用 `powershell.exe` 和 `taskkill` 时没有设置 `timeout`。在某些 Windows 系统环境下，PowerShell 命令（尤其是 `Get-CimInstance`）可能会因为 WMI 故障或进程过多而挂起。
2. **Watcher 叠加泄露**：系统每 5 秒通过 `setInterval` 轮询一次浏览器状态。如果某次轮询中的 PowerShell 调用挂起，对应的 async 函数就会一直处于 `pending` 状态留在内存中。由于 `setInterval` 不等待上一次完成，每 5 秒都会产生一个新的挂起函数及其实际占用的子进程句柄和缓冲区，导致内存持续上涨。
3. **Promise 锁链条泄露**：`runWithProfileLock` 使用了 Promise 链来保证操作原子性。如果某个操作（如 `warmupBrowser` 中的 Puppeteer 调用）挂起且没有超时，该 Profile 的锁将永远无法释放。后续的定时热机（Cron）会不断向该 Promise 链添加新的 `.then()` 回调，导致内存随时间缓慢增长。

## 3. 修复方案
1. **全面增加超时保护**：为所有 `execFile` 调用增加 `timeout: 15000` (15秒) 的配置，确保外部命令不会永久阻塞 Node.js 事件循环。
2. **将 setInterval 改为递归 setTimeout**：将 Session Watcher 改为在当前任务完成后再调度下一次任务，避免在任务执行缓慢或挂起时产生并发堆积。
3. **增强 PowerShell 命令稳健性**：在 PowerShell 脚本中增加 `-ErrorAction SilentlyContinue` 并优化查询逻辑。
4. **优化锁机制**：虽然 Promise 链是标准的，但应确保链中的每个环节（action）都有自己的超时控制，防止死锁。

## 4. 经验与教训
- **所有的外部 I/O 必须有超时**：无论是网络请求还是本地子进程调用，只要涉及跨进程通信，就必须假设对方可能会死锁或挂起。
- **避免并发轮询堆积**：对于耗时可能波动的定时任务，优先选择“任务完成后再设下一次定时”的模式，而不是固定频率的 `setInterval`。
- **监控 pending 任务**：在复杂的异步系统中，如果内存持续增长，应优先排查是否存在大量未完成的 Promise 或被持有的闭包。

---

## Bug #18: 浏览器账号探活并发状态写入冲突与 JSON 解析失败

**日期**：2026-05-10

### 问题描述
在高频并发执行浏览器账号探活（Browser Probe）时，服务器磁盘写入出现 high-frequency 文件锁死错误（如 `EBUSY`），有时会导致 `accounts.json` 被写为空文件或者写入破损的 JSON 串，从而在下一次服务启动时导致 JSON 解析崩溃。

### 根本原因
1. **并发 I/O 脏写**：在探活过程中，系统在更新账号状态后会通过 `AccountManager.updateAccount` 调用 `saveAccounts` 将最新的 `Cookie` / `LocalStorage` 写入到磁盘中。在高并发探活时，多个异步进程在没有写入互斥机制的情况下同时写同一个 JSON 文件，导致文件写入锁冲突。
2. **磁盘状态脏覆盖**：部分执行中的异步探活由于写锁失败，导致将空白或不完整的数据覆盖写入到磁盘。
3. **缺少限流保护**：对 `probeBrowserAccountsIfDue` 没有设计严格的并发队列与过期时间检查，导致探活任务并发过多，超过 Windows 下的子进程承受上限。

### 修复方案
1. **引入排他串行写锁**：在 `AccountManager` 中引入排他写锁队列，利用 Promise 链式机制将所有的磁盘写文件（`saveAccounts`）操作进行强制串行化排列，彻底解决并发写冲突。
2. **探活状态防重防并发**：在进入 `probeBrowserAccountsIfDue` 时增加锁状态判断，若已有正在探活的相同账号，则直接跳过或等待，避免产生重叠调用。
3. **非阻塞安全写回**：对所有的 JSON 读写操作增加严格的 try-catch 保护，写入时先写入 `.tmp` 临时文件，确认写入成功后再通过原子替换重命名为 `accounts.json`，确保数据文件的绝对完整性。

### 经验与教训
- **高并发下的文件存储安全性**：单文件数据库在高并发操作下必须提供应用层串行队列（写入锁），否则随时面临文件脏写和损毁。
- **临时写入原子替换**：通过先写临时文件再重命名的方式是保证数据文件持久化安全的黄金标准。
- **防重机制前置**：异步高开销任务在触发前必须有就地的防重和限流锁，防止下游拥塞。

---

## Bug #19: npm run dev 模式下内存持续上涨与 CPU 占用过高 (Watcher Loop)

**日期**：2026-05-11

### 问题描述
在 `npm run dev` 开发模式下，一旦打开浏览器或触发浏览器探活，服务器 CPU 占用会上升至 7-10%，且 Node.js 进程内存持续上涨直到爆满。而在 `npm start` 生产模式下运行正常。

### 根本原因
1. **监听死循环 (Watcher Loop)**：`tsup --watch` 默认监听了 `data`、`logs` 等频繁变动的目录。
2. **触发链条**：
   - 浏览器打开或探活 -> 后端写日志到 `logs/` 并同步状态到 `data/accounts.json`。
   - `tsup` 监测到文件变动 -> 重新编译 -> 通过 `onSuccess` 重启服务。
   - 新服务启动 -> 初始化健康检查/探活 -> 再次写日志/数据 -> 再次触发编译重启。
3. **资源积压**：`--dts` 生成类型定义文件极其消耗内存，加上频繁的重启导致内存和 CPU 迅速耗尽。

### 修复方案
修改 `package.json` 中的 `dev` 脚本：
1. 使用 `--ignore-watch` 参数显式忽略 `data`、`logs`、`.cache` 和 `dist` 目录，切断监听死循环。
2. 在 `dev` 脚本中移除 `--dts` 参数，仅在 `build` 脚本中保留，减少开发时的内存开销。

### 经验与教训
- **Watch 范围控制**：在使用带 `onSuccess` 重启机制的监听器（如 `tsup`、`nodemon`）时，必须严格限制监听范围，排除所有程序运行产生的日志和持久化数据目录。
- **开发与生产差异**：当 `dev` 模式出现性能问题而 `start` 模式正常时，应优先排查监听器配置和构建工具的副作用。

---

## Bug #20: 浏览器账号创建后 UI 不自动刷新 (JS Crash)

**日期**：2026-05-11

### 问题描述
在管理后台 浏览器账号页面，点击新增浏览器账号并保存成功后，弹窗不会自动关闭，列表也不会自动刷新，必须手动刷新页面才能看到新账号。

### 根本原因
1. **作用域变量引用错误**：在 submitBrowserAccount 回调函数中，错误地引用了未定义的变量 cc。
2. **执行链中断**：JavaScript 在执行到 cc.webId = ... 时抛出 ReferenceError: acc is not defined 异常，导致后续的 closeBrowserModal() 和 etchData()（刷新逻辑）被跳过。

### 修复方案
1. **移除冗余错误代码**：在 public/admin.html 中移除 submitBrowserAccount 函数内对 cc 的赋值操作。
2. **保持自动刷新逻辑**：确保 etchData() 在请求成功后被正确调用，以从后端获取最新的账号列表。

### 经验与教训
- **代码审查与测试**：在进行代码重构或复制类似逻辑时，必须确保所有引用的变量在当前作用域内均有效。
- **异常处理的局限性**：虽然 	ry-catch 捕获了异常并弹出了 Toast，但逻辑中断导致了用户体验上的功能失效。应确保关键流程（如 UI 状态重置）的鲁棒性。

## Bug #21: 异步媒体生成任务无法获取有效的任务 ID

**日期**：2026-05-11

### 问题描述
在异步任务（图片/视频/音乐）的创建接口中，系统偶尔无法获取到正确的任务 ID，导致后台执行逻辑失败。客户端在拿到无效 ID 后开始轮询，最终由于找不到任务记录而显示 'failed'。此外，系统在初始化某些异步渠道时如果没能正确校验 ID，会导致使用空白的提示词或无效的参数进行调用。

### 根本原因
任务生成和账户获取逻辑中存在异步竞态条件。在并发创建任务阶段，异步的执行器（executor）未能同步拿到成功创建的任务 ID 便提前返回或进入下一步处理。

### 修复方案
1. **前置路由拦截**：在 `src/api/routes/media.ts` 中，在调用 `createTask` 之前，先完成账户状态和支持模型的同步校验与预分配。
2. **及时报错阻断**：若账户分配或 ID 生成失败，直接返回 403 错误，防止创建无效的异步任务 ID。
3. **优化报错提示**：在 `sync-task-query` 的轮询逻辑中优化提示语，指导用户查看前置任务的创建是否成功。

### 经验与教训
- **异步时序控制**：在复杂的异步交互流中，任务 ID 等核心凭证必须确保在创建操作完全落库并返回后，再向下游触发轮询或后续流程。
- **接口快速失败**：在输入参数或环境依赖项不满足条件时（如账户不可用），应在入口处立即阻断请求，防止产生无效的脏数据。

## Bug #22: test_music_async.py 轮询报错 AttributeError

**日期**：2026-05-11

### 问题描述
在异步音乐任务轮询过程中，脚本抛出 AttributeError: 'NoneType' object has no attribute 'get'，导致程序中断。

### 根本原因
1. **响应异常处理不足**：当 API 返回的 data 字段为 null 时，脚本未进行非空检查就直接调用 .get() 方法。
2. **模型名称配置错误**：查询负载中的 model 字段被错误地设置为了 'async'，而 API 文档要求必须是 'async-task-query'。

### 修复方案
1. **修正模型名称**：确保查询负载中使用正确的 async-task-query。
2. **增加非空检查**：在处理 API 响应时，增加了对 task_data 的 None 检查。
3. **完善日志记录**：当返回异常数据时，打印原始响应内容以便排查。

### 经验与教训
- **始终校验 API 返回值**：不能假设 API 总是返回预期的 JSON 结构，特别是 data 字段。
- **严格遵守文档规范**：模型名称等关键参数必须与 API 文档保持完全一致。
- **增强脚本健壮性**：在循环轮询逻辑中增加 try-except 和非空保护，避免单次异常导致整个任务失败。

## Bug #23: 浏览器账号探活并发状态混淆与系统账号数量合并统计缺陷

**日期**：2026-05-17

### 问题描述
1. **浏览器账号并发探活状态混淆**：在浏览器账号管理页面，快速并发点击多个账号的“立即探活”时，由于前端缺乏行级状态隔离机制且共用全局的 loading，第一个完成的探活请求触发 fetchData() 会直接覆盖其他还在进行中的账号的 UI 状态，导致它们退回到旧成功状态，引起探活状态未被物理隔离的错觉。
2. **系统账号数量合并统计**：控制台系统启动日志及仪表盘、侧边栏直接展示 totalAccounts，将 API 渠道数与浏览器账号数混为一谈，造成两类完全不同用途账号数量的概念合并与统计混淆。

### 根本原因
1. **行级隔离机制缺失**：前端探活状态依赖全局 loading 刷新，没有在前端实现局部的、排他的行级状态跟踪（如 probingAccountIds）并禁用相关行其他并发按钮操作。
2. **账号指标计数重叠**：getStats() 方法中未将 isBrowserManagedAccount 账号区分开，且 UI 没有在主仪表卡片和侧边栏设计专门的分离统计区块。

### 修复方案
1. **后端数据库串行写锁**：在 `AccountManager` 类中声明 `private saveQueue = Promise.resolve();`。通过 Promise 链式队列将所有高频并发的 `saveAccounts` 磁盘异步写入操作串行排队，彻底杜绝 Windows 平台上的 `EBUSY` 文件写入锁冲突或数据文件脏写覆盖。
2. **路由脱敏数据单行对齐**：在 `/admin/browser-accounts/:id/probe` 和 `sync-state` 接口中，数据更新完毕后，利用 `AccountManager.getBrowserAccountsData()` 重新获取并返回单个经过完整映射、掩码脱敏过的账号对象。
3. **前端就地局部精准更新**：在 `probeBrowserAccount` 和 `syncBrowserState` 成功回调中，**完全删除全局 `fetchData()` 调用**，直接利用接口返回的单行数据在 Vue 的 `browserAccounts.value` 数组中就地通过 `id` 查找并进行单项替换。这保证了其他正在探活中账号的 DOM 节点与 Reactivity 状态保持绝对纯净和物理隔离。
4. **探活中文字状态保护**：重构表格行底部的 `responseSummary` 区域。当账号处于 `isProbing(acc)` 时，该文字区被保护并高亮显示为：`“正在执行 chat 探活，请稍候...”`（附加呼吸动画），完全屏蔽历史探活摘要，消除任何混淆错觉。
5. **Dashboard 5列高级卡片拆分**：将主控面板从 `lg:grid-cols-4` 升级为 `lg:grid-cols-5`，把第一个合并的卡片彻底拆分为两张极其高端的独立卡片（“API 渠道总数”与“浏览器档案总数”），分别拥有独立的 Lucide 图标与已启用数量比率角标。

### 经验与教训
- **长耗时异步行为的 UI 隔离设计**：绝不能依赖单一的全局刷新机制（如 `fetchData()`）来更新并发的长耗时异步列表行，因为旧数据的重绘会覆盖其他处于等待态行的临时 UI 表现。必须使用局部精准就地更新，以确保完美的并发控制与极致平滑的交互。
- **高并发写操作的文件锁机制**：在无多版本并发控制（MVCC）的简单 JSON 文件数据库系统中，任何高频并发写入动作必须在应用层（如使用 Promise Chain）进行严格串行化，否则多物理进程并发异步写 I/O 极易产生死锁或数据丢失。
- **UI 设计的黄金法则**：当功能实体的逻辑概念完全正交时（如提供 API 反代服务的渠道 vs. 网页托管 Puppeteer 档案），其关键指标绝不能合并统计。应使用设计高档的、正交的网格布局进行拆分展示，既清晰又极具专业感。

---

## Bug #24: 豆包视频生成新多模态 content_block 适配与顶层 chat_ability 场景分流升级

**日期**：2026-05-20

### 问题描述
豆包官方后端对接口端点和请求体进行了多模态统一升级，彻底淘汰了旧版的 `/samantha/chat/completion` 发送序列化 JSON 字符串的过时方式。当使用旧版接口发送请求时，由于后端架构变更，导致生成任务面临失败，无法正常发起视频生成或者无法获取正确的异步视频任务信息。

### 根本原因
1. **多模态架构演进**：豆包不再接受通过普通文本 `content` 加载大段序列化 JSON 的方式进行多模态视频生产，而是统一使用全新的内容块数组 `content_block`（文本剧本块为 `10000`，图片参考图附件块为 `10052`）。
2. **场景路由机制**：在统一 `/chat/completion` 后，网关不再按 URL 路径做服务分发，而是读取请求体最外层独立的 `chat_ability` 参数，利用 `ability_type: 17` 进行视频生成的精准分流。
3. **动态分辨率适配**：旧的参考图大小被硬编码，导致不同长宽比的参考图出现扭曲或不兼容。

### 修复方案
1. **重构视频请求 payload**：
   - 彻底废弃旧的 `content_type: 2020`，重新设计并根据参考图的有无动态构造多模态内容块 `content_block`。
   - 自动在文本剧本中前置拼接豆包专属的场景描述：`帮我生成视频：比例 「${ratio}」${prompt}`，完美贴合网页端生成逻辑。
2. **接入真实图片分辨率**：
   - 在 `images.uploadFile` 时提取返回的图片真实宽高，通过 mappedAttachments 的 `width` 和 `height` 将其动态载入附件包中，彻底消灭硬编码。
3. **升级场景控制参数**：
   - 将原接口统一变更为最新的 `/chat/completion` 路由，并在最外层挂载规范的 `chat_ability` 字段，封装比例控制。
   - 精细对齐 `option` 和 `ext` 中的各项高精度指纹和配置参数。

### 经验与教训
- **多模态协议统一**：随着大模型应用由纯文本走向多模态，请求协议也逐步标准化（例如 content_blocks 块化设计）。在反代适配中，必须灵活分析官方最新的 Payload 特征，及时对齐多模态规范。
- **高动态参数保持**：针对多媒体任务（图片或视频生成），尺寸参数非常关键。在提取用户上传的多媒体附件时，应自动解析物理文件的真实分辨率与最接近的长宽比，而不是使用默认写死的值，这对于生成质量的稳定性至关重要。

---

## Bug #25: 豆包异步任务『后扣费』额度结算保护机制与测试轮询状态终止判断对齐

**日期**：2026-05-20

### 问题描述
1. **失败白扣额度问题**：异步视频（以及音乐）任务生成周期长、易失败。在旧设计中，由于在请求下发之初即执行了“预扣费”，一旦生成任务在后台轮询期间由于风控、超时等原因宣告失败，用户账号的使用次数依然会被扣减。此外，若任务成功，在回调时可能触发二次累加，导致“多扣额度”。
2. **测试脚本轮询不退出**：在执行 `test_new_video.py` 时，视频明明已经成功生成并且控制台已打印 `succeeded` 状态，但测试脚本由于只识别旧版本的 `completed` 成功标识，从而无限在控制台卡死进行多余轮询。

### 根本原因
1. **扣费时机与机制错配**：对于高失败率、高延时的异步任务，依然套用了同步对话（chat）的“锁账号即扣费”的前置预扣费逻辑，缺乏失败退款或任务确认交付后的“后扣费”闭环。
2. **状态机判定范围窄**：豆包视频生成系统的最终成功状态码在当前版本中被标记为了 `succeeded`，而测试脚本中的状态判定硬编码为了 `completed`，导致成功信号被错误过滤，无法打破轮询。

### 修复方案
1. **取消前置预扣费**：
   - 重构 `AccountManager.lockAccount`，在请求被调度分发并加锁账号时，对 `video` 与 `music` 类型**彻底移除预先自增 `usage` 额度的行为**，保护资产安全。
2. **实现精确的后置交付扣费（后扣费）**：
   - 精塑 `video.ts` 中的 `createVideoCompletion` 控制器流：只有在任务从轮询中正常苏醒，**且 `videos.length > 0` 真正带回了合法的视频下载 URL 时**，才通过调用 `AccountManager.updateAccountUsage(accountId, 'video')` 累加账号被消费的使用次数。对于生成超时或返回为空的情况，概不计入使用额度。
3. **兼容多状态机判断**：
   - 升级 `test_new_video.py` 脚本，将状态终止检测判定扩展为 `status in ("succeeded", "completed")`。只要监测到任务顺利走完并成功产出，立刻提取 URL 详情并利落地打破循环退出。

### 经验与教训
- **异步耗时服务必须采用后扣费**：对于任何包含异步队列、由回调或轮询交付的第三方云服务（如视频生成、音频合成），绝不能在提交请求时做“一锤子买卖”式的预扣费。应该在结果安全落地、数据真实返回后才触发收费逻辑，以确保消费额度的绝对公平与健康性。
- **宽容的状态断言设计**：在编写反代测试与监控脚本时，针对状态码（如 `succeeded` / `completed` / `finished`）应该保持一定的兼容与弹性，以避免因为上游微小的文案变更导致测试进程卡死在无效循环之中。

---

## Bug #26: 视频生成卡人脸/安全审核时无限轮询直至超时的问题

**日期**：2026-06-03

### 问题描述
在图生视频中，如果用户上传的提示词或参考图包含敏感信息或真人肖像（触发卡人脸/风控审查失败），系统不会提前终止任务，而是持续向 `/im/chain/single` 发送拉取请求，一直轮询直到 180 秒（3 分钟）超时结束才返回空数据，浪费了系统资源和响应效率。

### 根本原因
1. 在 [video.ts](file:///d:/daima/doubao-free-api-master/src/api/controllers/video.ts) 的 [pollForVideoResult](file:///d:/daima/doubao-free-api-master/src/api/controllers/video.ts#L234) 轮询逻辑中，仅以 `videos.length > 0`（成功拿到视频）或时间超时作为退出循环的条件。即使豆包在消息链中返回了侵权、违规或肖像保护等警告文案，轮询机制也由于缺乏相关的关键字断言，无法识别失败状态并提前阻断。
2. 即使我们在轮询遍历中抛出了 `APIException`，但由于该异常被 `while` 循环体内最外层的 `try ... catch (err)` 块捕获且未重新抛出（Re-throw），导致异常被内部静默吞掉，程序继续进行下一轮的 5 秒等待和重复请求，未能真正提早结束轮询。同时，因为没有抛出错误，外层调用以 200 状态响应成功（但在回复中显示超时），导致上游计费系统（如 One API）误以为生成成功而扣除了用户的次数额度。

### 修复方案
在 [pollForVideoResult](file:///d:/daima/doubao-free-api-master/src/api/controllers/video.ts#L234) 的消息遍历循环开始前，增加针对消息内容的快速安全审核与肖像保护关键字匹配。
1. 将 `msg.content` 统一序列化为字符串进行内容审查：
   - 情况1 (疑似侵权/违规/版权限制)：当包含 `"疑似包含侵权"`、`"侵权 / 违规"`、`"换个主题再试试"` 或 `"版权"` 时，立即记录日志并抛出 `APIException` 异常终止轮询，提示内容安全或版权审核失败。
   - 情况2 (肖像保护)：当包含 `"出于肖像保护考虑"`、`"不支持上传真实人脸"` 或 `"真实人脸素材"` 时，立即记录日志并抛出 `APIException` 异常终止轮询，提示出于肖像保护暂不支持真实人脸。
2. 在循环体底部的 `catch (err)` 中，增加类型判断 `if (err instanceof APIException) throw err;`。确保触发风控与安全异常时，错误能正常穿透并阻断 `while` 循环。
3. 异常被外层捕获后，同步接口将及时向客户端返回 500 状态的安全阻断错误（防止上游扣减计费）；异步任务管理器能接收到抛出的错误并将任务物理标记为 `failed` 状态，免去了冗余的等待时间。
4. 在 [src/api/routes/video.ts](file:///d:/daima/doubao-free-api-master/src/api/routes/video.ts) 的视频路由 `catch(err)` 分支中，增加对安全和版权错误的拦截旁路：如果错误信息包含安全或版权相关的关键字，直接抛出错误且不触发 `applyResponsePolicy`，防止因 `-2001` 被当作未定义网络瞬时错误而重新选号并无限重试 3 次，达到了“一经审核失败，立刻彻底终止”的完美闭环。

### 经验与教训
- **异常链路的提前退出（Early Exit）**：在长耗时的异步/轮询场景中，除了关注成功状态的捕获外，也必须重点分析并匹配上游可能返回的全部异常状态（如违规、限流、保护策略等）。一旦发现由于不可逆原因导致的任务失败信号，应立刻提前打破轮询以释放进程与网络资源。
- **匹配宽容性与精确性的平衡**：使用具有强特征的多词汇短语或词组组合来进行安全词审查，比单一的 "人脸" 等分词更具鲁棒性，能够有效消除常规输入中产生误判的负面影响。

---

## Bug #27: 今天的生成次数已经达到上限兼容与直连Token状态同步问题

**日期**：2026-06-03

### 问题描述
1. **生成额度上限不自动重试**：当 Doubao 账号的使用频次触及平台限制时，其响应中会输出 `"今天的生成次数已经达到上限"`。系统此前未对此特定频次/限流文本进行早期兼容性检测，导致请求被当作常规错误而不会触发跨账号自动轮询重试。
2. **直连 Token 状态始终为空闲（Idle）**：当用户在管理后台点击或直接在调用中使用具体渠道的 API Key（`isPooled = false` 非池化模式）时，后台虽然能够成功请求，但其账号状态在“渠道管理”列表中自始至终被显示为 `idle` 状态，不会变更成 `busy` 或 `cooldown`，造成统计和可视化交互方面的状态不同步。

### 根本原因
1. **缺失针对限额的特殊错误拦截**：不管是流式响应解析（`receiveStream`、`createTransStream`）还是视频轮询（`pollForVideoResult`），均未对 `"今天的生成次数已经达到上限"` 等关键字做拦截抛出，且在路由的错误重试判定（`RETRY_GENERATION_EMPTY` 之外）中，也没有捕获到此类限额错误来触发用量上限更新与跨账号重试。
2. **直连模式缺失 Lock / Release 周期**：在 `/completions` 和各个 `/generations` 路由中，系统仅对池化模式（`isPooled = true`）执行了 `AccountManager.acquireToken` 和 `AccountManager.releaseToken`。对于传入特定 Bearer Token 的非池化模式，则直接用 token 字符串进行请求，完全绕过了 `AccountManager` 内的状态锁定与冷却管理。

### 修复方案
1. **限额拦截与用量封顶机制**：
   - 在 `chat.ts`、`images.ts`、`video.ts` 控制器中的 `receiveStream`/`createTransStream`/`pollForVideoResult` 校验位置，增加 `"今天的生成次数已经达到上限"` 与 `"生成次数已经达到上限"` 的匹配。当检出后抛出 `APIException` 带有专属前缀 `"RETRY_GENERATION_LIMIT"` 的错误信息。
   - 在所有的接口路由（`chat`、`images`、`video`、`music`、`media`） catch 块中拦截此错误。检测到后将 `policyAction` 设置为 `retry` 触发账号轮询重试，同时将当前被封顶账号的对应额度变量（如 `usageVideo`）直接设为最大值（如 `limitVideo > 0 ? limitVideo : 99999`），并调用 `AccountManager.saveAccounts()` 保存状态，从而从账号池中临时剔除该满额账号。
2. **直连 Token 状态监控闭环**：
   - 升级 `AccountManager`，新增 `getAccountByToken(token: string)` 用于匹配持久化中的具体账号对象，并将 `lockAccount` 及 `saveAccounts` 调整为 `public` 属性。
   - 在各个接口路由中，若 `isPooled` 为 false，先使用 `getAccountByToken` 尝试获取具体的配置账号。若获取成功，在业务执行前显式调用 `lockAccount` 将其状态变更为 `busy`，并在 `finally` 或流的关闭/异常事件回调中调用 `releaseToken` 触发状态冷却，从而无缝接入后台的状态机渲染周期。

### 经验与教训
- **池化和直连模式在状态跟踪上应当保持一致**：即使是用户直连使用特定 Key，在系统内部依然应该被映射为对应的实体并接入生命周期管理，以确保持久化显示与实体的实际运行状态完全统一。
- **特定业务错误的针对性升级**：类似于“次数达到上限”、“登录状态过期”等跟额度或权限高度相关的特殊业务错误，不能简单地当作普通异常抛给用户。应当将其捕获，并作为运行时状态机调整的反馈（例如更新用量并触发换号重试），以极大地增强反代集群的自愈能力与服务可用性。

---

## Bug #28: 客户端提前关闭流式连接导致账号永久锁定繁忙状态 (Stream Abort Account Leak)

**日期**：2026-06-03

### 问题描述
在使用图像（images）、视频（video）、音乐（music）生成接口流式响应时，若客户端在流式传输未结束前提前主动中断/关闭连接（如在网页上点击取消生成或直接断开连接），对应的账号状态在“渠道管理”列表中会永久显示为 `busy` 繁忙，无法回到 `idle`，导致可用渠道不断消耗耗尽。

### 根本原因
1. 流式响应在客户端提前中断时，Koa/Node.js 底层只会触发流的 `'close'` 事件，而不会触发 `'end'`（正常结束）或 `'error'`（发生错误）。
2. 旧的路由逻辑（`images.ts`, `video.ts`, `music.ts`）中，仅对流 `s` 绑定了 `s.on('end', ...)` 和 `s.on('error', ...)`，没有绑定 `s.on('close', ...)`，这导致在此情况下 `releaseToken` 逻辑被跳过。
3. 之前已经修复了 `chat.ts` 的流式退出事件，但未在图像、视频和音乐路由中统一同步。

### 修复方案
在 `images.ts`、`video.ts`、`music.ts` 路由的 stream 响应分支中，引入一个防重复释放的 `release` 助手函数，并同时监听三个事件：
```typescript
const token = isPooled ? account.token : matchedAccount?.token;
if (token) {
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        AccountManager.releaseToken(token);
    };
    s.on('end', release);
    s.on('error', release);
    s.on('close', release);
}
```

### 经验与教训
- **流生命周期事件的完整覆盖**：在 Node.js 中，任何与资源锁定绑定的可读流生命周期处理，都必须同时绑定 `'end'`（数据读完）、`'error'`（出错异常）与 `'close'`（底层套接字/流销毁），确保无论是顺利交付还是异常中断，均能触发回收机制。
- **单次释放保护设计**：使用带有 Boolean 标志（如 `released`）的独立闭包回调来包装释放逻辑，防止同一流触发多个事件导致重复释放及控制台 warning 报错。

---

## Bug #29: 服务重启接口 exit(0) 导致 watchdog 守护进程无法自动重启 (Service Restart Watchdog Exit Code)

**日期**：2026-06-03

### 问题描述
管理员在后台控制面板点击“重启服务”按钮后，后台服务进程终止，但没有自动拉起，反而把终端控制台完全关闭，导致必须手动在终端重新运行 `npm run dev` 或 `npm start` 才能恢复服务。

### 根本原因
1. 项目使用了 `src/daemon.ts` 作为看门狗进程启动守护服务，守护进程在 `childProcess.on("close")` 监听子进程的退出状态码。
2. 守护进程中硬编码了当子进程退出码 `code === 3` 时执行 `createProcess()` 自动拉起重启；而 `code === 0`（正常退出）时，守护进程只记录 `process has exited` 并不执行重启，最终整个守护进程与控制台直接退出。
3. `/admin/restart` 接口原逻辑延时调用 `process.exit(0)`，传递了 0（代表正常退出）而不是 3，使看门狗退出了守护，进而导致无法重启。

### 修复方案
修改 `src/api/routes/admin.ts` 中的 `/admin/restart` 接口处理函数，将 `process.exit(0)` 修改为 `process.exit(3)`，并在旁边注明原因，以触发 `daemon.ts` 的自动拉起流程。

### 经验与教训
- **对齐退出信号语义**：自定义的控制流或进程守护机制下，应特别注意各个退出状态码（Exit Code）的精确含义并严格保持前后端对齐。不能将“管理重启”误归于“常规正常退出 (Code 0)”。

---

## Bug #30: Windows 启动脚本 start-windows-5566.bat 拦截非零退出码导致重启功能在终端失败

**日期**：2026-06-03

### 问题描述
将服务端重启退出的 Exit Code 调整为 `3` 后，在 Windows 环境下双击或在终端通过 `start-windows-5566.bat` 运行服务时，点击重启服务按钮依然无法成功重启，且控制台打印 `[dbapi] Startup failed.` 后进程直接退出/挂起。

### 根本原因
1. `start-windows-5566.bat` 脚本直接通过 `call npm run start` 启动生产服务。
2. 脚本中使用了 `if errorlevel 1 goto :fail` 来捕获启动或运行时的异常。在 Windows 批处理中，`if errorlevel N` 表示当退出码大等于 N 时条件成立。
3. 当服务端调用 `process.exit(3)` 触发重启时，返回的退出码是 `3`。由于 `3 >= 1`，批处理认为启动/运行失败，进而跳转到了 `:fail` 代码块，打印了 `Startup failed.` 并结束了脚本。

### 修复方案
修改 `start-windows-5566.bat`，在检测 `errorlevel 1` 之前，先精确匹配退出码是否等于 `3`。如果是，则提示重启并跳转回 `:start_server` 重新拉起服务：
```bat
:start_server
echo [dbapi] Starting production server...
call npm run start -- --port=%SERVER_PORT%
if %errorlevel% equ 3 (
  echo.
  echo [dbapi] Server requested restart. Restarting...
  echo.
  goto :start_server
)
if errorlevel 1 goto :fail
```

### 经验与教训
- **批处理中 errorlevel 的比较机制**：Windows 批处理的 `if errorlevel N` 是大等于（>=）比较，如果需要精确匹配，建议使用 `%errorlevel% equ N` 语法，或按数值从大到小的顺序进行 `errorlevel` 条件检查。
- **运行环境的全链路测试**：在涉及底层进程退出的修改时，不能只核对守护进程（如 `daemon.ts`），还要把所有的入口引导脚本（如 `.bat`、`.sh`）一同纳入回归测试，确保在直连启动与守护启动的各种环境下表现一致。

---

## Bug #31: 即梦模型配置页面 HTML 重复渲染导致数据与操作冲突

**日期**：2026-06-04

### 问题描述
管理员在后台控制面板访问“即梦模型”页面时，发现该页面下的即梦模型列表以及添加即梦模型按钮等 HTML 结构发生了完全重复的渲染。由于存在两个功能完全相同但 ID 相同的 DOM 段，在双向绑定和事件监听时，导致多次拉取、DOM 数据不一致或者在修改配置保存时引发意料之外的数据脏写和交互冲突。

### 根本原因
在开发 `admin.html` 页面时，在 `Main Content` 部分错误地连续嵌入了两个 `v-if="activePage === 'jimeng-models'"` 块（分别在 798 行与 875 行），代码段之间是完全的物理复制，没有做到逻辑与结构上的去重。

### 修复方案
在后台进行模块化重构时，将所有的 7 大模块拆分为各自独立的 HTML 文件：
1. 彻底去除了原本合并在 `admin.html` 中繁琐的 accounts、browser-accounts、models、jimeng-models、usage、settings 页面，分别抽取成 `public/accounts.html`, `public/browser-accounts.html`, `public/models.html`, `public/jimeng-models.html`, `public/usage.html`, `public/settings.html`。
2. 在新抽离出的 `public/jimeng-models.html` 页面中，彻底清除并剔除了重复的那个 `activePage === 'jimeng-models'` 的 HTML 块，仅保留一份纯净、唯一的 DOM 段。
3. 统一了各页面侧栏跳转链接的指向，支持了 MPA (多页面应用) 跳转与各自的 Vue App 隔离加载。

### 经验与教训
- **模板代码审查**：在编写长文件或单页面巨石应用时，要注意代码复制带来的模板冗余，尤其是带有 `v-if` 或 `v-show` 的条件块。
- **模块化设计的优越性**：尽早把臃肿、大体量的多模块单页面文件重构成松耦合、小体积的独立模块或多页面，可以从根本上解决模板重复渲染等维护黑洞。

---

## Bug #32: MPA 页面切换延迟与频繁加载外部 CDN 导致的白屏闪烁

**日期**：2026-06-04

### 问题描述
将原本臃肿的 `admin.html` 拆分为 MPA（多页面应用）后，管理员在后台点击侧边栏切换“渠道管理”、“浏览器账号”、“即梦模型”等页面时，会出现非常明显的白屏闪烁和加载延迟（约 500ms~2s）。这严重影响了后台系统的操作流畅度。

### 根本原因
在 MPA 模式下，每次页面跳转（如 `accounts.html`、`browser-accounts.html`）都会导致浏览器重新向网络或缓存拉取巨型的外部 CDN 依赖（Tailwind CSS, Vue 3, Lucide 图标等），并重新编译 Tailwind 主题和解析 Vue 实例，这造成了极高的页面载入和脚本初始化延迟。

### 修复方案
将系统重构为 **静态模板预载单页面应用 (Pre-loaded Templates SPA)**：
1. **静态 HTML 模块化**：将各功能模块的纯 DOM 结构放置在 `public/templates/` 目录下的独立 HTML 片段中（如 `accounts.html`）。
2. **逻辑高度抽离**：将各页面的 Vue setup 逻辑合入 `public/js/admin.js` 中进行统一管理，解耦 DOM 与逻辑。
3. **外壳预载与 0ms 路由**：`admin.html` 作为 SPA 唯一的入口外壳，挂载所有模板的占位符。在 Vue 挂载前通过并行 `fetch` 预先将模板片段塞入 DOM 树，由 Vue 3 统一编译。页面切换通过 `window.location.hash` 配合 Vue 的 `activePage` 变量进行 `v-if` 条件渲染。
4. 切换无任何网络请求，响应时间降低为 **0 毫秒**，彻底消除了白屏闪烁。

### 经验与教训
- **依赖与网络开销权衡**：重度依赖 CDN 资源（如 Tailwind, Vue 运行时编译）的应用，应避免频繁跨页面加载（MPA），而应优先选择 SPA 架构。
- **模板与逻辑的合理拆分**：在 SPA 开发中，我们可以使用原生 `fetch` 并行预载 HTML 片段并动态更新占位符，从而在保持开发期“多文件模块化、高可维护”的同时，享受到 SPA 运行期的“零延迟、无白屏”体验。

---

## Bug #33: 物理删除旧版 MPA HTML 页面后导致用户历史浏览器标签及书签访问 404

**日期**：2026-06-04

### 问题描述
完成 SPA 架构重构并物理删除了根目录下原有的 `/public/models.html`、`/public/accounts.html` 等文件后，若用户浏览器此前保留了这些页面的历史标签页，或者用户点击了收藏的书签直接访问（例如：`http://127.0.0.1:5566/models.html`），浏览器会收到 404 Not Found 响应，无法正常打开系统。

### 根本原因
由于之前的 MPA 路由是物理路径路由，重构为 SPA 后，原有的 HTML 物理文件不复存在，Koa 服务器的静态资源拦截器找不到 `/models.html` 等文件，直接落入 404 未定义路由的处理逻辑。

### 修复方案
在 Koa 静态资源与错误路由拦截层（`src/lib/server.ts`）中，对历史遗留的 HTML 路径进行安全重定向拦截：
1. 拦截对 `/accounts.html`、`/browser-accounts.html`、`/models.html`、`/jimeng-models.html`、`/usage.html`、`/settings.html` 的 GET 请求。
2. 识别出目标页面标识（如 `models`）。
3. 状态码设为 `302`，调用 `ctx.redirect('/admin.html#<pageId>')` 重定向到 SPA 主入口的外壳相应 hash 路由上。
4. 保证了用户历史链接的向后兼容，实现无缝平滑过渡。

### 经验与教训
- **过渡期向后兼容性原则**：在进行从 MPA 到 SPA 或者是 API 路由大重构物理删除文件时，必须设计针对旧路径的重定向或优雅降级（Graceful Degradation）策略，避免直接向用户展示 404 或故障页面。

---

## Bug #34: 管理后台重构 HTML 模板导致重启服务进程按钮丢失

**日期**：2026-06-04

### 问题描述
在进行 SPA 架构重构时，由于原先的按钮在重构中遗漏，导致管理面板全局的“重启服务”按钮丢失，使得管理员无法远程重启后台 Node.js 服务。

### 根本原因
重构时删除了页面中调用 `restartService` 的 DOM 结构，且原先的 Danger Zone 卡片较深。用户更倾向于将其作为一个高频、显眼的系统级按钮放置于页面顶部状态栏。

### 修复方案
1. 废弃了设置页面底部的重启卡片。
2. 在 [admin.html](file:///d:/daima/doubao-free-api-master/public/admin.html) 顶部的全局 `<header>` 区域，在版本号卡片旁边添加了一个 4 字的 `重启服务` 按钮，绑定 `@click="restartService"`。采用 `glass-card` 及 `text-danger` 统一样式，确保美观与易用性。

### 经验与教训
- **按钮布局合理性**：系统基础级的快捷操作（如重启、刷新等）比起藏在多级子页面深处的卡片中，放在全局可见的顶部头部状态栏更加实用且醒目。
- **模板迁移与重构校验**：在拆分重构庞大的单页应用时，要保证全局共用操作的入口不要丢失。

---

## Bug #35: 即梦本地上传图片和视频时由于使用了未定义的 calculateCRC32 函数导致上传失败

**日期**：2026-06-04

### 问题描述
在进行即梦视频生成/图生视频测试时，如果通过本地图片上传（multipart/form-data），服务端会在获取上传令牌后报 `首帧图片上传失败: util_default.calculateCRC32 is not a function` 错误，导致上传和视频生成过程中断。

### 根本原因
1. `src/jimeng/lib/image-uploader.ts`（第 58 行）以及 `src/jimeng/lib/video-uploader.ts`（第 146 行）调用了未定义的 `util.calculateCRC32` 方法（该方法在主项目的 `src/lib/util.ts` 中缺失）。
2. 如果简单地替换为已有的 `util.crc32` 方法，由于该方法返回的是十进制有符号整数（如 `289740408`），而字节跳动 TOS 与 VOD 的上传 HTTP Headers 中 `Content-CRC32` 要求必须传入 8 位的十六进制无符号填充字符串（如 `114514ab`），这会触发校验失败导致接口返回 `UriStatus=2001`。

### 修复方案
1. 重新在主项目的 [util.ts](file:///d:/daima/doubao-free-api-master/src/lib/util.ts) 中补充并实现 original 版本的 `calculateCRC32(buffer: ArrayBuffer)` 方法，确保正确返回前导零填充的 8 位 16 进制字符串。
2. 将 `image-uploader.ts` 和 `video-uploader.ts` 还原为调用 `util.calculateCRC32`。

### 经验与教训
- **外部模块对齐**：从其他地方集成或拷贝代码时，必须仔细验证调用的工具方法（如 `calculateCRC32` 与 `crc32`）命名是否在当前项目中完全一致，避免由于接口命名微小差异导致运行时崩溃。
- **强化本地链路测试**：高开销/复杂调用链路（如图片和视频多段上传）在做重构或打包合并后，应编写健全的测试脚本模拟全流程，以便及早抓到类似拼写或引用未定义方法的错误。

---

## Bug #36: 浏览器托管账号由于 Token 为空导致 releaseToken 释放错误账号，从而导致特定账号永久卡在繁忙 (BUSY) 状态

**日期**：2026-06-19

### 问题描述
在使用多个浏览器托管账号（`authMode: manual_browser_login`）时，对其中任意账号发起图片/视频生成请求后，该账号的状态在请求结束后会永久卡在 `BUSY`（繁忙）状态。在管理后台页面上，即使刷新页面或终端显示冷却完毕，其状态依然卡在繁忙，而另一个毫无关系的浏览器账号却错误地进入了冷却和空闲状态。

### 根本原因
1. **浏览器账号 Token 缺省为 `""`**：在创建浏览器托管渠道时，由于没有立即提供真实的 API Key/Session ID，其 `token` 字段默认为空字符串 `""`。
2. **多账号 Token 冲突**：当配置了多个浏览器账号且尚未全部登录，或者登录已过期时，它们在 `this.accounts` 数组中的 `token` 都是 `""`。
3. **按 Token 匹配时“指鹿为马”**：请求结束时，路由层调用 `releaseToken(account.token)`（实际参数为 `""`）。`AccountManager` 内部通过 `this.accounts.find(a => a.token === token)` 去查找匹配的账号，由于是按空字符串查找，它永远只能匹配到**数组中第一个** token 为空字符串的浏览器账号（比如 Account A），并将其释放，而**实际执行请求并被锁定的另一个账号**（比如 Account B）则因无法被匹配到，状态永远留在了 `BUSY` 状态。

### 修复方案
1. **为无 Token 账号赋予唯一标识兜底**：
   - 修改 [account-manager.ts](file:///d:/daima/doubao-free-api-master/src/lib/account-manager.ts)：在 `addAccount` 新增账号和 `loadAccounts` 加载持久化账号时，如果账号的 `token` 为空，则默认使用账号的 `id`（UUID）作为其 `token`。
   - 当浏览器账号成功探活/登录获取到真实的 `sessionid` 时，会自动覆盖为此真实 `sessionid`（仍然保持唯一性）。
2. **提升 `releaseToken` 查找的健壮性**：
   - 改进 `releaseToken` 和 `setTimeout` 内部的对象查找机制，优先通过传入的参数进行 `id` 查找，如果查找不到，再退回进行 `token` 查找。这样即使外面传入的是 `id` 还是 `token` 都能精确解除锁定，避免因空值引起释放混乱。

### 经验与教训
- **全局唯一字段不应允许空字符串冲突**：在以某个关键字段（如 Token、Email、Username）作为资源查找或哈希的 Key 时，如果有多个实例的该字段为空，必须使用唯一 ID（如 UUID）进行兜底填充，否则基于 Key 查找和更新的状态机必定会导致“指鹿为马”的严重 Bug。
- **状态流转多用 ID 替代 Token**：在业务逻辑路由层与底层状态机交互（锁/释放）时，推荐传递更具唯一性和不可变性的 `id`，而非可能发生动态变动或为空的凭证/Token。

3. **彻底隔离浏览器托管账号与 API 渠道状态锁**：
   - 在 `getAccountByToken`、`releaseToken` 查找方法中添加了 `!this.isBrowserManagedAccount(a)` 过滤，确保 API 接口调度（对话/绘图等）仅匹配和操作标准 API 渠道账号，完全排除只用于保活/探活的浏览器托管账号的状态干涉。
   - 同时将 `getAccountsData` 的调试日志输出过滤掉浏览器托管账号，保持排查日志的精简和纯粹。

---

## Bug #37: 豆包Pro模型非流式对话响应中跳过删除会话

**日期**：2026-07-03

### 问题描述
在使用 `doubao-pro` 模型发起非流式（`stream: false`）对话请求时，系统日志频繁报 `[warning][chat.ts] 跳过删除会话，因为 convId 为空或无效`，且用户在账号的网页端能看到遗留的历史对话，无法按预期自动清理会话。

### 根本原因
在 `src/api/controllers/chat.ts` 的 `receiveStream` 函数（用于在后台接收完整的流响应并返回非流式结果给客户端）中，忽略了 `STREAM_MSG_NOTIFY` 和 `FULL_MSG_NOTIFY` 两个关键事件，并直接 `return;`。这两个事件包含会话在豆包服务端的 `conversation_id`。因为忽略了它们，导致 `data.id` 保持为空，最终在 `createCompletion` 完结触发 `removeConversation` 时由于没有有效的 `convId` 而跳过删除，导致网页端残留历史对话。

### 修复方案
在 `receiveStream` 的事件流解析中，针对 `STREAM_MSG_NOTIFY` 和 `FULL_MSG_NOTIFY` 事件添加解析逻辑，从而正确提取 `conversation_id` 并赋值给 `data.id`，与流式响应逻辑 `createTransStream` 保持一致：
```typescript
                if (event.event === "STREAM_MSG_NOTIFY" || event.event === "FULL_MSG_NOTIFY") {
                    const rawResult = _.attempt(() => JSON.parse(event.data));
                    if (!_.isError(rawResult)) {
                        const cid = rawResult?.meta?.conversation_id || rawResult?.message?.conversation_id;
                        if (cid && !data.id) {
                            data.id = cid;
                        }
                    }
                    return;
                }
```

### 经验与教训
- **非流式与流式分支的行为一致性**：在封装和对接同一端点时，无论流式还是非流式接收，都必须对底层的流协议保持完全相同的元数据解析逻辑，确保像 `conversation_id` 这样关键的生命周期控制字段在两个分支中都能被正确捕捉和处理。

