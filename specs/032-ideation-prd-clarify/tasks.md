---
feature_id: 032-ideation-prd-clarify
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-21'
---

# Tasks: 032-ideation-prd-clarify（移动端「需求灵感澄清」助手 — 文字闭环 ideation B1）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `032-ideation-prd-clarify` | **设计源**: [契约 doc](../../docs/private/plans/2026-06/06-21-ideation-brief-contract-and-elicitation.md) + [master B1](../../docs/private/plans/2026-06/06-21-prd-ideation-to-sdd-master.md) + [mockup](./design/)

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）；`[USx]` = user-story 阶段 task 带；层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Verify]`
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；纯函数（brief zod/收敛门 / chips 两道闸 / markdown 渲染）= vitest 无 DB；UC 读写 DB = **Testcontainers PG**（`nx test server <file>`，cwd=apps/server）；真 M3/DS provider 走 **env-gated IT**（`RUN_LLM_IT`，默认 skip，CI 不打外网）；mobile 纯逻辑 = vitest，UI·render·a11y = Playwright Expo Web e2e
- 无 task-meta JSON（**manual 模式**，per 004-031）
- 🚨 **032 = ideation 第 8 限界上下文首落地**（ADR-0057，**叶子 ctx 禁 import chat**）；多轮对话经 **`integrations/llm` 平台层 port** 复用 LLM provider（ADR-0058：provider 从 `chat/` `git mv` 过来，chat + ideation 绑同一 port）；SSE 流式复用 chat 范式（ADR-0055 `reply.hijack()` + split-tx，**自写 stream controller 非 import**）
- 🚨 **用户身份 = `accountId`**（`req.user.accountId` + `JwtAuthGuard` from `account/` 平台基座复用，**非业务跨 ctx 依赖**）；会话/turn/brief 按 accountId 归属，越权读/写/删 → **字节级一致反枚举**（与 027-031 同款）
- 🚨 **两相驱动剧本（契约 doc §3，HOW SoT）**：相 A 访谈（per-turn 两步微循环：接地 `codeindex_retrieval` `auto`〔本期 **stub**〕+ 提问 `ask_clarifying_question` `required`/M3）；相 B 产出（用户点「生成 brief」→ `emit_requirements_brief` **forced**）。**相位切换 = 工具菜单切换**；收敛触发 = 用户按钮（非 sentinel）
- 🚨 **chips 两道闸（契约 doc §4，FR-004）**：仅「答案空间可枚举 **且** AI 有可辩护推荐」两闸同过才给 chips；推荐项内嵌「（推荐）」+ 排首 + 不预选；末位「都不是/自己填」逃生；自由文本永驻；第一问永不给 chips
- 🚨 **模型策略（契约 doc §5，FR-010）**：结构化轮（提问步 + emit 相）**默认 MiniMax M3**（`required` 稳）；DeepSeek V4 降级 best-effort（恒思考不支持强制 tool_choice）+ 正则兜底 + 吐不出降纯文本
- 🚨 **接地 stub（ADR-0059，FR-011 / SC-007）**：`codeindex_retrieval` 本期 stub（返空/不入菜单）；`repo` 字段 nullable 后台预留、**不展示选择器 UI**；brief T2 接地段留空/手填、**不阻塞收敛门**（门只查 T1 五段）
- 🚨 **brief 落库（契约 doc §2 / D4）**：规范态 = 结构化 JSON 真相源（zod 校 T1 齐）；导出态 = 渲 markdown；**一会话一份 1:1**，重新生成覆盖上一版（不留 v1/v2）
- **单 PR（per Constitution §V v1.3.0）**：`feat(ideation)` —— provider git mv + server impl + 真 server IT + export-openapi + api-client regen + mobile 消费 + 两层验证全原子 merge。PR body flag「新 ctx + provider 搬迁触碰 chat ctx」+ **建议人工 review**

## Path Conventions

- server：`apps/server/src/ideation/`（**新建扁平 module**，无 domain/application/infrastructure 子目录）；`apps/server/src/integrations/llm/`（provider 搬迁目标，平台层）；schema `apps/server/prisma/schema.prisma` + 新 migration；IT `apps/server/test/integration/*.it.spec.ts`
- contract：`apps/server/openapi.json`（`nx run server:export-openapi`，canonical `node dist/main.js`）→ `packages/api-client/`（Orval `nx affected -t generate`）
- mobile：`apps/mobile/src/ideation/`（**新建 feature dir**）+ `apps/mobile/app/(app)/ideation/{index,[id]}.tsx`（**新建独立 stack**）+ `apps/mobile/app/(app)/(tabs)/_layout.tsx`（+ FAB 创建浮层）+ `apps/mobile/app/(app)/(tabs)/pkm.tsx`（外脑 tab 暂 redirect ideation 列表）；`~/theme`/`~/ui` 零新库（mockup 0 新 token）
- e2e：`apps/mobile/e2e/`（mock SSE + CRUD + 003 refresh per memory）；contract-smoke `apps/mobile/e2e/contract-smoke/ideation.contract.ts`
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait`（:5433/:6380）；**本地 server IT/smoke 前 `env -u OSS_*`**
- 真 M3/DS IT：env-gated `RUN_LLM_IT`，默认 skip（key 在 `apps/server/.env`，CI 不打外网）

---

## Phase 0: 前置改造 — LLM provider 搬迁到 integrations/llm（触碰 chat ctx，必先行）

**Goal**：把 LLM provider 从 `chat/` `git mv` 到平台层 `integrations/llm/`，chat + ideation 绑同一 `LLM_PROVIDER` port；chat 行为零变更、IT 全回归（ADR-0058，ADR-0055 amend 在 T021）。

- [X] T001 [Server] **provider `git mv` chat/ → integrations/llm/ + port 平台化**：`git mv apps/server/src/chat/{llm-provider.port,deepseek.provider,minimax.provider,fake-llm.provider}.ts apps/server/src/integrations/llm/`（实际文件名以 `ls apps/server/src/chat/*provider*` 为准）+ 新建 `integrations/llm/llm.module.ts`（export `LLM_PROVIDER` token）+ chat module 改 import 自 `integrations/llm` + **ESLint boundaries / Nx tag 注册 `scope:integrations` 平台层**（chat + ideation 单向可依赖，integrations 不依赖任何业务 ctx）。**验**：`nx test server chat --skip-nx-cache`（chat 全 IT 回归绿，行为不变）+ `nx run server:lint`（boundaries 0 violation：chat 经 port import OK）

## Phase 1: Server — ideation 限界上下文 + 两相澄清/收敛端点

**Goal**：新 `ideation` 叶子 ctx 落地——会话 CRUD + 两相澄清（访谈 SSE 流式 + 接地 stub + chips）+ 收敛产出 brief（forced emit + zod T1 门）+ 重开回流/重生覆盖/删除，spec ~19 条 state_branches 全覆盖（FakeLLM 确定性 + 真 M3/DS env-gated）。

- [X] T002 [Server] **Prisma `ideation` schema + 3 表 + migration + 注册四处**：`apps/server/prisma/schema.prisma` `schemas` 列表加 `"ideation"` + `idea_session`（`id BigInt @id @default(autoincrement())` / `accountId BigInt @map("account_id")` 无 FK / `title String` / `status String` 默认 `"open"` / `repo String?`〔接地缝 nullable〕/ `createdAt`/`updatedAt` / `@@index([accountId, updatedAt])` / `@@map("idea_session")` / `@@schema("ideation")`）+ `idea_turn`（`id` / `sessionId BigInt @map("session_id")` 无 FK / `role String` / `content String @db.Text` / `suggestion Json?`〔本轮 chips：question/options/recommended/multi_select/allow_freetext〕/ `createdAt` / `@@index([sessionId, id])` / `@@map`/`@@schema`）+ `requirements_draft`（`id` / `sessionId BigInt @map("session_id") @unique`〔1:1〕/ `briefJson Json @map("brief_json")` / `createdAt`/`updatedAt` / `@@map`/`@@schema`）。**注册四处**：(a) schema ↑ (b) ESLint boundaries + Nx tag `scope:ideation`（叶子，禁 import chat）(c) `scripts/checks/check-server-moat.ts` ownership 纳入 3 表 (d) `docs/conventions/business-naming.md` 列 `ideation`。**验**：`docker compose -f docker-compose.dev.yml up -d --wait` → `env -u OSS_* pnpm -C apps/server prisma migrate dev --name ideation_init` + `prisma generate`（过 `migration-naming-check`）+ `nx run server:lint`（boundaries 注册生效）
- [X] T003 [P] [Server] **brief 契约 zod schema + T1 收敛门纯函数**：`apps/server/src/ideation/brief.schema.ts`（zod：T1 五段必填 `problem`/`user_stories`/`functional_requirements`/`success_criteria`/`non_goals` + T2 接地段 optional `affected_surface`/`constraints_guardrails`/`data_model_sketch`/`api_contract_sketch` + T3 optional `edge_cases`/`nfr`/`ui_notes`/`open_questions`/`phase_boundary`，契约 doc §2）+ `brief-gate.rules.ts`（`isConverged(briefJson)` 只查 T1 五段齐〔**绝不含 T2**〕→ 返缺失段列表）+ vitest（T1 齐→pass / 缺任一段→列缺失 / T2 全空仍 pass / 类型错→zod 拒）
- [X] T004 [P] [US3] [Server] **chips 两道闸纯函数**：`apps/server/src/ideation/suggestion-gate.rules.ts`（`shouldOfferChips({turnIndex, enumerable, defensibleRec})` → 两闸同过且非第一问才 true；`normalizeSuggestion(raw)` 钳 2-4 项 + 推荐项排首 + 末位补「都不是/自己填」逃生 + 不预选，契约 doc §4.1/§4.5/§4.6）+ vitest（两闸过→给 / 闸一挂〔开放〕→不给 / 闸二挂〔无推荐〕→不给 / 第一问→永不给 / >4 项→钳到 4 / 逃生项末位补齐 / 推荐项首位）
- [X] T005 [P] [Server] **brief JSON→markdown 渲染纯函数**：`apps/server/src/ideation/brief-markdown.rules.ts`（`renderBriefMarkdown(briefJson)` 按段渲 markdown：T1 全渲 / T2 空段渲「_本期留空/手填_」占位非报错 / T3 有内容才渲〔小颗粒自适应跳〕，契约 doc §2.2）+ vitest（T1 齐渲全段 / T2 空→占位行 / T3 空→整段跳 / 往返 JSON→md 稳定）
- [X] T006 [US1] [Server] **LLM 工具定义 + FakeLLM 两相驱动**：`apps/server/src/ideation/ideation-tools.ts`（3 工具 schema：`codeindex_retrieval`〔本期 **stub**：UC 侧返空/不入菜单〕+ `ask_clarifying_question`〔出 `{question, options[], multi_select, allow_freetext}`〕+ `emit_requirements_brief`〔参数 = brief.schema T1 required〕，契约 doc §3.1/§4.4）+ `fake-ideation-llm.provider.ts`（脚本化驱动两相：访谈相吐 ask_clarifying_question〔含/不含 chips 两态〕、产出相吐 emit_requirements_brief；可注入 error/abort/吐纯文本降级）+ vitest（FakeLLM 访谈轮出问题+可选 chips / 产出轮出 brief JSON / 降级吐纯文本 / abort 中断）
- [X] T007 [US1] [US2] [Server] **会话 CRUD + 生命周期 UC + controller**：`apps/server/src/ideation/`：`create-session.usecase.ts`（建 open 会话 + title，`repo=null`）+ `list-sessions.usecase.ts`（scope accountId，按 updatedAt 序，仅本人）+ `get-session.usecase.ts`（含 turns + brief，scope）+ `delete-session.usecase.ts`（连带 turn + brief，scope）+ `reopen-session.usecase.ts`（converged/handed-off→open 回流，conditional UPDATE affected-count）+ `session.controller.ts`（`POST/GET /ideation/sessions` `GET/DELETE /ideation/sessions/{id}` `PATCH /ideation/sessions/{id}/reopen`，`@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)`，越权→**字节级一致**拒）+ 新 `ideation.module.ts` 注册（注 `LLM_PROVIDER` from integrations）+ `app.module.ts` import + Testcontainers（建/列〔仅本人〕/查/删连带/重开回流 / 越权读写删字节级一致 / 未认证 401）
- [X] T008 [US1] [US3] [Server] **澄清轮 SSE UC + controller（两相·访谈相两步微循环）**：`clarify-turn.usecase.ts`（① scope 校验→越权拒 ② 落 user turn 即时〔空白拒不落〕③ per-turn 两步：接地步 `codeindex_retrieval` `auto`〔stub 返空直进步2〕→ 提问步 `ask_clarifying_question` `required`(M3)/best-effort(DS) ④ 流式吐 assistant turn〔`question` 文本流式 + chips JSON 收口整出，契约 doc §4.7〕⑤ 落 assistant turn + suggestion；abort→保留半成品 / 失败→不落半截 + error 帧，split-tx）+ `clarify-stream.controller.ts`（`POST /ideation/sessions/{id}/turns`，`reply.hijack()` + SSE headers + `reply.raw.on('close')` abort 上游 + 逐帧 write + `[DONE]`）+ Testcontainers（**FakeLLM**：澄清轮落 user+assistant turn / 带 chips 轮 suggestion 落库 / 不过闸轮无 chips / 空白输入拒 / abort 落半成品 / 失败不落 assistant / 越权拒）
- [X] T009 [US1] [Server] **生成/重生 brief UC + 导出 markdown + controller**：`generate-brief.usecase.ts`（产出相：`emit_requirements_brief` **forced**〔M3 required / DS 降级 + 正则兜底〕→ zod 校 T1 齐〔`brief-gate`〕→ 未齐**不落** + 回「继续追问缺失段」信号 / 齐→**upsert** `requirements_draft`〔1:1 覆盖上版〕+ session `open→converged`，conditional UPDATE）+ `export-brief.usecase.ts`（`renderBriefMarkdown` → 返 markdown + session `converged→handed-off`）+ controller（`POST /ideation/sessions/{id}/brief` 生成/重生 + `GET /ideation/sessions/{id}/brief/export` 导出）+ Testcontainers（T1 齐→落 brief + converged / 缺段→不落 + 追问信号 / 重生→覆盖单份不留历史 / 导出→markdown + handed-off / 接地 stub〔T2 空〕照样收敛〔SC-007〕）
- [X] T010 [US1][US2][US3] [Server-IT] **state_branches 全覆盖 IT**：`apps/server/test/integration/ideation.it.spec.ts`（全 boot + FakeLLM 注入）覆盖 spec **~19 条**（建会话 / 流式澄清落轮 / chips 过闸出选项 / 不过闸纯文本 / 自由文本覆盖选项推进 / 收敛齐产 brief / 缺段继续追问 / 小颗粒 brief 自适应跳 T3 / 导出 handed-off / 重开回流 open / 重生 1:1 覆盖 / 删除连带 / 中途退出保留 open / 列表仅本账号 / 越权读写删字节级一致 / 401 refresh / provider 失败不落半截 / abort 保留半成品 / 空白拒 / 接地 stub 不阻塞收敛）+ **env-gated 真 M3 IT**（`RUN_LLM_IT`：真发驱动两相→chips/brief 结构化 emit 稳定 + DS 降级路径各覆盖，默认 skip）

## Phase 2: 契约同步（Nx-driven）

- [X] T011 [Contract] [Verify] **swagger + openapi + api-client regen**：`session.controller` / `clarify-stream.controller` / brief controller 加 `@nestjs/swagger` 装饰器（会话 CRUD / 生成 brief / 导出 JSON DTO + SSE 端点标 `produces: text/event-stream` + nullable string〔`repo`〕显式 `type:'string'` per memory）→ `nx run server:export-openapi`（canonical `node dist/main.js`）→ `nx affected -t generate`（Orval regen：会话 CRUD / brief / 导出 typed hook；SSE 澄清端点不依赖 hook）→ mobile typecheck 绿

## Phase 3: Mobile US1 — 创建入口 + 澄清对话 + brief 导出（翻 mockup baseline）

**Goal**：+ FAB 建会话 → 多轮澄清（流式 + chips + 自由文本）→ 生成 brief → 导出，端到端 dogfood 脊柱（翻面 A/B/C，0 新 token）。

- [X] T012 [US1] [Mobile] **ideation stack 脚手架 + 外脑 tab redirect**：新建 `apps/mobile/app/(app)/ideation/_layout.tsx`（Stack）+ `index.tsx`（会话列表占位，US2 T018 填）+ `[id].tsx`（会话详情：澄清对话 + brief，T015/T016 填）+ 改 `apps/mobile/app/(app)/(tabs)/pkm.tsx` → `<Redirect href="/(app)/ideation" />`（外脑 tab B1 暂指向 ideation 列表）+ vitest/typecheck（路由解析、redirect 生效）
- [X] T013 [US1] [Mobile] **中央 + FAB + 创建浮层（翻面 A，root Modal）**：`apps/mobile/app/(app)/(tabs)/_layout.tsx` 加中央绿色 + FAB（`ok #10B981`，custom `tabBar` 或 root 层 absolute 叠加，**不覆写 tab 栏高度**）+ `apps/mobile/src/ideation/CreateOverlay.tsx`（**root RN `Modal`** 盖 tab 栏，翻面 A：从 + 长出锚定浮层 + 指向三角、scrim .48、prd灵感 活入口 + 置灰未来槽位〔不命名〕、点 prd灵感→标题输入 RHF+zodResolver→`POST /ideation/sessions`→push `/ideation/[id]`）+ `ideation-copy.ts` 文案 + 复用 `~/ui`/`~/theme`（0 新 token）+ vitest（标题表单 4 铁律：Controller≠register / isSubmitting 单源 / 空标题校验 / 建会话成功导航）。**真机/窄视口验**（盖 tab 栏容器尺寸类，web e2e 易漏）
- [X] T014 [US1] [Mobile] **SSE 澄清客户端 + 两相会话态机 hook**：`apps/mobile/src/ideation/ideation-stream-client.ts`（复用 027 `expo/fetch` + SSE 帧解析：`question` 文本增量 + chips JSON 收口整出、`[DONE]`、`AbortController`、中断判定 `signal.aborted`）+ `use-ideation-session.ts`（态机 idle/streaming/done/error/stopped + 多轮 turn 态 + chips 数据解析 + abort/重试 + 接 orval 会话/brief hook + 冷启 reload last sessionId；streaming 态禁再发）+ vitest 纯逻辑（reducer 态转换 / token 累加 / chips 解析 / stop→stopped / error→error / retry / streaming 拒发）
- [X] T015 [US1] [US3] [Mobile] **澄清对话屏（翻面 B 6 态）**：`apps/mobile/src/ideation/ClarifyChatScreen.tsx`（接 `app/(app)/ideation/[id].tsx`）：① 流式反问气泡 + 光标 ② chips 轮（推荐项「（推荐）」+ brand-soft 首位不预选 + 末位逃生 + 横排换行）③ **chip 点选→直接发送**（契约 §4.5，2026-06-22 翻转：quick-reply 即发；逃生项聚焦输入条）④ 纯文本轮无 chips ⑤ AI 软提示 + 底部「生成 brief」主按钮（用户主动触发收敛）⑥ 流式失败 err-soft 条 + 重试；**自由输入条全态常驻**；复用 `~/ui`/`~/theme`（0 新 token，承 027 chat 视觉）。**RN 布局**：对话区 `ScrollView` 跟随；避免无界高容器裸 `flex-1`（per mobile-impl-playbook）
- [X] T016 [US1] [Mobile] **brief 预览/导出屏（翻面 C）**：`apps/mobile/src/ideation/BriefPreviewScreen.tsx`（同 `[id].tsx` 内切换/子屏）：结构化分段渲染〔非 markdown 源码〕（T1 五段 + GWT 验收 + FR 编号）+ T2 接地段灰色虚线**非阻塞占位**（非报错）+ T3 可选段淡化 + 状态徽标（open/converged/handed-off）+ 「复制/导出 markdown」（`GET .../brief/export` → Clipboard + 成功 toast）+ 「重新生成」（`POST .../brief` 覆盖）+ 回流提示 + vitest（分段渲染 / 复制成功反馈 / 重生触发）
- [X] T017 [US1] [Mobile-E2E] **hermetic UI e2e（US1 主干）**：`apps/mobile/e2e/ideation-clarify.spec.ts`（Playwright Expo Web，mock SSE 澄清端点 + mock 会话 CRUD/brief + 003 refresh）验：+ FAB → 创建浮层选 prd灵感 → 输标题建会话 → 多轮澄清（chips 点选 + 自由文本各一）→ 软提示 → 点生成 brief → 预览结构化（T2 占位在）→ 导出复制。注：SSE mock 一次性全帧（`route.fulfill` 不支持逐帧），真增量由 server IT(T010) 兜底；文件名 `.spec.ts`（playwright `testMatch`）

## Phase 4: Mobile US2 — 会话列表 / 持久 / 继续

**Goal**：账号级会话列表可见、可继续、可删除；中途退出重进进度保留；仅见本账号会话。

- [X] T018 [US2] [Mobile] **会话列表屏**：`apps/mobile/app/(app)/ideation/index.tsx`（接 `list-sessions` orval hook：列本账号会话 + 标题 + 状态徽标 + updatedAt + 点进继续 push `[id]` + 左滑/长按删除〔确认 `ConfirmModal`〕+ 空态引导 + 冷启 reload）+ 复用 `~/ui`（`SwipeRow`/`ConfirmModal` 等）+ vitest（列表渲染 / 仅本账号〔mock〕/ 删除确认流 / 状态徽标映射 `Record<Status,Meta>` 穷举）
- [X] T019 [US2] [Mobile-E2E] **US2 持久/列表 e2e**：`apps/mobile/e2e/ideation-sessions.spec.ts`（Playwright，mock CRUD + 003 refresh）验：建会话澄清几轮 → 回列表该会话可见〔状态/标题对〕→ 点进可继续〔进度保留〕→ 删除消失 → 仅见本账号（mock 他人 id 不串）

## Phase 5: 契约冒烟 + 收尾

- [X] T020 [US1] [Contract-Smoke] **契约冒烟**：`apps/mobile/e2e/contract-smoke/ideation.contract.ts`（node 层，生成的 `@nvy/api-client` 打 testcontainers 真 server，`IDEATION_FAKE_LLM` env 注入）：登录 → `POST /ideation/sessions` 建会话 → 澄清轮（流式读到 token + chips）→ `POST .../brief` 生成 → `GET .../brief/export` 导出 → 验**真落库 3 表**（idea_session/idea_turn/requirements_draft、role/status/序/1:1）+ 契约对齐（URL/method/序列化/错误码）；落共享套件 `nx run mobile:contract-smoke`
- [X] T021 [Server] **ADR-0055 amend**：`docs/adr/0055-chat-ctx-sse-streaming-llm-provider.md` 补 amend 段（LLM provider 物理位置 `chat/` → `integrations/llm/`〔ADR-0058 平台层〕，chat + ideation 共享 port、chat 行为不变 IT 全回归）+ `docs/adr/README.md` index 若需 + 过 `adr-frontmatter-check`/`adr-index-check`
- [X] T022 [Verify] **PR gate**：`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main`（首跑 `--skip-nx-cache`）全绿 + moat/boundaries 0 violation（ideation 叶子不 import chat、LLM 经 port、3 表 ownership 齐）+ `[Contract-Smoke]` 绿 + spec `status: draft→implemented` + tasks.md `[X]` 全同步 + PR body 3 checkbox 部署 gate + flag「新 ctx + provider 搬迁触碰 chat ctx，建议人工 review」

---

## Dependencies & 执行顺序

```text
T001(provider 搬迁, 触碰 chat) ─► T002(ideation schema + 注册四处)
T002 ─┬─► T003/T004/T005 [P] 纯函数(brief zod / chips 闸 / markdown, 无 DB)
      ├─► T006(工具 + FakeLLM) ─► T007(会话 CRUD/生命周期)
      │                            └─► T008(澄清 SSE 两相) ─► T009(生成/导出 brief)
      └─► T010(state_branches IT, 依赖 T007-T009)
T007/T008/T009 + swagger ─► T011(export-openapi + api-client regen)
T011 ─► T012(stack 脚手架 + 外脑 redirect) ─► T013(FAB 浮层 + 标题)
                                              ├─► T014(SSE 客户端 + 态机) ─► T015(澄清屏) ─► T016(brief 屏) ─► T017(US1 e2e)
                                              └─► T018(会话列表 US2) ─► T019(US2 e2e)
T009 + T011 ─► T020(Contract-Smoke 真 server 3 表)
全部 ─► T021(ADR-0055 amend) ─► T022(PR gate)
```

## 并行机会（per phase）

- **Phase 1 纯函数**：T003 / T004 / T005 三个 `*.rules.ts`/`*.schema.ts` 不同文件、仅依赖 T002 schema 类型 → `[P]` 并行。
- **Phase 3/4 分叉**：T013 落地后，澄清链（T014→T015→T016→T017）与会话列表链（T018→T019）相对独立，可交错推进（共享 `use-ideation-session` 注意先 T014）。

## Implementation Strategy（MVP first）

1. **MVP = US1 脊柱**（T001-T011 server + T012-T017 mobile）：建会话 → 多轮澄清〔含 chips〕→ 生成 brief → 导出。过此即 SC-001/SC-002 dogfood 闭环成立。
2. **增量 US2**（T018-T019）：会话列表/持久/继续——任务态完整闭环。
3. **US3 chips** 内联在 US1 的 T004（闸纯函数）+ T008（server 出 chips）+ T015（mobile 渲 chips），不单列阶段（增强项挂主干）。
4. **收尾**（T020-T022）：契约冒烟 + ADR amend + PR gate。
5. **Clear 检查点批次**（per `.claude/rules/implement-task-closure.md`）：建议批次 = 〔T001〕/〔T002-T005〕/〔T006-T008〕/〔T009-T011〕/〔T012-T014〕/〔T015-T017〕/〔T018-T020〕/〔T021-T022〕，每批后停顿提醒 `/clear`。

## Post-gate follow-ups

- FU-1: clarify turn 终态 invalidate 会话详情 query（修热重进 30s 内陈旧空 turns；与 generateBrief 同构）
- FU-1a: ideation-clarify.spec.ts 详情 GET mock 改 stateful（FU-1 invalidate 后重取需返已落 turns+suggestion，否则 hydrate 冲掉流式气泡）
