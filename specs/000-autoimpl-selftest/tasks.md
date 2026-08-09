---
feature_id: 000-autoimpl-selftest
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-13'
---

# Tasks: 000-autoimpl-selftest（🧪 自测 fixture — dry-run only）

> 🧪 THROWAWAY。每 task 只写 `sandbox/`。dry-run 闭环：写文件 → `node -e` 断言 → **不真 commit**，结果契约报 `commit_sha:"DRY-RUN"`。

## Tasks

- [ ] T001 [Selftest] 实现 `echo(s)` 纯函数 → `specs/000-autoimpl-selftest/sandbox/echo.ts`，断言 `echo('nvy')==='nvy'`（FR-001 / SC-001）
- [ ] T002 [Selftest] 实现 `greet(name)` → `specs/000-autoimpl-selftest/sandbox/greeting.ts`，**必须 import 复用 T001 产出的 `sandbox/echo.ts` 的 `echo`**（不许重新内联实现），断言 `greet('x')==='hi x'`（FR-002 / SC-002）
- [ ] T003 [Selftest] 实现 `formatAmount(n)` → `specs/000-autoimpl-selftest/sandbox/format.ts`（FR-003 / SC-003）
