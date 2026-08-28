# 顶层目录归属约定

> mono-repo 顶层目录的判据 SoT。新增任何「一个目录级别的东西」之前先读本文判一次。
> 机器强制：`scripts/checks/check-repo-layout.ts`（`pr-validation.yml` 的 `gate-checks` + lefthook pre-commit）。

## 判据表

| 顶层目录    | 判据（一句话说得清才算合格）                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/`     | **可部署物**，且归 pnpm workspace / Nx 管（有 `project.json`）                                                                        |
| `services/` | **可部署物**，但**自带独立工具链**（自己的 lockfile / Python venv / 纯配置），刻意不入 workspace                                      |
| `packages/` | **不可独立部署**的共享库，且 ≥ 2 个 consumer（单 consumer 按 [ADR-0030](../adr/0030-package-decomposition.md) 内联到使用方）          |
| `ops/`      | 运维产物。**仅 5 个子目录**，见下                                                                                                     |
| `scripts/`  | 只在**开发机 / CI** 跑的工具，**不进生产宿主机**                                                                                      |
| `docs/`     | 文档（plans / improvements / experience 三类的分工与命名见 [docs-organization.md](docs-organization.md)；ADR / conventions 各有体例） |
| `specs/`    | SDD feature 产物（见 [sdd.md](sdd.md)）                                                                                               |

### `ops/` 的 5 个子目录

| 子目录         | 放什么                                                            |
| -------------- | ----------------------------------------------------------------- |
| `ops/bin/`     | 人工 / CI 调用的运维可执行（回滚、备份、探测、一次性配置）        |
| `ops/host/`    | 宿主机级配置（反向代理 conf、certbot 钩子）                       |
| `ops/jobs/`    | 宿主机级**定时任务**：`<unit>.sh` + `<unit>.sql` + `systemd/`     |
| `ops/lib/`     | 跨任务复用的 shell 原语（飞书发送、run-reported wrapper、看门狗） |
| `ops/runbook/` | **纯文档**（`.md`）。可执行一律归 `ops/bin/`                      |

## 新东西该放哪：按顺序问

1. **它会被部署到某台机器上跑吗？**
   - 否 → 跳到第 4 步
   - 是 → 继续
2. **它归 pnpm workspace / Nx 管吗？**（要不要 `pnpm install` 认它、要不要进 `nx affected`）
   - 是 → `apps/<name>/`，必须有 `project.json`
   - 否（自带 lockfile / venv / 纯配置）→ `services/<name>/`，必须有 `deploy/`
3. **它是「定时跑」而不是「常驻」吗？**
   - 定时 + 跑在**生产宿主机** → `ops/jobs/`（见下「定时任务的三个家」）
   - 定时 + 跑在**开发机** → `scripts/jobs/<name>/`
   - 常驻 → 回第 2 步，它是个 service
4. **不部署的东西**：给人读的 → `docs/`；被别的代码 import 的 → `packages/`；开发/CI 工具 → `scripts/`；运维用的宿主机配置或可执行 → `ops/host/` 或 `ops/bin/`

## 定时任务的三个家（**刻意不统一**，别当成不一致去"修"）

| 跑在哪                  | 家                       | 为什么不并到一起                                  |
| ----------------------- | ------------------------ | ------------------------------------------------- |
| 生产宿主机（业务 host） | `ops/jobs/`              | —                                                 |
| 某个 service 自己的机器 | `services/<svc>/deploy/` | **就近**：它与该 service 同生共死，跟着它一起部署 |
| 开发机（macOS launchd） | `scripts/jobs/<name>/`   | 不进生产宿主机，判据同 `scripts/` 那条            |

三者的**逻辑**统一在注册表 [`ops/runbook/scheduled-tasks.md`](../../ops/runbook/scheduled-tasks.md)（机器强制：`check-scheduled-tasks.ts`），不需要文件系统也统一。

## `ops/jobs/` 的内部形态

一个任务 = **同名三件套**，不给每个任务开子目录：

```text
ops/jobs/<unit>.sh              任务本体
ops/jobs/<unit>.sql             判据谓词（若判断下沉到 SQL）—— 必须与 .sh 同目录同名
ops/jobs/systemd/<unit>.service + <unit>.timer
```

- **文件名 = systemd unit 名**，不是别的。这条让「unit ↔ 脚本」可机器校验。
- **`<unit>.sh` 与 `<unit>.sql` 必须是同目录同名兄弟** —— 脚本按 sibling 找谓词，仓内与装机后（`/usr/local/lib/nvy/jobs/`）形状一致。拆开放 = 运行期「谓词文件缺失」告警。
- 安装一律走 `ops/jobs/install.sh`（幂等），不在 unit 头注释里写各自的 `cp` 步骤。
- **跨任务原语例外**：本体在 `ops/lib/` 的共享件（如看门狗 `nvy-watchdog.sh`）只在 `ops/jobs/systemd/` 有 unit、没有同名 `.sh` 兄弟 —— 别当违规去搬。

## 机器强制的五条

`scripts/checks/check-repo-layout.ts`，全部 **fail-closed**（目标目录缺失 = 红，不是 skip）：

1. `ops/` 顶层子目录 ⊆ 上表 5 个
2. `ops/runbook/` 下无可执行（`.sh` / `.ts` / `.mjs` / `.cjs` / `.py`）
3. 每个 `apps/*` 有 `project.json`
4. 每个 `services/*` 有 `deploy/`，且**不被** `pnpm-workspace.yaml` 的 glob 命中
5. `ops/jobs/systemd/`：每个 `.timer` 有同名 `.service`；每个 `.service` 的 `ExecStart` 里指向 `/usr/local/lib/nvy/…` 的路径，映射回仓内必须存在

> 第 5 条防的是**静默失效**：unit 指着一个仓里已不存在的脚本，systemd 不会提前报错，要等下次 `OnCalendar` 触发才 `203/EXEC`；而多数探针是 `--on-success silent`，届时「装错了」与「探到真故障」在飞书上没法区分。它在仓内的孪生是 `ops/jobs/install.sh` 的装机自检（同一条不变量的运行期版本）。

## 为什么要有这份约定

判据不写下来，目录就会渐进沙化：每一步单看都合理，合起来没人说得清一个新东西该放哪。

**要治的是「判据说不清」，不是「顶层目录多」** —— 这两件事常被混为一谈。2026-08-07 起草本文时实取过一批同量级公开 monorepo（immich / cal.com / supabase / PostHog / grafana / n8n）的顶层目录做基线，本仓当时是其中最少的之一，而痛感依然存在，痛点在 `ops/` 内部；对照数据留在本地 plan `08-07-mono-layout-reorg`（本机私有，未公开）。

取舍原则照 Nx 官方口径：_group by scope, not type_ / _projects that change together should sit together_。
