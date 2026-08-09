# Spec-Driven Development（SDD）工作流

mono-repo 单仓共享。M1.1 起业务模块按此流程开发。基于 [GitHub Spec-Kit](https://github.com/github/spec-kit)（2025-2026 事实标准）。

## 标准流程（每个 feature 走一遍）

6 步必跑 + `constitution` 项目级一次性。**spec.md 单一来源** 在 `specs/NNN-<feature-slug>/spec.md`（mono root 相对，扁平 feature-first 布局，per [ADR-0024](../adr/0024-spec-feature-first-layout.md)）；plan / tasks / analysis 与 spec 同目录。

命令链：`/speckit-constitution`（项目级一次性）→ `specify` → `clarify`（写 spec.md 内 `## Clarifications` 段）→ `plan` → `tasks` → `analyze` → `implement`（代码 + 测试 + tasks.md `[X]` flip，TDD 红绿）。cwd 一律 mono root；各命令产出位置见对应 `/speckit-*` skill。tasks 每条标 `[Server]` / `[Mobile]` / `[Contract]` 层级，测试任务不独立、绑定到每个实现 task。

**Review gate**：clarify → plan、plan → tasks、analyze → implement 之间均为人工审批卡点，不是装饰。

### spec.md frontmatter（强制，per [ADR-0024](../adr/0024-spec-feature-first-layout.md)）

每个 `spec.md` 顶部 YAML frontmatter 含 ADR-0024 治理三字段 `modules` / `owners` / `status`（**模块倒查 / ownership / lifecycle** 单一来源）；其余 `feature_id` / `state_branches` / `web_compat` / `perf_budgets` 等由 spec-kit preset 模板注入（schema `.specify/schemas/mono-orchestrator-ready/spec.zod.ts`）：

```yaml
---
modules:
  [auth] # 影响的代码模块,值域 = business-naming.md 列出的业务模块名
  # 单模块: [auth]   多模块: [pkm, account, notification]
  # 完全跨模块平台改造: [cross-cutting]
owners: ['@zhangleizlpd'] # GitHub handle,与 CODEOWNERS 兼容
status: implemented # draft | clarified | planned | tasks-ready | implementing | implemented | superseded | archived
---
```

**模块倒查**：`rg -l '^modules:.*\bauth\b' specs/`（不依赖目录结构，靠 frontmatter）。

## 前端 UI 工作流（mockup-first）+ design/ 留迹

→ `.claude/rules/sdd-authoring.md`（触及 `specs/**` 时 path-trigger 自动加载；mockup-first 单一流程、库/paradigm 选型时机、跨端 feature 单 PR + 正交两层验证、design/ 留迹路径、历史 UI 类别 retire 注记的 canonical 均移驻该 rule —— 只在写 spec/plan/tasks/design 时相关，不占 always-load）。

## `spec.md` 内部结构

走 spec-kit 官方 3 段模板（`.specify/templates/spec-template.md`）：User Scenarios & Testing / Functional Requirements / Success Criteria。**不自创子层**（如"业务规则 / API / 测试"等）。

## 与已有约定的协同

| 约定 | 协同点                                                           |
| ---- | ---------------------------------------------------------------- |
| ADR  | use case 内部决策留 `plan.md`；跨模块 / 不可逆决策才抽出独立 ADR |

## /implement 每 task 闭环 6 步（强制）

→ `.claude/rules/implement-task-closure.md`（改 `specs/*/tasks.md` 或 impl 文件 ts/tsx 时 path-trigger 自动加载）。

## server impl 后的 mobile types 同步

→ `.claude/rules/api-contract-trigger.md` § Nx target 依赖链（改 server controller / DTO / openapi.json / packages/api-client/src/ 时 path-trigger 自动加载）。

## 反模式

→ `.claude/rules/sdd-authoring.md` § 反模式（触及 `specs/**` 时 path-trigger 自动加载；6 条 canonical——跳过 TDD / tasks 过细 / spec drift / 自审靠通读 / md 裸下划线标识符 / plan 阶段多造镜像文档——均移驻该 rule）。
