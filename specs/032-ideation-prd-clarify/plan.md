---
feature_id: 032-ideation-prd-clarify
spec_ref: ./spec.md
status: drafted
created_at: 2026-06-21
updated_at: 2026-06-21
adr_refs: ['0032', '0043', '0055', '0057', '0058', '0059']
context7_verified: []
---

# Implementation Plan: 移动端「需求灵感澄清」助手 — 文字闭环（ideation B1）

## Summary *(mandatory)*

新建 **ideation 第 8 限界上下文**（ADR-0057），落「+ FAB 创建会话 → AI 多轮反问澄清〔含建议式选项 chips〕→ 用户点收敛产出结构化 brief → 导出交接」纯文字闭环。技术路线：复用 027-031 chat 的 SSE 流式 + split-tx 终态 + accountId 归属/反枚举链路，但 LLM provider **先从 `chat/` `git mv` 到平台层 `integrations/llm/`**（ADR-0058）由 chat + ideation 共享 port；接地能力仅落**代码级 stub 接缝**（ADR-0059，本期 repo-blind）。HOW 细节（brief 段落契约 / 两相驱动剧本 / chips 两道闸 / M3 默认）见 [契约 doc](../../docs/private/plans/2026-06/06-21-ideation-brief-contract-and-elicitation.md)，本 plan 不复述、只锚关键决策。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None（server） | 复用现有 `@nestjs/swagger` / Prisma / 现有 LLM provider（DeepSeek + MiniMax M3 均已在 chat ctx 落地，仅物理 `git mv` 到 `integrations/llm/`，非新依赖） | 现状：MiniMax M3 provider 已随 029 双模式落地（`apps/server/src/chat/`，本 PR 搬迁，不新增包） |
| None（mobile） | 复用 `~/theme` + `~/ui` + Orval 函数式 hook + RHF/zodResolver（标题输入）+ 027 SSE 消费范式；FAB 浮层走 RN 内建 `Modal`（已用于现有 overlay 范式，无新包） | [fe-directory-structure.md](../../docs/conventions/fe-directory-structure.md) / 现有 `ConfirmModal.tsx` 用 RN `Modal` |

> Mockup baseline 已落 `design/`（面 A 创建浮层 / 面 B 澄清对话+chips / 面 C brief 预览导出，**0 新 token**，token 同步已验）。

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles, OR every violation is justified in the Complexity Tracking below.

逐条对照（v1.3.0；v1.4.0 mockup 闸 merge 时继承）：

- **I. SDD**：已 specify → clarify（4 决议）→ mockup（三面 baseline）→ 本 plan；后续 tasks → analyze → implement 不跳步。
- **II. TDD**：每 task 红→绿→闭环；server lifecycle（JWT guard / SSE interceptor）走 `createTestingModule` 真 DI 不 mock（见 Testing Invariants）。
- **III. Atomic task**：tasks 阶段按 30min-2h 拆；provider `git mv`、注册四处、3 表 schema、两相剧本、3 面 UI 各自 atomic commit。
- **IV. Module boundary（扁平+贫血+护城河+零-class）**：ideation = **叶子 ctx**，单向不被任何 ctx 依赖；**禁 import chat ctx**（LLM 经 `integrations/llm` port，vendor I/O 不计 ctx 依赖 per ADR-0043 §4 / ADR-0057 §2）；3 表全在 ideation ctx 内，无跨 ctx `tx.<otherTable>.*`；数据 = 贫血 Prisma row（`@map`）+ `*.rules.ts`，零充血 class。
- **V. 类型同步链 + 单 PR**：跨端 feature 单 PR 原子 merge（server impl + IT + `nx run server:export-openapi` + api-client regen + mobile 消费 + 两层验证 ①hermetic e2e ②契约冒烟）。

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: real-boot smoke（Testcontainers PG + Redis）覆盖每个新端点 ≥1 次——会话 CRUD / 澄清轮 SSE 流 / 生成 brief / 删除，且经 `IDEATION_FAKE_LLM` 注入假模型驱动两相 + chips 结构化 + emit（契约 doc §7）。unit/module 不充分。
- [x] **Mobile**: P1 golden-path 真 Expo 走查——+ FAB 建会话 → 多轮澄清（含点 chip + 自由文本）→ 生成 brief → 导出。
- [x] **Evidence**: 计划落 `apps/server/src/ideation/*.it.spec.ts`（Testcontainers）+ `apps/mobile/e2e/contract-smoke/ideation.contract.ts`（契约冒烟）+ Playwright Web hermetic e2e；impl 阶段产出 commit 链。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A — 无新第三方包**。DeepSeek + MiniMax M3 provider 均已在 chat ctx 落地（029 双模式 ship），本 feature 仅把 provider 文件 `git mv` 到 `integrations/llm/` 并由 ideation 经 port 复用；mobile 侧 FAB 浮层用 RN 内建 `Modal`，无新包。**Evidence**: N/A。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] **N/A — feature is mono-native**。ideation 是全新 ctx，无 meta-repo（Java/Spring）迁入血统；spec/plan 无 stale Java class / Maven coord / Spring 路径。**Evidence**: `rg -n 'mbw-|org\.springframework|@RequestMapping' specs/032-ideation-prd-clarify/` → 空。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| ADR-0055（chat SSE + LLM provider） | provider 物理位置（原在 `chat/`） | escalated-to-amend | provider `git mv` 到 `integrations/llm/` 同 PR；ADR-0055 补 amend 记录物理位置变更 + chat 行为不变（IT 全回归） |
| ADR-0058（integrations 平台层） | `integrations/llm` port 形状（chat + ideation 双 consumer） | mitigated | 本 plan 锚定单 `LLM_PROVIDER` port；ideation 自写 stream controller（范式复用 ≠ 代码 import） |
| ADR-0059（repo 接地） | B1 接地缝形状（codeindex_retrieval stub） | accepted-as-is | 本期 adapter=stub / 不入访谈菜单；schema 预留 `repo` nullable + T2 字段；收敛门不含 T2（FR-011 + SC-007） |
| ADR-0057（ideation ctx） | context 注册四处 | mitigated | B1 PR-1 一次到位：prisma schema `ideation` + ESLint boundaries/Nx tags + moat ownership 探针 + business-naming |

**Evidence**: `rg -ln 'Open Question' docs/adr/005[5789]*.md docs/adr/0057*.md` → 上述 4 ADR；amend/注册随本 PR ship。

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock(...)` 隔离单测。ideation 复用现有 JWT guard + SSE 流式 interceptor（reply.hijack），必须真 DI lifecycle。
- **MANDATORY INTEGRATION**: 用 `Test.createTestingModule({ imports: [IdeationModule] }).compile()` 装真 DI 容器；`createTestingModule` 之外的"测试"视同未测。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 每条（共 ~19 条：建会话 / 流式澄清 / chips 过闸 / 不过闸纯文本 / 自由文本覆盖选项 / 收敛齐 / 收敛缺段追问 / 小颗粒自适应 / 导出 / 重开回流 / 重新生成覆盖 / 删除 / 中途退出 / 列表隔离 / 越权拒 / 401 refresh / provider 失败 / abort 保留 / 空白拒 / 接地 stub 不阻塞）必须有对应 `it()` 块。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)** — Flat + Anemic + No-Repo + Moat。ideation module 所有文件平铺 `apps/server/src/ideation/`，无 `domain/application/infrastructure/web` 子目录；数据 = 贫血 Prisma row（`@map` camelCase）；UseCase 直注 `PrismaService`，无 repository port；业务不变量入 `*.rules.ts` 纯函数；**禁 `tx.<otherTable>.*`**（ideation 叶子 ctx，本期 3 表全自有，无跨 ctx 写）。

**① 限界上下文 + 注册四处（ADR-0057，B1 PR-1 一次到位）**
- 新 ctx `ideation`（叶子，不被任何 ctx 依赖；不塞 chat）。注册四处：(a) `apps/server/prisma/` schema `ideation` + 3 表；(b) ESLint `boundaries` + Nx `depConstraints` tag `scope:ideation`，单向、禁 import `chat`；(c) `scripts/checks/check-server-moat.ts` ownership 探针纳入 ideation 表；(d) `docs/conventions/business-naming.md` 列 `ideation`。
- **LLM 复用经 port，不 import chat**：`integrations/llm` 是 vendor I/O port（ADR-0058），不计 ctx 依赖（ADR-0043 §4）；ideation 注 `LLM_PROVIDER` token，**自写 stream controller**（SSE 范式复用 ADR-0055，非代码 import）。

**② provider 搬迁（ADR-0058，本 PR 前置改造）**
- 把 LLM provider（DeepSeek + MiniMax M3）从 `apps/server/src/chat/` `git mv` 到 `apps/server/src/integrations/llm/`；chat + ideation 绑同一 `LLM_PROVIDER` port。chat 行为零变更、IT 全回归。ADR-0055 补 amend 记物理位置。**这是触碰 chat ctx 的唯一改动**，与 ideation 注册同 PR。

**③ 数据模型设计意图（SoT = schema.prisma，此处仅 prose 意图，不镜像 schema）**
- **`idea_session`**：accountId 归属、`title`、`status`（`open | converged | handed-off`，**可从 converged/handed-off 重开回 open**，状态机非单向）、**`repo` nullable**（接地缝预留，本期不暴露 UI，S3 才点亮）。账号级永久保留、无自动清理；用户可删（连带 turn + brief）。
- **`idea_turn`**：所属会话、`role`（`user | assistant`）、`content`；assistant 轮可携 `suggestion`（本轮 chips：question + options[] + recommended 标注 + multi_select + allow_freetext）。**只追加不回改**（append-only）；abort 半成品 turn 保留、provider 失败不落半截（split-tx 终态语义复用 027/030）。
- **`requirements_draft`（brief）**：**规范态 = 结构化 JSON 真相源**（zod 强校验 T1 五段齐 + 类型），**导出态 = 渲染 markdown**。**一会话一份（1:1）**，重新生成**覆盖**上一版（不留 v1/v2 历史，后续按需扩展）。段落三层（契约 doc §2）：T1 核心必填（`problem`/`user_stories`/`functional_requirements`/`success_criteria`/`non_goals`，收敛硬门只查这 5 段）+ T2 接地段（`affected_surface`/`constraints_guardrails`/`data_model_sketch`/`api_contract_sketch`，**非阻塞**，本期 stub 留空/手填）+ T3 可选段（`edge_cases`/`nfr`/`ui_notes`/`open_questions`/`phase_boundary`，随规模自适应跳过）。
- **`idea_attachment`（多模态）= B2，本期不落**。

**④ 两相驱动剧本（契约 doc §3，server 编排 DS/M3）**
- **相 A 访谈**（每条用户消息驱动，per-turn 两步微循环 §4.4）：步1 接地 `tools:[codeindex_retrieval]` `auto`（本期 stub，返空/不入菜单 → 直接进步2）；步2 提问 `tools:[ask_clarifying_question]` `required`(M3)/best-effort(DS) → 出 `{question, options[], multi_select, allow_freetext}`。
- **相 B 产出**（用户点「生成 brief」触发）：`tools:[emit_requirements_brief]` **forced**（M3 `required`；DS 降级 best-effort + 正则兜底 + 吐不出降纯文本）。访谈期**不给** emit 工具、产出期**强制** emit。**相位切换 = 工具菜单切换**（mono 编排核心杠杆）。
- **收敛触发 = 用户按钮**（非模型吐 sentinel）；AI 可软提示「够清楚了」。收敛门只查 T1 五段齐（zod），未齐继续追问、不产半截。

**⑤ 建议式选项 chips 两道闸（契约 doc §4，FR-004）**
- chips 仅当**两闸同过**才出，否则纯自由文本：闸一=答案空间可枚举（≤4 稳定选项）、闸二=AI 有可辩护推荐（行业惯例/最佳实践/领域约定）。推荐项内嵌「（推荐）」+ 排首位 + 轻量 brand-soft 区分、**不预选**；末位永远「都不是/自己填」逃生；**自由文本永远 live**。第一个问题永不给 chips（反锚定）。chips 是增强、非硬依赖（DS 吐不出降级纯文本，正则兜底捞结构化）。

**⑥ 模型策略（契约 doc §5，FR-010 降级）**
- 结构化轮（提问步 + emit 相）**默认 MiniMax M3**（`required` 稳定保证 chips/brief）；DeepSeek V4 作降级 best-effort（恒思考模式不支持强制 `tool_choice`，HTTP 400）。经 `integrations/llm` port 路由。

**⑦ 接地 stub 接缝（ADR-0059，FR-011 / SC-007）**
- `codeindex_retrieval` 本期 = stub（返空 / feature-flag off / 不入访谈菜单）；`repo` 字段 nullable 后台预留、**不展示选择器 UI**；T2 接地段留空/手填，缺失**不阻塞收敛门**。S3 接真索引服务时 adapter drop-in、访谈剧本零改动。

**⑧ API surface 设计意图（SoT = `@nestjs/swagger` 装饰器 → OpenAPI，code-first）**
- 会话 CRUD（建/列/查/删，p95 300ms）；澄清轮 **SSE 流式**（首 token p95 2s，复用 027/030 流式预算 + `reply.hijack()` split-tx）；生成 brief（收敛产出，p95 8s）；导出 markdown。全部 accountId 归属隔离 + 字节级一致反枚举（越权读/写/删拒）；未认证 → 401 → 003 refresh retry-once。abort（用户停止）保留半成品；provider 失败（非 abort）不落半截 + 可重试。

**⑨ Mobile UI（mockup-first，design/ baseline）**
- **导航（本 plan 决策，解 spec deferred）**：**独立 ideation stack** `app/(app)/ideation/`（`index.tsx`=会话列表 US2 / `[id].tsx`=对话页面B + brief 面C）。**外脑(pkm) tab B1 期暂指向 ideation 列表**（现 `pkm.tsx` 空占位 `<Redirect>`/直渲列表，PKM unpark 后再分流；redirect-vs-直渲为 impl 细节）。
- **创建入口 = app-shell chrome**：中央绿色 + FAB（`ok #10B981`）+ 创建面板落 `app/(app)/(tabs)/_layout.tsx`，**盖 tab 栏须 root RN `Modal`**（非 tab 内 absolute）；优先图二锚定浮层（从 + 长出 + 指向三角），bottom-sheet 仅某端难实现时降级。本期面板只挂「prd灵感」活入口 + 置灰未来槽位（不命名）。点 prd灵感 → 标题输入（RHF + zodResolver）→ 建会话 push `/ideation/[id]`。
- **tab 栏高度不覆写**（`_layout.tsx` 注释：交给 `49+insets.bottom`）；FAB 经 custom `tabBar` 或 root 层 absolute 叠加。
- **澄清对话**：消费 027 SSE 范式（typed Orval hook，非 class，axios 不删）；chips 点选**直接发送**该值成本轮回答（契约 §4.5，2026-06-22 翻转回归 mockup ③ 直发；逃生项点击转聚焦自由输入条自填）；自由输入条全态常驻。
- **brief 预览/导出**：结构化分段渲染（非 markdown 源码）；T2 接地段灰色虚线非阻塞占位（非报错样式）；导出/复制 markdown + 重新生成 + 状态徽标（回流提示）。

### 🚨 Impl Guardrails（并发 / 安全 / 前端）

- **并发/事务**：会话/brief 单行状态转换用 conditional UPDATE affected-count（`updateMany where {id, accountId, <前置 status>}` → count===1 won / 0 lost，READ COMMITTED）；**NEVER** `FOR UPDATE`/Serializable。SSE 流式外部 LLM I/O **split-tx**（禁 tx 内持锁等 HTTP）；assistant turn 落库与终态写按 027/030 split-tx 语义（completed/stopped/error）。brief 1:1 覆盖走 upsert（会话内单份）。
- **安全**：accountId 越权读/写/删**字节级一致折叠**（反枚举，与 027-031 同款，dummy 路径 constant-time pad）；无新 PII 字段（title/content 非敏感，不引 AES-GCM）。
- **前端（mobile）**：标题输入 **RHF + zodResolver** 4 铁律（Controller≠register / 表单态≠副作用态 / isSubmitting 单源 / 错误+a11y）；port Strangler-Fig（复用 `~/theme`+`~/ui`、Orval 函数式 hook、axios 不删）；FAB 浮层 root Modal + 真机/窄视口验（容器尺寸类改动 web e2e 易漏，per mobile-impl-playbook）。

## Complexity Tracking

> 无 Constitution 违规，无需填写。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| N/A | N/A | N/A |
