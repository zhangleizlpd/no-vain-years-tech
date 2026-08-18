import { Module, type FactoryProvider } from '@nestjs/common';
import { SecurityModule } from '../security/security.module.js';
import { AccountModule } from '../account/account.module.js';
import { PrismaService } from '../security/prisma.service.js';
import { marketdataConfig, type MarketdataConfig } from '../config/marketdata.config.js';
import { MockMarketDataAdapter } from './mock-market-data.adapter.js';
import { refusingCollectionPort } from './refusing-collection.adapter.js';
import { VendorHttpClient } from './vendor-http-client.js';
import { LIXINGER_PROFILE } from './lixinger.constraint-profile.js';
import { EASTMONEY_PROFILE } from './eastmoney.constraint-profile.js';
import { TENCENT_PROFILE } from './tencent.constraint-profile.js';
import {
  FUTU_SHIM_EARNINGS_CALENDAR_PROFILE,
  FUTU_SHIM_OPTION_CHAIN_PROFILE,
  FUTU_SHIM_OPTION_SNAPSHOT_PROFILE,
  FUTU_SHIM_PROFILE,
} from './futu-shim.constraint-profile.js';
import { CBOE_PROFILE } from './cboe.constraint-profile.js';
import { LixingerEodBarAdapter } from './lixinger-eod-bar.adapter.js';
import { LixingerFundamentalAdapter } from './lixinger-fundamental.adapter.js';
import { LixingerFinancialsAdapter } from './lixinger-financials.adapter.js';
import { LixingerCorporateActionAdapter } from './lixinger-corporate-action.adapter.js';
import { LixingerShortSellingAdapter } from './lixinger-short-selling.adapter.js';
import { LixingerConnectHoldingAdapter } from './lixinger-connect-holding.adapter.js';
import { LixingerFundHoldingAdapter } from './lixinger-fund-holding.adapter.js';
import { LixingerFundCompanyHoldingAdapter } from './lixinger-fund-company-holding.adapter.js';
import { LixingerIndexMembershipAdapter } from './lixinger-index-membership.adapter.js';
import { LixingerVolatilityAdapter } from './lixinger-volatility.adapter.js';
import { LixingerHotAdapter } from './lixinger-hot.adapter.js';
import { LixingerBuybackAdapter } from './lixinger-buyback.adapter.js';
import { LixingerEquityChangeAdapter } from './lixinger-equity-change.adapter.js';
import { LixingerShareholderChangeAdapter } from './lixinger-shareholder-change.adapter.js';
import { LixingerAllotmentAdapter } from './lixinger-allotment.adapter.js';
import { LixingerRevenueSegmentAdapter } from './lixinger-revenue-segment.adapter.js';
import { LixingerShareholderSnapshotAdapter } from './lixinger-shareholder-snapshot.adapter.js';
import { LixingerEmployeeAdapter } from './lixinger-employee.adapter.js';
import { LixingerIndustryClassificationAdapter } from './lixinger-industry-classification.adapter.js';
import { LixingerAnnouncementAdapter } from './lixinger-announcement.adapter.js';
import { DbTradingCalendarAdapter } from './db-trading-calendar.adapter.js';
import { LixingerCompanyProfileAdapter } from './lixinger-company-profile.adapter.js';
import { EastmoneySearchAdapter } from './eastmoney-search.adapter.js';
import { EastmoneyUniverseAdapter } from './eastmoney-universe.adapter.js';
import { TencentCalendarAdapter } from './tencent-calendar.adapter.js';
import { StaticCalendarAdapter } from './static-calendar.adapter.js';
import { CalendarSourceFallbackChain } from './calendar-source-fallback-chain.adapter.js';
import { FutuCalendarAdapter } from './futu-calendar.adapter.js';
import { FutuUniverseAdapter } from './futu-universe.adapter.js';
import { FutuEodBarAdapter } from './futu-eod-bar.adapter.js';
import { FutuUnderlyingIvAdapter } from './futu-underlying-iv.adapter.js';
import { CboeUsIndexAdapter } from './cboe-us-index.adapter.js';
import { MarketRoutedEodBarAdapter } from './market-routed-eod-bar.adapter.js';
import { MarketRoutedCalendarSource } from './market-routed-calendar-source.adapter.js';
import { LixingerUniverseAdapter } from './lixinger-universe.adapter.js';
import { LocalInstrumentSearchAdapter } from './local-instrument-search.adapter.js';
import { FallbackChainAdapter } from './fallback-chain.adapter.js';
import { UniverseFallbackChainAdapter } from './universe-fallback-chain.adapter.js';
import { EodBackedQuoteAdapter } from './eod-backed-quote.adapter.js';
import { GetQuotesUseCase } from './get-quotes.usecase.js';
import { GetInstrumentDetailUseCase } from './get-instrument-detail.usecase.js';
import { GetInstrumentBarsUseCase } from './get-instrument-bars.usecase.js';
import { SearchInstrumentsUseCase } from './search-instruments.usecase.js';
import { SyncRunRecorder } from './sync-run.recorder.js';
import { SyncUniverseUseCase } from './sync-universe.usecase.js';
import { SyncOptionContractUseCase } from './sync-option-contract.usecase.js';
import { SyncOptionSnapshotUseCase } from './sync-option-snapshot.usecase.js';
import { SyncEarningsEventUseCase } from './sync-earnings-event.usecase.js';
import { SyncProfileUseCase } from './sync-profile.usecase.js';
import { SyncTierRecalc } from './sync-tier-recalc.js';
import { AnchorDrivenSyncGate } from './anchor-driven-sync-gate.js';
import { AnchorColdStartUseCase } from './anchor-cold-start.usecase.js';
import { AnchorColdStartSubscriber } from './anchor-cold-start.subscriber.js';
import { BackfillPacer, DEFAULT_BACKFILL_PACER_CONFIG } from './backfill-pacer.js';
import { DimensionExecutorRegistry } from './dimension-executor.js';
import { MarketdataSyncQueue } from './marketdata-sync.queue.js';
import { MarketdataSyncWorker } from './marketdata-sync.worker.js';
import { SyncTickDriver } from './sync-tick-driver.js';
import { CalendarHitCheck } from './calendar-hit-check.js';
import { FreshnessSlaCheck } from './freshness-sla.check.js';
import { OptionSnapshotCoverageCheck } from './option-snapshot-coverage.check.js';
import { OptionSnapshotRemediation } from './option-snapshot-remediation.js';
import { marketdataQueueRedisProviders } from './marketdata-queue-connection.js';
import { MarketdataController } from './marketdata.controller.js';
import { INSTRUMENT_SEARCH_PORT } from './instrument-search.port.js';
import {
  INSTRUMENT_UNIVERSE_PORT,
  type InstrumentUniversePort,
} from './instrument-universe.port.js';
import { COMPANY_PROFILE_PORT, type CompanyProfilePort } from './company-profile.port.js';
import { TRADING_CALENDAR_PORT } from './trading-calendar.port.js';
import {
  TRADING_CALENDAR_SOURCE,
  type TradingCalendarSource,
} from './trading-calendar-source.port.js';
import { TradingCalendarSyncService } from './trading-calendar-sync.service.js';
import { EOD_BAR_PORT, type EodBarPort } from './eod-bar.port.js';
import { UNDERLYING_IV_PORT, type UnderlyingIvPort } from './underlying-iv.port.js';
import { US_INDEX_PORT, type UsIndexPort } from './us-index.port.js';
import { FUNDAMENTAL_PORT, type FundamentalPort } from './fundamental.port.js';
import { FINANCIALS_PORT, type FinancialsPort } from './financials.port.js';
import { CORPORATE_ACTION_PORT, type CorporateActionPort } from './corporate-action.port.js';
import { SHORT_SELLING_PORT, type ShortSellingPort } from './short-selling.port.js';
import { CONNECT_HOLDING_PORT, type ConnectHoldingPort } from './connect-holding.port.js';
import { FUND_HOLDING_PORT, type FundHoldingPort } from './fund-holding.port.js';
import {
  FUND_COMPANY_HOLDING_PORT,
  type FundCompanyHoldingPort,
} from './fund-company-holding.port.js';
import { INDEX_MEMBERSHIP_PORT, type IndexMembershipPort } from './index-membership.port.js';
import { VOLATILITY_PORT, type VolatilityPort } from './volatility.port.js';
import { HOT_SNAPSHOT_PORT, type HotSnapshotPort } from './hot-snapshot.port.js';
import { BUYBACK_PORT, type BuybackPort } from './buyback.port.js';
import { EQUITY_CHANGE_PORT, type EquityChangePort } from './equity-change.port.js';
import { SHAREHOLDER_CHANGE_PORT, type ShareholderChangePort } from './shareholder-change.port.js';
import { ALLOTMENT_PORT, type AllotmentPort } from './allotment.port.js';
import { REVENUE_SEGMENT_PORT, type RevenueSegmentPort } from './revenue-segment.port.js';
import {
  SHAREHOLDER_SNAPSHOT_PORT,
  type ShareholderSnapshotPort,
} from './shareholder-snapshot.port.js';
import { EMPLOYEE_PORT, type EmployeePort } from './employee.port.js';
import {
  INDUSTRY_CLASSIFICATION_PORT,
  type IndustryClassificationPort,
} from './industry-classification.port.js';
import { ANNOUNCEMENT_PORT, type AnnouncementPort } from './announcement.port.js';
import { QUOTE_PORT } from './quote.port.js';
import { OPTION_CHAIN_PORT, type OptionChainPort } from './option-chain.port.js';
import { FutuOptionChainAdapter } from './futu-option-chain.adapter.js';
import { OPTION_SNAPSHOT_PORT, type OptionSnapshotPort } from './option-snapshot.port.js';
import { FutuOptionSnapshotAdapter } from './futu-option-snapshot.adapter.js';
import { EARNINGS_CALENDAR_PORT, type EarningsCalendarPort } from './earnings-calendar.port.js';
import { FutuEarningsCalendarAdapter } from './futu-earnings-calendar.adapter.js';

/** 全 Lixinger adapter 共一个 VendorHttpClient 实例 (共享双窗限频器 + 熔断配额)。 */
const LIXINGER_HTTP_CLIENT = Symbol('LIXINGER_HTTP_CLIENT');
/** 东财搜索专用 VendorHttpClient 实例 (东财 profile: 保守限频 + UA/Referer)。 */
const EASTMONEY_HTTP_CLIENT = Symbol('EASTMONEY_HTTP_CLIENT');
/** 腾讯 ifzq 日历源专用 VendorHttpClient 实例 (044; 腾讯 profile: 保守限频 + UA/Referer)。 */
const TENCENT_HTTP_CLIENT = Symbol('TENCENT_HTTP_CLIENT');
/** 富途 shim 专用 VendorHttpClient 实例 (sellput-viz Phase 1; 独立熔断态 —— 隧道故障不连坐其余源)。 */
const FUTU_HTTP_CLIENT = Symbol('FUTU_HTTP_CLIENT');
/** CBOE 官方历史 CSV 专用 VendorHttpClient 实例 (046 T012; 77 直连、极保守限频、独立熔断态)。 */
const CBOE_HTTP_CLIENT = Symbol('CBOE_HTTP_CLIENT');
/**
 * 期权链专用 VendorHttpClient 实例 (047 T014)。**同一个 shim, 但自己一个桶** —— shim 的限频闸
 * 是 per-capability 的 (`option_chain` 官方 10 次/30s vs 其余 60 次/30s), 共用 FUTU_HTTP_CLIENT
 * 会让一轮链发现 (12 票 × 10–14 窗) 把日线 / IV 的令牌一起吃光。
 */
const FUTU_OPTION_CHAIN_HTTP_CLIENT = Symbol('FUTU_OPTION_CHAIN_HTTP_CLIENT');
/**
 * 期权快照专用 VendorHttpClient 实例 (047 T016)。**又是自己一个桶** —— `snapshot` 官方
 * 60 次/30s, 挂在 `option_chain` 那个严 6 倍的桶上会让快照白排队 (且不会红); 与主画像共用则
 * 会把日线 / IV 的令牌吃光。
 */
const FUTU_OPTION_SNAPSHOT_HTTP_CLIENT = Symbol('FUTU_OPTION_SNAPSHOT_HTTP_CLIENT');
/**
 * 财报日历专用 VendorHttpClient 实例 (047 T018)。**第三个自己的桶** —— `earnings_calendar`
 * 官方 60 次/30s (T011a 已按官方值补登 shim 的 `LIMITS`), 挂在 `option_chain` 那个严 6 倍的桶
 * 上会让约 26 窗的财报采集白排队 (且不会红); 与主画像共用则会把日线 / IV 的令牌吃光。
 */
const FUTU_EARNINGS_CALENDAR_HTTP_CLIENT = Symbol('FUTU_EARNINGS_CALENDAR_HTTP_CLIENT');

/** `kind=live` 下 config 的收窄形态 —— `collectionPort` 的 `live` 回调只在这一支被调。 */
type LiveMarketdataConfig = Extract<MarketdataConfig, { kind: 'live' }>;

/**
 * **采集口** provider 工厂 (054 FR-004/FR-010) —— `kind=mock` 分支不在调用处写, 也**写不了**。
 *
 * 采集口的产出**必然被持久化** (逐 port 核过 consumer, 全是写手), 故 mock 下必须拒绝而不是
 * 给 fixture —— 否则伪造行情与真行情同形落进真表, 事后无从分辨 (2026-08-12 实撞)。把这个判断
 * 收进本 helper 之后, **新增采集口照抄邻居即自动继承约束**, 作者什么都不用多做。
 *
 * 🚨 **这是「结构性阻断」的兑现方式: 让对的事成为唯一能写的事, 而不是让错的事变红。**
 * 类型系统够不到这里 —— Nest 的 `provide` 是裸 `Symbol` (`InjectionToken`),
 * `FactoryProvider<T>` 的 `T` 从 `useFactory` **返回值反向推断**, token 与 `T` 之间零关联;
 * 加之 TS 是结构化类型, 收窄 `MockMarketDataAdapter` 的 `implements` 同样不产生任何约束
 * (两条均 2026-08-13 探针实测, 见 `specs/054-marketdata-mock-write-provenance/plan.md` D-2 证据表)。
 *
 * 读取口 (`QUOTE_PORT` / `TRADING_CALENDAR_PORT`) 与 `INSTRUMENT_SEARCH_PORT` **不走本 helper**,
 * 保留裸 provider 字面量 + 各自「为什么可以留 mock」的判据注释 —— 让偏离**看得见**。
 *
 * 显式的 `<XxxPort>` 类型参数不是装饰: 它顺带把 live 分支的返回物按端口接口校一遍
 * (此前 `useFactory` 的返回类型与端口接口零关联, 接错了也不报)。
 */
function collectionPort<T extends object>(
  token: symbol,
  opts: {
    inject?: NonNullable<FactoryProvider['inject']>;
    /**
     * 🚨 **方法简写语法是刻意的**: 它让参数走**双变**检查, 于是各 provider 可以把 `deps`
     * 逐个标成自己真正的依赖类型 (`http: VendorHttpClient` 等) 而不必在这里写 `any` ——
     * `inject` 数组与形参的对应关系本来就由 Nest 在运行时按位置解析, 类型层无从表达。
     */
    live(cfg: LiveMarketdataConfig, ...deps: unknown[]): T;
  },
): FactoryProvider<T> {
  return {
    provide: token,
    inject: [marketdataConfig.KEY, ...(opts.inject ?? [])],
    useFactory: (cfg: MarketdataConfig, ...deps: unknown[]): T =>
      cfg.kind === 'mock'
        ? refusingCollectionPort<T>(token.description ?? String(token))
        : opts.live(cfg, ...deps),
  };
}

/**
 * marketdata bounded context (015, 第 5 个 — 与 security/account/auth/portfolio 平级,
 * per ADR-0032 Q4 + ADR-0047 可插拔访问层)。
 *
 * 8 个 capability-scoped 端口经 config-driven DI 工厂绑定 adapter (discriminated-union
 * `kind: mock|live`): `kind=live` 缺 token → boot fail-fast (config zod parse, FR-S02)。
 * 消费者只依赖端口 Symbol + interface, 不感知背后 vendor / fallback。
 *
 * 🚨 **零 env (dev/test) 下不再是「全 Mock」(054)**: 端口按**意图**分三类 ——
 * ① **采集口 28 个** (产出必然被持久化) 走 `collectionPort` helper → 绑拒绝壳, 调用即抛;
 * ② **读取口 / 闸口 2 个** (`QUOTE_PORT` / `TRADING_CALENDAR_PORT`) 仍绑 Mock 单例;
 * ③ `INSTRUMENT_SEARCH_PORT` 本就不伪造数据 (直查真 Instrument 表), 照旧。
 * 因由: mock 行情与真行情同形, 经采集口一路落进真表后无从分辨 (2026-08-12 实撞)。
 *
 * 依赖 SecurityModule (PrismaService + Redis + 全局 ProblemDetailFilter + JwtModule)
 * + AccountModule (JwtAuthGuard + AccountIdThrottlerGuard, account-bound 鉴权 artefact
 * 经 export 复用 — 非业务 use-case 调用, 无 R2/R3 跨 ctx 注释)。marketdata 是**叶子**:
 * 零跨 ctx 业务调用 (intra only); 被 portfolio 反向只读消费属 016+。
 *
 * PR2 (T006): 4 个理杏仁事实端口 (EOD/估值/财报/公司行动) live 分支已接真 adapter,
 * 共享一个 `VendorHttpClient` (LIXINGER_HTTP_CLIENT)。QUOTE_PORT (T007) live = EOD-backed
 * 读 PG DailyBar。SEARCH 端口 live = `FallbackChain([东财, 本地 pg_trgm]`
 * (东财专用 EASTMONEY_HTTP_CLIENT)。CALENDAR (016 T003) + UNIVERSE (016 T007) live 已接真
 * adapter — 8 端口 live 分支全接线。
 */

@Module({
  imports: [SecurityModule, AccountModule],
  controllers: [MarketdataController],
  providers: [
    MockMarketDataAdapter,
    { provide: LIXINGER_HTTP_CLIENT, useFactory: () => new VendorHttpClient(LIXINGER_PROFILE) },
    { provide: EASTMONEY_HTTP_CLIENT, useFactory: () => new VendorHttpClient(EASTMONEY_PROFILE) },
    { provide: TENCENT_HTTP_CLIENT, useFactory: () => new VendorHttpClient(TENCENT_PROFILE) },
    { provide: FUTU_HTTP_CLIENT, useFactory: () => new VendorHttpClient(FUTU_SHIM_PROFILE) },
    { provide: CBOE_HTTP_CLIENT, useFactory: () => new VendorHttpClient(CBOE_PROFILE) },
    {
      provide: FUTU_OPTION_CHAIN_HTTP_CLIENT,
      useFactory: () => new VendorHttpClient(FUTU_SHIM_OPTION_CHAIN_PROFILE),
    },
    {
      provide: FUTU_OPTION_SNAPSHOT_HTTP_CLIENT,
      useFactory: () => new VendorHttpClient(FUTU_SHIM_OPTION_SNAPSHOT_PROFILE),
    },
    {
      provide: FUTU_EARNINGS_CALENDAR_HTTP_CLIENT,
      useFactory: () => new VendorHttpClient(FUTU_SHIM_EARNINGS_CALENDAR_PROFILE),
    },

    // ── 理杏仁事实端口 (kind=live → 真 adapter; kind=mock → 拒绝壳, 054) ──
    //
    // EOD 日线 **按市场路由** (sellput-viz): cn/hk → 理杏仁 candlestick (现状不动);
    // us → 富途 shim kline。理杏仁对 us 是代码层硬编码拒绝 (`toLixinger` 抛,
    // 「美股理杏仁仅 index 无个股」) ⇒ us 必须走独立 vendor。
    // 🚨 富途侧**只取不复权** (`AuType.NONE`): 存储模型自 020 起只物化 `adjust='none'` 一行、
    // 读时按 AdjustmentFactor 算 forward/backward, 塞复权价进 raw 槽会二次复权。
    collectionPort<EodBarPort>(EOD_BAR_PORT, {
      inject: [LIXINGER_HTTP_CLIENT, FUTU_HTTP_CLIENT],
      live: (cfg, lixHttp: VendorHttpClient, futuHttp: VendorHttpClient) => {
        const lixinger = new LixingerEodBarAdapter(lixHttp, cfg.lixingerToken, cfg.lixingerBaseUrl);
        return new MarketRoutedEodBarAdapter({
          cn: lixinger,
          hk: lixinger,
          us: new FutuEodBarAdapter(futuHttp, cfg.futuShimUrl, cfg.futuShimToken),
        });
      },
    }),

    // ── 标的级 IV 端口 (046 T007, FR-023): kind=live → 富途 shim `/overview` + `/his-vol` ──
    //
    // **不套 `MarketRouted*`**（与上面的 EOD 日线不同）：路由器的价值是「同一能力、多市场、多源」,
    // 而期权面本片只覆盖美股锚 ⇒ 路由表只会有一个 `us` 条目, 净增一层间接。非 us symbol 由
    // adapter 自己抛（零外呼），不静默返空 —— 返空会被同步管线记成「该标的今天没有 IV」。
    collectionPort<UnderlyingIvPort>(UNDERLYING_IV_PORT, {
      inject: [FUTU_HTTP_CLIENT],
      live: (cfg, futuHttp: VendorHttpClient) =>
        new FutuUnderlyingIvAdapter(futuHttp, cfg.futuShimUrl, cfg.futuShimToken),
    }),

    // ── 美股波动率指数端口 (046 T012, FR-025): kind=live → CBOE 官方历史 CSV (77 直连) ──
    //
    // **零 config 入参**（与上面两个富途端口不同）：源是公开 CDN 静态文件，无 token、无
    // baseUrl 可配 —— URL 全集就是 adapter 里那张常量表。这不是省事，是**合规红线的一部分**：
    // 让 URL 可配置就等于给「顺手改成盘中报价端点」留了一个不过 code review 的口子
    // （Guardrail 4 / p3b E1/E24）。⇒ 本端口**不新增任何 env**（SC-007 连带成立）。
    // ── 期权链端口 (047 T014, FR-039): kind=live → 富途 shim (`/option-expirations` +
    // `/option-chain`, 走自己的限频桶) ──
    //
    // 同 UNDERLYING_IV_PORT **不套 MarketRouted***: 期权面只覆盖美股锚, 路由表只会有一个
    // `us` 条目。非 us symbol 由 adapter 自己抛 (零外呼), 不静默返空。
    collectionPort<OptionChainPort>(OPTION_CHAIN_PORT, {
      inject: [FUTU_OPTION_CHAIN_HTTP_CLIENT],
      live: (cfg, chainHttp: VendorHttpClient) =>
        new FutuOptionChainAdapter(chainHttp, cfg.futuShimUrl, cfg.futuShimToken),
    }),

    // ── 期权快照端口 (047 T016, FR-030/039): kind=live → 富途 shim `/option-snapshot`
    // (走自己的 60/30s 桶) ──
    //
    // 同 OPTION_CHAIN_PORT 不套 MarketRouted*: 期权面只覆盖美股锚, 非 us symbol 由 adapter
    // 自己抛 (零外呼)。标的 spot 由 adapter 并进同一批 codes, **不另配 QUOTE_PORT 依赖**。
    collectionPort<OptionSnapshotPort>(OPTION_SNAPSHOT_PORT, {
      inject: [FUTU_OPTION_SNAPSHOT_HTTP_CLIENT],
      live: (cfg, snapshotHttp: VendorHttpClient) =>
        new FutuOptionSnapshotAdapter(snapshotHttp, cfg.futuShimUrl, cfg.futuShimToken),
    }),

    // ── 财报日历端口 (047 T018, FR-034/039): kind=live → 富途 shim `/earnings-calendar`
    // (走自己的 60/30s 桶) ──
    //
    // 🚨 **市场级**端口: 入参是 market + 日期窗, 没有标的 —— 不套 MarketRouted*, 非 us market
    // 由 adapter 自己抛 (零外呼)。它对应的维度**不挂锚闸** (Guardrail 2), 与上面两个 per-code
    // 端口判据相反。
    collectionPort<EarningsCalendarPort>(EARNINGS_CALENDAR_PORT, {
      inject: [FUTU_EARNINGS_CALENDAR_HTTP_CLIENT],
      live: (cfg, earningsHttp: VendorHttpClient) =>
        new FutuEarningsCalendarAdapter(earningsHttp, cfg.futuShimUrl, cfg.futuShimToken),
    }),

    collectionPort<UsIndexPort>(US_INDEX_PORT, {
      inject: [CBOE_HTTP_CLIENT],
      live: (_cfg, cboeHttp: VendorHttpClient) => new CboeUsIndexAdapter(cboeHttp),
    }),
    collectionPort<FundamentalPort>(FUNDAMENTAL_PORT, {
      inject: [LIXINGER_HTTP_CLIENT, PrismaService],
      live: (cfg, http: VendorHttpClient, prisma: PrismaService) =>
        new LixingerFundamentalAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl, prisma),
    }),
    collectionPort<FinancialsPort>(FINANCIALS_PORT, {
      inject: [LIXINGER_HTTP_CLIENT, PrismaService],
      live: (cfg, http: VendorHttpClient, prisma: PrismaService) =>
        new LixingerFinancialsAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl, prisma),
    }),
    collectionPort<CorporateActionPort>(CORPORATE_ACTION_PORT, {
      inject: [LIXINGER_HTTP_CLIENT],
      live: (cfg, http: VendorHttpClient) =>
        new LixingerCorporateActionAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl),
    }),
    // 039 T006 US1 做空日频端口: kind=live → 理杏仁 short-selling adapter
    // (无 fsType → 无-Prisma 工厂分支, 同 EOD/corp)。
    collectionPort<ShortSellingPort>(SHORT_SELLING_PORT, {
      inject: [LIXINGER_HTTP_CLIENT],
      live: (cfg, http: VendorHttpClient) =>
        new LixingerShortSellingAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl),
    }),
    // 039 T007 US1 南向持股日频端口: kind=live → 理杏仁 mutual-market adapter。
    collectionPort<ConnectHoldingPort>(CONNECT_HOLDING_PORT, {
      inject: [LIXINGER_HTTP_CLIENT],
      live: (cfg, http: VendorHttpClient) =>
        new LixingerConnectHoldingAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl),
    }),
    // 039 T011 US2 公募基金持股端口: kind=live → 理杏仁 fund-shareholders adapter。
    collectionPort<FundHoldingPort>(FUND_HOLDING_PORT, {
      inject: [LIXINGER_HTTP_CLIENT],
      live: (cfg, http: VendorHttpClient) =>
        new LixingerFundHoldingAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl),
    }),
    // 039 T012 US2 基金公司持股端口: kind=live → 理杏仁 fund-collection-shareholders adapter。
    collectionPort<FundCompanyHoldingPort>(FUND_COMPANY_HOLDING_PORT, {
      inject: [LIXINGER_HTTP_CLIENT],
      live: (cfg, http: VendorHttpClient) =>
        new LixingerFundCompanyHoldingAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl),
    }),
    // 039 T015 US3 所属指数端口: kind=live → 理杏仁 indices adapter (无 date 快照)。
    collectionPort<IndexMembershipPort>(INDEX_MEMBERSHIP_PORT, {
      inject: [LIXINGER_HTTP_CLIENT],
      live: (cfg, http: VendorHttpClient) =>
        new LixingerIndexMembershipAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl),
    }),
    // 040 T005 US1 波动率日频端口: kind=live → 理杏仁 volatility adapter (单数 stockCode + volatilityDays
    // number 单数, 多窗口循环由 executor 驱动; 无 fsType → 无-Prisma 工厂分支, 同 EOD/short-selling)。
    collectionPort<VolatilityPort>(VOLATILITY_PORT, {
      inject: [LIXINGER_HTTP_CLIENT],
      live: (cfg, http: VendorHttpClient) =>
        new LixingerVolatilityAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl),
    }),
    // 040 T008 US2 热度精选快照端口: kind=live → 理杏仁 hot adapter (数组 stockCodes[], HOT_TYPES 循环由
    // executor 驱动, 忽略 undefined key; 无 fsType → 无-Prisma 工厂分支, 同 EOD/short-selling)。
    collectionPort<HotSnapshotPort>(HOT_SNAPSHOT_PORT, {
      inject: [LIXINGER_HTTP_CLIENT],
      live: (cfg, http: VendorHttpClient) =>
        new LixingerHotAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl),
    }),
    // 041 T005 US1 回购事件端口: kind=live → 理杏仁 repurchase adapter (单数 stockCode + range,
    // 丰富 typed 字段; 无 fsType → 无-Prisma 工厂分支, 同 EOD/short-selling)。
    collectionPort<BuybackPort>(BUYBACK_PORT, {
      inject: [LIXINGER_HTTP_CLIENT],
      live: (cfg, http: VendorHttpClient) =>
        new LixingerBuybackAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl),
    }),
    // 041 T008 US2 股本变动事件端口: kind=live → 理杏仁 equity-change adapter (单数 stockCode + range,
    // 扁平字段; 无 fsType → 无-Prisma 工厂分支, 同 EOD/short-selling)。
    collectionPort<EquityChangePort>(EQUITY_CHANGE_PORT, {
      inject: [LIXINGER_HTTP_CLIENT],
      live: (cfg, http: VendorHttpClient) =>
        new LixingerEquityChangeAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl),
    }),
    // 041 T011 US3 股东权益变动事件端口: kind=live → 理杏仁 shareholders-equity-change adapter (单数
    // stockCode + range, 嵌套 L/S payload; 无 fsType → 无-Prisma 工厂分支, 同 EOD/short-selling)。
    collectionPort<ShareholderChangePort>(SHAREHOLDER_CHANGE_PORT, {
      inject: [LIXINGER_HTTP_CLIENT],
      live: (cfg, http: VendorHttpClient) =>
        new LixingerShareholderChangeAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl),
    }),
    // 041 T014 US4 配股事件端口: kind=live → 理杏仁 allotment adapter (单数 stockCode + range, payload
    // 整存 vendor 行, 港股极罕见零样本; 无 fsType → 无-Prisma 工厂分支, 同 EOD/short-selling)。
    collectionPort<AllotmentPort>(ALLOTMENT_PORT, {
      inject: [LIXINGER_HTTP_CLIENT],
      live: (cfg, http: VendorHttpClient) =>
        new LixingerAllotmentAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl),
    }),
    // 042 T005 US1 营收构成端口: kind=live → 理杏仁 operation-revenue-constitution adapter (单数 stockCode +
    // range, dataList 展开 typed 子行; 无 fsType → 无-Prisma 工厂分支, 同 EOD/short-selling)。
    collectionPort<RevenueSegmentPort>(REVENUE_SEGMENT_PORT, {
      inject: [LIXINGER_HTTP_CLIENT],
      live: (cfg, http: VendorHttpClient) =>
        new LixingerRevenueSegmentAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl),
    }),
    // 042 T008 US2 最新股东端口: kind=live → 理杏仁 latest-shareholders adapter (单数 stockCode + range,
    // 嵌套 L/S/P payload + contentHash; 无 fsType → 无-Prisma 工厂分支, 同 EOD/short-selling)。
    collectionPort<ShareholderSnapshotPort>(SHAREHOLDER_SNAPSHOT_PORT, {
      inject: [LIXINGER_HTTP_CLIENT],
      live: (cfg, http: VendorHttpClient) =>
        new LixingerShareholderSnapshotAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl),
    }),
    // 042 T011 US3 员工端口: kind=live → 理杏仁 employee adapter (单数 stockCode + range, dataList 展开 typed
    // 子行 + displayType 进 NK; 无 fsType → 无-Prisma 工厂分支, 同 EOD/short-selling)。
    collectionPort<EmployeePort>(EMPLOYEE_PORT, {
      inject: [LIXINGER_HTTP_CLIENT],
      live: (cfg, http: VendorHttpClient) =>
        new LixingerEmployeeAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl),
    }),
    // 043 T005 US1 所属行业端口: kind=live → 理杏仁 industries adapter (单数 stockCode + 无 date 覆盖式快照;
    // 无 fsType → 无-Prisma 工厂分支, 同 EOD/index_membership)。
    collectionPort<IndustryClassificationPort>(INDUSTRY_CLASSIFICATION_PORT, {
      inject: [LIXINGER_HTTP_CLIENT],
      live: (cfg, http: VendorHttpClient) =>
        new LixingerIndustryClassificationAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl),
    }),
    // 043 T008 US2 公告端口: kind=live → 理杏仁 announcement adapter (单数 stockCode + range, 只存元数据
    // linkUrl/linkText/linkType/types; 无 fsType → 无-Prisma 工厂分支, 同 EOD/buyback)。
    collectionPort<AnnouncementPort>(ANNOUNCEMENT_PORT, {
      inject: [LIXINGER_HTTP_CLIENT],
      live: (cfg, http: VendorHttpClient) =>
        new LixingerAnnouncementAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl),
    }),

    // ── EOD-backed 报价端口 (T007): kind=live → 读 PG DailyBar; kind=mock → Mock 单例 ──
    //
    // 🚨 **它是 054 之后仅存的两个仍绑 mock 的端口之一, 故蓄意保留裸字面量而不走
    //    `collectionPort` —— 偏离要看得见。** 判据: 消费方 `get-quotes.usecase.ts` 零
    //    `prisma.` 引用, 实证只读 ⇒ mock fixture 不会落进任何表。
    {
      provide: QUOTE_PORT,
      inject: [marketdataConfig.KEY, MockMarketDataAdapter, PrismaService],
      useFactory: (cfg: MarketdataConfig, mock: MockMarketDataAdapter, prisma: PrismaService) =>
        cfg.kind === 'mock' ? mock : new EodBackedQuoteAdapter(prisma),
    },
    // ── 搜索端口 (T014): kind=live → FallbackChain([东财, 本地 pg_trgm]); kind=mock → 本地
    //    pg_trgm (不造搜索 fixture, 直查已 seed 的 Instrument 表 — 与 live 备援同 adapter,
    //    dev 手测搜索语义贴近生产; mock universe 同步后 fixture 标的即可搜) ──
    //
    //    054: 它**本来就不伪造数据** (mock 分支查的是真 Instrument 表), 故既不入拒绝壳、
    //    也不在「仍绑 mock」之列 —— 是第三种情况, 照旧。
    {
      provide: INSTRUMENT_SEARCH_PORT,
      inject: [marketdataConfig.KEY, EASTMONEY_HTTP_CLIENT, PrismaService],
      useFactory: (cfg: MarketdataConfig, http: VendorHttpClient, prisma: PrismaService) =>
        cfg.kind === 'mock'
          ? new LocalInstrumentSearchAdapter(prisma)
          : new FallbackChainAdapter([
              new EastmoneySearchAdapter(http, cfg.eastmoneyBaseUrl),
              new LocalInstrumentSearchAdapter(prisma),
            ]),
    },

    // 报价读 use case (Redis 热快照 → QUOTE_PORT)。端点 (EP2) 落 T009。
    GetQuotesUseCase,
    // 详情 + K线读 use case (EP3/EP4, 直读 PG 物化事实, T008)。
    GetInstrumentDetailUseCase,
    GetInstrumentBarsUseCase,
    // 搜索 use case (EP1, 经 INSTRUMENT_SEARCH_PORT, T014)。
    SearchInstrumentsUseCase,

    // ── 同步层 (016) ──
    // SyncRun 审计/水位记录器 (T004): 同步管线 + scheduler + backfill 共用。
    SyncRunRecorder,
    // universe 同步 use case (T008): enumerate→黑名单→pinyin→upsert Instrument。
    SyncUniverseUseCase,
    // 047 T015 链发现维度 use case (DimensionExecutorRegistry 尾部第 30 位注入面)。
    SyncOptionContractUseCase,
    // 047 T016 逐日快照维度 use case (同上, 尾部第 31 位)。
    SyncOptionSnapshotUseCase,
    // 047 T019 财报日历维度 use case (同上, 尾部第 32 位)。🚨 它**不接受工作集入参** ——
    // 市场级接口, 工作集是固定前向时间窗序列, 不挂锚闸 (FR-035a)。
    SyncEarningsEventUseCase,
    // profile 富化 use case (T010): 缺 fsType 的 cn 标的 → COMPANY_PROFILE_PORT 解析回写缓存。
    SyncProfileUseCase,
    // syncTier 重算 (018 T001): fact 维度 executor 前置 Q7-B 直查自选并集 → 落 syncTier。
    SyncTierRecalc,
    // 045 T015 采集闸重算 (FR-028/FR-029): DimensionExecutorRegistry 的尾部可选注入面 ——
    // 按 optionsdesk 锚表刷 us 标的 needSync。**反向跨 ctx 只读**, optionsdesk 不被注册进
    // 本模块的 SyncDimension / executor 钩子 (方向铁律: 底座不依赖业务)。
    AnchorDrivenSyncGate,
    // 回填自限速节流器 (038 T017, INV-3): DimensionExecutorRegistry 注入面 (enabled 生产实例,
    // ~600/min + jitter 叠加软护栏)。共享 lixinger.constraint-profile.ts 900/min 桶不动。
    { provide: BackfillPacer, useFactory: () => new BackfillPacer(DEFAULT_BACKFILL_PACER_CONFIG) },

    // ── 调度重构 (017) ──
    // 队列专用 Redis 连接 (T002, plan D1): bullmq 要求 maxRetriesPerRequest=null,
    // 与共享 REDIS_CLIENT 配置冲突 → 独立连接 + lifecycle close。
    ...marketdataQueueRedisProviders,
    // per-dimension executor 注册表 (T008): 016 管线 4 fact 方法 + universe/profile 包装
    // 升格的统一执行面 (PR-7 清退旧 22:00 聚合管线后, worker 是唯一消费方)。
    DimensionExecutorRegistry,
    // 队列入队面 + 维度 worker (T009): 单 queue `marketdata-sync` concurrency=1;
    // MARKETDATA_WORKER_DISABLED sentinel 置位 (CLI 进程, D6) → worker 不启动。
    MarketdataSyncQueue,
    MarketdataSyncWorker,
    // 060 T005-T007 锚首建冷启动编排: 由 worker 的 `sync:anchor-cold-start` 分支路由
    // (**不**进 DimensionExecutorRegistry —— 它是事件驱动的一次性补数, 不是周期维度)。
    AnchorColdStartUseCase,
    // 060 T008 建锚事件消费方 (R3 CROSS-CONTEXT-ASYNC 消费端): OnModuleInit 自注册进平台层
    // OutboxSubscriberRegistry, 只做「校验 + 入队」—— relay 是单线 cron, 采集必须异步。
    AnchorColdStartSubscriber,
    // PG 真相层 tick 驱动 (T013/T014): 分钟级 @Cron 扫 nextFireAt → 条件 UPDATE 抢占 →
    // 交易日 gate → D3 装配组 flow; MARKETDATA_TICK_ENABLED 灰度 flag 默认关 (US7)。
    SyncTickDriver,
    // 日历命中检查 (019 T013/T014, D6): event-calendar 维度 tick gate 的 source 路由
    // 注册表; live source 现状空 (T001 探测无披露日历端点, financial 落 slow-drift)。
    CalendarHitCheck,
    // 新鲜度 SLA 检查 (019 T017, D9): 每日 08:30 Asia/Shanghai 扫 sla_hours 维度,
    // 超期结构化 ERROR (交易日历折算, 休市/skipped 不误报)。
    FreshnessSlaCheck,
    // 047 T021 期权快照完整性核对 (FR-045): 逐票逐合约覆盖率判定 + 结构化 ERROR log。
    // 判据挂**数据**不挂 run; 触达是另一件事 (ops/jobs/marketdata-snapshot-integrity 独立 timer)。
    OptionSnapshotCoverageCheck,
    // 047 T022 两级自动补救 (FR-046/052): ① 每日 08:00 当日重试 ② 每日 18:00 (美股盘前窗)
    // 兜底重采上一交易日, 落 source=premarket_backfill 的降级痕; 两级都失败才升 ERROR。
    OptionSnapshotRemediation,
    // 交易日历填充服务 (sync-1 S1-T2): 每日 21:00 Asia/Shanghai (早于 22:00 tick) 拉指数
    // 日历落 trading_day; tickEnabled 灰度 flag 短路 (与 tick 同门, dev/test 不外呼)。
    TradingCalendarSyncService,

    // ── 交易日历端口 (sync-1 S1-T4, 去理杏仁化): kind=live → 读 trading_day 表
    //    (DbTradingCalendarAdapter, 由 TradingCalendarSyncService populate); kind=mock → Mock。
    //    旧 Lixinger 指数 candlestick 派生已退役 (付费墙 403 打挂夜间同步)。──
    //
    //    🚨 **它是 054 之后仅存的两个仍绑 mock 的端口之一, 故蓄意保留裸字面量而不走
    //    `collectionPort`。** 判据: 它是**闸口不是采集口** —— 形态是读, 三个消费方
    //    (`sync-tick-driver` / `option-snapshot-remediation` / `freshness-sla.check`) 里
    //    `freshness-sla.check` 是只读检查, 拒了它 dev 下这类检查全起不来 (违 FR-009)。
    //    伪造日历放行之后, 写手会在**下一步**撞上采集口的拒绝壳 —— 拦截点后移一格,
    //    结果相同: 零写库 (054 plan D-3)。
    {
      provide: TRADING_CALENDAR_PORT,
      inject: [marketdataConfig.KEY, MockMarketDataAdapter, PrismaService],
      useFactory: (cfg: MarketdataConfig, mock: MockMarketDataAdapter, prisma: PrismaService) =>
        cfg.kind === 'mock' ? mock : new DbTradingCalendarAdapter(prisma),
    },

    // ── 交易日历源 (044 T008 + sellput-viz Phase 1 #5): kind=live → 按市场路由到各自的
    //    fallback 链; kind=mock → Mock (周一~周五)。TradingCalendarSyncService 的写入源,
    //    与上面 TRADING_CALENDAR_PORT (读表) 解耦。
    //
    //    **旧东财指数 kline 源已退役** (FR-007): 端点被定向下线 + robots.txt `Disallow: /` →
    //    日历填充静默停摆 2 天。换源治不了根 —— 单点 + 无降级 + 无告警才是根因 ⇒ 上链 +
    //    合理性闸 + 心跳/探针。降级**必被观测**: 胜出节点自报 servedBy → 心跳落库 → 探针告警
    //    (FR-014)。
    //
    //    **cn / hk** = `[腾讯 L1, 静态离线 L2]` (044 原样): 腾讯 ifzq 免费指数 kline, PoC 交叉
    //    校验 hk 128/128 + cn 126/126 零差异; L1 挂 → L2 静态年历兜底 (仅 cn/hk + 仅当年,
    //    蓄意有限 —— 见 static adapter 绊线)。
    //
    //    **us** = `[富途 L1, 腾讯 L2]` (Phase 1 #5, 044 绊线处置): 6 个 `{us}`-only 期权维度
    //    即将上线 ⇒ static adapter 那条「当前无 {us}-only 维度」的绊线前提失效, us 不能再由
    //    腾讯单源独撑。富途 = 持牌券商官方接口 + 带半日市标记 + 与期权维度同源 → 接 L1,
    //    腾讯降 L2。
    //    🚨 **us 蓄意无 L3** (user 2026-07-31 拍板): 静态层不补 us。理由 = 两个活源走**不同
    //    物理通路** (富途经 B↔C WireGuard 隧道 / 腾讯经公网直连), 且探针已把 us 纳入监控
    //    (26h 内必报) ⇒ 双源全挂时人工 seed 可救; 而补 us 静态表要新建一条 NYSE 假日采集 +
    //    人工年更 = 新 drift 面, 且反映不了临时休市。**改这里前先读 static-calendar.adapter.ts
    //    的绊线段。**──
    collectionPort<TradingCalendarSource>(TRADING_CALENDAR_SOURCE, {
      inject: [TENCENT_HTTP_CLIENT, FUTU_HTTP_CLIENT],
      live: (cfg, tencentHttp: VendorHttpClient, futuHttp: VendorHttpClient) => {
        // 腾讯节点在两条链里共享同一实例 → 共享其 VendorHttpClient 的限频桶与熔断状态
        // (两条链打的是同一个 vendor, 各算各的会双倍打向对方)。
        const tencent = new TencentCalendarAdapter(tencentHttp, cfg.tencentCalendarBaseUrl);
        const cnHkChain = new CalendarSourceFallbackChain([tencent, new StaticCalendarAdapter()]);
        const usChain = new CalendarSourceFallbackChain([
          new FutuCalendarAdapter(futuHttp, cfg.futuShimUrl, cfg.futuShimToken),
          tencent,
        ]);
        return new MarketRoutedCalendarSource({ cn: cnHkChain, hk: cnHkChain, us: usChain });
      },
    }),

    // ── universe 枚举端口 (016 T007 + ADR-0047 Amendment 2026-06-03 + sellput-viz Phase 1 #4):
    //    kind=live → FallbackChain [理杏仁 → 富途 → 东财]; kind=mock → Mock。
    //    链是 **per-market** 的 (`UniverseFallbackChainAdapter`)，且降级判据 = 「抛错**或返空**
    //    则平移下一节点」，故各节点只需覆盖自己支持的市场、其余返空即可：
    //      · cn/hk → 理杏仁 /cn/company 全集枚举命中即停 (可靠付费主源)，挂了落东财 clist (逆向备源)
    //      · us    → 理杏仁与东财均返空 → 富途 `get_stock_basicinfo` 承担
    //    per-provider 熔断由各 VendorHttpClient 传输层承担。
    //
    //    🚨 **东财的 us 路径已随本次换源退役**（见 `eastmoney-universe.adapter.ts` 的
    //    MARKET_TO_FS 🪦 段）：它一直在**静默少收**（服务端 100 条/响应硬封顶 × 500 游标 ⇒
    //    2800/13683，且按 code 降序截断到 AAPL 都搜不到）。**别把它加回来当 us 备源** ——
    //    链只在返空时平移，一个「非空但残缺」的节点会在富途故障时静默接住并写入残缺 universe。
    //    us 宁可整链耗尽返空（fail-soft：`SyncUniverseUseCase` scanned=0，DB 沿用既有清单）。──
    collectionPort<InstrumentUniversePort>(INSTRUMENT_UNIVERSE_PORT, {
      inject: [LIXINGER_HTTP_CLIENT, EASTMONEY_HTTP_CLIENT, FUTU_HTTP_CLIENT],
      live: (
        cfg,
        lixHttp: VendorHttpClient,
        emHttp: VendorHttpClient,
        futuHttp: VendorHttpClient,
      ) =>
        new UniverseFallbackChainAdapter([
          new LixingerUniverseAdapter(lixHttp, cfg.lixingerToken, cfg.lixingerBaseUrl),
          new FutuUniverseAdapter(futuHttp, cfg.futuShimUrl, cfg.futuShimToken),
          new EastmoneyUniverseAdapter(emHttp, cfg.eastmoneyClistBaseUrl),
        ]),
    }),

    // ── 公司画像端口 (016 T010): kind=live → Lixinger /cn/company fsType 解析+缓存 ──
    collectionPort<CompanyProfilePort>(COMPANY_PROFILE_PORT, {
      inject: [LIXINGER_HTTP_CLIENT, PrismaService],
      live: (cfg, http: VendorHttpClient, prisma: PrismaService) =>
        new LixingerCompanyProfileAdapter(http, cfg.lixingerToken, cfg.lixingerBaseUrl, prisma),
    }),
  ],
})
export class MarketdataModule {}
