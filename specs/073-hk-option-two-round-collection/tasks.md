---
feature_id: 073-hk-option-two-round-collection
spec_ref: ./spec.md
plan_ref: ./plan.md
status: drafted
created_at: '2026-09-01'
updated_at: '2026-09-01'
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

- [ ] T001 [Server] **新维度键登记 + asOf 口径**（FR-006; plan §D2; state_branches 6; US2）：`dimension-executor.ts` 的 `DIMENSION_KEYS` 加 `hk_option_oi_settle`；`sync-asof.rules.ts:63` 的 `AS_OF_BASIS_BY_DIMENSION` 加同键、取 `'last-completed-session'`（与 `:97` `hk_option_daily_snapshot` 同档 —— 21:40 求值落当日） → verify: `dimension-executor.spec.ts:133` 的 **`DIMENSION_KEYS` 值层全集断言先红**（这是本片 TDD 的第一个红）→ 补键 → 绿；`sync-asof.rules.spec.ts` 补一臂断言新键的口径，缺键时 TS 编译即失败（`Record<DimensionKey, …>` 穷举）

- [ ] T002 [Server] **轮2 段 a：定向 UPDATE 三列 + 定稿判据闸**（FR-006, FR-007, FR-008, FR-011; plan §D3; state_branches 6/8; US2）：新建 `sync-option-oi-settle.usecase.ts`，取当前快照后对已存在的 `(contract_id, session_date, source='eod')` 行**只**写 `open_interest` / `net_open_interest` / `oi_as_of`；起手 MUST 调 `oiRefreshedAtEod(market, sessionDate, now)`，返 `false` ⇒ 整轮**跳过 OI 写入**、计 `skipped`、落结构化 ERROR 留痕 → verify: 同名 spec 四臂**先红后绿** ① 定稿为真 ⇒ 三列被更新且 `oi_as_of = session_date` ② 定稿为假 ⇒ 零写入 + 留痕 ③ UPDATE 的 where **含** `source='eod'`（构造一条 `premarket_backfill` 行，断言它未被触及，Guardrail 6）④ 报价列与 greeks 逐值不变；🚨 变异留档：把 `oiRefreshedAtEod` 调用注掉 ⇒ 臂 ② 必红

- [ ] T003 [Server] **轮2 段 b：补漏行**（FR-009, FR-010; plan §D3; state_branches 7/11; US3）：对主轮整行缺失的合约，复用 `sync-option-snapshot.usecase.ts` 的行映射构造完整行，走 `createMany(skipDuplicates)`（`:476` 同款），`source` 落 `SNAPSHOT_SOURCE_EOD`（`:75`）→ verify: 同名 spec 三臂先红后绿 ① 主轮已写的合约**不被重写**（`quote_as_of` 逐值不变，幂等键挡住）② 主轮缺失的合约补出完整行 ③ 主轮整场零行 ⇒ 走全量兜底；🚨 **段 a 与段 b MUST 对不相交的合约集**（先查已存在集合再分流，Guardrail 2）—— 断言两段处理的 id 集合交集为空

- [ ] T004 [Server] **轮2 接线到 executor**（FR-006; plan §D2; state_branches 6; US2）：`dimension-executor.ts` 按 `:1046` / `:1051` 同款注册 `hk_option_oi_settle` 的 `factExecutor` → verify: `dimension-executor.spec.ts` 注册表断言绿；`pnpm nx test server` 该文件全绿

- [ ] T005 [Server-IT] **轮2 两段写的真库验证**（SC-003, SC-004, SC-007; plan §D3; state_branches 6/7/8/11; US2/US3）：新建 `marketdata-073.two-round.it.spec.ts`，Testcontainers 真库跑五臂 —— ① 主轮写行 → 轮2 → 三列更新且其余列**逐值不变**（逐字段对拍，不是抽查）② 主轮缺一批 → 轮2 补齐 ③ 定稿判据假 ⇒ 零写入 ④ 无期权链的锚**不判红**（Edge Case 7）⑤ 锚在两轮之间新建 ⇒ 走整行缺失分支 → verify: 五臂先红后绿；🚨 **MUST NOT 用 mock 顶替真库**（Testing Invariant 3 —— 「只改三列」这条只有真库能证）；执行走 `pnpm nx test server <file>`（🚫 禁 `vitest --root`，找不到 schema）

- [ ] T006 [Server] **migration：三维度前移 16:20 + 轮2 seed + 沿革留痕**（FR-001, FR-002, FR-003, FR-004, FR-005, FR-012, FR-016; plan §D1/§D2/§D9; state_branches 1/2/3; US1）：新建 migration，data-only —— ① `UPDATE sync_dimension SET cron_expr='0 20 16 * * *'` for `hk_option_contract` / `hk_option_daily_snapshot`（IV 那行见 T009）② **同 migration** `SET next_fire_at = NULL`（Guardrail 1）③ `INSERT` 轮2 行：`cron_expr='0 40 21 * * *'` · `market_scope={hk}` · `vendor=futu` · `queue_lane=futu` · `priority=5` · `retry_max=3` · `history_depth=NULL` · `enabled=true` ④ 注释写明**为什么不连依赖边**（Guardrail 2）⑤ 注释写「沿革留痕：`20260827_1957` 的『港股零补救』前提已于 08-28（#265）失效；不改回 hard 的**结论仍成立**，理由改为『轮2 已承担补漏且档位严格更优』」（Guardrail 8）→ verify: `pnpm prisma migrate dev` 落地；`dimension-executor.spec.ts` 补一条**字典序相邻性**断言（`hk_option_contract` < `hk_option_daily_snapshot`，同 priority 下顺序由此保证，FR-002）；补一条**时刻在窗内**断言（16:20 落在 `[closeSettleBufferMinutes('hk') 解除, 台阶上界]` 内，FR-003/FR-004）；🚫 **不动** `20260827_1957`（Guardrail 8）

- [ ] T007 [Server] **退役港股两级补救**（FR-013; plan §D4; state_branches 9/10; US3）：删 `option-snapshot-remediation.ts:225`（hk ① 23:40）与 `:231`（hk ② 08:30）两个 `@Cron` 方法；`retrySameDay` / `backfillPremarket` 本体与美股两条 cron（`:213` / `:219`）**一字不动**（Guardrail 7）→ verify: 同名 spec 先红后绿 —— ① 新断言「`option-snapshot-remediation` 上不存在任何 hk 触发点」② 既有**美股**补救测试全绿、逐值不变；🚨 清理由本 task 产生的 orphan（若 `retrySameDay('hk')` 后再无调用方，其 hk 分支的 dead code MUST 一并清；预先存在的 dead code 只 mention 不删）

- [ ] T008 [Server] **告警一级制**（FR-014, FR-021; plan §D5; state_branches 9/10/12/13; US3）：轮2 跑完后跑一次 `OptionSnapshotCoverageCheck`（阈值 `:152` 与计数口径 `:205` **只读不改**），不达标 ⇒ **直接 ERROR**；删掉港股路径上「① 级只 WARN 挂着等 ②」那条阶梯的表达（`:326` 注释所述分支）；🚨 代码注释 MUST 写明「本 ERROR 当前无接收端（#209）」，否则下一个人以为报了就有人管 → verify: 同名 spec 四臂先红后绿 ① 达标 ⇒ 静默 ② 不达标 ⇒ ERROR（不是 WARN）③ 主轮成功 ∧ 轮2 失败 ⇒ 留痕不静默 ④ 两轮双失败 ⇒ ERROR（FR-021）

- [ ] T009 [Server] **抓价时刻可观测 + 越界告警**（FR-022, SC-008; plan §D8; US1）：在 `market-session.rules.ts` 新增**单点**的 per-market「盘口台阶上界」常量（注释 MUST 写明它是**样本期结论**、不是物理常数，并写明重标条件 —— 同 `MARKET_OI_SETTLE_LOCAL_MINUTE` 的处理方式）；主轮结束后取本轮 `max(quote_as_of)` 折算交易所当地分钟，越界即告警 → verify: 同名 spec 三臂先红后绿 ① 落在台阶内 ⇒ 静默 ② 越界 ⇒ 告警 ③ **告警面与采集成败分离**（采集 `failed=0` 但越界仍告警）；🚨 SC-008 要求**造一次反例证明它能红**（人为放大工作集使抓价时刻越界）

- [ ] T010 [Gate] **美股零变化**（FR-018, SC-005; state_branches 14）：不写新断言，跑既有美股面全量 —— `pnpm nx test server`（含 `option-snapshot-remediation.spec.ts` / `sync-option-snapshot.usecase.spec.ts` / `sync-asof.rules.spec.ts` / `market-session.rules.spec.ts`）→ verify: 全绿且**零测试被修改**（`git diff --stat` 对美股相关 spec 文件应为空）；🚨 Testing Invariant 4：美股零变化由**既有测试全绿**承担，MUST NOT 新写一条「美股没变」的断言

- [ ] T011 [Server-IT] **半日市与非交易日归属**（FR-019, SC-006; state_branches 2/4/5; US1-AS3）：在 T005 的 IT 文件补三臂 —— ① 半日市当天 16:20 ⇒ `sessionWatermark` 仍判**当日**、正常落库、零告警 ② 非交易日 ⇒ 主轮与轮2 均不触发 ③ 常规交易日 16:20 ⇒ 采集业务日 = 当日（state_branch 2 的正面） → verify: 三臂先红后绿；🚨 半日市那臂 MUST 用**真日历行**构造（`trading_day` + `calendar_coverage`），不许 mock 日历口径

- [ ] T012 [Ops] **探针补样本 + IV 定型结论收口**（FR-017, FR-020; plan §D6）：取回 2026-09-01 两条探针（`hk-iv-2026-09-01.jsonl` 网格 15:30→22:47 / `hk-post-close-2026-09-01.jsonl` 同 08-31 网格），并与生产 23:00 那轮写进 `marketdata.underlying_iv_daily` 的行对拍（**23:00 那个点白捡，不采**）；继续挂 09-02 / 09-03 / **09-04（到期周）** 三天 → verify: ① IV 逐格差异表落 `docs/private/plans/2026-09/`，结论「从哪一格起不再变」写进 spec `## Assumptions` ② 盘后曲线第 2–4 个交易日的台阶时刻与 08-31 对拍，一致/不一致都写明 ③ 🚨 **收尾必删 `~/nvy-probe`**，且 MUST 等原始件取回归档之后

- [ ] T013 [Server] **（条件）IV 维度前移 —— 仅当 T012 证明其读数在 16:2x 已定型**（FR-017; plan §D6; state_branches 1）：把 `hk_underlying_iv_daily` 的 `cron_expr` 一并改 `'0 20 16 * * *'`（并入 T006 的 migration 或另开一条），同 migration 置 `next_fire_at = NULL` → verify: 字典序相邻性断言扩到三键（`hk_option_contract` < `hk_option_daily_snapshot` < `hk_underlying_iv_daily`）；**未定型 ⇒ 本条标注「不适用」并写明理由，🚫 禁静默删除**；⚠️ 前移会让 FR-034 双算对表的 WARN 基线平移（阈值照 23:00 标定），MUST 观察一轮再决定要不要重标

- [ ] T014 [Ops] **上线后按验收线核一轮**（SC-001, SC-001b, SC-002; US1-AS1/AS2）：上线后取一个港股交易日，按**仓内正规召回口径**核 —— ① 收租召回集（`RENT_RECALL_DTE` × `RENT_DELTA_BAND`）有买价比例 ≥ 80% ② 建仓召回集（`BUILD_RECALL_DTE` × `BUILD_DELTA_BAND`）≥ 95% ③ 与改动前同批腿对拍，反向丢失条数 = 0 → verify: 三个数落 spec `## Assumptions`；🚨 口径 MUST 取仓内常量、**禁自造**（本片 clarify 期已因自造口径把验收线定成不可达，见 spec `## Clarifications`）

- [ ] T015 [Docs] **ADR-0047 消费注记 + spec 结论回写**（FR-020）：`docs/adr/0047-marketdata-pluggable-data-access.md` 补注记 —— 其 FR-046 两级补救在**港股半边**已由本片退役、改一级制，美股半边逐字不动；spec `## Assumptions` 的样本期段更新为最终样本天数 → verify: `pnpm tsx scripts/check-spec-frontmatters.ts` 绿；ADR 链接可达

- [ ] T016 [Gate] **PR 门**：`pnpm nx affected -t lint,typecheck,test,build` 全绿 + 治理脚本全扫 → verify: 按终态串判定，**不只看 exit code**；PR body 按 `.github/pull_request_template.md` 全段复刻，hard-gate 三 checkbox 核实落地

## 依赖与并行

```text
T001 ─┬─> T002 ─┬─> T004 ──> T005 ──> T011
      └─> T003 ─┘                      │
T006 ────────────────────────────────> │  (migration 与代码可并行开发, IT 需两者都在)
T007 [P] ──────────────────────────────┤
T008 ──────────────────────────────────┤
T009 [P] ──────────────────────────────┘
T012 (Ops, 全程并行) ──> T013 (条件)
T005 + T011 + T010 ──> T014 (上线后) ──> T015 ──> T016
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
| 9 | 覆盖率达标 ⇒ 静默 | T008 ① |
| 10 | 覆盖率不达标 ⇒ ERROR | T008 ② |
| 11 | 主轮失败 ∧ 轮2 成功 ⇒ 全量兜底 | T003 ③ |
| 12 | 主轮成功 ∧ 轮2 失败 ⇒ 留痕 | T008 ③ |
| 13 | 双失败 ⇒ ERROR | T008 ④ |
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
| 锚集在两轮之间变化 | T005 ⑤ |
| 有人把轮2 时刻改到定稿之前 | T002 ② · T005 ③ |
| 无期权链的锚 | T005 ④ |

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

## Implementation Strategy

**MVP = US1（T001–T006 + T010）** —— 只做主轮前移就已交付本片 91% 的用户价值（收租 54.8% → 88.5%）。此时 OI 退到隔日口径，是**已知且可接受**的中间态。

**增量顺序**：
1. **US2（T002/T003/T004/T005）** 把 OI 接回当日口径 —— 它是主轮前移的**必然债**，MUST 同 PR 交付，不许留到下一片。
2. **US3（T007/T008）** 补救链收敛 —— 依赖轮2 已能补漏，故必须在 US2 之后。
3. **T009 / T012 / T013 / T014** 观测面与取证收口。

🚨 **单 PR 原子交付**（Constitution §V）：US1 单独上线会留下「OI 标签错一天且不会红」的窗口，因此 US1+US2+US3 **同 PR**。MVP 的意义在于**实现顺序**与出问题时的回退落点，不是分批 ship。
