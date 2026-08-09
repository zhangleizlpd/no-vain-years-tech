---
description: Verify tasks.md [X] state synced with implementation after /speckit.implement
allowed-tools: Bash
---

You have been triggered by the spec-kit `after_implement` hook.

## Steps

1. Locate the feature's `tasks.md` (the active feature dir's `tasks.md`, derived
   from the spec-kit branch convention or hook context).
2. Parse `tasks.md`: count total tasks, pending `- [ ]`, completed `- [X]`.
3. Run `git log --since="2 hours ago" --pretty=format:"%H %s" --name-only` to
   list recent commits.
4. For each commit that touched implementation files (e.g. `*.java` / `*.tsx` /
   `*.ts` / `*.kt` / `*.py`), check whether `tasks.md` was staged together.
5. Cross-reference: any task that switched to `[X]` since the last verify run
   MUST appear in a commit that also staged `tasks.md`. Conversely, any commit
   touching implementation files but not `tasks.md` is suspect if a `[X]` flip
   exists for a matching task.
6. Report a status table:

   | Task ID | State | In commit | tasks.md staged? |
   |---|---|---|---|
   | T001 | [X] | abc1234 | ✅ |
   | T002 | [X] | def5678 | ❌ DRIFT |
   | T003 | [ ] | (pending) | — |

7. If any DRIFT is detected, output a remediation message (suggest squashing
   the `tasks.md` flip into the impl commit via `git commit --amend`, or
   opening a follow-up commit that only edits `tasks.md`).

## Failure handling

- If the project's git history shows no recent impl activity, report
  "no recent /speckit.implement run detected" and exit 0.
- If `tasks.md` doesn't exist in the feature dir, abort gracefully (likely not
  a feature dir).

## Notes

- This command is a **soft prompt-time reminder**. The hard commit-time gate
  lives in lefthook (`tasks-md-drift` hook on `pre-commit`) — they coexist on
  purpose, covering different points in the lifecycle.
- Ships as part of `task-closure` preset from michael-speckit-presets.
