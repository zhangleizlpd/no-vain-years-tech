---
adr_id: ADR-0067
status: Accepted
applies_to: [apps/server]
sunset_trigger: |
  - 接入的 vendor 全部改用带外缺失（JSON null / 显式 present 标志位），带内哨兵在本仓绝迹 —— 届时本 ADR 的强制声明退化为无对象的仪式，应降级为注释
  - 出现第 2 个需要「成对判据」之外的消歧形态（如三字段联合、或需跨行上下文才能判缺失），本 ADR 的单行 O(1) 归一化模型不够用，须重审是否上升为独立的规范化管线
  - 数值列的缺失语义由上游 shim 统一承担（shim 改为输出显式 null 并有契约测试守住），本 ADR 的分层表须重画
---

# ADR-0067: Vendor 缺失语义 — 带内哨兵必须在 adapter 边界归一为 null，且逐字段显式声明

- Status: Accepted (2026-08-24)
- Deciders: @zhangleizlpd
- Tags: server / marketdata / external-data / data-quality / anti-corruption-layer
- Follows: [ADR-0047](0047-marketdata-pluggable-data-access.md)（per-adapter 约束档扩展一节「缺失语义」）· [ADR-0043](0043-server-flat-module-paradigm.md) §4（rules 文件持无副作用业务规则）

## Context

同一形状的缺陷在本仓出现了**三次**：

| 次  | 哨兵                         | 落点                              | 后果                                                                                                                                |
| --- | ---------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 字符串 `'N/A'`               | `option_contract.settlement_mode` | 「没有结算方式」被存成一个看起来有效的结算方式（066 T01 已修）                                                                      |
| 2   | 数值 `0`（实时档 bid）       | 候选集权利金门槛                  | 「此刻还没挂价」被判成「不再合格」，开盘初期候选集凭空缩水（[#130](https://github.com/zhangleizlpd/no-vain-years-tech/issues/130)） |
| 3   | 数值 `0`（日线快照 bid/ask） | 落库前硬门                        | 实值腿整片被拒 ⇒ **永久缺口**；虚值腿带假报价入库（[#172](https://github.com/zhangleizlpd/no-vain-years-tech/issues/172)）          |

共同形状：**vendor 用带内哨兵（in-band sentinel）表达「没有这个值」，而 adapter 的 null 判据只认带外缺失（out-of-band：字段不下发 / 非有限数 / 空串）。**

### 那道闸从未触发过一次

`futu-option-snapshot.adapter.ts` 的 `numToString` 注释白纸黑字承诺：

> 🚨 **不回落成 0**：0 张 OI 与「vendor 没给 OI」是两件事。

2026-08-24 prod 全表实测（185,918 行）证明这个承诺**结构性无法兑现**：

| 列                    | `= 0`          | **`IS NULL`** |
| --------------------- | -------------- | ------------- |
| `last` / `prev_close` | 3,312 / 3,312  | **0**         |
| `volume`              | 134,653        | **0**         |
| `open_interest`       | 62,007         | **0**         |
| `bid` / `ask`         | 37,340 / 1,626 | **0**         |

除 `iv` 外**没有任何数值列曾经是 NULL** —— 因为这个 vendor 从不产生带外缺失。防线在，但守的是一扇永远不会有人走的门。

### 而下游早就写对了

`optionsdesk` 整片按 `bid: Decimal | null` 写好，注释里连纪律都立了（`leg-derive.rules.ts`：「无 `bid` → `null`，🚫 MUST NOT 当 0（那是「白送」的意思）」）。**那些 `=== null` 分支是死代码，从未执行过一次** —— 上游把下游已经写好的正确逻辑饿死了。

### 业内怎么做（2026-08-24 核）

| 来源                                                                | 做法                                                                                                                                               |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Databento DBN](https://github.com/databento/dbn)                   | `UNDEF_PRICE = i64::MAX` / `UNDEF_ORDER_SIZE = u32::MAX` —— 哨兵放在**类型值域极端**，与合法值不可能碰撞；**逐字段**在 schema 注释写明何时是 UNDEF |
| [NautilusTrader](https://github.com/nautechsystems/nautilus_trader) | `best_bid_price() -> Option<Price>`；`has_bid()` = 顶档存在 **且** 该档非空 ⇒ **空档位（zero size）= 没有报价**                                    |
| OPRA Binary Participant Interface                                   | 🚨「**Zero in the bid price field represents a valid Bid Price**」                                                                                 |
| 富途 OpenAPI                                                        | `bid_price` / `ask_price` / `bid_vol` / `ask_vol` 只列了类型，**未规定缺失时返什么**                                                               |

⚠️ OPRA 那条是关键的反向约束：**零价可以是合法报价**，所以 `if (price === 0) return null` 是错的修法 —— 它会静默吃掉真实报价，且不会红。

## Decision

### D1 — 归一化落在 adapter 边界的**唯一一处**

vendor 哨兵 → `null` 的转换 MUST 发生在 adapter（ACL 边界），MUST NOT 散在 use case / rules / 呈现层。

职责分层就此定死（此前没定，`'N/A'` 正是从两层之间的缝里漏的 —— adapter 注释当时写着「网关侧 `clean_value` 只处理空值/非有限数，字符串原样透传」，两边都以为对方管了）：

| 层                                  | 管什么                               | MUST NOT         |
| ----------------------------------- | ------------------------------------ | ---------------- |
| 网关 shim（`mappers.clean_value`）  | **传输形态**归一：空值 / 非有限数    | 不做业务语义判断 |
| adapter + `vendor-absence.rules.ts` | **业务语义**归一：vendor 哨兵 → null | 不做传输层清洗   |

### D2 — 判据 MUST 成对，MUST NOT 只看单个字段

盘口价的缺失判据是 `(price, size)` **同时为 0**。三份独立证据零例外：

| 证据源                  | 成对为 0             | 成对为正 | **混合** |
| ----------------------- | -------------------- | -------- | -------- |
| prod 港股 `2026-08-21`  | 252                  | 271      | **0**    |
| prod 美股全表           | —                    | —        | **0**    |
| 真实港股 fixture 132 行 | 101 (bid) / 68 (ask) | 31 / 64  | **0**    |

### D3 — 分不出来的列 MUST 显式登记，MUST NOT 留白

判据是**有没有伴生字段可消歧**：

| 类别             | 列                                                                                           | 处置                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 可判定           | `bid` / `ask`（伴生 `*_vol`）                                                                | 归一为 null                                                                              |
| **已知不可判定** | `volume` / `turnover` / `open_interest` / `net_open_interest` —— 0 是**合法值**且无伴生字段  | 登记进 `INDISTINGUISHABLE_ZERO_FIELDS`，**原样保留**。属 vendor 契约层信息丢失，本地无解 |
| 待查             | `last` / `prev_close` —— 0 值计数完全相等（3312/3312），疑似「从未成交」但**不能凭数据断言** | 维持原样，向 vendor 求证后再定                                                           |

🚫 **MUST NOT 把不可判定的列也 `0 → null`** —— 那会把「真的是 0」抹成「不知道」，方向与本 ADR 正好相反，且同样不会红。

### D4 — 不一致形态 MUST 原样保留 + 告警，MUST NOT 猜

`price = 0 ∧ size > 0`（OPRA 那种合法零价）、`price > 0 ∧ size = 0`、单边缺失 —— 一律**原值原样落库**，抬批级 WARN。

**理由是不对称性**：富途没有文档化这个契约 ⇒ D2 的判据是**从数据反推**的；反推出来的东西会过期，且**过期时不报错**。这些形态是「哨兵理论破裂」的唯一信号，归一掉等于把警报器拆了。而猜错的代价（静默吃掉真实报价 / 静默造出假报价）远高于库里留一行待查数据。

### D5 — 每个新 vendor adapter MUST 显式声明它的缺失语义假设

扩展 ADR-0047 的 per-adapter 约束档，新增一节「**缺失语义**」，必答三问：

1. 这个 vendor 用什么形态表达「没有值」？带外（null / 不下发）还是带内哨兵？
2. 每个哨兵有没有伴生字段可消歧？没有的列列出来，登记为不可判定。
3. 这个假设从哪来 —— vendor 文档写明的，还是从数据反推的？**反推的必须有运行时不变量盯着。**

## Consequences

**正面**

- 下游那片从未执行过的 `=== null` 分支被一次性激活 —— 不是新建语义，是让已有的正确逻辑真正跑起来
- 隐式假设变成**被监控的**假设（D4）：契约漂移会有人知道，而不是又攒三年
- D5 让下一个 adapter 作者不必靠运气 —— 这是本 ADR 相对「修一行代码」的全部增量

**负面 / 成本**

- 已入库 38,966 行需一次确定性回改（`bid = 0 ∧ bid_size = 0 → NULL`），且**是行为变更不是纯清洗**：`computeEffectiveCost(K, 0) = K` 这个看起来有效的「有效成本」会变成 `null`。方向正确（正是 `leg-recall.rules.ts` 警告过的「MUST NOT 拿 `K − 0` 冒充」），但 UI 上可见
- hk `2026-08-21` 那 491 行实值腿**买不回来** —— vendor 不提供历史期权快照。本 ADR 只能阻止它继续发生
- 每行多两次 O(1) 比较（成对判定 + 不变量），可忽略

**已知不解决**

`volume` / `turnover` / `open_interest` / `net_open_interest` 的 0 与「没有值」在 vendor 契约层就分不开。本 ADR 把它**登记为已知限制**而非假装解决了。
