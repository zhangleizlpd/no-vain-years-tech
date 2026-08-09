---
feature_id: [###-feature-name]
spec_ref: ./spec.md
plan_ref: ./plan.md
status: not-started
created_at: [YYYY-MM-DD]
updated_at: [YYYY-MM-DD]
---

# Tasks: [FEATURE NAME]

<!--
Frontmatter fields:
- feature_id / spec_ref / plan_ref must match plan.md and spec.md
- status: not-started → in-progress → completed (or blocked)

Phase headings (## Server / ## API Client / ## Mobile / ## E2E) are
human-reading grouping only.

A task is a 30min–2h single-commit unit of work (per docs/conventions/sdd.md
反模式: 别每个 method 一个 task). Trace requirements in the task title prose
(e.g. "(FR-001, US1)") — no per-task machine marker.

Status semantics (per implement-task-closure rule):
- `- [ ]` = pending
- `- [X]` = completed (flipped by /speckit-implement after the task ships)
-->

## Server

- [ ] T001 [task title] (FR-001, US1)

- [ ] T002 [task title — unit test, ships RED first then GREEN] (FR-001, US1)

- [ ] T003 Verify Backend Physics — Server Runtime Smoke Verification (FR-001, US1)
  <!--
  T003 is the gating runtime smoke per ADR-0040 multi-layer test gate. It
  invokes scripts/ci/server-boot-smoke.ts which spins up Testcontainers PG +
  Redis, boots the real Nest server, fires a real HTTP probe, and asserts
  RFC 9457 ProblemDetail shape + traceId end-to-end. NO mocks. T003 RED
  means the cascade (CLS / ValidationPipe / AuthGate / Filter) shipped
  broken — roll back impl. Do not skip; do not split.
  -->

<!-- 📋 Impl Guardrails (per plan § 🚨 Impl Guardrails): spec.md state_branches 的每条
     **并发/竞态** 与 **反枚举** 分支 → 各配一个独立 integration test task
     (exhaustive，per EXHAUSTIVE BRANCHING + docs/conventions/server-impl-playbook.md)。 -->

## API Client

- [ ] T0XX [task title — typically OpenAPI export + codegen] (FR-001, US1)

## Mobile

- [ ] T0XX [task title] (FR-001, US1)

<!-- 📋 表单屏 → 配 RHF 逻辑测 task (vitest helper-level：错误映射 /
     提交态 / 校验)；UI·render·a11y 走 E2E (per docs/conventions/mobile-impl-playbook.md
     + 测试分层 vitest=logic·Playwright=UI)。 -->

## E2E (optional)

- [ ] T0XX [task title] (FR-001, SC-001, US1)
