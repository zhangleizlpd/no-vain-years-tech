---
feature_id: [###-feature-name]
spec_ref: ./spec.md
status: drafted
created_at: [YYYY-MM-DD]
updated_at: [YYYY-MM-DD]
adr_refs: []
context7_verified: []
---

# Implementation Plan: [FEATURE]

<!--
Frontmatter fields:
- feature_id: must equal spec.md frontmatter feature_id
- spec_ref: relative path to spec.md
- status: drafted → approved → superseded
- adr_refs: list of ADR ids this plan depends on (e.g., ["0019", "0043"])
- context7_verified: library names whose API surface was grounded via
  mcp__context7__query-docs during plan drafting (populated by
  context7-injection preset workflow)

This plan is PROSE-ONLY. The data model lives in schema.prisma (SoT); the API
surface lives in @nestjs/swagger decorators → OpenAPI (code-first SoT, per
docs/conventions/api-contract.md). Do NOT mirror either into this file — capture
DESIGN INTENT + decisions in prose under Architecture Notes instead.
-->

## Summary *(mandatory)*

[1-2 sentences. Extract from spec.md: primary requirement + 1-line technical
approach. Do NOT restate full FR list — spec.md already carries them.]

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

<!--
Per ADR-0040 multi-layer test gate (P5 follow-up). Cargo-cult anti-pattern:
AI agent (含人类) 倾向从泛 RN / NestJS 教程 copy-paste "防御性" polyfill /
import / config 而不验证当前栈是否真需要 (PR #79 retro Pattern F 实证:
review plan L185 要求 `react-native-get-random-values` polyfill, 事后
fact-check 发现 expo-crypto 当前版本不需要, 纯 cargo-cult bundle 膨胀)。

本表强制每个 plan 阶段填写: 引入的新依赖或防御性 import 必须有 fact-
check 锚点 (官方 docs / GitHub issue / 源码位置)。无锚点的 cargo-cult 会
在 spec-kit /implement 阶段被 reviewer 抓包。

填写规则:
- 真有新依赖 / polyfill / shamefully-hoist 等防御性配置 → 必须列 + 锚点 URL
- 无新引入 → 填一行 `None | N/A | N/A` 作为 explicit no-op 声明
- 锚点不能是 "我觉得需要" / "教程说要" — 必须可点击的 docs / source 位置
-->

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| (例) react-native-get-random-values | Polyfill globalThis.crypto.getRandomValues 给 uuid v9+ | [Link to upstream Expo docs OR specific commit verifying need on current SDK] |
| None | N/A | N/A |

## Constitution Check *(mandatory gate)*

<!--
Evaluate this plan against .specify/memory/constitution.md. Hard gate — the plan
cannot advance to tasks until this passes. If a principle is violated, either
revise the plan OR justify the violation in Complexity Tracking below. Check the
box explicitly; an empty box blocks the next phase.
-->

- [ ] **Passed** — plan honors all constitution principles, OR every violation is justified in the Complexity Tracking table below.

## Phase 0 Research Gates *(mandatory)*

<!--
4 gate checklists added in mono-orchestrator-ready 0.2.1 (post-A-002 retro).
Each gate is a hard YES/NO question + space for "evidence link / N/A reason".
Plan cannot advance to status: tasks-ready until all 4 gates resolved.
LLM filling /speckit-plan MUST check each box explicitly — empty `[ ]` blocks
the next phase.
-->

### Gate 0.1 — Integration Smoke Gate

- [ ] **Server**: real-boot smoke (PG + Redis up via Testcontainers or equiv) covers each new endpoint at least once. unit + module tests are NOT sufficient.
- [ ] **Mobile / Web**: golden-path flow walked in a real Expo simulator / Web browser session for each new user story (P1).
- [ ] **Evidence**: <link to smoke commit / screenshot / log paste; or "N/A — explain"></evidence>

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

Fill IF this plan introduces a new third-party package / SDK / tool. SKIP otherwise (mark N/A in evidence).

| # | Question | Answer |
|---|---|---|
| Q1 | Long-term maintenance signals? (commit cadence / contributors / sponsor) | [...] |
| Q2 | Could an already-installed tool cover this equivalently? | [...] |
| Q3 | Compatibility with current stack (NestJS / Prisma / Expo / pnpm / Nx)? | [...] |
| Q4 | LLM training-data coverage — does Claude know this package's API surface? | [...] |
| Q5 | Decoupling cost — how many weeks to replace if it goes stale? | [...] |
| Q6 | Risk surface — license / CN availability / supply-chain / known CVE? | [...] |

**Evidence**: <link to context7 grounding session / decision memo; or "N/A">

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

Fill IF this plan touches code / docs that were migrated from the prior meta-repo (Java/Spring → mono TS). Use `rg` from mono root to verify stale references are gone:

- [ ] No stale Java class names (e.g. `\bAccount\b` referring to `mbw-account/...` instead of `apps/server/src/account/...`)
- [ ] No stale Maven coords (`org.springframework.*` / `org.mapstruct.*` references in doc / spec)
- [ ] No stale ADR ids (meta-repo ADR-NNNN vs mono ADR-NNNN — verify against `docs/adr/README.md` index)
- [ ] No stale file paths (`mbw-*/src/main/java/...` Maven layout vs nx workspace `apps/server/src/...`)
- [ ] No stale API paths (Spring `@RequestMapping` defaults vs NestJS `@nestjs/swagger` decorators)
- [ ] **Evidence**: <`rg` output / grep result link; or "N/A — feature is mono-native">

### Gate 0.4 — ADR-deferred-mitigation Scan Step

Scan `docs/adr/*.md` for Open Questions that this feature would surface. Each impacted ADR must be:

1. listed below + state the deferred question
2. classified: `mitigated` / `accepted-as-is` / `escalated-to-new-ADR`

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| ADR-XXXX | [question excerpt] | mitigated / accepted / escalated | [action] |

If none → write "no impacted Open Questions" + the `rg` you ran to verify.

**Evidence**: <link to ADR amend commit / new ADR PR; or "N/A">

## Architecture Notes *(mandatory)*

<!--
Natural-language bullets. Injected into each implementing sub-agent's brief
(per plan-anchor extraction), so keep each bullet focused on a decision an LLM
coding agent needs to honor. This is also where the data model + API surface
DESIGN INTENT belongs (prose, not a mirror table) — entities, ownership,
append-only semantics, masking points, endpoint purpose, etc.
-->

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

<!--
Per ADR-0040 multi-layer test gate strategy. These three invariants are the
hard rules for any NestJS lifecycle test (Guard / Interceptor / Filter /
Pipe). 违背任一条 → P3 阶段 lefthook anti-mock 正则会拦 commit.
These bullets are injected verbatim into the implementing sub-agent prompt; do
not soften the language — the LLM defaults to mock everything if not
explicitly forbidden.
-->

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。这些组件依赖 NestJS DI lifecycle 顺序 (Guards→Interceptors→Pipes→Filters)，mock 隔离 = 抹掉 PR-79 类 cascade bug 的唯一信号。
- **MANDATORY INTEGRATION**: 必须用 `Test.createTestingModule({ imports: [<TheModule>] }).compile()` 装一个微型 DI 容器，让被测组件在真实 lifecycle 中触发。`createTestingModule` 之外的"测试" 视同未测试。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 列出的每条分支，**必须**在 integration test 文件中有对应 `it()` 块。100% 路径覆盖 — 不允许漏 cold-boot / 路由根 `/` 等非 happy-path 状态（PR #79 实证 4 层 cascade 始于一个未列状态分支）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
> The implementer LLM MUST strictly follow the "Flat + Anemic + Moat" paradigm:
> - **Flat Module**: ALL files live flatly in `apps/server/src/<module>/`. NEVER generate `domain/`, `application/`, `infrastructure/`, or `web/` subdirectories.
> - **Anemic Data & Zero-Class**: Data equals raw Prisma rows (snake_case handled by `@map` in schema.prisma). NEVER generate Domain Classes or Entity Mappers.
> - **No Repositories**: NEVER create Repository interfaces/adapters for your own tables. Inject `PrismaService` directly into UseCases. Put business invariants in pure functions (`*.rules.ts`).
> - **The Moat**: NEVER write `tx.<otherTable>.*`. Cross-context access MUST go through the target module's UseCase (use the Two-step Inspect+Commit saga only when caller validation must sit between read and write).

### 🚨 Impl Guardrails（并发 / 安全 / 前端 — 详版见 mono conventions）

<!--
Injected into the implementing sub-agent brief. 详版 + 实证锚见
docs/conventions/{server,mobile}-impl-playbook.md（单源）。保持 fierce —
LLM 默认走简单路径，机制不显式禁就踩。仅留本 feature 适用的条目。
-->

- **并发/事务**：单行状态转换用 conditional UPDATE **affected-count**（`updateMany where {id,<前置>}` → count===1 won / 0 lost，READ COMMITTED）；**NEVER** 单行 `FOR UPDATE` / Serializable（偏索引 SSI 假冲突）。并发 insert 确需 Serializable 时 catch **P2002 + P2034 双形态**。outbox 事件 `publish(tx,…)` 与状态写**同 tx**。scheduler 逐行独立 tx。外部 I/O **split-tx**（禁 tx 内持锁等 HTTP）。→ `../../docs/conventions/server-impl-playbook.md`
- **安全**：失败分支**字节级一致折叠** + dummy-hash constant-time pad（反枚举）；码/token 比较 **HMAC constant-time**，**NEVER bcrypt** 新代码；PII **AES-GCM** + 唯一 hash 防占位 + 终态才解密+掩码。
- **前端（mobile）**：表单 **RHF + zodResolver** 4 铁律（Controller≠register / 表单态≠副作用态 / isSubmitting 单源 / 错误+a11y）；port 走 **Strangler-Fig**（复用 `~/theme`+`~/ui`、Orval 函数式 hook 非 class、axios 不删）；mockup 走 Claude Design 2 段模板。→ `../../docs/conventions/mobile-impl-playbook.md`

(Write any feature-specific architecture notes here — data model design intent, API surface purpose, reuse decisions, schema state, masking points, etc.)

## Complexity Tracking

> Fill ONLY if Constitution Check reports violations that need justification.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| [e.g., cross-module import] | [current requirement] | [why a simpler design is insufficient] |
