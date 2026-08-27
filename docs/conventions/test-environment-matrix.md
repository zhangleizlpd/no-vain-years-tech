# 测试场景 × 环境矩阵

> **本文是「哪类测试跑在哪个环境、吃什么 env、隔离到什么级别」的单一来源。**
> 怎么跑（命令与前置）见 [`local-verification.md`](local-verification.md)——那是本文的「操作入口」，本文是它的「为什么」。
> **一个测试属于哪一类、该叫什么名字**见 [`testing.md`](testing.md)（size × scope 分类学 + 三个后缀 + 新写测试的决策流程）——本文的场景编号是那套分类学的**实例清单**，不重复定义判据。
>
> 🚨 **本文只放结构事实**（哪类跑在哪、吃什么 env、隔离到什么级别、常驻陷阱）。**任何时点事实**（文件计数、wall/CPU、某次改了几个文件、某条修复的经过）**一律不进本文**，归 [`docs/improvements/`](../improvements/)。判断标准：**这句话一年后还成立吗？**

## 0. 环境模型

| #   | 环境              | 位置                                                                                      | 用途                                                    |
| --- | ----------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | 本地开发          | 本机                                                                                      | 日常开发 + PR 前自测                                    |
| 2   | 本地测试          | 本机起 server（[`local-dev.md`](../../ops/runbook/local-dev.md) + `run-local-env` skill） | 手动功能验证 / 联调                                     |
| 3   | PR CI             | GitHub Actions `pr-validation.yml` + `ci.yml` 的 lint / scan / pytest 类 job              | merge 前的门                                            |
| 4   | main CI / release | `ci.yml`（push main）+ `release-please.yml` + nightly 三条                                | merge 后 + 发版链                                       |
| 5   | **生产**          | 代号 **`app`**（角色 / 变量契约见 `ops/host/fleet.env.example`）                          | 唯一生产；仓里**不存在**独立 staging 环境               |
| 6   | _（未来）_ 预发   | 不单独留机器；两台生产 LB 摘挂                                                            | **未实施**，见 plan §四的两条硬约束（本机私有，未公开） |

> alias 与代号的消歧（含「名字带 staging 却是生产」的陷阱）见 [information-boundary.md § 代号纪律](information-boundary.md)。

## 1. 主矩阵

隔离级别图例：**进程内** = 无外部依赖 / **每文件容器** = 各起各的 / **共享+克隆** = 共享实例 + per-file 逻辑隔离 / **混合** = 两者并存 / **独占端口** = 全局单例、不可并发。

> **场景 2 为什么是「混合」**：`test/integration/` 绝大多数已用共享 PG，例外是**把自己容器的 ID 交给外部脚本**的那一类（`marketdata.calendar-044.probe-independence`：`docker exec -i "$PG_CONTAINER" psql`，被测通路全程不经 node，这正是它要证明的「app 挂了探针照样告警」）。共享容器下该通路不成立，故**永久保持自起容器**。
>
> **存储入口怎么选** → [`testing.md`](testing.md) §4 步 3（真相 = `test/_support/isolated-db.ts` 头部那张表）。**Redis 蓄意保持每文件独立**（共享它省不下多少，却换来整类隐蔽的跨文件串台，理由见 `isolated-db.ts` 的 🚨 段）。
>
> 两个 project 的划线按后缀（`.it.spec.ts`，[`testing.md`](testing.md) §2）：`unit` = **零容器**硬不变量（`check-test-size.ts` 钉死）；`src/` 下的 `.it.` 蓄意不搬进 `test/`（§3.1），代价 = `tsconfig.spec.json` `rootDir: .`。

| #   | 场景                                            | Nx target                               | 数据源                                      | env 来源                                    | 隔离级别                | 可并行         | 跑在哪                                    |
| --- | ----------------------------------------------- | --------------------------------------- | ------------------------------------------- | ------------------------------------------- | ----------------------- | -------------- | ----------------------------------------- |
| 1   | server 单测                                     | `server:test` 的 `unit` project         | **零外部依赖**（不需要 Docker，硬不变量）   | `vitest.config.ts` `test.env`               | 进程内                  | ✅             | ①③④                                       |
| 2   | server IT（`*.it.spec.ts`）                     | `server:test` 的 `it` project           | 共享 PG（template 克隆）+ 每文件 Redis      | 同上 + 各文件 `beforeAll` 内写死            | **混合**                | ✅             | ①③④                                       |
| 3   | server perf IT                                  | 同上，`RUN_PERF_IT` 门控                | 容器 + 真 bcrypt 计时                       | `nightly-perf.yml` 注入 `EXPECTED_P95_MS_*` | 混合（同 #2）           | ⚠️ 计时敏感    | ④ nightly-perf                            |
| 4   | server 真 vendor（`*.vendor.spec.ts` + 内嵌块） | 同上，`RUN_<VENDOR>_IT` 门控            | **真凭证 + 外网**                           | 手工 env（在用名录 = `check-env-sync.ts`）  | 进程内 + 外网（无容器） | ✅             | **无任何 workflow 设置** ⇒ 恒 skip（T-4） |
| 5   | server runtime-smoke                            | `server:runtime-smoke`（`cache:false`） | 容器 + 真 `NestFactory` + 真 `fetch`        | 脚本内部钉死                                | 每次容器                | —              | ①③④                                       |
| 6   | mobile 单测（logic-only）                       | `mobile:test`                           | 无                                          | 无                                          | 进程内                  | ✅             | ①③④                                       |
| 7   | mobile hermetic e2e（dev-server）               | `mobile:e2e`                            | Metro + Chromium，网络边界自 mock           | target 内联                                 | 进程内                  | ✅             | **仅本地 DevX**                           |
| 8   | mobile hermetic e2e（static export）            | `mobile:runtime-smoke`                  | 静态产物 + Chromium                         | target 内联                                 | 进程内                  | ✅             | ①④（**不在 PR 门**，见下）                |
| 9   | mobile markets-OFF 合规 e2e                     | `mobile:e2e-public`                     | Metro（**端口 4174**）                      | config `webServer.env` 钉死                 | 独占端口                | ❌ 与 #8 互斥  | **仅** ④ nightly-sweep                    |
| 10  | mobile 真后端浏览器 smoke                       | `mobile:e2e-real-backend`               | 容器 + 真 server on **:3000 硬编码**        | harness 注入                                | **独占端口**            | ❌ 与 #11 互斥 | ④ e2e-real-backend                        |
| 11  | 契约冒烟 `[Contract-Smoke]`                     | `mobile:contract-smoke`                 | 容器 + 真 server + 生成的 `@nvy/api-client` | harness 注入                                | **独占端口**            | ❌ 与 #10 互斥 | ④ e2e-real-backend                        |
| 12  | 治理检查单测                                    | `@nvy/checks:test`                      | 无                                          | 无                                          | 进程内                  | ✅             | ①③④                                       |
| —   | futu-shim pytest                                | **非 Nx**                               | 无                                          | 无                                          | 进程内                  | ✅             | ③④（`ci.yml` 独立 job，自带路径过滤）     |

> ④ 含 `nightly-sweep` 的 `run-many --all` 与 `nightly-perf` 的 `nx run server:test`，故 #1 / #2 / #6 / #12 也在 ④ 跑。
>
> **#8 为什么不在 PR 门**：`nightly-sweep.yml` 的 `run-many --all` 本来就跑它，摘出只把 UI 回归的发现推迟至多一天（明确接受的代价）；本地 `pull_request_template.md` 的物理验证命令仍含 `runtime-smoke`，几十秒即完。**这个不对称是蓄意的** —— 本机几十秒能抓到的 UI 回归，不值得占 PR 门几分钟外加与 `server:test` 抢 CPU/Docker。连带结论：**PR 门不需要浏览器**，别往里加 Playwright 依赖。

## 2. env 来源的三条铁律

1. 🔴 **测试进程的 env 有三层，只有一层能钉死。** shell（含 worktree `.envrc` 继承的值）→ `apps/server/.env`（`@nestjs/config` 在 cwd = `apps/server` 时加载，**只填缺失 key**）→ spec 顶层 `??=`（同样只填缺失）。前两层都会让本地与 CI（无 `.env`、无 shell 值）跑不同配置，而 `??=` 挡不住任何一层。**唯一可靠的钉死位置 = `apps/server/vitest.config.ts` 的 `test.env`**（worker 启动时覆盖 shell；也是 boot-required 占位的登记处；spec `beforeAll` 内赋值可再覆盖它）。⇒ 关键 env 烘进 `test.env` / nx target 的 `options.env`，让「正确的事成为默认」，别依赖 cwd。
   🚨 **禁止给活客户端指向「不可达端口」当哨兵。** 把 `DATABASE_URL` / `REDIS_URL` 钉到 `127.0.0.1:1` 之类让真会建连的客户端去连，会把「安静连上真存储」变成**无退避的疯狂重连**，并发时饿死事件循环（全量门挂死、日志空白）。**要治「测试碰真数据存储」，治被测对象**（让它根本不建那个客户端）。`test.env` 里 `REDIS_URL` 的无人监听端口占位**不在此列** —— 它只为过 zod，真连 Redis 的 spec 在 boot 前用 `setupIsolatedStores()` 覆盖。
2. **CI 里没有任何 app secret**。`pr-validation.yml` 无 `env:` 块，测试靠 Testcontainers 自足；prod secret 走 repo→SOPS→主机，**从不经过 Actions**。这个隔离是对的，不要打破。

## 3. 常驻陷阱

> 编号**历史稳定、不回收**。已消解的编号不再列陷阱行，但代码注释仍引用它们，索引如下：**T-1** = 两个 project 按后缀划线（[`testing.md`](testing.md) §2）· **T-2** = `test/**` 已进 typecheck + lint、`src/` 的 `.it.` 不搬（§3.1）· **T-6** = 治理检查单测收编进 `gate-checks`（场景 12）· T-3 / T-5 见 [08-02 落地记录](../improvements/2026-08/08-02-test-size-taxonomy.md)。其耐久结论已并入本文正文、`testing.md` §6 不变量表与下面三条纪律。

从已消解陷阱沉下来的三条常驻纪律：

- **软信号连红第一晚就当事故治。** 恒红信号 = 零信息，且掩护一切真回归。「不阻塞合并 + 每晚一张 issue」会让噪声堆到没人看。
- **无 runner 的测试套件等于不存在。** 新写的检查 / 工具自测必须接进 Nx、lefthook、CI 三者之一，否则它只是躺在仓里的文件。
- **配了不跑的门槛是装饰。** coverage 阈值一类，要设门就先让它在某条自动化里真跑、用实测数据定阈值；否则只保留为 ad-hoc 观测（`nx test server -- --coverage`），别配一个从不生效、哪天被无意接通就一片突然红的数字。

| 编号    | 陷阱                                                                                                                                                                                                                                                                                                                                                        | 后果                                                                                                                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T-4** | **真 vendor 的 `RUN_*_IT` 无任何 workflow 设置**（`RUN_PERF_IT` 不在此列 —— 那是 Medium 计时门，`nightly-perf.yml` 设它；在用名录 = `scripts/checks/check-env-sync.ts` 的 `ALLOWLIST`）。**蓄意保持** —— 「CI 零 app secret」是 §2 铁律 3 的蓄意架构，给 CI 发真凭证去换这层覆盖不划算。兜底纪律 = 手工真跑 + 在 PR / improvements 留痕（何时真调过要可查） | 真 vendor 测试在所有自动化运行中**完全惰性** ⇒ 「测试全绿」对它们覆盖的契约**不构成任何证据**                                                                                      |
| **T-7** | `:3000` 是硬编码全局单例                                                                                                                                                                                                                                                                                                                                    | #10 与 #11 **永远不能并发**                                                                                                                                                        |
| **T-8** | `packages/api-client` 与 `packages/types` **零测试**。**蓄意接受** —— `api-client` 是 orval 生成物（测生成代码 = 测 orval 本身），`types` 是纯类型（typecheck 即测试）；行为验证由 contract-smoke（生成 client 打真 server）+ mobile `backend-contract.spec.ts` + server IT 三层承担                                                                        | 两个包唯一的静态验证是 typecheck，行为验证全部住在别处 —— 改它们时别只看包内绿                                                                                                     |
| **T-9** | **`runtime-smoke` 一个 target 名挂了两件事** —— `server:runtime-smoke` 是 ADR-0040 钢钉 #1，`mobile:runtime-smoke` 是 Playwright e2e                                                                                                                                                                                                                        | 两者已落在不同 job（`server-test` 用 `--exclude=mobile`，`mobile-checks` 反之），改一个碰不到另一个；但**名字仍一名两用**，从 `-t` 列表里删 `runtime-smoke` 会同时删掉两个且不报错 |

## 4. 实测数据在哪

- [08-02 测试分类学落地 + 出网探针实证](../improvements/2026-08/08-02-test-size-taxonomy.md)
- [08-02 环境 × 测试体系重构 plan](../private/plans/2026-08/08-02-env-test-architecture-refactor.md) 各阶段结果段（本机私有，未公开）
