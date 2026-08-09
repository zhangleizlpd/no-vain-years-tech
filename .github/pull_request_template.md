## 修改内容

<!-- 简述本 PR 的核心改动（≤ 3 bullet） -->

-
-

### 🚨 部署与存活前置确认 (Deployment & Smoke Gates)

<!--
Per ADR-0040 multi-layer test gate. 本段 3 checkbox 由 .github/workflows/
pr-validation.yml 的 actions/github-script step 严格扫描;任一未勾 → CI 红 + 阻 merge。
-->

- [ ] **物理验证通过**：我确认本地已运行 `pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main` 并拿到 exit code 0。
- [ ] **禁止过度 Mock**：如修改了 Guard / Interceptor / Filter / Pipe / Repository,我确认相关 spec 已使用 `Test.createTestingModule` 装 DI 容器,而非 `new Class()` 隔离实例化。
- [ ] **状态机闭环**：本特性的 `state_branches`(spec.md frontmatter)均已在 integration test 中 100% `it()` 覆盖。

### 📋 Spec frontmatter sync (soft checklist — per ADR-0024 + ADR-0035)

<!--
Soft checklist. CI 不强制扫(无 hard-gate)，但 spec drift 反复发生则收紧。
适用场景: 改动触及 spec scope (业务 use case / 模块边界 / perf budget / 错误码) 时勾选。
docs-only / chore-only / 不触 spec 的改动 → 全段跳过即可,不必勾。
-->

- [ ] **`updated_at` 已 bump**: 改 spec.md 内容时 frontmatter `updated_at` 同步到 commit 当日 (YYYY-MM-DD)
- [ ] **`status` 已转**: spec ship 阶段切换 (e.g. `tasks-ready` → `implementing`,impl 全完 → `implemented`)
- [ ] **`modules` / `owners` 符合现状**: 物理代码模块边界变化时,frontmatter 字段同步
- [ ] **`perf_budgets` SSOT**: 改了延迟相关代码时,spec frontmatter `perf_budgets` 是单一来源 (per ADR-0039);plan.md `## Performance Budget` 段已 `pnpm tsx scripts/checks/plan-compiler.ts <spec-dir>` regen
- [ ] **`migration_refs` 已挂**: spec 涉及 schema 改动时, frontmatter `migration_refs: [<timestamp_name>]` 反查关联 (per ADR-0035 § 4 optional 字段)

## Test plan

<!-- bullets describing how reviewers can verify this PR locally -->

-

## 关联 Issue / PR

- Fixes #
