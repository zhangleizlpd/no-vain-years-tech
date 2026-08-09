---
feature_id: 038-hk-marketdata-core
modules: [marketdata]
owners: ['@zhangleizlpd']
status: implemented
created_at: 2026-07-11
updated_at: 2026-07-12
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: na
web_compat_notes: '纯 server 端数据摄取 —— 现有 6 个夜间同步维度扩到港股 (market=hk) + 10 年历史回填，零 mobile/web surface。不新增读端点（读侧端点 015 已落，market-agnostic 天然覆盖 hk），只让 PG 事实层多出 market=hk 的真数据。无 OpenAPI 契约变更、无 mobile 段、无 Web export 冒烟路径。'
agent_friction_observed: false
state_branches:
  - '市场路由 cn 无回归: canonical cn:xxx 符号 → adapter 命中 /cn/ 路径 → 现有 A 股同步行为逐字节不变'
  - '市场路由 hk: canonical hk:xxxxx 符号 → adapter 按 market 段插值命中 /hk/ 路径 → 拉到港股数据'
  - '未知市场前缀: 非 cn/hk 符号 → UnsupportedLixingerMarketError 明确抛错，不静默错配 vendor'
  - 'marketScope 过滤 cn-only: 维度 marketScope={cn} → 工作集只含 cn 标的（未上线 hk 的维度保持现状）'
  - 'marketScope 过滤含 hk: 维度 marketScope={cn,hk} → 工作集含 cn+hk 标的，按 syncTier 排序统一消费同一令牌桶'
  - 'fsType 路由 hk-reit: 港股 REIT 标的 → profile 富化 lixingerCompanyType=reit → fundamental/fs 路由到 /hk/company/{fundamental,fs}/reit'
  - 'fsType 路由 hk 常规: 港股 bank/insurance/security/non/other 标的 → 路由到对应 fsType（与 A 股同构）'
  - 'universe hk 新标的: 理杏仁港股 universe 返 code 不在 Instrument → insert market=hk + currency=HKD + 填 pinyin + syncTier 默认'
  - 'universe hk 既有标的: hk code 已在 Instrument → upsert name/status/listingStatus，不覆盖 syncTier/lixingerCompanyType'
  - 'active-only 边界: hk 标的 status != active（退市/停牌）→ 不纳入回填工作集（生存者偏差为已知取舍）'
  - 'eod_bar hk 区间回填: 单只港股 candlestick 按 10yr 区间拉 → DailyBar market=hk append skipDuplicates，幂等无重复'
  - 'fundamental/fs hk 区间回填: 按 per-stock startDate/endDate 拉历史序列 → 多行日频估值/季频财报 upsert 自然键'
  - 'corporate_action hk 触发复权: 港股新增 dividend/split/allotment → 触发该标的复权因子重锚（重拉理杏仁已复权，本地不重算）'
  - '回填 --markets 透传: backfill CLI --markets hk → estimateRequests 与工作集均按 hk 统计/过滤，dry-run 估算量级吻合'
  - '回填自限速: 回填期叠加自限速 ~10/s(~600/min) + jitter → 不超共享 900/min 桶，无 429'
  - '共享限流器串行: hk 回填 job 与 A 股夜间同步 job 共享单 LIXINGER_HTTP_CLIENT + queue concurrency=1 → 天然串行，不并发打爆共享桶'
  - 'vendor 字段缺失: hk 某标的某维度 vendor 返 null/缺字段 → 存 null 不崩（沿 015 端口层「字段缺失不报错」契约）'
  - '回填分层排序: HSI/港股通成分标的 syncTier 提级 → 优先回填落库；长尾低流动性在市标的后置，但仍纳入全量回填（不缩范围）'
  - '港股交易日历派生: hk 交易日门控由恒生指数(HSI) via hk/index/candlestick 派生（与 A 股 000001 同构），非交易日整管线 skip'
---

# Feature Specification: 港股核心数据同步 + 平台市场缝隙激活

**Feature Branch**: `038-hk-marketdata-core`
**Created**: 2026-07-11
**Status**: Draft
**Input**: 隶属 [master p1](../../docs/private/plans/2026-07/07-11-hk-marketdata-sync-master.md)；p0 实测结论见 [探查报告](../../docs/private/plans/2026-07/07-11-hk-marketdata-p0-probe-report.md)。

## Clarifications

### Session 2026-07-11

- Q: 10 年回填的标的范围/优先级? → A: 全量分层排序 —— 全部在市港股都回填，但按流动性/指数成分（HSI/港股通成分）经 `syncTier` 分层排序，流动可回测集先落、长尾后置（不缩范围）。
- Q: 港股交易日历（trading-day gate）以哪个为准? → A: 恒生指数（HSI）via `hk/index/candlestick` 派生（纯 HKEX 日历，与 A 股 000001 派生同构）；港股通日历留南向场景（p2）。

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 港股价量历史可用于回测 (Priority: P1)

量化研究员需要港股近 10 年的日线价量（原始价 + 读时前/后复权），并能像 A 股一样从统一的接口/表读取，作为回测的价格底座。为此系统须先注册港股标的（含公司类型富化），再同步 K 线历史。

**Why this priority**: 价格数据是任何回测的最小必需输入；没有它其余因子数据无意义。这是本 feature 的 MVP 切片。

**Independent Test**: 对单只港股（如 `hk:00700` 腾讯）跑 universe→profile→eod_bar 三维度后，查 PG `instrument` 出现 `market='hk'` 行、`daily_bar` 出现该标的近 10 年 `market=hk` 的 K 线行；经现有读端点（015）能取到该港股的 K 线与最新报价。

**Acceptance Scenarios**:

1. **Given** 港股标的未注册, **When** universe 维度对 hk 运行, **Then** 该标的以 `market='hk'`、`currency='HKD'`、拼音、默认 syncTier 落 `Instrument`，且可被搜索命中
2. **Given** 港股标的已注册但缺公司类型, **When** profile 维度运行, **Then** `lixingerCompanyType` 被富化（含 `reit` 房托这一港股特有类型）
3. **Given** 已注册港股标的, **When** eod_bar 维度按 10 年区间回填, **Then** `daily_bar` 出现 `market=hk` 的日线行（`adjust='none'` 单口径），字段与 A 股同构，重复运行幂等不产生重复行
4. **Given** 现有 A 股同步, **When** 市场缝隙改造上线, **Then** A 股（cn）同步行为无回归（路径仍 `/cn/`、工作集仍含 cn 标的）

---

### User Story 2 - 港股基本面/财报/公司行动历史可用于因子回测 (Priority: P2)

量化研究员需要港股 10 年的日频估值（PE/PB/PS/股息率/市值 + 历史分位）、季频财务指标（ROE/毛利率/EPS/BPS）、以及分红/拆分/配股与由此派生的复权因子，用于估值因子与基本面因子回测。

**Why this priority**: 在价格底座（US1）之上提供更丰富的回测因子；对策略实验价值高但非最小必需。

**Independent Test**: 对样本港股跑 fundamental/financial/corporate_action 三维度回填后，查 `fundamental_snapshot`（多行日频历史）、`financial_metric`（多期季频）、`corporate_action` + `adjustment_factor` 均出现 `market=hk` 关联行；抽样与理杏仁网站核对一致。

**Acceptance Scenarios**:

1. **Given** 已注册且已富化 fsType 的港股标的, **When** fundamental 维度按 per-stock 区间回填, **Then** `fundamental_snapshot` 出现该标的多年日频估值行（按 `(instrumentId,date)` upsert）
2. **Given** 港股标的, **When** financial 维度回填, **Then** `financial_metric` 按 `(instrumentId,reportPeriod)` 出现多期财务指标
3. **Given** 港股标的有分红/拆分/配股, **When** corporate_action 维度回填, **Then** `corporate_action` 落事件行并触发该标的复权因子重锚（`adjustment_factor`）
4. **Given** 某港股某维度 vendor 返回字段缺失, **When** 同步写库, **Then** 缺失字段存 `null`、不崩、不阻塞其余标的

---

### User Story 3 - 运维分多夜安全回填、不触发风控、不影响 A 股 (Priority: P3)

运维需要把港股 10 年历史分多夜温和回填，峰值远低于理杏仁限额并叠加抖动以规避账号风控，同时不干扰既有 A 股夜间同步。

**Why this priority**: 保障数据获取过程本身的稳定与账号安全；是交付方式而非数据内容，故 P3。

**Independent Test**: `backfill --markets hk --history-depth 3650 --dry-run` 打印的请求数估算与预期量级吻合；小批（~50 只）真回填期间监控令牌桶排队日志与 `SyncRun`，sustained rate 在自限速内、无 429、A 股同步不受影响。

**Acceptance Scenarios**:

1. **Given** 回填以 `--markets hk` 触发, **When** 估算与执行, **Then** `estimateRequests` 与工作集均按 hk 统计/过滤（不再 hardcode cn）
2. **Given** 回填期自限速开启, **When** 持续拉取, **Then** 有效 sustained rate ≤ 自限速目标（~600/min）、不触发 429
3. **Given** hk 回填 job 与 A 股夜间同步 job 同队列, **When** 两者都排队, **Then** 因 `concurrency=1` 天然串行，共享令牌桶不被并发打爆
4. **Given** 回填被限额/中断, **When** 下一夜续跑, **Then** 已同步标的幂等跳过、从断点续，不重复拉取

### Edge Cases

- 未知/不支持市场前缀（非 cn/hk，如 us 个股）→ 明确抛 `UnsupportedLixingerMarketError`，不静默错配。
- 港股 REIT 标的 fsType 路由：`lixingerCompanyType=reit` 必须正确路由到 `/hk/company/{fundamental,fs}/reit`，值域较 A 股多这一档。
- 退市/停牌港股（`status != active`）→ 不纳入工作集（active-only，生存者偏差为已知取舍）。
- 理杏仁 candlestick 单次区间上限（≤10 年）—— 若未来需 >10 年须分段，本 feature 以 10 年为界。
- 港股交易日历与 A 股不同 → `trading_day` 需按 `market='hk'` 独立维护（HKEX 日历）。

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: 同步系统 MUST 支持按 canonical 符号的市场段（`cn`/`hk`）路由到理杏仁对应市场路径，`cn` 行为与改造前逐字节一致（无回归）。
- **FR-002**: 同步系统 MUST 以每维度的 `marketScope` 配置（而非全局硬编码单市场常量）决定该维度的标的工作集。
- **FR-003**: 系统 MUST 支持将 `universe / profile / eod_bar / fundamental / financial / corporate_action` 六个维度的工作集扩展到 `hk`，且港股标的以 `market='hk'`、`currency='HKD'` 注册。
- **FR-004**: `profile` 维度 MUST 能富化港股公司类型 fsType，值域包含港股特有的 `reit`（房托），并驱动 fundamental/fs 的 fsType 路由。
- **FR-005**: 系统 MUST 能对港股按 per-stock 时间区间（起止日）回填历史日频估值与财报（fundamental/fs），支撑近 10 年历史序列，而非仅最新快照。
- **FR-006**: 系统 MUST 能对港股回填近 10 年日线（K 线）、分红/拆分/配股，并据公司行动重锚复权因子。
- **FR-007**: 回填运维命令 MUST 将市场范围参数真正作用于请求量估算与执行工作集（不得 hardcode 单一市场）。
- **FR-008**: 回填 MUST 在既有限速（每分钟 900 / 每秒 36）之下再叠加更保守的自限速（目标约每秒 10 / 每分钟约 600）与调用抖动，以规避账号风控；港股回填与 A 股夜间同步 MUST 共享单一限流预算并因单并发队列天然串行。
- **FR-009**: 港股同步 MUST 幂等：同一区间重复运行不产生重复行、不产生副作用；被限额/中断后 MUST 能从进度水位/已同步集续跑。
- **FR-010**: 港股同步 MUST 沿用「vendor 字段缺失存 `null`、单标的失败隔离不阻塞其余标的」的既有容错契约。
- **FR-011**: 存储 MUST 复用现有 market-agnostic 事实表（`Instrument` / `DailyBar` / `FundamentalSnapshot` / `FinancialMetric` / `CorporateAction` / `AdjustmentFactor` / `TradingDay`），港股行经 `market` 字段/`instrument` 外键区分；MUST NOT 新建带市场前缀（`hk_*`）的并行表。
- **FR-012**: 系统 MUST 按 `market='hk'` 独立维护港股交易日历（`TradingDay`），由恒生指数（HSI）via `hk/index/candlestick` 派生（与 A 股 000001 上证综指派生同构），驱动港股同步的交易日门控。
- **FR-013**: 港股同步范围限「在市股」（`status='active'`）；退市/停牌标的不纳入工作集（生存者偏差记为已知限制）。
- **FR-014**: 回填 MUST 覆盖全部在市港股，但 MUST 按流动性/指数成分（HSI/港股通成分优先）经 `syncTier` 分层排序，使流动可回测集先落库、长尾低流动性标的后置（复用现有 syncTier 机制，不缩减范围）。

### Key Entities _(include if feature involves data)_

- **Instrument（标的）**: 已含 `market`（`cn`/`hk`/`us`）、`currency`、`code`、`lixingerCompanyType`、`syncTier`、`status`、`listingStatus`；港股复用此表，`market='hk'`。
- **DailyBar（日线）**: 日频 OHLC 时序，`(instrumentId, tradeDate, adjust)` 唯一；港股 K 线复用。
- **FundamentalSnapshot（估值快照）**: 日频估值 + 历史分位，`(instrumentId, date)` 唯一；港股 10 年日频历史复用。
- **FinancialMetric（财务指标）**: 季频，`(instrumentId, reportPeriod)` 唯一；港股财报复用。
- **CorporateAction / AdjustmentFactor（公司行动 / 复权因子）**: 事件粒度；港股分红/拆分/配股 + 复权因子复用。
- **TradingDay（交易日历）**: `(market, date)` 主键；新增 `market='hk'` 港股日历。
- **SyncDimension（同步维度配置）**: 已含 `marketScope String[]`、`cronExpr`、`batchSize`、`historyDepth`、`metricsList` 等；港股上线 = 对应维度 `marketScope` 追加 `'hk'`。

## Success Criteria _(mandatory)_

- **SC-001**: 量化研究员能从统一接口/表取到覆盖近 10 年（≥ 2400 交易日，视标的上市时长）的港股日线，样本标的价量与理杏仁网站核对一致率 100%。
- **SC-002**: 六个维度均能产出 `market='hk'` 的持久化事实行；港股在市标的覆盖率 ≥ 95%（少数 vendor 无数据的标的按 `null`/跳过记录，不静默丢失）。
- **SC-003**: 市场缝隙改造上线后，A 股既有同步与读取行为零回归（既有集成/单测全绿）。
- **SC-004**: 10 年历史回填期间无 429、无账号风控触发；有效持续调用速率不超过自限速目标。
- **SC-005**: 港股 10 年历史回填在保守多夜节奏下于约 2–3 周内完成核心六维；流动可回测集（HSI/港股通成分）经 syncTier 提级于首几夜优先就位。
- **SC-006**: 港股估值/财报因子具备足够历史长度支撑回测（日频估值序列 ≥ 5 年，视标的上市时长），可用于估值分位类策略实验。

## Assumptions

- 理杏仁港股付费包（hk/company）已订阅且在有效期内（2026-07-11 起，至 2027-05-12），API 凭证经 SOPS 注入 `LIXINGER_TOKEN`（p0 已确认）。
- 港股 K 线字段与 A 股完全一致；fundamental/fs/dividend 均支持 per-stock 时间区间（p0 实测确认）。
- 港股 fsType 值域为 `bank/insurance/non/other/reit/security`（比 A 股多 `reit`）；路由源为 `hk/company/profile`（p0 确认）。
- 采用「仅在市股（active-only）」，接受生存者偏差；退市股维度留后续（非本 feature）。
- 存储与限流基建（PG、令牌桶、BullMQ 单并发队列、共享 `LIXINGER_HTTP_CLIENT`）沿用现状，本 feature 不新增同步基础设施。
- 港股特有的 ~16 类 greenfield 数据（做空/南向/所属指数/基金持股/波动率/热度/公告等）不在本 feature 范围，留 p2/p3。
- 港股交易日历由恒生指数（HSI）via `hk/index/candlestick` 派生（Clarification Q2），与 A 股 000001 派生机制同构；港股通（Stock Connect）日历留南向场景（p2）。
- 回填覆盖全部在市港股，按流动性/指数成分经 `syncTier` 分层排序（Clarification Q1），复用现有 syncTier 提级机制（如 015/018 的 watchlist 提级），不因分层缩减范围。
