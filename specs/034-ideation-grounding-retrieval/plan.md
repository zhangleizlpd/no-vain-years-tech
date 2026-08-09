---
feature_id: 034-ideation-grounding-retrieval
spec_ref: ./spec.md
status: drafted
created_at: 2026-06-23
updated_at: 2026-06-23
adr_refs: ['0024', '0027', '0040', '0043', '0055', '0057', '0058', '0059', '0060']
context7_verified: []
---

# Implementation Plan: ideation 接地检索接线（grounding · S3）

## Summary *(mandatory)*

把 ideation 澄清的 `codeindex_retrieval` 工具从 stub 接到 S2 `services/code-index`：会话锁定一个目标 repo（写 `idea_session.repo`），澄清助手调工具时真调 `POST /search` 检索该 repo 命名空间、把命中代码作为 `tool_result` 回灌给 LLM 接地、并以 `sources` 帧回流前端展示。技术路径 = 新 `integrations/codeindex` 端口（HTTP provider + fake，镜像 `integrations/llm` ADR-0058 范式）+ ideation UC 引入 **tool-result 回灌循环**（替换现有「stub 标记直接进步2」）+ 新 catalog/set-repo 端点（OpenAPI → api-client regen）+ mobile「选择代码库」真接线 + 来源/检索指示/降级 UI。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None（无新 npm 依赖） | code-index 客户端用 Node 内置 `fetch`（undici，Node 22 LTS 原生全局）打 `services/code-index` HTTP；server/mobile 均不新增包。api-client 经既有 orval 链 regen | Node 22 LTS 全局 `fetch` 稳定（已是当前 runtime，constitution Tech Stack）；`services/code-index` 契约见 `services/code-index/src/server.ts:43,46` |

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles。

> ✅ **§I Mockup gate — 已满足（决策 A，2026-06-23）**：为 3 处增量 affordance（① InputPlusSheet「选择代码库」真实 repo 列表 + 空态；② 助手回答下「来源（N）」折叠/展开；③ `tool_start`「正在检索代码…」指示 + code-index 不可达会话内系统气泡）补轻量 Claude Design mockup（绑 mono DS，全复用 token、零新增配色）→ 落 `design/grounding-ui.dc.html`（5 状态帧）+ `design/_ds/colors_and_type.css` + `design/handoff.md`；Playwright 渲染自验 **0 console error / 0 failed request**。clarify→**mockup**→plan 链补齐。Claude Design 链见 handoff.md。

- **§II TDD**：每 task 红→绿。server 走真后端 IT（`IDEATION_FAKE_LLM` + **fake code-index provider**，Testcontainers）；mobile 逻辑 vitest（sse-parse 新帧 / reducer）；UI Playwright Expo Web e2e（code-index 走 hermetic mock）。
- **§III Atomic task**：按 30min-2h 拆（codeindex port / UC 回灌循环 / 条件注册 / SSE 新帧 / catalog 端点 / set-repo 端点 / api-client regen / mobile 选择器 / mobile 来源+指示+降级 / 各层测试）。
- **§IV Module Boundary（扁平+贫血+护城河）**：
  - ideation UC 注入新 `CODE_INDEX` 端口（platform integration，**非他业务 ctx**，与注入 `LLM_PROVIDER` 同类，无护城河注释要求 per ADR-0041 platform infra 例外）。
  - `idea_session.repo` 写入 = ideation **自己的表**（Q1 → 留 ideation ctx，直注 `PrismaService`，无 repository，贫血 row）。
  - **不 import chat**（SSE 帧自有，per ADR-0055 范式复用≠import；ideation-sse.rules.ts 已独立）。
- **§V 单 PR + 类型链**：跨端单 PR —— server（端口 + UC + 端点）+ 真后端 IT + `@nvy/api-client` regen + mobile 消费 + 两层验证（`[Mobile-E2E]` hermetic + `[Contract-Smoke]`）原子 merge。

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [ ] **Server**: 真后端 IT（PG via Testcontainers + `IDEATION_FAKE_LLM` + **fake code-index provider**）覆盖每个新端点（catalog `GET /repos`、set-repo）+ 接地回灌循环（命中 / 0 命中 / 服务不可达降级三态）至少各一次。
- [ ] **Mobile / Web**: 每条 P1 user story golden-path 走 Playwright Expo Web（code-index hermetic mock）：选仓 → 提问 → 见来源折叠 + tool_start 指示；切仓命名空间隔离；停服降级气泡。
- [ ] **Evidence**: impl 阶段产出 server IT spec（`apps/server/src/ideation/*.spec.ts` + integration）+ `apps/mobile/e2e/` ideation grounding spec + `[Contract-Smoke]` 套件（`apps/mobile/e2e/contract-smoke/ideation-grounding.contract.ts`，打 testcontainers 真 server 验 catalog/接地帧契约）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** — 本 plan **不引入新第三方包**（code-index 客户端用 Node 内置 `fetch`；server/mobile 零新依赖）。**Evidence**: 见 Dependencies 表 `None`；`services/code-index` 是本仓已上线的 standalone 服务（非第三方），契约 `services/code-index/src/server.ts`。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A — feature 为 mono-native**（ideation S3 接地，无任何旧 meta-repo 迁入代码/路径/类名）。Evidence: `rg -n 'mbw-|org\.springframework|src/main/java' specs/034-ideation-grounding-retrieval/` → 无命中（impl 起手复跑）。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| ADR-0059（ideation 接地索引）| 「接地以 stub ship，S3 接真索引」—— 本 feature 正是兑现 | mitigated | 接 `integrations/codeindex` 端口真检索，stub 退役 |
| ADR-0060（索引运行时按需 + 可手动停）| 「服务可手动停 → chat 优雅降级」 | mitigated | FR-008 降级（端口不可达 → 返空 + 会话内系统气泡，不阻断） |
| ADR-0058（integrations 平台层）| 平台端口聚合（LLM 已迁）| accepted-as-is | 新增 codeindex 端口同构落 `integrations/codeindex/` |
| ADR-0045（OSS 大附件）| 本 feature **不触发**（无附件/上传）| accepted-as-is | 无 OSS 交互 |

**Evidence**: `rg -n 'Open Question|stub|S3' docs/adr/0059*.md docs/adr/0060*.md` 人工核对；网络暴露（WireGuard/env）= 部署前置，不在本 ADR scan（属运维，见 Architecture Notes §部署前置）。

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock` 隔离单测。用 `Test.createTestingModule({ imports: [...] }).compile()` 装真 DI 容器。
- **MANDATORY INTEGRATION**: 接地回灌循环 + 端点必须在 `createTestingModule` 真 lifecycle 中测（fake code-index provider 经 DI 注入，非 `new`）。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 每条（未选仓不接地 / 命中 / 0 命中 / 服务不可达降级 / catalog 空 / catalog 错 / 切仓 / 命名空间隔离）**必须**有对应 `it()` 块。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)** — Flat + Anemic + Zero-Class + Moat。新文件平铺于 `apps/server/src/ideation/` 与 `apps/server/src/integrations/codeindex/`；数据 = 裸 Prisma row；UC 直注 `PrismaService` + 端口；不建 repository / domain class。

#### 1. code-index 端口（新 platform integration，ADR-0058 同构）

- 新目录 `apps/server/src/integrations/codeindex/`，镜像 `integrations/llm` 范式：
  - `code-index.port.ts` —— `CODE_INDEX` DI token + `CodeIndexPort` 接口：`search(repo, query, signal?): Promise<CodeChunk[]>` + `listRepos(): Promise<RepoCatalogEntry[]>`。类型为 ideation 侧自有 DTO（贫血），形状对齐 code-index `SearchHit`（`relPath/kind/symbol/startLine/endLine/score/text`，见 `services/code-index/src/query.ts:5`）与 `RepoMeta`（`repo/lastSha/indexedAt/chunkCount/status`，见 `services/code-index/src/meta.ts:4`）。
  - `http-code-index.provider.ts` —— 真 provider：`fetch(CODE_INDEX_URL + '/search'|'/repos', { Authorization: 'Bearer '+token })`；超时（AbortSignal）+ 非 2xx/网络错 → throw（UC catch 降级）。`/search` body `{repo, query, topK?}`，401/400/5xx 区分日志。
  - `fake-code-index.provider.ts` —— IT 替身（确定性命中脚本 + 可注入「不可达」态测降级）。
  - `code-index.module.ts` —— provider 经 `CODE_INDEX_PROVIDER` env 选 http/fake（同 `llm-router` 范式）。
- **config / env-sync（部署前置铺路）**：`CODE_INDEX_URL` + `CODE_INDEX_SERVICE_TOKEN` 走 `config-env-sync` **9 位置 boot-path**（`.env.example` / `vitest.config.ts` test.env 占位 / `docker-compose.tight.yml` 映射 …；缺一 prod boot crash，lefthook `check-env-sync` 拦）。本地 IT 用 fake provider，不需真 URL。镜像 `sms.config.ts` zod discriminated-union 范式（boot `.parse()` 兜底；boot healthy ≠ cred 有效）。

#### 2. ideation UC：tool-result 回灌循环（核心变更，替换现 stub）

- 现状（`clarify-turn.usecase.ts:294-328` `streamAskRound`）：模型发起 `codeindex_retrieval` 仅置 `groundingOnly=true`、**不回灌**、直接进步2。
- 改为**回灌循环**：步1 stream 检测到 `codeindex_retrieval` tool_call →
  1. 发 `tool_start` 帧（onToolStart 回调，「正在检索代码…」）；
  2. 经 `CODE_INDEX` 端口 `search(session.repo, query, signal)`；
  3. 把 `assistant`（带 toolCalls）+ `tool`（role:'tool', toolCallId, content=命中 JSON）消息**追加进 `messages[]`**（`Msg` 已支持 `role:'tool'` + `toolCallId`），再**重入 stream** 让模型据真实代码出澄清问题；
  4. 命中结果经 `sources` 帧回流（onSources 回调，folded list，**上限默认 ≤5**，per Clarifications）。
- **降级**（FR-008 / ADR-0060）：端口 throw（不可达/超时/401/5xx）→ catch → 发**降级 notice 帧**（会话内系统气泡）+ 视作空命中、继续步2 提问，**绝不** abort/error 整轮。**0 命中**（端口正常返 `[]`）与**不可达**（throw）严格分流（FR-009）：0 命中正常回灌空集，模型据「未找到」继续。
- **split-tx 不变**：检索是 tx 外 HTTP（既有 split-tx 纪律，server-impl-playbook「外部 I/O split-tx」）；assistant/tool turn 落库仍流后短写。来源**不单独落 idea_turn 表**（本期挂在 assistant turn 内或仅 SSE 瞬时回流；是否持久化 sources 留 tasks 决策，倾向 assistant turn `suggestion` 旁加 `sources` Json 或瞬时不落——见 §5 开放点）。

#### 3. 条件注册（FR-007，Clarifications 决策）

- `INTERVIEW_PHASE_TOOLS`（`ideation-tools.ts:151` 现为常量含 codeindex）→ 改为按 `session.repo` 派生：`interviewToolsFor(repo)` = repo 非空时 `[CODEINDEX_RETRIEVAL_TOOL, ASK_...]`，repo 空时 `[ASK_...]`。**未选仓时 LLM 根本拿不到检索工具**（不会尝试不可用工具）。UC 步1 取 `session.repo`（scope 查询已 `select`，加 `repo` 字段）。

#### 4. SSE 帧扩展（ideation-sse.rules.ts + 解析端对齐）

- 新增三帧序列化（`ideation-sse.rules.ts`，纯函数，不 import chat）：
  - `tool_start` 帧 `{"tool_start":"codeindex_retrieval"}` —— 检索开始指示（Clarifications：复用 030 tool_start 语义）。
  - `sources` 帧 `{"sources":[{relPath,startLine,endLine,symbol?}...]}` —— 命中来源 JSON 收口整出（≤5）。
  - `notice` 帧 `{"notice":"grounding_degraded"}` —— 降级系统气泡（FR-008）。
- controller（`clarify-stream.controller.ts`）注入对应回调（onToolStart/onSources/onNotice），ClarifyTurnCallbacks 扩三回调。
- mobile `ideation-sse-parse.ts:31` `IdeationFrame` 联合加 `{type:'tool_start'}` / `{type:'sources';sources:...}` / `{type:'notice';notice:string}` 三变体 + `parseFrame` 字段判别（与既有 token/suggestion/error 互不重叠）。vitest 补帧解析单测。

#### 5. catalog + set-repo 端点（OpenAPI → api-client）

- **catalog**：新 `GET /api/v1/ideation/repos`（`session.controller.ts` 或新 `repos.controller.ts`）→ 调端口 `listRepos()` → DTO（`repo/lastSha/indexedAt/chunkCount/status`）+ `@nestjs/swagger` 装饰器 → OpenAPI → orval regen `@nvy/api-client`。端口不可达 → 返错误态（前端可重试，FR-010）。
- **set-repo**：会话选/切仓写 `idea_session.repo`。新 `set-session-repo.usecase.ts`（ideation 自表，直注 Prisma，conditional update by `{id, accountId}`）+ 端点（`PATCH /api/v1/ideation/sessions/:id/repo` 或纳入既有 session 更新）。scope 校验同 `clarify-turn` 反枚举 404。切仓**只影响后续轮**（FR-006，既有 turn 引用不回改 = 不动历史）。
- **data model**：`idea_session.repo` 字段**已在** `schema.prisma`（nullable string，#548 era 预留）→ **无 migration**。仅赋真实读写语义。

#### 6. mobile 消费

- **选择代码库**（`InputPlusSheet.tsx`「选择代码库」现 stub `fireToast(comingSoon)`）→ 改：api-client 拉 catalog（react-query）→ 真实 repo 列表（名 + 状态：最近索引时间/ready/indexing）→ 选中调 set-repo → 写会话态（`use-ideation-session.ts` / reducer）。空态（无 ready repo）/ 错误态（可重试）per FR-010。RHF 不涉（非表单，是列表选择）。
- **来源展示**：ClarifyChatScreen 助手气泡下挂「来源（N）」**默认折叠**列表（点开看 relPath:line），≤5；新增 `~/ui` 或 ideation 内 `SourcesDisclosure` 组件（NativeWind ≤4 原子，复用既有 token）。
- **检索指示**：`tool_start` 帧 → 短暂「正在检索代码…」指示（复用既有流式态 chrome）。
- **降级气泡**：`notice` 帧 → 会话内一次性系统气泡（reducer 落一条 system 提示，e2e 可断言）。
- **隔离性**：会话态记 `repo`，切仓后续轮 query 带新 repo（命名空间隔离由 server `session.repo` 锁定，mobile 只持选择）。

#### 7. 部署前置（划出本 feature 业务范围，plan 记录、impl 不阻塞）

- 网络暴露：62（code-index）↔ 77（ideation server）跨账号、`CODE_INDEX_URL`/token 走**公网** → **WireGuard 隧道**加密（token 明文严禁裸公网，per S2 plan §E）；备选自签 TLS 反代。
- 本 feature 业务实现与 IT/e2e 用 **fake/mock provider** 完成，**不依赖**真隧道；隧道 + 真 env 接线在**部署 PR**（或本 PR 部署章）补，per `config-env-sync` 9 位置。

### 🚨 Impl Guardrails（并发 / 安全 / 前端）

- **并发/事务**：set-repo 单行状态写用 conditional UPDATE affected-count（`updateMany where {id, accountId}`），READ COMMITTED；**NEVER** 单行 FOR UPDATE。检索 HTTP 是 tx 外（split-tx）。
- **安全**：code-index service token 经 env 注入、`Authorization: Bearer`，**不入日志/不回前端**；catalog/set-repo 端点走既有 ideation 鉴权（accountId scope，反枚举 404 字节级一致）。降级提示**不泄露**内部错误细节（FR-008，只「索引服务暂不可用」）。
- **前端（mobile）**：复用 `~/theme`+`~/ui`、Orval 函数式 hook（非 class）、axios 不删（Strangler-Fig）；列表/折叠走 NativeWind ≤4 原子抽组件；a11y label 不省；hermetic e2e mock = 契约镜像（stateful canonical，禁按测试标志分支）。

## Complexity Tracking

> 无 constitution 违背需 justify（§I mockup gate 已满足，见 Constitution Check）。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| （无） | — | — |
