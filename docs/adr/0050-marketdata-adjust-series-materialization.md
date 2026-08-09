---
adr_id: ADR-0050
status: Superseded
applies_to: [apps/server]
sunset_trigger: |
  - daily_bar 存储/备份成为真实压力（盘水位 > 70% 或 pg_dump 时长影响运维窗口）→ 重审切「none + 因子读时算」（本 ADR 备选 C）
  - K线读路径大改（缓存层 / 列存 / 聚合下沉）时 → 顺势重审物化形态，C 的读时换算可随改动一并落地
  - 出现 point-in-time 复权消费方（回测引擎防未来函数）→ 物化前复权天然带 look-ahead，必须按时点因子动态计算，触发 C
---

# ADR-0050: Marketdata 复权序列物化策略 — 三口径全物化，否决读时换算与中间态

- Status: Superseded (2026-06-05，by [ADR-0051](0051-marketdata-adjust-on-read.md))

> **⚠️ Superseded（2026-06-05 同日）**：本 ADR 定格策略 B 后，同日三个新输入翻转权衡（决策者重审 §14.4 调研后主动直迁主流终局 / #348 lookback 全窗重写实证加重 B 的除权日代价 / 选 B 三条理由在 020 设计中逐条有解）→ [ADR-0051](0051-marketdata-adjust-on-read.md) 定格策略 C（只存 none + 累积 backward 因子，读时换算），实施载体 = [020-marketdata-adjust-on-read](../../specs/020-marketdata-adjust-on-read/spec.md)。本篇保留作 B/C 权衡的完整历史 rationale（业界调研 References 仍有效），不再 in-place 改决策本身（per [ADR-0031](0031-adr-governance.md) supersede-not-delete）。

- Status(原): Accepted (2026-06-05)
- Deciders: @zhangleizlpd
- Tags: server / market-data / storage / data-architecture
- Relates: [ADR-0047](0047-marketdata-pluggable-data-access.md)（口径敏感维度 fail-or-flag）/ [ADR-0049](0049-marketdata-scheduler-bullmq-hybrid.md)（调度体系）；019 plan D1-D3（因子比值锚定 / 除权命中检查 / vendor 重拉）；[06-04-marketdata-sync-strategy-design §14](../private/plans/2026-06/06-04-marketdata-sync-strategy-design.md)（prod 首跑实测）

## Context

`forward/backward = none × 复权因子链`，数学上是派生冗余——019 因子版本化（#341）后本地即可换算，「存不存派生口径」成为独立决策点。prod 首跑实测（2026-06-04，设计 doc §14）：daily_bar 4.97M 行 / 1.1GB，其中 forward/backward 占 99.7%。

业界调研（2026-06-05 联网，来源见 References）：

1. **行情展示的事实口径 = 前复权**（同花顺/东财/通达信/富途均可三口径切换，教程与设置普遍引导前复权；后复权几乎只用于回测/收益归因）。
2. **量化平台主流 = 存不复权价 + 复权因子，读时动态算**（Tushare 文档明示「复权行情利用复权因子动态计算」；聚宽 `get_price(fq='pre')` 即 `close/factor` 派生；米筐回测按 point-in-time 动态前复权防未来函数）。
3. **前复权是最不适合物化的口径**：锚定最新价 → 每逢新除权全部历史值漂移，物化即除权日全历史重写（我们的 `reAdjustBars` deleteMany+createMany 730 天窗口即此代价）；后复权锚定上市首日写一次不变，理论可物化但因子在手时动态算成本极低。

## Decision

**继续三口径全物化（策略 B，019 T010 已 ship 形态），不切读时换算（策略 C），并显式否决中间态。**

| 策略                                        | 业界对位                          | vendor 外呼/日 | 存储           | 读路径                                             | 除权日代价                |
| ------------------------------------------- | --------------------------------- | -------------- | -------------- | -------------------------------------------------- | ------------------------- |
| A. vendor 拉 3 口径存 3 份（016 旧态）      | 行情终端流派                      | 16.8k          | 3 份           | `findMany` 直读                                    | vendor 重拉整窗 + 重写    |
| **B. 拉 none、本地算、仍存 3 份（本决策）** | 折中                              | **5.6k**       | 3 份           | `findMany` 直读，零改动                            | 本地重算 + 重写（无外呼） |
| C. 只存 none + 因子，读时换算               | 量化平台主流（Tushare/聚宽/米筐） | 5.6k           | 1 份（砍 2/3） | 每读乘因子链，**先复权再聚合**穿透 `aggregateBars` | 零重写                    |

选 B 的理由：

1. **瓶颈资源是 vendor 配额非存储**——B 已拿到全部配额收益（日增外呼砍 2/3）；存储稳态 +0.9GB/年对 49G 盘无压力。
2. **读契约零改动**——`GetInstrumentBarsUseCase` 是单 `findMany`，周/月/季/年线聚合建在日线行上；C 要求在读路径插入因子乘法且必须先复权再聚合（周线 high/low 取极值在调整后值上做），改动面穿透聚合与分页。
3. **对拍审计需要物化值**——019 SC-S02 对拍门（本地算 = vendor 直拉逐 Decimal 断言）与 backfill 直拉权威历史值（防 vendor 舍入尾差争议）都依赖落库可比。
4. **写放大已被钳住**——因子仅除权日变（~2 次/年/股），重写窗口被 `reAdjustLookbackDays=730` floor 限界。

**显式否决中间态**（只物化 forward 砍 backward，或反之）：单砍省 1/3 存储不解决本质，业界无对位实践；前复权恰是漂移重写源、后复权才是「写一次不变」的可物化口径——直觉相反易误选。若未来动手，直接迁 C（none 真相源 + `adjustment_factor` 可零外呼重建一切，019 T009 `--factors` 已是迁移工具）。

## Consequences

- daily_bar 三口径并存，稳态 +0.9GB/年；除权日 `reAdjustBars` 历史重写为既有行为（本 ADR 接受其代价）。
- C 的迁移路径已预留且零成本维护：none + 因子表足以重建全部派生序列（可重建性 = 019 FR-S04）。
- 设计 doc §14.3 prod 运维序（backfill 直拉 → `--factors` → 灰度）不受影响。

## Trade-offs

- **存 2 份派生冗余（~2/3 存储）** — 接受理由：单人项目复杂度预算远比磁盘预算稀缺；C 的读路径复杂度现在不值。
- **物化前复权带 look-ahead（历史值含未来除权信息）** — 当前唯一消费方是行情展示（前复权恰是展示口径），无回测引擎；出现 point-in-time 需求即触发 sunset。
- **除权日全历史重写** — 被 730 floor + 事件稀疏钳住，量级 ~百级股/周 × 485 行 × 2 口径。

## Open Questions

- `ix_daily_bar_instrument_date` 与 uk `(instrument_id, trade_date, adjust)` 前缀重叠（index 586MB > heap 528MB）——核查询计划后评估删除（省 ~200MB），不阻塞本决策。

## References

- 019: [spec](../../specs/019-marketdata-sync-strategy/spec.md) / plan D1-D3 / tasks T009-T010；PR #339-#344
- prod 首跑实测：[06-04-marketdata-sync-strategy-design §14](../private/plans/2026-06/06-04-marketdata-sync-strategy-design.md)（PR #346）
- 业界调研（2026-06-05）：
  - Tushare 复权因子动态计算：<https://tushare.pro/document/2?doc_id=146>
  - 聚宽 `get_price` fq 默认 pre + `close/factor`：<https://www.joinquant.com/help/data/stock>
  - 富途三口径切换：<https://support.futunn.com/topic813>
  - 前复权 look-ahead / 漂移：<https://portfoliooptimizer.io/blog/adjusted-prices-without-look-ahead-bias/>
  - 后复权回测口径：<https://zhuanlan.zhihu.com/p/452936393>
