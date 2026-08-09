import { describe, it, expect } from 'vitest';
import type { PrismaService } from '../../src/security/prisma.service';
import { VendorHttpClient } from '../../src/marketdata/vendor-http-client';
import { LIXINGER_PROFILE } from '../../src/marketdata/lixinger.constraint-profile';
import { LixingerEodBarAdapter } from '../../src/marketdata/lixinger-eod-bar.adapter';
import { LixingerFundamentalAdapter } from '../../src/marketdata/lixinger-fundamental.adapter';
import { LixingerFinancialsAdapter } from '../../src/marketdata/lixinger-financials.adapter';
import { LixingerCorporateActionAdapter } from '../../src/marketdata/lixinger-corporate-action.adapter';
import { LixingerShortSellingAdapter } from '../../src/marketdata/lixinger-short-selling.adapter';
import { LixingerConnectHoldingAdapter } from '../../src/marketdata/lixinger-connect-holding.adapter';
import { LixingerFundHoldingAdapter } from '../../src/marketdata/lixinger-fund-holding.adapter';
import { LixingerFundCompanyHoldingAdapter } from '../../src/marketdata/lixinger-fund-company-holding.adapter';
import { LixingerIndexMembershipAdapter } from '../../src/marketdata/lixinger-index-membership.adapter';
import { LixingerIndustryClassificationAdapter } from '../../src/marketdata/lixinger-industry-classification.adapter';
import { LixingerAnnouncementAdapter } from '../../src/marketdata/lixinger-announcement.adapter';
import { LixingerVolatilityAdapter } from '../../src/marketdata/lixinger-volatility.adapter';
import { HOT_TYPES, LixingerHotAdapter } from '../../src/marketdata/lixinger-hot.adapter';
import { LixingerBuybackAdapter } from '../../src/marketdata/lixinger-buyback.adapter';
import { LixingerEquityChangeAdapter } from '../../src/marketdata/lixinger-equity-change.adapter';
import { LixingerShareholderChangeAdapter } from '../../src/marketdata/lixinger-shareholder-change.adapter';
import { LixingerAllotmentAdapter } from '../../src/marketdata/lixinger-allotment.adapter';
import { LixingerRevenueSegmentAdapter } from '../../src/marketdata/lixinger-revenue-segment.adapter';
import { LixingerShareholderSnapshotAdapter } from '../../src/marketdata/lixinger-shareholder-snapshot.adapter';
import { LixingerEmployeeAdapter } from '../../src/marketdata/lixinger-employee.adapter';

/**
 * 理杏仁 4 adapter 真 vendor IT (015 T006, env-gated, 默认 skip) — SC-S08。
 *
 * 目的: 用真 LIXINGER_TOKEN 打真理杏仁, **校真 mock 单测无法覆盖的 vendor 契约**:
 * 端点 path / 请求 body 字段 / 响应字段名 (pe_ttm / cvpos 窗口 / q.metrics.* / fs_type
 * 枚举 / candlestick type 语义)。adapter 里标 PROVISIONAL 的字段映射在此被证实或证伪
 * —— 错则按 spec L253「同步漏标 / 400」修 adapter。
 *
 * **默认 skip** (env-gated, per memory env_gated_perf_it_pattern, 沿 RUN_PERF_IT / RUN_SMS_IT
 * 范式): 会真打理杏仁 (耗配额 + 触双窗限频), CI / 常规 `nx affected` 不跑。
 *
 * **本地启用** (token 放 gitignored env / shell, 禁入仓):
 *   RUN_MARKETDATA_IT=true LIXINGER_TOKEN=<token> \
 *   pnpm nx test server -- marketdata.lixinger.vendor
 *
 * 注: fundamental/financials 走 fsType 路由需读 Instrument 缓存 → 此处用 stub prisma
 * (空缓存 → 强制每次调 /cn/company 验路由), 不依赖真 PG。
 */
const RUN_MARKETDATA_IT = process.env.RUN_MARKETDATA_IT === 'true';
const BASE = 'https://open.lixinger.com/api';
const SYMBOL = 'cn:600519'; // 贵州茅台 (non_financial)
const HK_SYMBOL = 'hk:00700'; // 腾讯 (港股通/做空活跃, p2 探查样本股)

/** 空缓存 stub prisma — findMany 返空 (强制 /cn/company), updateMany no-op。 */
const STUB_PRISMA = {
  instrument: {
    findMany: async () => [],
    updateMany: async () => ({ count: 0 }),
  },
} as unknown as PrismaService;

describe.skipIf(!RUN_MARKETDATA_IT)('理杏仁真 vendor IT (env-gated, 默认 skip)', () => {
  const token = process.env.LIXINGER_TOKEN ?? '';
  // 单实例 http client (共享双窗限频器, 避免 4 adapter 各自打满配额)。
  const http = new VendorHttpClient(LIXINGER_PROFILE);

  it('LIXINGER_TOKEN 必设 (否则明确报错, 不静默打空 token)', () => {
    if (!token) throw new Error('真 vendor IT 缺 LIXINGER_TOKEN');
  });

  it('EOD candlestick → 非空日线, OHLC 为数字串, tradeDate YYYY-MM-DD', async () => {
    const adapter = new LixingerEodBarAdapter(http, token, BASE);
    const bars = await adapter.getBars({
      symbol: SYMBOL,
      adjust: 'forward',
      from: '2024-01-01',
      to: '2024-01-31',
    });
    expect(bars.length).toBeGreaterThan(0);
    const b = bars[0];
    expect(b.tradeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Number(b.close))).toBe(false);
  }, 30_000);

  it('fundamental → fsType 路由通 + 估值字段解析 (peTtm 非空)', async () => {
    const adapter = new LixingerFundamentalAdapter(http, token, BASE, STUB_PRISMA);
    const out = await adapter.getFundamentals([SYMBOL]);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].symbol).toBe(SYMBOL);
    // peTtm 是核心估值字段; null = 字段名漂移 → 修 adapter metric 名。
    expect(out[0].peTtm).not.toBeNull();
  }, 30_000);

  it('financials → fs/{fsType} 路由通 + reportPeriod YYYYQn', async () => {
    const adapter = new LixingerFinancialsAdapter(http, token, BASE, STUB_PRISMA);
    const out = await adapter.getFinancials([SYMBOL]);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].reportPeriod).toMatch(/^\d{4}Q[1-4]$/);
  }, 30_000);

  it('corporate-action → 公司行动列表 (exDate YYYY-MM-DD)', async () => {
    const adapter = new LixingerCorporateActionAdapter(http, token, BASE);
    const out = await adapter.getCorporateActions(SYMBOL);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].exDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }, 30_000);

  // 019 T012 SC-S02 真 vendor 抽样对拍: 段内 forward/backward = none × 锚定因子 (比值
  // 段内常数, plan D1 数学前提的真数据校真)。窗口取 2024-07~08 (茅台 2024-06-19 除权后
  // 至年末无新除权 → 单段), 锚最新日比值, 对拍全窗逐日。3 请求。
  it('SC-S02 抽样对拍: 段内 forward/backward = none × 段因子 (真 vendor 数据)', async () => {
    const adapter = new LixingerEodBarAdapter(http, token, BASE);
    const range = { symbol: SYMBOL, from: '2024-07-01', to: '2024-08-30' } as const;
    const noneBars = await adapter.getBars({ ...range, adjust: 'none' });
    const forwardBars = await adapter.getBars({ ...range, adjust: 'forward' });
    const backwardBars = await adapter.getBars({ ...range, adjust: 'backward' });
    expect(noneBars.length).toBeGreaterThan(20);

    const byDate = (bars: typeof noneBars) => new Map(bars.map((b) => [b.tradeDate, b]));
    const fwd = byDate(forwardBars);
    const bwd = byDate(backwardBars);
    const aligned = noneBars.filter((b) => fwd.has(b.tradeDate) && bwd.has(b.tradeDate));
    expect(aligned.length).toBeGreaterThan(20);

    // 锚: 窗内最新交易日比值 (019 段内比值锚同式, 函数已随 020 T009 退役 — 此处内联校真)。
    const last = aligned[aligned.length - 1];
    const factorForward = Number(fwd.get(last.tradeDate)!.close) / Number(last.close);
    const factorBackward = Number(bwd.get(last.tradeDate)!.close) / Number(last.close);

    // 对拍: 全窗逐日 |vendor − none×factor| / vendor < 1e-3 (vendor 价格 2dp 舍入容差)。
    for (const b of aligned) {
      const vForward = Number(fwd.get(b.tradeDate)!.close);
      const vBackward = Number(bwd.get(b.tradeDate)!.close);
      expect(Math.abs(vForward - Number(b.close) * factorForward) / vForward).toBeLessThan(1e-3);
      expect(Math.abs(vBackward - Number(b.close) * factorBackward) / vBackward).toBeLessThan(1e-3);
    }
  }, 60_000);

  // 039 T004 US1: 校真做空端点契约 (单数 stockCode + date/shares/amount 字段名, hk/company/short-selling)。
  it('short-selling (hk) → 非空做空日频, date YYYY-MM-DD, shares/amount 数字串', async () => {
    const adapter = new LixingerShortSellingAdapter(http, token, BASE);
    const out = await adapter.getShortSellingRange({
      symbol: HK_SYMBOL,
      from: '2025-05-01',
      to: '2025-05-31',
    });
    expect(out.length).toBeGreaterThan(0);
    const p = out[0];
    expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // shares/amount 是核心字段; null = 字段名漂移 → 修 adapter 映射。
    expect(p.shares).not.toBeNull();
    expect(Number.isNaN(Number(p.shares))).toBe(false);
  }, 30_000);

  // 039 T005 US1: 校真南向持股端点契约 (单数 stockCode + date/shareholdings 字段名, hk/company/mutual-market)。
  it('mutual-market (hk 港股通标的) → 非空南向持股, date YYYY-MM-DD, shareholdings 数字串', async () => {
    const adapter = new LixingerConnectHoldingAdapter(http, token, BASE);
    const out = await adapter.getConnectHoldingRange({
      symbol: HK_SYMBOL,
      from: '2025-05-01',
      to: '2025-05-31',
    });
    expect(out.length).toBeGreaterThan(0);
    const p = out[0];
    expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.shareholdings).not.toBeNull();
    expect(Number.isNaN(Number(p.shareholdings))).toBe(false);
  }, 30_000);

  // 039 T009 US2: 校真公募基金持股端点契约 (单数 stockCode + date→reportDate/holdings/fundCode 字段名,
  // hk/company/fund-shareholders; proportionOfOutstandingSharesA 名带 A → hk 存 null 不丢弃)。
  it('fund-shareholders (hk) → 非空报告期持股, reportDate YYYY-MM-DD, holdings/fundCode 非空', async () => {
    const adapter = new LixingerFundHoldingAdapter(http, token, BASE);
    const out = await adapter.getFundHoldingRange({
      symbol: HK_SYMBOL,
      from: '2024-01-01',
      to: '2025-06-30',
    });
    expect(out.length).toBeGreaterThan(0);
    const p = out[0];
    expect(p.reportDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // holdings/fundCode 是核心字段; null/'' = 字段名漂移 → 修 adapter 映射。
    expect(p.fundCode.length).toBeGreaterThan(0);
    expect(p.holdings).not.toBeNull();
    expect(Number.isNaN(Number(p.holdings))).toBe(false);
  }, 30_000);

  // 039 T010 US2: 校真基金公司持股端点契约 (单数 stockCode + date→reportDate/marketCap/fundCollectionCode
  // 字段名, hk/company/fund-collection-shareholders)。
  it('fund-collection-shareholders (hk) → 非空报告期持股, reportDate YYYY-MM-DD, marketCap/fundCollectionCode 非空', async () => {
    const adapter = new LixingerFundCompanyHoldingAdapter(http, token, BASE);
    const out = await adapter.getFundCompanyHoldingRange({
      symbol: HK_SYMBOL,
      from: '2024-01-01',
      to: '2025-06-30',
    });
    expect(out.length).toBeGreaterThan(0);
    const p = out[0];
    expect(p.reportDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // marketCap/fundCollectionCode 是核心字段; null/'' = 字段名漂移 → 修 adapter 映射。
    expect(p.fundCollectionCode.length).toBeGreaterThan(0);
    expect(p.marketCap).not.toBeNull();
    expect(Number.isNaN(Number(p.marketCap))).toBe(false);
  }, 30_000);

  // 039 T014 US3: 校真所属指数端点契约 (第 3 形态: 单数 stockCode + **无日期**, hk/company/indices;
  // vendor `stockCode` 字段实为指数代码 → indexCode; p2 探查 00700 归属多指数)。
  it('indices (hk) → 非空所属指数快照, indexCode 非空, name 非空 (vendor stockCode=指数代码)', async () => {
    const adapter = new LixingerIndexMembershipAdapter(http, token, BASE);
    const out = await adapter.getIndexMembership(HK_SYMBOL);
    expect(out.length).toBeGreaterThan(0);
    const m = out[0];
    // indexCode/name 是核心字段; null/'' = 字段名漂移 → 修 adapter 映射 (indexCode=vendor stockCode)。
    expect(m.indexCode.length).toBeGreaterThan(0);
    expect(m.name).not.toBeNull();
  }, 30_000);

  // 043 T004 US1: 校真所属行业端点契约 (覆盖式快照形态: 单数 stockCode + **无 date**, hk/company/industries;
  // vendor `stockCode` 字段实为行业代码 → industryCode; probe 00700 → hsi 3 级层级 3 行 H70/H7020/H702015)。
  it('industries (hk) → 非空所属行业快照 (3 级层级), industryCode 非空, source 非空 (vendor stockCode=行业代码)', async () => {
    const adapter = new LixingerIndustryClassificationAdapter(http, token, BASE);
    const out = await adapter.getIndustryClassification(HK_SYMBOL);
    expect(out.length).toBeGreaterThan(0);
    const m = out[0];
    // industryCode/source 是核心字段; null/'' = 字段名漂移 → 修 adapter 映射 (industryCode=vendor stockCode)。
    expect((m.industryCode ?? '').length).toBeGreaterThan(0);
    expect(m.source).not.toBeNull();
  }, 30_000);

  // 043 T007 US2: 校真公告端点契约 (range 文本流形态: 单数 stockCode + startDate/endDate ≤10yr,
  // hk/company/announcement; date +08:00 → lixDateOnly; linkUrl 全局唯一; types 数组)。腾讯 00700 高频
  // 披露 → 非空; 抽核 linkUrl 非空 + date YYYY-MM-DD + 升序 (null/'undefined' = 字段名漂移 → 修 adapter 映射)。
  it('announcement (hk, ≤10yr range) → 非空公告流, date YYYY-MM-DD, linkUrl 非空, types 数组, date 升序', async () => {
    const adapter = new LixingerAnnouncementAdapter(http, token, BASE);
    const out = await adapter.getAnnouncementRange({
      symbol: HK_SYMBOL,
      from: '2024-01-01',
      to: '2024-12-31',
    });
    expect(out.length).toBeGreaterThan(0);
    const p = out[0];
    expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // linkUrl 是自然键组件, 全非空 ('undefined' = linkUrl 字段漂移 → 修 adapter)。
    expect(p.linkUrl.length).toBeGreaterThan(0);
    expect(p.linkUrl).not.toBe('undefined');
    // types 是数组 (可空标签集但恒 Array)。
    expect(Array.isArray(p.types)).toBe(true);
    // date 升序 (端口契约): 首行 date ≤ 末行 date。
    expect(out[0].date <= out[out.length - 1].date).toBe(true);
  }, 30_000);

  // 🚨 announcement 端点 `endDate` **排他** (右开), 本族里独一份 —— adapter 已 +1 天归一到端口的
  // 右闭契约。本例校真那道归一: **单日窗 `from === to` 必须能取回该日全部行**。
  //
  // 为什么这条非有不可: 归一前 executor delta 的 `from = to = asOf` 在右开语义下是空区间, vendor
  // 恒返 0 行、SyncRun 全绿, 043 上线 (2026-07-16) 起 prod 静默 12 个交易日零增量无人发现。这正是
  // mock 单测**结构性覆盖不到**的一类: mock 按我们假设的语义回答, 假设错了 mock 跟着一起错。
  //
  // 断言写成**自我参照**而非钉死日期: 先用宽窗找出一个确有公告的日子, 再对该日发单日窗, 要求两者
  // 行数一致 —— 不随 vendor 数据变动漂移 (钉死日期的断言迟早变成假红)。
  it('announcement 单日窗 (from===to) 取回该日全部行 —— 校真 endDate 右开归一', async () => {
    const adapter = new LixingerAnnouncementAdapter(http, token, BASE);
    const wide = await adapter.getAnnouncementRange({
      symbol: HK_SYMBOL,
      from: '2024-12-01',
      to: '2024-12-31',
    });
    expect(wide.length).toBeGreaterThan(0); // 宽窗无数据 = 样本失效, 非归一失败

    const anchor = wide[wide.length - 1].date; // 宽窗内最后一个确有公告的日子
    const expected = wide.filter((a) => a.date === anchor).length;

    const single = await adapter.getAnnouncementRange({
      symbol: HK_SYMBOL,
      from: anchor,
      to: anchor,
    });
    // 归一前这里恒为 0 (空区间) —— 即 prod 上那 12 个交易日的病灶形状。
    expect(single.length).toBe(expected);
    expect(single.every((a) => a.date === anchor)).toBe(true); // 且不越界带出邻日
  }, 30_000);

  // 040 T004 US1: 校真波动率端点契约 (单数 stockCode + volatilityDays number 单数 + date/value 字段名,
  // hk/company/volatility)。多窗口 = 每窗口一次请求; 此处抽一窗口 (250) 校 param 契约 + 字段 schema。
  it('volatility (hk, volatilityDays=250 单数 number) → 非空日频 HV, date YYYY-MM-DD, value 数字串', async () => {
    const adapter = new LixingerVolatilityAdapter(http, token, BASE);
    const out = await adapter.getVolatilityRange({
      symbol: HK_SYMBOL,
      volatilityDays: 250,
      from: '2024-11-01',
      to: '2024-12-31',
    });
    expect(out.length).toBeGreaterThan(0);
    const p = out[0];
    expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // value 是核心字段 (年化 HV); null = 字段名漂移 / volatilityDays 数组 → 400 → 修 adapter 映射。
    expect(p.value).not.toBeNull();
    expect(Number.isNaN(Number(p.value))).toBe(false);
  }, 30_000);

  // 040 T007 US2: 校真热度精选快照端点契约 (**stockCodes[] 数组** + 无日期 + last_data_date/异构字段,
  // hk/company/hot/{type})。逐个精选 type (ss/tr/capita/rep) 真调确认 param 契约 + 字段 schema + payload
  // 整存 + 忽略异常 key "undefined" (rep)。快照家族: 1 行/股, 含 last_data_date (plan Deferred-probe #2:
  // impl 首个真调二次确认 4 type 字段与 probe 一致)。
  it.each([...HOT_TYPES])(
    'hot/%s (hk, stockCodes[] 数组 快照) → 非空快照, dataDate YYYY-MM-DD, payload 无 "undefined" key',
    async (hotType) => {
      const adapter = new LixingerHotAdapter(http, token, BASE);
      const out = await adapter.getHotSnapshot({ hotType, stockCodes: [HK_SYMBOL] });
      expect(out.length).toBeGreaterThan(0);
      const p = out[0];
      expect(p.hotType).toBe(hotType);
      // dataDate = vendor last_data_date (自然键); null/'' = 字段名漂移 → 修 adapter 映射。
      expect(p.dataDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // payload 整存异构字段, 异常 key "undefined" 已忽略 (FR-007)。
      expect(Object.keys(p.payload)).not.toContain('undefined');
      expect(Object.keys(p.payload).length).toBeGreaterThan(0);
    },
    30_000,
  );

  // 041 T004 US1: 校真回购端点契约 (单数 stockCode + date/num/highestPrice/avgPrice/totalPaid/…
  // 字段名, hk/company/repurchase)。腾讯 00700 近年活跃回购 → 非空; 丰富 typed 字段抽核 num/avgPrice
  // (null = 字段名漂移 → 修 adapter 映射)。plan Deferred-probe #1/#2: impl 首个真调二次确认同日多事件
  // 基数 (C1 护栏) + Decimal 精度 (大额回购不溢出)。
  it('repurchase (hk) → 非空回购事件, date YYYY-MM-DD, num/avgPrice 数字串', async () => {
    const adapter = new LixingerBuybackAdapter(http, token, BASE);
    const out = await adapter.getBuybackRange({
      symbol: HK_SYMBOL,
      from: '2024-01-01',
      to: '2024-12-31',
    });
    expect(out.length).toBeGreaterThan(0);
    const p = out[0];
    expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // num/avgPrice 是核心字段; null = 字段名漂移 → 修 adapter 映射。
    expect(p.num).not.toBeNull();
    expect(Number.isNaN(Number(p.num))).toBe(false);
    expect(p.avgPrice).not.toBeNull();
    expect(Number.isNaN(Number(p.avgPrice))).toBe(false);
    // C1: vendorEventId (vendor `_id`) 是自然键判别字段, 全非空 ('undefined' = _id 字段漂移 → 修 adapter)。
    expect(p.vendorEventId.length).toBeGreaterThan(0);
    expect(p.vendorEventId).not.toBe('undefined');
    // date 升序 (端口契约): 首行 date ≤ 末行 date。
    expect(out[0].date <= out[out.length - 1].date).toBe(true);
  }, 30_000);

  // 041 T007 US2: 校真股本变动端点契约 (单数 stockCode + date/capitalization/capitalizationH/
  // changeReason/declarationDate 字段名, hk/company/equity-change)。腾讯 00700 定期披露股本 → 非空;
  // capitalization/date 抽核 (null = 字段名漂移 → 修 adapter 映射)。
  it('equity-change (hk) → 非空股本变动事件, date YYYY-MM-DD, capitalization 数字串', async () => {
    const adapter = new LixingerEquityChangeAdapter(http, token, BASE);
    const out = await adapter.getEquityChangeRange({
      symbol: HK_SYMBOL,
      from: '2020-01-01',
      to: '2024-12-31',
    });
    expect(out.length).toBeGreaterThan(0);
    const p = out[0];
    expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // capitalization 是核心字段; null = 字段名漂移 → 修 adapter 映射。
    expect(p.capitalization).not.toBeNull();
    expect(Number.isNaN(Number(p.capitalization))).toBe(false);
    // date 升序 (端口契约): 首行 date ≤ 末行 date。
    expect(out[0].date <= out[out.length - 1].date).toBe(true);
  }, 30_000);

  // 041 T010 US3: 校真股东权益变动端点契约 (单数 stockCode + date/name/numOfSharesInterestedList/
  // percentageOfIssuedVotingShares 嵌套字段名, hk/company/shareholders-equity-change)。腾讯 00700 大股东
  // 频繁增减持 → 非空; **嵌套 L/S 保真**抽核: name 非空 (自然键) + payload.numOfSharesInterestedList 是数组
  // 且每项含 {value, sharesType} (null/非数组 = 字段名漂移 → 修 adapter 映射)。plan Deferred-probe #4:
  // impl 真调核 sharesType 值域 (L/S 外是否有第三类 lending-pool)。
  it('shareholders-equity-change (hk) → 非空股东权益变动, date YYYY-MM-DD, name 非空, 嵌套 L/S 数组', async () => {
    const adapter = new LixingerShareholderChangeAdapter(http, token, BASE);
    const out = await adapter.getShareholderChangeRange({
      symbol: HK_SYMBOL,
      from: '2015-01-01',
      to: '2024-12-31',
    });
    expect(out.length).toBeGreaterThan(0);
    const p = out[0];
    expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.shareholderName.length).toBeGreaterThan(0); // 自然键之一, 非空。
    // C1: contentHash (vendor 原始行 canonical sha256) 是自然键判别字段, 64 位 hex 非空 (判别同名同日多笔)。
    expect(p.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // 嵌套 L/S 保真: numOfSharesInterestedList 是数组, 每项含 {value, sharesType} (null = 字段名漂移)。
    const list = p.payload.numOfSharesInterestedList as Array<{
      value: unknown;
      sharesType: unknown;
    }>;
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    expect(typeof list[0].sharesType).toBe('string'); // L/S (或潜在第三类)。
    // date 升序 (端口契约): 首行 date ≤ 末行 date。
    expect(out[0].date <= out[out.length - 1].date).toBe(true);
  }, 30_000);

  // 041 T013 US4: 校真配股端点契约 (单数 stockCode + hk/company/allotment)。**港股配股极罕见零样本**
  // (p3 probe 扫 12 标的全 0 行, US4/SC-004) → **允许全 0**: 端点须正常返数组不崩 (零样本容错核心), 命中
  // (罕见) 则 date YYYY-MM-DD + payload 整存非空。plan Deferred-probe #3: impl 对候选池真调找配股历史标的,
  // 命中则 payload 首样本二次确认字段; 全 0 记为已知限制 (SC-004 收敛即通过, 不 fail)。
  it('allotment (hk) → 端点正常返数组 (港股极罕见, 允许全 0 零样本), 命中则 date YYYY-MM-DD + payload 非空', async () => {
    const adapter = new LixingerAllotmentAdapter(http, token, BASE);
    const out = await adapter.getAllotmentRange({
      symbol: HK_SYMBOL,
      from: '2010-01-01',
      to: '2024-12-31',
    });
    // 零样本容错: 全 0 不崩、管道收敛 (SC-004 收敛即通过)。
    expect(Array.isArray(out)).toBe(true);
    // 命中 (罕见): date 格式 + payload 整存非空 (字段首样本待人工二次确认 schema)。
    for (const p of out) {
      expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Object.keys(p.payload).length).toBeGreaterThan(0);
    }
    // date 升序 (端口契约): 命中多行时首行 ≤ 末行。
    if (out.length > 1) expect(out[0].date <= out[out.length - 1].date).toBe(true);
  }, 30_000);

  // 042 T004 US1: 校真营收构成端点契约 (单数 stockCode + operation-revenue-constitution; dataList 展开
  // typed 子行)。腾讯 00700 各报告期披露分部营收 → 非空; **头行判别 + typed 子行 + HK-aware date** 抽核:
  // parentItemName/itemName 非空 (NK 列) + revenue 数字串 + date YYYY-MM-DD (UTC-Z 经 lixDateOnlyHk 无
  // off-by-one)。plan §风险 #1/#5/#6: impl 真调核头行结构 + signed 负 revenue + Decimal 不溢出 + 日期对齐。
  it('operation-revenue-constitution (hk) → 非空营收分部行, date YYYY-MM-DD, parentItemName/itemName 非空, revenue 数字串', async () => {
    const adapter = new LixingerRevenueSegmentAdapter(http, token, BASE);
    const out = await adapter.getRevenueSegmentRange({
      symbol: HK_SYMBOL,
      from: '2018-01-01',
      to: '2024-12-31',
    });
    expect(out.length).toBeGreaterThan(0);
    const p = out[0];
    // date HK-aware 归一 (营收 UTC-Z → +8h date-only, 无 off-by-one 少 1 天)。
    expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // itemName 是 NK 列, 非空 ('' 只允许顶层行的 parentItemName 哨兵, itemName 恒有值)。
    expect(p.itemName.length).toBeGreaterThan(0);
    // 头行不落 → 输出行至少有一行携带真 revenue (typed 解析成功; 全 null = 字段名漂移 → 修 adapter 映射)。
    expect(out.some((r) => r.revenue !== null)).toBe(true);
    const withRev = out.find((r) => r.revenue !== null)!;
    expect(Number.isNaN(Number(withRev.revenue))).toBe(false);
    // 纯头行 (无 parentItemName + 无 value) 不落库: 每行至少 parentItemName 非空(数据行) 或 revenue 非空(合計)。
    for (const r of out) {
      expect(r.parentItemName.length > 0 || r.revenue !== null).toBe(true);
    }
    // date 升序 (端口契约): 首行 date ≤ 末行 date。
    expect(out[0].date <= out[out.length - 1].date).toBe(true);
  }, 30_000);

  // 042 T007 US2: 校真最新股东端点契约 (单数 stockCode + latest-shareholders; 嵌套 L/S/P payload)。
  // 腾讯 00700 各报告期披露大股东名册 → 非空; **SERIES + 嵌套保真 + contentHash** 抽核: name 非空 (NK 列)
  // + payload.numOfSharesInterestedList 是数组且每项含 {value, sharesType} (null/非数组 = 字段名漂移 → 修
  // adapter 映射) + contentHash 64 位 hex。plan §风险 #3/#4: impl 真调核 SERIES (多 date) + sharesType 值域
  // (L/S 外第三类 P)。
  it('latest-shareholders (hk) → 非空最新股东, date YYYY-MM-DD, name 非空, 嵌套 L/S/P 数组, SERIES 多 date', async () => {
    const adapter = new LixingerShareholderSnapshotAdapter(http, token, BASE);
    const out = await adapter.getShareholderSnapshotRange({
      symbol: HK_SYMBOL,
      from: '2015-01-01',
      to: '2024-12-31',
    });
    expect(out.length).toBeGreaterThan(0);
    const p = out[0];
    expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.shareholderName.length).toBeGreaterThan(0); // 自然键之一, 非空。
    // C1: contentHash (vendor 原始行 canonical sha256) 是自然键判别字段, 64 位 hex 非空 (判别同名同日多笔)。
    expect(p.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // 嵌套 L/S/P 保真: numOfSharesInterestedList 是数组, 每项含 {value, sharesType} (null = 字段名漂移)。
    const list = p.payload.numOfSharesInterestedList as Array<{
      value: unknown;
      sharesType: unknown;
    }>;
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    expect(typeof list[0].sharesType).toBe('string'); // L/S/P。
    // SERIES 抽核: 多个不同 date 行 (报告期×股东序列, 非覆盖式快照 — probe verified 00700 5 date)。
    expect(new Set(out.map((r) => r.date)).size).toBeGreaterThan(1);
    // date 升序 (端口契约): 首行 date ≤ 末行 date。
    expect(out[0].date <= out[out.length - 1].date).toBe(true);
  }, 30_000);

  // 042 T010 US3: 校真员工端点契约 (单数 stockCode + employee; dataList 展开 typed 子行 + displayType NK)。
  // 腾讯 00700 各报告期披露员工数据 → 非空; **头行判别 + displayType 保留 + 同名两行共存 + HK-aware date** 抽核:
  // parentItemName/itemName/displayType 非空 (NK 列) + value 数字串 + date YYYY-MM-DD。plan Decision 6: impl
  // 真调核 displayType 值域 (number/percentage) + 同名 (parentItemName,itemName) number+percentage 两行存在。
  it('employee (hk) → 非空员工行, date YYYY-MM-DD, itemName/displayType 非空, value 数字串, displayType∈{number,percentage}', async () => {
    const adapter = new LixingerEmployeeAdapter(http, token, BASE);
    const out = await adapter.getEmployeeRange({
      symbol: HK_SYMBOL,
      from: '2015-01-01',
      to: '2024-12-31',
    });
    expect(out.length).toBeGreaterThan(0);
    const p = out[0];
    // date HK-aware 归一 (员工 +08:00 → date-only)。
    expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // itemName 是 NK 列, 非空 ('' 只允许顶层行的 parentItemName 哨兵, itemName 恒有值)。
    expect(p.itemName.length).toBeGreaterThan(0);
    // displayType 进 NK, 非空且值域 ∈ {number, percentage} (probe verified; 全空 = 字段名漂移 → 修 adapter 映射)。
    for (const r of out) {
      expect(r.displayType.length).toBeGreaterThan(0);
      expect(['number', 'percentage']).toContain(r.displayType);
    }
    // 有 value 的行至少一行携带真数字串 (typed 解析成功; 全 null = 字段名漂移)。
    expect(out.some((r) => r.value !== null)).toBe(true);
    const withVal = out.find((r) => r.value !== null)!;
    expect(Number.isNaN(Number(withVal.value))).toBe(false);
    // 纯头行 (无 parentItemName + 无 value) 不落库: 每行至少 parentItemName 非空(数据行) 或 value 非空(顶层行)。
    for (const r of out) {
      expect(r.parentItemName.length > 0 || r.value !== null).toBe(true);
    }
    // date 升序 (端口契约): 首行 date ≤ 末行 date。
    expect(out[0].date <= out[out.length - 1].date).toBe(true);
  }, 30_000);
});
