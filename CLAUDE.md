# 「不虚此生」/ no-vain-years-mono

跨端内容工具型应用 mono-repo，由单人开发。栈：NestJS + Fastify + Prisma + Nx + Expo。

## 工作区结构

Nx mono-repo。`apps/server/`（NestJS + Fastify adapter + Prisma）；`apps/mobile/`（Expo，含 `auth/` / `core/` / `theme/` / `ui/` 内联子目录，per [ADR-0030](docs/adr/0030-package-decomposition.md) 「5 包减 2」）；`packages/`（仅 `api-client` + `types`，跨 mobile + server-types 真共享；其他单 consumer 候选已内联到 `apps/mobile/src/`）。

Doc 文件组织 per [docs/conventions/docs-organization.md](docs/conventions/docs-organization.md)；`docs/experience/` 与 `docs/private/`（plans + 拓扑相邻 runbook）为 local-only（gitignored 不入库；命名约定仍适用）。旧 meta-repo 的 experience 历史不迁入（2026-05-23 决定作废 Plan 3 迁入）。

**本仓面向公开** —— 主机只以代号出现，标识符运行时从仓外 `fleet.env` 解析，判据见 [docs/conventions/information-boundary.md](docs/conventions/information-boundary.md)（三层归属 + 5 问自检；机器强制 `scripts/checks/check-identifier-boundary.ts`）。

## 跨仓公共约定

### 始终装载（@import 自动展开）

#### 业务命名

@docs/conventions/business-naming.md

#### Git 工作流

@docs/conventions/git-workflow.md

#### Spec-Driven Development

@docs/conventions/sdd.md

### 按需 read — 触发对应操作前先读

| 操作                                                                                                                         | 必读文档                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 后端选型 / PoC 范围 / 验收门槛 / W1-W5 时间盒                                                                                | [Plan 1](docs/private/plans/2026-05/05-18-plan1-backend-stack-poc.md)（本机私有，未公开；旧 meta 仓的 `docs/plans/` 是历史源，git 史含 PR #137/#138/#139 amend 链）                                           |
| 后端栈 root 决策（语言 / 框架 / 主 ORM / 模块边界策略）                                                                      | `docs/adr/0018-backend-language-pivot.md`（Plan 1 W4-W5 ship）                                                                                                                                                |
| ORM 选型理由                                                                                                                 | `docs/adr/0019-orm-prisma.md`（同上）                                                                                                                                                                         |
| NestJS module 边界 + 模块内构范式（扁平 / 贫血 / 护城河 / 零-class）                                                         | `docs/adr/0032-backend-bounded-context.md`（bounded context 拆分 + hexagonal 退役）+ `docs/adr/0043-server-flat-module-paradigm.md`（扁平内构正向范式）。ADR-0020 已 Superseded                               |
| Plan 2 业务迁移 / Plan 3 部署上线 / Phase 0 prep / per-feature SDD gate                                                      | [account-migration master](docs/private/plans/2026-05/05-25-account-migration-master.md)（统领子 plan：p1 工具链 / p2 依赖+顺序 / p3 逐 uc 步骤；部署 Plan 3 已先行完成）                                     |
| **新 server use case / 跨 context 决策 / bounded context 评估**                                                              | `docs/conventions/server-bounded-context-catalog.md`（3 传播规则 + 7 决策问题；已实装 operation 清单靠代码派生 per ADR-0034 sunset；`.claude/rules/server-bounded-context-decision.md` 路径触发自动加载摘要） |
| **新增/改动任何测试文件 · 给测试起名 · 判断该不该起容器/打真 vendor**                                                        | `docs/conventions/testing.md`（size × scope 二维分类学 + 三个后缀 `*.spec.ts` / `*.it.spec.ts` / `*.vendor.spec.ts` + 新写测试 5 步决策流程；机器强制在 `scripts/checks/check-test-size.ts`）                 |
| **本地跑 test / e2e / smoke / export-openapi / `nx affected` 全量门**                                                        | `docs/conventions/local-verification.md`（命令矩阵 + **「红得像代码坏了、其实是环境/工具链」的失败**分类 + 每条声明的**证据等级**纪律；「跑了必红 / 必骗人」那几档由 `PreToolUse` hook 在命令执行时刻硬拦）   |
| **新增/改动测试场景 · 判断某类测试该跑在哪个环境 · 改 CI job 分层 · 排查测试基建**                                           | `docs/conventions/test-environment-matrix.md`（测试场景 × 数据源/env 来源/隔离级别/可并行/CI job 的权威矩阵 + env 三条铁律 + 常驻陷阱；`local-verification.md` 是它的「怎么跑」入口）                         |
| **执行 `gh pr create` / `gh pr edit` body 改写**                                                                             | `docs/conventions/pr-creation-protocol.md`（仓库模板 `.github/pull_request_template.md` 是 body 唯一权威 source；CI 严格 regex 扫部署 gate 3 checkbox，缺失 / 未勾全红）                                      |
| 改 `.claude/` 目录任何内容 / 新建 commands / skills / rules / settings 调整                                                  | `docs/conventions/claude-config-layout.md`（`.claude/rules/claude-config-layout-sync.md` 路径触发自动加载硬 invariant 摘要）                                                                                  |
| **新建 / 改动 `docs/conventions/` 任何 convention**                                                                          | `docs/conventions/docs-organization.md`（evergreen-only 判据「一年后仍成立」+ 三类记录怎么选；`.claude/rules/convention-authoring.md` 路径触发摘要 + `pretooluse-convention-rubric.sh` 写入时刻注入自检）     |
| **新增主机 / 服务 / runbook / env var 时判「这信息能不能进仓」· 写任何含 IP / 云账号 / 实例 ID 的内容 · 改标识符守门**       | `docs/conventions/information-boundary.md`（三层归属决策表 + 代号纪律 + 5 问自检 + 验证纪律；机器强制 `scripts/checks/check-identifier-boundary.ts`，`.claude/rules/information-boundary.md` 路径触发摘要）   |
| **新增任何「一个目录级别的东西」· 判断它该放 `apps/` / `services/` / `packages/` / `ops/` / `scripts/` 哪个 · 新增定时任务** | `docs/conventions/repo-layout.md`（顶层归属判据 + 4 步决策 + `ops/` 5 子目录 + 定时任务「三个家」为何刻意不统一；机器强制在 `scripts/checks/check-repo-layout.ts`，5 条全 fail-closed）                       |
| 改 GitHub repo 设置 / ruleset / CI workflow 改名 / 加 required check / 引第二人收紧                                          | `docs/conventions/github-ruleset.md`                                                                                                                                                                          |
| 新增 / 改动 server endpoint (controller / DTO / OpenAPI 装饰器) / packages/api-client 重新 gen                               | `docs/conventions/api-contract.md`                                                                                                                                                                            |
| **写任何涉及「今天」/ 交易日 / 剩余期限 / 折年化 / 陈旧判据 / vendor 时间戳解析的代码**                                      | `docs/conventions/cross-timezone-date-semantics.md`（三层归属 + 「今天」跟谁走的决策表 + 5 问自检；这类偏差**不报错**，只让数字悄悄差一天）                                                                   |
| 改 `apps/mobile/src/**` / 加 frontend dependency / 处理客户端凭证存储                                                        | `docs/conventions/fe-directory-structure.md`                                                                                                                                                                  |
| 改 prod 部署流程 / `deploy.yml` / `docker-compose.tight.yml` env 映射 / 回滚                                                 | `ops/runbook/prod-deploy-rollback.md`（部署 + B2 config 闸 + 自动/手动回滚 SOT；改 deploy 前先读，防漏 compose 映射 / 无回滚踩坑）                                                                            |

<!-- nx configuration start-->
<!-- intentionally empty — nx CLI / skill hints belong in docs/conventions/nx-usage.md (TBD), not in always-load CLAUDE.md. Please do not refill. -->
<!-- nx configuration end-->

<!-- SPECKIT START -->

For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:
[specs/049-optionsdesk-leg-table-gesture-scroll/plan.md](specs/049-optionsdesk-leg-table-gesture-scroll/plan.md)

<!-- SPECKIT END -->
