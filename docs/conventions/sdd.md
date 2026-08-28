# Spec-Driven Development（SDD）工作流

业务模块按此流程开发，基于 [GitHub Spec-Kit](https://github.com/github/spec-kit)。

## 标准流程（每个 feature 走一遍）

`/speckit-constitution`（项目级一次性）→ `specify` → `clarify`（写 spec.md 内 `## Clarifications` 段）→ `plan` → `tasks` → `analyze` → `implement`（代码 + 测试 + tasks.md `[X]` flip，TDD 红绿）。cwd 一律 mono root；产出全在 `specs/NNN-<feature-slug>/`（**spec.md 单一来源**，plan / tasks / analysis 同目录；扁平 feature-first，per [ADR-0024](../adr/0024-spec-feature-first-layout.md)），各命令产出位置见对应 `/speckit-*` skill。tasks 每条标层级 tag（`[Server]` / `[Mobile]` / `[Contract]` 及 `-IT` / `-E2E` / `-Smoke` / `-Vendor` 变体、`[Ops]` / `[Docs]`；词汇表以既有 `specs/*/tasks.md` 为准），测试任务不独立、绑定到每个实现 task。

**Review gate**：clarify → plan、plan → tasks、analyze → implement 之间均为人工审批卡点，不是装饰。

### spec.md frontmatter（强制，per ADR-0024）

顶部 YAML 含治理三字段（**模块倒查 / ownership / lifecycle** 单一来源）：`modules: [<business-naming 模块名>, …]`（单行；完全跨模块平台改造用 `[cross-cutting]`）、`owners: ['@<GitHub handle>']`、`status: draft | clarified | planned | tasks-ready | implementing | implemented | superseded | archived`。其余字段由 spec-kit preset 模板注入；schema `.specify/schemas/mono-orchestrator-ready/spec.zod.ts`，lefthook `spec-frontmatter-check`（preset 装，`scripts/check-spec-frontmatters.ts`）commit 时校验，写错当场红。模块倒查：`rg -l '^modules:.*\bauth\b' specs/`。

## `spec.md` 内部结构

走官方模板（`.specify/templates/spec-template.md`）的三个 mandatory H2：User Scenarios & Testing / Requirements（Functional Requirements 是其 H3）/ Success Criteria。**不自创子层**（如"业务规则 / API / 测试"等）。

## 与 ADR 的分工

use case 内部决策留 `plan.md`；跨模块 / 不可逆决策才抽出独立 ADR。

## 前端 UI 工作流（mockup-first）+ design/ 留迹

→ `.claude/rules/sdd-authoring.md`（触及 `specs/**` 自动注入）。

## /implement 每 task 闭环 6 步（强制）

→ `.claude/rules/implement-task-closure.md`（改 `specs/*/tasks.md` 或 impl 文件自动注入）。

## server impl 后的 mobile types 同步

→ `.claude/rules/api-contract-trigger.md`（改 controller / DTO / openapi.json / api-client 自动注入）。

## 反模式

→ `.claude/rules/sdd-authoring.md` § 反模式（6 条 canonical，触及 `specs/**` 自动注入）。
