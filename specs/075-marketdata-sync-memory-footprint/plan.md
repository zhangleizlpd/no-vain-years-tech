---
feature_id: 075-marketdata-sync-memory-footprint
spec_ref: ./spec.md
status: drafted
created_at: '2026-09-05'
updated_at: '2026-09-05'
adr_refs: ['0040', '0043', '0066']
context7_verified: []
---

# Implementation Plan: 采集轮次内存足迹治本

## Summary

把期权快照采集的异常监控从「攒齐整轮再判」改成「每批喂完即可回收」的累加器形态（常驻由 O(n) 降到 O(1)）。~~并给链发现 → 快照这条 hard 边加一个从**上游完成时刻**起算的错开下界。~~ 不新增表、不新增依赖：累加器是同文件内的形态改造。

🚫 **2026-09-05：调度错开（§B / US2 / US3）已降级为 deferred，本片只落累加器这一半。** 两条理由 —— ① §B 的承重断言「加 delay 不会拖慢失败传播」**已被证伪**（§B 末的证据包 A/B/C）；② US2 的前提观测已过期（见 [`spec.md`](./spec.md) Assumptions）。已落地的那版实现（`178ce17d`）整块回退于 `18fc750e`。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| --- | --- | --- |
| None | N/A | N/A |

`@testcontainers/redis` 是**已装**依赖（既有用例 `apps/server/src/alert/push-dispatch.processor.it.spec.ts:2` 已 import `RedisContainer`），本片复用、不新增。

⚠️ **BullMQ `delay` 语义的取证状态（2026-09-05 重新标注）** —— 原文在这里写「上一轮已用源码 + 真 Redis PoC 双证验过」，这个措辞把**两条不同的断言**混成了一条：

| 断言 | 状态 | 出处 |
| --- | --- | --- |
| child **成功**时，parent 的 `delay` 从 child 完成时刻起算（不是入队时刻） | ✅ **成立** | `moveToFinished-14.js:400-410`；本片实测臂 ①② = 1528 ms / 0 ms |
| child **失败**时，`delay` 被清零、失败传播不被延后 | 🚨 **已证伪** | 见 §B 末的证据包 A/B/C；实测臂 ③ = 1511 ms |

第二条当初从未被单独验证过 —— 它是顺着第一条的源码阅读**推断**出来的，却被写成了同一句「已验过」。⇒ 证据落 §B，**不再引用「上一轮」**。

## Constitution Check _(mandatory gate)_

- [x] **Passed** — plan honors all constitution principles.

逐条：§I SDD 全流程已走到 plan（clarify 4 问已收口）；§II TDD 红绿由每个 task 承担；§III task 拆成 30min–2h 可独立 commit 单元（见下方 Architecture Notes 的切分意图）；§IV 全部改动落在 `apps/server/src/marketdata/` 内、扁平平铺、零 class、不碰他 ctx 的表；§V 无 endpoint 改动 ⇒ 不触发 openapi / api-client 重生成，纯 server 单 PR。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**〔2026-09-05 改写〕: 本片不新增 endpoint。~~真启动冒烟的对象是调度侧的错开下界~~ —— **调度侧（§B）已 deferred，真 Redis 时序 IT 不再是本片的验收面**。本片剩下的 US1 全部落在 `apps/server/src/marketdata/` 的**纯函数与其调用侧**，无进程边界、无外部依赖 ⇒ 真启动冒烟对本片 **N/A**；等价保障由既有的三条整轮 tick e2e IT（`marketdata.flow-orchestration` / `marketdata.night-e2e-019` / `marketdata.tier-night-e2e`）承担 —— 它们打真 Redis + 真 PG 跑完整轮调度，本片对它们**零改动**、且回退后原生回绿（3 files / 9 tests，6.63 s）。
- [x] **Mobile / Web**: N/A —— `web_compat: na`，无任何前端面。
- [x] **Evidence**〔2026-09-05 改写〕: ~~判据 `parent.processedOn − child.finishedOn ≥ delayMs` + 对照臂 delay=0~~ —— 该三臂 IT **已实际跑过**，读数与结论落在 §B 的证据包 C；它证伪了 §B 的承重断言（臂 ③ 1511 ms），是 US2 降级的直接证据，**不是本片的验收证据**。本片的验收证据 = `pnpm nx run-many -t lint typecheck test -p server --skip-nx-cache` 全绿（Test Files 502 passed / 13 skipped，Tests 5890 passed / 87 skipped）+ 各 task 自己的定向变异留档。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**Evidence**: N/A —— 本片不引入任何新的第三方 package / SDK / tool（依赖表已声明 `None`）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] **Evidence**: N/A —— feature is mono-native。被改的三个文件（`option-anomaly.rules.ts` / `sync-option-snapshot.usecase.ts` / `sync-flow-assembler.ts`）均为 mono 内 TS 原生产物，无 Java/Maven 前身。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

扫的是 `docs/adr/{0039,0040,0043,0047,0066}-*.md` 的 Open Questions 段（命令：`awk '/^##+ .*Open Question/{s=1;next} /^##+ /{if(s)s=0} s' docs/adr/<id>-*.md`）。0043 / 0039 无该段；0040 / 0047 的条目分别是测试门禁机制与 vendor 配额，与本片无交集。唯一相邻的一条：

| ADR | Open Question affected | Classification | Mitigation / next step |
| --- | --- | --- | --- |
| ADR-0066 | 「`sync_run` 的『实际写入行数』统计加在 recorder 层还是各 executor 自报」 | accepted-as-is | 本片改的是**判定面**的持有形态，不碰 `addWritten` 与写入统计口径 —— 既不推进也不恶化该问题。impl 时若发现必须动写入统计，视为溢出本 feature，按 stop signal 停下确认 |

## Architecture Notes

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。这些组件依赖 NestJS DI lifecycle 顺序 (Guards→Interceptors→Pipes→Filters)，mock 隔离 = 抹掉 PR-79 类 cascade bug 的唯一信号。
- **MANDATORY INTEGRATION**: 必须用 `Test.createTestingModule({ imports: [<TheModule>] }).compile()` 装一个微型 DI 容器，让被测组件在真实 lifecycle 中触发。`createTestingModule` 之外的"测试" 视同未测试。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 列出的每条分支，**必须**在 integration test 文件中有对应 `it()` 块。100% 路径覆盖 — 不允许漏 cold-boot / 路由根 `/` 等非 happy-path 状态（PR #79 实证 4 层 cascade 始于一个未列状态分支）。

> 📌 **本片的适用面**〔2026-09-05 更新〕：不含任何 Guard / Interceptor / Filter / Pipe ⇒ 前两条 vacuous。**第三条足额适用，但作用面缩到前 10 条** —— 16 条 `state_branches` 里前 10 条是判定分支（落 Small 纯函数测试），~~后 6 条是调度分支~~ **后 6 条（11–16）随 US2 / US3 deferred、本片不验收**。分档不豁免覆盖：**在本片验收面内**的每条仍要有对应 `it()`。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
>
> - **Flat Module**: ALL files live flatly in `apps/server/src/marketdata/`. NEVER generate `domain/`, `application/`, `infrastructure/`, or `web/` subdirectories.
> - **Anemic Data & Zero-Class**: 累加器是**闭包工厂**（`createOptionAnomalyAccumulator(...)` 返回 `{ feed, report }`），NOT a class。同文件既有的 `greeksUsable` / `moneynessOf` 都是模块级纯函数，累加器沿用同一形态。
> - **No Repositories**: 不新建任何 port / adapter。
> - **The Moat**: 本片不新增任何跨 ctx 访问。

#### A. 异常监控：形态改造，判据一条不改

- **形态**：`option-anomaly.rules.ts` 增 `createOptionAnomalyAccumulator({ now, exchange, knownNonStandardRoots })` → `{ feed(rows), report() }`。`feed` 把现有那个 `for (const row of input.rows)` 循环体原样搬进来，逐行更新计数器 / 样本数组 / `freshRoots` 集；`report()` 是现有函数从 `const findings = []` 起的后半段。
- **一次性入口保留为薄封装**（spec FR-004a / clarify Q1）：`detectOptionAnomalies(input)` 改成 `建 acc → acc.feed(input.rows) → acc.report()`。挂在它上面的 **20 条既有单测零改写**继续跑，它们是这套判据唯一的回归网 —— 与本次改动同时重写就失去了对拍基准。
- 🚨 **喂完不再引用**：`feed` 只从行里取值（计数、`row.contractCode` 推进样本数组、`row.root` 进 `Set`），**不得**把 `rows` 或整行对象存进累加器状态。这是 FR-002 / FR-003 的全部内容，也是这次改造唯一的收益来源。样本数组的上界（现 `MAX_SAMPLE_ITEMS`）与 `freshRoots` 的天然小基数是「O(1)」成立的两个前提，测试要正面钉住。
- 🚨 **全域判据 MUST 跨批**：`greeksSubjects > 0 && otmMissingCodes.length === greeksSubjects && usableAnywhere === 0` 这条只在 `report()` 里求值一次，求值域是**整轮**。退化成逐批求值不会报错、不会红，只会让休市时段的一次采集从 1 条 WARN 变成 N 条假 WARN —— 正是原判据要防的那件事（spec FR-005，本片最大回归面）。
- **调用侧**（`sync-option-snapshot.usecase.ts`）：把 `anomalyRows: OptionAnomalyRow[]`（:413）换成累加器；`syncUnderlying` 的形参随之从数组换成累加器；批循环里那段 `for (const row of persistable) anomalyRows.push(...)`（:579）改成「构一个**批内**数组 → `acc.feed(它)` → 出作用域即可回收」。**判定面不变**：仍只喂 `persistable`（过了硬门、真落库的行），被拒行由 `reportRejected` 出 ERROR，不进 WARN 面。
- **懒创建，保住空轮语义**：现 `reportAnomalies` 先 `rows.length === 0` 早退、再取 `marketScope[0]` 判 exchange 并在空 scope 时抛（:774–:786），且那处 🚨 注释明写「判据放在零行早退之后，空批那条路上新抛异常是行为回归」。累加器要 DTE 基准就必须在 `feed` 时已有 exchange ⇒ **累加器在第一次拿到非空批时才创建**，空 scope 的守卫随之只在「确实有行要判」时触发，与今天的谓词一致。
  ⚠️ **一处不等价，显式接受**：今天这个 throw 发生在全部标的跑完之后，改造后发生在第一批 —— 抛之前少写若干行。该守卫按上游双闸（`collect()` 的 `foreign` 守卫 + `resolveAttribution` 的 `length !== 1`）本就不可达，是纵深防御；差异是理论上的。impl 时在代码注释里写明这一点，别让下一个人以为是漏改。

#### B. 调度错开：落点在装配期，不在 opts 注入点 🚫 DEFERRED（2026-09-05）

> 🚫 **本节整段于 2026-09-05 降级为 deferred，本片不落地**（全文保留，论证要留痕）。US2 / US3 一并降级，理由见 [`spec.md`](./spec.md) 的 Assumptions「US2 的前提观测为何已过期」。
>
> 本节自身塌在**最后一条**上：下文「失败传播不受影响」那条断言**已被证伪**（源码 + 官方文档 + 真机实测三重证据，逐条落在本节末）。按本节设计落地的实现（`178ce17d`）会让美股 hard 边的失败晚 30 分钟才报 ⇒ 已整块回退（`18fc750e`）。
>
> ⚠️ **落点、上界、必填第 4 参这些工程判断本身没有被证伪** —— 它们只是建立在一个错误的前提上。将来重开时**不要照抄本节**：先读下面的「重开时的形状约束」，那里说的是「把 `delay` 挂在依赖边上」这个**形状**本身就不成立。

- **通道已存在，不新造**：`MarketdataSyncQueue.jobOpts({ retryMax, delayMs? })`（`marketdata-sync.queue.ts:295`）已经把 `delayMs` 映射成 BullMQ 的 `delay`，其 doc 注释明写「FlowProducer 组树时复用同语义」。缺的只是**谁来传**。
- 🚨 **不能无条件挂在维度的 `opts` 上**。tick driver 在 `:154` 统一给每个维度装 `jobOpts({ retryMax })`；若在那里把下游维度的 `delayMs` 一律填上，当上游本轮**未 won**（禁用 / 暂停 / 未 due）时下游会成为链根，BullMQ 对无 children 的 job 从**入队时刻**起算 delay ⇒ 白等一个错开间隔。这直接违反 FR-017。
- ⇒ **落点 = `assembleSyncFlow`**（`sync-flow-assembler.ts:89`）。理由有二：① 只有它掌握**链相邻**的权威事实（`chain` + `edgeByPair` 都在这里算），能判「这个节点是不是真的把它声明的上游包成了 immediate child」；② FR-018 要求上界违反在**装配期**拒绝，而这个函数已经是「不可表达拓扑必须 throw」的那道门（`assertEdgesExpressible`），新判据落进同一层是延续既有纪律、不新开一处。
- **实现意图**：装配循环里 `node = { ...toNode(d), children: [node] }` 那一步，若 `d` 的维度键在错开表里、且刚被包进去的 child 正是该表声明的上游 ⇒ 给这个 parent 节点的 opts 合入 `delay`。其余节点一律不带 delay。
- **签名扩展为必填第 4 参**，不给默认值。`assembleSyncFlow` 有 **3 个生产调用方**：`sync-tick-driver.ts:161`、`marketdata-trigger.cli.ts:300`、`marketdata-backfill.cli.ts:232`。两个 CLI 是**人工触发**，语义上就该立刻跑 ⇒ 它们显式传「不错开」。之所以不用可选参默认关，是同队列文件里 `lane` 必填那条注释给的理由在这里同样成立：给了默认值，将来新加的入队路径会**静默**不错开 —— 而「内存峰又叠回去」正是本片要根除的东西，静默失效的代价与当初 lane 落错队列同级。必填 ⇒ 漏传是 typecheck 红。
- **取值**：美股 30 分钟；港股 0（clarify Q3/Q4）。载体是本文件内的命名常量表（每市一项），**不新增配置列**（spec Assumptions）。每个取值旁写出处 —— 30 分钟来自 `20260823_1015_seed_hk_option_dimensions/migration.sql:46` 记录的、合并两拍之前港股快照相对其链发现的原有错开量；港股的 0 旁边要写明「不是不需要，是没观测」并指向 spec 的重开判据。
- **上界判据**（FR-018）：装配期校验 `delay` 不把下游推出当日归属窗、且不与同市场后续采集轮次次序颠倒（港股那条的参照物是 `hk_option_oi_settle`，cron `0 40 21 * * *`）。违反 throw，走 tick driver 既有的 catch → 结构化 ERROR 出口（`:165`），不静默偏移。
- ~~**失败传播不受影响**：BullMQ 在 child 失败时走 `handleChildFailureAndMoveParentToWait()`，显式 `HSET parentKey "delay" 0` 再移入 `wait` ⇒ 加 delay **不会**拖慢 hard 边的失败传播（FR-016）。~~
  🚨 **本条已被证伪（2026-09-05）。** 它是整个 §B 的承重墙 —— 承重墙塌了，§B 一并 deferred。原文那句「显式 `HSET parentKey "delay" 0`」**只描述了两支中我们够不到的那一支**。

  **A. 源码实证**（`bullmq@5.78.0`，`node_modules/.pnpm/bullmq@5.78.0/node_modules/bullmq/dist/cjs/scripts/moveToFinished-14.js`）：

  | 行 | 内容 | 对我们意味着什么 |
  | --- | --- | --- |
  | `:470` | `if parentData['fpof']` → `:474` `handleChildFailureAndMoveParentToWait(...)` | 我们的 hard 边（`failParentOnFailure`）走这里 |
  | `:446` | `if ZSCORE(parent:waiting-children, parentId)` | 🚨 **我们恒走这一支，而它不动 `delay`** |
  | `:448-450` | `elseif ZSCORE(parent:delayed, ...)` → **才** `HSET parentKey "delay" 0` | 原文引的就是这一支 —— 我们**永远够不到** |
  | `:452-456` | 两支合流：都 `HSET parentKey "defa" "child <key> failed"` 然后 `moveParentToWait(...)` | 清零与否，出口是同一个 |
  | `:400-403` | `moveParentToWait` 先 `HMGET parentKey "priority","delay"` → `if delay > 0` | 读到的仍是 30 分钟 |
  | `:404-410` | ⇒ `ZADD parent:delayed (timestamp+delay)` | 🚨 **失败传播在这里被拖满一个完整错开间隔** |

  **为什么我们必然命中 `:446`**：`sync-flow-assembler.ts` 里 `node = { ...parent, children: [node] }` 装出来的是**嵌套单链**，每个 parent 恰好 1 个 child ⇒ child 失败的那一刻，parent 必定还在 `waiting-children` 里（它还没等到过任何终态）。
  **没有任何配置能绕开**：四种 mode 全部落到同一个 `moveParentToWait` —— `fpof` `:470` / `cpof` `:482` / `idof`-`rdof` `:488`。

  **B. 官方文档语义**（<https://docs.bullmq.io/guide/flows/fail-parent>，两句原文）：

  > "As soon as a _child_ with this option fails, the parent job will be marked as failed **lazily**."
  > "**A worker must process the parent job before it transitions to the failed state.**"

  ⇒ 这是 **documented behavior，不是 bug**。changelog 里那条 `flow: consider delayed state when moving a parent to failed (#3112)` 正是 `:448-450` 那一支，而 **5.78.0 已经带着它** ⇒ **升级无用**。

  **C. 真机实测**（`bullmq@5.78.0` + `redis:7-alpine`，两次复跑一致）：

  | 臂 | 配置 | 读数 |
  | --- | --- | --- |
  | ① | `delay`=1500 ms、child 成功 | `parent.processedOn − child.finishedOn` = **1528 ms** ✓（delay 确实从 child 完成时刻起算） |
  | ② | `delay`=0（对照臂）、child 成功 | 同一差值 = **0 ms** ✓ |
  | ③ | `delay`=1500 ms、**child 失败** | parent 确实 failed，但 `processedOn − child.finishedOn` = **1509 ms**、`finishedOn − child.finishedOn` = **1511 ms**，`failedReason` = `"child bull:...:<id> failed"` 🚨 |

  ⇒ 臂 ③ 判死了原断言：**失败传播被延后了整整一个错开间隔**。按生产取值等比放大 = 美股 hard 边失败**晚 30 分钟**才报，违反 FR-016 / SC-005 / `state_branches` 12。

  📌 **这条断言当初为什么会错，比它错在哪更重要**：原文写的是「这一条是上一轮读源码时确认的」—— 一个**跨轮次继承过来的「已验证」结论**，在新语境（这次是「child 失败」而非「child 成功」这条路径）下失效了，却**没有被重新标注置信度**，就直接当成既成事实用了。⇒ 本片起，`plan` 里 MUST NOT 出现「上一轮 / 之前已确认」这类措辞：要么当场给出出处（源码行 / 观测值 / 文档原话），要么显式标「未验证」，没有中间态。

#### B'. 将来重开时的形状约束（业内标准形状）

> 📌 本节是 §B 降级的**产物**，不是本片的实施内容。它存在的意义：下一个人重开 US2 时不要再走一遍 §B 那条路。

🚨 **「等待」是一个节点，不是依赖边的属性。** §B 把 `delay` 挂在 parent 的 `opts` 上，等于把「等待」编码成边的属性；而在 BullMQ 里 parent 的 `delay` 与它的失败传播共用同一条 Lua 出口（`moveParentToWait`）⇒ 两者**在实现层面拆不开**。这不是 BullMQ 的缺陷，是「把等待挂在边上」这个形状的必然结果。

| 参照 | 做法 | 关键性质 |
| --- | --- | --- |
| Apache Airflow | 上下游之间插一个 `TimeDeltaSensor` **任务节点**，边仍是普通 `all_success` | 上游失败 ⇒ 下游立刻 `upstream_failed`，**不等 sensor** |
| AWS Step Functions | 显式 `Wait` **state**（一个状态，不是 task 的属性） | 其 best-practice 明确反对「让 task 挂着干等」 |
| BullMQ 官方 `patterns/process-step-jobs` | `job.moveToDelayed(ts, token)` + `throw new DelayedError()`，让 job 在**运行时**自延 | ⚠️ 不增 `attemptsMade`，要用 `maxStartedAttempts` 控重试；📌 **该页未覆盖 flow 内的用法** ⇒ 端到端时序仍需一条真 Redis IT 实测，不能照搬 |

**明确排除的两条**：

1. **在 processor 里自己 sleep** —— 占着 worker 槽 + 撞 stalled 检查，业内反模式。
2. **改触发时刻** —— 调度界对**无依赖边**的任务群，标准解确实是 deterministic jitter（`hash(job_id) mod window`）；但一旦两者之间有 hard 边，改触发时刻就是把这条边拆掉。与既有 FR-015 立场一致，**FR-015 不用改**。

#### C. 测试分层（size 后缀 per testing.md §2 / §4）

| 层 | 文件 | size | 覆盖 |
| --- | --- | --- | --- |
| 判定等价 + 差分 | `option-anomaly.rules.spec.ts`（既有，追加） | Small `*.spec.ts` | 20 条既有单测零改写 + 新增「一次喂完 vs 切 N 批喂结论逐字段相同」（N ≥ 2 且至少一批跨越全域判据），`state_branches` 前 10 条 |
| 常驻结构 | 同上 | Small | 喂完的行不再被引用、样本集有固定上界、root 集基数与行数无关（FR-021 ①，确定性、每次回归都跑） |
| 实测内存 | 同上，`describe.skipIf` 门控 | Small（§2.1：默认路径不碰容器/外网） | FR-021 ②，钉 SC-001 / SC-003 |
| ~~flow 装配~~ 🚫 DEFERRED | ~~`sync-flow-assembler.spec.ts`（既有，追加）~~ | ~~Small~~ | ~~错开只挂在真包住上游的 parent 上、链根不带 delay、上界违反 throw，`state_branches` 后 6 条的可静态判部分~~ —— 随 §B deferred；该文件本片**零改动** |
| ~~真 Redis 时序~~ 🚫 DEFERRED | ~~新建 `*.it.spec.ts`~~ | ~~Medium~~ | ~~parent 起跑 − child 完成 ≥ delay，对照臂 delay=0；child 失败时传播不被延后~~ —— 该三臂**跑过了**，结果见 §B 证据包 C（臂 ③ 判红 ⇒ US2 降级）。它是**证伪证据**，不是本片验收面 |

- **env gate 复用既有的 `RUN_PERF_IT`**（已在 `scripts/checks/check-env-sync.ts` ALLOWLIST，行 72–73），不新造 flag 名 —— 新造要同时改 ALLOWLIST，且多一个没人记得开的旋钮。
- 🚨 **`--expose-gc` 在本仓零先例**（`rg 'expose-gc|global\.gc' apps/server` 无命中）。实测内存那条因此有一个**特有的失效形态**：拿不到 `global.gc` 时读数全是噪声，而测试**照样绿**。⇒ 该块要能区分「过」与「根本没跑」：`global.gc` 不可用时**显式 skip 并留可见输出**，绝不静默通过（testing.md §7「恒有输出 = 恒无输出」）。判据本身按 SC-001 写成**比值**（10× 行数 ⇒ 常驻增幅 < 2×）而非绝对字节，比值对机器差异鲁棒。
- **反例臂**：判定等价那层用 in-test 对照臂（翻输入，testing.md §7.1 默认形态）—— 把一批行故意留在累加器里，结构断言应当变红；差分测试把批大小设成 1 与设成全量，结论应当相同。两侧都能用输入构造，不需要 sabotage 臂。

#### D. task 切分意图（给 `/speckit-tasks`）

按「每条 30min–2h、可独立 commit、且各自能红」切：① 累加器 + 一次性入口薄封装（含差分与结构断言）② 实测内存块（env-gated）③ 调用侧改喂批（含懒创建与空轮语义）~~④ `assembleSyncFlow` 错开落点 + 上界 throw + 三调用方签名 ⑤ 真 Redis 时序 IT~~。①③ 之间有序（③ 依赖 ① 的接口）。

🚫 **④⑤ 于 2026-09-05 随 §B deferred**（对应 `tasks.md` 的 T005 / T006）。⇒ 本片实际落地的只有 ①②③（US1），加上零回归全量门与上线后观测口径两条收尾 task。

## Complexity Tracking

> 无 Constitution 违规，本段留空。
