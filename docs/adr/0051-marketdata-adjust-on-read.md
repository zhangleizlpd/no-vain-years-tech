---
adr_id: ADR-0051
status: Accepted
applies_to: [apps/server]
sunset_trigger: |
  - 出现高频读时换算性能实证瓶颈（K线复权口径 P95 显著回归且缓存层不可行）→ 重审物化（回 ADR-0050 策略 B 形态，none + 因子可零外呼重建一切）
  - vendor 后复权口径出现 rebase 行为实证（破坏累积因子永不过期前提）→ 重审因子模型
---

# ADR-0051: Marketdata 复权序列读时换算 — 只存 none + 累积 backward 因子（策略 C）

- Status: Accepted (2026-06-05)
- Deciders: @zhangleizlpd
- Tags: server / market-data / storage / data-architecture
- Relates: **Supersedes [ADR-0050](0050-marketdata-adjust-series-materialization.md)**（三口径全物化）；[ADR-0047](0047-marketdata-pluggable-data-access.md) / [ADR-0049](0049-marketdata-scheduler-bullmq-hybrid.md)；实施载体 = [020-marketdata-adjust-on-read](../../specs/020-marketdata-adjust-on-read/spec.md)（spec/plan/tasks，PR #350）；设计沉淀 = [06-05-eod-none-plus-factor-design](../private/plans/2026-06/06-05-eod-none-plus-factor-design.md)

## Context

ADR-0050（2026-06-05 上半日 Accepted）在「三口径全物化（B）vs 只存 none + 因子读时换算（C）」中定格 B，把 C 列为 sunset 备选。**同日下半日三个新输入翻转权衡**：

1. **决策者重审业界调研后主动选择直迁主流终局**（§14.4 三结论：量化平台主流 = 存不复权价 + 因子读时算；前复权恰是最不适合物化的口径）——020 SDD 全套（spec 4Q clarify + plan D1-D9 + tasks 15 task）已就 C 的工程落地完成设计（#350）。
2. **#348 实证加重了 B 的除权日代价**：`reAdjustBars` 窗口修正为 lookback 全窗（旧「exDate 起」漏掉前复权被改写的**前段**历史，prod 108 只除权标的实证）——B 形态下每命中标的 = 730d × 2 口径 ≈ 2,900 行 delete+create 重写；叠加 prod 首跑实测 daily_bar 4.97M 行 / 1.1GB 中 **99.7% 为派生冗余**（§14.2）。C 把除权日重写降为**一行因子 upsert**。
3. **0050 选 B 的三条理由在 020 设计中逐条有解**：① 读契约零改动 → 020 D1「先复权再聚合」收口在 usecase 内存换算（API contract 零变更，FR-A08）；② 对拍审计需物化值 → 改 env-gated 真 vendor 直拍（ε 相对误差判据）+ 存量行清退**前**离线对拍（T013，物化值在被删前完成最后审计使命）；③ 写放大已被钳住 → C 不是钳住而是**消除**（前复权 rebase 由读时 `B(t)/B_latest` 自动发生，零维护）。

0050 的 sunset trigger 之一「K线读路径大改时顺势重审」——020 本身即该重构点（主动触发，而非等待存储压力被动触发）。

## Decision

**DailyBar 只持久化 `none` 口径；`AdjustmentFactor` 以累积 backward 因子为单一真相（`factor_forward` 列 drop）；forward/backward 读时换算：**

```text
backward(t) = none(t) × B(t)            B(t) = ∏ f_i (exDate_i ≤ t)，无版本 → 1
forward(t)  = none(t) × B(t) / B_latest B_latest = 全版本跃变乘积（永远全量 rebase）
```

> ⚠️ 2026-06-05 修订：因子存储粒度 = per-event 跃变 `f_i`（非累积值），锚定与对拍判据见下文「修订：自洽比值模型」段。

- 除权日：1 次 transient vendor backward 拉取（lookback 全窗，不落 DailyBar）比值锚定新版本；历史版本永不改动（backward 锚上市日永不 rebase）。
- 存量物化 forward/backward 行（dev + **prod ~4.95M 行**）：因子链回填 → 离线对拍 → 分批 DELETE 清退（运维 runbook 人工执行）。
- prod 前置：none 历史缺口（首跑仅单日深度，§14.3）必须先 backfill 补齐——none 是读时换算的唯一基底。

工程细节（公式边界 / expand→contract migration 时序 / PR 切分 / 对拍门）= 020 spec/plan/tasks，不在本 ADR 复述。

## Consequences

- 存储 -2/3（稳态 +0.9GB/年 → +0.3GB/年）；除权日行重写（730d×2 口径）消失；`ix_daily_bar_instrument_date` index 膨胀问题（0050 Open Question）随行数 -2/3 大半消解。
- forward 语义比物化形态**更正确**：永远以当前最新因子全量 rebase（物化形态 lookback 窗口外历史段永久停留旧纪元）；point-in-time 消费方（回测防未来函数）天然可支持（按时点因子链动态算）——0050 的第三个 sunset trigger 直接消解。
- 读路径增量：K线复权口径 +1 次因子表查询 + O(n) 内存乘法（SC-A05 spot-check 兑付）；`adjust=none` 路径逐字节不变。
- [ADR-0050](0050-marketdata-adjust-series-materialization.md) 标 Superseded（supersede-not-delete 留史，per ADR-0031）。

## Trade-offs

- **forward 与 vendor 直拉存在舍入级差异**（恒等关系 `forward = backward / B_latest` 的浮点尾差）——SC-A02 对拍门以相对误差 ε 判据兑付（ε 由 020 T001 probe 实测回填）；恒等关系实测不成立 = 020 T001 STOP 条件，本 ADR 随之重审。
- **读时换算依赖因子链完整性**——缺锚段读到旧因子（最终一致，`--factors` 幂等补锚）；锚定延迟窗口期 forward 以旧 B_latest 基准照常服务（020 clarify ④）。
- **清退不可逆**——顺序硬约束（回填 → 对拍 → 删）+ 人工执行卡点。

## 修订：自洽比值模型（2026-06-05，020 T001 实证后改判）

Trade-offs 预埋的 STOP 条件触发：**T001 probe 实证理杏仁 `fc_rights`/`bc_rights` 为减法精确复权**（段内 `none − forward` 恒等于每股股息，600519 23.957 元分毫不差；601088 历史 forward 出现负价格——减法签名；乘法恒等 `forward = backward / B_latest` 全 12 样本不成立，maxε 达 10⁻¹~10² 量级）。同时实证 `bc_rights` 绝对水位**锚查询窗口起点**（非上市日）——跨事件比值是 vendor 数据中唯一不变量。

**裁决（决策者 2026-06-05）：核心决策 C（读时换算）不变；因子模型从「对齐 vendor 恒等」改为「自洽比值模型」**——跨市场统一组合底座摒弃 vendor 减法口径，采用标准乘法比值（Tushare adj_factor 构造法），收益率数学自洽、无负价格：

1. **存储粒度 = per-event 跃变 `f_i`**（非累积值）：`f_i = [bwd(ex)/bwd(ex−1)] ÷ [none(ex)/none(ex−1)]`，锚自 vendor backward 跨除权日相邻两日比值（窗口平移免疫 + 乱序补锚局部幂等）。读时累积 `B(t) = ∏ f_i (exDate_i ≤ t)`，公式块其余不变；恒等关系由构造自洽成立。
2. **SC-A02 对拍门重定义**：比值模型输出与该 vendor 任何序列全局不可对（非事件日减法口径日收益 ≠ none 日收益）→ 改为 ① per-event `f_i` vs dividend 端点公式推算 `f̂_i` **独立源交叉验证**（ε = 2e-2 实测含再投资 convention gap，主体 ≤5e-3）+ ② 自洽恒等 IT 门 + none 逐字节等价；存量物化行对拍改为口径差异留档（预期不一致）。
3. **顺带暴露**：019 `anchorFactors` 的「段内比值常数」假设对该 vendor 本就失真（段内漂移实测 2%~57%）——020 T005/T009 重写连根替换，无需独立补救。

## References

- 020: [spec](../../specs/020-marketdata-adjust-on-read/spec.md) / [plan](../../specs/020-marketdata-adjust-on-read/plan.md) / [tasks](../../specs/020-marketdata-adjust-on-read/tasks.md)；SDD docs PR #350
- #348 `reAdjustBars` lookback 全窗修正（B 代价实证）；#346 prod 首跑实测 §14（4.97M 行 / 99.7% 冗余 / none 单日深度）
- 业界对位：ADR-0050 References 全部沿用（Tushare 复权因子动态计算 / 聚宽 `close/factor` / 米筐 point-in-time 前复权）
