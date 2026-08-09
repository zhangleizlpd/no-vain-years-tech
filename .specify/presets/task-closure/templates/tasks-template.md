[TASK CLOSURE CONVENTION — prepended by michael-speckit-presets/task-closure preset]

Every task heading uses spec-kit native checkbox state:

- `- [ ]` = pending
- `- [X]` = completed (flipped by /speckit.implement after the task ships)

**Per-task closure protocol** (executed inside /speckit.implement):

1. Complete TDD cycle (red → green); pass lint + typecheck.
2. In tasks.md, flip the task heading's `[ ]` to `[X]`.
3. `git add` implementation + tests + **tasks.md in the same stage**.
4. Proceed to commit.

**Hard rule**: tasks.md MUST be staged in the same commit as implementation
code. The /speckit-tasks-verify hook (after_implement) reports any divergence.

[END TASK CLOSURE CONVENTION]
