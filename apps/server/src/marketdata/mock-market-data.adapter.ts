import { Injectable } from '@nestjs/common';
import type { CompanyProfilePort } from './company-profile.port.js';
import type {
  TradingCalendarFetchResult,
  TradingCalendarSource,
} from './trading-calendar-source.port.js';
import type { InstrumentUniversePort } from './instrument-universe.port.js';
import type { TradingCalendarPort } from './trading-calendar.port.js';
import type { TradingDayStatus } from './trading-day.rules.js';
import type { EodBarPort } from './eod-bar.port.js';
import type { FundamentalPort } from './fundamental.port.js';
import type { FinancialsPort } from './financials.port.js';
import type { CorporateActionPort } from './corporate-action.port.js';
import type { QuotePort } from './quote.port.js';
import type { ShortSellingPort } from './short-selling.port.js';
import type { ConnectHoldingPort } from './connect-holding.port.js';
import type { FundHoldingPort } from './fund-holding.port.js';
import type { FundCompanyHoldingPort } from './fund-company-holding.port.js';
import type { IndexMembershipPort } from './index-membership.port.js';
import type { IndustryClassificationPort } from './industry-classification.port.js';
import type { VolatilityPort } from './volatility.port.js';
import type { HotSnapshotPort } from './hot-snapshot.port.js';
import type { BuybackPort } from './buyback.port.js';
import type { EquityChangePort } from './equity-change.port.js';
import type { ShareholderChangePort } from './shareholder-change.port.js';
import type { AllotmentPort } from './allotment.port.js';
import type { RevenueSegmentPort } from './revenue-segment.port.js';
import type { ShareholderSnapshotPort } from './shareholder-snapshot.port.js';
import type { EmployeePort } from './employee.port.js';
import type { AnnouncementPort } from './announcement.port.js';
import type {
  UnderlyingIvHistoryPoint,
  UnderlyingIvHistoryQuery,
  UnderlyingIvPort,
  UnderlyingIvSnapshot,
} from './underlying-iv.port.js';
import type { UsIndexCode, UsIndexHistory, UsIndexPort } from './us-index.port.js';
import type {
  OptionChainPort,
  OptionChainWindowQuery,
  OptionContractStatic,
  OptionExpiry,
} from './option-chain.port.js';
import type {
  OptionSnapshotBatch,
  OptionSnapshotPort,
  OptionSnapshotQuery,
  OptionSnapshotRow,
} from './option-snapshot.port.js';
import type {
  EarningsCalendarEvent,
  EarningsCalendarPort,
  EarningsCalendarWindowQuery,
} from './earnings-calendar.port.js';
import type {
  AllotmentDto,
  AllotmentRangeQuery,
  AnnouncementDto,
  AnnouncementRangeQuery,
  EmployeeDto,
  EmployeeRangeQuery,
  RevenueSegmentDto,
  RevenueSegmentRangeQuery,
  ShareholderSnapshotDto,
  ShareholderSnapshotRangeQuery,
  BuybackDto,
  BuybackRangeQuery,
  EquityChangeDto,
  EquityChangeRangeQuery,
  ShareholderChangeDto,
  ShareholderChangeRangeQuery,
  ConnectHoldingPoint,
  ConnectHoldingRangeQuery,
  CorporateActionDto,
  EodBarPoint,
  EodBarQuery,
  FinancialMetricDto,
  FinancialsRangeQuery,
  FundamentalRangeQuery,
  FundamentalSnapshotDto,
  FundCompanyHoldingDto,
  FundCompanyHoldingRangeQuery,
  FundHoldingDto,
  FundHoldingRangeQuery,
  HotSnapshotDto,
  HotSnapshotQuery,
  IndexMembershipDto,
  IndustryClassificationDto,
  QuoteSnapshot,
  ShortSellingPoint,
  ShortSellingRangeQuery,
  UniverseEntry,
  VolatilityPoint,
  VolatilityRangeQuery,
} from './marketdata.types.js';

/**
 * Mock 市场数据 adapter — 零 env (dev/test) 默认的事实端口实现 (FR-S03)。
 *
 * 返**确定性** fixtures (无随机, 无外呼), 让全套 IT 无需真 vendor 凭证即可跑。
 *
 * 🚨 **054 起它不再是 kind=mock 的通吃实现**。DI 只在两个口上绑它:
 * `QUOTE_PORT` (读取口) 与 `TRADING_CALENDAR_PORT` (闸口) —— 二者都不写库。**28 个采集口
 * 在 kind=mock 下绑 `refusing-collection.adapter.ts` 的拒绝壳**, 因为采集口的产出必然被
 * 持久化, 而 mock 行情与真行情同形, 落进真表后无从分辨 (2026-08-12 实撞)。
 * 例外: SEARCH 端口 kind=mock 走 `LocalInstrumentSearchAdapter` 直查已 seed 的
 * Instrument 表 (与 live 备援同 adapter), 不在此造搜索 fixture。
 *
 * 📌 **`implements` 列表蓄意保持全量、不随之收窄**: 它对采集口接口的实现自 054 起只服务
 * **测试内的 stub 用途** (数十个 IT 拿它当「其余端口」的 no-data 桩), 而 `implements` 仍在
 * 保证这些方法的签名不与端口接口漂移。收窄它零强制力 (TS 是结构化类型, 且 Nest 的端口
 * token 与工厂返回类型零关联 —— 054 探针实测), 只会白丢这道签名检查。
 *
 * fixture 标的: cn:600519 (贵州茅台) — 详情/报价/K线有数据; 其余 symbol 视为 no-data。
 */
@Injectable()
export class MockMarketDataAdapter
  implements
    InstrumentUniversePort,
    CompanyProfilePort,
    TradingCalendarPort,
    TradingCalendarSource,
    EodBarPort,
    FundamentalPort,
    FinancialsPort,
    CorporateActionPort,
    QuotePort,
    ShortSellingPort,
    ConnectHoldingPort,
    FundHoldingPort,
    FundCompanyHoldingPort,
    IndexMembershipPort,
    IndustryClassificationPort,
    VolatilityPort,
    HotSnapshotPort,
    BuybackPort,
    EquityChangePort,
    ShareholderChangePort,
    AllotmentPort,
    RevenueSegmentPort,
    ShareholderSnapshotPort,
    EmployeePort,
    AnnouncementPort,
    UnderlyingIvPort,
    UsIndexPort,
    OptionChainPort,
    OptionSnapshotPort,
    EarningsCalendarPort
{
  private static readonly MAOTAI = 'cn:600519';

  /**
   * 标的级 IV 的 fixture 标的 (046)。**不是茅台** —— 期权面本片只覆盖美股锚,
   * 给 cn 标的编 IV 会让 mock 长出一个真源里不存在的形状。
   */
  private static readonly PEP = 'us:PEP';

  async enumerate(markets: string[]): Promise<UniverseEntry[]> {
    // Mock 仅 cn fixtures (dev/test 零外呼); 按请求 markets 过滤 (S2-T2 签名对齐)。
    const all: UniverseEntry[] = [
      { market: 'cn', code: '600519', name: '贵州茅台' },
      { market: 'cn', code: '000001', name: '平安银行' },
      { market: 'cn', code: '430047', name: '诺思格' }, // 北交所
    ];
    return all.filter((e) => markets.includes(e.market));
  }

  async resolveCompanyTypes(_market: string, _codes: string[]): Promise<Map<string, string>> {
    // mock fundamental 不按 fsType 路由 → profile 富化无需解析, 返空 (零外呼)。
    return new Map();
  }

  async classify(_market: string, date: string): Promise<TradingDayStatus> {
    // 确定性: 周一~周五视为交易日 (Mock 不查节假日)。
    // 062 T006: Mock 的日历**自身就是判据**, 不存在「还没填到」这回事 ⇒ 恒不返 `unknown`,
    // 三态在 dev/test 下退化成两态, 与改动前的布尔逐点等价 (零行为变更)。
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    return day >= 1 && day <= 5 ? 'trading' : 'non-trading';
  }

  async fetchTradingDates(
    _market: string,
    from: string,
    to: string,
  ): Promise<TradingCalendarFetchResult> {
    // 确定性: [from, to] 内周一~周五视为交易日 (与 classify mock 同口径, 无外呼)。
    const dates: string[] = [];
    const end = new Date(`${to}T00:00:00Z`);
    for (let d = new Date(`${from}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const day = d.getUTCDay();
      if (day >= 1 && day <= 5) dates.push(d.toISOString().slice(0, 10));
    }
    return { dates, servedBy: 'mock' };
  }

  async getBars(query: EodBarQuery): Promise<EodBarPoint[]> {
    if (query.symbol !== MockMarketDataAdapter.MAOTAI) return [];
    const point: EodBarPoint = {
      tradeDate: '2026-06-01',
      adjust: query.adjust,
      open: '1680.0000',
      high: '1705.0000',
      low: '1675.0000',
      close: '1700.0000',
      changePct: '0.5917', // 官方涨跌幅 (= 10/1690*100); 与 getQuotes fixture 一致。
      prevClose: '1690.0000',
      volume: '3200000',
      amount: '5440000000.00',
      turnoverRate: '0.2500',
    };
    return [point];
  }

  async getFundamentals(symbols: string[]): Promise<FundamentalSnapshotDto[]> {
    return symbols
      .filter((s) => s === MockMarketDataAdapter.MAOTAI)
      .map((symbol) => ({
        symbol,
        date: '2026-06-01',
        peTtm: '25.5000',
        peStatic: '26.0000',
        peDynamic: '24.8000',
        pb: '9.2000',
        ps: '12.4000',
        dividendYield: '1.8000',
        marketCap: '2135000000000.00',
        circMarketCap: '2135000000000.00',
        pePctlY3: '0.4200',
        pePctlY5: '0.3800',
        pbPctlY3: '0.5500',
        pbPctlY5: '0.5100',
      }));
  }

  async getFinancials(symbols: string[]): Promise<FinancialMetricDto[]> {
    return symbols
      .filter((s) => s === MockMarketDataAdapter.MAOTAI)
      .map((symbol) => ({
        symbol,
        reportPeriod: '2026Q1',
        roe: '0.3100',
        grossMargin: '0.9180',
        eps: '18.5000',
        bps: '185.2000',
      }));
  }

  // 038 T013 区间抓取 (mock): 复用 latest fixture (仅 cn:600519; 其余 no-data → 护 hk seam,
  // hk 历史区间由各 IT 的 test-local mock hk adapter 供, 不在共享 mock 塞 hk fixture)。
  async getFundamentalsRange(query: FundamentalRangeQuery): Promise<FundamentalSnapshotDto[]> {
    return this.getFundamentals([query.symbol]);
  }

  async getFinancialsRange(query: FinancialsRangeQuery): Promise<FinancialMetricDto[]> {
    return this.getFinancials([query.symbol]);
  }

  // 039 US1 做空日频 (mock): 仅 cn:600519 有 1 行 fixture; 其余 no-data → 护 hk seam
  // (hk 历史区间由各 IT 的 test-local mock hk adapter 供, 不在共享 mock 塞 hk fixture)。
  async getShortSellingRange(query: ShortSellingRangeQuery): Promise<ShortSellingPoint[]> {
    if (query.symbol !== MockMarketDataAdapter.MAOTAI) return [];
    return [{ date: '2026-06-01', shares: '1831500', amount: '915201080.00' }];
  }

  // 039 US1 南向持股日频 (mock): 仅 cn:600519 有 1 行 fixture; 其余 no-data (含护 hk seam +
  // 模拟非港股通标的空返回 → executor 零落库不崩)。
  async getConnectHoldingRange(query: ConnectHoldingRangeQuery): Promise<ConnectHoldingPoint[]> {
    if (query.symbol !== MockMarketDataAdapter.MAOTAI) return [];
    return [{ date: '2026-06-01', shareholdings: '1039052782' }];
  }

  // 039 US2 公募基金持股 (mock): 仅 cn:600519 有 1 行 fixture; 其余 no-data → 护 hk seam
  // (hk 报告期序列由各 IT 的 test-local mock hk adapter 供, 不在共享 mock 塞 hk fixture)。
  async getFundHoldingRange(query: FundHoldingRangeQuery): Promise<FundHoldingDto[]> {
    if (query.symbol !== MockMarketDataAdapter.MAOTAI) return [];
    return [
      {
        reportDate: '2026-03-31',
        fundCode: '513050',
        name: '易方达中证海外中国互联网50',
        holdings: '24158500',
        marketCap: '11080211711.00',
        netValueRatio: '0.2994',
        marketCapRank: 1,
        declarationDate: '2026-04-22',
        proportionOutstandingSharesA: null,
      },
    ];
  }

  // 039 US2 基金公司持股 (mock): 仅 cn:600519 有 1 行 fixture; 其余 no-data → 护 hk seam。
  async getFundCompanyHoldingRange(
    query: FundCompanyHoldingRangeQuery,
  ): Promise<FundCompanyHoldingDto[]> {
    if (query.symbol !== MockMarketDataAdapter.MAOTAI) return [];
    return [
      {
        reportDate: '2026-03-31',
        fundCollectionCode: '14240000',
        name: '中信证券资产管理有限公司',
        holdings: '690600',
        marketCap: '320952688.00',
      },
    ];
  }

  // 039 US3 所属指数 (mock): 仅 cn:600519 有 2 行 fixture (无 date 快照); 其余 no-data → 护 hk seam
  // (hk 所属指数集合由各 IT 的 test-local mock hk adapter 供)。
  async getIndexMembership(symbol: string): Promise<IndexMembershipDto[]> {
    if (symbol !== MockMarketDataAdapter.MAOTAI) return [];
    return [
      { indexCode: '1000001', name: '沪深300', source: 'lxri', areaCode: 'cn' },
      { indexCode: '1000015', name: '中证全指', source: 'lxri', areaCode: 'cn' },
    ];
  }

  // 043 US1 所属行业 (mock): 仅 cn:600519 有 3 级层级 3 行 fixture (无 date 快照, 覆盖式); 其余 no-data →
  // 护 hk seam + 空返回股 (hk 所属行业集合由各 IT 的 test-local mock hk adapter 供; 空返回股 = 非茅台标的)。
  async getIndustryClassification(symbol: string): Promise<IndustryClassificationDto[]> {
    if (symbol !== MockMarketDataAdapter.MAOTAI) return [];
    return [
      { source: 'sw', industryCode: 'C10', name: '食品饮料', areaCode: 'cn' },
      { source: 'sw', industryCode: 'C1010', name: '饮料制造', areaCode: 'cn' },
      { source: 'sw', industryCode: 'C101010', name: '白酒', areaCode: 'cn' },
    ];
  }

  // 043 US2 公告 (mock): 仅 cn:600519 有 fixture (只存元数据); 其余 no-data → 护 hk seam (hk 公告流由各 IT 的
  // test-local mock hk adapter 供, 不在共享 mock 塞 hk fixture)。fixture 含: 同 date 多 linkUrl (NK linkUrl
  // 天然唯一 → 两行都落不折叠) + 多 date + 缺 linkText/linkType 行 (null) + 空 types 行 ([])。
  async getAnnouncementRange(query: AnnouncementRangeQuery): Promise<AnnouncementDto[]> {
    if (query.symbol !== MockMarketDataAdapter.MAOTAI) return [];
    return [
      {
        date: '2026-06-01',
        linkUrl: 'https://mock.hkexnews/2026/0601/a.pdf',
        linkText: '翌日披露报表',
        linkType: 'PDF',
        types: ['ndd_r'],
      },
      {
        // 同 date 不同 linkUrl → NK (instrumentId,date,linkUrl) 两行都落 (不折叠丢真行)。
        date: '2026-06-01',
        linkUrl: 'https://mock.hkexnews/2026/0601/b.pdf',
        linkText: '股份购回报告',
        linkType: 'PDF',
        types: ['mr', 'srp'],
      },
      {
        // 另一 date + 缺 linkText/linkType (null) + 空 types ([])。
        date: '2026-05-15',
        linkUrl: 'https://mock.hkexnews/2026/0515/c.pdf',
        linkText: null,
        linkType: null,
        types: [],
      },
    ];
  }

  // 040 US1 波动率日频 (mock): 仅 cn:600519 有 1 行 fixture (窗口无关, 各窗口同值); 其余 no-data →
  // 护 hk seam (hk 多窗口历史序列由各 IT 的 test-local mock hk adapter 供, 不在共享 mock 塞 hk fixture)。
  async getVolatilityRange(query: VolatilityRangeQuery): Promise<VolatilityPoint[]> {
    if (query.symbol !== MockMarketDataAdapter.MAOTAI) return [];
    return [{ date: '2026-06-01', value: '0.32676715' }];
  }

  // 040 US2 热度精选快照 (mock): 仅 cn:600519 有 fixture (每 type 一行, dataDate 固定, payload 各 type
  // 异构结构不同); 其余 no-data → 护 hk seam (hk 快照由各 IT 的 test-local mock hk adapter 供, 不在
  // 共享 mock 塞 hk fixture)。stockCodes 数组含茅台即返 (executor per-stock 传单只)。
  async getHotSnapshot(query: HotSnapshotQuery): Promise<HotSnapshotDto[]> {
    if (!query.stockCodes.includes(MockMarketDataAdapter.MAOTAI)) return [];
    // 各 type 字段结构不同 (payload 异构整存, 照 p3 探查报告 §hot 字段样本)。
    const payloadByType: Record<string, Record<string, unknown>> = {
      ss: { ass_m: 0.12, ass_s: 1000, ass_s_cap_r: 0.05, stockCode: '600519' },
      tr: { tr_d1: 0.02, tr_d5: 0.015, tr_d20: 0.011, spc: 380, stockCode: '600519' },
      capita: { stn: 50000, stn_mc_pc: 0.3, stn_toi_pc: 0.12, stockCode: '600519' },
      rep: { rs_m1: 0.9, rs_m3: 0.85, rs_last: 1.1, stockCode: '600519' },
    };
    return [
      {
        hotType: query.hotType,
        dataDate: '2026-06-01',
        payload: payloadByType[query.hotType] ?? { stockCode: '600519' },
      },
    ];
  }

  // 041 US1 回购事件 (mock): 仅 cn:600519 有 fixture (丰富 typed 列); 其余 no-data → 护 hk seam
  // (hk 历史区间由各 IT 的 test-local mock hk adapter 供, 不在共享 mock 塞 hk fixture)。含同日双 venue 两笔
  // (C1: 同 (instrumentId,date) 不同 vendorEventId → 各落行不折叠, 照汇丰 00005 同日两市场回购)。
  async getBuybackRange(query: BuybackRangeQuery): Promise<BuybackDto[]> {
    if (query.symbol !== MockMarketDataAdapter.MAOTAI) return [];
    return [
      {
        date: '2026-06-01',
        vendorEventId: 'mock-bb-0001', // vendor `_id` (自然键判别字段)
        num: '1370000',
        highestPrice: '421.4000',
        lowestPrice: '416.0000',
        avgPrice: '419.0040',
        totalPaid: '574035480.00',
        totalSharesForCancellation: '1370000',
        totalSharesForTreasury: '0',
        ratioPurchasedSinceResolution: '0.024450',
        methodOfPurchase: 'exchange',
        currency: 'CNY',
        boardType: 'main',
      },
      {
        // 同日第二笔 (另一 venue) → 同 (date) 不同 vendorEventId, C1 扩键后两笔都落 (不折叠)。
        date: '2026-06-01',
        vendorEventId: 'mock-bb-0002',
        num: '500000',
        highestPrice: '420.0000',
        lowestPrice: '415.0000',
        avgPrice: '417.5000',
        totalPaid: '208750000.00',
        totalSharesForCancellation: '500000',
        totalSharesForTreasury: '0',
        ratioPurchasedSinceResolution: '0.008900',
        methodOfPurchase: 'turquoise',
        currency: 'CNY',
        boardType: 'main',
      },
    ];
  }

  // 041 US2 股本变动事件 (mock): 仅 cn:600519 有 1 行 fixture (扁平列); 其余 no-data → 护 hk seam
  // (hk 历史区间由各 IT 的 test-local mock hk adapter 供, 不在共享 mock 塞 hk fixture)。
  async getEquityChangeRange(query: EquityChangeRangeQuery): Promise<EquityChangeDto[]> {
    if (query.symbol !== MockMarketDataAdapter.MAOTAI) return [];
    return [
      {
        date: '2026-06-01',
        capitalization: '1256197800',
        capitalizationH: '0',
        changeReason: '定期報告',
        declarationDate: '2026-06-05',
      },
    ];
  }

  // 041 US3 股东权益变动事件 (mock): 仅 cn:600519 有 fixture (嵌套 L/S payload); 其余 no-data → 护 hk seam
  // (hk 历史区间由各 IT 的 test-local mock hk adapter 供, 不在共享 mock 塞 hk fixture)。含两大股东同日行
  // (自然键 shareholderName 区分): ① 含 L 和 S 两项; ② 缺 S (只有 L) → 嵌套无损 + 缺项容错。C1: ③ 同 (date,name)
  // 不同 involved → 不同 contentHash 各落行 (照 JPMorgan 09988 同日多笔); ④ 与 ① 完全相同 → 同 contentHash 折叠幂等。
  async getShareholderChangeRange(
    query: ShareholderChangeRangeQuery,
  ): Promise<ShareholderChangeDto[]> {
    if (query.symbol !== MockMarketDataAdapter.MAOTAI) return [];
    return [
      {
        date: '2026-06-01',
        shareholderName: 'Naspers Limited',
        contentHash: 'mock-sc-naspers-a', // vendor 原始行 hashdiff (自然键判别字段)
        // 含 L 和 S 两项 (嵌套 L/S 保真)。
        payload: {
          numOfSharesInterestedList: [
            { value: 2215242300, sharesType: 'L' },
            { value: 100000, sharesType: 'S' },
          ],
          percentageOfIssuedVotingShares: [
            { value: 0.2401, sharesType: 'L' },
            { value: 0.0001, sharesType: 'S' },
          ],
        },
      },
      {
        date: '2026-06-01',
        shareholderName: '马化腾',
        contentHash: 'mock-sc-pony-a',
        // 缺 S (只有 L) → 数组只含 L 项, 不伪造 S (缺项容错 FR-007)。
        payload: {
          numOfSharesInterestedList: [{ value: 804859700, sharesType: 'L' }],
          percentageOfIssuedVotingShares: [{ value: 0.0842, sharesType: 'L' }],
        },
      },
      {
        // C1 ③ 同 (date, shareholderName) 第二笔申报, involved 不同 → contentHash 不同 → 各落行不折叠。
        date: '2026-06-01',
        shareholderName: '马化腾',
        contentHash: 'mock-sc-pony-b',
        payload: {
          numOfSharesInterestedList: [{ value: 900000000, sharesType: 'L' }],
          numOfSharesInvolvedList: [{ value: 95140300, sharesType: 'P' }], // 第三类 sharesType P (T018 实证)
          percentageOfIssuedVotingShares: [{ value: 0.0942, sharesType: 'L' }],
        },
      },
      {
        // C1 ④ 与 ① 完全相同 (同 date/name/内容) → 同 contentHash → skipDuplicates 折叠幂等 (vendor 真重复行)。
        date: '2026-06-01',
        shareholderName: 'Naspers Limited',
        contentHash: 'mock-sc-naspers-a',
        payload: {
          numOfSharesInterestedList: [
            { value: 2215242300, sharesType: 'L' },
            { value: 100000, sharesType: 'S' },
          ],
          percentageOfIssuedVotingShares: [
            { value: 0.2401, sharesType: 'L' },
            { value: 0.0001, sharesType: 'S' },
          ],
        },
      },
    ];
  }

  // 041 US4 配股事件 (mock): 仅 cn:600519 有 1 行 fixture; 其余 symbol → [] (**模拟配股极罕见**,
  // 多数标的 vendor 返 0 行 → executor 零落库不崩)。护 hk seam (hk 历史由各 IT 的 test-local mock
  // hk adapter 供, 不在共享 mock 塞 hk fixture)。
  // 🚨 fixture 刻意让 `date`(公告日) ≠ `exDate`(除权日) —— prod 545 行实测 510 行两者不同, 二者
  // 混用会让因子锚错版本边界; 相等的 fixture 无法暴露该错。
  async getAllotmentRange(query: AllotmentRangeQuery): Promise<AllotmentDto[]> {
    if (query.symbol !== MockMarketDataAdapter.MAOTAI) return [];
    return [
      {
        date: '2026-06-01',
        exDate: '2026-06-18',
        allotmentRatio: '0.5',
        allotmentPrice: '1500.0000',
        currency: 'CNY',
        // 提列列之外字段 (allotmentShares 等) 靠整存无损保留。
        payload: {
          date: '2026-06-01',
          exDate: '2026-06-18',
          allotmentRatio: 0.5,
          allotmentPrice: 1500,
          currency: 'CNY',
          allotmentShares: 628000000,
        },
      },
    ];
  }

  // 042 US1 营收构成 (mock): 仅 cn:600519 有 fixture (adapter 已展开 dataList → typed 子行, 故 DTO 层是
  // 展开后的分部行, 无「头行」概念 — 纯头行已被 adapter 跳过, 不进 DTO 流)。含数据行 + **缺值数据行** (有
  // parentItemName 缺 revenue → null) + **顶层合計行** (parentItemName 哨兵 '') 混合, 护 executor 的 null 透传
  // + 哨兵落库分支。其余 symbol → no-data → 护 hk seam (hk 报告期序列由各 IT 的 test-local mock hk adapter 供)。
  async getRevenueSegmentRange(query: RevenueSegmentRangeQuery): Promise<RevenueSegmentDto[]> {
    if (query.symbol !== MockMarketDataAdapter.MAOTAI) return [];
    return [
      {
        date: '2026-06-01',
        declarationDate: '2026-06-05',
        currency: 'CNY',
        parentItemName: '按服務類型分',
        itemName: '增值服務',
        revenue: '319168000000.00',
        costs: '137511000000.00',
        grossProfitMargin: '0.569200',
      },
      {
        // 缺值数据行: 有 parentItemName 但缺 revenue/costs/grossProfitMargin → 落 null (HSBC 英國场景)。
        date: '2026-06-01',
        declarationDate: '2026-06-05',
        currency: 'CNY',
        parentItemName: '按地區分',
        itemName: '英國',
        revenue: null,
        costs: null,
        grossProfitMargin: null,
      },
      {
        // 顶层合計行: parentItemName 哨兵 '' (NK 列 NOT NULL); signed 负 revenue 亦兼容 (此处正值样本)。
        date: '2026-06-01',
        declarationDate: '2026-06-05',
        currency: 'CNY',
        parentItemName: '',
        itemName: '合計',
        revenue: '660257000000.00',
        costs: '340000000000.00',
        grossProfitMargin: '0.485000',
      },
    ];
  }

  // 042 US2 最新股东 (mock): 仅 cn:600519 有 fixture (嵌套 L/S/P payload, 复用 041 shareholder_change 范式);
  // 其余 symbol → no-data → 护 hk seam (hk 报告期股东序列由各 IT 的 test-local mock hk adapter 供, 不在共享
  // mock 塞 hk fixture)。**含多 date 行** (护 SERIES 分支 — probe verified 非覆盖式快照, 多报告期都落): ① 含 L
  // 和 S 两项; ② 含第三类 sharesType P (嵌套无损); ③ 缺 S/P (只有 L) → 缺项容错。C1: ④ 同 (date,name) 不同持股 →
  // 不同 contentHash 各落行; ⑤ 与 ① 完全相同 → 同 contentHash 折叠幂等。
  async getShareholderSnapshotRange(
    query: ShareholderSnapshotRangeQuery,
  ): Promise<ShareholderSnapshotDto[]> {
    if (query.symbol !== MockMarketDataAdapter.MAOTAI) return [];
    return [
      {
        // ① 报告期 A: 含 L 和 S 两项 (嵌套 L/S 保真)。
        date: '2024-12-31',
        shareholderName: 'Naspers Limited',
        contentHash: 'mock-ss-naspers-a', // vendor 原始行 hashdiff (自然键判别字段)
        payload: {
          numOfSharesInterestedList: [
            { value: 2215242300, sharesType: 'L' },
            { value: 100000, sharesType: 'S' },
          ],
          percentageOfIssuedVotingShares: [
            { value: 0.2401, sharesType: 'L' },
            { value: 0.0001, sharesType: 'S' },
          ],
        },
      },
      {
        // ② 报告期 A: 含第三类 sharesType P (HK SDI lending-pool, 嵌套无损保留)。
        date: '2024-12-31',
        shareholderName: 'JPMorgan Chase & Co.',
        contentHash: 'mock-ss-jpm-a',
        payload: {
          numOfSharesInterestedList: [{ value: 900000000, sharesType: 'P' }],
          percentageOfIssuedVotingShares: [{ value: 0.0942, sharesType: 'P' }],
        },
      },
      {
        // ③ 报告期 B (**不同 date → SERIES 多报告期序列, 非覆盖式快照**): 缺 S/P (只有 L) → 缺项容错。
        date: '2023-12-31',
        shareholderName: '马化腾',
        contentHash: 'mock-ss-pony-b',
        payload: {
          numOfSharesInterestedList: [{ value: 804859700, sharesType: 'L' }],
          percentageOfIssuedVotingShares: [{ value: 0.0842, sharesType: 'L' }],
        },
      },
      {
        // ④ 报告期 A 同 (date, shareholderName) 第二笔, 持股不同 → contentHash 不同 → 各落行不折叠 (C1)。
        date: '2024-12-31',
        shareholderName: '马化腾',
        contentHash: 'mock-ss-pony-a',
        payload: {
          numOfSharesInterestedList: [{ value: 900000000, sharesType: 'L' }],
          percentageOfIssuedVotingShares: [{ value: 0.0942, sharesType: 'L' }],
        },
      },
      {
        // ⑤ 与 ① 完全相同 (同 date/name/contentHash) → skipDuplicates 折叠幂等 (vendor 真重复行)。
        date: '2024-12-31',
        shareholderName: 'Naspers Limited',
        contentHash: 'mock-ss-naspers-a',
        payload: {
          numOfSharesInterestedList: [
            { value: 2215242300, sharesType: 'L' },
            { value: 100000, sharesType: 'S' },
          ],
          percentageOfIssuedVotingShares: [
            { value: 0.2401, sharesType: 'L' },
            { value: 0.0001, sharesType: 'S' },
          ],
        },
      },
    ];
  }

  // 042 US3 员工 (mock): 仅 cn:600519 有 fixture (adapter 已展开 dataList → typed 子行, 故 DTO 层是展开后
  // 的分类行, 无「头行」概念 — 纯头行已被 adapter 跳过, 不进 DTO 流)。含顶层 value 行 (parentItemName 哨兵 '')
  // + 数据行 + **同名 (parentItemName,itemName) number+percentage 两行** (Decision 6 独有坑, 护 displayType
  // 进 NK 共存分支) + 缺值行 (value null)。其余 symbol → no-data → 护 hk seam (hk 报告期序列由各 IT 的
  // test-local mock hk adapter 供, 不在共享 mock 塞 hk fixture)。
  async getEmployeeRange(query: EmployeeRangeQuery): Promise<EmployeeDto[]> {
    if (query.symbol !== MockMarketDataAdapter.MAOTAI) return [];
    return [
      {
        // 顶层 value 行: parentItemName 哨兵 '' (NK 列 NOT NULL); headcount。
        date: '2024-12-31',
        declarationDate: '2025-03-20',
        parentItemName: '',
        itemName: '员工总数',
        displayType: 'number',
        value: '58350',
      },
      {
        // 数据行 (按年龄分)。
        date: '2024-12-31',
        declarationDate: '2025-03-20',
        parentItemName: '按年龄分',
        itemName: '30歲以下',
        displayType: 'number',
        value: '18415',
      },
      {
        // 🔑 同名 (流失率按性别分, 男性) number 行 (headcount) — 与下面 percentage 行同 (parent,item)、仅
        // displayType 区分 → NK 含 displayType 才能共存 (Decision 6 probe 独有坑)。
        date: '2024-12-31',
        declarationDate: '2025-03-20',
        parentItemName: '流失率按性别分',
        itemName: '男性',
        displayType: 'number',
        value: '58812',
      },
      {
        // 🔑 同名 (流失率按性别分, 男性) percentage 行 (占比) → 与上面 number 行都落、不折叠。
        date: '2024-12-31',
        declarationDate: '2025-03-20',
        parentItemName: '流失率按性别分',
        itemName: '男性',
        displayType: 'percentage',
        value: '15.2',
      },
      {
        // 缺值数据行: 有 parentItemName 缺 value → 落 null (不丢)。
        date: '2024-12-31',
        declarationDate: '2025-03-20',
        parentItemName: '按地区分',
        itemName: '未披露',
        displayType: 'number',
        value: null,
      },
    ];
  }

  async getCorporateActions(symbol: string): Promise<CorporateActionDto[]> {
    if (symbol !== MockMarketDataAdapter.MAOTAI) return [];
    return [
      {
        symbol,
        exDate: '2026-06-20',
        type: 'dividend',
        payload: { perShare: '30.00', currency: 'CNY' },
      },
    ];
  }

  async getQuotes(symbols: string[]): Promise<QuoteSnapshot[]> {
    return symbols.map((symbol) => {
      if (symbol !== MockMarketDataAdapter.MAOTAI) {
        return {
          symbol,
          name: null,
          price: null,
          change: null,
          changePct: null,
          asOf: null,
          priceKind: 'eod_close' as const,
          hasData: false,
        };
      }
      return {
        symbol,
        name: '贵州茅台',
        price: '1700.0000',
        change: '10.0000',
        changePct: '0.5917',
        asOf: '2026-06-01',
        priceKind: 'eod_close' as const,
        hasData: true,
      };
    });
  }

  // 046 标的级 IV (mock): 仅 us:PEP 有 fixture, 数值取 p3 2026-07-29 实测 (iv_percentile 63.5 /
  // iv_rank 51.5); 其余 symbol → no-data。🚨 缺项一律 null 不填 0 —— IVP 上 0 = 「一年最低」。
  async getIvSnapshots(symbols: readonly string[]): Promise<UnderlyingIvSnapshot[]> {
    if (!symbols.includes(MockMarketDataAdapter.PEP)) return [];
    return [
      {
        symbol: MockMarketDataAdapter.PEP,
        iv: '24.8',
        ivRank: '51.5',
        ivPercentile: '63.5',
        preIv: '25.1',
        hv30: '19.3',
        hv30Percentile: '44.2',
        hv60: '20.7',
        hv60Percentile: '47.8',
        hv90: '21.4',
        hv90Percentile: '49.1',
        hv120: '22.0',
        hv120Percentile: '50.6',
        hv365: '23.9',
        hv365Percentile: '55.3',
        callVolume: '12043',
        putVolume: '9821',
        callOi: '183044',
        putOi: '151298',
      },
    ];
  }

  // 046 标的级 IV 历史 (mock): 仅 us:PEP, 1 行 fixture (区间无关)。⚠️ 蓄意**远不足** 252 交易日
  // ⇒ 走 mock 时 IVP 自算恒 `insufficient_window`, 双算对表恒 skipped —— 这正是「零 env 也能跑
  // 全套 IT」该有的形状: 不给假窗口, 免得把「不可算」这条分支在 mock 下测成「可算」。
  async getIvHistoryRange(query: UnderlyingIvHistoryQuery): Promise<UnderlyingIvHistoryPoint[]> {
    if (query.symbol !== MockMarketDataAdapter.PEP) return [];
    return [{ date: '2026-07-30', iv: '24.8', hv: '19.3', underlyingPrice: '140.2' }];
  }

  // 046 T012 美股波动率指数日线 (mock): 两个代码各 2 行 fixture, 数值取 2026-07-30/31 量级。
  // 🚨 **VVIX 的 OHLC 恒 null 不填 0** —— 官方历史文件只有 `DATE,VVIX` 两列 (Guardrail 7)。
  // mock 也照这个形状给, 否则「VVIX 无 OHLC」这条分支在零 env 的 IT 里会被测成「有 OHLC」。
  // `skipped: 0`: mock 不造非法行, 非法行处置由 `cboe-index-csv.rules.spec.ts` 覆盖。
  async getIndexHistory(indexCode: UsIndexCode): Promise<UsIndexHistory> {
    const rows =
      indexCode === 'VIX'
        ? [
            {
              date: '2026-07-30',
              open: '15.2100',
              high: '15.9800',
              low: '14.8700',
              close: '15.4300',
            },
            {
              date: '2026-07-31',
              open: '15.4000',
              high: '16.1200',
              low: '15.0500',
              close: '15.8800',
            },
          ]
        : [
            { date: '2026-07-30', open: null, high: null, low: null, close: '92.3100' },
            { date: '2026-07-31', open: null, high: null, low: null, close: '94.0700' },
          ];
    return { indexCode, rows, skipped: 0, skippedSamples: [] };
  }

  // 047 T014 期权链 (mock): PEP 两个到期日 + 每窗一对 PUT/CALL。
  // 🚨 **双边都给** —— 采集端 `option_type=ALL` (Guardrail 3)。mock 只给 PUT 会让「CALL 也落库」
  // 这条分支在零 env 的 IT 里被测成「只有 PUT」, 正好把要防的坑测成合规。
  async getExpiryDates(symbol: string): Promise<OptionExpiry[]> {
    if (symbol !== MockMarketDataAdapter.PEP) return [];
    return [
      { expiryDate: '2026-09-18', expirationCycle: 'MONTH', daysToExpiry: 45 },
      { expiryDate: '2026-10-16', expirationCycle: 'MONTH', daysToExpiry: 73 },
    ];
  }

  async getChainWindow(query: OptionChainWindowQuery): Promise<OptionContractStatic[]> {
    if (query.symbol !== MockMarketDataAdapter.PEP) return [];
    const expiries = ['2026-09-18', '2026-10-16'].filter((d) => d >= query.start && d <= query.end);
    return expiries.flatMap((expiryDate) => {
      const yymmdd = expiryDate.replaceAll('-', '').slice(2);
      return (['PUT', 'CALL'] as const).map((optionType) => ({
        market: 'us',
        code: `US.PEP${yymmdd}${optionType === 'PUT' ? 'P' : 'C'}130000`,
        root: 'PEP',
        underlyingSymbol: MockMarketDataAdapter.PEP,
        expiryDate,
        strikePrice: '130',
        optionType,
        expirationCycle: 'MONTH',
        settlementMode: 'PM',
        isStandard: true,
      }));
    });
  }

  // 047 T016 期权快照 (mock): 请求的每个合约一行 + **标的自身一行** (spot 的来源, 与期权行
  // 同批返回, 不另发调用)。
  // 🚨 **数值必须过得了落库前硬门** (`option-snapshot-guard.rules.ts`): bid ≤ ask ·
  // PUT Δ ≤ 0 / CALL Δ ≥ 0 · ask ≥ 内在价值 − 容差。给一组过不了门的编造数值 = 零 env 的 IT
  // 里整批被拒, 正好把「硬门不误拦正常行」这条测成合规。spot 取 128.40 (< K=130) ⇒ PUT 实值、
  // CALL 虚值, 两侧的门都被真正走到。
  async getSnapshots(query: OptionSnapshotQuery): Promise<OptionSnapshotBatch> {
    const rows: OptionSnapshotRow[] = query.contractCodes.map((code) => {
      const isPut = /P\d+$/.test(code);
      return {
        code,
        isOption: true,
        underlyingCode: 'US.PEP',
        bid: isPut ? '2.30' : '1.05',
        ask: isPut ? '2.40' : '1.15',
        bidSize: '45',
        askSize: '60',
        last: isPut ? '2.35' : '1.10',
        prevClose: isPut ? '2.28' : '1.12',
        iv: '21.4',
        // 两侧符号相反 —— 抄成同号会让硬门的方向性判据在 IT 里形同虚设。
        delta: isPut ? '-0.31' : '0.28',
        gamma: '0.041',
        vega: '0.092',
        theta: '-0.058',
        rho: '0.011',
        openInterest: '3120',
        netOpenInterest: '-410',
        volume: '1204',
        turnover: '283940',
        vendorUpdateTime: new Date('2026-09-18T20:00:00Z'),
        greeksComplete: true,
      };
    });
    // 标的自身那行: greeks 不适用 ⇒ null (标 false 会被读作「这只票 greeks 缺失」)。
    rows.push({
      code: 'US.PEP',
      isOption: false,
      underlyingCode: null,
      bid: null,
      ask: null,
      bidSize: null,
      askSize: null,
      last: '128.40',
      prevClose: '127.90',
      iv: null,
      delta: null,
      gamma: null,
      vega: null,
      theta: null,
      rho: null,
      openInterest: null,
      netOpenInterest: null,
      volume: '3120000',
      turnover: '400000000',
      vendorUpdateTime: new Date('2026-09-18T20:00:00Z'),
      greeksComplete: null,
    });
    return { asOf: new Date(), rows };
  }

  /**
   * 047 T018 财报日历 (mock): 窗内**全市场**两行 —— PEP (库里有 `Instrument` 行) +
   * 一只**库里没有**的票。
   *
   * 🚨 **那只库外票是刻意的**: 全市场落库必然撞上 `Instrument` 表外的标的 (新上市 / OTC),
   * 处置是「跳过并计数」(FR-035b / plan D-DATA-8)。mock 只给白名单内的票, 会让零 env 的 IT 里
   * 那条分支**永远走不到**, 正好把要防的坑测成合规。
   *
   * 🚨 **不按 symbol 过滤**: 本端口是市场级的, 一发返全市场 —— 给 mock 加个「只在锚里才返」
   * 的旁路等于在 mock 层重建锚闸, 而不挂锚闸正是本维度的承重设计 (Guardrail 2)。
   */
  async getWindow(query: EarningsCalendarWindowQuery): Promise<EarningsCalendarEvent[]> {
    if (query.market !== 'us') return [];
    // 窗起当天各一条 —— use case 按 ≤7 天窗滚前向视野, 每窗都拿得到形状完整的一行。
    return [
      {
        underlyingSymbol: MockMarketDataAdapter.PEP,
        earningsDate: query.start,
        pubType: 'BEFORE',
        periodText: 'Q3 2026',
        // 尚未公布 ⇒ actual 为 null, 只有预期值 (FR-026 三态里的「预估」形态)。
        epsActual: null,
        epsPredict: '2.31',
      },
      {
        // 库里没有的标的 (universe 尚未枚举到 / OTC): FK 撞不上 ⇒ 应被跳过并计数。
        underlyingSymbol: 'us:NOBODY',
        earningsDate: query.start,
        pubType: 'AFTER',
        periodText: 'Q3 2026',
        epsActual: null,
        epsPredict: null,
      },
    ];
  }
}
