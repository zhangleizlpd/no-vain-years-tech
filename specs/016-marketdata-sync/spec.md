---
feature_id: 016-marketdata-sync
modules: [marketdata]
owners: ['@zhangleizlpd']
status: implemented
created_at: '2026-06-02'
updated_at: '2026-06-04'
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: na
web_compat_notes: '纯 server 夜间同步管线 + 调度，零 mobile/web surface。本 feature 不新增读端点（读侧端点 015 已落），只让 015 端点背后的 PG 事实层有真数据。无 OpenAPI 契约变更、无 mobile 段、无 Web export 冒烟路径。'
agent_friction_observed: false
state_branches:
  - 'trading-day gate 交易日: TradingDay 含今日 → 管线正常执行全步骤'
  - 'trading-day gate 非交易日: TradingDay 不含今日 → 整管线 skip(SyncRun status=skipped)，不打 vendor'
  - 'universe sync 新标的: 东财 clist 返 code 不在 Instrument → insert + 填 pinyin + syncTier 默认 2'
  - 'universe sync 既有标的: code 已在 Instrument → upsert name/status，不覆盖 syncTier/lixingerCompanyType'
  - 'universe sync 黑名单标的: code ∈ SyncBlacklist → 跳过(不 insert 不同步)'
  - 'uniform sync: V1 全标的统一优先级，syncTier 维持 015 默认 2(不重算)，单序消费同一双窗令牌桶 (分级延后至 watchlist/holdings 落地，clarify 2026-06-03)'
  - 'rate-budget 耗尽: 双窗令牌桶/日配额耗尽 → 剩余标的顺延下窗(SyncRun 水位记进度)，已同步标的幂等不重复'
  - 'per-instrument 成功: 单标全步骤 ok → SyncRun.ok++'
  - 'per-instrument 失败隔离: 单标某步抛错 → catch 记 SyncRun.failedTargets，不阻塞其余标的，管线继续'
  - 'idempotent 重跑: 同一交易日管线连跑两次 → DailyBar append skipDuplicates + upsert 自然键 → 无重复行、无副作用'
  - 'corporate-action 触发复权: 新增 dividend/split/allotment → 标记该标的 forward/backward adjusted 序列需重取(重拉 Lixinger 已复权,本地不重算)'
  - 'distributed-lock 抢锁成功: 实例抢到 Redis 锁(SET NX EX) → 执行管线'
  - 'distributed-lock 抢锁失败: 其余实例未抢到锁 → 直接退出(leader-election-lite，集群单例 HA)'
  - 'lock-expiry 双跑: 持锁实例超时锁释放致双跑 → 幂等兜底保证数据不坏(仅浪费配额)'
  - 'crash 恢复: 持锁实例中途崩溃 → 锁 TTL 到期释放，下窗凭 SyncRun 水位 + failedTargets 续跑'
  - 'backfill 一次性: backfill 模式按 historyDepth 拉历史(交易日迭代) vs 夜间 delta 模式从 lastWatermark 增量'
---

# Feature Specification: Marketdata 同步（配置化夜间全量 A 股同步管线 + 调度 — 让 015 读端点有真数据；重要度分级延后）

> ⚠️ **[ARCHITECTURE PARADIGM (2026-06-02)]**
> 本 feature 在 015 已立的 **第 5 个 bounded context `marketdata`** 内续写（schema `marketdata` 增量演进 + module 目录新增同步类）。落地按 [ADR-0032](../../docs/adr/0032-backend-bounded-context.md) bounded context 边界 + [ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md) Flat + Anemic + Moat 范式；可插拔访问层范式 [ADR-0047](../../docs/adr/0047-marketdata-pluggable-data-access.md)。marketdata 在 016 **仍是叶子 context**（零跨 ctx 读，与 015 一致）——原计划的「跨 ctx 读 portfolio 算 tier」因分级延后（clarify 2026-06-03）而不在本 feature。spec 只描述能力与行为，不锁实现技术细节（具体 schema 列 / scheduler 类名 / 锁实现归 plan）。
>
> 🎯 **[流程 — 纯 server 同步管线，无 mockup]**
> 本 feature **无 UI**，走 sdd.md 后端业务模块标准流程：`spec → /speckit-clarify → plan → tasks → impl`（无 mockup 步）。**不新增读端点**——只生产灌库让 015 端点有真数据。验证全走 Testcontainers IT + env-gated 真 vendor IT。

**Feature Branch**: `016-marketdata-sync`
**Created**: 2026-06-02
**Status**: Clarified（clarify 2026-06-02：① corp-action 复权=重拉 Lixinger 已复权 candlestick、本地不重算；② backfill=NestJS standalone CLI script。**clarify 2026-06-03（plan Phase 0 撞 spec 漏洞）：③ 砍重要度分级**——T0 四并集源表全未建（持仓/自选/追踪/预警），V1 全量统一同步、syncTier 留默认不重算、零跨 ctx 读，分级延后至 watchlist/holdings 落地）
**Module**: `marketdata`（015 已立的第 5 bounded context — 本 feature 续写同步层；schema `marketdata` 增量演进）
**设计源**: [Marketdata Master Plan](../../docs/private/plans/2026-06/06-02-portfolio-marketdata-master.md) §4.3 分级 + [子 plan 2 同步](../../docs/private/plans/2026-06/06-02-portfolio-marketdata-p2-sync.md) + [ADR-0047](../../docs/adr/0047-marketdata-pluggable-data-access.md) + [PRD-03](../../docs/prd/portfolio/portfolio-03-data-provider-tech-design.md)
**前置依赖**: [015-marketdata-access-layer](../015-marketdata-access-layer/spec.md)（schema 6 表 + 8 capability 端口 + adapter + 读端点；本 feature 消费其 port 拉数、写其 schema）
**Input**:

- 015 落了访问层（schema 6 事实/注册表 + 8 端口 + adapter + 读端点），但 **PG 事实层是空的**——015 的 IT 靠 seed fixtures 验读路径，生产库无真数据。本 feature = **数据访问层第二阶段（方案A ②）**：把全市场 EOD/估值/财报/公司行动夜间灌进库，让 013 自选 / 014 详情 / 预警 / 策略实验室的读端点返真数据。
- **3 张配置/审计表落地**：015 clarify 明确把 `SyncDimension` / `SyncBlacklist` / `SyncRun` 的 DDL 推迟到本 feature（访问层无消费者不携空表）。本 feature 建表 + 写入/消费语义。
- **universe / calendar live adapter 落地**：015 建了 search/quote/eod/fundamental 等 port 的 live 实现，但 universe 枚举 / 交易日历的 **live adapter（东财 clist / trade-day）+ pinyin 填充**落本 feature（同步管线的直接依赖）。
- **异构夜间同步管线**：交易日 gate → universe 同步 → profile 富化（拿 fsType）→ EOD bar → fundamental → financial → corporate-action；幂等 + per-instrument 失败隔离 + 双窗限频 + HTTP-out-of-tx。
- **全量统一优先级同步**（V1）：黑名单外全 universe 同优先级，syncTier 留默认不重算；配额耗尽剩余顺延、幂等不重复。**重要度分级（T0/T1/T2 + 跨 ctx 读 portfolio 并集）延后**——其四并集源表（持仓/自选/追踪/预警）全未建，clarify 2026-06-03 砍。
- **调度**：`@nestjs/schedule @Cron` + Redis 分布式锁（ECS 集群单例 HA）+ 幂等兜底 + SyncRun 水位恢复 + backfill 命令。

## Context

- **承上启下**：015 是「能取数 + 能读」的访问层；本 feature 是「定时把全市场灌进库」的同步层。两者通过 015 的 8 capability 端口（消费侧）+ 6 事实/注册表 schema（落库侧）解耦——同步管线只依赖端口 `Symbol + interface` 拉数，不感知背后 vendor。
- **vendor 限频是真瓶颈（承重事实 F4）**：理杏仁双窗限频 **1000 req/min 且 36 req/s**（任一超即 429）。全 A 股 ~5400 标的 × 多维度 × 多年——单窗口跑不完全量，故须 ① 复用 015 的双窗令牌桶 `VendorHttpClient`；② 配额耗尽剩余顺延下窗（水位记进度），正确性靠幂等兜底而非靠一次跑完。（V1 全标的统一优先级；tier 序优先消费 = 分级 feature 增量。）
- **限频封顶 → 调度无需 fan-out（master §B.4）**：即便未来上 ECS 多实例集群，也无法突破 vendor 全局限频上限并行加速，故同步负载「跨节点分片」收益有限。集群下要的是**单例 HA**（只一个实例在跑 + 故障转移），而非工作分片——把多实例需求从「分布式工作队列」降级为「分布式选主锁」（`@Cron` + Redis `SET NX EX` 选主，其余实例退出）。
- **幂等是终极安全网**：upsert on 自然键 + append `skipDuplicates`——即便锁过期致双跑、或单标重试，数据不坏（仅浪费配额），正确性不靠锁。
- **失败隔离照搬既有范式**：per-instrument try/catch（照搬 `account/anonymize-frozen-accounts.scheduler.ts` 的 cron per-row 范式），单标错不阻塞其余 → 落 `SyncRun.failedTargets`（下次重试 + 可 grep）。
- **HTTP 在 tx 外**：写库在 tx 内，绝不跨 HTTP 持有数据库事务（vendor 慢响应会长期占锁）。
- **配置化元数据驱动**：同步哪些维度（表）、哪些股票（黑名单外全同步）、选哪些列、cron 时刻、批量大小、重试上限——全由 `SyncDimension` 配置表驱动（后续做管理界面）。cron 时刻**配置化**（F7 理杏仁 EOD 就绪时间未公开、保守经验测后调，不硬编码）。
- **叶子 context（V1 零跨 ctx 读）**：分级延后后，marketdata 同步不读任何他 ctx 表（与 015 一致）。未来分级 feature 才引入跨 ctx 读 portfolio（持仓/自选/追踪/预警并集），届时按 [ADR-0048](../../docs/adr/0048-marketdata-portfolio-cross-layer-dependency.md) 走 **Q7 独立只读**（优先 Outbox-replay 投影 / 临时共享只读服务；**非 R2**、**禁直 DI use case**——原措辞「只读跨 ctx use case DI 注入」即 Q7-C 禁形态，已纠正；无跨 schema FK，逻辑 `market+code` 关联，`check-server-moat` 注释强制）。
- **规模 trivial（承重事实 F8）**：全 A 股 10yr ≈ 5GB 裸 / 1.5GB 压缩，单 PG trivial。**V1 不分区不归档**，仅文档化分区（>50GB）/ Parquet 冷存（>200GB）seam。

## Clarifications

### Session 2026-06-02

- Q: T1 分级（近 N 日被搜索/查看）需访问历史，但 015 schema 无 view/search 访问记录表，V1 怎么处理 T1？ → A: **V1 砍 T1，只 T0/T2 二级**。**（⚠️ 已被 2026-06-03 决议进一步超越——整套分级延后，见下方 Session 2026-06-03）**确定性二级：T0=用户可见集（持仓∪自选∪追踪∪预警并集）、T2=其余 universe。T1（recency）**留 seam**——文档化「未来加访问历史记录表后升三级」。理由：为凑 T1 提前建埋点设施是独立 scope，V1 二级已满足「保鲜用户可见集」核心目标，不过度设计；master §4.3 三级模型在 V1 降为二级实装。
- Q: corporate-action 后的复权重算语义——V1 怎么产生 forward/backward 复权序列？ → A: **重拉 Lixinger 已复权 candlestick**。Lixinger candlestick 本就按 `adjustTypes` 提供 forward/backward 复权 bar；corp-action 仅作「触发重取受影响日期区间 bar」的标记，本地**不重算**复权。理由：Lixinger 是可靠付费源，本地自实现复权（除权因子连乘）是重新发明轮子 + 正确性风险；复用 vendor 复权最稳。
- Q: backfill（一次性 10yr 历史回填）命令的落地形态？ → A: **NestJS standalone CLI script**（`apps/server/src/marketdata/*.cli.ts` 经 `NestFactory.createApplicationContext` 跑，运维手调 nx target / node dist）。理由：零 HTTP attack surface、复用全部 DI（adapter / Redis 锁 / SyncRun）、与夜间 cron 共享同一锁与管线代码，最贴「一次性运维操作」；admin endpoint 与本 feature「零新读端点」原则冲突。

### Session 2026-06-03（plan Phase 0 研究撞到 spec 级逻辑漏洞 → 用户裁决）

- Q: T0 分级的四个并集源（持仓/自选/追踪/预警）表实证**一个都未建**（schema 仅 `PortfolioPreference` 市场级偏好 + `BrokerAccount` 券商身份，均非 instrument 级用户信号；013-watchlist / 014-stock-detail 仍 `status: draft`），016 的重要度分级怎么办？ → A: **V1 砍分级，全量统一同步（全标的同优先级，syncTier 留 015 默认 2 不重算）**。理由：分级机制目的是「保鲜用户可见集」，可见集为空时纯空转；现做 syncTier 重算 + 跨 ctx 读 portfolio = 读不存在的表（编译都过不了）。**移除 US4（syncTier 重算）+ FR-S04（分级）+ FR-S05（跨 ctx 读 portfolio）+ tier 序消费**——marketdata 在 016 仍是**叶子 context**（零跨 ctx 读，与 015 一致）。**分级 + 跨 ctx 读并集延后**到独立 feature，在 watchlist（013）/ holdings 表真正落地之后做（`syncTier` 列已支持 0/1/2 取值，届时无需迁移）。work-conserving 预算分配退化为：**全标的单序消费同一双窗令牌桶，配额/窗口耗尽 → 剩余顺延下窗（SyncRun 水位记进度），已同步标的幂等不重复**。

## User Scenarios & Testing _(mandatory)_

### User Story 1 — [Server] 同步配置/审计 schema 落地（3 表 DDL，承接 015 增量演进）（Priority: P1）

系统建 `SyncDimension`（配置化驱动核心：维度开关 / vendor 绑定 / cronExpr / 选列 / 批量 / 重试 / 水位）、`SyncBlacklist`（黑名单外全同步）、`SyncRun`（执行审计 + DLQ-lite：scanned/ok/skipped/failed + failedTargets + status + 时间窗）三表，在 015 已建的 6 事实/注册表之上**增量演进** `marketdata` schema。这是其余所有同步能力的配置与审计底座。

**Why this priority**: 015 明确把这 3 表 DDL 推迟到本 feature（无消费者不携空表）。同步管线的「配置驱动」「失败隔离审计」「水位恢复」全挂在这 3 表上，必须先落表。

**Independent Test**: Testcontainers PG；① `prisma migrate deploy` 后断言 3 表存在、唯一键/索引齐全；② seed 一行 SyncDimension(universe) → 断言可读配置；③ 写 SyncRun(running) → 更新为 partial + failedTargets → 断言审计可查。

**Acceptance Scenarios**:

1. **Given** 015 的 6 表已在，**When** 跑本 feature migration，**Then** SyncDimension/SyncBlacklist/SyncRun 三表落地，唯一键（dimension_key / market+code）+ 索引（syncRun type+startedAt）齐全
2. **Given** SyncDimension 配置一行，**When** 同步管线读配置，**Then** 维度开关/vendor/cronExpr/选列/批量/重试/水位字段均可驱动行为
3. **Given** 一次同步执行，**When** 写 SyncRun，**Then** scanned/ok/skipped/failed 计数 + failedTargets(Json) + status(running|success|partial|failed) 可审计

---

### User Story 2 — [Server] 交易日历同步 + 交易日 gate（universe/calendar live adapter）（Priority: P1）

系统提供交易日历 live adapter（东财或理杏仁 trade-day），同步交易日落 `TradingDay`；夜间管线起手先过**交易日 gate**——非交易日直接 skip（不打 vendor、不耗配额、SyncRun status=skipped）；backfill 按交易日迭代（跳过非交易日）。

**Why this priority**: gate 是整管线的最外层短路——非交易日盲跑纯浪费配额。calendar 也是 backfill 迭代的基础（按交易日逐日回填）。015 只建了 `TRADING_CALENDAR_PORT` 抽象，live 实现 + gate 逻辑落本 feature。

**Independent Test**: Testcontainers PG；① mock calendar adapter 返某日非交易日 → 断言管线整体 skip、SyncRun=skipped、未触任何 vendor 调用；② 交易日 → 断言管线进入后续步骤；③ backfill 区间含周末/节假日 → 断言仅交易日被迭代；④ env-gated 真 calendar IT（默认 skip）。

**Acceptance Scenarios**:

1. **Given** 今日非交易日（不在 TradingDay），**When** cron 触发管线，**Then** 整管线 skip，不打 vendor，SyncRun status=skipped
2. **Given** 今日交易日，**When** cron 触发，**Then** 管线进入 universe→...→corp-action 后续步骤
3. **Given** backfill 区间跨周末/节假日，**When** 按交易日迭代，**Then** 仅交易日被回填，非交易日跳过

---

### User Story 3 — [Server] universe 同步 + 黑名单过滤 + pinyin 填充（东财 clist live adapter）（Priority: P1）

系统经东财 clist（m:0/1/2，含北交所）枚举全 A 股 → upsert `Instrument`（code/name/market/type），填充 `pinyinAbbr`/`pinyinFull`（015 仅建列，本地 pg_trgm 搜索备援需要真数据）；`SyncBlacklist` 命中的标的跳过（不 insert 不同步）。既有标的 upsert 不覆盖 `syncTier`/`lixingerCompanyType`（由后续步骤维护）。

**Why this priority**: universe 是后续所有维度同步的标的来源（「黑名单外全同步」）；pinyin 填充让 015 的本地 pg_trgm 搜索备援真正可用（否则搜索降级路径返空）。015 建了 `INSTRUMENT_UNIVERSE_PORT` 抽象，live adapter（东财 clist）+ pinyin 填充落本 feature。

**Independent Test**: Testcontainers PG；① mock 东财 clist 返若干标的（含北交所 bj）→ 断言 upsert Instrument、归一化 canonical `market:code`、pinyin 列被填；② 重跑 → 断言 upsert 幂等（无重复、name 更新、syncTier 不被重置）；③ 某 code ∈ SyncBlacklist → 断言跳过未 insert；④ env-gated 真东财 IT（默认 skip）验真实 clist 解析。

**Acceptance Scenarios**:

1. **Given** 东财 clist 返全 A 股（含北交所），**When** universe 同步，**Then** upsert Instrument（canonical market:code），pinyinAbbr/pinyinFull 被填充
2. **Given** 某标的 ∈ SyncBlacklist，**When** universe 同步，**Then** 该标的跳过（不 insert 不同步）
3. **Given** universe 重跑，**When** 同一标的再 upsert，**Then** 幂等（无重复行、name/status 更新、syncTier/lixingerCompanyType 不被重置）

---

### User Story 4 — [Server] 全量统一优先级同步（重要度分级延后至 watchlist/holdings 落地）（Priority: P1）

V1 对黑名单外全 universe **统一优先级**同步——所有标的 `syncTier` 留 015 默认 2，**不重算、不跨 ctx 读**。原 master §4.3 的 T0/T1/T2 分级因其数据源（持仓/自选/追踪/预警表）**全未建**（schema 仅 `PortfolioPreference` 市场级 + `BrokerAccount` 券商身份，013/014 仍 draft）而**延后**到独立 feature（watchlist/holdings 表落地后做）。work-conserving 预算分配退化为：全标的单序消费同一双窗令牌桶，配额/窗口耗尽 → 剩余顺延下窗（SyncRun 水位记进度），已同步标的幂等不重复。

**Why this priority**: 分级目的是「保鲜用户可见集」，可见集（持仓/自选）当前为空 → 分级无可分级之物，纯空转；现做 syncTier 重算 + 跨 ctx 读 = 读不存在的表（编译都过不了）。统一同步是 V1「让 015 端点有真数据」的最小正确路径；分级是 watchlist 落地后的纯增量（`syncTier` 列已支持 0/1/2，届时无需迁移）。marketdata 在 016 因此仍是**叶子 context**（零跨 ctx 读，与 015 一致）。

**Independent Test**: Testcontainers PG；① 跑 sync-plan → 断言全标的统一序消费、`syncTier` 维持默认（无重算逻辑）；② 配额耗尽注入 → 断言剩余顺延下窗（水位记进度），已同步标的不重复（幂等）；③ marketdata 模块零 `prisma.<portfolioTable>.*`（`check-server-moat` 0 violation，叶子 ctx）。

**Acceptance Scenarios**:

1. **Given** 黑名单外全 universe，**When** 跑同步，**Then** 全标的统一优先级消费同一双窗令牌桶（无 tier 序），`syncTier` 维持 015 默认 2
2. **Given** 一窗配额/令牌桶耗尽，**When** 剩余标的待同步，**Then** 顺延下窗（SyncRun 水位记进度），已同步标的幂等不重复
3. **Given** marketdata 同步代码，**When** `check-server-moat` 扫描，**Then** 零跨 ctx `prisma.<otherTable>.*`（叶子 context，无 CROSS-CONTEXT-READ）

---

### User Story 5 — [Server] 异构 EOD 同步管线（双窗限频 + per-row 隔离 + SyncRun 水位 + 幂等）（Priority: P1）

夜间管线（交易日 gate 后）按维度序执行：universe 同步 → profile 富化（Lixinger cn/company 拿 fsType 缓存到 Instrument.lixingerCompanyType，低频/变更才跑）→ EOD bar（Lixinger candlestick，adjustTypes 配置）→ fundamental（Lixinger fundamental/{fsType}，metricsList 配置）→ financial（财报季 Lixinger fs）→ corporate-action（Lixinger dividend/allotment/equity-change）→ 触发复权重取标记（corp-action 后重拉 Lixinger 已复权 bar）。V1 全标的统一优先级（无 tier 序）单序消费 015 双窗令牌桶 work-conserving；窗口/配额耗尽剩余顺延（SyncRun 水位记进度），已同步标的幂等不重复。幂等（DailyBar append skipDuplicates、fundamental/financial upsert 自然键）；per-instrument try/catch 失败隔离（落 SyncRun.failedTargets）；HTTP 在 tx 外、写库在 tx 内。

**Why this priority**: 这是「让 015 端点有真数据」的核心——把全市场事实灌进库。限频 + 失败隔离 + 幂等 + 水位续跑是可靠性四支柱。

**Independent Test**: Testcontainers PG（mock 各 vendor adapter）；① 跑管线 → 断言 DailyBar/Fundamental/Financial/CorporateAction 落库；② **连跑两次** → 断言无重复行（append skipDuplicates + upsert 自然键）；③ 注入单标某步抛错 → 断言该标记 SyncRun.failedTargets、其余标的正常落库（隔离）；④ 限频突发 → 断言被双窗令牌桶节流；⑤ 配额耗尽注入 → 断言剩余顺延（水位记进度）、已同步标的不重复；⑥ profile 富化 → 断言 fsType 缓存到 lixingerCompanyType、fundamental 路由到对应端点；⑦ HTTP-out-of-tx 断言（事务不跨 vendor 调用）。

**Acceptance Scenarios**:

1. **Given** 交易日且 universe 已同步，**When** 跑 EOD/fundamental/financial/corp-action 管线，**Then** 四类事实落库（Decimal 精度、唯一键）
2. **Given** 同一交易日管线连跑两次，**When** 第二次执行，**Then** 无重复行（DailyBar append skipDuplicates、fundamental/financial upsert 自然键），无副作用
3. **Given** 单标的某维度抛错，**When** 管线处理该标，**Then** 记 SyncRun.failedTargets、不阻塞其余标的，管线继续
4. **Given** 双窗令牌桶/配额耗尽，**When** 继续消费，**Then** 剩余标的顺延下窗（SyncRun 水位记进度），已同步标的幂等不重复
5. **Given** 公司类型未知的标的，**When** profile 富化，**Then** 调 cn/company 解析 fsType、缓存 lixingerCompanyType，fundamental 步路由到对应端点
6. **Given** 新增 corporate-action（分红/拆股/配股），**When** 处理该标，**Then** 标记其受影响日期区间（ex-date 之后）的 forward/backward bar 需**重拉 Lixinger 已复权 candlestick**（本地不重算复权，clarify 2026-06-02）

---

### User Story 6 — [Server] 调度（@Cron + Redis 分布式锁单例 HA + 崩溃恢复）+ backfill 命令（Priority: P1）

系统用 `@nestjs/schedule @Cron`（cron 时刻走 SyncDimension.cronExpr 配置化，不硬编码）触发夜间管线；多实例集群下经 Redis 分布式锁（`SET NX EX` + TTL > 最长 job 时长 + 续租/fencing token）选主——仅一个实例执行，其余退出（leader-election-lite / 单例 HA）。持锁实例崩溃 → 锁 TTL 到期释放，下窗凭 SyncRun 水位 + failedTargets 续跑。另提供 backfill 命令（一次性历史回填 vs 夜间 delta：historyDepth + lastWatermark 双模）。

**Why this priority**: 调度是「夜间自动灌库」落地的最后一环；分布式锁是 ECS 集群上线（已部署，master account-migration 进行中）的安全前提；backfill 是首次启用时灌历史的入口。

**Independent Test**: Testcontainers PG+Redis；① 模拟多实例并发触发 → 断言仅一个抢到锁执行、其余退出；② 锁过期致双跑 → 断言幂等兜底数据不坏（仅多耗配额）；③ 持锁实例中途「崩溃」（不释放锁）→ 断言 TTL 到期释放、下窗凭水位续跑；④ backfill 干跑（dry-run）→ 断言按 historyDepth 交易日迭代、delta 模式从 lastWatermark 增量；⑤ cron 时刻读 SyncDimension.cronExpr（非硬编码）。

**Acceptance Scenarios**:

1. **Given** 多实例集群同时 cron 触发，**When** 抢 Redis 锁，**Then** 仅一个实例执行，其余直接退出（单例 HA）
2. **Given** 持锁实例锁过期致双跑，**When** 两实例并发执行，**Then** 幂等兜底保证数据不坏（仅浪费配额）
3. **Given** 持锁实例中途崩溃，**When** 锁 TTL 到期，**Then** 锁释放，下一窗口凭 SyncRun 水位 + failedTargets 续跑
4. **Given** 首次启用需灌历史，**When** 运行 backfill 命令（**NestJS standalone CLI script**，`NestFactory.createApplicationContext` 复用 DI，clarify 2026-06-02），**Then** 按 historyDepth 交易日迭代回填；夜间 delta 模式从 lastWatermark 增量
5. **Given** SyncDimension.cronExpr 配置某时刻，**When** 调度触发，**Then** cron 时刻来自配置（不硬编码，F7 经验测后可调）

---

### Edge Cases

- **非交易日触发**（节假日/周末）→ gate 短路，整管线 skip，零 vendor 调用
- **universe 枚举返坏项**（东财 200 但结构异常/字段缺失）→ 容错解析跳过坏项，不整体失败
- **黑名单标的已在 Instrument**（历史已 insert 后才拉黑）→ 后续同步跳过该标，是否删历史行 = 配置/运维决策（V1 保留，仅停同步）
- **single instrument 多维度部分失败**（EOD 成功但 fundamental 失败）→ 维度级隔离，已成功维度落库，失败维度记 failedTargets
- **配额耗尽跨夜顺延**（一夜跑不完全量）→ 水位记进度，多夜补齐；不重复已完成标的（幂等 + 水位）
- **锁续租失败**（持锁实例 GC 停顿超 TTL）→ fencing token 防脑裂（旧持锁者写入被新 leader 的 token 拒绝 / 或纯靠幂等兜底，归 plan 决策）
- **corp-action 触发复权重算的范围爆炸**（一只票多年历史全重算）→ 仅重算受影响日期区间（ex-date 之后），不全量重算
- **profile 富化频率**（fsType 极少变）→ 低频/变更才跑（非每夜全量调 cn/company），避免浪费配额
- **backfill 与夜间 delta 并发**（运维手跑 backfill 撞上 cron）→ 同一 Redis 锁互斥，二者不并发
- **Lixinger EOD 未就绪**（cron 早于数据就绪 F7）→ 当夜拉到旧数据/空 → 幂等不坏；经验测后调 cronExpr
- **规模超阈值**（库 >50GB）→ 文档化分区 seam 触发（V1 不实装，仅留 ADR seam）

## Requirements _(mandatory)_

### Server Functional Requirements

- **FR-S01**: 系统 MUST 建 `SyncDimension` / `SyncBlacklist` / `SyncRun` 三表（`marketdata` schema 增量演进，承接 015 的 6 表），唯一键（dimension_key / market+code）+ 审计索引齐全。
- **FR-S02**: 系统 MUST 提供交易日历 live adapter（落 `TradingDay`）+ 夜间管线起手**交易日 gate**——非交易日 MUST 整管线 skip（不打 vendor、SyncRun status=skipped）；backfill MUST 按交易日迭代（跳过非交易日）。
- **FR-S03**: 系统 MUST 提供 universe live adapter（东财 clist m:0/1/2 含北交所）枚举全 A 股 → upsert `Instrument`（canonical `market:code` + name/type）；MUST 填充 `pinyinAbbr`/`pinyinFull`（本地 pg_trgm 搜索备援）；`SyncBlacklist` 命中标的 MUST 跳过（不 insert 不同步）；既有标的 upsert MUST NOT 覆盖 `syncTier`/`lixingerCompanyType`。
- **FR-S04**: V1 MUST 对黑名单外全 universe **统一优先级**同步——`Instrument.syncTier` 留 015 默认 2，MUST NOT 重算、MUST NOT 跨 ctx 读。重要度分级（T0/T1/T2 + 跨 ctx 读 portfolio 并集）**延后**到独立 feature（持仓/自选/追踪/预警表落地后），本 feature 不实装（clarify 2026-06-03：四并集源表全未建，现做 = 读不存在的表）。
- **FR-S05**: marketdata 在 016 MUST 保持**叶子 context**——同步代码 MUST NOT 出现跨 ctx `prisma.<otherTable>.*`（仅 `prisma.instrument/dailyBar/fundamentalSnapshot/financialMetric/corporateAction/tradingDay/syncDimension/syncBlacklist/syncRun`）；`check-server-moat` MUST 0 violation。（分级延后后无跨 ctx 读，与 015 叶子形态一致。）
- **FR-S06**: 夜间同步管线 MUST 按维度序执行：交易日 gate → universe → profile 富化（拿 fsType 缓存 lixingerCompanyType）→ EOD bar（adjustTypes 配置）→ fundamental（metricsList 配置）→ financial（财报季）→ corporate-action → 触发复权重算标记。
- **FR-S07**: 每步 MUST 统一序消费 015 双窗令牌桶 `VendorHttpClient`（V1 无 tier 优先，全标的同优先级）；窗口/配额耗尽时剩余标的 MUST 顺延下窗（SyncRun 水位记进度），已同步标的幂等不重复。（tier 序保底 = 分级 feature 增量。）
- **FR-S08**: 同步 MUST 幂等——DailyBar append `skipDuplicates`、fundamental/financial/corp-action upsert on 自然键；重跑/双跑 MUST 无重复行、无副作用。
- **FR-S09**: 同步 MUST per-instrument 失败隔离（try/catch，照搬 `anonymize-frozen-accounts.scheduler` 范式）——单标错 MUST NOT 阻塞其余标的，MUST 记 `SyncRun.failedTargets`（下次重试 + 可 grep）。
- **FR-S10**: HTTP（vendor 调用）MUST 在事务之外；写库 MUST 在事务之内（绝不跨 HTTP 持有 DB 事务）。
- **FR-S11**: corporate-action（分红/拆股/配股）落库后 MUST 触发该标的受影响日期区间（ex-date 之后）forward/backward bar 的**重取**——经 EOD_BAR 端口重拉 Lixinger 已复权 candlestick（本地 MUST NOT 自实现复权因子连乘重算，clarify 2026-06-02）；重取经幂等 upsert 覆盖旧复权行。
- **FR-S12**: 调度 MUST 用 `@nestjs/schedule @Cron`，cron 时刻 MUST 来自 `SyncDimension.cronExpr` 配置（不硬编码，F7 经验测后可调）。
- **FR-S13**: 多实例集群下 MUST 经 Redis 分布式锁（`SET NX EX` + TTL > 最长 job 时长 + 续租/fencing token）选主——仅一个实例执行，其余退出（leader-election-lite / 单例 HA）。
- **FR-S14**: 崩溃恢复 MUST 靠 ① 锁 TTL 到期自动释放 + ② `SyncRun` 水位 + `failedTargets` 让下窗续跑；正确性 MUST NOT 依赖锁不丢（幂等兜底）。
- **FR-S15**: 系统 MUST 提供 backfill 命令（一次性历史回填 vs 夜间 delta 双模：`historyDepth` + `lastWatermark`），落地为 **NestJS standalone CLI script**（`NestFactory.createApplicationContext` 复用 DI，无 HTTP surface，clarify 2026-06-02）；backfill MUST 与夜间 cron 经同一 Redis 锁互斥（不并发）。
- **FR-S16**: 同步配置 MUST 由 `SyncDimension` 元数据驱动（维度开关 enabled / vendor 绑定 / cronExpr / metricsList 选列 / adjustTypes / batchSize / retryMax / priority / lastWatermark / pausedUntil）——加维度/调参不改代码。
- **FR-S17**: 可观测性 MUST 复用 `trace_id`（nestjs-cls）+ `SyncRun` 审计（scanned/ok/skipped/failed/failedTargets/status/时间窗）；失败告警出口（SyncRun failed → log/outbox）作为配置化补强维度（V1 至少 log，outbox 通知为 seam）。
- **FR-S18**: 规模/归档 V1 MUST 单 PG 不分区不归档；分区（月度 RANGE by tradeDate，>50GB 触发）+ Parquet 冷存（>200GB）MUST 仅作文档化 seam（ADR 记触发条件 + expand-migrate-contract 手法，本 feature 不实装）。
- **FR-S19**: 本 feature MUST NOT 新增读端点 / 改 OpenAPI 契约（读端点 015 已落）——只生产灌库；故无 `packages/api-client` regen、无 mobile 段。

### Out-of-Scope Functional Boundaries

- ❌ 新读端点 / OpenAPI 契约变更（015 已落，本 feature 零端点）
- ❌ **重要度分级（syncTier 重算 T0/T1/T2）+ 跨 ctx 读 portfolio 并集**（clarify 2026-06-03：四并集源表持仓/自选/追踪/预警全未建 → 延后至 watchlist/holdings 落地后独立 feature；V1 全量统一同步、syncTier 留默认）
- ❌ 实时报价同步（V1 仅 EOD；盘中实时分级刷新 = BullMQ 升级 seam）
- ❌ 管理界面（SyncDimension/SyncBlacklist CRUD UI 属更后续 feature）
- ❌ 港股/美股事实同步（V1 集中 A 股；港股次阶、美股待富途）
- ❌ 点位时阶 universe / 退市史（东财当前快照够 V1；策略实验室阶段补）
- ❌ 分区/Parquet 冷存实装（仅文档化 seam）

## Key Entities

- **SyncDimension（配置化驱动核心）**：`{ dimensionKey(universe|profile|eod_bar|fundamental|financial|corporate_action), enabled, cronExpr, vendor, marketScope[], metricsList(Json), adjustTypes[], batchSize, historyDepth, retryMax, priority, lastWatermark, pausedUntil }`——驱动同步哪些维度/哪个 vendor/何时跑/选哪些列/批量/重试/水位。唯一 `dimensionKey`。
- **SyncBlacklist（黑名单外全同步）**：`{ market, code, reason, createdAt }`——命中即完全不同步。唯一 `(market, code)`。
- **SyncRun（执行审计 + DLQ-lite）**：`{ syncType, startedAt, finishedAt, scanned, ok, skipped, failed, failedTargets(Json), status(running|success|partial|failed) }`——每次执行的审计 + 失败目标（续跑/重试源）+ 水位（顺延进度）。索引 `(syncType, startedAt desc)`。
- **Instrument（015 已建，本 feature 写 pinyin + lixingerCompanyType）**：universe 同步填 `pinyinAbbr`/`pinyinFull`；profile 富化填 `lixingerCompanyType`。`syncTier` V1 维持默认 2（不重算，分级延后）。
- **TradingDay（015 已建，本 feature 由 calendar adapter 灌）**：`{ market, date }`——gate + backfill 迭代来源。
- **DailyBar / FundamentalSnapshot / FinancialMetric / CorporateAction（015 已建，本 feature 灌库）**：同步管线写入目标；幂等 upsert 自然键。
- _（QuoteSnapshot / VendorConstraintProfile 见 015，本 feature 不改）_

## Success Criteria _(mandatory)_

### Server Measurable Outcomes

- **SC-S01**: 3 配置/审计表落地，migration 在 015 的 6 表之上增量演进、CI 通过（Prisma `marketdata` schema 检查 + Testcontainers migrate deploy）。
- **SC-S02**: 交易日 gate IT 覆盖两分支（交易日进入管线 / 非交易日 skip 不打 vendor）；universe 同步 IT 覆盖 upsert 幂等 + pinyin 填充 + 黑名单跳过。
- **SC-S03**: 全量统一同步 IT 覆盖 syncTier 维持默认（无重算逻辑）+ 配额耗尽顺延幂等不重复；marketdata 零跨 ctx `prisma.<otherTable>.*`（`check-server-moat` 0 violation，叶子 ctx）。
- **SC-S04**: 同步管线 IT 覆盖四类事实落库 + **连跑两次无重复行**（幂等）+ 单标失败隔离（failedTargets）+ 双窗限频节流 + **配额耗尽顺延幂等不重复** + profile fsType 路由。
- **SC-S05**: 调度 IT 覆盖 **多实例并发仅一个执行** + **锁过期双跑幂等不坏数据** + 崩溃后水位续跑 + cronExpr 配置化（非硬编码）。
- **SC-S06**: backfill 命令 IT/干跑覆盖 historyDepth 交易日迭代 + delta 从 lastWatermark 增量 + 与 cron 锁互斥。
- **SC-S07**: 真 vendor IT（`LIXINGER_TOKEN` / 东财）env-gated 默认 skip（沿用 `RUN_PERF_IT` 范式），本地/nightly 显式启用可验真实 universe/calendar/EOD 契约解析 + 真实限频不触 429。
- **SC-S08**: 端到端验证——本地启用真 vendor 跑一夜（或缩减集）后，015 读端点（search/quote/detail/bars）返真数据（非 fixtures），证明「让 015 端点有真数据」目标达成。

## Assumptions

- **消费 015 端口 + 写 015 schema**：本 feature 不重定义端口/事实表，只新增 3 配置/审计表 + universe/calendar live adapter + 同步管线 + 调度。Prisma `marketdata` schema 跨 015/016 增量演进。
- **vendor 限频是真瓶颈**（F4 双窗 1000/min·36/s）：复用 015 `VendorHttpClient` 双窗令牌桶；V1 全标的统一同步 + 顺延 + 幂等是应对限频封顶的组合（tier 序优先 = 分级 feature 增量）。
- **集群单例 HA 而非 fan-out**（master §B.4）：限频封顶 → 多实例无并行加速收益，调度只需分布式选主锁；BullMQ 三队列留盘中实时 seam。
- **重要度分级延后**（clarify 2026-06-03）：master §4.3 的确定性成员制分级（持仓/自选/追踪/预警并集 → T0）因四并集源表全未建而延后；watchlist（013）/ holdings 表落地后做独立 feature（`syncTier` 列已支持 0/1/2，无需迁移）。打分衰减留更后续升级。
- **cron 时刻配置化**（F7）：理杏仁 EOD 就绪时间未公开，保守经验测（18:00/20:00/22:00/次日 08:00）后调 `SyncDimension.cronExpr`，不硬编码。
- **规模 trivial**（F8）：全市场 10yr ≈ 5GB → 单 PG 不分区不归档；分区/冷存仅文档化 seam。
- **vendor 约束细节经验测**（master §7 风险）：批量 code 上限 / fsType 字段名 / adjust 语义 / 东财端点稳定性在 impl 的 env-gated 真 IT 阶段确认。
- **复用既有设施**：Cockatiel 重试（`auth/cockatiel-retry.executor.ts`）、cron per-row 范式（`account/anonymize-frozen-accounts.scheduler.ts`）、security Redis client、nestjs-cls trace_id——不重立。
- **V1 市场 = A 股**：港股次阶、美股待富途；schema/管线 market-agnostic 但 V1 验证集中 A 股。

## Out of Scope（本 feature 不做）

- **新读端点 / mobile 消费**——015 已落读端点；mobile UI 归 013/014。
- **重要度分级 + 跨 ctx 读 portfolio**——四并集源表（持仓/自选/追踪/预警）全未建，延后至 watchlist/holdings 落地后独立 feature（clarify 2026-06-03）；V1 全标的统一优先级同步，marketdata 保持叶子 context。
- **实时报价同步**——V1 仅 EOD-backed；盘中实时分级刷新 = BullMQ 升级 seam。
- **管理界面**——同步元数据 CRUD UI 属更后续。
- **港股/美股事实同步**——V1 集中 A 股。
- **点位时阶 universe / 退市史**——策略实验室阶段补（BaoStock sidecar 或买 Tushare 积分）；V1 东财当前快照，回测幸存者偏差届时解决。
- **分区/Parquet 冷存实装**——仅文档化 seam（>50GB / >200GB 触发）。
