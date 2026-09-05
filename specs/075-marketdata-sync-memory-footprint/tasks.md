---
feature_id: 075-marketdata-sync-memory-footprint
spec_ref: ./spec.md
plan_ref: ./plan.md
status: not-started
created_at: '2026-09-05'
updated_at: '2026-09-05'
---

# Tasks: 075-marketdata-sync-memory-footprint（采集轮次内存足迹治本 —— 异常监控增量化 + 链发现与快照错开峰值）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **来源**：2026-09-05 生产内存耗尽夯机复盘的层 2（复盘全文 local-only）

**病根一句话**：期权快照采集把**整轮 9.7 万行**的异常监控输入攒在一个数组里等到最后才判，实测常驻 **74.8 MB**，而事故当晚整机缺口只有 **51 MB**；紧邻它的链发现在同一拍先跑完、内存尚未回落，又把基线抬高了一截。

> 🚫 **2026-09-05 范围变更：本片只做前半句（US1，异常监控增量化）。** 后半句（US2 / US3，链发现与快照错开）整块降级为 **deferred** —— 对应 **T005 / T006**，落地过一版（`178ce17d`）后已整块回退（`18fc750e`）。两条理由：① 它依赖的 BullMQ 断言**被自己的 IT 证伪**（错开与失败传播拆不开）；② US2 的前提观测早于层 1 与 US1，**已过期**。完整论证与重开判据见 [`spec.md`](./spec.md) 的 Assumptions；形状约束见 [`plan.md`](./plan.md) §B'。**T001–T004 零改动**。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan §X; state_branches n; USn）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环（Constitution §II）；新测试必须证明「能红」（定向变异留档；rebase 后重做）。
- 层级：`[Server]` / `[Server-IT]` / `[Gate]` / `[Ops]`。**本片无 `[Mobile]` / `[Contract-Smoke]` / `[API Client]`** —— 零 endpoint 改动、`web_compat: na`、openapi 与 api-client 不重生成（plan §Summary / §Constitution Check 已逐项核过）。这是结论不是遗漏。
- 🚨 **FR / SC 一律逐条枚举，禁范围记法**。

## Path Conventions

| 用途 | 路径 |
| --- | --- |
| 判定纯函数 + 累加器（改，同文件加导出） | `apps/server/src/marketdata/option-anomaly.rules.ts` |
| 判定测试（**既有 20 条零改写**，只追加） | `apps/server/src/marketdata/option-anomaly.rules.spec.ts` |
| 调用侧：`anomalyRows` 累积点改喂批 | `apps/server/src/marketdata/sync-option-snapshot.usecase.ts`（`:413` 数组 / `:430` 传参 / `:452` 上报 / `:579` push 点 / `:767` `reportAnomalies`） |
| 同上单测 | `apps/server/src/marketdata/sync-option-snapshot.usecase.spec.ts` |
| ~~flow 装配 + 错开落点 + 上界判据（改签名）~~ 🚫 DEFERRED，本片**零改动** | `apps/server/src/marketdata/sync-flow-assembler.ts` |
| ~~同上单测（既有 19 处引用，随签名改）~~ 🚫 DEFERRED，本片**零改动** | `apps/server/src/marketdata/sync-flow-assembler.spec.ts` · `dimension-executor.spec.ts` |
| ~~三个生产调用方（随签名改，各传显式值）~~ 🚫 DEFERRED，本片**零改动** | `sync-tick-driver.ts` · `marketdata-trigger.cli.ts` · `marketdata-backfill.cli.ts` |
| ~~delay 通道（只读复用，禁另造）~~ 🚫 DEFERRED，本片不碰 | `apps/server/src/marketdata/marketdata-sync.queue.ts:295` `jobOpts({ retryMax, delayMs? })` |
| ~~真 Redis 时序 IT（新建）~~ 🚫 DEFERRED —— 写过、跑过、**判红**，未入库，留本机盘等定夺 | `apps/server/src/marketdata/sync-flow-stagger.it.spec.ts`（untracked） |
| 上线后观测归属（local-only） | `docs/private/plans/2026-09/09-05-prod-memory-hang-postmortem.md` §九 批 4 |

## 🚨 Impl Guardrails（plan §Architecture Notes 摘录，盲写会踩且不会红）

> 🚫 **Guardrail 4–9 于 2026-09-05 随 T005 / T006 一并 deferred**（它们全是错开相关）。本片仍生效的是 **1 / 2 / 3 / 10**。原文保留，但重开 US2 时**先读 [`plan.md`](./plan.md) §B' 的形状约束再回来看这几条** —— 4–7 描述的是「把 `delay` 挂在依赖边上」那个形状下的注意事项，而那个形状本身已被判定不成立。

1. 🚨 **全域判据 MUST 跨批求值**（plan §A）—— `greeksSubjects > 0 && otmMissingCodes.length === greeksSubjects && usableAnywhere === 0` 只在 `report()` 里算一次，域是**整轮**。退化成逐批不报错、不会红，只会让休市时段的一次采集从 1 条 WARN 变成 N 条假 WARN，正是原判据要防的那件事。**本片最大回归面。**
2. 🚨 **`feed` MUST NOT 持有喂入的行**（plan §A）—— 只取值推进计数器 / 样本数组 / root 集，不得把 `rows` 或整行对象存进累加器状态。这是全部收益的来源，存了就等于没改。
3. 🚨 **MUST NOT 改任何判据语义、阈值、告警文案**（FR-013）—— 20 条既有单测**零改写**是这条的机器判据。要改测试才能绿 ⇒ 说明改坏了语义，回头看，不是改测试。
4. 🚫〔deferred〕🚨 **错开 MUST NOT 挂在 `sync-tick-driver.ts:154` 的 `jobOpts` 上**（plan §B）—— 上游未 won 时下游成链根，BullMQ 对无 children 的 job 从**入队时刻**起算 delay ⇒ 白等一个间隔，违反 FR-017。落点是 `assembleSyncFlow`，判据是「这个 parent 是否真的把它声明的上游包成了 immediate child」。
5. 🚫〔deferred〕🚨 **上界违反 MUST 在装配期 throw**（FR-018）—— 与 `assertEdgesExpressible` 同一层、同一纪律。运行期静默偏移的后果是采成另一天，而那**不会报错也不会红**。
6. 🚫〔deferred〕**第 4 参 MUST 必填、不给默认值**（plan §B）—— 同文件 `lane` 必填那条注释的理由在这里同样成立：给默认值则新入队路径会静默不错开，而「内存峰叠回去」正是本片要根除的。
7. 🚫〔deferred〕**MUST NOT 新造 delay 通道**（plan §B）—— `jobOpts` 的 `delayMs` 已映射成 BullMQ `delay`，其 doc 注释明写「FlowProducer 组树时复用同语义」。另造一条 = 两份必漂。⚠️ 重开时这条要连着 §B' 一起读：复用 `delay` 字段正是把「等待」编码成边属性的做法，而那与失败传播拆不开。
8. 🚫〔deferred〕**MUST NOT 新增配置列 / migration**（spec Assumptions）—— 取值是本文件内的命名常量表，每个值旁写出处。
9. 🚫〔deferred〕**港股取 0 的注释 MUST 写明「不是不需要，是没观测」**（spec US3）—— 并指向 spec 的重开判据三选一。写成像标定过的一样，下一个读的人就会拿它当依据。📌 这条方法论本次**反过来把美股也判了**（见 [`spec.md`](./spec.md) Assumptions 第 4 条）。
10. **`--expose-gc` 在本仓零先例**（plan §C）—— 实测内存那块拿不到 `global.gc` 时读数全是噪声而测试照样绿。MUST 能区分「过」与「根本没跑」。

## Tasks

- [X] T001 [Server] **判定改累加器形态 + 一次性入口降为薄封装**（FR-001, FR-004, FR-004a, FR-005, FR-006, FR-007, FR-008, FR-009, FR-010, FR-011, FR-012, FR-013; SC-002; plan §A; state_branches 1/2/3/4/5/6/7/8/10; US1）：`option-anomaly.rules.ts` 增 `createOptionAnomalyAccumulator({ now, exchange, knownNonStandardRoots })` → `{ feed(rows), report() }`（**闭包工厂，NOT class**，同文件既有纯函数形态）；把 `detectOptionAnomalies` 现有的 `for (const row of input.rows)` 循环体原样搬进 `feed`，`const findings = []` 起的后半段搬进 `report()`；`detectOptionAnomalies(input)` 改成 `建 acc → feed(input.rows) → report()` → verify: **20 条既有单测零改写全绿**（Guardrail 3 的机器判据，`git diff` 对该 spec 文件应只有新增行）；追加差分臂「同一输入一次喂完 vs 切 N 批喂（N ≥ 2，且**至少一批的边界横切全域判据**：可用 greeks 全落在第一批、缺失全落在第二批）⇒ findings / newNonStandardRoots / metrics **逐字段相同**」；🚨 变异留档：把 `report()` 里的全域判据改成只看最后一批的计数 ⇒ 差分臂必红（这条变异不红 = 差分臂在空跑，Guardrail 1）

- [X] T002 [Server] **常驻结构断言：喂完的行不再被引用**（FR-002, FR-003, FR-021①; plan §A/§C; state_branches 10; US1）：在 `option-anomaly.rules.spec.ts` 追加**确定性**结构断言（不读内存数字，每次回归都跑）—— ① 喂入的行对象在 `feed` 返回后不再被累加器可达（用 `WeakRef` + 可达性断言，或对累加器内部状态做结构遍历断言其不含行对象引用；二选一，选到的那条在文件头写明理由）② 样本数组长度恒 ≤ `MAX_SAMPLE_ITEMS`，喂 10 倍行数不变 ③ `freshRoots` 基数只随**不同 root 数**增长、与行数无关 → verify: 三臂先红后绿；🚨 变异留档：在 `feed` 里加一行把 `rows` 存进累加器状态 ⇒ 臂 ① 必红（若不红说明这条断言够不到「持有」这件事，换观察面重写，per testing.md §7）

- [X] T003 [Server] **实测内存块（env-gated，默认 skip）**（FR-021②; SC-001, SC-003; plan §C; state_branches 10; US1）：在 `option-anomaly.rules.spec.ts` 追加 `describe.skipIf(!process.env.RUN_PERF_IT)` 块，用 `--expose-gc` 量「喂 1 万行 vs 喂 10 万行」判定侧常驻的比值 → verify: 比值 < 2（SC-001）、10 万行的常驻 < 1 MB（SC-003）；🚨 **拿不到 `global.gc` 时 MUST 显式 skip 并留可见输出**，绝不静默通过 —— 本仓 `--expose-gc` 零先例，「没跑」与「过了」在数据上必须能区分（Guardrail 10 / testing.md §7）；判据写成**比值**而非绝对字节（对机器差异鲁棒）；env 名复用 `RUN_PERF_IT`（已在 `scripts/checks/check-env-sync.ts:72` ALLOWLIST，🚫 不新造 flag）；跑法与读数写进文件头；
  🚨 **两臂对照，缺一不算实证**（testing.md §7）—— 本块的失效形态是「一直绿着却什么也没量到」，而它是唯一钉 SC-001 / SC-003 的东西。**对照臂 = 在 `feed` 里把 `rows` 存回累加器状态的变异体**（等价于 T001 之前的持有语义）⇒ 同一判据下比值应 ≈ 10× 而非 < 2，**必须判红**。红/绿两次读数与复跑命令一并写进文件头；🚫 变异臂**不常驻**，故它属于 out-of-test sabotage 形态（testing.md §7.1）—— 写不进文件头就等于没验过

- [X] T004 [Server] **调用侧改喂批 + 累加器懒创建保住空轮语义**（FR-001, FR-003, FR-010, FR-012; plan §A; state_branches 8/9; US1）：`sync-option-snapshot.usecase.ts` 把 `anomalyRows: OptionAnomalyRow[]`（`:413`）换成累加器；`syncUnderlying` 形参同步换（`:469`）；`:579` 那段 `for (const row of persistable) anomalyRows.push(...)` 改成「构**批内**数组 → `acc.feed(它)` → 出作用域即回收」；`reportAnomalies`（`:767`）改成读累加器；**累加器在第一次拿到非空批时才创建** —— 空 `marketScope` 的守卫随之只在「确实有行要判」时触发，与今天 `rows.length === 0` 早退在前的谓词一致 → verify: 同名 spec 四臂先红后绿 ① 全轮零落库行 ⇒ 零 finding、零抛（sb 8）② 某标的整票失败 / 限频顺延 ⇒ 已喂入的行仍进结论、未采的不进（sb 9）③ 判定面仍恒等于 `persistable`（被硬门拒的行不进 WARN 面）④ 空 `marketScope` + 有行 ⇒ 仍抛；🚨 **代码注释 MUST 写明那处不等价**：throw 从「全部标的跑完之后」提前到「第一批」，抛之前少写若干行；该守卫按上游双闸（`collect()` 的 `foreign` 守卫 + `resolveAttribution` 的 `length !== 1`）本就不可达，差异是理论上的 —— 不写下一个人会当成漏改

- [ ] **DEFERRED（2026-09-05）** T005 [P] [Server] **错开落在装配期：`assembleSyncFlow` 第 4 参 + 取值常量 + 上界 throw**（FR-014, FR-015, FR-017, FR-018, FR-019, FR-019a, FR-019b, FR-023; plan §B; state_branches 13/14/15/16; US2/US3）：`sync-flow-assembler.ts` 给 `assembleSyncFlow` 加**必填**第 4 参（错开表）；在 `:113` 的包裹循环里，仅当「刚被包进去的 child 正是该维度在表里声明的上游」时才给这个 parent 的 opts 合入 `delay`（复用 `jobOpts` 的 `delayMs` 语义，Guardrail 7）；同文件加命名常量表：**美股 30 分钟**（出处：`20260823_1015_seed_hk_option_dimensions/migration.sql:46` 记录的、2026-08-27 合并两拍之前港股快照相对其链发现的原有错开量）、**港股 0**（注释 MUST 写明「不是不需要，是没观测」+ 指向 spec 重开判据，Guardrail 9）；加上界校验并 throw（Guardrail 5，港股那条的参照物是 `hk_option_oi_settle` 的 `0 40 21 * * *`）；三个生产调用方各传显式值（两个 CLI 是人工触发 ⇒ 显式「不错开」）→ verify: `sync-flow-assembler.spec.ts` 六臂先红后绿 ① 上游 won 且相邻 ⇒ parent 带 delay（sb 14 正面）② 上游未 won、下游成链根 ⇒ **不带 delay**（sb 13，FR-017）③ 取值 0 的市场 ⇒ 装出的树与改动前逐字段相同（sb 15，FR-019a）④ 一市改值不影响另一市（sb 16，FR-019b）⑤ 上界违反 ⇒ throw（sb 14 反面）⑥ 把港股取值改成非 0 ⇒ 错开按与美股**同一套语义**生效，且改动面只有常量表那一行（US3-AS2 —— 这条来自 Acceptance Scenario 层，analyze 的三张矩阵扫不到，故在此显式挂账）；既有 19 处引用随签名改但**断言体零改动**；🚨 变异留档：把落点改回「无条件挂在维度 opts 上」⇒ 臂 ② 必红
  > 🚫 **DEFERRED 原因**：本 task 曾以 `178ce17d` 落地并全绿，但随后由 T006 的真 Redis 三臂**证伪了它所依赖的前提**（BullMQ 里 parent 的 `delay` 与失败传播共用同一条 Lua 出口，拆不开 ⇒ 美股 hard 边失败晚 30 分钟才报，违反 FR-016 / SC-005 / `state_branches` 12），已整块回退于 `18fc750e`。叠加 US2 的前提观测本身已过期。**重开判据**见 [`spec.md`](./spec.md) Assumptions「美股侧错开重开的判据」；**重开时 MUST NOT 照抄本 task 的落点设计**，先读 [`plan.md`](./plan.md) §B'「将来重开时的形状约束」——「等待」要做成一个节点，不是依赖边的属性。

- [ ] **DEFERRED（2026-09-05）** T006 [Server-IT] **真 Redis 时序：delay 从 child 完成时刻起算 + 失败传播不被延后**（FR-014, FR-016, FR-022; SC-004, SC-005; plan §B/§C; state_branches 11/12; US2）：新建 `sync-flow-stagger.it.spec.ts`，自起 `RedisContainer('redis:7-alpine')`（**只要 Redis、不挂共享 PG**，testing.md §4 步 3；先例 `alert/push-dispatch.processor.it.spec.ts:2`），用 `FlowProducer` 装一亲一子、child 跑满一段可分辨的时长 → verify: 三臂 ① `parent.processedOn − child.finishedOn ≥ delayMs`（SC-004，sb 11）② **对照臂** delay=0 ⇒ 同一差值为个位数毫秒（两臂缺一不算实证，testing.md §7）③ child 失败 ⇒ parent 立即被唤醒、时延与未加错开时同量级（SC-005，sb 12，FR-016）；📌 **FR-022 无需新增日志**：`sync_run` 已有逐维度的 `started_at` / `finished_at`（`schema.prisma:1374/1375`），下游起跑 − 上游完成事后直接可查 —— 本 task 只需在文件头把这条查法写下来；执行走 `pnpm nx test server <file>`（🚫 禁 `vitest --root`，找不到 schema）
  > 🚫 **DEFERRED 原因**：本 task 的三臂**已经实际写出来跑过两轮**，而且**臂 ③ 判红** —— 读数与结论落在 [`plan.md`](./plan.md) §B 末的证据包 C（`delay`=1500 ms + child 失败 ⇒ `finishedOn − child.finishedOn` = 1511 ms，对照臂 0 ms）。它因此**不是「没做完的验收」，是本次降级的取证载体**：正是它证伪了 T005 的前提。⇒ 随 US2 deferred。**重开判据**见 [`spec.md`](./spec.md) Assumptions「美股侧错开重开的判据」；重开时这条 IT 仍然要写（BullMQ 官方 `patterns/process-step-jobs` 未覆盖 flow 内用法 ⇒ 端到端时序必须实测），但被测形状要按 [`plan.md`](./plan.md) §B' 换成「等待是一个节点」。
  > 📌 承载这次取证的 spec 文件（`apps/server/src/marketdata/sync-flow-stagger.it.spec.ts`）**未入库**，留在本机盘上等定夺 —— 它的臂 ③ 断言的是被证伪的那条性质，原样进仓即是一条恒红的测试。

- [ ] T007 [Gate] **零回归全量门**（SC-006; plan §C; US1）：不写新断言，跑**权威 PR 门口径**的全量 —— `nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache`（该命令串的唯一权威是 [local-verification §2 命令矩阵](../../docs/conventions/local-verification.md) 的「PR 门」行；🚫 **MUST NOT** 换成 `run-many -t typecheck,lint,test` 之类的窄口径 —— 少了 `build` / `runtime-smoke` 就是拿弱证据去勾 PR 的 hard-gate checkbox）→ verify: 全绿，且**结果判定按 local-verification §3「exit code 会说谎」**（别只看退出码）；且**零个既有断言被改写或删除** —— 逐文件取证 `git diff --stat` 对 `option-anomaly.rules.spec.ts` / `sync-option-snapshot.usecase.spec.ts` / `sync-flow-assembler.spec.ts` / `dimension-executor.spec.ts` 的**删除行**逐条归属（签名改动引起的调用行更新可接受，断言体改动不可接受）；🚨 Testing Invariant：「判据语义一条没改」由**既有测试全绿**承担，MUST NOT 新写一条「语义没变」的断言

- [ ] T008 [Ops] **上线后观测口径落到复盘批 4**（SC-007, SC-008; plan §Gate 0.1; US1/US2）：把两条 post-merge 判据写进 `docs/private/plans/2026-09/09-05-prod-memory-hang-postmortem.md` §九 批 4 的清单 —— ① 连续 7 个采集窗无被中断轮次 + 容器内存事件计数与重启次数保持 0（SC-007）② 任一采集窗内宿主可用内存最低点 ≥ 200 MB（SC-008，该阈值取事故当晚崩溃点 80 MB 的 2.5 倍，是**保守边界不是标定值**）→ verify: 批 4 清单可见这两条且各自写明数据来源（采样 CSV 的哪几列）；📌 **SC-007 / SC-008 是本片唯二不进 PR 门的 SC，这是故意的** —— 它们要真实采集窗才能求值，写在这里是为了不让它们变成「只有口号、没有验证手段」的那类 SC（sdd-authoring 反模式 ②）；⚠️ 同时登记一条批 2 的连带陷阱：09-08 那轮曲线量到的峰值是**改动后**的，拿它反推容器内存上限与堆上限的终值会系统性偏小

## 覆盖核对（起手先列「spec 有哪几层 / 我扫了哪几层」）

spec 共五层。三层机器可扫，已逐条 grep 交叉核对；两层无 ID、手工映射。

🚫 **2026-09-05 重算**（US2 / US3 降级后）：spec 的**总条数一条没变**，变的是「本片验收面」。下表因此拆成三列 —— **总数 / 本片验收面 / 覆盖**。条数全部实时 grep 重数，未抄旧值。

| 层 | spec 总条数 | 本片验收面 | 覆盖 | 降级掉的是哪些 | 扫法 |
| --- | --- | --- | --- | --- | --- |
| `state_branches` | 16 | **10** | **10/10** | 11–16（6 条调度分支） | 取 tasks 侧 `state_branches n` 注记的并集与 1–10 求差 |
| FR | 26 | **15** | **15/15** | FR-014 / 015 / 016 / 017 / 018 / 019 / 019a / 019b / 020 / 022 / 023（11 条） | 逐个 `FR-xxx` 在 tasks.md 零命中扫描 |
| SC | 8 | **6** | **6/6** | SC-004 / SC-005（2 条） | 同上 |
| Edge Cases | 9 | **5** | **5/5** | 「错开间隔取得过大」/「取得过小」/「有人试图用改触发时刻」/「上游完成但下游队列正忙」（4 条） | 手工映射，无 ID |
| **Acceptance Scenarios** | 11 | **4**（US1 全部） | **4/4** | US2 的 4 条 + US3 的 3 条 = 7 条 | 手工映射 —— 🚨 **这一层 analyze 的三张矩阵扫不到**，写在 AS 里的需求会零覆盖且零告警（sdd-authoring 反模式 ④/⑧）。上一轮核对逮到的那条缺口（US3-AS2）曾补为 T005 臂 ⑥，随 T005 一并 deferred |

**逐层记账（对得上才算数）**：

- `state_branches`：16 − 6 = 10；覆盖并集 = T001 的 1/2/3/4/5/6/7/8/10 ∪ T002·T003 的 10 ∪ T004 的 8/9 = {1…10}。
- FR：26 − 11 = 15，即 FR-001…FR-013（14 条，含 FR-004a）+ FR-021。覆盖：FR-001 (T001,T004)、FR-002 (T002)、FR-003 (T002,T004)、FR-004 / FR-004a / FR-005 / FR-006…FR-013 (T001)、FR-010 / FR-012 亦见 T004、FR-021① (T002) + FR-021② (T003)。
- SC：8 − 2 = 6 = SC-001 (T003)、SC-002 (T001)、SC-003 (T003)、SC-006 (T007)、SC-007 (T008)、SC-008 (T008)。
- Edge Cases：9 − 4 = 5 = 「全轮零落库行」(T004 臂①)、「某标的整票失败 / 限频顺延」(T004 臂②)、「新非标 root 跨批去重」(T001)、「命中条数远超样本上限」(T002 臂②)、「全域判据在增量形态下退化」(T001 变异臂)。
- AS：11 − 7 = 4 = US1 的 AS1 (T001 差分臂) / AS2 (T002 臂②③ + T003) / AS3 (T002 臂①) / AS4 (T001 全域判据臂)。

**故意的零覆盖：本片现在一条也没有** —— 🚨 这本身是一条发现，**原先那三条全部是错开相关的**，随 US2 / US3 一并 deferred，于是「有意不覆盖」这个类别在本片内清空了。原三条原样搬到下面存档，重开 US2 时直接可用：

1. ~~**Edge Case「错开间隔取得过小」**~~〔已随 US2 deferred〕—— 无验收手段。它不产生错误数据，只是纵深失效；spec 已声明为可接受残余风险，取值校准归批 2 的曲线。
2. ~~**Edge Case「有人试图用改触发时刻来实现错开」**~~〔已随 US2 deferred〕—— 由**落点选择本身**承载，盲写由 Guardrail 4 拦。写不出有意义的运行时断言：「没有用另一种方式实现」不是一个可观测的运行时状态。⚠️ 重开时这条判断仍然成立，但落点会变（见 [`plan.md`](./plan.md) §B'）。
3. ~~**Edge Case「上游完成但下游队列正忙」**~~〔已随 US2 deferred〕—— 曾被 T006 的判据形态吸收（断言写成 `≥ delayMs` 而非 `== delayMs`），不另开臂。

## Dependencies

```text
T001 ─┬─> T002        (同文件，T002 断言的是 T001 造出的累加器)
      ├─> T003        (同上)
      └─> T004        (调用侧依赖 T001 的接口)

T005 ────> T006       🚫 两条均 DEFERRED (2026-09-05)，不在本片依赖链上

T001..T004 ──> T007   (全量门放最后)
T007 ──> T008         (观测口径在实现定稿后登记)
```

- ~~**T005 与 T001–T004 正交**（不同文件、无共享符号）⇒ 可并行，故标 `[P]`。~~ 🚫 T005 / T006 已 deferred；**正交性判断仍然成立且已被实证** —— 摘掉 T005 时 `git diff 178ce17d^ -- apps/server/` 为空、T001–T004 的产物零改动。
- T002 / T003 / T004 三者互不依赖，但都依赖 T001；T001 落地后三者可并行。

## Implementation Strategy

**MVP = T001 + T004**。这两条就是 US1（P1），单独落地即覆盖 74.8 MB 的全部收益，也就覆盖了事故当晚 51 MB 的缺口。T002 / T003 是这份收益的验收手段。~~T005 / T006 是纵深（US2 / US3）。~~

🚫 **2026-09-05：T005 / T006 降级为 deferred ⇒ 本片 = MVP + 其验收手段 + 两条收尾**，即 T001 / T002 / T003 / T004 / T007 / T008 共 6 条。**MVP 本身一字未动** —— 被摘掉的正是「纵深」那一半，而算账（见 [`spec.md`](./spec.md) Assumptions）显示光靠 MVP 事故当晚就已不崩。

📌 **附带净收益**：clarify Q3 当初为赶 09-08 显式放弃了「改动前基线」；错开摘掉后，09-08 那一轮变成「带 US1、不带错开」—— 这恰好是判断错开要不要开、开多少的干净基线，且是唯一一次机会（错开一旦开了就再也量不到）。

**Clear 检查点批次**（Constitution §III）：① T001–T002 ② T003–T004 ~~③ T005–T006~~ ③ T007–T008。每批 2 条、批内强关联，批后停顿提醒 `/clear`。**批次 ≠ commit 合并** —— 每 task 仍各自 atomic commit。
