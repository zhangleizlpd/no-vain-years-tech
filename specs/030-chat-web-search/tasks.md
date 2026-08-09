---
feature_id: 030-chat-web-search
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready # +A1 amend Phase 7 (2026-06-19): T018-T025 pending (ChatGPT 式统一联网)
created_at: '2026-06-18'
updated_at: '2026-06-19'
---

# Tasks: 030-chat-web-search（AI 对话智能搜索 · DeepSeek 联网 ReAct）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `030-chat-web-search` | **架构源**: [plan 文档](../../docs/private/plans/2026-06/06-18-chat-web-search-architecture.md)

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）；`[USx]` = user-story 阶段 task 带；层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Verify]`
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；纯函数（`web-search.rules` / `sse.rules`）= vitest 无 DB；UC 读写 DB + ReAct loop = **Testcontainers PG**（`nx test server <file>`，cwd=apps/server，新文件首跑 `--skip-nx-cache`）；mobile 纯逻辑（`sse-parse` / `chat-reducer` / `use-chat`）= vitest，UI·render·a11y = Playwright Expo Web e2e
- 无 task-meta JSON（**manual 模式**，per 004-029）
- 🚨 **030 在 027/029 上增量**（plan）：复用 027 `chat` 叶子 ctx + `LlmProvider`/`deepseek.provider` + SSE 链路 + `JwtAuthGuard` scope→404 + Orval typed hook；复用 028 会话切换/冷启动 hydrate；复用 029 会话 model 路由（flash/pro）。**新增**：`SearchProvider` port + IQS adapter（chat 自身 infra，类比 LlmProvider）+ `LlmProvider` tool-calling 扩展（向后兼容）+ `send-message` ReAct loop + SSE 工具帧 + `Message.metadata Json?`（**唯一 schema 改动 + 1 migration**）
- 🚨 **用户身份 = `accountId`**（`req.user.accountId` + `JwtAuthGuard`）；联网 send 复用 027 scope `findFirst({where:{id, accountId}})`，他人/不存在 → **404 字节级一致**（反枚举）；未认证 → **401**（003 refresh）
- 🚨 **server 零新 npm dep**（plan D2）：IQS 走 Node 22 内建 `fetch` HTTP API（`X-API-Key`），SDK `@alicloud/iqs20241111` 仅回退、**不预装**；**impl T003 硬前置**：env-gated `RUN_IQS_IT` 先验 HTTP 真连通，不通切回退路。**mobile 1 新 dep** `expo-web-browser`（`expo install`，T013）
- 🚨 **LlmProvider 向后兼容**（plan D3）：`stream` 产出改事件联合（`token`|`tool_call`），**无 `tools` 时行为同 027**（纯 token）；027/029 非联网路径零回归——IT 显式回归断言
- 🚨 **send-message 联网分支 split-tx**（plan D4）：ReAct loop（多次 `LlmProvider.stream` + `SearchProvider.search` HTTP）**全程 tx 外**，**禁 tx 内持锁等 HTTP**；user msg 落库（短写）→ loop（tx 外）→ assistant msg + metadata（短写）。abort 透传 signal 止付 token + 取消在途检索
- 🚨 **调参锁定**（plan）：search top-K=**5** / per-search 硬超时 **8s** / max **3** 轮 / `tool_choice='auto'`（模型自决）
- **单 PR（per Constitution §V）**：`feat(chat)` —— server（port+adapter+LlmProvider 扩展+loop+migration）+ 真 server IT + export-openapi + api-client regen + mobile 消费 + 两层验证全原子 merge。**触部署**（新 env `IQS_*`）。⚠️ **改 027 核心发送链路 + schema migration + 不确定的 IQS 接入** → **倾向人工合并复核、不接 auto-merge**（plan PR 策略，待 user 定）
- 🔄 **A1 amend（2026-06-19，spec Session 2026-06-19）**：T001-T017 = 030 原始已 ship（手动 toggle / 仅 DeepSeek 联网 / MiniMax 灰显）。**Phase 7（T018-T025）= ChatGPT 式统一**：去 toggle + 联网默认常开 + MiniMax M3 经 `thinking:adaptive` 纳入。M3 国内站 tool-call PoC（disabled 不可靠 / adaptive 15/15）见 spec；受影响验证矩阵行已标 `⚠️ A1`。

## Path Conventions

- server：`apps/server/src/chat/`（**既有扁平 module**，加 port/adapter/UC/rules，无新 module 注册）；schema `apps/server/prisma/schema.prisma`（`Message.metadata`）+ migration；config `apps/server/src/config/iqs.config.ts`；IT `apps/server/test/integration/*.it.spec.ts`
- contract：`apps/server/openapi.json`（`nx run server:export-openapi`，canonical `node dist/main.js`）→ `packages/api-client/`（Orval `nx affected -t generate`）
- mobile：`apps/mobile/src/chat/`（**既有 feature dir**，加 `web-search-sources.tsx` + 扩展 `use-chat`/`sse-parse`/`chat-stream-client`/`chat-reducer`/`chat-home-screen`）；`~/theme`/`~/ui` 零新 token；新 dep `expo-web-browser`
- e2e：`apps/mobile/e2e/chat-web-search.spec.ts`（mock SSE 工具帧/降级帧/sources）；contract-smoke `apps/mobile/e2e/contract-smoke/chat-web-search.contract.ts`
- 部署：`docker-compose.tight.yml` + `deploy.yml`（`IQS_*` env 映射，**先读 `ops/runbook/prod-deploy-rollback.md`**）
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait`（:5433/:6380）；**本地 server IT/smoke/export-openapi 前 `env -u OSS_*`** + 显式 dev `DATABASE_URL`/`REDIS_URL`

---

## Phase 1: Server 基建 — SearchProvider port + IQS adapter（chat 自身 infra）

**Goal**：在既有 `chat` ctx 加搜索后端接口化 port + IQS adapter + Fake 替身（类比 027 `LlmProvider`），IQS 真连通先验后用。

- [X] T001 [P] [US1] [Server] **SearchProvider port + 纯函数 rules**：`apps/server/src/chat/search-provider.port.ts`（DI token `SEARCH_PROVIDER` + `interface SearchProvider { search(query, {signal, maxResults?}): Promise<SearchResult[]> }` + `SearchResult = {title;url;snippet;publishedAt?;content?}`）+ `apps/server/src/chat/web-search.rules.ts`（纯函数：① 来源**去重**（同 URL 合一）+ **全局唯一编号**（FR-006）② `web_search` tool-def 常量（JSON schema：`query` required + 可选 `time_range`）③ top-K 截取 helper，默认 5）。**验**：vitest 纯逻辑（去重保序 + 编号唯一稳定 / 多次检索重叠 URL 合并 / top-K 截断 / tool-def schema 形状）
- [X] T002 [US1] [US3] [Server] **IQS config + adapter + Fake + DI**：`apps/server/src/config/iqs.config.ts`（zod **discriminated-union** `kind:'mock'|'aliyun'`，镜像 `sms.config.ts`，`aliyun` 含 `apiKey`（HTTP `X-API-Key` 主路），boot `.parse()` 兜底）+ `apps/server/src/chat/iqs-search.provider.ts`（Node 22 `fetch` POST `cloud-iqs.aliyuncs.com/search/genericSearch`，归一化 `pageItems[]`→`SearchResult[]`：`link→url`/`publishTime→publishedAt`/`markdownText??mainText→content`；per-search 硬超时 **8s**→throw）+ `apps/server/src/chat/fake-search.provider.ts`（scripted results + 可注入 error/timeout/空结果，尊重 signal，同 `fake-llm.provider.ts` 套路）+ `chat.module.ts` DI（`SEARCH_PROVIDER` factory：`CHAT_FAKE_SEARCH=1`→Fake，否则 IQS）。**验**：vitest（config union 解析 mock/aliyun + 缺 key boot 报错 / IQS 归一化字段映射 + 超时 throw / Fake scripted + error 注入 + signal abort）
- [X] T003 [US1] [Server-IT] **IQS 真连通冒烟（env-gated，先验后用）**：`apps/server/test/integration/iqs-search.it.spec.ts`（`describe.skipIf(!process.env.RUN_IQS_IT)`，per env-gated perf-IT 范式，默认 skip 不进 CI fast suite）——真 key 调 IQS HTTP `genericSearch` 验返 `pageItems[]` 可归一化。🚨 **D2 硬前置**：HTTP 主路不通 → 切回退 SDK `@alicloud/iqs20241111`（复用已装 `@alicloud/openapi-core` AK/SK），**两路同归一化、不动 port**；记录实测结论于 task commit message（价格/配额待阿里云 AE，不阻塞）。✅ **D2 实测定稿（2026-06-18 RUN_IQS_IT 真连通）**：HTTP 主路可用 = **GET `?query=` 标准接口**（非 POST+JSON，POST 返 404）；GET 默认返 markdownText/mainText/publishTime/snippet；results=5 往返 ~984ms（perf 内）→ **不切 SDK、零新 dep**（adapter GET 修复见后续 fix commit）

## Phase 2: Server — LlmProvider tool-calling 扩展（向后兼容）

**Goal**：把 027 `LlmProvider.stream` 从纯文本扩为事件联合支持 tool calling，DeepSeek 累加流式 tool_calls + 双形态解析；27/029 非联网路径零回归。

- [X] T004 [US1] [Server] **LlmProvider 接口扩展 + 各 provider 适配**：`apps/server/src/chat/llm-provider.port.ts`（`stream` 产出 `AsyncIterable<string>`→`AsyncIterable<LlmStreamEvent>`，`type LlmStreamEvent = {kind:'token';text} | {kind:'tool_call';calls:ToolCall[]}`；`LlmStreamOptions` 加可选 `tools?`；`Msg` 扩 `role:'tool'`（`toolCallId`）+ assistant `toolCalls`）+ `deepseek.provider.ts`（透传 `tools`+`tool_choice:'auto'`；流式按 `delta.tool_calls[index]` 累加（`id`/`name` 取一次、`arguments` 分片拼接），`finish_reason==='tool_calls'` 收口吐 `{kind:'tool_call'}`，否则 `delta.content` 吐 `{kind:'token'}`；**双形态解析** DeepSeek 偶发 tool_call 当文本吐——content 内 tool-call 模式兜底正则）+ `minimax.provider.ts`（不支持 tools，永远只吐 `{kind:'token'}`）+ `llm-router.provider.ts` + `fake-llm.provider.ts`（扩 scripted：可编排「轮1 吐 tool_call(web_search,query) → 轮2 吐 text」供 loop IT）+ 各 `*.spec.ts` 改。**验**：vitest/IT（无 tools=纯 token 行为同 027【**零回归断言**】/ deepseek 累加分片 tool_calls 成完整 call / 双形态：结构化 tool_calls 与 content 文本兜底都解析 / minimax 永不吐 tool_call / fake-llm scripted 两轮）。🚨 接口迁移**原子**（port+4 provider+spec 同 typecheck 过）；上界偏大但不可半改
- [X] T005 [US1] [Server-IT] **provider tool 事件闭环 IT**：`apps/server/test/integration/llm-tool-stream.it.spec.ts`（全 boot + FakeLlmProvider env 注入）—— scripted「tool_call → 喂回 tool result → text」单 provider 层闭环，断言事件序列 + `Msg` tool 角色回灌 shape（assistant.toolCalls + tool.toolCallId 匹配）

## Phase 3: Server — 系统提示层 + ReAct loop + schema（US1 核心 + US2 持久化 + US3 降级）

**Goal**：`send-message` 联网分支跑 ReAct loop（max3 + 降级 + split-tx），落 assistant message + sources 元数据；非联网走 027 单轮零改；spec state_branches server 段全覆盖。

- [X] T006 [P] [US2] [Server] **Message.metadata schema + migration**：`apps/server/prisma/schema.prisma` `Message` 加 `metadata Json? @map("metadata")`（**加性可空**，旧消息 null 正常）+ `prisma migrate dev` 产 migration。**验**：migration apply 干净 + 既有 message 读取不破（旧行 metadata=null）；`nx test server` 既有 chat IT 回归绿
- [X] T007 [P] [US1] [US3] [Server] **SSE 工具帧（纯函数，向后兼容）**：`apps/server/src/chat/sse.rules.ts` 加 `toSseToolStartFrame({query})` / `toSseToolResultFrame({count,sources})` / `toSseDegradedFrame()` / `toSseSourcesFrame(sources)`（token/DONE/error 帧**不变**）。**验**：vitest（各帧 `data:...\n\n` 形状 + JSON 转义 + 与旧 token/DONE/error 帧前缀不冲突，解析端可分派）
- [X] T008 [P] [US1] [Server] **可组合系统提示层（D8，纯函数）**：`apps/server/src/chat/system-prompt.rules.ts` —— `SystemPromptContext={webSearch;now:Date;locale?}` + 两个真实层纯函数 `webSearchSteering(ctx)`（联网时返「实时/最新/时效类问题优先 web_search 检索再答 + 标来源；寒暄/稳定常识可不搜」）+ `dateContext(ctx)`（联网时返「当前时间=`{fmt(now,locale)}`，用于理解今天/本周/最近」）+ `composeSystemPrompt(ctx):string|null`（有序列表 `[webSearchSteering,dateContext]` map→filter(非 null)→`join('\n\n')`）。🚨 **不预置平台基座/用户自定义空 stub**（未来独立 feature；注释标优先级位：平台基座 prepend 列首 / 用户自定义 append 列尾）。**验**：vitest（webSearch=true 含 steering+日期文本 / webSearch=false 返 null / 注入固定 `now` 断言日期 / 拼接顺序 / 两层独立可测）。🚨 chat **首次引入 system prompt**，纯代码 0 DB
- [X] T009 [US1] [US2] [US3] [Server] **send-message ReAct loop + DTO + controller 接线**：`apps/server/src/chat/send-message.request.ts`（+`webSearch?:boolean` 默认 false，`@IsOptional @IsBoolean`）+ `send-message.usecase.ts`（**非联网**=027 单轮零改、**不注入 system 消息**；**联网**=ReAct loop：组 context → **prepend `composeSystemPrompt({webSearch:true,now:new Date(),locale:'zh-CN'})` 的 `system` 消息**（D8，置 token 窗口外 / history 前）+ 附 `web_search` tool + `tool_choice:'auto'` → `for round 1..3`：吐 token→onToken+累加 / 吐 tool_call→写 tool_start 帧+`SearchProvider.search`(top-K 5)+写 tool_result 帧+去重编号累加来源+回灌 assistant/tool msg+continue / 无 tool_call→收敛 break；round>3 兜底不附 tools 收敛；**降级**：search throw→`degraded=true`+停检索+无 tools 收敛作答（FR-009，user msg 不丢，零结果**不**标 degraded）；**split-tx** loop 全程 tx 外；落 assistant `content,status,metadata{webSearch,degraded,sources}`，abort→status=stopped 保留半成品+sources）+ `chat-stream.controller.ts`（透传 webSearch + 写工具/降级/sources 帧）+ `chat.response.ts`（GET messages 映射 `metadata`，贫血 JSON narrow）。**验**：T010 IT **先写 RED** 再本 task 转 GREEN（TDD，Constitution II；loop 行为全在 IT 断言）
- [X] T010 [US1] [US2] [US3] [Server-IT] **state_branches 全覆盖 IT**：`apps/server/test/integration/chat-web-search.it.spec.ts`（全 boot + Testcontainers PG + FakeLlmProvider + FakeSearchProvider env 注入）覆盖 spec **15 条** server 可验分支：OFF 无联网（不调 search + **无 system 消息**，行为同 027【回归】）/ **webSearch ON 注入 system 消息含 steering + 当日日期**（FakeLlmProvider 断言收到 `messages[0].role==='system'` 且含注入的固定日期文本）/ 模型自决不检索（scripted 无 tool_call→text）/ 多轮去重编号（scripted 2 轮重叠 URL）/ 超时降级带 `degraded`+user msg 不丢 / 零结果不标 degraded / max-3-轮兜底 / 流中 abort 中断整链+半成品 / 越权 404 字节级一致 / 未认证 401 / flash&pro 均可联网 / sources 落 `metadata` / 冷启动 GET messages 回填。中间态「已阅读 N」/ 来源 tap / in-app / **MiniMax 灰显** = mobile 段（T015）。🚨 **TDD：本 IT 先 RED 于 T009 impl**

## Phase 4: 契约同步（Nx-driven）

- [X] T011 [Contract] [Verify] **swagger + openapi + api-client regen**：`send-message.request` 加 `webSearch` swagger（`@ApiPropertyOptional({type:'boolean'})`）+ GET messages 响应 `metadata` schema（**nullable 字段显式 `type` per orval objectmap 坑 memory**：sources 数组 + degraded boolean + webSearch boolean，均 optional/nullable 显式声明）→ `nx run server:export-openapi`（canonical `node dist/main.js`，本地前 `env -u OSS_*`）→ `nx affected -t generate`（Orval regen）→ mobile typecheck 绿。⚠️ 不破坏 027/028/029 既有 chat 端点契约；SSE send 端点仍手写（工具帧不入 openapi，同 027）

## Phase 5: Mobile — toggle + 中间态 + 来源 + 降级（翻 DeepSeek baseline）

**Goal**：输入栏「智能搜索」toggle（per-message 默认关）；流式消费工具/来源/降级帧 → 渲染「已阅读 N 个网页」+ 编号来源列表（in-app 打开）+「本次未联网」降级标识；冷启动引用恢复。

- [X] T012 [P] [US1] [US3] [Mobile] **SSE 解析 + stream client 回调 + reducer 态**：`apps/mobile/src/chat/sse-parse.ts`（扩解析 tool_start/tool_result/degraded/sources 帧，按 payload 字段分派）+ `chat-stream-client.ts`（回调加 `onToolEvent`/`onSources`/`onDegraded`）+ `chat-reducer.ts`（`searchProgress` 中间态「已阅读 N 个网页」answer 开始时过渡 + message 挂 `sources`/`degraded`）+ vitest（解析各新帧 / reducer：tool_result 累加 N（N=累计原始页数，可 > 去重来源数，F3）/ token 开始清中间态 / sources 落 message / degraded 标记 / abort 中断中间态）。🚨 复用既有 expo/fetch 手写流（非 orval）；不破坏 027 token/DONE/error 解析
- [X] T013 [US1] [US2] [Mobile] **use-chat webSearch 态 + ChatMessage 扩 + hydrate**：`apps/mobile/src/chat/use-chat.ts`（`webSearch:boolean` 默认 false，per-message，传 `sendMessage(content,{webSearch})`；发送后留态不自动关；切会话/new 回默认关）+ `ChatMessage` 类型加 `sources?:Source[]`+`degraded?:boolean` + GET messages hydrate 从 `metadata` 回填（冷启动 SC-003，复用 028 hydrate）+ vitest（toggle 态传递 / new·select 回默认关 / hydrate 从 metadata 填 sources/degraded）。🚨 复用 028 `selectConversation`/`newConversation` 照接，别臆造；不动 027 发送链路
- [X] T014 [US1] [US2] [US3] [Mobile] **toggle UI + 来源/中间态/降级渲染（新 dep expo-web-browser）**：`expo install expo-web-browser` → `chat-home-screen.tsx` InputBar 加「智能搜索」pill toggle（tap 驱动，testID/a11y；**`model==='minimax'` 时灰显 disabled、点击无效**，FR-001/F2）+ 中间态「已阅读 N 个网页」展示（reducer `searchProgress`）+ 新 `apps/mobile/src/chat/web-search-sources.tsx`（assistant 气泡上「已阅读 N 个网页 ›」可折叠 + 答案下编号来源列表 tap→`expo-web-browser.openBrowserAsync(url)`，**http(s) scheme 校验**防注入 + 降级 message 显「本次未联网，基于已有知识作答」标识）+ `chat-copy.ts` 文案。复用 `~/theme`+`~/ui`（0 新 token）。**验**：UI·render·a11y 走 T015 e2e（per 测试分层 vitest=逻辑·Playwright=UI）
- [X] T015 [US1] [US2] [US3] [Mobile-E2E] **hermetic UI e2e**：`apps/mobile/e2e/chat-web-search.spec.ts`（Playwright Expo Web，mock SSE：工具帧/降级帧/sources/token + 003 refresh）验：开 toggle → 发实时问 → 「已阅读 N 个网页」中间态计数跳动 → 过渡到答案流 → 答案下来源列表 → tap 来源（mock `openBrowserAsync` 调用断言）→ 折叠/展开来源 → **关 toggle 发同问 → 无中间态无来源（OFF 无联网）** → 降级帧 → 显「本次未联网」标识 → 停止生成中断中间态 → **切 MiniMax 模型验 toggle 灰显不可点（F2）**。tap 驱动（非手势，per RNGH web memory）；`testMatch=*.spec.ts`
- [X] T016 [US1] [US2] [Contract-Smoke] **契约冒烟**：`apps/mobile/e2e/contract-smoke/chat-web-search.contract.ts`（node 层，生成的 `@nvy/api-client` 打 testcontainers 真 server + FakeLlmProvider/FakeSearchProvider env 注入）：登录 → 建会话 → `webSearch=true` 发消息（SSE）→ 解析验工具帧序列 + 最终答案 + sources → `GET messages` 验 `metadata.sources`/`degraded` 落库回填（契约对齐 URL/method/序列化/SSE 帧形状）→ 降级路径（Fake 注入 search error）验 `degraded=true` 落库。落共享套件 `nx run mobile:contract-smoke`

## Phase 6: 收尾

- [X] T017 [Verify] **PR gate + 部署门**：`env -u OSS_* pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main`（首跑 `--skip-nx-cache`）全绿 + moat/boundaries 0 violation（chat 仍叶子，`SearchProvider` 是 chat 自身 infra）+ `[Contract-Smoke]` 绿 + **部署**：`docker-compose.tight.yml` + `deploy.yml` 加 `IQS_*` env 映射（先读 `ops/runbook/prod-deploy-rollback.md`）+ PR body「部署存活前置确认」3-checkbox + spec `status: draft→implemented` + plan `status: drafted→approved` + tasks.md `[X]` 全同步。⚠️ **PR 倾向人工合并复核**（改 027 核心链路 + migration + IQS 接入不确定，plan PR 策略）——**不接 auto-merge**，PR 描述 flag「建议人工合并」

---

## Phase 7: A1 amend（2026-06-19）— ChatGPT 式统一联网（去 toggle + 默认常开 + MiniMax M3 纳入）

**Goal**：移除「智能搜索」开关，联网工具对所有支持模型默认常挂、模型 `tool_choice='auto'` 自决；DeepSeek flash/pro + MiniMax M3 统一（M3 经 `thinking:adaptive`）。依据 spec Clarifications **Session 2026-06-19** + M3 国内站 tool-call PoC（`disabled` 不可靠 / `adaptive` 需联网 6/6 触发、不需 9/9 不触发，合计 15/15）。

- [X] T018 [A1] [Server] **minimax.provider 接入 tool calling（adaptive + `<think>` 剥离）**：`apps/server/src/chat/minimax.provider.ts` —— ① `thinking` 由 `{type:'disabled'}` 改 `{type:'adaptive'}`（disabled 下工具调用不可靠，PoC 实证）② 透传 `opts.tools` + `tool_choice:'auto'`（去掉"刻意不透传"）③ 流式按 `delta.tool_calls[index]` 累加成完整 call（抄 `deepseek.provider` 累加逻辑），`finish_reason==='tool_calls'` 收口吐 `{kind:'tool_call'}` ④ **流式剥离内联 `<think>…</think>`**：跨 chunk 缓冲状态机（进 `<think>` 抑制 token、遇 `</think>` 恢复；标签会被拆在 chunk 边界，PoC 实证如 `"I shoulduse"`，须按缓冲匹配非整 chunk）。更新 `minimax.provider.spec.ts`。**验**：vitest（adaptive body 参数 / tools 透传 / tool_calls 分片累加成完整 call / `<think>` 跨 chunk 分片剥离干净、正文 token 不漏不多 / 无 tools 时仍纯 token）。🚨 反转 029「关思考求首字快/省钱」取舍（首字延迟↑+思考 token↑，spec 已记 user 接受）
- [X] T019 [A1] [Server] **send-message 去 webSearch gate → 全模型默认 ReAct loop**：`send-message.usecase.ts`（删 `webSearch===true` 分支，**所有会话模型默认走 ReAct loop**：附 `web_search` tool + `tool_choice:'auto'` + **默认 prepend `composeSystemPrompt` 的 system 消息**；模型不调 tool 则首轮 text 收敛=等价旧单轮）+ `send-message.request.ts`（**移除 `webSearch` 字段**）+ `chat-stream.controller.ts`（移除 webSearch 透传）+ metadata：`sources`/`degraded` 保留，`webSearch` 字段冗余 → **改记 `searched:boolean`（实际是否发生 tool_call，三态可分：凭知识答/搜零结果/搜到来源）**；`chat.response.ts` narrow 同步 `webSearch→searched`。删 orphan `runSingleTurn`（去 gate 后不可达）。🚨 027 字节兼容失效（system 消息默认注入，spec 已记为预期变化）。🔗 **跨 feature 影响（user 确认 A）**：031 自定义指令 IT 2×2 矩阵塌缩为恒联网 1D（非联网层组合仍由 `system-prompt.rules.spec` 单测覆盖，零真实覆盖损失）。**验**：T020 IT 先 RED 再转 GREEN ✅ 15/15
- [X] T020 [A1] [Server-IT] **state_branches IT 改造**：`apps/server/test/integration/chat-web-search.it.spec.ts` —— **删** OFF 无联网/无 system 消息回归断言（已无 OFF）；**改**为「所有发送默认注入 system 消息 + 挂 web_search tool」；**加** MiniMax 会话同样走 loop（FakeLlmProvider scripted tool_call，验 send-message 不再按模型 gate）；保留 模型自决不检索（scripted 无 tool_call→text，零成本路径）/ 多轮去重 / 降级 degraded / 零结果不 degraded / max-3 / abort 中断 / 越权 404 / 冷启动回填。**验**：Testcontainers 绿（先 RED 于 T019）
- [X] T021 [A1] [Contract] [Verify] **openapi regen（移除 webSearch）**：`send-message.request` 去 `webSearch` swagger → `nx run server:export-openapi`（canonical `node dist/main.js`，本地前 `env -u OSS_*`）→ `nx affected -t generate`（Orval）→ mobile typecheck 绿。⚠️ 不破坏 GET messages `metadata` 既有契约。**验**：openapi.json/api-client `webSearch`=0；`sendMessageRequest` 删 `webSearch?`；`ChatMessageMetadataResponse` `webSearch→searched`；mobile typecheck ✅（hydration 仅读 `metadata.sources/degraded`，不消费 `searched` → rename 零影响；mobile 本地 `webSearch` 态/手工 body 构造属 T022 scope，未消费 generated `SendMessageRequest`）
- [X] T022 [A1] [Mobile] **去 toggle + webSearch 态 + minimax 灰显**：`chat-home-screen.tsx`（删 `WebSearchPill` + `GlobeIcon` + InputBar 引用 + `model==='minimax'` 灰显逻辑）+ `use-chat.ts`（删 `webSearch` 态 + `setWebSearch` + `sendMessage` 不再传 webSearch + select/new 不再 reset）+ `chat-stream-client.ts`（删 `SendMessageOptions`/`options` 参 + body 恒 `{content}`）+ `chat-copy.ts`（删 orphan `webSearchToggle`）+ `index.ts`（去 `SendMessageOptions` export）。中间态「已阅读 N」/ 来源列表 / 降级标识渲染**保留**（现默认可能出现）。**验**：typecheck ✅ / vitest 798 ✅（use-chat 无 webSearch 态 + sendMessage 不带第 4 参 options；web-search-url 删 toggle 文案断言；hydrate mock `webSearch→searched`）/ lint 0 error
- [X] T023 [A1] [Mobile-E2E] **e2e 改造**：`apps/mobile/e2e/chat-web-search.spec.ts` —— 删 toggle tap / aria-checked / aria-disabled / webSearch body poll；改为：默认发实时问→模型检索→来源列表→tap 来源→折叠；发寒暄→模型自决不搜（plain SSE）无中间态无来源；切 MiniMax→同样可联网（来源出现，证不再 gate）；降级帧→「本次未联网」；停止生成中断。新增回归断言 `lastSendBody not.toHaveProperty('webSearch')`（证前端恒不带字段）。**验**：`nx run mobile:e2e chat-web-search.spec.ts` **6 passed** ✅
- [X] T024 [A1] [Contract-Smoke] **契约冒烟改造**：`apps/mobile/e2e/contract-smoke/chat-web-search.contract.ts` —— `streamSend` 去 `webSearch` 参 + body 恒 `{content}`（content-driven Fake 靠 `WebSrch` 关键字触发，不依赖 body 字段）；`metadata.webSearch→searched`（happy + 降级均 searched=true）；验工具帧序列 + sources 落库 + GET messages 回填仍对齐；降级路径不变。**验**：`nx run mobile:contract-smoke` 真后端 **14/14 全绿**（含 chat-web-search 030 ✅ + chat-custom-instructions 031 ✅，证 031 恒联网下不破）
- [X] T025 [A1] [Verify] **PR gate + 状态同步**：`env -u OSS_* pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main`（首跑 `--skip-nx-cache`）全绿 + `[Contract-Smoke]` 绿 + spec/plan/tasks `[X]` 同步 + spec `status: implementing→implemented`。**无新 env**（IQS/minimax 已在）→ 部署门按常规勾 3-checkbox（无 compose 新映射）。⚠️ 监测 MiniMax adaptive 首字延迟（观测项非 gate；IQS query+命中数 logger 可量搜索率前后变化）。改 027/minimax 发送链路 → **倾向人工合并复核**。**验**：lint/typecheck/test/build 1942 tests ✅(NX_EXIT=0) + runtime-smoke 98 + boot-smoke ✅(NX_EXIT=0) + contract-smoke 14/14 ✅；spec status→implemented

> **Phase 7 依赖**：T018 ∥ 独立；T018 → T019（minimax 走 loop 需 provider 支持 tools）；T019 ← T020（IT RED 先行）；T018+T019 → T021 → {T022, T024} → T023 → T025。

---

## Dependencies & 执行顺序

```text
T001(port+rules) ─► T002(iqs config+adapter+fake+DI) ─► T003(IQS 真连通冒烟)
T004(LlmProvider 扩展) ─► T005(provider tool 闭环 IT)
T006(schema metadata) ─┐
T007(SSE 工具帧)        │
T008(system-prompt 层)  ├─► T009(send-message ReAct loop) ─► T010(state_branches IT)
T001 + T002 + T004 ─────┘
T009 ─► T011(swagger+openapi+regen)
T011 ─► T012(sse-parse+reducer) ─┐
T011 ─► T013(use-chat+hydrate)   ├─► T014(toggle UI+来源+降级) ─► T015(Mobile-E2E)
                                 ┘
T011 ─► T016(Contract-Smoke 真 server)
全部 ─► T017(PR gate + 部署门)
```

- **MVP（US1 最小闭环）**：T001 → T002 → T004 → T006 → T007 → T008 → T009 → T010 → T011 → T012 → T013 → T014 —— 开智能搜索 → DeepSeek 联网读网页（steering+日期 grounding）→ 「已阅读 N 个网页」+ 带引用作答，单这条链已交付本 feature 核心价值（解图二死路）。
- **US2（来源持久化/恢复）**：T006（metadata）+ T009（落库）+ T010（IT 验）+ T013（hydrate 回填）+ T014（来源列表）+ T015/T016。
- **US3（失败降级）**：T002（Fake 注入 error）+ T009（降级分支）+ T010（IT 验 degraded）+ T012（降级帧解析）+ T014（降级标识）+ T015。
- **并行**：T001/T004/T006/T007/T008 互不依赖可并行（不同文件）；T003 与 T004/T006/T007/T008 并行；mobile T012/T013 在 T011 后并行（不同文件），T014 需二者；T016 与 T012-T015 并行（不同测试道）。

## 验证矩阵映射（spec → task）

| spec | 覆盖 task |
|---|---|
| FR-001 toggle 正交默认关 per-message + MiniMax 灰显 | T013 / T014 — **⚠️ A1**：toggle 移除 → T022；MiniMax 不再灰显（adaptive 纳入）→ T018 / T022 / T023 |
| FR-002 联网检索 + 模型自决 + steering 系统提示 | T004 / T008 / T009 / T010 / T015 |
| FR-003 DeepSeek 本尊作答不替换 | T004 / T009 / T010 |
| FR-004 「已阅读 N 个网页」中间态（N=原始页数） | T007 / T012 / T014 / T015 |
| FR-005 来源查看 + in-app 打开 | T014 / T015 |
| FR-006 来源去重 + 编号唯一 | T001 / T009 / T010 |
| FR-007 来源持久化 + 冷启动恢复 | T006 / T009 / T013 / T016 |
| FR-008 OFF 维持无联网（含无 system 消息） | T009 / T010 / T015 — **⚠️ A1**：无 OFF 态，等价=模型自决不检索（零成本路径）→ T019 / T020 / T023 |
| FR-009 失败降级 + 标识 + 不丢消息 | T002 / T009 / T010 / T014 / T016 |
| FR-010 检索轮数上限 3 | T009 / T010 |
| FR-011 停止生成中断整链 | T009 / T010 / T012 / T015 |
| FR-012 search 接口化 + key 留 server | T001 / T002 |
| FR-013 越权 404 + 401 | T009 / T010 |
| 联网 steering + 日期 grounding（D8 / F1） | T008 / T009 / T010 |
| SC-001 实时答案带来源（对比 OFF） | T009 / T010 / T015 / T016 |
| SC-002 「已阅读 N」中间态 | T012 / T015 |
| SC-003 来源 100% 持久化恢复 | T006 / T009 / T013 / T016 |
| SC-004 默认关 + OFF 零联网 | T013 / T015 — **⚠️ A1**：无开关；零成本=模型自决不搜（寒暄/常识/写作 9/9 不触发）→ T020 / T023 |
| SC-005 失败不丢不整条失败 | T009 / T010 / T016 |
| SC-006 作答模型始终所选 DeepSeek | T004 / T009 / T010 |
| SC-007 越权/未认证按 404/401 | T010 |
| SC-008 检索轮数不超上限 | T009 / T010 |
| state_branches ×15 | T010（server 段）/ T015（mobile 段）— **⚠️ A1**：去 OFF/灰显分支、加 M3 adaptive 联网分支 → T020（server）/ T023（mobile）|
