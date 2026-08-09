---
feature_id: 037-ideation-mockup-delivery
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-27'
updated_at: '2026-06-27'
---

# Tasks: 037-ideation-mockup-delivery（ideation mockup 交付链路 + App 渲染 · Phase D §A）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `037-ideation-mockup-delivery` | **设计源**: [Phase D §A/§E](../../docs/private/plans/2026-06/06-27-ideation-mockup-phase-d-delivery-seam.md)（Q2 联网核业界）+ [ADR-0045](../../docs/adr/0045-object-storage-image-upload.md)（OSS 直传）+ [ADR-0058](../../docs/adr/0058-server-integrations-layer.md)（平台层）+ [mockup](./design/)（代码是真相源，不逐 pixel 同步）

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）；`[USx]` = user-story 阶段 task 带（Foundational/Polish 不带）；层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Verify]`
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；纯函数（prefix 归属校验 / screens 规整 / 事件归属派生 / version rank）= vitest 无 DB；server 端点 + UC = **Testcontainers PG+Redis + fake-oss + 种子 claimed `agent_queue_event` 行**（`nx test server <file>`，cwd=apps/server）；mobile 纯逻辑 = vitest，UI·render·渲染隔离 = Playwright Expo Web e2e（mockup 产物 + 读列表经 `route.fulfill`）
- 无 task-meta JSON（**manual 模式**，per 004-036）
- 🚨 **上传执行方 = channel（agent-platform 仓，仓外独立 PR）**：本 feature **只提供 server 契约 + mobile 消费**。server IT / contract-smoke **模拟 worker**——种子一条 claimed `agent_queue_event`（bizType=ideation mockup, bizId=sessionId, accountId）+ 直接持 worker token 调端点，不依赖真 channel
- 🚨 **凭证 / 写记录 = worker-token，scope server 派生（Q2 终判）**：(accountId, sessionId) **永远** server 据 claimed event 派生，**channel 不得自报**（防越权 + 混淆代理）。跨 ctx **只读** `agentQueueEvent` 派生 = `// CROSS-CONTEXT-READ` 注释化（Q7-B），**永不跨 ctx 写**
- 🚨 **读列表 = account-token（JwtAuthGuard）**：app 用户读自己 session 的 mockup；他人 / 不存在 session → 字节级一致 404（反枚举，沿 036 FR-013）
- 🚨 **`IdeationMockup` 首建（ADR-0035 expand）**：`screens` 贫血 Json（逐屏标签字符串数组，无锚点）；**append-only**（多版多行、新版不覆盖、无 updatedAt）；version 序 app 按 createdAt rank 派生**不落列**；无 mapper / 无 Domain Class（raw row）
- 🚨 **OSS 签名器参数化 content-type（平台层安全改）**：`buildPostObjectCredential` content-type 白名单 硬绑 `IMAGE_WHITELIST` → 改**入参**（默认仍 image，向后兼容）；mockup 传 `['text/html']`。account / ideation-image 调用方**零变**
- 🚨 **新依赖 `react-native-webview`（stop-signal #2）**：native 内嵌隔离渲染；**静态硬化** `javaScriptEnabled={false}` + `originWhitelist`(备案域) + `onShouldStartLoadWithRequest` 拦外链 + CSP。引库 task → app rebuild + PR 列 research.md R3 选型 + 硬化配置
- 🚨 **新 EP 进 OpenAPI**：api-client **DOES regen**（凭证 fn + 写记录 fn + 读列表 fn）；mobile **必须**调生成 fn，**禁手写** fetch/axios（worker-token 端点由 channel 调、不在 mobile；mobile 只调 account-token 读列表）
- 🚨 **2 个仓外/前置依赖（不在本 PR）**：① channel inline+upload（agent-platform 仓）② 备案自定义展示域（native 内联渲染前置 infra；读列表返 objectKey→域 URL，域名配置化）。native 隔离渲染 + 备案域内联留**真机手动验证**（web_compat: untested）
- **单 PR（per Constitution §V）**：`feat(ideation)` —— server（IdeationMockup + oss 参数化 + worker guard 共享 + 3 端点）+ 真 server IT + api-client regen + mobile 消费（viewer + webview 渲染 + 多版切换 + 状态态）+ 两层验证全原子 merge

## Path Conventions

- server 平台层（改）：`apps/server/src/integrations/oss/oss-policy.ts`（CHANGE content-type 白名单参数化）+ 既有 `account` / `ideation` image 调用方传 image 白名单（零行为变）
- server 鉴权（改）：`apps/server/src/security/`（worker-token guard 共享落点——把 `agent-bridge/worker-auth.guard.ts` 提升/re-export 供 ideation 复用，platform infra per ADR-0041）；`agent-bridge/` 调用方零变
- server ideation（新/改）：`apps/server/src/ideation/` 的 `mockup-credential.{controller,request,usecase}.ts`（new，worker-token）+ `mockup-record.{controller,request,usecase}.ts`（new，worker-token 写）+ `mockup-list.{controller,response,usecase}.ts`（new，account-token 读）+ `mockup.rules.ts`（new，prefix 归属校验 + screens 规整 + version rank 纯函数）+ `claimed-event-ownership.ts`（new，`// CROSS-CONTEXT-READ` 读 agentQueueEvent 派生归属）+ `ideation.module.ts`（CHANGE）
- schema：`apps/server/prisma/schema.prisma`（`IdeationMockup` model）+ migration
- server IT：`apps/server/test/integration/ideation-mockup-delivery.it.spec.ts`（new）
- mobile（新/改）：`apps/mobile/src/ideation/` 的 `use-session-mockups.ts`（new，react-query 调生成读列表 fn，fetch-on-open）/ `MockupRenderer.tsx`（new，react-native-webview 隔离渲染 + Web `<iframe sandbox>` 退化）/ `MockupVersionStrip.tsx`（new，多版 chips）/ `SessionMockupScreen` 装配 + 空/加载/错误态 / `ideation-copy.ts`（CHANGE 加文案）
- mobile 路由（新）：`apps/mobile/app/(app)/(tabs)/ideation/mockups.tsx`（Expo Router，挂载点 tasks 定）
- e2e：`apps/mobile/e2e/ideation-mockup-delivery.spec.ts`（new，读列表 + 产物经 `route.fulfill`）；contract-smoke `apps/mobile/e2e/contract-smoke/ideation-mockup.contract.ts`（new）
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait`（:5433/:6380）；**本地 server IT/smoke 前 `env -u OSS_*` + 显式 dev `DATABASE_URL`/`REDIS_URL` + `MARKETDATA_PROVIDER=mock`**

---

## Phase 1: Foundational — Server 表 + 平台层参数化 + worker guard 共享（阻塞所有 US）

**Goal**：建 IdeationMockup 表、参数化 OSS 签名器 content-type、让 worker-token guard 可被 ideation 复用。为 3 端点铺路。

- [X] T001 [Server] **`IdeationMockup` model + migration（expand 首建）**：`apps/server/prisma/schema.prisma` 加 `model IdeationMockup { id BigInt @id @default(autoincrement()) / sessionId BigInt @map("session_id") / accountId BigInt @map("account_id") / objectKey String @map("object_key") / screens Json / note String? / createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6) }`，`@@schema("ideation")`，`@@index([sessionId, createdAt], map:"ix_idea_mockup_session_created")` + `@@index([accountId], map:"ix_idea_mockup_account")`；生成 migration（纯增表 expand，无破坏列）。**验**：`prisma migrate` 本地 apply 成功（`env -u OSS_*` + dev URL）；走 expand（无 drop/alter 既有）；`nx run server:build` 绿（client 含 IdeationMockup）。**贫血**：raw row，无 Domain Class / 无 mapper
- [X] T002 [Server] **OSS 签名器 content-type 白名单参数化（平台层，向后兼容）**：`apps/server/src/integrations/oss/oss-policy.ts`（CHANGE `buildPostObjectCredential` 加可选 `contentTypeWhitelist: readonly string[]` 入参，默认 `IMAGE_WHITELIST`；policy `['in','$content-type', […whitelist]]` 用入参）。**验**：`oss-policy.spec.ts` 补「传 `['text/html']` → policy content-type 限 text/html」+「不传 → 默认 image 白名单（既有用例零改仍绿）」（红→绿）；account `issue-upload-credential` + ideation `attachment-credential`（036）既有测试**零改仍绿**（默认参数向后兼容）；`nx run server:lint` 绿
- [X] T003 [Server] **worker-token guard 共享落点（供 ideation 复用，platform infra）**：把 `apps/server/src/agent-bridge/worker-auth.guard.ts`（`WorkerAuthGuard` + `worker-auth.rules.ts`）提升到 `apps/server/src/security/`（或 security 薄 re-export），使 ideation worker 端点可 `@UseGuards(WorkerAuthGuard)`；`agent-bridge` 调用方改 import 共享落点、**对外行为零变**。**验**：`worker-auth.rules.spec.ts` 随迁仍绿；`agent-queue.controller.it.spec.ts`（既有）worker-token 鉴权**零改仍绿**；`nx run server:lint`（boundaries：security 平台基座可被 agent-bridge + ideation 依赖）绿。⚠️ 触及 agent-bridge = 平台抽取非行为变更 → PR 标注（stop-signal #4）

## Phase 2: US1 — Server worker-token 凭证 + 写记录（P1 交付脊柱）

**Story Goal**：channel 据所认领任务拿 scoped 凭证直传产物 → 回报落 mockup 记录关联 session。**Independent Test**：种子 claimed `agent_queue_event`（bizId=sessionId）+ worker token，POST 凭证签发 scope 锁 `ideation-mockup/{accountId}/{sessionId}/` + content-type text/html；POST 写记录校 prefix 归属 + insert；越权 scope / 谎报 prefix → 拒。

- [X] T004 [US1] [Server] **跨 ctx 事件归属派生 + prefix 校验纯函数**：`apps/server/src/ideation/claimed-event-ownership.ts`（new，`// CROSS-CONTEXT-READ: 读 agent-bridge claimed event 派生 (accountId,sessionId)；只读、永不写`，注入点 DI `PrismaService` 读 `agentQueueEvent` where id=eventId & status='claimed' & bizType=<ideation mockup type> → 返 {accountId, sessionId=bizId}，否则 null）+ `mockup.rules.ts`（new，`assertObjectKeyOwnership(objectKey, accountId, sessionId)` = `startsWith('ideation-mockup/{accountId}/{sessionId}/')` 纯函数 + `normalizeScreens(json)` + `deriveVersionRank` 纯函数）。**验**：`mockup.rules.spec.ts` vitest（prefix 归属命中/不命中 / screens 规整非数组兜底 / version rank）；事件派生随 T007 IT（真 DI lifecycle，不单测隔离跨 ctx 读）
- [X] T005 [US1] [Server] **worker-token mockup 凭证 UC + EP**：`apps/server/src/ideation/mockup-credential.{request,usecase,controller}.ts`（new）—— request `{eventId:string}`；UC `IssueMockupCredentialUseCase` 经 `claimed-event-ownership` 派生 (accountId,sessionId)（派生失败 → 404/拒，不泄漏）→ 消费 `integrations/oss/buildPostObjectCredential`（contentTypeWhitelist=`['text/html']`，keyPrefix `ideation-mockup/{accountId}/{sessionId}/`，size cap，短 TTL）；controller `POST /api/v1/ideation/mockups/credential`（`@UseGuards(WorkerAuthGuard)`+`@ApiBearerAuth('worker-token')`+`@ApiTags('ideation')`，OSS 未配 → 503 ProblemDetail 不泄 vendor）+ `ideation.module.ts`（CHANGE 加 UC+controller+ownership provider）。**验**：随 T007 IT（Guard 真 DI lifecycle）；scope 派生纯逻辑随 T004
- [X] T006 [US1] [Server] **worker-token 写记录 UC + EP**：`apps/server/src/ideation/mockup-record.{request,usecase,controller}.ts`（new）—— request `{eventId:string, objectKey:string, screens:string[], note?:string}`；UC `RecordMockupUseCase` 经 ownership 派生 (accountId,sessionId) → `mockup.rules.assertObjectKeyOwnership`（不符 → 拒，防谎报他 session）→ insert `IdeationMockup`（append-only）；controller `POST /api/v1/ideation/mockups`（`@UseGuards(WorkerAuthGuard)`+`@HttpCode(201)`）+ `ideation.module.ts`（CHANGE）。**验**：随 T007 IT；prefix 归属 reject 纯逻辑随 T004

## Phase 3: US1 — Server account-token 读列表（app 消费）

- [X] T007 [US1] [Server] **account-token 读列表 UC + EP**：`apps/server/src/ideation/mockup-list.{response,usecase,controller}.ts`（new）—— UC `ListSessionMockupsUseCase` 直注 `PrismaService` 查 `IdeationMockup` where sessionId & **accountId=req.user**（scope 校 session 归属；他人/不存在 → **空等价**，但端点层他人 session → 404 字节级一致反枚举）→ 倒序（createdAt desc）返 `{id, objectKey, mockupUrl(objectKey→备案域 URL 派生,域名配置化), screens[], createdAt, versionRank}`；controller `GET /api/v1/ideation/sessions/{id}/mockups`（`@UseGuards(JwtAuthGuard)`+`@ApiBearerAuth()`，session id 非数字/他人/不存在 → 404 反枚举，沿 036 `parseSessionId`）+ `ideation.module.ts`（CHANGE）。**验**：随 T008 IT；version rank / URL 派生纯逻辑随 T004（remediation 2026-06-27: 读列表反枚举折叠 = 他人/不存在 session 字节级一致 404，沿 036 FR-013，impl 已对齐 — UC 在列 mockup 前先校验 session 归属-存在 镜像 get-session.usecase，查不到 → NotFoundException('SESSION_NOT_FOUND')；IT ⑤ 断言改 404 字节级一致，本人空 session 仍 200 {items:[]}）

## Phase 4: US1 — Server 真 IT（state_branches 全覆盖）

- [X] T008 [US1] [Server-IT] **交付 + 读列表 state_branches 全覆盖 IT**：`apps/server/test/integration/ideation-mockup-delivery.it.spec.ts`（new，全 boot Fastify + Testcontainers PG+Redis + fake/参数化 oss + **种子 claimed `agent_queue_event` 行**）覆盖 spec `state_branches`：worker-token 有效 / 无效（401）；**凭证 scope 派生**（keyPrefix=`ideation-mockup/{accountId}/{sessionId}/` + content-type text/html，accountId/sessionId 来自 event 非自报）；**写记录 prefix 归属**（命中 insert / 谎报他 session prefix → 拒）；**append-only 多版**（同 session 多次 record → 多行，读列表倒序返全部）；account-token 读列表（自己 session 返列表 / **他人 session → 404 字节级一致** / 不存在 → 404）；降级（OSS 未配 → 503 ProblemDetail 不泄 vendor / 派生失败不脏写）。**验**：`nx test server <file>` 全绿（Guard 真 lifecycle，无隔离 mock）；env-gated 真 OSS 分支（`RUN_OSS_IT` 默认 skip）。⚠️ **覆盖边界（analyze C1）**：state_branch「**直传失败→不落库**」= **channel 侧（仓外）**职责（server 只在直传成功后被调写记录、看不到直传失败），本 IT **不覆盖**该 branch，由 agent-platform 仓 channel PR + T017 手动 dogfood 担保——勿声称 server IT 100% 覆盖全 9 branch（remediation 2026-06-27: 读列表反枚举折叠 = 他人/不存在 session 字节级一致 404，沿 036 FR-013，impl+IT 已对齐 — ⑤ 他人 session / 不存在 numeric → 404 字节级一致；本人空 session → 200 {items:[]}；非数字 id → 404 不变）

## Phase 5: US1 — Contract（export-openapi + api-client regen）

- [X] T009 [US1] [Contract] **export-openapi + api-client regen → 3 fn**：per `.claude/rules/api-contract-trigger.md`：`env -u OSS_*` + 显式 dev `DATABASE_URL`/`REDIS_URL` 跑 `pnpm nx affected --target=generate` → 生成凭证 fn / 写记录 fn / **读列表 fn**（mobile 只消费读列表；worker 两端点由 channel 调，但仍入 OpenAPI 契约）。**验**：`nx run server:export-openapi` openapi.json 含 3 新 path；`packages/api-client/src/` 出现读列表 fn + 类型；typecheck 绿。**注（analyze I1）**：mobile 侧仅 import **读列表 fn**；凭证 / 写记录 fn 入契约供 agent-platform 仓 channel 用，mobile 不调（非死码，是已发布契约）

## Phase 6: US1 — Mobile viewer + 隔离渲染（新依赖 + fetch-on-open）

- [X] T010 [US1] [Mobile] **新依赖 react-native-webview + MockupRenderer 隔离渲染**：`expo install react-native-webview`（app rebuild）；`apps/mobile/src/ideation/MockupRenderer.tsx`（new，native `<WebView source={{uri}}>` + `javaScriptEnabled={false}` + `originWhitelist={['https://<备案域>']}` + `onShouldStartLoadWithRequest` 拦非备案域外链 + CSP；**Web 退化** `<iframe sandbox="allow-same-origin" />` + meta-CSP，供 e2e，FR-005/SC-004）。⚠️ **stop-signal #2**：PR body 列 research.md R3 选型 + 硬化配置。**验**：渲染组件 render + origin/外链拦截走 T013 e2e（Web iframe）；native 隔离 + 备案域内联真机手动（web_compat untested）；纯逻辑（URL/CSP 组装）vitest
- [X] T011 [US1] [Mobile] **session mockup hook + SessionMockupScreen 装配（fetch-on-open + 状态态）**：`apps/mobile/src/ideation/use-session-mockups.ts`（new，react-query 调**生成的**读列表 fn，fetch-on-open 无实时刷新 FR-011）+ `apps/mobile/app/(app)/(tabs)/ideation/mockups.tsx`（new，从 session 进入「设计稿」区，装配 MockupRenderer 渲染最新版）+ 空态（无 mockup 非错误 US1 AC3）/ 加载态 / **错误降级**（`onError`/不可达 → 一次性提示 + 重试，不阻断 session FR-009/US1 AC4）+ `ideation-copy.ts`（CHANGE 加「暂无设计稿」/「设计稿加载失败」文案）。**验**：hook 纯逻辑（fetch-on-open / 派生最新）vitest（mock 生成 fn）；空/加载/错误态 + 渲染最新走 T013 e2e；typecheck + lint（无悬空 import）

## Phase 7: US1 — Mobile 两层验证（e2e + contract-smoke）

- [X] T012 [US1] [Contract-Smoke] **契约冒烟（打 testcontainers 真 server）**：`apps/mobile/e2e/contract-smoke/ideation-mockup.contract.ts`（new，node 层生成 `@nvy/api-client` 打真 server，**显式 `MARKETDATA_PROVIDER=mock`** per memory）—— 种子 claimed event + worker token：签凭证 → 校 prefix → 写记录 → **account-token 读列表对齐**（返该 session 记录 + screens + 倒序）；他人 session 读 → 404。**验**：`nx run mobile:contract-smoke` 绿（验契约对齐 + 真落库 + 反枚举，补 hermetic 与 server IT 缝）
- [X] T013 [US1] [Mobile-E2E] **hermetic UI e2e（Playwright Expo Web）**：`apps/mobile/e2e/ideation-mockup-delivery.spec.ts`（new，读列表 + mockup 产物经 `route.fulfill` 镜像契约返 fixture HTML）覆盖 US1：打开有 mockup 的 session → 拉列表 → `<iframe>` 渲染最新 fixture → 多状态屏可滚动浏览 → **空态**（mock 空列表）→ **渲染降级**（mock 产物 404 → 一次性提示 + 重试，session 不崩）。**验**：`nx run mobile:e2e <file>` 绿（authed 业务 401 须 mock refresh per memory，避免误登出）

## Phase 8: US2 — 多版迭代浏览（append-only 已落，补 mobile 切换）

**Story Goal**：同 session 多版 mockup 列出 + 默认最新 + 切历史版渲染。**Independent Test**：mock 读列表返 N 版 → App 列出 + 默认渲最新 + 切历史版重渲。（server append-only 多版已由 T008 覆盖。）

- [X] T014 [US2] [Mobile] **多版切换条 + 屏标签行**：`apps/mobile/src/ideation/MockupVersionStrip.tsx`（new，append-only 倒序 chips，latest 默认选中带交付日期，点历史 chip 切 MockupRenderer uri 重渲，FR-006 + Clarification Q1，mockup 帧①/⑤）+ 屏标签行渲 `screens[]`（逐屏标签，FR-010 + Clarification Q2）；SessionMockupScreen（CHANGE 接入 strip）。**验**：版本选择 / 倒序 / 默认最新纯逻辑 vitest；切换重渲 + 标签渲染走 T015 e2e
- [X] T015 [US2] [Mobile-E2E] **多版 e2e**：`ideation-mockup-delivery.spec.ts`（扩，mock 读列表返同 session N 版不同 createdAt）→ App 列 N 版 + 默认渲最新 + 选历史版 → iframe 切到该版 fixture。**验**：`nx run mobile:e2e <file>` 绿

## Phase 9: Polish & Cross-Cutting

- [X] T016 [Polish] [Verify] **PR 收口 + 跨切关注**：typecheck/lint 全包绿（无 orphan import / 无悬空 copy）；PR body 含 ① 🚨部署存活前置确认 3-checkbox（per `feedback_every_pr_body_needs_deploy_gate_section`）② **新依赖 react-native-webview 选型理由**（research.md R3 + 硬化配置，stop-signal #2）③ **跨 ctx 只读 agentQueueEvent flag**（Q7-B `// CROSS-CONTEXT-READ`，Complexity Tracking）④ **2 仓外/前置依赖**（channel agent-platform 仓独立 PR + 备案自定义展示域 infra 前置；native 隔离渲染 + 备案域内联留真机手动）⑤ touches account/agent-bridge 平台抽取标注（stop-signal #4：oss 参数化 + worker guard 共享 = 非行为变更）。**验**：`nx affected -t typecheck lint test` 绿；OpenAPI 无 drift；markdownlint（docs *.md）；dead-code 自查（我的改动产生的 orphan 清理；预存 dead code 仅 mention）。⚠️ **记 manual 验证项（analyze C2）**：SC-004（native webview JS-off+origin 锁隔离）+ SC-001（3s 渲染预算）= **真机手动验证**（web e2e 仅 web `<iframe>` 部分覆盖隔离、不验 native + 不验预算），结论回填 PR / master（web_compat: untested 已声明）
- [X] T017 [Polish] [Verify] **跨仓 dogfood（手动，仓外联动）**：~~待 agent-platform 仓 channel inline+upload PR 合 + 备案域配好后~~ **两个仓外前置均已清（channel ✅ agent-platform 本地 `main` `698b3d0`；备案展示域 `img.shintongtech.com` HTML-inline ✅ 实测 PR #632）**——剩唯一前提 = **一个跑 mockup 3 端点 + 应用了 `IdeationMockup` migration + 配 `OSS_PUBLIC_BASE_URL=https://img.shintongtech.com` 的 server**：① **本地全栈 + Mate50 真机**（user 已计划下次随真机一并跑，dogfood 走本地 server 即可）或 ② **prod 77 部署**（面向真实用户的 ship，另起 deploy 决策）。齐后真 headless 交付 → app 真机隔离渲染（一并覆盖 SC-001 3s 预算 + SC-004 native JS-off/origin 隔离手动验证）。**本 PR 不阻塞**（channel 仓外）；记为手动验证项，结论回填 master/PR。**✅ 已闭合（2026-06-28，本地全栈 + Mate50 八戒/session 5）**：openclaw-nvy channel（agent-platform `c98a08e`，含外链 `@import` 剥离）`claude -p /mockup-gen-from-brief` 真生成 **12 屏** mockup → 据所认领事件签凭证 → **真传 OSS** `ideation-mockup/7/5/75cc5f50…/img` → 写记录 → 读列表返 `https://img.shintongtech.com/…` 内联 URL（`Content-Type: text/html` 无 force-download）→ **App 真机隔离渲染出图**；**SC-001 < 2s**（≤3s 预算达标）、**SC-004** 隔离渲染成立（产物自包含 0 外链 + native JS-off + origin 锁）。路上修四坑：本地 server `OSS_PUBLIC_BASE_URL`/`AGENT_WORKER_TOKEN` 缺值 + Prisma client 陈旧（migration 已应用未 regen）+ **Metro 漏传 `EXPO_PUBLIC_OSS_PUBLIC_BASE_URL`**（= 渲染端 origin 白名单空 → valid 备案域 URL 被判脏域折叠空态，「暂无设计稿」真因；已修 `run-local-env` skill）。**prod 77 ship 仍是面向真实用户的独立 deploy 决策**（设 `OSS_PUBLIC_BASE_URL` 否则 server 返 `mockupUrl:null`）。

## Dependencies & Execution Order

1. **Phase 1（T001-T003）= Foundational，阻塞所有 US**：表 + oss 参数化 + worker guard 共享。T001/T002/T003 互不依赖可并行。
2. **US1 server（T004-T009）**：T004（纯函数+派生）→ T005/T006（worker 端点，依赖 T002/T003/T004）→ T007（读列表，依赖 T001/T004）→ T008（IT，依赖 T005/T006/T007）→ T009（contract，依赖端点稳定）。
3. **US1 mobile（T010-T013）**：T010（webview 渲染组件）+ T011（hook+屏，依赖 T009 生成 fn）→ T012 contract-smoke + T013 e2e。
4. **US2（T014-T015）**：依赖 US1 mobile 骨架（T011）；server 多版 T008 已覆盖。
5. **Polish（T016-T017）**：最后；T017 跨仓 dogfood 不阻塞本 PR merge。

**MVP scope** = US1（T001-T013）：单版 mockup 交付 + app 隔离渲染闭环。US2（多版切换）增量。

**并行机会**：T001/T002/T003（Foundational 不同文件）；T010 与 T004-T009（mobile 渲染组件 vs server，仅 T011 依赖 T009 生成 fn）。
