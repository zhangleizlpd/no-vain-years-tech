# 「不负光阴」/ no-vain-years-mono

跨端内容工具型应用，单人开发的 Nx mono-repo：`apps/server/`（NestJS + Fastify + Prisma；模块内扁平）、`apps/mobile/`（Expo；`auth/` / `core/` / `theme/` / `ui/` 是 [ADR-0030](docs/adr/0030-package-decomposition.md) 内联子目录）、`packages/`（仅 `api-client` + `types`，真跨端共享）。`docs/experience/` 与 `docs/private/`（plans / 拓扑相邻 runbook / 取证 evidence）为 local-only（gitignored；命名约定仍适用）。

**本仓面向公开** —— 主机只以代号出现，标识符运行时从仓外 `fleet.env` 解析（判据 [information-boundary.md](docs/conventions/information-boundary.md)）。

## 跨仓公共约定

### 始终装载（@import 自动展开）

#### 业务命名

@docs/conventions/business-naming.md

#### Git 工作流

@docs/conventions/git-workflow.md

#### Spec-Driven Development

@docs/conventions/sdd.md

### 按需 read — 触发对应操作前先读

摘要只帮你判「要不要读」，触发列才是命中依据；配对的 `.claude/rules/*.md` 在改对应文件时自动注入。

| 操作                                                                                                                         | 必读文档                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **新 server use case / 跨 context 决策 / bounded context 评估**                                                              | `docs/conventions/server-bounded-context-catalog.md`（3 传播规则 + 7 决策问题）                                                                                                                                   |
| **新增/改动任何测试文件 · 给测试起名 · 判断该不该起容器/打真 vendor**                                                        | `docs/conventions/testing.md`（是哪类 / 叫什么：size × scope + 三后缀；`check-test-size.ts` 强制）                                                                                                                |
| **本地跑 test / e2e / smoke / export-openapi / `nx affected` 全量门**                                                        | `docs/conventions/local-verification.md`（怎么跑 / 哪些红是假的；「必骗人」档由 `PreToolUse` hook 硬拦）                                                                                                          |
| **新增/改动测试场景 · 判断某类测试该跑在哪个环境 · 改 CI job 分层 · 排查测试基建**                                           | `docs/conventions/test-environment-matrix.md`（跑在哪 / env 从哪来的权威矩阵）                                                                                                                                    |
| **执行 `gh-bot pr create` / `pr edit` body 改写**                                                                            | `docs/conventions/pr-creation-protocol.md`（模板是 body 唯一权威；CI regex 扫 3 checkbox）                                                                                                                        |
| 改 `.claude/` 目录任何内容 / 新建 commands / skills / rules / settings 调整                                                  | `docs/conventions/claude-config-layout.md`                                                                                                                                                                        |
| **新建 / 改动 `docs/conventions/` 任何 convention**                                                                          | `docs/conventions/docs-organization.md`（evergreen-only 判据 + 三类记录怎么选）                                                                                                                                   |
| **新增主机 / 服务 / runbook / env var 时判「这信息能不能进仓」· 写任何含 IP / 云账号 / 实例 ID 的内容 · 改标识符守门**       | `docs/conventions/information-boundary.md`（三层归属 + 代号纪律；`check-identifier-boundary.ts` 强制）                                                                                                            |
| **新增任何「一个目录级别的东西」· 判断它该放 `apps/` / `services/` / `packages/` / `ops/` / `scripts/` 哪个 · 新增定时任务** | `docs/conventions/repo-layout.md`（顶层归属判据 + 定时任务「三个家」；`check-repo-layout.ts` 强制）                                                                                                               |
| 改 GitHub repo 设置 / ruleset / CI workflow 改名 / 加 required check / 引第二人收紧                                          | `docs/conventions/github-ruleset.md`                                                                                                                                                                              |
| 新增 / 改动 server endpoint (controller / DTO / OpenAPI 装饰器) / packages/api-client 重新 gen                               | `docs/conventions/api-contract.md`                                                                                                                                                                                |
| **注释里写「vendor / 交易所 / 第三方平台会怎样」这类外部世界断言**                                                           | `docs/conventions/comment-provenance.md`（写不写 / 怎么写 + `EVIDENCE:` `ASSUMED:` 两个 codetag；写入时刻由 `pretooluse-comment-provenance.sh` 注入自检）                                                         |
| **写任何涉及「今天」/ 交易日 / 剩余期限 / 折年化 / 陈旧判据 / vendor 时间戳解析的代码**                                      | `docs/conventions/cross-timezone-date-semantics.md`（四条时间轴 + 该调哪个函数速查；[ADR-0066](docs/adr/0066-time-semantics-ubiquitous-language.md)；`check-time-semantics.ts` 强制。偏差不报错，只让数字差一天） |
| 改 `apps/mobile/src/**` / 加 frontend dependency / 处理客户端凭证存储                                                        | `docs/conventions/fe-directory-structure.md`                                                                                                                                                                      |
| 改 prod 部署流程 / `deploy.yml` / `docker-compose.tight.yml` env 映射 / 回滚                                                 | `ops/runbook/prod-deploy-rollback.md`（部署 + B2 config 闸 + 回滚 SoT）                                                                                                                                           |

<!-- nx configuration start-->
<!-- intentionally empty — nx CLI hints do not belong in always-load. Please do not refill. -->
<!-- nx configuration end-->

<!-- SPECKIT START -->

在 `NNN-<feature>` 分支上工作时，先读该 feature 的 `specs/<branch>/plan.md`（技术选型 / 结构 / 命令）。

<!-- SPECKIT END -->
