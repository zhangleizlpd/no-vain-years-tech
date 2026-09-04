---
feature_id: 073-hk-option-two-round-collection
spec_ref: ./spec.md
plan_ref: ./plan.md
status: drafted
created_at: '2026-09-01'
updated_at: '2026-09-03'
---

# Tasks: 073-hk-option-two-round-collection（港股期权采集拆两轮 —— 报价轮前移到收盘直后，OI 轮独立排在定稿之后）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **母 issue**: [#308](https://github.com/zhangleizlpd/no-vain-years-tech/issues/308)

**病根一句话**：港股期权整轮采集排在**收盘 7 小时后**，而做市商盘口在收盘后是**阶梯式**撤走的 —— 采集时刻正落在最差的稳定台阶上，**收租召回集 45.2% 的腿拿不到买价**；同一批腿在收盘后那半小时只有 11.5% 缺价。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan §Dx; state_branches n; USn）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环（Constitution §II）；新测试必须证明「能红」（定向变异留档；rebase 后重做）。
- 层级：`[Server]` / `[Server-IT]` / `[Gate]` / `[Ops]` / `[Docs]`。**本片无 `[Mobile]` / `[Contract-Smoke]`** —— 契约零变化、前端零代码（plan §Summary 已逐项核过），这是结论不是遗漏。
- 🚨 **FR / SC 一律逐条枚举，禁范围记法**。

## Path Conventions

| 用途 | 路径 |
| --- | --- |
| 维度键登记 + executor 接线（改） | `apps/server/src/marketdata/dimension-executor.ts`（+ 同名 spec） |
| asOf 口径表（改一行） | `apps/server/src/marketdata/sync-asof.rules.ts`（+ 同名 spec） |
| 轮2 采集路径（**新建**） | `apps/server/src/marketdata/sync-option-oi-settle.usecase.ts`（+ 同名 spec） |
| 主轮行映射（**只读复用，禁另抄**） | `apps/server/src/marketdata/sync-option-snapshot.usecase.ts` |
| 两级补救退役（删两个 `@Cron`） | `apps/server/src/marketdata/option-snapshot-remediation.ts`（+ 同名 spec） |
| 覆盖率判据（**只读，不改阈值/口径**） | `apps/server/src/marketdata/option-snapshot-coverage.check.ts` |
| 抓价时刻越界常量 + 告警（新增单点） | `apps/server/src/marketdata/market-session.rules.ts`（+ 同名 spec） |
| OI 定稿判据（🚫 **本片禁改**） | 同上文件 `:176` / `:200` —— 归 #324 |
| migration（**新建**，data-only + seed） | `apps/server/prisma/migrations/<ts>_hk_option_two_round_collection/migration.sql` |
| Server IT（**新建**） | `apps/server/test/integration/marketdata-073.two-round.it.spec.ts` |
| 探针（已落，本片收口其结论） | `ops/bin/hk-option-post-close-probe.py` · `~/nvy-probe/iv-probe.py`（仓外） |
| 取证留档（local-only） | `docs/private/evidence/` · `docs/private/plans/2026-09/` |

## 🚨 Impl Guardrails（plan §Architecture Notes 摘录，盲写会踩且不会红）

1. **改 cron MUST 同 migration 置 `next_fire_at = NULL`**（plan §D1）—— 漏了的表现是「改动静默滞后一个周期」，`20260827_2112` 整条 migration 就是为补 `_1957` 漏掉的这一半而存在的。
2. **MUST NOT 给轮2 连依赖边**（plan §D2）—— 两端不同 tick，ADR-0049 §3 的边装不上，连了是一条**永远不生效却看起来像保证**的空话。裁决 MUST 写进 migration 注释。
3. **MUST NOT 在轮2 另抄一份 vendor 行 → DB 行映射**（plan §D3）—— 同 `ensure-latest-eod-bar.usecase.ts` 头部那条禁令，两份必漂。
4. **MUST NOT 让轮2 靠 cron 时刻推定「已定稿」**（plan §D3）—— 必须调 `oiRefreshedAtEod`。`option-snapshot-remediation.ts` 的 #187 注释记着他们正是从那个形态重构走的。
5. **MUST NOT 为轮2 新开 `source` 取值**（plan §D3）—— `market-session.rules.ts:160` 明文「OI 归属与 `source` 正交」；新开会让唯一键不再碰撞，重演 #306 的 555× 放大。
6. **段 a 的 UPDATE MUST 限定 `source = 'eod'`**（plan §Guardrail 1）—— 不限定会连美股仍在产的 `premarket_backfill` 行一起改。
7. **MUST NOT 删 `retrySameDay` / `backfillPremarket` 本身，也 MUST NOT 动美股两条 cron**（plan §D4）—— 退役的是港股两个触发点，不是机制。
8. **MUST NOT 改 `20260827_1957` 的注释**（plan §D9）—— 已应用的 migration 改注释会炸 Prisma checksum；更正走新 migration 的「沿革留痕」段。
9. **MUST NOT 改 `MARKET_OI_SETTLE_LOCAL_MINUTE`**（FR-015）—— 归 #324，本片只读。
10. **样本期 MUST 写明**（FR-020）—— 港股只有 1–2 个交易日、3 个探针标的。结论一律写「本样本期成立」，🚫 禁全称。

## Tasks

> **impl 期偏离登记（2026-09-01）**：**T001 + T004 + T006 落在同一个 commit**，不是疏忽。三者被两条机器不变式焊死：① `dimension-executor.ts` 的 `buildExecutors(): Record<DimensionKey, DimensionExecutorFn>` 是**穷举 Record** ⇒ 加了键不接线，typecheck 当场红；② `marketdata.sync-schema-gate.it.spec.ts` 断 `syncDimension.count() ≡ DIMENSION_KEYS.length` ⇒ 键与 seed 行必须同时到位。拆开提交必有一个中间态是红的（Constitution §III 的 atomic commit 要求「每 commit 可独立绿」，这里三者才构成一个可绿的最小单元）。
>
> 另：T001 的登记面**比原文多一处** —— `anchor-scoped-dimensions.rules.ts` 的 `ANCHOR_SCOPED_DIMENSIONS` 也必须登记。漏了不会红，表现是轮 2 的工作集变成**整个港股 universe**（港股 `needSync` 恒 true，该文件类注释粗体写着这个坑）。已一并补上并加断言。

- [X] T001 [Server] **新维度键登记 + asOf 口径**（FR-006; plan §D2; state_branches 6; US2）：`dimension-executor.ts` 的 `DIMENSION_KEYS` 加 `hk_option_oi_settle`；`sync-asof.rules.ts:63` 的 `AS_OF_BASIS_BY_DIMENSION` 加同键、取 `'last-completed-session'`（与 `:97` `hk_option_daily_snapshot` 同档 —— 21:40 求值落当日） → verify: `dimension-executor.spec.ts:133` 的 **`DIMENSION_KEYS` 值层全集断言先红**（这是本片 TDD 的第一个红）→ 补键 → 绿；`sync-asof.rules.spec.ts` 补一臂断言新键的口径，缺键时 TS 编译即失败（`Record<DimensionKey, …>` 穷举）

- [X] T002 [Server] **轮2 段 a：定向 UPDATE 三列 + 定稿判据闸**（FR-006, FR-007, FR-008, FR-011; plan §D3; state_branches 6/8; US2）：新建 `sync-option-oi-settle.usecase.ts`，取当前快照后对已存在的 `(contract_id, session_date, source='eod')` 行**只**写 `open_interest` / `net_open_interest` / `oi_as_of`；起手 MUST 调 `oiRefreshedAtEod(market, sessionDate, now)`，返 `false` ⇒ 整轮**跳过 OI 写入**、计 `skipped`、落结构化 ERROR 留痕 → verify: 同名 spec 四臂**先红后绿** ① 定稿为真 ⇒ 三列被更新且 `oi_as_of = session_date` ② 定稿为假 ⇒ 零写入 + 留痕 ③ UPDATE 的 where **含** `source='eod'`（构造一条 `premarket_backfill` 行，断言它未被触及，Guardrail 6）④ 报价列与 greeks 逐值不变；🚨 变异留档：把 `oiRefreshedAtEod` 调用注掉 ⇒ 臂 ② 必红

- [X] T002b [Ops] **探针判据 ⑫ 换模型：`oi_as_of` 不再是 `quote_as_of` 的函数**（impl 期新增，2026-09-01；plan 缺口）：`ops/jobs/marketdata-table-health.sql` 的判据 ⑫（#262）把应然 `oi_as_of` 从 `quote_as_of` 推导。两轮拆分后**报价列与 OI 列有了不同的写手和时刻**（主轮 16:20 写 `quote_as_of`、轮2 21:40 写 OI 三列且不碰 `quote_as_of`）⇒ 稳态行被逐行判红（约 1.8 万行/晚，且该探针跑在 app 进程外、有独立飞书通道）。改为「同日采集的行问**探针自己的时刻**：轮2 的时刻到了没」，跨日采集与美股两档逐字不变 → verify: 同名 IT 补三臂（两轮稳态 · 当天 / 两轮稳态 · 过去的场 / 🚨 轮2 静默没跑 ⇒ 判红）+ 改写两条因模型变更而翻面的既有臂；🚨 变异留档：把 CASE 退回旧模型 ⇒ 两条稳态臂**判红**（= 上线后每晚的假红，实证）且「轮2 没跑」**判绿**（= 旧模型对新故障模式零输出）；📌 谓词新增 `/* :probe_now */` 替换锚（体例同 `:avail_kb`）——「轮2 跑了没」这一档不钉时刻的话用例结果随跑测试的钟点漂；🚫 **不改 `marketdata-table-health.sh`**（它的铁律是只传观测值、零判断）

- [X] T003 [Server] **轮2 段 b：补漏行**（FR-009, FR-010; plan §D3; state_branches 7/11; US3）：对主轮整行缺失的合约，复用 `sync-option-snapshot.usecase.ts` 的行映射构造完整行，走 `createMany(skipDuplicates)`（`:476` 同款），`source` 落 `SNAPSHOT_SOURCE_EOD`（`:75`）→ verify: 同名 spec 三臂先红后绿 ① 主轮已写的合约**不被重写**（`quote_as_of` 逐值不变，幂等键挡住）② 主轮缺失的合约补出完整行 ③ 主轮整场零行 ⇒ 走全量兜底；🚨 **段 a 与段 b MUST 对不相交的合约集**（先查已存在集合再分流，Guardrail 2）—— 断言两段处理的 id 集合交集为空

- [X] T004 [Server] **轮2 接线到 executor**（FR-006; plan §D2; state_branches 6; US2）：`dimension-executor.ts` 按 `:1046` / `:1051` 同款注册 `hk_option_oi_settle` 的 `factExecutor` → verify: `dimension-executor.spec.ts` 注册表断言绿；`pnpm nx test server` 该文件全绿

- [X] T005 [Server-IT] **轮2 两段写的真库验证**（SC-003, SC-004, SC-007; plan §D3; state_branches 6/7/8; US2/US3）：新建 `marketdata-073.two-round.it.spec.ts`，Testcontainers 真库跑三臂 —— ① 主轮写行 → 轮2 → 三列更新且其余列**逐值不变**（逐字段对拍，不是抽查）② 主轮缺一批 → 轮2 补齐 ③ 定稿判据假 ⇒ 零写入 → verify: 三臂先红后绿；🚨 **MUST NOT 用 mock 顶替真库**（Testing Invariant 3 —— 「只改三列」这条只有真库能证）；执行走 `pnpm nx test server <file>`（🚫 禁 `vitest --root`，找不到 schema）；
  📌 **impl 期偏离登记（2026-09-01）**：① 文件**不是本 task 新建的** —— T006 已建（那条 migration 的断言要它），本 task 是在其中续一个嵌套 describe，共用同一个空库 + `migrate deploy`。② 三臂**首跑即绿**（被测实现是 T002/T003 已落地的）⇒ 不存在「先红」相位，「它能红」改由**定向变异**承担，三条各钉一臂：M4 段 a 的 `data` 多写一列 `bid` ⇒ 臂 ① 逐字段对拍判红（`轮2 改了它不该改的列: bid`，臂 ② 一并红）· M5 段 b 换成 `premarket_backfill` ⇒ 唯一键不再碰撞，库里 3 行变 **5 行**，臂 ② 判红（#306 那个 555× 放大形态的缩微版）· M6 注掉 `oiRefreshedAtEod` 闸 ⇒ 臂 ③ 判红。③ 维度行取**库里 migration 落的那一行**而不是手搓字面量；段 b 的执行体用**主轮 use case 的真实例**（Guardrail 3「不另抄一份行映射」只有真的调它才成立）。

- [X] T005b [Server-IT] **轮2 的两条边界臂**（state_branches 11; US3; Edge Case「无期权链的锚」/「锚集在两轮之间变化」）：在 T005 的 IT 文件续两臂 —— ① 无期权链的锚**不判红**（该类标的 IV 与期权链恒无值，与采集时刻无关）② 锚在主轮与轮2 之间新建 ⇒ 走「整行缺失」分支补全量 → verify: 两臂先红后绿；📌 **从 T005 拆出**（Constitution §III：五臂一条超 30min–2h 上界），两条 task 同文件、可连续提交；
  📌 **impl 期登记（2026-09-01）**：① 臂 ④ 的「不判红」**注了真的 `OptionSnapshotCoverageCheck`** —— 轮2 的 `coverage` 是可选构造参，不注就等于拿一个恒静默的判据断言「没告警」（空跑）。判据本体是覆盖率名册的口径 `instrument … optionContracts: { some: 未到期 }`：无链的票压根不进分母、也不进 absent 那一层。🚨 同时**先断报告非空**（`underlyings === ['hk:00700']`）—— 少了这句，报告落 `no_subject` 时断言同样绿，而「无链的票没被判红」根本没被证过；为此基线日（前一交易日）也铺了一份行。② 两臂同样**首跑即绿** ⇒ 「能红」由变异承担：M7 覆盖率名册去掉 `optionContracts` 过滤 ⇒ 无链票被判 degraded，臂 ④ 判红 · M8 停掉 `backfillMissingRows` 调用 ⇒ 新锚整条链补不出来，臂 ⑤（连同 T005 臂 ②）判红。⚠️ M8 首版写成 `if (false && …)` 会掐掉 TS 的类型收窄、整包 typecheck 先红（变异变成了编译错，证不了断言）—— 改用 `backfill.length > 999_999` 保住收窄。③ 顺带把 T005 的 `seedChain` / 端点替身参数化（`option_contract` 唯一键是 `(market, code)`，两只票必须各用各的词根；标的自身那行的 code 按被问的票派生，写死一个就成了「所有票共用一个 spot」，而 spot 是硬门 ④ 的输入）。

- [X] T006 [Server] **migration：三维度前移 16:20 + 轮2 seed + 沿革留痕**（FR-001, FR-002, FR-003, FR-004, FR-005, FR-012, FR-016; plan §D1/§D2/§D9; state_branches 1/2/3; US1）：新建 migration，data-only —— ① `UPDATE sync_dimension SET cron_expr='0 20 16 * * *'` for `hk_option_contract` / `hk_option_daily_snapshot`（IV 那行见 T009）② **同 migration** `SET next_fire_at = NULL`（Guardrail 1）③ `INSERT` 轮2 行：`cron_expr='0 40 21 * * *'` · `market_scope={hk}` · `vendor=futu` · `queue_lane=futu` · `priority=5` · `retry_max=3` · `history_depth=NULL` · `enabled=true` ④ 注释写明**为什么不连依赖边**（Guardrail 2）⑤ 注释写「沿革留痕：`20260827_1957` 的『港股零补救』前提已于 08-28（#265）失效；不改回 hard 的**结论仍成立**，理由改为『轮2 已承担补漏且档位严格更优』」（Guardrail 8）→ verify: `pnpm prisma migrate dev` 落地；`dimension-executor.spec.ts` 补一条**字典序相邻性**断言（`hk_option_contract` < `hk_option_daily_snapshot`，同 priority 下顺序由此保证，FR-002）；补一条**时刻在窗内**断言（16:20 落在 `[closeSettleBufferMinutes('hk') 解除, 台阶上界]` 内，FR-003/FR-004）；🚫 **不动** `20260827_1957`（Guardrail 8）

- [X] T007 [Server] **退役港股两级补救**（FR-013; plan §D4; state_branches 9/10; US3）：删 `option-snapshot-remediation.ts:225`（hk ① 23:40）与 `:231`（hk ② 08:30）两个 `@Cron` 方法；`retrySameDay` / `backfillPremarket` 本体与美股两条 cron（`:213` / `:219`）**一字不动**（Guardrail 7）→ verify: 同名 spec 先红后绿 —— ① 新断言「`option-snapshot-remediation` 上不存在任何 hk 触发点」② 既有**美股**补救测试全绿、逐值不变；🚨 清理由本 task 产生的 orphan（若 `retrySameDay('hk')` 后再无调用方，其 hk 分支的 dead code MUST 一并清；预先存在的 dead code 只 mention 不删）

- [X] T008 [Server] **告警一级制**（FR-014, FR-021; plan §D5; state_branches 9/10/12/13; US3）：轮2 跑完后跑一次 `OptionSnapshotCoverageCheck`（阈值 `:152` 与计数口径 `:205` **只读不改**），不达标 ⇒ **直接 ERROR**；删掉港股路径上「① 级只 WARN 挂着等 ②」那条阶梯的表达（`:326` 注释所述分支 —— 📌 impl 期实况：该阶梯在 `retrySameDay` 里是 **market 参数化**的，没有独立的 hk 分支；T007 删掉两个 hk 触发点之后港股路径已整体不存在，故此处**无代码可删**，「一级制」由轮2 收尾直接 ERROR 实现）；🚨 代码注释 MUST 写明「本 ERROR 当前无接收端（#209）」，否则下一个人以为报了就有人管 → verify: 同名 spec 四臂先红后绿 ① 达标 ⇒ 静默 ② 不达标 ⇒ ERROR（不是 WARN）③ 主轮成功 ∧ 轮2 失败 ⇒ 留痕不静默 ④ 两轮双失败 ⇒ ERROR（FR-021）

- [X] T009 [Server] **抓价时刻可观测 + 越界告警**（FR-022, SC-008; plan §D8; US1）：在 `market-session.rules.ts` 新增**单点**的 per-market「盘口台阶上界」常量（注释 MUST 写明它是**样本期结论**、不是物理常数，并写明重标条件 —— 同 `MARKET_OI_SETTLE_LOCAL_MINUTE` 的处理方式）；主轮结束后取本轮 `max(quote_as_of)` 折算交易所当地分钟，越界即告警 → verify: 同名 spec 三臂先红后绿 ① 落在台阶内 ⇒ 静默 ② 越界 ⇒ 告警 ③ **告警面与采集成败分离**（采集 `failed=0` 但越界仍告警）；🚨 SC-008 要求**造一次反例证明它能红**（人为放大工作集使抓价时刻越界）—— 由臂 ② 承载：同一段代码只多了两只标的（每只 = 一次端口调用 = 抓价时刻右移一格），16:26 静默 → 16:32 告警，证明的是「工作集长大 ⇒ 越界」这条**因果还连着**，而不是手填一个越界的时刻。
  📌 **impl 期三处定夺 / 偏离（2026-09-01）**：
  ① **上界取 16:30**（实测「仍好」的最后一格），user 定夺。起因是 spec 自身两处推论互斥 —— §193「余量约 3 倍」反解出 16:45、§229「约 50 个锚滑出」反解出约 16:35，而实测断点只知道落在 **盲区 (16:30, 16:45)**（网格 15 分钟）。取下界的理由写进常量注释：本表猜错的方向是**告警早报**（可判读），取 16:45 则是把一个**实测已坏**的档位当上界 —— 漏报恰是 FR-022 存在的理由。⚠️ 与 `MARKET_OI_SETTLE_LOCAL_MINUTE` 取**上界**刻意相反，共同纪律是「取猜错也不产生静默错误的那一侧」。稳态余量约 2 分钟，按每锚 18.5s 外推**约 35 个锚**开始报 —— 那是结论不是噪声，重标条件挂在 T012 的补样本上。
  ② **告警挂 `run()` 而非 `collect()`**：`collect` 还服务 ② 级盘前兜底与锚首建冷启动两条**非主轮**路径，它们的抓价时刻本就不在收盘台阶内，挂进 `collect` 等于每次假红。FR-022 盯的是主轮，而 `run` 是主轮唯一入口。
  ③ **ERROR + `notice` finding 双落**（user 定夺 ERROR 级）：日志只进容器 stdout（30MB 环、无投递）⇒ 只抬 ERROR 事后不可判（同 #261 取舍）。🚨 注释已写明本 ERROR 当前无接收端（#209）。
  📌 顺带收掉 **T006 欠的那条上界断言**（IT 里 `📌 随 T009 落地后补` 那处）；变异留档三条：M1 上界改 16:00 ⇒ 「静默」臂判红（证明它不是空跑）· M2 `max`→`min` ⇒ 两条告警臂零输出 · M3 上界改 16:10 ⇒ IT 窗口断言判红。M1 顺带暴露新块的**测试隔离缺陷**（断言抛出 ⇒ 行末 `mockRestore()` 不执行，`vi.spyOn` 对已 spy 方法返同一 mock ⇒ 下一例凭空多红），清理已挂 `afterEach`（与 T008 同款，全绿时完全不可见）；另给既有用例「hk 缺日历不抬 ERROR」显式喂一个台阶内的采集时刻，免被本告警串台（默认 `COLLECTED_AT` 是 us 常量，折成港股当地已是次日 12:31）。

- [X] T010 [Gate] **美股零变化**（FR-018, SC-005; state_branches 14）：不写新断言，跑既有美股面全量 —— `pnpm nx test server`（含 `option-snapshot-remediation.spec.ts` / `sync-option-snapshot.usecase.spec.ts` / `sync-asof.rules.spec.ts` / `market-session.rules.spec.ts`）→ verify: 全绿且**零测试被修改**（`git diff --stat` 对美股相关 spec 文件应为空）；🚨 Testing Invariant 4：美股零变化由**既有测试全绿**承担，MUST NOT 新写一条「美股没变」的断言；
  🚨 **验收线的字面判据不成立，已换成实质判据（2026-09-01）**：原文要求「`git diff --stat` 对美股相关 spec 文件应为空」，而本片**确实动了其中三个**（T007 / T009 / T001 各自的新臂都落在这些文件里）。⇒ 逐行取证换成「**零个既有美股断言被改写或删除**」，四个文件对 merge-base 的删除行合计 **4 条**，逐条归属：

  | 文件 | 增 | 删 | 删的是什么 |
  | --- | --- | --- | --- |
  | `market-session.rules.spec.ts` | +49 | 0 | —（T009 新 describe，只碰 hk 与 null 市场） |
  | `sync-asof.rules.spec.ts` | +4 | 0 | —（T001 新键一臂） |
  | `option-snapshot-remediation.spec.ts` | +76 | −1 | 一条 `describe` **标题改名**（加「073 起 hk 无触发点」后缀），断言体零改动 |
  | `sync-option-snapshot.usecase.spec.ts` | +139 | −3 | ① import 加 `afterEach` ② harness 的端点 `asOf` 由常量改成可选函数（**默认值不变**）③ 一条 **hk** 用例的夹具显式喂一个台阶内的采集时刻 |

  生产侧同查：本片改过的 8 个 server 文件里，`us` 的每一处出现都是**注释**或新表的 `us: null`；`option-snapshot-remediation.ts` 的非注释删除行**恰好**是两个 hk `@Cron` 方法（8 行），美股两条 cron 与`retrySameDay` / `backfillPremarket` 本体一字未动（Guardrail 7）。台阶告警对美股恒静默（`quoteLadderEndMinute('us') = null`，rules spec 有专臂钉），且盘前兜底那条路根本不传采集时刻收集器。
  → 全量：`nx run-many -t typecheck,lint,test -p server` **5812 passed / 0 failed**；四个美股面文件单独跑 **142 passed**。

- [X] T011 [Server-IT] **半日市与非交易日归属**（FR-019, SC-006; state_branches 2/4/5; US1-AS3）：在 T005 的 IT 文件补三臂 —— ① 半日市当天 16:20 ⇒ `sessionWatermark` 仍判**当日**、正常落库、零告警 ② 非交易日 ⇒ 主轮与轮2 均不触发 ③ 常规交易日 16:20 ⇒ 采集业务日 = 当日（state_branch 2 的正面） → verify: 三臂先红后绿；🚨 半日市那臂 MUST 用**真日历行**构造（`trading_day` + `calendar_coverage`），不许 mock 日历口径；
  📌 **impl 期登记（2026-09-01）**：① 🚨 **半日市那臂在 16:20 上判不出 half/whole** —— 两种收盘时刻（12:00 / 16:00）之下 16:20 都已过收盘，即便日历口径整个没接那一臂照样绿。⇒ 补了控制组 **⑥b**：hk 当地 **12:20**（`kind=half` ⇒ 已收+缓冲 ⇒ 可写；落 `unknown`/`whole` ⇒ 回落常规时段，而 12:20 正在**午休**里、`isSessionUnderway` 含午休 ⇒ 判「场内」⇒ 零落库）。**M9 实证**：把 `todaySessionKind` 钉死成 `unknown` ⇒ **只有 ⑥b 判红、⑥ 照绿** —— 原臂单独就是空跑，这条不是补充是必需。② 臂 ⑦「非交易日不触发」的落点**不在 use case** ——归属判据在周六照样返 `collect`（归到上一场）；真闸在 `SyncTickDriver.tradingDayGate`。本臂组合生产的两个单点（`resolveAsOfForDimension` → `isTradingDayGateOpen`）逐句同序，并配正向控制组（常规日必须**开**），防「覆盖声明缺失 ⇒ 全 non-trading」那种布景错冒充判据。**M10 实证**：把 `sessionWatermark` 改成恒退一天 ⇒ 周六 asOf 变周五、闸放行，臂 ⑦ 判红（连同 ①②③⑤⑥⑥b⑧ 共 8 条）—— 那正是「每个周末白烧一轮 vendor 配额且没有任何东西会红」。③ 日历端口在本组走**真** `DbTradingCalendarAdapter`（前两批用 `stubTradingCalendar`）；`calendar_coverage` 是承重的 ——缺它则三态落 `unknown`、闸 fail-open 放行（062 判据），臂 ⑦ 会红得像代码坏了。④ 布景坑留痕：`seedChain` 的到期日原写死 2026-09-18，而半日市那两臂在 12 月 ⇒ 工作集口径 `expiry_date >= session_date` 把整条链滤空，表现是「零落库」看着像归属判错。到期日已参数化并在注释里写明。

- [X] T012 [Ops] **探针补样本 + IV 定型结论收口**（FR-017, FR-020; plan §D6）：取回 2026-09-01 两条探针（`hk-iv-2026-09-01.jsonl` 网格 15:30→22:47 / `hk-post-close-2026-09-01.jsonl` 同 08-31 网格），并与生产 23:00 那轮写进 `marketdata.underlying_iv_daily` 的行对拍（**23:00 那个点白捡，不采**）；继续挂 09-02 / 09-03 / **09-04（到期周）** 三天 → verify: ① IV 逐格差异表落 `docs/private/plans/2026-09/`，结论「从哪一格起不再变」写进 spec `## Assumptions` ② 盘后曲线第 2–4 个交易日的台阶时刻与 08-31 对拍，一致/不一致都写明 ③ 🚨 **收尾必删 `~/nvy-probe`**，且 MUST 等原始件取回归档之后
  📌 **收口进度（2026-09-03）**：① 08-31 / 09-01 全部原始件已取回 `docs/private/evidence/073-hk-probe-raw/`；② verify ①② 均已落 `docs/private/plans/2026-09/09-03-073-t012-collection-verdict.md` 并回写 spec `## Assumptions`（IV 冻结自 16:02、`put_volume` 例外 16:32；22:47↔23:00 对拍 364 值全等；台阶结构三日一致、高度被订正）；③ **09-02 缺样**（两条探针均未挂，既成事实，spec 已写明）；④ 09-03 改挂 **22 标的扩样轮**（网格 15:29→23:10）——其 16:02 首平台 45.5% 与 prod 同日 16:28 落库 45.8% 交叉闭合（差 0.3pt），**3 标的外推被证伪**，SC-001/SC-001b 因此重标（user 裁决，见 spec SC 修订注记）；⑤ **09-04 到期日轮裁决不采**（user 定夺：唯一下游 T013 已被反例否决，失效兜底归 FR-022 告警 + 覆盖率 ERROR）。⏳ 剩余：09-03 原始件（23:10 跑完后）取回归档 → 删 `~/nvy-probe`（含当日散落的 09988 取证脚本）。
  📌 **收口完成（2026-09-04）**：09-03 扩样轮跑批干净（`run-0903.log` 末行「23:10: 落 18488 行 / 网格跑完」，0 error）；全部原始件 rsync 取回 `docs/private/evidence/073-hk-probe-raw/`（含 1.17 GB 主件，双端 md5 `e1fe1801…` 一致 + 名录 comm 零缺失），`~/nvy-probe` 已删（user 批准）。本 task 关闭，073 全部 task 完成。

- [X] ~~T013~~ **【不适用 —— 2026-09-03 判定，🚫 不删除，见下】** [Server] **（条件）IV 维度前移 —— 仅当 T012 证明其读数在 16:2x 已定型**（FR-017; plan §D6; state_branches 1）：把 `hk_underlying_iv_daily` 的 `cron_expr` 一并改 `'0 20 16 * * *'`，同 migration 置 `next_fire_at = NULL`。🚨 **并入还是另开取决于 T006 的 migration 应用了没有**：**未应用** ⇒ 可直接并入 T006 那条；**已在任何环境应用过** ⇒ MUST 另开一条 —— 改已应用的 migration 会炸 Prisma checksum（Guardrail 8 同源） → verify: 字典序相邻性断言扩到三键（`hk_option_contract` < `hk_option_daily_snapshot` < `hk_underlying_iv_daily`）；**未定型 ⇒ 本条标注「不适用」并写明理由，🚫 禁静默删除**；⚠️ 前移会让 FR-034 双算对表的 WARN 基线平移（阈值照 23:00 标定），MUST 观察一轮再决定要不要重标

  > **判定：不适用（2026-09-03）。** 触发条件是「T012 证明其读数在 16:2x 已定型」。实测相反 —— 09-01 IV 探针（28 标的 × 16 格，零 error）里 `put_volume` 在 16:22 仍在变、16:32 才冻结，而该维度写的是整行 13 个 vendor 字段（含成交量列）⇒ FR-017 要求的正向确认不成立，`hk_underlying_iv_daily` 保持 23:00。`iv` 本体 16:02 已冻结不足以放行。到期日补样随本判定一并取消（否决型判定一个反例即充分，user 裁决）。
  > 🚫 **不删除本条**：将来 vendor 改变盘后重算行为、或需要更早的盘后 IV 口径时，触发条件会重新成立 —— 以 `iv-probe.py` 同网格重测后再议（脚本随原始件归档于 `docs/private/evidence/073-hk-probe-raw/`）。

- [X] T014 [Ops] **上线后按验收线核一轮**（SC-001, SC-001b, SC-002; US1-AS1/AS2）：上线后取一个港股交易日，按**仓内正规召回口径**核 —— ① 收租召回集（`RENT_RECALL_DTE` × `RENT_DELTA_BAND`）有买价比例 ≥ 80% ② 建仓召回集（`BUILD_RECALL_DTE` × `BUILD_DELTA_BAND`）≥ 95% ③ 与改动前同批腿对拍，反向丢失条数 = 0 → verify: 三个数落 spec `## Assumptions`；🚨 口径 MUST 取仓内常量、**禁自造**（本片 clarify 期已因自造口径把验收线定成不可达，见 spec `## Clarifications`）
  📌 **收口登记（2026-09-03）**：三个数已落 spec `## Assumptions` §上线后验收 —— 判据日 09-03（16:28 抓价，**对收租带口径而言**的干净对照日；当日快照轮仍 `partial`、同一死码 502 照常复发，射程订正见 spec §上线后验收 上文的 2026-09-04 注记）：收租 **45.8%**、建仓 **77.7%**、反向丢失 **0** 条（探针 22 标的，19:00 对 16:02 逐腿比对）。🚨 **验收线经 user 裁决重标**（SC-001 80→40 / SC-001b 95→70）——原线出自 08-31 单日 3 标的外推，09-03 的 22 标的扩样 + prod 交叉验证（45.5% vs 45.8%，差 0.3pt）证明其在盘后**物理不可达**；本条原文里的 80% / 95% 字面保留作历史，现行线以 spec SC 修订注记为准。口径未自造：探针侧用 `band.py`（直抄 `leg-recall.rules.ts` / `leg-delta-surface.rules.ts` 带定义），prod 侧 SQL 同款复算。09-02（42.5% / 51.3%）受 #334 批级毒杀影响（推断；修复已合，并于 09-03 21:52 随 `server-v0.44.1` 部署 —— 晚于 09-03 判据日的 16:28 抓价）不作判据日。

- [X] T015 [Docs] **ADR-0047 消费注记 + spec 结论回写**（FR-020）：`docs/adr/0047-marketdata-pluggable-data-access.md` 补注记 —— 其 FR-046 两级补救在**港股半边**已由本片退役、改一级制，美股半边逐字不动；spec `## Assumptions` 的样本期段更新为最终样本天数 → verify: `pnpm tsx scripts/check-spec-frontmatters.ts` 绿；ADR 链接可达；
  🚨 **ADR 那一半的锚点是错的，且意图已被满足（2026-09-01 取证）**：`docs/adr/0047-*.md` 里 `FR-046` **零命中**、「两级补救」**零命中** —— 该 ADR 讲的是可插拔数据访问层（port/adapter/fallback），两级补救是 **`specs/047-optionsdesk-chain-leg-picker/spec.md`** 的需求条目，被 ADR 号与 spec 号同为 047 混在了一起。（ADR-0047 里唯一的 `remediation` 命中是 054 那条「dev 写手验证面由 `option-snapshot-remediation.it.spec.ts` 顶替」的注记，与两级结构无关且仍然成立。）
  ⇒ 🚫 **不在 ADR-0047 上编一条 Amendment**（那是无中生有）。本条的**意图**是「别让活文档还告诉读者港股有两级补救」，而它已由前面几条 task 覆盖，逐个 grep 实证：① `option-snapshot-remediation.ts` 的类注释 / `:220` 段已写明「港股两个触发点已于 073 退役、退役的是触发点不是机制」并配机械断言；② 073 新 migration 已带「沿革留痕」段；③ `marketdata.module.ts:658` 的两级注释如今逐字只描述**美股**那两档（08:00 / 18:00），本就正确；④ `option-snapshot-coverage.check.ts` 与 `ops/jobs/marketdata-snapshot-integrity.sql` 里的提法是通用的、对美股仍成立；⑤ `ops/runbook/scheduled-tasks.md` 两处提及均为泛指（POC 退役史 / dev mock 行为），无 hk 专属时刻。⇒ ADR 那一半判**不适用**，🚫 禁静默删除，理由留在此处。
  ✅ **剩余一半已收（2026-09-03）**：spec `## Assumptions` 样本期段已按最终样本定稿（盘后曲线 3 个交易日 + IV 1 个交易日；09-02 缺样、09-04 到期日轮裁决不采，均写明理由）⇒ 本 task 翻 `[X]`。ADR 半边此前已判不适用（见上），意图由前列 task 覆盖的取证不变。

- [X] T016 [Gate] **读侧扫描：确认无人假设「有 D 日期权快照 ⇒ 有 D 日日线」**（spec `## Assumptions · 已知代价 #2`）：主轮前移后，当日期权数据将比当日日线（22:00，理杏仁）**早约 5.7 小时**落库，顺序与改动前相反。采集侧 plan 期已验证零耦合（期权采集路径零 `daily_bar` 读取）；**读侧未穷尽扫描**，本 task 补上 —— 逐个 grep `daily_bar` / `dailyBar` 的消费方，确认没有哪一处依赖「两者同日到齐」→ verify: 扫描结果逐条落 PR body；命中即评估影响并起 follow-up issue，零命中也要**写明扫了哪些路径**（否则下一个人无从判断这条扫过没有）；📌 本条是 analyze 期抓出的零覆盖 —— spec 明写「列为实施时必扫项」而 tasks 原先无人承载；
  ✅ **扫描结果（2026-09-01）：零命中。** 结论可收敛成一句可证的话 —— **「有 D 日期权快照 ⇒ 有 D 日日线」这个假设在生产读侧无处可落，因为两份数据没有共同消费方。**

  **口径**：全仓 `rg 'dailyBar|daily_bar'` 命中 120 个文件，去掉 spec / docs / 测试 / migration / 生成物后，读写面 **19 个**（15 个 server 生产 TS + 3 个 ops 探针/报表 + 1 个 dev 同步脚本），逐个读过。

  | 分类 | 文件 | 判定 |
  | --- | --- | --- |
  | **期权侧零日线读** | `optionsdesk/**` 全模块 | 生产代码里 `daily_bar` 只出现 **2 行注释**（`sync-anchor-last-close.ts`，描述 ADR-0070 已退役的那条每小时投影）⇒ 唯一持有期权数据的 bounded context **一行日线都不读** |
  | **日线侧零期权读** | `alert/evaluate-alerts.usecase` · `alert-evaluation.rules` · `get-instrument-detail` · `get-instrument-bars` · `eod-backed-quote.adapter` · `anchor-factors` · `sync-universe` · `futu-eod-bar.adapter` · `ensure-latest-eod-bar` | 对 `optionDailySnapshot` / `optionContract` **零引用**（grep 实证）⇒ 无从假设同日到齐。📌 `anchor-factors.ts` 的「锚」是**复权因子锚**不是期权锚，别被名字骗过去 |
  | **两者都碰、逐个清掉** | `anchor-cold-start.usecase` / `.rules` | **日线已不在判据内**（#159 明写：「拿它当闸只会让『日线恰好没落上』误挡住真正要补的快照」）—— 本片担心的那个耦合，那次已经拆过 |
  | | `dimension-executor` · `marketdata-backfill.cli` · `sync-asof.rules` | 写侧 / 回填游标 / 口径表注释；日线只作**复权重建**的前置，与期权无跨表判据 |
  | **探针与报表** | `marketdata-table-health.sql` | 判据 ②（us 日线掉队）与 ⑧（us 期权快照掉队）是**两条独立的逐维度判据**，无合取；且都是 us 面，本片改的是 hk |
  | | `marketdata-sync-report.sh` · `app-state-health.sql` | 前者逐表行数、无跨表判断；后者只在**沿革注释**里提日线（ADR-0070 后上游已换人） |
  | **dev 同步脚本** | `marketdata-dev-sync/sync.sh` | **刻意解耦**：注释明写「不值得为它把 optionsdesk 的近窗绑到 `marketdata.daily_bar` 的交易日集合上」，两个窗口各走各的天数 |
  | **前端 / 契约** | `apps/mobile/**` · `packages/api-client` | 无任何文件同时消费日线与期权/锚（grep 实证）；e2e 契约种子只种日线、零期权 |

  **另核**：`sync_dependency` 全部 migration 里**零条边牵涉 `eod_bar`**（期权维度的上游只有 `universe` 与 `hk_option_contract`）⇒ 采集侧的解耦不只是「路径上没读」，是**编排层也没连**。全仓亦无 SQL VIEW（`CREATE VIEW` 零命中），不存在藏在视图里的 join。

  🚨 **扫描边界（写明，否则下一个人无从判断扫过没有）**：本次只扫 **main 可达**的代码。冻结在未合分支 `048-optionsdesk-radar-aggregate-views` 上的聚合视图**不在扫描面内** —— 该分支上 `sync-anchor-quote.ts` （`daily_bar` 每小时投影）仍在，而 main 已由 ADR-0070 换成同源实时写手 ⇒ **048 解冻时必须重扫这一格**，且它要解决的是「与 main 的 stale 冲突」，不是本片引入的新耦合。⇒ 零命中，**不起 follow-up issue**；边界这条随 PR body 一起交待。

- [X] T017 [Gate] **PR 门**：`pnpm nx affected -t lint,typecheck,test,build` 全绿 + 治理脚本全扫 → verify: 按终态串判定，**不只看 exit code**；PR body 按 `.github/pull_request_template.md` 全段复刻，hard-gate 三 checkbox 核实落地；
  🚨 **核 checkbox ③ 时抓出一个真缺口，已当场补掉（2026-09-01，user 定夺「先补再开 PR」）**：14 条 `state_branches` 里 **9 / 10 / 12 / 13**（告警一级制四态）此前**只有 unit 覆盖**（`sync-option-oi-settle.usecase.spec.ts` 的 T008 四臂，mock prisma + 注入 coverage），而 checkbox 与 spec schema 注释都写的是 **integration test**。ADR-0040 不信 unit-only 的理由正落在这里：覆盖率判据的分母来自「基线日那批行 ⋈ 当日行」**两趟真 SQL**，mock 里那两趟是被测方自己编的答案 ⇒ 「达标 / 不达标」由夹具决定而不是由库里的行决定。⇒ 073 IT 续 4 臂（13 → 17 → **21**）。两处判据面因此被真库钉住：① 缺口**必须落在工作集之外**的票上才构造得出「轮2 之后仍不达标」——落在工作集内会被段 b 当场补掉（那正是轮2 存在的意义）；② `state_branch 12` 证的是**覆盖率判据在那一格是瞎的**（行全在 ⇒ 它照判 ok），这就是「两条 ERROR 各管一件事、MUST NOT 合并」的机器证明。
  变异留档三条：**M11** `alertIfDegraded` 的 ERROR 降 WARN ⇒ sb 10 / 13 判红（「是 ERROR 不是 WARN」）· **M12** 停掉 `stats.failed > 0` 那条 ERROR ⇒ sb 12 / 13 判红（证第一条不冗余）· **M13** 删 `status !== 'degraded'` 守卫改恒告警 ⇒ 三条「断言**没有**告警」的臂判红（④ / sb 9 / sb 12）。⚠️ M13 首版写成比对一个不存在的 status 字面量，被 TS2367 挡住 —— **变异变成编译错就证不了断言**，与 T005b 的 M8 同一形态、本片第二次踩。
  🚨 **M13 顺带照出本 IT 文件的测试隔离缺陷**（断言抛出 ⇒ 行末 `mockRestore()` 不执行 ⇒ `vi.spyOn` 返同一 mock ⇒ 下一例带历史、失败级联、变异不可归因）：修前 M13 红 6 条、修后红 3 条，中间三条全是污染。清理已挂 `afterEach`。**同一形态在 073 内第三次**（T008 / T009 / 本条）⇒ 新写 spy 块一律先挂 `afterEach`，别用行末 restore。
  → 门的终态串：`nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache` **Successfully ran targets … for 4 projects**（5816 passed / 0 failed）；`scripts/checks/*.ts` 全扫 **18 ✅ / 0 ❌**；`check-commit-msg-parseable --range origin/main..HEAD` ✅（18 条）。

## 依赖与并行

```text
T001 ─┬─> T002 ─┬─> T004 ──> T005 ──> T005b ──> T011
      └─> T003 ─┘                                │
T006 ─────────────────────────────────────────>  │  (migration 与代码可并行开发, IT 需两者都在)
T007 [P] ────────────────────────────────────────┤
T008 ────────────────────────────────────────────┤
T009 [P] ────────────────────────────────────────┘
T012 (Ops, 全程并行) ──> T013 (条件)
T005b + T011 + T010 ──> T014 (上线后) ──> T015 ──> T016 (读侧扫描) ──> T017 (PR 门)
```

- **可并行**：T007（补救退役，独立文件）· T009（越界告警，独立文件）· T012（探针，仓外）
- **串行硬点**：T001 → T002/T003（键不在，TS 编译不过）；T004 → T005（未接线跑不起来）；T013 依赖 T012 的结论

## state_branches 覆盖预检（analyze 期逐条 grep 的基准）

| # | state_branch 摘要 | 落在 |
| --- | --- | --- |
| 1 | 三维度同一拍，链发现先于快照 | T006（+ T013 条件扩到三键） |
| 2 | 采集业务日解析为当日 | T006 · T011 ③ |
| 3 | 主轮时刻早于闸解除 ⇒ 不写 | T006（时刻在窗内断言） |
| 4 | 半日市仍判当日 | T011 ① |
| 5 | 非交易日不触发 | T011 ② |
| 6 | 轮2 已写行 ⇒ 只更新三列 | T002 · T005 ① |
| 7 | 轮2 整行缺失 ⇒ 补行 | T003 · T005 ② |
| 8 | 定稿判据假 ⇒ 跳过留痕 | T002 ② · T005 ③ |
| 9 | 覆盖率达标 ⇒ 静默 | T008 ① · **T017 补 IT** |
| 10 | 覆盖率不达标 ⇒ ERROR | T008 ② · **T017 补 IT** |
| 11 | 主轮失败 ∧ 轮2 成功 ⇒ 全量兜底 | T003 ③ |
| 12 | 主轮成功 ∧ 轮2 失败 ⇒ 留痕 | T008 ③ · **T017 补 IT** |
| 13 | 双失败 ⇒ ERROR | T008 ④ · **T017 补 IT** |
| 14 | 美股逐值零变化 | T010 |

**零覆盖：无。**

## Success Criteria 覆盖预检（🚨 SC 是系统性盲区，单列一张）

| SC | 落在 | 备注 |
| --- | --- | --- |
| SC-001（收租 ≥80%） | **T014** | 上线后真数据核，非单测可及 |
| SC-001b（建仓 ≥95%） | **T014** | 同上 |
| SC-002（超集，反向丢失 0） | **T014** | 样本期已实证（529 / 0），上线后同法复核 |
| SC-003（OI 口径日错标 0 行） | T005 ① | |
| SC-004（报价/greeks 被改写 0 行） | T005 ① | 逐字段对拍 |
| SC-005（美股差异 0 行） | T010 | |
| SC-006（半日市错误归属 0 行） | T011 ① | |
| SC-007（缺口补齐 + 双失败告警 100%） | T005 ② · T008 ④ | |
| SC-008（抓价时刻越界告警 100%） | T009 | 🚨 要求造反例证明能红 |

**零覆盖：无。** 📌 SC-001 / SC-001b / SC-002 三条**刻意落在 `[Ops]` 而非单测** —— 它们量的是真实市场盘口，单测里造出来的数只能证明算式对、证明不了验收线。

## Edge Case 覆盖预检（标准矩阵扫得到，但零覆盖必须写明「蓄意」）

| Edge Case | 落在 |
| --- | --- |
| 主轮时刻网关不可用 | T008 ④ |
| 撤单早于主轮时刻 | **蓄意零 impl 覆盖** —— 它是 spec 显式接受的残余风险（断点分钟在网格盲区内），缓解由 T003 的补漏 + T009 的越界告警承担，**不为它写断言** |
| 主轮跑得比预期久 | T009 |
| 当日盘中新挂牌的行权价 | T006（链发现在主轮内、先于快照） |
| 锚集在两轮之间变化 | T005b ② |
| 有人把轮2 时刻改到定稿之前 | T002 ② · T005 ③ |
| 无期权链的锚 | T005b ① |

## Acceptance Scenario 覆盖预检（🚨 标准矩阵**够不到**这一层，046 曾两轮全漏）

| AS | 落在 |
| --- | --- |
| US1-AS1 收租/建仓召回集达各自验收线 | T014 ①② |
| US1-AS2 有买价的腿是改动前的超集 | T014 ③ |
| US1-AS3 半日市归属正确且零告警 | T011 ① |
| US2-AS1 轮2 后 OI 与口径日双双更新 | T005 ① |
| US2-AS2 报价/greeks 逐值不变 | T005 ① |
| US2-AS3 定稿判据假 ⇒ 跳过并留痕 | T005 ③ |
| US3-AS1 主轮缺失 ⇒ 轮2 补齐 | T005 ② |
| US3-AS2 主轮已写 ⇒ 不被重写 | T003 ① |
| US3-AS3 覆盖率仍不达标 ⇒ 直接 ERROR | T008 ② |

**零覆盖：无。**

## Assumptions·已知代价 覆盖预检（🚨 标准矩阵**够不到**这一层 —— C1 就是从这里漏掉的）

标准三矩阵扫的是 `state_branches` / Edge Case / SC，**不含 `## Assumptions` 里的「已知代价」**。而已知代价里可以躺着**实施义务**（本片第 2 条就明写「列为实施时必扫项」），零覆盖且零告警。故单列。

| # | 已知代价 | 落在 |
| --- | --- | --- |
| 1 | 半日市约 5 天/年无收益 | T011 ① |
| 2 | 落库顺序反转 → **读侧必扫** | **T016**（analyze 期抓出的零覆盖，原先无人承载） |
| 3 | 告警今天仍无接收端（#209） | T008（代码注释 MUST 写明） |
| 4 | 重试深度 3 → 2 | T008 ④ |

**零覆盖：无。**

## 蓄意零覆盖登记（写明「故意的」，否则下轮 analyze 会补假 task）

| 项 | 为什么零覆盖是对的 |
| --- | --- |
| plan **§D7**（与 ADR-0070 时序相容） | 它是一条**已核过、无需动作**的结论：#325 首拍 16:10 早于主轮，且已核 `hk` 收盘缓冲仍为 10。核过即完成，不产出代码行 ⇒ 不该有 task |
| **T017**（PR 门）未挂 FR/SC | 流程闸，不映射任何需求。它验的是「门全绿」，不是某条 FR |
| Edge Case「撤单早于主轮时刻」 | spec 显式接受的残余风险（断点分钟在网格盲区内）。缓解由 T003 补漏 + T009 越界告警承担，**不为它写断言** |

## Implementation Strategy

**MVP = US1（T001–T006 + T010）** —— 只做主轮前移就已交付本片 91% 的用户价值（收租 54.8% → 88.5%）。此时 OI 退到隔日口径，是**已知且可接受**的中间态。

**增量顺序**：
1. **US2（T002/T003/T004/T005）** 把 OI 接回当日口径 —— 它是主轮前移的**必然债**，MUST 同 PR 交付，不许留到下一片。
2. **US3（T007/T008）** 补救链收敛 —— 依赖轮2 已能补漏，故必须在 US2 之后。
3. **T009 / T012 / T013 / T014** 观测面与取证收口。

🚨 **单 PR 原子交付**（Constitution §V）：US1 单独上线会留下「OI 标签错一天且不会红」的窗口，因此 US1+US2+US3 **同 PR**。MVP 的意义在于**实现顺序**与出问题时的回退落点，不是分批 ship。
