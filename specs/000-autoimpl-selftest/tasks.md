---
feature_id: 000-autoimpl-selftest
spec_ref: ./spec.md
plan_ref: ./plan.md
status: archived
created_at: '2026-06-13'
---

# Tasks: 000-autoimpl-selftest（🧪 自测 fixture — dry-run only）

> 🧪 THROWAWAY。每 task 只写 `sandbox/`。dry-run 闭环：写文件 → `node -e` 断言 → **不真 commit**，结果契约报 `commit_sha:"DRY-RUN"`。
>
> 🚫 **下面那 3 条 `- [ ]` 是夹具载荷，MUST NOT 勾、MUST NOT 实现。** 它们是 `/sdd-auto-impl --dry-run` 每次自测的输入：跑在临时 worktree 里（`.claude/commands/sdd-auto-impl.md:221`），产物落 gitignored 的 `sandbox/`，随 worktree 一并丢弃（`:222`）。把它们勾成 `[X]` 并合进 main ⇒ **下次 dry-run 没有 pending task 可驱动，夹具即被消耗掉**；T003 更是**故意 under-specified**（`spec.md` FR-003 / SC-003），它存在的意义就是让子 agent 在那里 blocked —— 实现它等于删掉 stop-signal 那条验收。
>
> 📌 **2026-09-13：frontmatter `status` 由 `ready` 对齐为 `archived`**，与 [`spec.md`](./spec.md) 一致。此前两份文件对同一 feature 的 lifecycle 说法不一致（spec 说 archived、tasks 说 ready），叠加 3 条未勾选行 ⇒ 本 fixture 被反复扫成「待办」。判据不变、`- [ ]` 原样保留 —— 改的只是 lifecycle 标注。

## Tasks

- [ ] T001 [Selftest] 实现 `echo(s)` 纯函数 → `specs/000-autoimpl-selftest/sandbox/echo.ts`，断言 `echo('nvy')==='nvy'`（FR-001 / SC-001）
- [ ] T002 [Selftest] 实现 `greet(name)` → `specs/000-autoimpl-selftest/sandbox/greeting.ts`，**必须 import 复用 T001 产出的 `sandbox/echo.ts` 的 `echo`**（不许重新内联实现），断言 `greet('x')==='hi x'`（FR-002 / SC-002）
- [ ] T003 [Selftest] 实现 `formatAmount(n)` → `specs/000-autoimpl-selftest/sandbox/format.ts`（FR-003 / SC-003）
