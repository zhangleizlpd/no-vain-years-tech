---
adr_id: ADR-0048
status: Accepted
applies_to: [apps/server, apps/mobile]
sunset_trigger: |
  - 重要度分级 feature 实装时：本 ADR 只钉「方向 + Q7 机制选型」，分级的具体投影表 / Outbox event schema / 消费者落地归该 feature plan，届时回填实装细节并复审 Q7-A vs Q7-B 取舍（⚠️ 复审已于 2026-06-04 规划期完成，选 Q7-B，见 § 复审记录；剩余动作 = 018 实装细节回填）
  - 出现 portfolio 必须「server 端强一致同步读 marketdata」的场景（如下单校验需实时价、不能容忍 client-side merge 的最终一致）→ 跨层方向假设失效，重审是否引入 server 端只读跨 ctx 路径
    ✅ **FIRED 2026-08-18（061）· mitigated** —— 场景出现（消费方是 `optionsdesk` 而非原文假设的 `portfolio`，但判据是**形态**不是**哪个 ctx**）；引入的是**只读同步调用**（DI port 方法）不是跨 ctx 写，方向仍单向无环（详见 §复审记录 2026-08-18）
  - marketdata 因分级 ship 不再是叶子 context 后，其作为 callee 被 portfolio 反向读的契约稳定性 + 是否需把投影抽为共享 read model 复审
---

# ADR-0048: Marketdata（数据层）↔ Portfolio（应用层）跨层依赖方向 — 单向无环 + 反向走 Q7

- Status: Accepted (2026-06-03)
- Deciders: @zhangleizlpd
- Tags: server / architecture / bounded-context / cross-context / layering / market-data
- Relates: follows [ADR-0032](0032-backend-bounded-context.md)（bounded context 边界）+ [ADR-0033](0033-outbox-cross-context-comm.md)（Outbox 跨 ctx 通信）+ [ADR-0047](0047-marketdata-pluggable-data-access.md)（marketdata 可插拔访问层）；机制权威 = [server-bounded-context-catalog](../conventions/server-bounded-context-catalog.md) Q7
- Corrects: [marketdata master plan](../private/plans/2026-06/06-02-portfolio-marketdata-master.md) §4.3 把分级跨 ctx 读误标为「R2」（实为 Q7，见 Decision §2）

## Context

mono 投资域有两个分层不同的 bounded context：

- **`marketdata`（「03 技术底层」/ 数据层）**：universe / EOD / 估值 / 财报 / 公司行动 / 报价。015 访问层 + 016 同步已 ship；当前是**叶子 context**（零跨 ctx 读，per 015/016）。
- **`portfolio`（「04+ 应用层」/ 用户业务层）**：市场偏好（01）/ 券商账户（02）/ 自选（013，规划中）/ 持仓（未建）。

两者有**双向的潜在依赖**，方向若不约束会成环：

1. **portfolio → marketdata（消费行情/搜索/详情）**：自选列表（013）逐行显示报价、加自选 mini 搜索；个股详情（014）聚合 EOD/财报/K线。这些都要读 marketdata 的读端点。
2. **marketdata → portfolio（未来重要度分级）**：master §4.3 的同步分级要把「持仓 ∪ 自选 ∪ 追踪 ∪ 预警」作为 T0 最先同步，即 marketdata 夜间同步 job 要知道「哪些 instrument 是用户可见集」——这要读 portfolio 的 watchlist/holdings 等表。016 已**砍分级**（clarify 2026-06-03：四并集源表全未建，现做=读不存在的表），延后至 watchlist/holdings 落地后独立 feature。

若方向 1 用「portfolio server 端 DI marketdata 做行情富化」，叠加方向 2 的 marketdata→portfolio，就形成 **portfolio ⇄ marketdata server 层双向环**——违反 [ADR-0032](0032-backend-bounded-context.md) 单向边界、ESLint boundaries 会拦、且生命周期/事务纠缠。

## Decision

### 1. portfolio → marketdata：只读、走 mobile client-side merge，禁 server 端跨 ctx DI

portfolio 特性消费 marketdata 数据**一律由 mobile client 直调 015 读端点（`/quote` / `/search` / `/instruments/:symbol` / `.../bars`）client-side merge**，**禁止** portfolio server 段 DI 注入 marketdata 的 use case / service 做服务端富化。

- 013 自选：行情值 mobile client 调 015 `/quote` merge；加自选搜索调 015 `/search`。013 server 与 015 **运行时零跨 ctx**（仅共享 `market:code` 逻辑键，无跨 schema FK）。
- 014 详情（**同此不变量**）：详情/K线/财报由 mobile client 直调 015 detail/bars 端点；portfolio server 段只管「调分组 / 笔记 / 自选归属」等自有 CRUD，**不** server-DI marketdata。

### 2. marketdata → portfolio（未来分级）：Q7 独立只读，非 R2；Outbox-replay 投影优先

分级同步是**夜间 cron 后台 job 为算自己的 `syncTier` 读 portfolio 表**——独立只读，无共享 tx、无 user-facing 编排 → 按 catalog 决策树是 **Q7（独立跨 ctx 读）**，**不是 R2**（R2 = 编排同 tx、callee 失败回滚 caller，分级全不符）。落地按 Q7 三档：

| 档               | 机制                                                                                                                                                        | 取舍                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Q7-A（优先）** | marketdata 维护本地 `UserVisibleInstrument` 物化视图，由 portfolio（+未来 holdings/tracking/alerts）发的 **Outbox event replay** 喂新；sync-plan 读自己副本 | 保层次方向（事实向下流）、最终一致对夜间 EOD 分级够用、对扩展开放（新信号源只多一个 producer） |
| **Q7-B（临时）** | 经 `SecurityModule` export 的只读服务直查 portfolio 表 + `// CROSS-CONTEXT-READ:` 注释                                                                      | 省事，但倒挂层次 + 直耦合 portfolio schema                                                     |
| **Q7-C（禁）**   | standalone 直 `@Inject()` portfolio use case 进 marketdata                                                                                                  | 护城河禁止（`check-server-moat` 拦）                                                           |

> ⚠️ **表中「A 优先 / B 临时」标签已被 2026-06-04 复审更新**（分级场景选 B 且为终态选择，见 § 复审记录）；表格本体冻结为 2026-06-03 原决策留痕，不回改。

### 3. 净效果：server 层单向无环，marketdata 保持叶子直至分级 ship

- server 层依赖**单向**：应用层信号经 Outbox **向下流为事实**给数据层（Q7-A），数据层不反向 import/直读应用层。**无环**。
- 方向 1 的 client-side merge 是无环的**结构性前提**——它让 portfolio 在 server 层不依赖 marketdata，从而方向 2 的 marketdata→portfolio 不构成环。
- marketdata 在分级 ship 前**保持叶子 context**（零跨 ctx，与 015/016 一致）。

### 4. 当前不预造基建

013 **不预发** Outbox 事件（016 已砍分级、源表方建、零消费者 → 提前发=过度设计）。emission + 投影表 + 消费者由**分级 feature** 落地时按 Q7-A 增量补（portfolio 自身 ctx 内补发 publish，无迁移痛；`Instrument.syncTier` 列已支持 0/1/2 取值，无需迁移）。

## Consequences

- **正**：014 + 分级 feature 有 normative 锚——014 规划必须遵守 §1（client-side merge，不 server-DI marketdata），分级 feature 必须遵守 §2（Q7 非 R2）。防 master §4.3 的 R2 误标重演。
- **正**：跨层依赖图清晰单向，ESLint boundaries / `check-server-moat` 可机械验（marketdata 零 `prisma.<portfolioTable>.*` 直到分级 ship）。
- **负 / 限制**：方向 1 的 client-side merge = 最终一致 + 多一次客户端往返；若未来出现强一致服务端读需求（sunset_trigger 2）需重审。
- **延后**：Q7-A vs Q7-B 的最终选型、投影表结构、Outbox event schema 归分级 feature plan，本 ADR 只钉方向与机制类别。（**复审已于 2026-06-04 完成**，见下节。）

## 复审记录 — 2026-06-04（分级 feature 规划期）

> 执行 frontmatter sunset_trigger 第 1 条预设的「分级 feature 时复审 Q7-A vs Q7-B」动作。规划上下文 = [06-04 分级 feature 规划](../private/plans/2026-06/06-04-marketdata-tiering-feature-planning.md)；前置事实：013-watchlist 已 implemented（`WatchlistItem` 表已落）、017 调度重构进行中。

**复审结论：分级 V1 选 Q7-B**，且 B 在本场景是**终态选择（trigger 前）而非临时债**——「临时」隐含迁移义务，实际语义是「无 trigger 则无义务」。

**选 B 理由（防回潮留痕）**：

1. **摊销判据**：投影机器（Q7-A 的事件流 + 消费者 + 投影表）的本质是把读时计算摊销到写时。本场景读频率 = 每夜 sync-plan 一次、读时计算 = 一条几百行表的 `distinct (market, code)`、漂移兜底 = 拿源表同一条查询全量重建——**无摊销对象**，事件机器在为不存在的读压力做优化。
2. **Outbox 消费侧基建现状为空**：publisher（同 tx 写 row）已实装，但消费是 placeholder cron（扫到直标 published，无 dispatch 机制）。走 A 要连带建平台级消费基建（handler 注册 / at-least-once 幂等 apply / 失败重试），且计数形态投影在 at-least-once 下天然不幂等（原子性 ≠ 幂等性）、行集形态需事件去重兜底——均为本场景不必要的复杂度。
3. **A 的冷启动含 B**：013 已 ship、存量行无事件历史，A 的投影首灌必须直查 `WatchlistItem` 一次性 backfill——B 是 A 的真子集而非绕路，先 B 后 A 无沉没成本。

**升 A 的 trigger（修正原假设）**：「第二 producer 出现（holdings/追踪/预警落地）」**不构成**升级压力——多源并集在 B 形态下只是 union 里多一条夜查。真 trigger 仅两个：

1. **盘中实时分级**把读频率拉到分钟级（摊销对象出现；呼应 [ADR-0049](0049-marketdata-scheduler-bullmq-hybrid.md) 盘中 seam 的复审点）；
2. portfolio schema 语义变更**实际咬过一次** marketdata 查询（如加软删列未同步过滤致 T0 污染——耦合债从账面变现实）。

**实装细节归 018 feature plan**：查询形态 / `// CROSS-CONTEXT-READ:` 注释文本 / syncTier 重算触发时点，届时回填本 ADR。

## 复审记录 — 2026-08-18（061 盘中实时 spot；`sunset_trigger` #2 `fired`）

> 执行 frontmatter `sunset_trigger` 第 2 条。触发源 = [061-marketdata-realtime-spot](../../specs/061-marketdata-realtime-spot/spec.md)（plan Gate 0.4 / D1）。同轮的另两份 amend：[ADR-0054](0054-alert-self-hosted-external-io-adapter.md)（实时面升格落点）/ [ADR-0062](0062-optionsdesk-bounded-context.md)（跨 ctx 面 +1 条）。

**trigger 原文** = 「出现 portfolio 必须**server 端强一致同步读 marketdata** 的场景（如下单校验需实时价、不能容忍 client-side merge 的最终一致）→ 跨层方向假设失效，重审是否引入 server 端只读跨 ctx 路径」。

**判定：命中（`fired`），已缓解。** 消费方是 **`optionsdesk`** 而不是原文假设的 `portfolio` —— 但**判据是「形态」不是「哪个 ctx」**：本 ADR 钉的是「数据层 ↔ 应用层的跨层方向 + 反向走 Q7」，061 出现的正是原文描述的那个形态 —— 一个应用层 ctx 必须在 **server 端同步读到实时价**，client-side merge 的最终一致**不够用**：雷达要按 spot **排序 + keyset 分页**，排序表达式的操作数必须在服务端同表可得，客户端 merge 排不了序也翻不了页。⚠️ [ADR-0062 §复审记录 2026-08-01](0062-optionsdesk-bounded-context.md) 登记的两条绊线里的第 ②「盘中实时 spot 上线」就是这一条。

**引入了什么（precise，别读宽）**：

1. **只读同步调用，不是跨 ctx 写** —— `optionsdesk` DI 注入 `marketdata` `exports` 的 port token（`REALTIME_QUOTE_PORT` / `MARKET_STATE_PORT`），调的是 port 方法。`marketdata` 的任何表在这条路径上**零写入**；tick 写库落的是 **optionsdesk 自有列**（锚表 `intraday_price` / `intraday_at`）。
2. **方向仍单向无环** —— `marketdata → optionsdesk` 的运行时依赖**不存在**：没有任何 marketdata 代码 import `optionsdesk`，`MarketdataModule` 只是 `exports` 两个 token（export 不产生对消费方的依赖）。本 ADR §3「server 层依赖单向、无环」的净效果**保持成立**。
3. **`portfolio` 一行未改** —— §1「portfolio → marketdata 一律 client-side merge、禁 server 端跨 ctx DI」**照旧有效**。本次放行的是 `optionsdesk → marketdata` 这一条**具名边**，不是给「应用层可以 server-DI marketdata」发通行证。🚨 谁要复用这条先例，先过 [catalog](../conventions/server-bounded-context-catalog.md) 7Q **加上**本条的三个限定：注入的是 **port 非 use case** / **零跨 ctx 写** / **被注入方零感知**。任一不满足 → 回本 ADR 重评。

**`sunset_trigger` #3（marketdata 不再是叶子后的契约稳定性 + 是否抽共享 read model）：前半句成立，后半句未触发。** marketdata 其实早就不是叶子（045 起有一条反向 Q7-B 读锚表，见 [ADR-0062](0062-optionsdesk-bounded-context.md) §3 第 2 行）；061 新增的是它作为**被注入方**的角色。但「抽共享 read model」**无对象** —— 本片的读**不经投影**（明确否掉「marketdata 落表 → optionsdesk 读表」的两跳，实时面无历史需求，历史归 `daily_bar`）。契约稳定性由 port interface 承担：`marketdata` 侧改 port 签名 = **编译期红**，不是运行期静默漂移。

**§2 表格与 2026-06-04 的 Q7-B 选型不受影响。** 分级同步（`marketdata → portfolio`）仍是夜间 cron 的独立只读，读频率没变、摊销判据没变。2026-06-04 记的两个「升 A」trigger 均**未命中**：① 「盘中实时**分级**把读频率拉到分钟级」—— 061 分钟级的是**行情价读取**，不是**分级读**，两者读的不是同一批表，`sync-plan` 的节奏一次没动；② portfolio schema 语义咬过一次 —— 未发生。
