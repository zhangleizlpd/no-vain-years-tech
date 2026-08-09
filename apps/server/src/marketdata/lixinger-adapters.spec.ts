import { describe, it, expect, vi } from 'vitest';
import type { PrismaService } from '../security/prisma.service.js';
import type { VendorHttpClient, VendorRequest } from './vendor-http-client.js';
import { LixingerEodBarAdapter } from './lixinger-eod-bar.adapter.js';
import { LixingerFundamentalAdapter } from './lixinger-fundamental.adapter.js';
import { LixingerFinancialsAdapter } from './lixinger-financials.adapter.js';
import { LixingerCorporateActionAdapter } from './lixinger-corporate-action.adapter.js';
import { LixingerShortSellingAdapter } from './lixinger-short-selling.adapter.js';
import { LixingerConnectHoldingAdapter } from './lixinger-connect-holding.adapter.js';
import { LixingerFundHoldingAdapter } from './lixinger-fund-holding.adapter.js';
import { LixingerFundCompanyHoldingAdapter } from './lixinger-fund-company-holding.adapter.js';
import { LixingerIndexMembershipAdapter } from './lixinger-index-membership.adapter.js';
import { LixingerIndustryClassificationAdapter } from './lixinger-industry-classification.adapter.js';
import { LixingerAnnouncementAdapter } from './lixinger-announcement.adapter.js';
import { LixingerVolatilityAdapter } from './lixinger-volatility.adapter.js';
import { LixingerHotAdapter } from './lixinger-hot.adapter.js';
import { LixingerBuybackAdapter } from './lixinger-buyback.adapter.js';
import { LixingerEquityChangeAdapter } from './lixinger-equity-change.adapter.js';
import { LixingerShareholderChangeAdapter } from './lixinger-shareholder-change.adapter.js';
import { LixingerAllotmentAdapter } from './lixinger-allotment.adapter.js';
import { LixingerRevenueSegmentAdapter } from './lixinger-revenue-segment.adapter.js';
import { LixingerShareholderSnapshotAdapter } from './lixinger-shareholder-snapshot.adapter.js';
import { LixingerEmployeeAdapter } from './lixinger-employee.adapter.js';

/**
 * 理杏仁 4 adapter mock 单测 (015 T006)。验请求结构 (path / body / token 注入) + 响应解析
 * + fsType 内部路由 + 缓存 + 签名不外泄。**真 vendor 字段值/契约**由 env-gated IT 校真
 * (test/integration/marketdata.lixinger.vendor.spec.ts, SC-S08) — 此处仅验解析逻辑。
 */

const TOKEN = 'test-token';
const BASE = 'https://open.lixinger.com/api';

interface Route {
  /** url 子串匹配 (sort 最长优先, 避免 /cn/company 抢 /cn/company/fundamental/x)。 */
  match: string;
  data: unknown[];
}

function makeHttp(routes: Route[]): { http: VendorHttpClient; calls: VendorRequest[] } {
  const sorted = [...routes].sort((a, b) => b.match.length - a.match.length);
  const calls: VendorRequest[] = [];
  const request = vi.fn(async (req: VendorRequest) => {
    calls.push(req);
    const route = sorted.find((r) => req.url.includes(r.match));
    if (!route) throw new Error(`[test] no route for ${req.url}`);
    return { code: 1, message: 'success', data: route.data };
  });
  return { http: { request } as unknown as VendorHttpClient, calls };
}

function makePrisma(cached: Record<string, string | null> = {}): {
  prisma: PrismaService;
  updateMany: ReturnType<typeof vi.fn>;
} {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const instrument = {
    findMany: vi.fn(async ({ where }: { where: { code: { in: string[] } } }) =>
      where.code.in
        .filter((c) => c in cached)
        .map((c) => ({ code: c, lixingerCompanyType: cached[c] })),
    ),
    updateMany,
  };
  return { prisma: { instrument } as unknown as PrismaService, updateMany };
}

function bodyOf(req: VendorRequest): Record<string, unknown> {
  return JSON.parse(req.body ?? '{}') as Record<string, unknown>;
}

describe('LixingerEodBarAdapter', () => {
  it('candlestick 行 → EodBarPoint, adjust→type 映射, 升序, change→changePct(×100)/to_r→turnoverRate/prevClose null', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/cn/company/candlestick',
        data: [
          {
            date: '2026-06-02T00:00:00+08:00',
            open: 1690,
            high: 1710,
            low: 1685,
            close: 1705,
            volume: 3000000,
            amount: 5100000000,
          },
          {
            date: '2026-06-01T00:00:00+08:00',
            open: 1680,
            high: 1705,
            low: 1675,
            close: 1700,
            volume: 3200000,
            amount: 5440000000,
            change: -0.0215, // 官方涨跌幅小数 → ×100 存 changePct
            to_r: 0.008, // 换手率 → turnoverRate
          },
        ],
      },
    ]);
    const adapter = new LixingerEodBarAdapter(http, TOKEN, BASE);

    const bars = await adapter.getBars({
      symbol: 'cn:600519',
      adjust: 'forward',
      from: '2026-06-01',
    });

    expect(bars.map((b) => b.tradeDate)).toEqual(['2026-06-01', '2026-06-02']); // 升序
    expect(bars[0]).toMatchObject({
      adjust: 'forward',
      close: '1700',
      changePct: '-2.1500', // change -0.0215 ×100 (Decimal, 无 float 漂移)
      turnoverRate: '0.008', // to_r 直透
      prevClose: null, // 理杏仁 ex_rights 不下发昨收
    });
    const body = bodyOf(calls[0]);
    expect(body.type).toBe('fc_rights'); // forward → fc_rights
    expect(body.stockCode).toBe('600519'); // 单只
    expect(body.startDate).toBe('2026-06-01');
    expect(body.token).toBe(TOKEN); // token 注入 body
  });

  it.each([
    ['none', 'ex_rights'],
    ['forward', 'fc_rights'],
    ['backward', 'bc_rights'],
  ] as const)('adjust %s → type %s', async (adjust, type) => {
    const { http, calls } = makeHttp([{ match: '/candlestick', data: [] }]);
    await new LixingerEodBarAdapter(http, TOKEN, BASE).getBars({
      symbol: 'cn:600519',
      adjust,
      from: '2026-01-01',
    });
    expect(bodyOf(calls[0]).type).toBe(type);
  });

  it('缺 from → 明确抛 (不发坏请求)', async () => {
    const { http } = makeHttp([{ match: '/candlestick', data: [] }]);
    await expect(
      new LixingerEodBarAdapter(http, TOKEN, BASE).getBars({ symbol: 'cn:600519', adjust: 'none' }),
    ).rejects.toThrow(/requires query.from/);
  });

  // 038 T002 seam#1: adapter 路径按 market 段插值 (cn 无回归 / hk 路由 / 未知前缀抛错)。
  it('cn:600519 → /cn/company/candlestick (无回归)', async () => {
    const { http, calls } = makeHttp([{ match: '/company/candlestick', data: [] }]);
    await new LixingerEodBarAdapter(http, TOKEN, BASE).getBars({
      symbol: 'cn:600519',
      adjust: 'none',
      from: '2026-01-01',
    });
    expect(calls[0].url).toContain('/cn/company/candlestick');
    expect(bodyOf(calls[0]).stockCode).toBe('600519');
  });

  it('hk:00700 → /hk/company/candlestick (market 段插值)', async () => {
    const { http, calls } = makeHttp([{ match: '/company/candlestick', data: [] }]);
    await new LixingerEodBarAdapter(http, TOKEN, BASE).getBars({
      symbol: 'hk:00700',
      adjust: 'none',
      from: '2026-01-01',
    });
    expect(calls[0].url).toContain('/hk/company/candlestick');
    expect(bodyOf(calls[0]).stockCode).toBe('00700');
  });

  it('未知市场前缀 (us) → UnsupportedLixingerMarketError (不静默错配)', async () => {
    const { http } = makeHttp([{ match: '/candlestick', data: [] }]);
    await expect(
      new LixingerEodBarAdapter(http, TOKEN, BASE).getBars({
        symbol: 'us:AAPL',
        adjust: 'none',
        from: '2026-01-01',
      }),
    ).rejects.toThrow(/unsupported market prefix/);
  });
});

describe('LixingerFundamentalAdapter (fsType 内部路由 + 缓存, FR-S11)', () => {
  const FUND_ROW = {
    stockCode: '600519',
    date: '2026-06-01T00:00:00+08:00',
    pe_ttm: 25.5,
    pb: 9.2,
    ps_ttm: 12.4,
    dyr: 1.8,
    mc: 2135000000000,
    cmc: 2135000000000,
    'pe_ttm.y3.cvpos': 0.42,
    'pe_ttm.y5.cvpos': 0.38,
    'pb.y3.cvpos': 0.55,
    'pb.y5.cvpos': 0.51,
  };

  it('缓存 miss → 调 /cn/company 拿 fsTableType → 路由 fundamental/{fsType} → 回写缓存 + 解析 cvpos', async () => {
    const { http, calls } = makeHttp([
      { match: '/cn/company/fundamental/non_financial', data: [FUND_ROW] },
      { match: '/cn/company', data: [{ stockCode: '600519', fsTableType: 'non_financial' }] },
    ]);
    const { prisma, updateMany } = makePrisma({}); // 无缓存

    const out = await new LixingerFundamentalAdapter(http, TOKEN, BASE, prisma).getFundamentals([
      'cn:600519',
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      symbol: 'cn:600519',
      date: '2026-06-01',
      peTtm: '25.5',
      peStatic: null, // 理杏仁仅 TTM 口径 (`pe` 非法 price metric)
      peDynamic: null,
      pb: '9.2',
      ps: '12.4',
      pePctlY3: '0.42',
      pbPctlY5: '0.51',
    });
    // 回写缓存
    expect(updateMany).toHaveBeenCalledWith({
      where: { market: 'cn', code: '600519' },
      data: { lixingerCompanyType: 'non_financial' },
    });
    // 路由到 trailing fsType 段端点
    expect(calls.some((c) => c.url.endsWith('/cn/company/fundamental/non_financial'))).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/cn/company'))).toBe(true);
    // fix(hk metric): cn fundamental 保留 cmc (流通市值 cn 有效, 不受 hk 裁剪影响)。
    const cnFundBody = bodyOf(calls.find((c) => c.url.includes('/fundamental/'))!);
    expect(cnFundBody.metricsList).toContain('cmc');
  });

  it('缓存 hit → 不调 /cn/company, 直接路由 fundamental/{cachedType}', async () => {
    const { http, calls } = makeHttp([
      { match: '/cn/company/fundamental/bank', data: [{ ...FUND_ROW }] },
    ]);
    const { prisma, updateMany } = makePrisma({ '600519': 'bank' });

    await new LixingerFundamentalAdapter(http, TOKEN, BASE, prisma).getFundamentals(['cn:600519']);

    expect(calls.some((c) => c.url.endsWith('/cn/company'))).toBe(false); // 零外呼 company
    expect(updateMany).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.endsWith('/cn/company/fundamental/bank'))).toBe(true);
  });

  it('端口签名不暴露 fsType (getFundamentals 仅 symbols 参)', () => {
    expect(LixingerFundamentalAdapter.prototype.getFundamentals.length).toBe(1);
  });

  // 038 T002 seam#1: 删旧 `.filter(market==='cn')` 静默丢弃 → hk 按 market 段路由到 /hk/。
  // (fsType 值域 reit 等 hk 特有值 = T009; 此处用已知 non_financial mock 验路径插值。)
  it('hk:00700 → /hk/company/fundamental/{fsType} (market 段插值, 不再静默丢弃)', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/fundamental/non_financial',
        data: [{ ...FUND_ROW, stockCode: '00700' }],
      },
    ]);
    const { prisma } = makePrisma({ '00700': 'non_financial' }); // 缓存命中 → 零 /company 外呼
    const out = await new LixingerFundamentalAdapter(http, TOKEN, BASE, prisma).getFundamentals([
      'hk:00700',
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe('hk:00700');
    expect(calls.some((c) => c.url.endsWith('/hk/company/fundamental/non_financial'))).toBe(true);
    expect(calls.every((c) => !c.url.includes('/cn/'))).toBe(true); // 无 cn 泄漏
    // fix(hk metric): hk fundamental 剔除 cmc (2026-07-12 prod 真调: cmc hk 无效, 理杏仁
    // all-or-nothing → metricsList 含任一 hk 无效 metric 整请求 code=0 返 0 行); 分位字段 hk 全下发保留。
    const hkFundBody = bodyOf(calls.find((c) => c.url.includes('/fundamental/'))!);
    expect(hkFundBody.metricsList).not.toContain('cmc');
    expect(hkFundBody.metricsList).toContain('pe_ttm.y3.cvpos');
  });

  it('未知市场前缀 (us) → UnsupportedLixingerMarketError', async () => {
    const { http } = makeHttp([{ match: '/x', data: [] }]);
    const { prisma } = makePrisma({});
    await expect(
      new LixingerFundamentalAdapter(http, TOKEN, BASE, prisma).getFundamentals(['us:AAPL']),
    ).rejects.toThrow(/unsupported market prefix/);
  });

  // 038 T009: hk 房托 reit fsType 解锁 → 路由 /hk/company/fundamental/reit (比 A 股多的值域)。
  it('hk reit 标的 → /hk/company/fundamental/reit (reit fsType 解锁, hk 特有房托)', async () => {
    const { http, calls } = makeHttp([
      { match: '/hk/company/fundamental/reit', data: [{ ...FUND_ROW, stockCode: '00823' }] },
    ]);
    const { prisma } = makePrisma({ '00823': 'reit' }); // 缓存命中 reit (领展房产基金)
    const out = await new LixingerFundamentalAdapter(http, TOKEN, BASE, prisma).getFundamentals([
      'hk:00823',
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe('hk:00823');
    expect(calls.some((c) => c.url.endsWith('/hk/company/fundamental/reit'))).toBe(true);
    expect(calls.every((c) => !c.url.includes('/cn/'))).toBe(true);
  });

  // 038 T009: hk 常规 fsType (bank) 与 A 股同构 (路由到 /hk/company/fundamental/bank)。
  it('hk 常规 fsType (bank) → /hk/company/fundamental/bank (与 A 股同构)', async () => {
    const { http, calls } = makeHttp([
      { match: '/hk/company/fundamental/bank', data: [{ ...FUND_ROW, stockCode: '00939' }] },
    ]);
    const { prisma } = makePrisma({ '00939': 'bank' }); // 建设银行 (hk 上市)
    const out = await new LixingerFundamentalAdapter(http, TOKEN, BASE, prisma).getFundamentals([
      'hk:00939',
    ]);
    expect(out).toHaveLength(1);
    expect(calls.some((c) => c.url.endsWith('/hk/company/fundamental/bank'))).toBe(true);
  });

  // 038 T013 seam#4: per-stock 区间抓取模式 (形态照抄 eod-bar getBars(from,to)) — 供 backfill
  // 拉 10yr 历史日频序列, 替代 date:'latest' 单快照。请求体单只 stockCode + startDate/endDate +
  // metricsList (非 date), 解析多行历史升序。
  it('038 T013 getFundamentalsRange hk:00700 → 区间 body (单只 stockCode/startDate/endDate/metricsList) + 解析多行历史升序', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/fundamental/non_financial',
        data: [
          { ...FUND_ROW, stockCode: '00700', date: '2020-06-15T00:00:00+08:00', pe_ttm: 30.1 },
          // 早年行缺分位字段 (DEFERRED-PROBE P2: hk fundamental 是否下发 pePctlY3/Y5 待 T020 确认) → 存 null 不崩。
          { stockCode: '00700', date: '2016-05-13T00:00:00+08:00', pe_ttm: 20.5 },
          { ...FUND_ROW, stockCode: '00700', date: '2026-05-15T00:00:00+08:00', pe_ttm: 25.5 },
        ],
      },
    ]);
    const { prisma } = makePrisma({ '00700': 'non_financial' }); // 缓存命中 → 零 /company 外呼
    const out = await new LixingerFundamentalAdapter(
      http,
      TOKEN,
      BASE,
      prisma,
    ).getFundamentalsRange({ symbol: 'hk:00700', from: '2016-05-13', to: '2026-05-15' });

    // 多行历史 (非单快照), tradeDate 升序 (端口契约)。
    expect(out.map((d) => d.date)).toEqual(['2016-05-13', '2020-06-15', '2026-05-15']);
    expect(out.every((d) => d.symbol === 'hk:00700')).toBe(true);
    expect(out[0].peTtm).toBe('20.5');
    expect(out[0].pePctlY3).toBeNull(); // P2: 缺分位字段 → null 不报错
    expect(out[2].pePctlY3).toBe('0.42'); // 有分位字段 → 照解析
    // 区间请求体 (非 date:'latest'): 单只 stockCodes 数组 + startDate/endDate + metricsList。
    // 理杏仁 range 模式 (startDate) 须 stockCodes 数组 (即使单股); stockCode 单数 → HTTP 400
    // (2026-07-12 prod 真调实证)。
    const body = bodyOf(calls.find((c) => c.url.includes('/fundamental/'))!);
    expect(body.stockCodes).toEqual(['00700']);
    expect(body.stockCode).toBeUndefined(); // 单数键不得残留 (range 模式发单数 → 400)
    expect(body.startDate).toBe('2016-05-13');
    expect(body.endDate).toBe('2026-05-15');
    expect(body.date).toBeUndefined();
    expect(Array.isArray(body.metricsList)).toBe(true);
    expect(body.metricsList).not.toContain('cmc'); // fix(hk metric): 区间 backfill 亦剔除 cmc
    expect(calls.some((c) => c.url.endsWith('/hk/company/fundamental/non_financial'))).toBe(true);
  });

  it('038 T013 getFundamentalsRange cn:600519 → /cn/company/fundamental/{fsType} (market-agnostic, cn 无回归)', async () => {
    const { http, calls } = makeHttp([
      { match: '/cn/company/fundamental/non_financial', data: [{ ...FUND_ROW }] },
    ]);
    const { prisma } = makePrisma({ '600519': 'non_financial' });
    const out = await new LixingerFundamentalAdapter(
      http,
      TOKEN,
      BASE,
      prisma,
    ).getFundamentalsRange({ symbol: 'cn:600519', from: '2016-01-01' });
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe('cn:600519');
    const body = bodyOf(calls.find((c) => c.url.includes('/fundamental/'))!);
    expect(body.stockCodes).toEqual(['600519']); // range 模式 stockCodes 数组 (cn 亦然, 单数 → 400)
    expect(body.stockCode).toBeUndefined();
    expect(body.startDate).toBe('2016-01-01');
    expect(body.endDate).toBeUndefined(); // to 省略 → 无 endDate
    expect(calls.some((c) => c.url.endsWith('/cn/company/fundamental/non_financial'))).toBe(true);
  });

  it('038 T013 getFundamentalsRange 未解析公司类型 → 空结果 (缺数据不崩, 无端点路由)', async () => {
    const { http, calls } = makeHttp([{ match: '/hk/company', data: [] }]); // /company 返空 → fsType 解析不出
    const { prisma } = makePrisma({}); // 无缓存
    const out = await new LixingerFundamentalAdapter(
      http,
      TOKEN,
      BASE,
      prisma,
    ).getFundamentalsRange({ symbol: 'hk:99998', from: '2020-01-01' });
    expect(out).toEqual([]);
    expect(calls.some((c) => c.url.includes('/fundamental/'))).toBe(false); // 无 fundamental 路由外呼
  });
});

describe('LixingerFinancialsAdapter (fs 端点 fsType 路由)', () => {
  it('路由 /cn/company/fs/{fsType} + 解析 metrics + reportPeriod 派生', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/cn/company/fs/non_financial',
        // 真 fs 响应嵌套 r.q.<报表>.<科目>.<计算类型> (env-gated IT 校真 2026-06-03)。
        data: [
          {
            stockCode: '600519',
            date: '2026-03-31T00:00:00+08:00',
            q: {
              m: { roe: { t: 0.31 } },
              ps: { gp_m: { t: 0.918 }, beps: { t: 18.5 } },
              bs: { tetoshopc_ps: { t: 185.2 } },
            },
          },
        ],
      },
    ]);
    const { prisma } = makePrisma({ '600519': 'non_financial' });

    const out = await new LixingerFinancialsAdapter(http, TOKEN, BASE, prisma).getFinancials([
      'cn:600519',
    ]);

    expect(out[0]).toMatchObject({
      symbol: 'cn:600519',
      reportPeriod: '2026Q1', // 03-31 → Q1
      roe: '0.31',
      grossMargin: '0.918',
      eps: '18.5',
      bps: '185.2',
    });
    expect(calls.some((c) => c.url.endsWith('/cn/company/fs/non_financial'))).toBe(true);
    // 非金融 → metricsList 含毛利率。
    expect(bodyOf(calls[0]).metricsList).toContain('q.ps.gp_m.t');
    // fix(hk metric): cn fs 保留 BPS (q.bs.tetoshopc_ps.t, cn 有效, 不受 hk 裁剪影响)。
    expect(bodyOf(calls[0]).metricsList).toContain('q.bs.tetoshopc_ps.t');
  });

  it('bank fsType → metricsList 去掉毛利率 (银行无 gp_m, 否则整请求 400), roe/eps/bps 照解析', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/cn/company/fs/bank',
        data: [
          {
            stockCode: '601398',
            date: '2026-03-31T00:00:00+08:00',
            q: {
              m: { roe: { t: 0.0204 } },
              ps: { beps: { t: 0.24 } },
              bs: { tetoshopc_ps: { t: 11.0625 } },
            },
          },
        ],
      },
    ]);
    const { prisma } = makePrisma({ '601398': 'bank' });

    const out = await new LixingerFinancialsAdapter(http, TOKEN, BASE, prisma).getFinancials([
      'cn:601398',
    ]);

    expect(bodyOf(calls[0]).metricsList).not.toContain('q.ps.gp_m.t'); // 银行无毛利率
    expect(out[0]).toMatchObject({ roe: '0.0204', eps: '0.24', bps: '11.0625', grossMargin: null });
  });

  // 038 T002 seam#1: fs 端点亦按 market 段插值 → /hk/company/fs/{fsType}。
  it('hk:00700 → /hk/company/fs/{fsType} (market 段插值, 不再静默丢弃)', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/fs/non_financial',
        data: [
          {
            stockCode: '00700',
            date: '2026-03-31T00:00:00+08:00',
            q: {
              m: { roe: { t: 0.25 } },
              ps: { beps: { t: 5.5 } },
              bs: { tetoshopc_ps: { t: 40 } },
            },
          },
        ],
      },
    ]);
    const { prisma } = makePrisma({ '00700': 'non_financial' });
    const out = await new LixingerFinancialsAdapter(http, TOKEN, BASE, prisma).getFinancials([
      'hk:00700',
    ]);
    expect(out[0]).toMatchObject({ symbol: 'hk:00700', reportPeriod: '2026Q1', roe: '0.25' });
    expect(calls.some((c) => c.url.endsWith('/hk/company/fs/non_financial'))).toBe(true);
    expect(calls.every((c) => !c.url.includes('/cn/'))).toBe(true);
    // fix(hk metric): hk fs 剔除 BPS (2026-07-12 prod 真调: q.bs.tetoshopc_ps.t hk 无效, 理杏仁
    // all-or-nothing → 含之整请求 code=0 返 0 行); roe/eps hk 有效保留。
    const hkFsBody = bodyOf(calls.find((c) => c.url.includes('/fs/'))!);
    expect(hkFsBody.metricsList).not.toContain('q.bs.tetoshopc_ps.t');
    expect(hkFsBody.metricsList).toContain('q.m.roe.t');
    expect(hkFsBody.metricsList).toContain('q.ps.beps.t');
  });

  // 038 T013 seam#4: fs per-stock 区间抓取 (照抄 eod-bar getBars(from,to)) — 供 backfill 拉多期
  // 财报历史。请求体单只 stockCode + startDate/endDate + metricsList (非 date:'latest'), 解析多期升序。
  it('038 T013 getFinancialsRange hk:00700 → 区间 body (单只 stockCode/startDate/endDate) + 解析多期升序', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/fs/non_financial',
        data: [
          {
            stockCode: '00700',
            date: '2025-12-31T00:00:00+08:00',
            q: {
              m: { roe: { t: 0.28 } },
              ps: { beps: { t: 6.1 } },
              bs: { tetoshopc_ps: { t: 44 } },
            },
          },
          {
            stockCode: '00700',
            date: '2024-12-31T00:00:00+08:00',
            q: {
              m: { roe: { t: 0.25 } },
              ps: { beps: { t: 5.5 } },
              bs: { tetoshopc_ps: { t: 40 } },
            },
          },
        ],
      },
    ]);
    const { prisma } = makePrisma({ '00700': 'non_financial' });
    const out = await new LixingerFinancialsAdapter(http, TOKEN, BASE, prisma).getFinancialsRange({
      symbol: 'hk:00700',
      from: '2020-01-01',
      to: '2025-12-31',
    });

    expect(out.map((d) => d.reportPeriod)).toEqual(['2024Q4', '2025Q4']); // 多期升序 (非单期)
    expect(out.every((d) => d.symbol === 'hk:00700')).toBe(true);
    expect(out[0].roe).toBe('0.25');
    const body = bodyOf(calls.find((c) => c.url.includes('/fs/'))!);
    expect(body.stockCodes).toEqual(['00700']); // range 模式 stockCodes 数组 (单数 → 400)
    expect(body.stockCode).toBeUndefined(); // 单数键不得残留 (range 模式发单数 → 400)
    expect(body.startDate).toBe('2020-01-01');
    expect(body.endDate).toBe('2025-12-31');
    expect(body.date).toBeUndefined();
    expect(Array.isArray(body.metricsList)).toBe(true);
    expect(body.metricsList).not.toContain('q.bs.tetoshopc_ps.t'); // fix(hk metric): 区间 backfill 亦剔除 BPS
    expect(calls.some((c) => c.url.endsWith('/hk/company/fs/non_financial'))).toBe(true);
  });
});

// ── 同 exDate 多行聚合 (2026-08-01) ──────────────────────────────────────────────
//
// vendor 对同一除权日常返多行 (特别息 + 常规息并存)。CorporateAction 自然键是
// (instrumentId, exDate, type) —— 两行同为 dividend 时后写覆盖先写, 静默丢掉那笔往往更大的
// 特别息, 且 DB 里查「同日多行」永远只有 1 行, 完全看不出来。因子按 n0/(n0−d) 算, d 少算 →
// 因子系统性偏小 (00026 丢 18.00 后算出 1.0024, 真值 1.1728)。故必须在 adapter 侧先聚合。
describe('LixingerCorporateActionAdapter 同 exDate 多行聚合', () => {
  // 真调实测行 (2026-08-01, hk:00026 / 00483)。
  const MULTI = [
    {
      date: '2019-08-02T00:00:00+08:00',
      exDate: '2019-08-16T00:00:00+08:00',
      currency: 'HKD',
      dividend: 18,
      content: '特别股息HKD 18.00',
    },
    {
      date: '2019-08-02T00:00:00+08:00',
      exDate: '2019-08-16T00:00:00+08:00',
      currency: 'HKD',
      dividend: 0.3,
      content: '第2次中期息HKD 0.30',
    },
  ];

  it('🚨 同日两笔派息 → 单 DTO, dividend 求和 (丢掉任一笔都会让因子系统性偏小)', async () => {
    const { http } = makeHttp([{ match: '/hk/company/dividend', data: MULTI }]);
    const out = await new LixingerCorporateActionAdapter(http, TOKEN, BASE).getCorporateActions(
      'hk:00026',
    );
    expect(out).toHaveLength(1); // 不是 2 —— 两行会被自然键折叠, 必须先合
    const p = out[0].payload as Record<string, unknown>;
    expect(p.dividend).toBe(18.3);
    expect(p.currency).toBe('HKD');
    expect(String(p.content)).toContain('特别股息');
    expect(String(p.content)).toContain('第2次中期息');
  });

  it('原始行无损存进 payload.rows (聚合值放顶层, 需要明细时可回查)', async () => {
    const { http } = makeHttp([{ match: '/hk/company/dividend', data: MULTI }]);
    const out = await new LixingerCorporateActionAdapter(http, TOKEN, BASE).getCorporateActions(
      'hk:00026',
    );
    const rows = (out[0].payload as Record<string, unknown>).rows as unknown[];
    expect(rows).toHaveLength(2);
    expect((rows[0] as Record<string, unknown>).dividend).toBe(18);
  });

  it('送转股比同样求和; 任一行判 split → 整个事件判 split', async () => {
    const { http } = makeHttp([
      {
        match: '/cn/company/dividend',
        data: [
          { exDate: '2024-06-04T00:00:00+08:00', dividend: 0.2, currency: 'CNY' },
          { exDate: '2024-06-04T00:00:00+08:00', bonusSharesFromProfit: 0.5, currency: 'CNY' },
        ],
      },
    ]);
    const out = await new LixingerCorporateActionAdapter(http, TOKEN, BASE).getCorporateActions(
      'cn:600519',
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('split');
    const p = out[0].payload as Record<string, unknown>;
    expect(p.dividend).toBe(0.2);
    expect(p.bonusSharesFromProfit).toBe(0.5);
  });

  it('单行时顶层结构与旧版等价 (存量 payload 兼容, 只多一个 rows)', async () => {
    const { http } = makeHttp([
      {
        match: '/hk/company/dividend',
        data: [{ exDate: '2025-05-26T00:00:00+08:00', dividend: 0.01, currency: 'HKD' }],
      },
    ]);
    const out = await new LixingerCorporateActionAdapter(http, TOKEN, BASE).getCorporateActions(
      'hk:00206',
    );
    const p = out[0].payload as Record<string, unknown>;
    expect(p.dividend).toBe(0.01);
    expect(p.currency).toBe('HKD');
  });
});

describe('LixingerCorporateActionAdapter', () => {
  it('/cn/company/dividend 单只 stockCode, camelCase exDate 降序, 送转→split, 无 exDate(预案)过滤', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/cn/company/dividend',
        // 真响应 camelCase (env-gated IT 校真 2026-06-03); exDate 仅已执行行有。
        data: [
          { exDate: '2025-06-20T00:00:00+08:00', dividend: 25 },
          { exDate: '2026-06-20T00:00:00+08:00', dividend: 30 },
          { exDate: '2024-06-20T00:00:00+08:00', bonusSharesFromCapitalReserve: 0.5 },
          { date: '2026-08-13T00:00:00+08:00', status: 'board_director_plan', dividend: 0 }, // 无 exDate → 过滤
        ],
      },
    ]);
    const out = await new LixingerCorporateActionAdapter(http, TOKEN, BASE).getCorporateActions(
      'cn:600519',
    );

    expect(out.map((a) => a.exDate)).toEqual(['2026-06-20', '2025-06-20', '2024-06-20']); // 降序 + 预案被过滤
    expect(out[0]).toMatchObject({ symbol: 'cn:600519', type: 'dividend' });
    expect(out[2].type).toBe('split'); // 送转股 bonusShares>0
    const body = bodyOf(calls[0]);
    expect(body.stockCode).toBe('600519');
    expect(body.token).toBe(TOKEN);
    expect(calls[0].url).toContain('/cn/company/dividend'); // cn 无回归
  });

  // 038 T002 seam#1: dividend 端点按 market 段插值 → /hk/company/dividend。
  it('hk:00700 → /hk/company/dividend (market 段插值)', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/dividend',
        data: [{ exDate: '2025-05-15T00:00:00+08:00', dividend: 2.4 }],
      },
    ]);
    const out = await new LixingerCorporateActionAdapter(http, TOKEN, BASE).getCorporateActions(
      'hk:00700',
    );
    expect(out[0]).toMatchObject({ symbol: 'hk:00700', exDate: '2025-05-15', type: 'dividend' });
    expect(calls[0].url).toContain('/hk/company/dividend');
    expect(bodyOf(calls[0]).stockCode).toBe('00700');
  });
});

// 039 T004 US1: 做空日频 adapter (SHORT_SELLING_PORT live) —— 请求体单数 stockCode (非数组) +
// date/shares/amount 解析 + date 升序 + market 段插值。真 vendor 契约由 env-gated IT 校真。
describe('LixingerShortSellingAdapter', () => {
  it('short-selling 行 → ShortSellingPoint, 单数 stockCode + startDate/endDate, date 升序解析', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/short-selling',
        data: [
          { date: '2025-05-31T00:00:00+08:00', shares: 1900000, amount: 950000000 },
          { date: '2025-05-30T00:00:00+08:00', shares: 1831500, amount: 915201080 },
        ],
      },
    ]);
    const out = await new LixingerShortSellingAdapter(http, TOKEN, BASE).getShortSellingRange({
      symbol: 'hk:00700',
      from: '2025-05-30',
      to: '2025-05-31',
    });

    expect(out.map((p) => p.date)).toEqual(['2025-05-30', '2025-05-31']); // 升序
    expect(out[0]).toMatchObject({ date: '2025-05-30', shares: '1831500', amount: '915201080' });
    const body = bodyOf(calls[0]);
    expect(body.stockCode).toBe('00700'); // 单数 stockCode (非数组 stockCodes)
    expect(body.stockCodes).toBeUndefined();
    expect(body.startDate).toBe('2025-05-30');
    expect(body.endDate).toBe('2025-05-31');
    expect(body.token).toBe(TOKEN); // token 注入 body
    expect(calls[0].url).toContain('/hk/company/short-selling');
  });

  it('省略 to → 无 endDate (至最新)', async () => {
    const { http, calls } = makeHttp([{ match: '/short-selling', data: [] }]);
    await new LixingerShortSellingAdapter(http, TOKEN, BASE).getShortSellingRange({
      symbol: 'hk:00700',
      from: '2015-01-01',
    });
    expect(bodyOf(calls[0]).endDate).toBeUndefined();
    expect(bodyOf(calls[0]).startDate).toBe('2015-01-01');
  });

  it('缺字段 (shares/amount 缺) → null 透传, 不崩', async () => {
    const { http } = makeHttp([
      { match: '/short-selling', data: [{ date: '2025-05-30T00:00:00+08:00' }] },
    ]);
    const out = await new LixingerShortSellingAdapter(http, TOKEN, BASE).getShortSellingRange({
      symbol: 'hk:00700',
      from: '2025-05-30',
    });
    expect(out[0]).toMatchObject({ date: '2025-05-30', shares: null, amount: null });
  });

  it('未知市场前缀 (us) → UnsupportedLixingerMarketError (不静默错配)', async () => {
    const { http } = makeHttp([{ match: '/short-selling', data: [] }]);
    await expect(
      new LixingerShortSellingAdapter(http, TOKEN, BASE).getShortSellingRange({
        symbol: 'us:AAPL',
        from: '2025-01-01',
      }),
    ).rejects.toThrow(/unsupported market prefix/);
  });
});

// 039 T005 US1: 南向持股日频 adapter (CONNECT_HOLDING_PORT live) —— 请求体单数 stockCode +
// date/shareholdings 解析 + date 升序 + **空返回 → [] 不崩** (非港股通标的). 真契约 env-gated IT 校真。
describe('LixingerConnectHoldingAdapter', () => {
  it('mutual-market 行 → ConnectHoldingPoint, 单数 stockCode, date 升序解析', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/mutual-market',
        data: [
          { date: '2025-05-31T00:00:00+08:00', shareholdings: 1050000000 },
          { date: '2025-05-30T00:00:00+08:00', shareholdings: 1039052782 },
        ],
      },
    ]);
    const out = await new LixingerConnectHoldingAdapter(http, TOKEN, BASE).getConnectHoldingRange({
      symbol: 'hk:00700',
      from: '2025-05-30',
      to: '2025-05-31',
    });

    expect(out.map((p) => p.date)).toEqual(['2025-05-30', '2025-05-31']); // 升序
    expect(out[0]).toMatchObject({ date: '2025-05-30', shareholdings: '1039052782' });
    const body = bodyOf(calls[0]);
    expect(body.stockCode).toBe('00700'); // 单数 (非数组)
    expect(body.stockCodes).toBeUndefined();
    expect(body.startDate).toBe('2025-05-30');
    expect(body.endDate).toBe('2025-05-31');
    expect(body.token).toBe(TOKEN);
    expect(calls[0].url).toContain('/hk/company/mutual-market');
  });

  it('非港股通标的 vendor 返 0 行 → [] (不崩; spec state_branch「南向非成分标的空数据」)', async () => {
    const { http } = makeHttp([{ match: '/mutual-market', data: [] }]);
    const out = await new LixingerConnectHoldingAdapter(http, TOKEN, BASE).getConnectHoldingRange({
      symbol: 'hk:08001', // 非港股通小盘
      from: '2015-01-01',
    });
    expect(out).toEqual([]);
  });

  it('缺 shareholdings 字段 → null 透传', async () => {
    const { http } = makeHttp([
      { match: '/mutual-market', data: [{ date: '2025-05-30T00:00:00+08:00' }] },
    ]);
    const out = await new LixingerConnectHoldingAdapter(http, TOKEN, BASE).getConnectHoldingRange({
      symbol: 'hk:00700',
      from: '2025-05-30',
    });
    expect(out[0]).toMatchObject({ date: '2025-05-30', shareholdings: null });
  });

  it('未知市场前缀 (us) → UnsupportedLixingerMarketError', async () => {
    const { http } = makeHttp([{ match: '/mutual-market', data: [] }]);
    await expect(
      new LixingerConnectHoldingAdapter(http, TOKEN, BASE).getConnectHoldingRange({
        symbol: 'us:AAPL',
        from: '2025-01-01',
      }),
    ).rejects.toThrow(/unsupported market prefix/);
  });
});

// 039 T009 US2: 公募基金持股 adapter (FUND_HOLDING_PORT live) —— 请求体单数 stockCode +
// date→reportDate/holdings/marketCap/... 解析 + reportDate 升序 + 缺字段→null (含名带 A 的
// proportionOfOutstandingSharesA hk 返 null 不因命名丢弃). 真契约 env-gated IT 校真。
describe('LixingerFundHoldingAdapter', () => {
  it('fund-shareholders 行 → FundHoldingDto, 单数 stockCode + startDate/endDate, reportDate 升序解析', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/fund-shareholders',
        data: [
          {
            date: '2025-06-30T00:00:00+08:00',
            holdings: 30000000,
            marketCap: 12000000000,
            netValueRatio: 0.31,
            marketCapRank: 2,
            declarationDate: '2025-07-20T00:00:00+08:00',
            fundCode: '513050',
            name: '易方达中证海外中国互联网50',
            proportionOfOutstandingSharesA: null,
          },
          {
            date: '2025-03-31T00:00:00+08:00',
            holdings: 24158500,
            marketCap: 11080211711,
            netValueRatio: 0.2994,
            marketCapRank: 1,
            declarationDate: '2025-04-22T00:00:00+08:00',
            fundCode: '513050',
            name: '易方达中证海外中国互联网50',
            proportionOfOutstandingSharesA: null,
          },
        ],
      },
    ]);
    const out = await new LixingerFundHoldingAdapter(http, TOKEN, BASE).getFundHoldingRange({
      symbol: 'hk:00700',
      from: '2025-01-01',
      to: '2025-06-30',
    });

    expect(out.map((p) => p.reportDate)).toEqual(['2025-03-31', '2025-06-30']); // reportDate 升序
    expect(out[0]).toMatchObject({
      reportDate: '2025-03-31',
      fundCode: '513050',
      name: '易方达中证海外中国互联网50',
      holdings: '24158500',
      marketCap: '11080211711',
      netValueRatio: '0.2994',
      marketCapRank: 1, // number|null (Prisma Int? 列)
      declarationDate: '2025-04-22',
      proportionOutstandingSharesA: null, // 名带 A, hk 返 null → 存 null 不丢弃
    });
    const body = bodyOf(calls[0]);
    expect(body.stockCode).toBe('00700'); // 单数 stockCode (非数组 stockCodes)
    expect(body.stockCodes).toBeUndefined();
    expect(body.startDate).toBe('2025-01-01');
    expect(body.endDate).toBe('2025-06-30');
    expect(body.token).toBe(TOKEN);
    expect(calls[0].url).toContain('/hk/company/fund-shareholders');
  });

  it('省略 to → 无 endDate (至最新)', async () => {
    const { http, calls } = makeHttp([{ match: '/fund-shareholders', data: [] }]);
    await new LixingerFundHoldingAdapter(http, TOKEN, BASE).getFundHoldingRange({
      symbol: 'hk:00700',
      from: '2021-01-01',
    });
    expect(bodyOf(calls[0]).endDate).toBeUndefined();
    expect(bodyOf(calls[0]).startDate).toBe('2021-01-01');
  });

  it('缺字段 (holdings/marketCapRank/declarationDate/proportion 缺) → null 透传, 不崩', async () => {
    const { http } = makeHttp([
      {
        match: '/fund-shareholders',
        data: [{ date: '2025-03-31T00:00:00+08:00', fundCode: '513050' }],
      },
    ]);
    const out = await new LixingerFundHoldingAdapter(http, TOKEN, BASE).getFundHoldingRange({
      symbol: 'hk:00700',
      from: '2025-01-01',
    });
    expect(out[0]).toMatchObject({
      reportDate: '2025-03-31',
      fundCode: '513050',
      name: null,
      holdings: null,
      marketCap: null,
      netValueRatio: null,
      marketCapRank: null,
      declarationDate: null,
      proportionOutstandingSharesA: null,
    });
  });

  it('未知市场前缀 (us) → UnsupportedLixingerMarketError (不静默错配)', async () => {
    const { http } = makeHttp([{ match: '/fund-shareholders', data: [] }]);
    await expect(
      new LixingerFundHoldingAdapter(http, TOKEN, BASE).getFundHoldingRange({
        symbol: 'us:AAPL',
        from: '2025-01-01',
      }),
    ).rejects.toThrow(/unsupported market prefix/);
  });
});

// 039 T010 US2: 基金公司持股 adapter (FUND_COMPANY_HOLDING_PORT live) —— 请求体单数 stockCode +
// date→reportDate/marketCap/holdings/fundCollectionCode 解析 + reportDate 升序 + 缺字段→null.
describe('LixingerFundCompanyHoldingAdapter', () => {
  it('fund-collection-shareholders 行 → FundCompanyHoldingDto, 单数 stockCode, reportDate 升序解析', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/fund-collection-shareholders',
        data: [
          {
            date: '2025-06-30T00:00:00+08:00',
            marketCap: 400000000,
            holdings: 800000,
            name: '中信证券资产管理有限公司',
            fundCollectionCode: '14240000',
            proportionOfOutstandingSharesA: null,
          },
          {
            date: '2025-03-31T00:00:00+08:00',
            marketCap: 320952688,
            holdings: 690600,
            name: '中信证券资产管理有限公司',
            fundCollectionCode: '14240000',
            proportionOfOutstandingSharesA: null,
          },
        ],
      },
    ]);
    const out = await new LixingerFundCompanyHoldingAdapter(
      http,
      TOKEN,
      BASE,
    ).getFundCompanyHoldingRange({ symbol: 'hk:00700', from: '2025-01-01', to: '2025-06-30' });

    expect(out.map((p) => p.reportDate)).toEqual(['2025-03-31', '2025-06-30']); // reportDate 升序
    expect(out[0]).toMatchObject({
      reportDate: '2025-03-31',
      fundCollectionCode: '14240000',
      name: '中信证券资产管理有限公司',
      holdings: '690600',
      marketCap: '320952688',
    });
    const body = bodyOf(calls[0]);
    expect(body.stockCode).toBe('00700'); // 单数 (非数组)
    expect(body.stockCodes).toBeUndefined();
    expect(body.startDate).toBe('2025-01-01');
    expect(body.endDate).toBe('2025-06-30');
    expect(body.token).toBe(TOKEN);
    expect(calls[0].url).toContain('/hk/company/fund-collection-shareholders');
  });

  it('省略 to → 无 endDate (至最新)', async () => {
    const { http, calls } = makeHttp([{ match: '/fund-collection-shareholders', data: [] }]);
    await new LixingerFundCompanyHoldingAdapter(http, TOKEN, BASE).getFundCompanyHoldingRange({
      symbol: 'hk:00700',
      from: '2021-01-01',
    });
    expect(bodyOf(calls[0]).endDate).toBeUndefined();
    expect(bodyOf(calls[0]).startDate).toBe('2021-01-01');
  });

  it('缺字段 (marketCap/holdings/name 缺) → null 透传, 不崩', async () => {
    const { http } = makeHttp([
      {
        match: '/fund-collection-shareholders',
        data: [{ date: '2025-03-31T00:00:00+08:00', fundCollectionCode: '14240000' }],
      },
    ]);
    const out = await new LixingerFundCompanyHoldingAdapter(
      http,
      TOKEN,
      BASE,
    ).getFundCompanyHoldingRange({ symbol: 'hk:00700', from: '2025-01-01' });
    expect(out[0]).toMatchObject({
      reportDate: '2025-03-31',
      fundCollectionCode: '14240000',
      name: null,
      holdings: null,
      marketCap: null,
    });
  });

  it('未知市场前缀 (us) → UnsupportedLixingerMarketError', async () => {
    const { http } = makeHttp([{ match: '/fund-collection-shareholders', data: [] }]);
    await expect(
      new LixingerFundCompanyHoldingAdapter(http, TOKEN, BASE).getFundCompanyHoldingRange({
        symbol: 'us:AAPL',
        from: '2025-01-01',
      }),
    ).rejects.toThrow(/unsupported market prefix/);
  });
});

// 039 T014 US3: 所属指数 adapter (INDEX_MEMBERSHIP_PORT live) —— **第 3 形态: 请求体无日期** +
// 单数 stockCode + vendor `stockCode` 字段(实为指数代码)→indexCode 解析 + name/source/areaCode +
// 缺字段→null. 真契约 env-gated IT 校真。
describe('LixingerIndexMembershipAdapter', () => {
  it('indices 行 → IndexMembershipDto, 单数 stockCode + 无日期, vendor stockCode→indexCode, indexCode 升序', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/indices',
        data: [
          { areaCode: 'hk', stockCode: '1000015', source: 'lxri', name: '港股全指' },
          { areaCode: 'hk', stockCode: '1000001', source: 'lxri', name: '恒生指数' },
        ],
      },
    ]);
    const out = await new LixingerIndexMembershipAdapter(http, TOKEN, BASE).getIndexMembership(
      'hk:00700',
    );

    expect(out.map((m) => m.indexCode)).toEqual(['1000001', '1000015']); // indexCode 升序
    expect(out[0]).toMatchObject({
      indexCode: '1000001',
      name: '恒生指数',
      source: 'lxri',
      areaCode: 'hk',
    });
    const body = bodyOf(calls[0]);
    expect(body.stockCode).toBe('00700'); // 单数 (非数组 stockCodes)
    expect(body.stockCodes).toBeUndefined();
    expect(body.startDate).toBeUndefined(); // 第 3 形态: 无日期
    expect(body.endDate).toBeUndefined();
    expect(body.token).toBe(TOKEN); // token 注入 body
    expect(calls[0].url).toContain('/hk/company/indices');
  });

  it('无归属标的 vendor 返 0 行 → [] (不崩)', async () => {
    const { http } = makeHttp([{ match: '/indices', data: [] }]);
    const out = await new LixingerIndexMembershipAdapter(http, TOKEN, BASE).getIndexMembership(
      'hk:08001',
    );
    expect(out).toEqual([]);
  });

  it('缺字段 (name/source/areaCode 缺) → null 透传, indexCode 保留', async () => {
    const { http } = makeHttp([{ match: '/indices', data: [{ stockCode: '1000015' }] }]);
    const out = await new LixingerIndexMembershipAdapter(http, TOKEN, BASE).getIndexMembership(
      'hk:00700',
    );
    expect(out[0]).toMatchObject({
      indexCode: '1000015',
      name: null,
      source: null,
      areaCode: null,
    });
  });

  it('未知市场前缀 (us) → UnsupportedLixingerMarketError (不静默错配)', async () => {
    const { http } = makeHttp([{ match: '/indices', data: [] }]);
    await expect(
      new LixingerIndexMembershipAdapter(http, TOKEN, BASE).getIndexMembership('us:AAPL'),
    ).rejects.toThrow(/unsupported market prefix/);
  });
});

// 043 T004 US1: 所属行业 adapter (INDUSTRY_CLASSIFICATION_PORT live) —— 覆盖式快照形态 (照抄
// index_membership): 请求体单数 stockCode + **无 date/无 startDate** + vendor stockCode→industryCode
// 映射 + 3 级层级 3 行全出不去重 + source 透传 + 缺 name/areaCode null + 空数组容错。
// 真 vendor 契约由 env-gated IT 校真。
describe('LixingerIndustryClassificationAdapter', () => {
  it('industries 行 → IndustryClassificationDto, 单数 stockCode + 无 date, vendor stockCode→industryCode, 3 级层级全出不去重, industryCode 升序', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/industries',
        data: [
          { areaCode: 'hk', stockCode: 'H7020', source: 'hsi', name: '软件与服务' },
          { areaCode: 'hk', stockCode: 'H70', source: 'hsi', name: '资讯科技业' },
          { areaCode: 'hk', stockCode: 'H702015', source: 'hsi', name: '互联网软件与服务' },
        ],
      },
    ]);
    const out = await new LixingerIndustryClassificationAdapter(
      http,
      TOKEN,
      BASE,
    ).getIndustryClassification('hk:00700');

    // 3 级层级 3 行全出、不去重; industryCode 升序 (前缀先排 → 天然层级序 L1<L2<L3, vendor stockCode 字段 = 行业代码)。
    expect(out.map((m) => m.industryCode)).toEqual(['H70', 'H7020', 'H702015']);
    expect(out).toHaveLength(3);
    expect(out.find((m) => m.industryCode === 'H70')).toMatchObject({
      industryCode: 'H70',
      source: 'hsi', // source 透传
      name: '资讯科技业',
      areaCode: 'hk',
    });
    const body = bodyOf(calls[0]);
    expect(body.stockCode).toBe('00700'); // 单数 (非数组 stockCodes)
    expect(body.stockCodes).toBeUndefined();
    expect(body.date).toBeUndefined(); // 覆盖式快照: 无 date
    expect(body.startDate).toBeUndefined(); // 无 startDate
    expect(body.endDate).toBeUndefined();
    expect(body.token).toBe(TOKEN); // token 注入 body
    expect(calls[0].url).toContain('/hk/company/industries');
  });

  it('无归属标的 vendor 返 0 行 → [] (不崩)', async () => {
    const { http } = makeHttp([{ match: '/industries', data: [] }]);
    const out = await new LixingerIndustryClassificationAdapter(
      http,
      TOKEN,
      BASE,
    ).getIndustryClassification('hk:08526');
    expect(out).toEqual([]);
  });

  it('缺字段 (name/areaCode 缺) → null 透传, industryCode/source 保留', async () => {
    const { http } = makeHttp([
      { match: '/industries', data: [{ stockCode: 'H70', source: 'hsi' }] },
    ]);
    const out = await new LixingerIndustryClassificationAdapter(
      http,
      TOKEN,
      BASE,
    ).getIndustryClassification('hk:00700');
    expect(out[0]).toMatchObject({
      industryCode: 'H70',
      source: 'hsi',
      name: null,
      areaCode: null,
    });
  });

  it('未知市场前缀 (us) → UnsupportedLixingerMarketError (不静默错配)', async () => {
    const { http } = makeHttp([{ match: '/industries', data: [] }]);
    await expect(
      new LixingerIndustryClassificationAdapter(http, TOKEN, BASE).getIndustryClassification(
        'us:AAPL',
      ),
    ).rejects.toThrow(/unsupported market prefix/);
  });
});

// 043 T007 US2: 公告 adapter (ANNOUNCEMENT_PORT live) —— range 文本流形态 (照抄 buyback): 请求体单数
// stockCode + startDate/endDate + **无 metricsList** (无 all-or-nothing 坑) + **date `+08:00` lixDateOnly
// 无 off-by-one** + linkUrl 透传 + linkText/linkType null 透传 + types 数组保真 (缺→[]) + date 升序 +
// 空数组容错 + market 段插值。真契约 env-gated IT 校真 (≤10yr)。
describe('LixingerAnnouncementAdapter', () => {
  it('announcement 行 → AnnouncementDto, 单数 stockCode + startDate/endDate, date +08:00 lixDateOnly 无 off-by-one, types 数组保真, date 升序', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/announcement',
        data: [
          {
            // p3 探查报告实测样本形态 (hk:00700, date +08:00 HK-local)。
            date: '2024-12-31T00:00:00+08:00',
            linkUrl: 'https://www1.hkexnews.hk/listedco/2024/1231/a.pdf',
            linkText: '翌日披露报表',
            linkType: 'PDF',
            types: ['ndd_r', 'srp'],
          },
          {
            date: '2024-12-30T00:00:00+08:00',
            linkUrl: 'https://www1.hkexnews.hk/listedco/2024/1230/b.pdf',
            linkText: '股份购回报告',
            linkType: 'PDF',
            types: ['mr'],
          },
        ],
      },
    ]);
    const out = await new LixingerAnnouncementAdapter(http, TOKEN, BASE).getAnnouncementRange({
      symbol: 'hk:00700',
      from: '2024-12-30',
      to: '2024-12-31',
    });

    // date 升序 + `+08:00` slice(0,10) 正确无 off-by-one (2024-12-31 保持不退到 12-30)。
    expect(out.map((a) => a.date)).toEqual(['2024-12-30', '2024-12-31']);
    expect(out[0]).toMatchObject({
      date: '2024-12-30',
      linkUrl: 'https://www1.hkexnews.hk/listedco/2024/1230/b.pdf',
      linkText: '股份购回报告',
      linkType: 'PDF',
      types: ['mr'],
    });
    // types 数组保真 (多标签保留、不折叠)。
    expect(out[1].types).toEqual(['ndd_r', 'srp']);

    const body = bodyOf(calls[0]);
    expect(body.stockCode).toBe('00700'); // 单数 stockCode (非数组 stockCodes)
    expect(body.stockCodes).toBeUndefined();
    expect(body.startDate).toBe('2024-12-30');
    expect(body.endDate).toBe('2025-01-01'); // 右开归一 = to + 1 天 (见下方专项用例)
    expect(body.token).toBe(TOKEN); // token 注入 body
    expect(body.metricsList).toBeUndefined(); // 不用 metricsList (无 all-or-nothing 坑)
    expect(calls[0].url).toContain('/hk/company/announcement');
  });

  // 🚨 本端点 endDate **排他** (右开), 本族里独一份 → adapter +1 天归一到端口的右闭契约。
  // 不归一则 executor delta 的 from=to=asOf 是空区间 → 每晚 0 行且 SyncRun 全绿
  // (043 上线起 prod 静默 12 个交易日无增量, 2026-08-01 探针实测定性)。
  it('endDate 右开归一: 请求体 endDate = to + 1 天', async () => {
    const { http, calls } = makeHttp([{ match: '/announcement', data: [] }]);
    await new LixingerAnnouncementAdapter(http, TOKEN, BASE).getAnnouncementRange({
      symbol: 'hk:00700',
      from: '2024-12-30',
      to: '2024-12-31',
    });
    expect(bodyOf(calls[0]).startDate).toBe('2024-12-30');
    expect(bodyOf(calls[0]).endDate).toBe('2025-01-01'); // 跨年/跨月进位亦正确
  });

  it('单日窗 from=to → endDate 仍 +1 天 (右开语义下不塌成空区间)', async () => {
    const { http, calls } = makeHttp([{ match: '/announcement', data: [] }]);
    await new LixingerAnnouncementAdapter(http, TOKEN, BASE).getAnnouncementRange({
      symbol: 'hk:00700',
      from: '2026-07-31',
      to: '2026-07-31',
    });
    // 归一前这里会发出 [07-31, 07-31] = 空区间 → vendor 恒返 0 行 (prod 实证的病灶形状)。
    expect(bodyOf(calls[0]).startDate).toBe('2026-07-31');
    expect(bodyOf(calls[0]).endDate).toBe('2026-08-01');
  });

  it('省略 to → 无 endDate (至最新)', async () => {
    const { http, calls } = makeHttp([{ match: '/announcement', data: [] }]);
    await new LixingerAnnouncementAdapter(http, TOKEN, BASE).getAnnouncementRange({
      symbol: 'hk:00700',
      from: '2016-07-16',
    });
    expect(bodyOf(calls[0]).endDate).toBeUndefined();
    expect(bodyOf(calls[0]).startDate).toBe('2016-07-16');
  });

  it('缺字段 (linkText/linkType 缺) → null 透传, linkUrl 保留; 缺 types → 空数组', async () => {
    const { http } = makeHttp([
      {
        match: '/announcement',
        data: [
          {
            date: '2024-12-30T00:00:00+08:00',
            linkUrl: 'https://www1.hkexnews.hk/listedco/2024/1230/c.pdf',
            // 无 linkText / linkType / types
          },
        ],
      },
    ]);
    const out = await new LixingerAnnouncementAdapter(http, TOKEN, BASE).getAnnouncementRange({
      symbol: 'hk:00700',
      from: '2024-12-30',
    });
    expect(out[0]).toMatchObject({
      date: '2024-12-30',
      linkUrl: 'https://www1.hkexnews.hk/listedco/2024/1230/c.pdf',
      linkText: null,
      linkType: null,
      types: [], // 缺 types → 空数组 (非 null)
    });
  });

  it('types 非数组 (vendor 返 null/字符串) → 空数组容错 (不崩)', async () => {
    const { http } = makeHttp([
      {
        match: '/announcement',
        data: [
          {
            date: '2024-12-30T00:00:00+08:00',
            linkUrl: 'https://www1.hkexnews.hk/listedco/2024/1230/d.pdf',
            types: null, // 非数组
          },
        ],
      },
    ]);
    const out = await new LixingerAnnouncementAdapter(http, TOKEN, BASE).getAnnouncementRange({
      symbol: 'hk:00700',
      from: '2024-12-30',
    });
    expect(out[0].types).toEqual([]);
  });

  it('无公告标的 vendor 返 0 行 → [] (不崩)', async () => {
    const { http } = makeHttp([{ match: '/announcement', data: [] }]);
    const out = await new LixingerAnnouncementAdapter(http, TOKEN, BASE).getAnnouncementRange({
      symbol: 'hk:08001', // 无公告小盘
      from: '2016-07-16',
    });
    expect(out).toEqual([]);
  });

  it('未知市场前缀 (us) → UnsupportedLixingerMarketError (不静默错配)', async () => {
    const { http } = makeHttp([{ match: '/announcement', data: [] }]);
    await expect(
      new LixingerAnnouncementAdapter(http, TOKEN, BASE).getAnnouncementRange({
        symbol: 'us:AAPL',
        from: '2025-01-01',
      }),
    ).rejects.toThrow(/unsupported market prefix/);
  });
});

// 040 T004 US1: 波动率日频 adapter (VOLATILITY_PORT live) —— 请求体单数 stockCode +
// **volatilityDays 单数 number** (非数组) + date/value 解析 + date 升序 + market 段插值。
// 真 vendor 契约由 env-gated IT 校真。
describe('LixingerVolatilityAdapter', () => {
  it('volatility 行 → VolatilityPoint, 单数 stockCode + volatilityDays number 单数 + startDate/endDate, date 升序解析', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/volatility',
        data: [
          { date: '2024-12-31T00:00:00+08:00', value: 0.3267671516225093 },
          { date: '2024-12-30T00:00:00+08:00', value: 0.3377492957220201 },
        ],
      },
    ]);
    const out = await new LixingerVolatilityAdapter(http, TOKEN, BASE).getVolatilityRange({
      symbol: 'hk:00700',
      volatilityDays: 250,
      from: '2024-12-30',
      to: '2024-12-31',
    });

    expect(out.map((p) => p.date)).toEqual(['2024-12-30', '2024-12-31']); // 升序
    expect(out[0]).toMatchObject({ date: '2024-12-30', value: '0.3377492957220201' });
    const body = bodyOf(calls[0]);
    expect(body.stockCode).toBe('00700'); // 单数 stockCode (非数组 stockCodes)
    expect(body.stockCodes).toBeUndefined();
    expect(body.volatilityDays).toBe(250); // number 单数 (非数组 [250])
    expect(typeof body.volatilityDays).toBe('number');
    expect(Array.isArray(body.volatilityDays)).toBe(false);
    expect(body.startDate).toBe('2024-12-30');
    expect(body.endDate).toBe('2024-12-31');
    expect(body.token).toBe(TOKEN); // token 注入 body
    expect(body.metricsList).toBeUndefined(); // 不用 metricsList (无 all-or-nothing 坑)
    expect(calls[0].url).toContain('/hk/company/volatility');
  });

  it('省略 to → 无 endDate (至最新)', async () => {
    const { http, calls } = makeHttp([{ match: '/volatility', data: [] }]);
    await new LixingerVolatilityAdapter(http, TOKEN, BASE).getVolatilityRange({
      symbol: 'hk:00700',
      volatilityDays: 30,
      from: '2015-01-01',
    });
    expect(bodyOf(calls[0]).endDate).toBeUndefined();
    expect(bodyOf(calls[0]).startDate).toBe('2015-01-01');
    expect(bodyOf(calls[0]).volatilityDays).toBe(30);
  });

  it('缺 value 字段 → null 透传, 不崩', async () => {
    const { http } = makeHttp([
      { match: '/volatility', data: [{ date: '2024-12-31T00:00:00+08:00' }] },
    ]);
    const out = await new LixingerVolatilityAdapter(http, TOKEN, BASE).getVolatilityRange({
      symbol: 'hk:00700',
      volatilityDays: 60,
      from: '2024-12-31',
    });
    expect(out[0]).toMatchObject({ date: '2024-12-31', value: null });
  });

  it('未知市场前缀 (us) → UnsupportedLixingerMarketError (不静默错配)', async () => {
    const { http } = makeHttp([{ match: '/volatility', data: [] }]);
    await expect(
      new LixingerVolatilityAdapter(http, TOKEN, BASE).getVolatilityRange({
        symbol: 'us:AAPL',
        volatilityDays: 250,
        from: '2025-01-01',
      }),
    ).rejects.toThrow(/unsupported market prefix/);
  });
});

// 040 T007 US2: 热度精选快照 adapter (HOT_SNAPSHOT_PORT live) —— 请求体 **`stockCodes[]` 数组**
// (与波动率单数 stockCode 相反) + **无日期** (快照) + payload 整存 vendor 原始异构字段 + **忽略异常
// key "undefined"** (hot/rep 数据质量, FR-007) + last_data_date→dataDate + 缺 last_data_date 跳过 +
// market 段插值。真 vendor 契约由 env-gated IT 校真。
describe('LixingerHotAdapter', () => {
  it('hot 行 → HotSnapshotDto, stockCodes 数组 (非单数) + 无日期, payload 整存原始字段, last_data_date→dataDate', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/hot/ss',
        data: [
          {
            ass_m: 0.12,
            ass_s: 1000,
            ass_s_cap_r: 0.05,
            last_data_date: '2026-06-01T00:00:00+08:00',
            stockCode: '00700',
          },
        ],
      },
    ]);
    const out = await new LixingerHotAdapter(http, TOKEN, BASE).getHotSnapshot({
      hotType: 'ss',
      stockCodes: ['hk:00700'],
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ hotType: 'ss', dataDate: '2026-06-01' });
    // payload 整存 vendor 原始异构字段 (含 stockCode / last_data_date 等)。
    expect(out[0].payload).toMatchObject({
      ass_m: 0.12,
      ass_s: 1000,
      ass_s_cap_r: 0.05,
      stockCode: '00700',
    });
    const body = bodyOf(calls[0]);
    expect(Array.isArray(body.stockCodes)).toBe(true); // 数组 (非单数 stockCode)
    expect(body.stockCodes).toEqual(['00700']);
    expect(body.stockCode).toBeUndefined(); // 单数键不得残留
    expect(body.startDate).toBeUndefined(); // 快照: 无日期
    expect(body.endDate).toBeUndefined();
    expect(body.date).toBeUndefined();
    expect(body.token).toBe(TOKEN); // token 注入 body
    expect(calls[0].url).toContain('/hk/company/hot/ss');
  });

  it('hot type path 段插值: capita → /hk/company/hot/capita (type 循环由 executor 驱动)', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/hot/capita',
        data: [{ stn: 50000, stn_mc_pc: 0.3, last_data_date: '2025-12-31T00:00:00+08:00' }],
      },
    ]);
    const out = await new LixingerHotAdapter(http, TOKEN, BASE).getHotSnapshot({
      hotType: 'capita',
      stockCodes: ['hk:00700'],
    });
    expect(out[0]).toMatchObject({ hotType: 'capita', dataDate: '2025-12-31' });
    expect(out[0].payload).toMatchObject({ stn: 50000, stn_mc_pc: 0.3 });
    expect(calls[0].url).toContain('/hk/company/hot/capita');
  });

  it('vendor 数据质量: rep payload 含异常 key "undefined" → 忽略该 key (FR-007), 正常字段保留', async () => {
    const { http } = makeHttp([
      {
        match: '/hk/company/hot/rep',
        // hot/rep 真实含异常 key "undefined" (p3 探查报告 §hot 实测) → 建模忽略。
        data: [
          {
            rs_m1: 0.9,
            rs_m3: 0.85,
            rs_last: 1.1,
            undefined: 'garbage-value',
            last_data_date: '2026-06-01T00:00:00+08:00',
            stockCode: '00700',
          },
        ],
      },
    ]);
    const out = await new LixingerHotAdapter(http, TOKEN, BASE).getHotSnapshot({
      hotType: 'rep',
      stockCodes: ['hk:00700'],
    });
    expect(out).toHaveLength(1);
    // 异常 key 已忽略 (payload 不含 "undefined")。
    expect(Object.keys(out[0].payload)).not.toContain('undefined');
    // 正常字段保留 (payload 整存)。
    expect(out[0].payload).toMatchObject({ rs_m1: 0.9, rs_m3: 0.85, rs_last: 1.1 });
  });

  it('缺 last_data_date 的行 → 跳过 (无自然键, 同 corp-action 无 exDate 过滤)', async () => {
    const { http } = makeHttp([
      {
        match: '/hk/company/hot/tr',
        data: [
          { tr_d1: 0.02, last_data_date: '2026-06-01T00:00:00+08:00', stockCode: '00700' },
          { tr_d1: 0.03, stockCode: '00701' }, // 无 last_data_date → 跳过
        ],
      },
    ]);
    const out = await new LixingerHotAdapter(http, TOKEN, BASE).getHotSnapshot({
      hotType: 'tr',
      stockCodes: ['hk:00700'],
    });
    expect(out).toHaveLength(1); // 缺 last_data_date 行被跳过
    expect(out[0]).toMatchObject({ hotType: 'tr', dataDate: '2026-06-01' });
  });

  it('空 stockCodes → 零外呼返 [] (不发坏请求)', async () => {
    const { http, calls } = makeHttp([{ match: '/hot/', data: [] }]);
    const out = await new LixingerHotAdapter(http, TOKEN, BASE).getHotSnapshot({
      hotType: 'ss',
      stockCodes: [],
    });
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0); // 空入参不外呼
  });

  it('未知市场前缀 (us) → UnsupportedLixingerMarketError (不静默错配)', async () => {
    const { http } = makeHttp([{ match: '/hot/', data: [] }]);
    await expect(
      new LixingerHotAdapter(http, TOKEN, BASE).getHotSnapshot({
        hotType: 'ss',
        stockCodes: ['us:AAPL'],
      }),
    ).rejects.toThrow(/unsupported market prefix/);
  });
});

// 041 T004 US1: 回购事件 adapter (BUYBACK_PORT live) —— 请求体单数 stockCode (非数组 stockCodes) +
// **无 metricsList** (无 all-or-nothing 坑) + 丰富 typed 字段解析 (num/highestPrice/lowestPrice/
// avgPrice/totalPaid/methodOfPurchase/totalSharesForCancellation/ratioPurchasedSinceResolution/
// currency/boardType…) + date 升序 + 缺字段 null 透传 + 空数组容错 + market 段插值. 真契约 env-gated IT 校真。
describe('LixingerBuybackAdapter', () => {
  it('repurchase 行 → BuybackDto, 单数 stockCode + startDate/endDate, 丰富字段解析, date 升序', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/repurchase',
        data: [
          {
            _id: '68f6e365d5961364e4428dcd',
            date: '2024-12-31T00:00:00+08:00',
            num: 1500000,
            highestPrice: 430,
            lowestPrice: 420,
            avgPrice: 425.5,
            totalPaid: 638250000,
            methodOfPurchase: 'exchange',
            totalSharesForCancellation: 1500000,
            totalSharesForTreasury: 0,
            ratioPurchasedSinceResolution: 0.03,
            currency: 'HKD',
            boardType: 'main',
          },
          {
            // p3 探查报告实测样本 (hk:00700 2024-12-30)。
            _id: '68f6e365d5961364e4428dce',
            date: '2024-12-30T00:00:00+08:00',
            num: 1370000,
            highestPrice: 421.4,
            lowestPrice: 416,
            avgPrice: 419.004,
            totalPaid: 574035480,
            methodOfPurchase: 'exchange',
            totalSharesForCancellation: 1370000,
            totalSharesForTreasury: 0,
            ratioPurchasedSinceResolution: 0.02445,
            currency: 'HKD',
            boardType: 'main',
          },
        ],
      },
    ]);
    const out = await new LixingerBuybackAdapter(http, TOKEN, BASE).getBuybackRange({
      symbol: 'hk:00700',
      from: '2024-12-30',
      to: '2024-12-31',
    });

    expect(out.map((p) => p.date)).toEqual(['2024-12-30', '2024-12-31']); // 升序
    expect(out[0]).toMatchObject({
      date: '2024-12-30',
      vendorEventId: '68f6e365d5961364e4428dce', // C1: vendor `_id` → 自然键判别字段
      num: '1370000',
      highestPrice: '421.4',
      lowestPrice: '416',
      avgPrice: '419.004',
      totalPaid: '574035480',
      totalSharesForCancellation: '1370000',
      totalSharesForTreasury: '0',
      ratioPurchasedSinceResolution: '0.02445',
      methodOfPurchase: 'exchange',
      currency: 'HKD',
      boardType: 'main',
    });
    const body = bodyOf(calls[0]);
    expect(body.stockCode).toBe('00700'); // 单数 stockCode (非数组 stockCodes)
    expect(body.stockCodes).toBeUndefined();
    expect(body.startDate).toBe('2024-12-30');
    expect(body.endDate).toBe('2024-12-31');
    expect(body.token).toBe(TOKEN); // token 注入 body
    expect(body.metricsList).toBeUndefined(); // 不用 metricsList (无 all-or-nothing 坑)
    expect(calls[0].url).toContain('/hk/company/repurchase');
  });

  it('省略 to → 无 endDate (至最新)', async () => {
    const { http, calls } = makeHttp([{ match: '/repurchase', data: [] }]);
    await new LixingerBuybackAdapter(http, TOKEN, BASE).getBuybackRange({
      symbol: 'hk:00700',
      from: '2015-01-01',
    });
    expect(bodyOf(calls[0]).endDate).toBeUndefined();
    expect(bodyOf(calls[0]).startDate).toBe('2015-01-01');
  });

  it('缺字段 (highestPrice/totalPaid/methodOfPurchase 等缺) → null 透传, 不崩', async () => {
    const { http } = makeHttp([
      {
        match: '/repurchase',
        data: [
          { _id: '68f6e365d5961364e4428dcf', date: '2024-12-30T00:00:00+08:00', num: 1370000 },
        ],
      },
    ]);
    const out = await new LixingerBuybackAdapter(http, TOKEN, BASE).getBuybackRange({
      symbol: 'hk:00700',
      from: '2024-12-30',
    });
    expect(out[0]).toMatchObject({
      date: '2024-12-30',
      vendorEventId: '68f6e365d5961364e4428dcf',
      num: '1370000',
      highestPrice: null,
      lowestPrice: null,
      avgPrice: null,
      totalPaid: null,
      totalSharesForCancellation: null,
      totalSharesForTreasury: null,
      ratioPurchasedSinceResolution: null,
      methodOfPurchase: null,
      currency: null,
      boardType: null,
    });
  });

  it('无回购历史标的 vendor 返 0 行 → [] (不崩)', async () => {
    const { http } = makeHttp([{ match: '/repurchase', data: [] }]);
    const out = await new LixingerBuybackAdapter(http, TOKEN, BASE).getBuybackRange({
      symbol: 'hk:08001', // 无回购历史小盘
      from: '2015-01-01',
    });
    expect(out).toEqual([]);
  });

  // C1: 同日多笔 (两市场回购, 照汇丰 00005 GBP/turquoise + HKD/exchange) → 同 date 不同 `_id` → 各带独立
  // vendorEventId 全保留 (自然键 (instrumentId,date,vendorEventId) 后两笔都落, 不因同日折叠)。
  it('同日两市场回购 (同 date 不同 _id) → 各解析独立 vendorEventId (C1 扩键防丢真行)', async () => {
    const { http } = makeHttp([
      {
        match: '/hk/company/repurchase',
        data: [
          {
            _id: '68f6e365d5961364e4428dcd',
            date: '2025-10-17T00:00:00+08:00',
            num: 100000,
            methodOfPurchase: 'turquoise',
            currency: 'GBP',
          },
          {
            _id: '68f6e365d5961364e4428dce',
            date: '2025-10-17T00:00:00+08:00',
            num: 200000,
            methodOfPurchase: 'exchange',
            currency: 'HKD',
          },
        ],
      },
    ]);
    const out = await new LixingerBuybackAdapter(http, TOKEN, BASE).getBuybackRange({
      symbol: 'hk:00005',
      from: '2025-10-17',
      to: '2025-10-17',
    });
    expect(out).toHaveLength(2); // 同日两笔均保留 (不丢行)
    expect(out.map((p) => p.date)).toEqual(['2025-10-17', '2025-10-17']);
    // 两笔独立 vendorEventId (自然键判别) — 不同市场/币种真行。
    expect(out.map((p) => p.vendorEventId).sort()).toEqual([
      '68f6e365d5961364e4428dcd',
      '68f6e365d5961364e4428dce',
    ]);
    expect(out.map((p) => p.currency).sort()).toEqual(['GBP', 'HKD']);
  });

  it('未知市场前缀 (us) → UnsupportedLixingerMarketError (不静默错配)', async () => {
    const { http } = makeHttp([{ match: '/repurchase', data: [] }]);
    await expect(
      new LixingerBuybackAdapter(http, TOKEN, BASE).getBuybackRange({
        symbol: 'us:AAPL',
        from: '2025-01-01',
      }),
    ).rejects.toThrow(/unsupported market prefix/);
  });
});

// 041 T007 US2: 股本变动事件 adapter (EQUITY_CHANGE_PORT live) —— 请求体单数 stockCode (非数组
// stockCodes) + **无 metricsList** (无 all-or-nothing 坑) + 扁平字段解析 (capitalization/
// capitalizationH/changeReason/declarationDate) + date 升序 + 缺字段 null 透传 + 空数组容错 +
// market 段插值. 真契约 env-gated IT 校真。
describe('LixingerEquityChangeAdapter', () => {
  it('equity-change 行 → EquityChangeDto, 单数 stockCode + startDate/endDate, 字段解析, date 升序', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/equity-change',
        data: [
          {
            date: '2024-12-31T00:00:00+08:00',
            declarationDate: '2025-01-07T00:00:00+08:00',
            capitalization: 9224914953,
            capitalizationH: 9224914953,
            changeReason: '定期報告',
          },
          {
            // p3 探查报告实测样本 (hk:00700 2023-12-31)。
            date: '2023-12-31T00:00:00+08:00',
            declarationDate: '2024-01-05T00:00:00+08:00',
            capitalization: 9600000000,
            capitalizationH: 9600000000,
            changeReason: '定期報告',
          },
        ],
      },
    ]);
    const out = await new LixingerEquityChangeAdapter(http, TOKEN, BASE).getEquityChangeRange({
      symbol: 'hk:00700',
      from: '2023-12-31',
      to: '2024-12-31',
    });

    expect(out.map((p) => p.date)).toEqual(['2023-12-31', '2024-12-31']); // 升序
    expect(out[1]).toMatchObject({
      date: '2024-12-31',
      capitalization: '9224914953',
      capitalizationH: '9224914953',
      changeReason: '定期報告',
      declarationDate: '2025-01-07',
    });
    const body = bodyOf(calls[0]);
    expect(body.stockCode).toBe('00700'); // 单数 stockCode (非数组 stockCodes)
    expect(body.stockCodes).toBeUndefined();
    expect(body.startDate).toBe('2023-12-31');
    expect(body.endDate).toBe('2024-12-31');
    expect(body.token).toBe(TOKEN); // token 注入 body
    expect(body.metricsList).toBeUndefined(); // 不用 metricsList (无 all-or-nothing 坑)
    expect(calls[0].url).toContain('/hk/company/equity-change');
  });

  it('省略 to → 无 endDate (至最新)', async () => {
    const { http, calls } = makeHttp([{ match: '/equity-change', data: [] }]);
    await new LixingerEquityChangeAdapter(http, TOKEN, BASE).getEquityChangeRange({
      symbol: 'hk:00700',
      from: '2015-01-01',
    });
    expect(bodyOf(calls[0]).endDate).toBeUndefined();
    expect(bodyOf(calls[0]).startDate).toBe('2015-01-01');
  });

  it('缺字段 (capitalizationH/changeReason/declarationDate 缺) → null 透传, 不崩', async () => {
    const { http } = makeHttp([
      {
        match: '/equity-change',
        data: [{ date: '2024-12-31T00:00:00+08:00', capitalization: 9224914953 }],
      },
    ]);
    const out = await new LixingerEquityChangeAdapter(http, TOKEN, BASE).getEquityChangeRange({
      symbol: 'hk:00700',
      from: '2024-12-31',
    });
    expect(out[0]).toMatchObject({
      date: '2024-12-31',
      capitalization: '9224914953',
      capitalizationH: null,
      changeReason: null,
      declarationDate: null,
    });
  });

  it('无股本变动历史标的 vendor 返 0 行 → [] (不崩)', async () => {
    const { http } = makeHttp([{ match: '/equity-change', data: [] }]);
    const out = await new LixingerEquityChangeAdapter(http, TOKEN, BASE).getEquityChangeRange({
      symbol: 'hk:08001', // 无股本变动历史小盘
      from: '2015-01-01',
    });
    expect(out).toEqual([]);
  });

  it('未知市场前缀 (us) → UnsupportedLixingerMarketError (不静默错配)', async () => {
    const { http } = makeHttp([{ match: '/equity-change', data: [] }]);
    await expect(
      new LixingerEquityChangeAdapter(http, TOKEN, BASE).getEquityChangeRange({
        symbol: 'us:AAPL',
        from: '2025-01-01',
      }),
    ).rejects.toThrow(/unsupported market prefix/);
  });
});

// 041 T010 US3: 股东权益变动事件 adapter (SHAREHOLDER_CHANGE_PORT live) —— 请求体单数 stockCode (非数组
// stockCodes) + **无 metricsList** (无 all-or-nothing 坑) + **嵌套 L/S 保真解析** (numOfSharesInterestedList/
// percentageOfIssuedVotingShares 每项 {value,sharesType} 完整整存 payload) + name→shareholderName 自然键 +
// date 升序 + 缺字段 null 不崩 + 空数组容错 + market 段插值. 真契约 env-gated IT 校真。
describe('LixingerShareholderChangeAdapter', () => {
  it('shareholders-equity-change 行 → ShareholderChangeDto, 单数 stockCode + range, 嵌套 L/S 保真, date 升序', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/shareholders-equity-change',
        data: [
          {
            // p3 探查报告实测样本 (hk:00700 2024-12-30, Naspers 只 L)。
            date: '2024-12-30T00:00:00+08:00',
            stockCode: '00700',
            name: 'Naspers Limited',
            numOfSharesInterestedList: [{ value: 2215242300, sharesType: 'L' }],
            percentageOfIssuedVotingShares: [{ value: 0.2401, sharesType: 'L' }],
          },
          {
            // 含 L 和 S 两项 (嵌套保真核心 — L/S 二维数值 + 潜在第三类须无损)。
            date: '2020-06-12T00:00:00+08:00',
            stockCode: '00700',
            name: '马化腾',
            numOfSharesInterestedList: [
              { value: 804859700, sharesType: 'L' },
              { value: 100000, sharesType: 'S' },
            ],
            percentageOfIssuedVotingShares: [
              { value: 0.0842, sharesType: 'L' },
              { value: 0.0001, sharesType: 'S' },
            ],
          },
        ],
      },
    ]);
    const out = await new LixingerShareholderChangeAdapter(
      http,
      TOKEN,
      BASE,
    ).getShareholderChangeRange({
      symbol: 'hk:00700',
      from: '2020-06-12',
      to: '2024-12-30',
    });

    expect(out.map((p) => p.date)).toEqual(['2020-06-12', '2024-12-30']); // 升序
    // 首行 (马化腾): shareholderName + 嵌套 L/S 两项完整保真 (整存 payload, 每项 {value,sharesType})。
    expect(out[0].shareholderName).toBe('马化腾');
    expect(out[0].payload.numOfSharesInterestedList).toEqual([
      { value: 804859700, sharesType: 'L' },
      { value: 100000, sharesType: 'S' },
    ]);
    expect(out[0].payload.percentageOfIssuedVotingShares).toEqual([
      { value: 0.0842, sharesType: 'L' },
      { value: 0.0001, sharesType: 'S' },
    ]);
    // 末行 (Naspers): 只 L (缺 S) → 数组只含 L 项, 不伪造 S (缺 S 不崩)。
    expect(out[1].shareholderName).toBe('Naspers Limited');
    expect(out[1].payload.numOfSharesInterestedList).toEqual([
      { value: 2215242300, sharesType: 'L' },
    ]);
    // C1: contentHash = vendor 原始行 canonical sha256 (64 位 hex, 自然键判别字段); 两行内容不同 → hash 不同。
    expect(out[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out[1].contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out[0].contentHash).not.toBe(out[1].contentHash);
    const body = bodyOf(calls[0]);
    expect(body.stockCode).toBe('00700'); // 单数 stockCode (非数组 stockCodes)
    expect(body.stockCodes).toBeUndefined();
    expect(body.startDate).toBe('2020-06-12');
    expect(body.endDate).toBe('2024-12-30');
    expect(body.token).toBe(TOKEN); // token 注入 body
    expect(body.metricsList).toBeUndefined(); // 不用 metricsList (无 all-or-nothing 坑)
    expect(calls[0].url).toContain('/hk/company/shareholders-equity-change');
  });

  it('省略 to → 无 endDate (至最新)', async () => {
    const { http, calls } = makeHttp([{ match: '/shareholders-equity-change', data: [] }]);
    await new LixingerShareholderChangeAdapter(http, TOKEN, BASE).getShareholderChangeRange({
      symbol: 'hk:00700',
      from: '2015-01-01',
    });
    expect(bodyOf(calls[0]).endDate).toBeUndefined();
    expect(bodyOf(calls[0]).startDate).toBe('2015-01-01');
  });

  it('缺嵌套字段 (numOfSharesInterestedList/percentageOfIssuedVotingShares 缺) → null 存, 不崩', async () => {
    const { http } = makeHttp([
      {
        match: '/shareholders-equity-change',
        data: [{ date: '2024-12-30T00:00:00+08:00', name: 'Naspers Limited' }],
      },
    ]);
    const out = await new LixingerShareholderChangeAdapter(
      http,
      TOKEN,
      BASE,
    ).getShareholderChangeRange({
      symbol: 'hk:00700',
      from: '2024-12-30',
    });
    expect(out[0]).toMatchObject({
      date: '2024-12-30',
      shareholderName: 'Naspers Limited',
      payload: { numOfSharesInterestedList: null, percentageOfIssuedVotingShares: null },
    });
  });

  it('缺 name (无自然键) → 跳过该行 (不静默错落)', async () => {
    const { http } = makeHttp([
      {
        match: '/shareholders-equity-change',
        data: [
          {
            date: '2024-12-30T00:00:00+08:00',
            numOfSharesInterestedList: [{ value: 1, sharesType: 'L' }],
          },
          { date: '2024-12-30T00:00:00+08:00', name: 'Naspers Limited' },
        ],
      },
    ]);
    const out = await new LixingerShareholderChangeAdapter(
      http,
      TOKEN,
      BASE,
    ).getShareholderChangeRange({
      symbol: 'hk:00700',
      from: '2024-12-30',
    });
    expect(out).toHaveLength(1); // 无 name 行被跳过
    expect(out[0].shareholderName).toBe('Naspers Limited');
  });

  it('无股东权益变动历史标的 vendor 返 0 行 → [] (不崩)', async () => {
    const { http } = makeHttp([{ match: '/shareholders-equity-change', data: [] }]);
    const out = await new LixingerShareholderChangeAdapter(
      http,
      TOKEN,
      BASE,
    ).getShareholderChangeRange({
      symbol: 'hk:08001', // 无股东权益变动历史小盘
      from: '2015-01-01',
    });
    expect(out).toEqual([]);
  });

  // C1: 同股东同日多笔 (JPMorgan 09988 同日 3 笔 involved 不同, 含第三类 sharesType P) → 只 interested 相同、
  // involved 不同 → contentHash 不同 (hashdiff 覆盖全描述性 payload); payload 整存整行含 numOfSharesInvolvedList。
  it('同名同日 involved 不同 → contentHash 不同 (hashdiff 全描述性) + payload 整存 numOfSharesInvolvedList (含第三类 P)', async () => {
    const { http } = makeHttp([
      {
        match: '/shareholders-equity-change',
        data: [
          {
            date: '2025-06-12T00:00:00+08:00',
            name: 'JPMorgan Chase & Co.',
            numOfSharesInterestedList: [{ value: 900000000, sharesType: 'L' }],
            numOfSharesInvolvedList: [{ value: 95140300, sharesType: 'P' }], // 第三类 sharesType P
            percentageOfIssuedVotingShares: [{ value: 0.0942, sharesType: 'L' }],
          },
          {
            date: '2025-06-12T00:00:00+08:00',
            name: 'JPMorgan Chase & Co.', // 同 (date, name)
            numOfSharesInterestedList: [{ value: 900000000, sharesType: 'L' }], // interested 相同
            numOfSharesInvolvedList: [{ value: 12000000, sharesType: 'P' }], // involved 不同 → 实质差异
            percentageOfIssuedVotingShares: [{ value: 0.0942, sharesType: 'L' }],
          },
        ],
      },
    ]);
    const out = await new LixingerShareholderChangeAdapter(
      http,
      TOKEN,
      BASE,
    ).getShareholderChangeRange({ symbol: 'hk:09988', from: '2025-06-12', to: '2025-06-12' });

    expect(out).toHaveLength(2);
    // involved 不同 → contentHash 不同 → 各落行不折叠 (C1 防丢真行)。
    expect(out[0].contentHash).not.toBe(out[1].contentHash);
    // payload 整存整行含 involved 列 (第三类 sharesType P 无损)。
    expect(out[0].payload.numOfSharesInvolvedList).toEqual([{ value: 95140300, sharesType: 'P' }]);
    expect(out[1].payload.numOfSharesInvolvedList).toEqual([{ value: 12000000, sharesType: 'P' }]);
  });

  // C1: 内容全同 (即便 vendor 返回 key 顺序不同) → contentHash 相同 (canonical 递归排序 → 确定性折叠幂等)。
  it('内容全同 (key 顺序不同) → contentHash 相同 (canonical 确定性, vendor 真重复行折叠)', async () => {
    const { http } = makeHttp([
      {
        match: '/shareholders-equity-change',
        data: [
          {
            date: '2024-12-30T00:00:00+08:00',
            name: 'Naspers Limited',
            numOfSharesInterestedList: [{ value: 2215242300, sharesType: 'L' }],
            percentageOfIssuedVotingShares: [{ value: 0.2401, sharesType: 'L' }],
          },
          {
            // 同内容, key 书写顺序打乱 → canonical 序列化后应产生同 hash。
            percentageOfIssuedVotingShares: [{ sharesType: 'L', value: 0.2401 }],
            numOfSharesInterestedList: [{ sharesType: 'L', value: 2215242300 }],
            name: 'Naspers Limited',
            date: '2024-12-30T00:00:00+08:00',
          },
        ],
      },
    ]);
    const out = await new LixingerShareholderChangeAdapter(
      http,
      TOKEN,
      BASE,
    ).getShareholderChangeRange({ symbol: 'hk:00700', from: '2024-12-30', to: '2024-12-30' });

    expect(out).toHaveLength(2);
    expect(out[0].contentHash).toBe(out[1].contentHash); // 同内容 → 同 hash (确定性折叠幂等)
  });

  it('未知市场前缀 (us) → UnsupportedLixingerMarketError (不静默错配)', async () => {
    const { http } = makeHttp([{ match: '/shareholders-equity-change', data: [] }]);
    await expect(
      new LixingerShareholderChangeAdapter(http, TOKEN, BASE).getShareholderChangeRange({
        symbol: 'us:AAPL',
        from: '2025-01-01',
      }),
    ).rejects.toThrow(/unsupported market prefix/);
  });
});

// 041 T013 US4: 配股事件 adapter (ALLOTMENT_PORT live) —— 请求体单数 stockCode (非数组 stockCodes)
// + **无 metricsList** (无 all-or-nothing 坑) + **payload 整存 vendor 原始行** (字段 schema 未知, 零样本
// → 无损保留) + date 升序 + **空数组不崩** (港股极罕见零样本容错核心 US4/SC-004) + market 段插值. 真契约
// env-gated IT 校真 (允许全 0)。⚠️ fixture 字段为合成占位 (probe 全 0, 首个真实样本待 T018 真调二次确认)。
describe('LixingerAllotmentAdapter', () => {
  it('allotment 行 → AllotmentDto, 单数 stockCode + startDate/endDate, payload 整存 vendor 行, date 升序', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/allotment',
        data: [
          // 🚨 真 API 实测样本 (2026-08-01 直连探测 hk:00897 / hk:00232 校真)。041 建表时 probe
          // 全 0 行 → 旧 fixture 用的是**臆造字段名** (`ratio` / `subscriptionPrice`), 与 vendor
          // 真名 (`allotmentRatio` / `allotmentPrice` / `exDate` / `currency` / `allotmentShares`)
          // 完全对不上 —— 臆造 fixture 测不出提列是否接对字段。
          {
            date: '2020-05-20T00:00:00+08:00',
            exDate: '2020-07-13T00:00:00+08:00', // 公告日 ≠ 除权日 (545 行实测 510 行不同)
            currency: 'HKD',
            allotmentRatio: 3,
            allotmentPrice: 0.43,
            allotmentShares: 948857166,
          },
          {
            date: '2016-03-10T00:00:00+08:00',
            allotmentRatio: 0.6855, // vendor 缺 exDate/price/currency 的行 (35/545) → 落 null
          },
        ],
      },
    ]);
    const out = await new LixingerAllotmentAdapter(http, TOKEN, BASE).getAllotmentRange({
      symbol: 'hk:00700',
      from: '2016-03-10',
      to: '2020-05-20',
    });

    expect(out.map((p) => p.date)).toEqual(['2016-03-10', '2020-05-20']); // 升序
    // 🚨 提列列: exDate 取的是 vendor `exDate` 而**不是** `date` —— 若误接 `date`, 因子会锚到
    // 公告日这个错误的版本边界上 (二者实测可差 4 个月)。
    expect(out[1]).toMatchObject({
      date: '2020-05-20',
      exDate: '2020-07-13',
      allotmentRatio: '3',
      allotmentPrice: '0.43',
      currency: 'HKD',
    });
    // vendor 缺字段 → null (不填假值; 下游据此判定条款不可用而非算出错值)。
    expect(out[0]).toMatchObject({
      date: '2016-03-10',
      exDate: null,
      allotmentRatio: '0.6855',
      allotmentPrice: null,
      currency: null,
    });
    // payload 整存 vendor 原始行无损 (含 date 原始 ISO + 未提列的 allotmentShares)。
    expect(out[1].payload).toEqual({
      date: '2020-05-20T00:00:00+08:00',
      exDate: '2020-07-13T00:00:00+08:00',
      currency: 'HKD',
      allotmentRatio: 3,
      allotmentPrice: 0.43,
      allotmentShares: 948857166,
    });
    const body = bodyOf(calls[0]);
    expect(body.stockCode).toBe('00700'); // 单数 stockCode (非数组 stockCodes)
    expect(body.stockCodes).toBeUndefined();
    expect(body.startDate).toBe('2016-03-10');
    expect(body.endDate).toBe('2020-05-20');
    expect(body.token).toBe(TOKEN); // token 注入 body
    expect(body.metricsList).toBeUndefined(); // 不用 metricsList (无 all-or-nothing 坑)
    expect(calls[0].url).toContain('/hk/company/allotment');
  });

  it('省略 to → 无 endDate (至最新)', async () => {
    const { http, calls } = makeHttp([{ match: '/allotment', data: [] }]);
    await new LixingerAllotmentAdapter(http, TOKEN, BASE).getAllotmentRange({
      symbol: 'hk:00700',
      from: '2010-01-01',
    });
    expect(bodyOf(calls[0]).endDate).toBeUndefined();
    expect(bodyOf(calls[0]).startDate).toBe('2010-01-01');
  });

  it('港股极罕见零样本: vendor 返 0 行 → [] (不崩, 零样本容错核心 US4/SC-004)', async () => {
    const { http } = makeHttp([{ match: '/allotment', data: [] }]);
    const out = await new LixingerAllotmentAdapter(http, TOKEN, BASE).getAllotmentRange({
      symbol: 'hk:08001', // 无配股历史 (港股绝大多数)
      from: '2010-01-01',
    });
    expect(out).toEqual([]);
  });

  it('未知市场前缀 (us) → UnsupportedLixingerMarketError (不静默错配)', async () => {
    const { http } = makeHttp([{ match: '/allotment', data: [] }]);
    await expect(
      new LixingerAllotmentAdapter(http, TOKEN, BASE).getAllotmentRange({
        symbol: 'us:AAPL',
        from: '2015-01-01',
      }),
    ).rejects.toThrow(/unsupported market prefix/);
  });
});

// 042 T004 US1: 营收构成 adapter (REVENUE_SEGMENT_PORT live) —— 请求体单数 stockCode (非数组 stockCodes)
// + **无 metricsList** (无 all-or-nothing 坑) + **dataList 展开 typed 子行**: 头行判别 (纯头行跳/有 parent
// 缺 value 落 null/顶层有 value 行 sentinel '') + key `.trim()` 归一 + signed 负 revenue + 多分组共存归组
// + **UTC-Z 日期经 lixDateOnlyHk 无 off-by-one** + date 升序 + 空数组容错 + market 段插值. 真契约 env-gated IT 校真。
describe('LixingerRevenueSegmentAdapter', () => {
  // 单报告期混合 fixture (probe verified 形态): 2 分组头行 + 数据行 + 缺值行 + signed 负 revenue + 顶层合計。
  // date 用 UTC `...T16:00:00.000Z` (= 次日 00:00+08 HK) 验 HK-aware off-by-one 修正 (裸 slice 会少 1 天)。
  const MIXED_REPORT = {
    date: '2024-12-30T16:00:00.000Z', // HK-aware → 2024-12-31 (非裸 slice 的 2024-12-30)
    declarationDate: '2025-03-19T16:00:00.000Z', // HK-aware → 2025-03-20
    currency: 'CNY',
    dataList: [
      { itemName: '按服務類型分' }, // 纯头行 (无 parentItemName + 无 value) → 跳
      {
        itemName: '增值服務',
        parentItemName: '按服務類型分',
        revenue: 319168000000,
        costs: 137511000000,
        grossProfitMargin: 0.5692,
      },
      // 尾随空格脏数据 (parentItemName/itemName 皆带空格) → trim 归一; "其他" 跨两组之一。
      {
        itemName: '其他 ',
        parentItemName: '按服務類型分 ',
        revenue: 10000000000,
        costs: 5000000000,
        grossProfitMargin: 0.5,
      },
      { itemName: '按地區分' }, // 纯头行 → 跳
      {
        itemName: '中國內地',
        parentItemName: '按地區分',
        revenue: 500000000000,
        costs: 200000000000,
        grossProfitMargin: 0.6,
      },
      // signed 负 revenue (HSBC 企業中心 −1e10 场景) — 不取绝对值/不过滤。
      {
        itemName: '企業中心',
        parentItemName: '按地區分',
        revenue: -10300000000,
        costs: 2000000000,
        grossProfitMargin: -0.1,
      },
      // "其他" 跨两组之二 (同 itemName 不同 parentItemName → NK 含 parent 不撞)。
      { itemName: '其他', parentItemName: '按地區分' }, // 缺值数据行 (有 parent 缺 value) → 落 null
      { itemName: '英國', parentItemName: '按地區分' }, // 缺值数据行 (HSBC 场景) → 落 null
      // 顶层合計 (无 parentItemName 但有 value) → parentItemName 落哨兵 ''。
      { itemName: '合計', revenue: 660257000000, costs: 340000000000, grossProfitMargin: 0.485 },
    ],
  };

  const findRow = (
    rows: Awaited<ReturnType<LixingerRevenueSegmentAdapter['getRevenueSegmentRange']>>,
    parent: string,
    item: string,
  ) => rows.find((r) => r.parentItemName === parent && r.itemName === item);

  it('dataList 展开 typed 子行: 纯头行跳/缺值行 null/顶层 sentinel/trim/signed 负/多分组归组, 单数 stockCode+range', async () => {
    const { http, calls } = makeHttp([
      { match: '/hk/company/operation-revenue-constitution', data: [MIXED_REPORT] },
    ]);
    const out = await new LixingerRevenueSegmentAdapter(http, TOKEN, BASE).getRevenueSegmentRange({
      symbol: 'hk:00700',
      from: '2024-01-01',
      to: '2024-12-31',
    });

    // 2 纯头行跳过 → 9 dataList 行剩 7 typed 子行。
    expect(out).toHaveLength(7);
    // 纯头行不落 (无 (按服務類型分, 按服務類型分) 之类的头行残留)。
    expect(out.some((r) => r.itemName === '按服務類型分')).toBe(false);
    expect(
      out.some((r) => r.itemName === '按地區分' && r.revenue === null && r.parentItemName === ''),
    ).toBe(false);

    // 🕐 UTC-Z 日期经 lixDateOnlyHk → 2024-12-31 (非裸 slice 的 2024-12-30, off-by-one 修正)。
    expect(out.every((r) => r.date === '2024-12-31')).toBe(true);
    expect(out.every((r) => r.declarationDate === '2025-03-20')).toBe(true);
    expect(out.every((r) => r.currency === 'CNY')).toBe(true);

    // 数据行 typed 解析 (金融数值 string)。
    expect(findRow(out, '按服務類型分', '增值服務')).toMatchObject({
      revenue: '319168000000',
      costs: '137511000000',
      grossProfitMargin: '0.5692',
    });
    // trim 归一: parentItemName/itemName 尾随空格已去。
    const other1 = findRow(out, '按服務類型分', '其他');
    expect(other1).toBeDefined();
    expect(other1!.revenue).toBe('10000000000');
    // 多分组共存: "其他" 跨两组各一行 (NK 含 parentItemName 不撞)。
    const other2 = findRow(out, '按地區分', '其他');
    expect(other2).toBeDefined();
    expect(other2!.revenue).toBeNull(); // 缺值数据行 → null
    expect(out.filter((r) => r.itemName === '其他')).toHaveLength(2);

    // signed 负 revenue 不取绝对值/不过滤。
    expect(findRow(out, '按地區分', '企業中心')).toMatchObject({
      revenue: '-10300000000',
      grossProfitMargin: '-0.1',
    });
    // 有 parent 缺 value → 落 null 行 (不丢)。
    expect(findRow(out, '按地區分', '英國')).toMatchObject({
      revenue: null,
      costs: null,
      grossProfitMargin: null,
    });
    // 顶层合計: parentItemName 落哨兵 '' (NK 列 NOT NULL)。
    const total = findRow(out, '', '合計');
    expect(total).toBeDefined();
    expect(total!.revenue).toBe('660257000000');

    // 请求体: 单数 stockCode + startDate/endDate + token, 无 metricsList/stockCodes。
    const body = bodyOf(calls[0]);
    expect(body.stockCode).toBe('00700');
    expect(body.stockCodes).toBeUndefined();
    expect(body.startDate).toBe('2024-01-01');
    expect(body.endDate).toBe('2024-12-31');
    expect(body.token).toBe(TOKEN);
    expect(body.metricsList).toBeUndefined();
    expect(calls[0].url).toContain('/hk/company/operation-revenue-constitution');
  });

  it('多报告期 → date 升序 (跨报告期展平后排序)', async () => {
    const { http } = makeHttp([
      {
        match: '/operation-revenue-constitution',
        data: [
          // vendor 返回降序 (新报告期在前) → adapter 展平后须升序。
          {
            date: '2024-12-30T16:00:00.000Z', // HK 2024-12-31
            currency: 'CNY',
            dataList: [{ itemName: '合計', revenue: 660000000000 }],
          },
          {
            date: '2023-12-30T16:00:00.000Z', // HK 2023-12-31
            currency: 'CNY',
            dataList: [{ itemName: '合計', revenue: 550000000000 }],
          },
        ],
      },
    ]);
    const out = await new LixingerRevenueSegmentAdapter(http, TOKEN, BASE).getRevenueSegmentRange({
      symbol: 'hk:00700',
      from: '2023-01-01',
      to: '2024-12-31',
    });
    expect(out.map((r) => r.date)).toEqual(['2023-12-31', '2024-12-31']); // 升序
  });

  it('省略 to → 无 endDate (至最新)', async () => {
    const { http, calls } = makeHttp([{ match: '/operation-revenue-constitution', data: [] }]);
    await new LixingerRevenueSegmentAdapter(http, TOKEN, BASE).getRevenueSegmentRange({
      symbol: 'hk:00700',
      from: '2015-01-01',
    });
    expect(bodyOf(calls[0]).endDate).toBeUndefined();
    expect(bodyOf(calls[0]).startDate).toBe('2015-01-01');
  });

  it('无营收披露标的 vendor 返 0 行 → [] (不崩)', async () => {
    const { http } = makeHttp([{ match: '/operation-revenue-constitution', data: [] }]);
    const out = await new LixingerRevenueSegmentAdapter(http, TOKEN, BASE).getRevenueSegmentRange({
      symbol: 'hk:08001',
      from: '2015-01-01',
    });
    expect(out).toEqual([]);
  });

  it('report 缺 dataList (非数组) → 零子行不崩', async () => {
    const { http } = makeHttp([
      {
        match: '/operation-revenue-constitution',
        data: [{ date: '2024-12-30T16:00:00.000Z', currency: 'CNY' }], // 无 dataList
      },
    ]);
    const out = await new LixingerRevenueSegmentAdapter(http, TOKEN, BASE).getRevenueSegmentRange({
      symbol: 'hk:00700',
      from: '2024-01-01',
    });
    expect(out).toEqual([]);
  });

  it('未知市场前缀 (us) → UnsupportedLixingerMarketError (不静默错配)', async () => {
    const { http } = makeHttp([{ match: '/operation-revenue-constitution', data: [] }]);
    await expect(
      new LixingerRevenueSegmentAdapter(http, TOKEN, BASE).getRevenueSegmentRange({
        symbol: 'us:AAPL',
        from: '2025-01-01',
      }),
    ).rejects.toThrow(/unsupported market prefix/);
  });
});

// 042 T007 US2: 最新股东 adapter (SHAREHOLDER_SNAPSHOT_PORT live) —— 请求体单数 stockCode
// (非数组 stockCodes) + **无 metricsList** (无 all-or-nothing 坑) + **嵌套 L/S/P payload 整存无损**
// (复用 041 ShareholderChange 范式) + contentHash 稳定 (同内容同 hash / 差异不同 hash) + date 升序
// (lixDateOnlyHk 归一 +08:00 幂等) + **空数组不崩** + market 段插值. probe verified = SERIES (多 date
// 行都落). 真契约 env-gated IT 校真 (latest-shareholders hk/company).
describe('LixingerShareholderSnapshotAdapter', () => {
  it('latest-shareholders 行 → ShareholderSnapshotDto, 单数 stockCode + range, 嵌套 L/S/P 保真, SERIES 多 date 升序', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/hk/company/latest-shareholders',
        data: [
          {
            // p3 探查报告实测样本 (hk:00700, Naspers 只 L)。date +08:00 → lixDateOnlyHk 归一 (幂等无害)。
            date: '2024-12-30T00:00:00+08:00',
            stockCode: '00700',
            name: 'Naspers Limited',
            numOfSharesInterestedList: [{ value: 2215242300, sharesType: 'L' }],
            percentageOfIssuedVotingShares: [{ value: 0.2401, sharesType: 'L' }],
          },
          {
            // 含 L 和 S 两项 (嵌套保真核心 — L/S 二维数值须无损). 不同 date → SERIES 多报告期序列。
            date: '2020-06-12T00:00:00+08:00',
            stockCode: '00700',
            name: '马化腾',
            numOfSharesInterestedList: [
              { value: 804859700, sharesType: 'L' },
              { value: 100000, sharesType: 'S' },
            ],
            percentageOfIssuedVotingShares: [
              { value: 0.0842, sharesType: 'L' },
              { value: 0.0001, sharesType: 'S' },
            ],
          },
          {
            // 含第三类 sharesType P (HK SDI lending-pool, 041 T018 实证) → payload 整存无损不丢。
            date: '2022-06-30T00:00:00+08:00',
            stockCode: '00700',
            name: 'JPMorgan Chase & Co.',
            numOfSharesInterestedList: [{ value: 900000000, sharesType: 'P' }],
            percentageOfIssuedVotingShares: [{ value: 0.0942, sharesType: 'P' }],
          },
        ],
      },
    ]);
    const out = await new LixingerShareholderSnapshotAdapter(
      http,
      TOKEN,
      BASE,
    ).getShareholderSnapshotRange({
      symbol: 'hk:00700',
      from: '2020-06-12',
      to: '2024-12-30',
    });

    // SERIES: 3 个不同 date 行都落 (非覆盖式快照), date 升序。
    expect(out.map((p) => p.date)).toEqual(['2020-06-12', '2022-06-30', '2024-12-30']);
    // 首行 (马化腾): shareholderName + 嵌套 L/S 两项完整保真 (整存 payload, 每项 {value,sharesType})。
    expect(out[0].shareholderName).toBe('马化腾');
    expect(out[0].payload.numOfSharesInterestedList).toEqual([
      { value: 804859700, sharesType: 'L' },
      { value: 100000, sharesType: 'S' },
    ]);
    expect(out[0].payload.percentageOfIssuedVotingShares).toEqual([
      { value: 0.0842, sharesType: 'L' },
      { value: 0.0001, sharesType: 'S' },
    ]);
    // 第三类 P 保真 (JPMorgan): sharesType P 无损保留 (不假定 L/S 二元)。
    expect(out[1].shareholderName).toBe('JPMorgan Chase & Co.');
    expect(out[1].payload.numOfSharesInterestedList).toEqual([
      { value: 900000000, sharesType: 'P' },
    ]);
    // 末行 (Naspers): 只 L (缺 S/P) → 数组只含 L 项, 不伪造 S (缺 S 不崩)。
    expect(out[2].shareholderName).toBe('Naspers Limited');
    expect(out[2].payload.numOfSharesInterestedList).toEqual([
      { value: 2215242300, sharesType: 'L' },
    ]);
    // contentHash = vendor 原始行 canonical sha256 (64 位 hex, 自然键判别字段); 三行内容不同 → hash 各异。
    for (const p of out) expect(p.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(out.map((p) => p.contentHash)).size).toBe(3);
    const body = bodyOf(calls[0]);
    expect(body.stockCode).toBe('00700'); // 单数 stockCode (非数组 stockCodes)
    expect(body.stockCodes).toBeUndefined();
    expect(body.startDate).toBe('2020-06-12');
    expect(body.endDate).toBe('2024-12-30');
    expect(body.token).toBe(TOKEN); // token 注入 body
    expect(body.metricsList).toBeUndefined(); // 不用 metricsList (无 all-or-nothing 坑)
    expect(calls[0].url).toContain('/hk/company/latest-shareholders');
  });

  it('省略 to → 无 endDate (至最新)', async () => {
    const { http, calls } = makeHttp([{ match: '/latest-shareholders', data: [] }]);
    await new LixingerShareholderSnapshotAdapter(http, TOKEN, BASE).getShareholderSnapshotRange({
      symbol: 'hk:00700',
      from: '2015-01-01',
    });
    expect(bodyOf(calls[0]).endDate).toBeUndefined();
    expect(bodyOf(calls[0]).startDate).toBe('2015-01-01');
  });

  it('缺嵌套字段 (numOfSharesInterestedList/percentageOfIssuedVotingShares 缺) → null 存, 不崩', async () => {
    const { http } = makeHttp([
      {
        match: '/latest-shareholders',
        data: [{ date: '2024-12-30T00:00:00+08:00', name: 'Naspers Limited' }],
      },
    ]);
    const out = await new LixingerShareholderSnapshotAdapter(
      http,
      TOKEN,
      BASE,
    ).getShareholderSnapshotRange({
      symbol: 'hk:00700',
      from: '2024-12-30',
    });
    expect(out[0]).toMatchObject({
      date: '2024-12-30',
      shareholderName: 'Naspers Limited',
      payload: { numOfSharesInterestedList: null, percentageOfIssuedVotingShares: null },
    });
  });

  it('缺 name (无自然键) → 跳过该行 (不静默错落)', async () => {
    const { http } = makeHttp([
      {
        match: '/latest-shareholders',
        data: [
          {
            date: '2024-12-30T00:00:00+08:00',
            numOfSharesInterestedList: [{ value: 1, sharesType: 'L' }],
          },
          { date: '2024-12-30T00:00:00+08:00', name: 'Naspers Limited' },
        ],
      },
    ]);
    const out = await new LixingerShareholderSnapshotAdapter(
      http,
      TOKEN,
      BASE,
    ).getShareholderSnapshotRange({
      symbol: 'hk:00700',
      from: '2024-12-30',
    });
    expect(out).toHaveLength(1); // 无 name 行被跳过
    expect(out[0].shareholderName).toBe('Naspers Limited');
  });

  it('无最新股东历史标的 vendor 返 0 行 → [] (不崩)', async () => {
    const { http } = makeHttp([{ match: '/latest-shareholders', data: [] }]);
    const out = await new LixingerShareholderSnapshotAdapter(
      http,
      TOKEN,
      BASE,
    ).getShareholderSnapshotRange({
      symbol: 'hk:08001', // 无最新股东历史小盘
      from: '2015-01-01',
    });
    expect(out).toEqual([]);
  });

  // C1: 同股东同日多笔持股不同 → contentHash 不同 (hashdiff 覆盖全描述性 payload); payload 整存整行。
  it('同名同日持股不同 → contentHash 不同 (hashdiff 全描述性, 不丢真行)', async () => {
    const { http } = makeHttp([
      {
        match: '/latest-shareholders',
        data: [
          {
            date: '2025-06-12T00:00:00+08:00',
            name: 'JPMorgan Chase & Co.',
            numOfSharesInterestedList: [{ value: 900000000, sharesType: 'L' }],
            percentageOfIssuedVotingShares: [{ value: 0.0942, sharesType: 'L' }],
          },
          {
            date: '2025-06-12T00:00:00+08:00',
            name: 'JPMorgan Chase & Co.', // 同 (date, name)
            numOfSharesInterestedList: [{ value: 12000000, sharesType: 'P' }], // 持股不同 → 实质差异
            percentageOfIssuedVotingShares: [{ value: 0.0012, sharesType: 'P' }],
          },
        ],
      },
    ]);
    const out = await new LixingerShareholderSnapshotAdapter(
      http,
      TOKEN,
      BASE,
    ).getShareholderSnapshotRange({ symbol: 'hk:09988', from: '2025-06-12', to: '2025-06-12' });

    expect(out).toHaveLength(2);
    // 持股不同 → contentHash 不同 → 各落行不折叠 (C1 防丢真行)。
    expect(out[0].contentHash).not.toBe(out[1].contentHash);
  });

  // C1: 内容全同 (即便 vendor 返回 key 顺序不同) → contentHash 相同 (canonical 递归排序 → 确定性折叠幂等)。
  it('内容全同 (key 顺序不同) → contentHash 相同 (canonical 确定性, vendor 真重复行折叠)', async () => {
    const { http } = makeHttp([
      {
        match: '/latest-shareholders',
        data: [
          {
            date: '2024-12-30T00:00:00+08:00',
            name: 'Naspers Limited',
            numOfSharesInterestedList: [{ value: 2215242300, sharesType: 'L' }],
            percentageOfIssuedVotingShares: [{ value: 0.2401, sharesType: 'L' }],
          },
          {
            // 同内容, key 书写顺序打乱 → canonical 序列化后应产生同 hash。
            percentageOfIssuedVotingShares: [{ sharesType: 'L', value: 0.2401 }],
            numOfSharesInterestedList: [{ sharesType: 'L', value: 2215242300 }],
            name: 'Naspers Limited',
            date: '2024-12-30T00:00:00+08:00',
          },
        ],
      },
    ]);
    const out = await new LixingerShareholderSnapshotAdapter(
      http,
      TOKEN,
      BASE,
    ).getShareholderSnapshotRange({ symbol: 'hk:00700', from: '2024-12-30', to: '2024-12-30' });

    expect(out).toHaveLength(2);
    expect(out[0].contentHash).toBe(out[1].contentHash); // 同内容 → 同 hash (确定性折叠幂等)
  });

  it('未知市场前缀 (us) → UnsupportedLixingerMarketError (不静默错配)', async () => {
    const { http } = makeHttp([{ match: '/latest-shareholders', data: [] }]);
    await expect(
      new LixingerShareholderSnapshotAdapter(http, TOKEN, BASE).getShareholderSnapshotRange({
        symbol: 'us:AAPL',
        from: '2025-01-01',
      }),
    ).rejects.toThrow(/unsupported market prefix/);
  });
});

describe('LixingerEmployeeAdapter', () => {
  // 单报告期混合 fixture (probe verified 形态): 纯头行 + 顶层 value 行 (员工总数/总流失率) + 数据行 +
  // **同名 (parentItemName,itemName) number+percentage 两行** (Decision 6 独有坑) + 尾随空格脏数据 + 缺值行。
  // date 用 `...+08:00` (裸 slice 已 HK-correct) 验 lixDateOnlyHk 幂等无害。
  const MIXED_REPORT = {
    date: '2024-12-31T00:00:00+08:00', // HK-aware 幂等 → 2024-12-31
    declarationDate: '2025-03-20T00:00:00+08:00', // → 2025-03-20
    stockId: 1000000000000700,
    dataList: [
      { itemName: '员工总数', value: 58350, displayType: 'number' }, // 顶层 value 行 → parentItemName ''
      { itemName: '总流失率', value: 14.3, displayType: 'percentage' }, // 顶层 value 行 → parentItemName ''
      { itemName: '按年龄分' }, // 纯头行 (无 parentItemName + 无 value) → 跳
      { itemName: '30歲以下', parentItemName: '按年龄分', value: 18415, displayType: 'number' },
      // 尾随空格脏数据 (parentItemName/itemName 皆带空格) → trim 归一。
      { itemName: '30-50歲 ', parentItemName: '按年龄分 ', value: 30000, displayType: 'number' },
      { itemName: '按性别分' }, // 纯头行 → 跳
      // 🔑 同名 (流失率按性别分, 男性) number + percentage 两行 (Decision 6 probe 实证) → 都出、不去重。
      { itemName: '男性', parentItemName: '流失率按性别分', value: 58812, displayType: 'number' },
      {
        itemName: '男性',
        parentItemName: '流失率按性别分',
        value: 15.2,
        displayType: 'percentage',
      },
      // 缺值数据行 (有 parentItemName 缺 value) → value 落 null (不丢)。
      { itemName: '未披露', parentItemName: '按地区分', displayType: 'number' },
    ],
  };

  const findRow = (
    rows: Awaited<ReturnType<LixingerEmployeeAdapter['getEmployeeRange']>>,
    parent: string,
    item: string,
    displayType: string,
  ) =>
    rows.find(
      (r) => r.parentItemName === parent && r.itemName === item && r.displayType === displayType,
    );

  it('dataList 展开 typed 子行: 同名 number+percentage 两行都出(不去重) + displayType 保留 + 纯头行跳/顶层 sentinel/trim/缺值 null, 单数 stockCode+range', async () => {
    const { http, calls } = makeHttp([{ match: '/hk/company/employee', data: [MIXED_REPORT] }]);
    const out = await new LixingerEmployeeAdapter(http, TOKEN, BASE).getEmployeeRange({
      symbol: 'hk:00700',
      from: '2024-01-01',
      to: '2024-12-31',
    });

    // 2 纯头行跳过 → 9 dataList 行剩 7 typed 子行。
    expect(out).toHaveLength(7);
    // 纯头行不落 (无 itemName='按年龄分'/'按性别分' 的残留)。
    expect(out.some((r) => r.itemName === '按年龄分' || r.itemName === '按性别分')).toBe(false);

    // 🕐 +08:00 日期经 lixDateOnlyHk 幂等 → 2024-12-31 / 2025-03-20。
    expect(out.every((r) => r.date === '2024-12-31')).toBe(true);
    expect(out.every((r) => r.declarationDate === '2025-03-20')).toBe(true);

    // 顶层 value 行: parentItemName 落哨兵 '' (NK 列 NOT NULL); value 金融数值 string。
    expect(findRow(out, '', '员工总数', 'number')).toMatchObject({ value: '58350' });
    expect(findRow(out, '', '总流失率', 'percentage')).toMatchObject({ value: '14.3' });

    // 数据行 typed 解析 + trim 归一 (尾随空格已去)。
    expect(findRow(out, '按年龄分', '30歲以下', 'number')).toMatchObject({ value: '18415' });
    expect(findRow(out, '按年龄分', '30-50歲', 'number')).toMatchObject({ value: '30000' });

    // 🔑 同名 (流失率按性别分, 男性) number + percentage 两行都出 (NK 含 displayType 才能共存, 不去重)。
    const numRow = findRow(out, '流失率按性别分', '男性', 'number');
    const pctRow = findRow(out, '流失率按性别分', '男性', 'percentage');
    expect(numRow).toBeDefined();
    expect(pctRow).toBeDefined();
    expect(numRow!.value).toBe('58812'); // headcount
    expect(pctRow!.value).toBe('15.2'); // percentage
    // 同 (parentItemName, itemName) 两行, 仅 displayType 区分 → 都在 (不因去重丢一半)。
    expect(
      out.filter((r) => r.parentItemName === '流失率按性别分' && r.itemName === '男性'),
    ).toHaveLength(2);

    // 缺值数据行: 有 parentItemName 缺 value → value 落 null 不丢。
    expect(findRow(out, '按地区分', '未披露', 'number')).toMatchObject({ value: null });

    // 请求体: 单数 stockCode + startDate/endDate + token, 无 metricsList/stockCodes。
    const body = bodyOf(calls[0]);
    expect(body.stockCode).toBe('00700');
    expect(body.stockCodes).toBeUndefined();
    expect(body.startDate).toBe('2024-01-01');
    expect(body.endDate).toBe('2024-12-31');
    expect(body.token).toBe(TOKEN);
    expect(body.metricsList).toBeUndefined();
    expect(calls[0].url).toContain('/hk/company/employee');
  });

  it('多报告期 → date 升序 (跨报告期展平后排序)', async () => {
    const { http } = makeHttp([
      {
        match: '/company/employee',
        data: [
          // vendor 返回降序 (新报告期在前) → adapter 展平后须升序。
          {
            date: '2024-12-31T00:00:00+08:00',
            dataList: [{ itemName: '员工总数', value: 58350, displayType: 'number' }],
          },
          {
            date: '2023-12-31T00:00:00+08:00',
            dataList: [{ itemName: '员工总数', value: 55000, displayType: 'number' }],
          },
        ],
      },
    ]);
    const out = await new LixingerEmployeeAdapter(http, TOKEN, BASE).getEmployeeRange({
      symbol: 'hk:00700',
      from: '2023-01-01',
      to: '2024-12-31',
    });
    expect(out.map((r) => r.date)).toEqual(['2023-12-31', '2024-12-31']); // 升序
  });

  it('省略 to → 无 endDate (至最新)', async () => {
    const { http, calls } = makeHttp([{ match: '/company/employee', data: [] }]);
    await new LixingerEmployeeAdapter(http, TOKEN, BASE).getEmployeeRange({
      symbol: 'hk:00700',
      from: '2015-01-01',
    });
    expect(bodyOf(calls[0]).endDate).toBeUndefined();
    expect(bodyOf(calls[0]).startDate).toBe('2015-01-01');
  });

  it('无员工披露标的 vendor 返 0 行 → [] (不崩)', async () => {
    const { http } = makeHttp([{ match: '/company/employee', data: [] }]);
    const out = await new LixingerEmployeeAdapter(http, TOKEN, BASE).getEmployeeRange({
      symbol: 'hk:08001',
      from: '2015-01-01',
    });
    expect(out).toEqual([]);
  });

  it('report 缺 dataList (非数组) → 零子行不崩', async () => {
    const { http } = makeHttp([
      {
        match: '/company/employee',
        data: [{ date: '2024-12-31T00:00:00+08:00' }], // 无 dataList
      },
    ]);
    const out = await new LixingerEmployeeAdapter(http, TOKEN, BASE).getEmployeeRange({
      symbol: 'hk:00700',
      from: '2024-01-01',
    });
    expect(out).toEqual([]);
  });

  it('未知市场前缀 (us) → UnsupportedLixingerMarketError (不静默错配)', async () => {
    const { http } = makeHttp([{ match: '/company/employee', data: [] }]);
    await expect(
      new LixingerEmployeeAdapter(http, TOKEN, BASE).getEmployeeRange({
        symbol: 'us:AAPL',
        from: '2025-01-01',
      }),
    ).rejects.toThrow(/unsupported market prefix/);
  });
});
