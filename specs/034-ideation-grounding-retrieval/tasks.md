---
feature_id: 034-ideation-grounding-retrieval
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-23'
updated_at: '2026-06-23'
---

# Tasks: 034-ideation-grounding-retrieval（ideation 接地检索接线 · grounding S3）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `034-ideation-grounding-retrieval` | **设计源**: [接地 master S3](../../docs/private/plans/2026-06/06-21-ideation-grounding-and-cc-handoff.md) + [mockup](./design/) | **消费服务**: [`services/code-index`](../../services/code-index/)（已上线 #550/#552）

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）；`[USx]` = user-story 阶段 task 带；层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Verify]`
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；纯函数（SSE 帧 / 条件注册 / 来源映射）= vitest 无 DB；UC 读写 DB + 端口 = **Testcontainers PG + fake code-index provider**（`nx test server <file>`，cwd=apps/server）；真 code-index IT 走 **env-gated**（`RUN_CODEINDEX_IT`，默认 skip）；mobile 纯逻辑 = vitest，UI·render·a11y = Playwright Expo Web e2e
- 无 task-meta JSON（**manual 模式**，per 004-032）
- 🚨 **去两个 stub + 接线，不重建骨架**：B1（[032](../032-ideation-prd-clarify/spec.md)）SSE 澄清闭环 + B2-1（[033](../033-ideation-multimodal-input-shell/spec.md)）输入栏 chrome 已 ship，本 feature 只接线，**不动**两者骨架
- 🚨 **code-index 端口 = 平台 integration**（ADR-0058 同构 `integrations/llm`）：ideation UC 注入 `CODE_INDEX` port（与 `LLM_PROVIDER` 同类，platform infra 无护城河注释要求 per ADR-0041）；**不 import chat**（ADR-0055 范式复用≠import）
- 🚨 **回灌循环（plan §2，核心变更）**：`codeindex_retrieval` 由现 `groundingOnly` stub（`clarify-turn.usecase.ts:321-324`）改真调端口 → append `role:'tool'` 消息 → 重入模型；命中作 `sources` 帧、检索发起作 `tool_start` 帧回流
- 🚨 **降级（FR-008 / ADR-0060）**：端口 throw（不可达/超时/401/5xx）→ catch → `notice` 帧（会话内系统气泡）+ 视作空命中、**不阻断**；**0 命中**（端口返 `[]`）与**不可达**（throw）严格分流（FR-009）
- 🚨 **条件注册（FR-007）**：`interviewToolsFor(repo)` —— 未选仓不把 `codeindex_retrieval` 给 LLM
- 🚨 **命名空间隔离（FR-003 / SC-002）**：检索按 `idea_session.repo` 锁；切仓只影响后续轮（FR-006），既有 turn 引用不回改
- 🚨 **无 schema migration**：`idea_session.repo`（nullable string）已在 `schema.prisma`（032 T002 预留）；本 feature 仅赋真实读写语义
- **单 PR（per Constitution §V）**：`feat(ideation)` —— server 端口 + UC + 端点 + 真 server IT + export-openapi + api-client regen + mobile 消费 + 两层验证全原子 merge

## Path Conventions

- server（新）：`apps/server/src/integrations/codeindex/`（`code-index.port.ts` / `http-code-index.provider.ts` / `fake-code-index.provider.ts` / `code-index.module.ts`）+ `apps/server/src/ideation/codeindex.config.ts`（或纳入既有 config）
- server（改）：`apps/server/src/ideation/` 的 `ideation-sse.rules.ts`（+3 帧）/ `ideation-tools.ts`（条件注册）/ `clarify-turn.usecase.ts`（回灌循环）/ `clarify-stream.controller.ts`（+3 回调）/ `session.controller.ts`（或新 `repo-catalog.controller.ts`）+ 新 `set-session-repo.usecase.ts` / `repo-catalog.usecase.ts`
- config / env-sync：`CODE_INDEX_URL` + `CODE_INDEX_SERVICE_TOKEN` 走 **9 位置 boot-path**（`.env.example` / `apps/server/vitest.config.ts` test.env 占位 / `docker-compose.tight.yml` 映射 / `codeindex.config.ts` zod …，`check-env-sync` 拦）；本地 IT 用 fake provider 不需真 URL
- contract：`apps/server/openapi.json`（`nx run server:export-openapi`，canonical `node dist/main.js`）→ `packages/api-client/`（Orval `nx affected -t generate`）
- mobile（改）：`apps/mobile/src/ideation/` 的 `InputPlusSheet.tsx`（选库真接线）/ `ideation-sse-parse.ts`（+3 帧）/ `ideation-reducer.ts` / `use-ideation-session.ts` / `ClarifyChatScreen.tsx`（来源 + 检索指示 + 降级气泡）+ 新 `SourcesDisclosure.tsx`（`~/ui` 或 ideation 内）；`~/theme`/`~/ui` 零新库（mockup 0 新 token）
- e2e：`apps/mobile/e2e/ideation-grounding.spec.ts`（hermetic mock code-index）；contract-smoke `apps/mobile/e2e/contract-smoke/ideation-grounding.contract.ts`
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait`（:5433/:6380）；**本地 server IT/smoke 前 `env -u OSS_*`**

---

## Phase 0: Server — integrations/codeindex 平台端口（新平台层，不触碰 chat/ideation 业务）

**Goal**：落 `CODE_INDEX` 平台端口（HTTP provider + fake，ADR-0058 同构）+ config env-sync，供 ideation UC 注入。本阶段零业务逻辑、零 ideation 改动。

- [X] T001 [Server] **code-index 端口 + http/fake provider + module + config（env-sync 9 处）**：新建 `apps/server/src/integrations/codeindex/`：`code-index.port.ts`（`CODE_INDEX` token + `CodeIndexPort` 接口 `search(repo, query, signal?): Promise<CodeChunk[]>` + `listRepos(): Promise<RepoCatalogEntry[]>`，DTO 形状对齐 `services/code-index/src/query.ts:SearchHit` + `meta.ts:RepoMeta`）+ `http-code-index.provider.ts`（Node 内置 `fetch` 打 `CODE_INDEX_URL` `/search`〔body `{repo,query,topK?}`〕+ `/repos`，`Authorization: Bearer ${token}`，AbortSignal 超时，非 2xx/网络错 throw，**token 不入日志**）+ `fake-code-index.provider.ts`（确定性命中脚本 + 可注入「不可达」态）+ `code-index.module.ts`（`CODE_INDEX_PROVIDER` env 选 http/fake，同 `llm-router` 范式）+ `codeindex.config.ts`（zod discriminated-union，镜像 `sms.config.ts`）+ **env-sync 9 位置**铺 `CODE_INDEX_URL`/`CODE_INDEX_SERVICE_TOKEN` 占位 + ESLint/Nx tag `scope:integrations`。**验**：vitest（fake provider 命中/不可达；http provider 用 mock fetch 验 URL/header/超时/非2xx→throw）+ `nx run server:lint`（boundaries：integrations 不依赖业务 ctx）+ `env -u OSS_* pnpm -C apps/server tsx scripts/...export-openapi` boot 不因缺 env crash（`check-env-sync` 绿）

## Phase 1: Server — ideation 接地接线（回灌循环 + 条件注册 + SSE 新帧 + catalog/set-repo）

**Goal**：`codeindex_retrieval` 去 stub 真检索 + 回灌循环 + 降级；catalog/set-repo 端点；spec 9 条 state_branches 全覆盖（fake provider 确定性 + 真 code-index env-gated）。

- [X] T002 [P] [US1] [Server] **SSE 三新帧序列化纯函数**：`apps/server/src/ideation/ideation-sse.rules.ts` 加 `toSseToolStartFrame()`（`{"tool_start":"codeindex_retrieval"}`）+ `toSseSourcesFrame(sources)`（`{"sources":[{relPath,startLine,endLine,symbol?}...]}`，≤5）+ `toSseNoticeFrame(notice)`（`{"notice":"grounding_degraded"}`），**不 import chat**、与既有 token/suggestion/error 帧字段互不重叠 + vitest（三帧序列化 / JSON 转义 / 字段判别不撞）
- [X] T003 [P] [US1] [US2] [Server] **条件注册 + 来源映射纯函数**：`apps/server/src/ideation/ideation-tools.ts` 把 `INTERVIEW_PHASE_TOOLS` 常量改为 `interviewToolsFor(repo: string | null)`（repo 非空 → `[CODEINDEX_RETRIEVAL_TOOL, ASK_...]`；空 → `[ASK_...]`）+ 来源映射纯函数（`SearchHit[]` → `sources` 帧 DTO，截 ≤5）+ vitest（选仓含 codeindex / 未选仓不含 / 来源截断 ≤5 / 映射字段齐）
- [X] T004 [P] [US2] [Server] **set-session-repo UC + controller**：`apps/server/src/ideation/set-session-repo.usecase.ts`（写 `idea_session.repo`，conditional UPDATE `where {id, accountId, status:open}` affected-count，越权/不存在→字节级一致 404 反枚举）+ `session.controller.ts` 加 `PATCH /ideation/sessions/{id}/repo`（`@UseGuards(JwtAuthGuard)`，body `{repo}`）+ Testcontainers（选仓写入 / 切仓覆盖 / 越权拒字节级一致 / 非 open 拒）
- [X] T005 [US2] [Server] **catalog UC + controller**：`apps/server/src/ideation/repo-catalog.usecase.ts`（注入 `CODE_INDEX` port `listRepos()` 透传）+ controller `GET /ideation/repos`（`@UseGuards(JwtAuthGuard)`，端口不可达→映射可重试错误态，不 500 裸抛）+ Testcontainers（fake provider：列 repo + status/lastSha/chunkCount / 端口不可达→错误态 / 空列表）
- [X] T006 [US1] [US3] [Server] **clarify-turn UC 回灌循环改造（核心）**：`apps/server/src/ideation/clarify-turn.usecase.ts` 步1 `streamAskRound` 检测 `codeindex_retrieval` tool_call → ① `onToolStart` 回调（tool_start 帧）② 注入 `CODE_INDEX` port `search(session.repo, query, signal)` ③ append `assistant`(toolCalls) + `role:'tool'`(toolCallId, 命中 JSON) 到 `messages[]` → **重入 stream** 让模型据真实代码出问题 ④ `onSources` 回调（命中 ≤5）；**降级**：端口 throw → catch → `onNotice`（degraded）+ 空命中续步2，**不 abort**；**0 命中**正常回灌空集（FR-009）；步1 用 `interviewToolsFor(session.repo)`（条件注册，scope 查询补 `select repo`）；split-tx 不变（检索 tx 外 HTTP）。`clarify-stream.controller.ts` 加 `onToolStart`/`onSources`/`onNotice` 回调写对应帧；`ClarifyTurnCallbacks` 扩三回调 + Testcontainers（fake provider：命中→tool_result 回灌 + sources 帧 + 引用真代码 / 0命中→续问不造引用 / 不可达→notice + 续问不中断 / 未选仓→不调端口〔条件注册〕/ 选 repoA 命中A 切 repoB 命中B〔隔离〕 / abort 半成品保留）
- [X] T007 [US1] [US2] [US3] [Server-IT] **state_branches 全覆盖 IT**：`apps/server/test/integration/ideation-grounding.it.spec.ts`（全 boot + FakeLLM + fake code-index provider）覆盖 spec **9 条**（未选仓不接地 / 命中回灌+来源 / 0命中续问 / 不可达降级气泡不中断 / catalog 列表 / catalog 空态 / catalog 不可达错误态 / 切仓后续轮换命名空间 / repoA·repoB 命名空间隔离）+ **env-gated 真 code-index IT**（`RUN_CODEINDEX_IT`：真打 62 code-index `/search`+`/repos`，命中真 chunk + 命名空间隔离，默认 skip）

## Phase 2: 契约同步（Nx-driven）

- [X] T008 [Contract] [Verify] **swagger + openapi + api-client regen**：`session.controller`（set-repo PATCH）+ `repo-catalog.controller`（GET /repos）加 `@nestjs/swagger` 装饰器（catalog 列表 DTO：`repo/lastSha/indexedAt/chunkCount/status` + set-repo body/响应；SSE clarify 端点新帧不依赖 hook）→ `nx run server:export-openapi`（canonical `node dist/main.js`）→ `nx affected -t generate`（Orval regen：catalog + set-repo typed hook）→ mobile typecheck 绿

## Phase 3: Mobile US2 — 选择代码库真接线（InputPlusSheet stub → catalog）

**Goal**：「选择代码库」由 stub toast 改真 catalog 列表 + 选中写会话 repo（翻 mockup 帧 A / A2）。接地的「针对哪个仓」前置。

- [X] T009 [US2] [Mobile] **选择代码库真接线（翻面 A/A2）**：`apps/mobile/src/ideation/InputPlusSheet.tsx`「选择代码库」由 `fireToast(comingSoon)` 改真接线：orval catalog hook 拉真实 repo 列表（名 + 状态点 ready/indexing + 最近索引 + chunk 数，复用 `~/ui`/`~/theme` 0 新 token；indexing 置灰）→ 选中调 set-repo hook 写 `idea_session.repo` + 会话态（`use-ideation-session.ts`/`ideation-reducer.ts` 记 repo）；空态（无 ready repo）/ 错误态（可重试）per FR-010；NativeWind ≤4 原子超则抽组件 + a11y label + vitest（列表渲染 / 选中写 repo / 空态 / 错误重试 / 状态映射 `Record<Status,Meta>` 穷举）

## Phase 4: Mobile US1 + US3 — 来源展示 + 检索指示 + 降级气泡（翻 mockup 帧 B/C/D）

**Goal**：接地回答展示来源（折叠 ≤5）+ 检索指示（tool_start）+ 服务不可达降级气泡，端到端 dogfood。

- [X] T010 [US1] [Mobile] **SSE parse 扩展 + 来源折叠 + 检索指示（翻面 B/C/D 上）**：`apps/mobile/src/ideation/ideation-sse-parse.ts` `IdeationFrame` 联合加 `{type:'tool_start'}` / `{type:'sources';sources:[...]}` / `{type:'notice';notice:string}` + `parseFrame` 字段判别（与既有互不重叠，畸形帧返 null）+ `ideation-reducer.ts`/`use-ideation-session.ts` 接新帧（来源挂对应 assistant turn、检索指示态）+ 新 `SourcesDisclosure.tsx`（默认折叠「来源（N）」点开看 relPath:line，≤5，NativeWind ≤4 原子）+ `ClarifyChatScreen.tsx` 渲来源折叠 + tool_start「正在检索代码…」短暂指示（复用既有流式 chrome）+ vitest（3 帧解析 / 来源归属对应 turn / 折叠展开 / 检索指示态 / 畸形帧忽略）
- [X] T011 [US3] [Mobile] **降级系统气泡（翻面 D 下）**：`ideation-reducer.ts` 接 `notice` 帧落一条会话内系统提示态 + `ClarifyChatScreen.tsx` 渲一次性系统气泡（`surface-sunken` 居中 muted，与普通气泡区分；与既有 `error` 帧重试态不同语义）+ vitest（notice→系统气泡态 / 会话继续不中断 / 与 error 帧区分）
- [X] T012 [US1] [US2] [Mobile-E2E] **hermetic UI e2e（接地主干）**：`apps/mobile/e2e/ideation-grounding.spec.ts`（Playwright Expo Web，hermetic mock code-index catalog + SSE 接地帧；mock = 契约镜像 stateful canonical 非测试标志分支）验：开会话 → 点选择代码库见真实列表 → 选 mono → 提问 → 见 tool_start 指示 + 来源折叠（展开看出处）→ 切 repo 后续轮命名空间变 → 停服 mock 触发降级气泡（会话继续）。注：SSE mock 一次性全帧，真增量由 server IT(T007) 兜底；文件名 `.spec.ts`

## Phase 5: 契约冒烟 + 收尾

- [X] T013 [US1] [US2] [Contract-Smoke] **契约冒烟**：`apps/mobile/e2e/contract-smoke/ideation-grounding.contract.ts`（node 层，生成的 `@nvy/api-client` 打 testcontainers 真 server，`IDEATION_FAKE_LLM` + fake code-index provider env 注入）：登录 → 建会话 → `GET /ideation/repos` 拉 catalog → `PATCH .../repo` 选仓 → 验 `idea_session.repo` **真落库** → 澄清轮（流式读到 tool_start + sources + token 帧）→ 验 catalog/set-repo/接地帧契约对齐（URL/method/序列化/错误码）；落共享套件 `nx run mobile:contract-smoke`
- [X] T014 [Verify] **PR gate**：`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main`（首跑 `--skip-nx-cache`）全绿 + moat/boundaries 0 violation（ideation 经 `CODE_INDEX` port、不 import chat、不碰他 ctx 表）+ `[Contract-Smoke]` 绿 + spec `status: draft→implemented` + tasks.md `[X]` 全同步 + PR body 3 checkbox 部署 gate + **flag「网络暴露（WireGuard 62↔77 + 真 `CODE_INDEX_URL`/token）= 部署前置，本 PR 用 fake provider，真接线在部署章/后续；建议人工 review 部署 gate」**

---

## Dependencies & 执行顺序

```text
T001(codeindex 端口 + config) ─┬─► T002/T003 [P] 纯函数(SSE 帧 / 条件注册+来源映射, 无 DB)
                                ├─► T004(set-repo UC) ─┐
                                ├─► T005(catalog UC, 注端口) ─┤
                                └─► T006(回灌循环, 注端口, 依赖 T002/T003) ─► T007(state_branches IT, 依赖 T004-T006)
T004/T005/T006 + swagger ─► T008(export-openapi + api-client regen)
T008 ─► T009(选库真接线 US2) ─► T010(来源+检索指示 US1) ─► T011(降级气泡 US3) ─► T012(US1/US2 e2e)
T006 + T008 ─► T013(Contract-Smoke 真 server + repo 落库)
全部 ─► T014(PR gate)
```

## 并行机会（per phase）

- **Phase 1 纯函数**：T002（SSE 帧）/ T003（条件注册 + 来源映射）不同文件、仅依赖类型 → `[P]` 并行。
- **Phase 1 端点**：T004（set-repo）/ T005（catalog）相对独立（不同 UC/端点，均注端口）可交错；T006（回灌循环）依赖 T002/T003 纯函数。
- **Phase 3/4 链**：T009（选库）→ T010（来源）→ T011（降级）顺链（共享 reducer/screen，注意先后）；T012 e2e 收口。

## Implementation Strategy（MVP first）

1. **MVP = US1+US2 脊柱**（T001-T008 server/契约 + T009-T010 mobile）：选仓 → 提问 → 真检索回灌 + 来源展示。过此即 SC-001/SC-002（接地准确 + 命名空间隔离）dogfood 闭环成立。
2. **增量 US3**（T011）：服务不可达降级气泡——韧性，挂主干后。
3. **收尾**（T012-T014）：e2e + 契约冒烟 + PR gate。
4. **Clear 检查点批次**（per `.claude/rules/implement-task-closure.md`）：建议批次 =〔T001〕/〔T002-T003〕/〔T004-T005〕/〔T006-T007〕/〔T008〕/〔T009-T010〕/〔T011-T012〕/〔T013-T014〕，每批后停顿提醒 `/clear`。

## 部署前置（不在本 impl scope，部署章/后续 PR）

- **网络暴露 E**（plan §7 / S2 plan §E）：WireGuard 隧道 62↔77 + 真 `CODE_INDEX_URL`/`CODE_INDEX_SERVICE_TOKEN` env 接线（9 位置已在 T001 铺占位）。本 feature 业务 impl + IT/e2e 全走 fake/mock code-index provider，**不依赖真隧道**；真接线 + 隧道在部署 PR 补。T014 PR gate flag 之。
