// 046 T021 — 标的详情屏（上半）纯函数单测（logic-only）。
// 渲染 / 交互 / a11y（三块版式、chip 点击、折线画出来了没）走 T024 Playwright e2e ——
// 本仓测试分层 vitest=logic / Playwright=UI，`~/ui` 与展示组件不写 vitest。
//
// 末四段是**机械防线**（写错了不会红、但错得很贵的那几条）：
//   · FR-035 文案与消费字段名零 `iv30d`
//   · FR-013 IVP 在 IVR 之前 + 呈现面零 `iv_rank`
//   · FR-036 阈值档 25/70/90 与分段条段宽 / 刻度同源
//   · plan D9 三个「本片无数据源」字段的恒态
import { describe, expect, it } from 'vitest';
import type { AnchorResponse, LegResponse, UnderlyingIvReadoutResponse } from '@nvy/api-client';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import {
  ALERT_STATUSES,
  ANCHOR_CARD_FIELD_KEYS,
  ANCHOR_NOT_FOUND_CODE,
  IVP_EXTREME_MIN,
  IVP_HIGH_MIN,
  IVP_MID_MIN,
  IVP_SEGMENTS,
  IVP_TIER_BOUNDARIES,
  IVP_TIERS,
  IV_READOUT_FIELD_ORDER,
  LEG_SECTION_KEY,
  POSITION_LEVEL_PLACEHOLDER,
  SERIES_START_TOLERANCE_DAYS,
  WILLING_SELL_ROW_VISIBLE,
  alertStatusOf,
  alertStatusText,
  anchorCardFields,
  anchorManualNotices,
  buildLegSections,
  chartAxis,
  composeUnderlyingDetail,
  freshnessOf,
  isNoAnchorError,
  ivReadoutView,
  ivpTier,
  legBlockState,
  legRowTotal,
  parseZoneBounds,
  polylinePoints,
  priceToY,
  seriesAsOf,
  seriesCloses,
  seriesRangeLabel,
  windowStartDate,
  zoneBoundaryPrices,
  zoneRects,
  type ZoneBounds,
} from './underlying-detail.rules';

const COPY = OPTIONSDESK_COPY.underlyingDetail;

const TODAY = '2026-08-03';

/** 两端点各一侧的成败 fixture。 */
const OK = { isPending: false, isError: false } as const;
const LOADING = { isPending: true, isError: false } as const;
const FAILED = { isPending: false, isError: true, error: axios(500) } as const;

function axios(status: number, code?: string) {
  return { isAxiosError: true, response: { status, data: code ? { code } : undefined } };
}

function anchor(over: Partial<AnchorResponse> = {}): AnchorResponse {
  return {
    id: '1',
    ticker: 'us:PEP',
    name: '百事可乐',
    v: '100.00',
    vModel: '100.00',
    asof: '2026-07-18',
    method: 'DCF',
    confidence: '8',
    confidenceSource: 'manual',
    excluded: false,
    excludeReason: null,
    nextReview: '2026-10-18',
    lastReviewedOn: '2026-07-18',
    overdue: false,
    overdueAgainstAsof: false,
    lLevelEffective: 'L2',
    positionCap: '0.05',
    w: '80.00',
    zoneFloor: '60.00',
    zoneCeiling: '120.00',
    willingSellLongHold: '120.00',
    willingSellRent: '100.00',
    zone: 'thin',
    lastClose: '96.00',
    lastCloseDate: '2026-07-31',
    quoteFreshnessTier: 'CURRENT',
    spot: '96.00',
    priceKind: 'eod_close',
    spotAsOf: '2026-07-31',
    distanceToWPct: '20.00',
    breachStartedOn: null,
    reviewFlagOn: false,
    vIsManual: false,
    lLevelIsManual: false,
    positionCapIsManual: false,
    vManual: null,
    lLevelManual: null,
    positionCapManual: null,
    derivedLLevel: 'L2',
    derivedPositionCap: '0.05',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    ...over,
  };
}

function iv(over: Partial<UnderlyingIvReadoutResponse> = {}): UnderlyingIvReadoutResponse {
  return {
    state: 'available',
    aggregateIv: '24.80',
    ivPercentile: '63.00',
    asOf: '2026-07-31',
    freshnessTier: 'CURRENT',
    ...over,
  };
}

const BOUNDS: ZoneBounds = { zoneFloor: 60, w: 80, v: 100, zoneCeiling: 120 };

// ═══════════ ① 两端点四种成败组合（plan D2 / state_branch #15） ═══════════

describe('两端点并行合成 —— 四种成败组合各自独立降级（禁整页失败）', () => {
  it('详情 ✓ 序列 ✓ → 三块全常态', () => {
    expect(composeUnderlyingDetail(OK, OK)).toEqual({
      page: 'ready',
      anchorCard: 'ready',
      series: 'ready',
    });
  });

  it('详情 ✓ 序列 ✗ → 锚卡照常，只有折线区降级（mockup 帧⑤）', () => {
    expect(composeUnderlyingDetail(OK, FAILED)).toEqual({
      page: 'ready',
      anchorCard: 'ready',
      series: 'failed',
    });
  });

  it('详情 ✗（非 404）序列 ✓ → 折线照常，只有锚卡降级（「反之亦然」那半边）', () => {
    expect(composeUnderlyingDetail(FAILED, OK)).toEqual({
      page: 'ready',
      anchorCard: 'failed',
      series: 'ready',
    });
  });

  it('🚨 两侧同时失败**也不整页失败** —— 两块各自显式降级', () => {
    const c = composeUnderlyingDetail(FAILED, FAILED);
    expect(c.page).toBe('ready');
    expect(c.anchorCard).toBe('failed');
    expect(c.series).toBe('failed');
  });

  it('🚨 一侧还在飞不拖住另一侧（禁整页 loading）', () => {
    expect(composeUnderlyingDetail(LOADING, OK)).toEqual({
      page: 'ready',
      anchorCard: 'loading',
      series: 'ready',
    });
    expect(composeUnderlyingDetail(OK, LOADING)).toEqual({
      page: 'ready',
      anchorCard: 'ready',
      series: 'loading',
    });
  });

  it('页级只有 ready / no_anchor 两态 —— 任何组合都产不出第三个值', () => {
    const sides = [OK, LOADING, FAILED];
    for (const d of sides) {
      for (const s of sides) {
        expect(['ready', 'no_anchor']).toContain(composeUnderlyingDetail(d, s).page);
      }
    }
  });
});

// ═══════════ ② 无锚态判定（FR-011） ═══════════

describe('无锚态（FR-011：显式提示 + 建锚入口，禁空白页 / 禁报错页）', () => {
  it('404 + ANCHOR_NOT_FOUND_FOR_SYMBOL → 整页换成建锚引导', () => {
    const err = { isPending: false, isError: true, error: axios(404, ANCHOR_NOT_FOUND_CODE) };
    expect(composeUnderlyingDetail(err, OK).page).toBe('no_anchor');
  });

  it('裸 404（ProblemDetail 未透传 code）也认 —— 该端点只在没建锚时 404', () => {
    expect(isNoAnchorError(axios(404))).toBe(true);
  });

  it('500 / 网络错 / 非 axios 错**不是**无锚 —— 那是故障，走锚卡降级不走建锚引导', () => {
    expect(isNoAnchorError(axios(500))).toBe(false);
    expect(isNoAnchorError({ isAxiosError: true })).toBe(false);
    expect(isNoAnchorError(new Error('boom'))).toBe(false);
    expect(isNoAnchorError(null)).toBe(false);
    expect(isNoAnchorError(undefined)).toBe(false);
  });

  it('无锚时序列侧的成败不影响页态（整页已是建锚引导）', () => {
    const err = { isPending: false, isError: true, error: axios(404, ANCHOR_NOT_FOUND_CODE) };
    expect(composeUnderlyingDetail(err, FAILED).page).toBe('no_anchor');
    expect(composeUnderlyingDetail(err, OK).page).toBe('no_anchor');
  });
});

// ═══════════ ③ asOf 新鲜度分档（FR-020） ═══════════

describe('asOf 新鲜度分档（FR-020：禁静默当当日实时）', () => {
  it('server 判 CURRENT → 正文「数据截至 X · 收盘」，无后缀', () => {
    const f = freshnessOf(TODAY, 'CURRENT');
    expect(f.tier).toBe('CURRENT');
    expect(f.asOf).toBe(TODAY);
    expect(f.text).toBe(`数据截至 ${TODAY} · 收盘`);
  });

  it('server 判 STALE → 同一句 + 显式后缀（禁静默当实时）', () => {
    const f = freshnessOf('2026-07-29', 'STALE');
    expect(f.tier).toBe('STALE');
    expect(f.text).toBe(`数据截至 2026-07-29 · 收盘${COPY.freshness.staleSuffix}`);
  });

  it.each([null, undefined, ''])('asOf 缺失（%s）→ UNAVAILABLE 且**不编造日期**', (bad) => {
    const f = freshnessOf(bad, 'CURRENT');
    expect(f.tier).toBe('UNAVAILABLE');
    expect(f.asOf).toBeNull();
    expect(f.text).toBe(COPY.freshness.unavailable);
  });

  it('🚨 两侧各算各的 —— IV 陈旧不会因为行情当期就被说成当期', () => {
    const ivSide = freshnessOf('2026-07-29', 'STALE');
    const quoteSide = freshnessOf(TODAY, 'CURRENT');
    expect(ivSide.tier).toBe('STALE');
    expect(quoteSide.tier).toBe('CURRENT');
  });

  /**
   * 🚨 **回归防线**：046 初版判据是 `asOf === 设备本地日期`，对美股永不可达 ⇒ 恒 STALE。
   * 现在档位来自 server —— 哪怕 asOf 与本地日期**不相等**，server 说 CURRENT 就是 CURRENT。
   * 把判据搬回客户端比日期，这条立刻红。
   */
  it('🚨 asOf ≠ 设备本地日期但 server 判 CURRENT → 仍渲染成当期（美股场景）', () => {
    const usSessionDate = '2026-08-04'; // 美股 08-04 的 EOD，境内设备此刻已是 08-05
    const f = freshnessOf(usSessionDate, 'CURRENT');
    expect(f.tier).toBe('CURRENT');
    expect(f.text).not.toContain(COPY.freshness.staleSuffix);
  });
});

// ═══════════ ④ 锚卡九字段 + 两个恒态（FR-002/004/005, plan D9 ①②） ═══════════

describe('锚卡字段（FR-002 全量九字段）', () => {
  it('字段清单穷举、无重复、顺序稳定', () => {
    const keys = anchorCardFields(anchor()).map((f) => f.key);
    expect(keys).toEqual([...ANCHOR_CARD_FIELD_KEYS]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('派生链无人工覆盖 → 三处显示派生值、零人工标记（state_branch #16）', () => {
    const fields = anchorCardFields(anchor());
    expect(fields.filter((f) => f.manual)).toEqual([]);
    expect(fields.find((f) => f.key === 'lLevel')?.value).toBe('L2');
    expect(fields.find((f) => f.key === 'positionCap')?.value).toBe('5%');
    expect(anchorManualNotices(anchor())).toEqual([]);
  });

  it('L 层 + 单票上限双人工态 → 各自标记 + 同屏带出派生值（state_branch #17）', () => {
    const a = anchor({
      lLevelIsManual: true,
      lLevelEffective: 'L1',
      derivedLLevel: 'L2',
      positionCapIsManual: true,
      positionCap: '0.12',
      derivedPositionCap: '0.25',
    });
    const fields = anchorCardFields(a);
    expect(fields.filter((f) => f.manual).map((f) => f.key)).toEqual(['lLevel', 'positionCap']);
    expect(anchorManualNotices(a)).toEqual([
      COPY.anchorCard.manualLLevelHint('L2'),
      COPY.anchorCard.manualPositionCapHint('25%'),
    ]);
  });

  it('next_review 逾期 → 红标 + 日期带「已逾期」（state_branch #18 / FR-005）', () => {
    const row = anchorCardFields(anchor({ overdue: true, nextReview: '2026-07-21' })).find(
      (f) => f.key === 'nextReview',
    );
    expect(row?.danger).toBe(true);
    expect(row?.value).toBe(`2026-07-21${COPY.anchorCard.overdueSuffix}`);
  });

  it('next_review 为空 → 「—」且不红标（不是逾期，是没排）', () => {
    const row = anchorCardFields(anchor({ nextReview: null })).find((f) => f.key === 'nextReview');
    expect(row?.value).toBe(COPY.anchorCard.noValue);
    expect(row?.danger).toBe(false);
  });

  it('W 恒强调（愿买价锚，同 045 色带的红界线语义）', () => {
    expect(anchorCardFields(anchor()).find((f) => f.key === 'w')?.danger).toBe(true);
  });

  it('L4 单票上限无 SoT 口径 → 「—」，不自造值', () => {
    const row = anchorCardFields(anchor({ lLevelEffective: 'L4', positionCap: null })).find(
      (f) => f.key === 'positionCap',
    );
    expect(row?.value).toBe(COPY.anchorCard.noValue);
  });
});

describe('🚨 plan D9 —— 三个「本片无数据源」字段的恒态（防 impl 期现编）', () => {
  it('① 仓位水位恒「未知 · 待接入」，**任何锚形态下都不显 0**', () => {
    const variants = [
      anchor(),
      anchor({ lLevelEffective: 'L4', positionCap: null }),
      anchor({ overdue: true }),
    ];
    for (const a of variants) {
      const row = anchorCardFields(a).find((f) => f.key === 'positionLevel');
      expect(row?.value).toBe(COPY.anchorCard.positionLevelPending);
      expect(row?.value).toBe(POSITION_LEVEL_PLACEHOLDER);
      // 「不知道」≠「知道是零」——  0 / 0% / 空仓 三种写法都不许出现。
      expect(row?.value).not.toMatch(/(^|[^\d])0([^\d]|$)|空仓/);
    }
  });

  it('② 未持股 ⇒ 愿卖锚行不出现（state_branch #19 的「持股」半边本片不可达）', () => {
    expect(WILLING_SELL_ROW_VISIBLE).toBe(false);
    // 字段清单里根本没有愿卖锚这一格 —— 不是「渲染时藏起来」，是压根没这一项。
    expect(ANCHOR_CARD_FIELD_KEYS.filter((k) => /willingSell/i.test(k))).toEqual([]);
    const values = anchorCardFields(anchor()).map((f) => f.value);
    expect(values).not.toContain(anchor().willingSellLongHold);
    expect(values.some((v) => v.includes('愿卖'))).toBe(false);
  });

  it('③ 提醒状态由 FR-036 档位纯派生 —— 三档穷举、无第四个值', () => {
    expect([...ALERT_STATUSES]).toEqual(['not_crossed', 'crossed_high', 'crossed_extreme']);
    for (const s of ALERT_STATUSES) expect(alertStatusText(s).length).toBeGreaterThan(0);
  });
});

// ═══════════ ⑤ FR-036 阈值档 25 / 70 / 90 ═══════════

describe('🚨 FR-036 IVP 阈值档边界 = 25 / 70 / 90（不是 mockup 刻度写的 0/50/90/100）', () => {
  it('三个边界常量就是 25 / 70 / 90', () => {
    expect([IVP_MID_MIN, IVP_HIGH_MIN, IVP_EXTREME_MIN]).toEqual([25, 70, 90]);
    expect([...IVP_TIER_BOUNDARIES]).toEqual([25, 70, 90]);
  });

  it('分段条段宽 = 25 / 45 / 20 / 10，合计 100，且**由边界派生**（刻度与段宽同源）', () => {
    expect(IVP_SEGMENTS.map((s) => s.widthPct)).toEqual([25, 45, 20, 10]);
    expect(IVP_SEGMENTS.reduce((a, s) => a + s.widthPct, 0)).toBe(100);
    expect(IVP_SEGMENTS.map((s) => s.tier)).toEqual([...IVP_TIERS]);
  });

  it.each([
    [0, 'low'],
    [24.9, 'low'],
    [25, 'mid'],
    [69.9, 'mid'],
    [70, 'high'],
    [89.9, 'high'],
    [90, 'extreme'],
    [100, 'extreme'],
  ])('IVP %s → %s 档（边界值归上档，归属唯一）', (v, tier) => {
    expect(ivpTier(v as number)).toBe(tier);
  });

  it('提醒状态三分：<70 未越 / 70–90 已越高档 / ≥90 已越极高档', () => {
    expect(alertStatusOf(0)).toBe('not_crossed');
    expect(alertStatusOf(24)).toBe('not_crossed');
    expect(alertStatusOf(69.9)).toBe('not_crossed');
    expect(alertStatusOf(70)).toBe('crossed_high');
    expect(alertStatusOf(89.9)).toBe('crossed_high');
    expect(alertStatusOf(90)).toBe('crossed_extreme');
    expect(alertStatusOf(100)).toBe('crossed_extreme');
  });

  it('🚨 IVP 不可算 ⇒ 徽标 MUST NOT 出现（无 IVP 即无档位）', () => {
    expect(alertStatusOf(null)).toBeNull();
    expect(
      ivReadoutView(iv({ state: 'percentile_unavailable', ivPercentile: null })).alert,
    ).toBeNull();
    expect(ivReadoutView(iv({ state: 'missing', ivPercentile: null })).alert).toBeNull();
  });
});

// ═══════════ ⑥ IV 读数四态（FR-012/014/020/035） ═══════════

describe('IV 读数四态（FR-014：禁回落 0 / 禁隐藏区块 / 禁显示上一次值而不标注）', () => {
  it('available → IVP 数值 + 聚合 IV + 自己的 asOf + 提醒徽标', () => {
    const v = ivReadoutView(iv());
    expect(v.state).toBe('available');
    expect(v.ivPercentile).toBe(63);
    expect(v.ivpText).toBe('63');
    expect(v.degradedText).toBeNull();
    expect(v.aggregateIvText).toBe(`${COPY.ivBlock.aggregateIvPrefix}24.8%`);
    expect(v.alert).toBe('not_crossed');
    expect(v.freshness.tier).toBe('CURRENT');
    expect(v.showMarker).toBe(true);
  });

  it('percentile_unavailable → 「分位不可算」，IVP 为 null 而**不是 0**，聚合 IV 照常出', () => {
    const v = ivReadoutView(iv({ state: 'percentile_unavailable', ivPercentile: null }));
    expect(v.ivPercentile).toBeNull();
    expect(v.ivpText).toBeNull();
    expect(v.degradedText).toBe(COPY.ivBlock.percentileUnavailable);
    expect(v.aggregateIvText).toContain('24.8%');
    expect(v.showMarker).toBe(false);
  });

  it('missing → 「暂无数据」，三值皆 null，区块仍要渲染（判定不返回「隐藏」）', () => {
    const v = ivReadoutView({
      state: 'missing',
      aggregateIv: null,
      ivPercentile: null,
      asOf: null,
      freshnessTier: 'UNAVAILABLE',
    });
    expect(v.degradedText).toBe(COPY.ivBlock.missing);
    expect(v.aggregateIvText).toBe(COPY.ivBlock.noValue);
    expect(v.freshness.tier).toBe('UNAVAILABLE');
  });

  it('🚨 read_failed 与 missing **文案不同** —— 前者是故障、后者是事实', () => {
    const failed = ivReadoutView({
      state: 'read_failed',
      aggregateIv: null,
      ivPercentile: null,
      asOf: null,
      freshnessTier: 'UNAVAILABLE',
    });
    const missing = ivReadoutView({
      state: 'missing',
      aggregateIv: null,
      ivPercentile: null,
      asOf: null,
      freshnessTier: 'UNAVAILABLE',
    });
    expect(failed.degradedText).toBe(COPY.ivBlock.readFailed);
    expect(failed.degradedText).not.toBe(missing.degradedText);
  });

  it('available 但分位串解析不出 → 退「分位不可算」，不渲染 NaN', () => {
    const v = ivReadoutView(iv({ ivPercentile: 'n/a' }));
    expect(v.state).toBe('percentile_unavailable');
    expect(v.ivpText).toBeNull();
    expect(v.alert).toBeNull();
  });

  it('当日未采到 → 最近一期值 + 显式陈旧 asOf（state_branch #3，禁静默当当日）', () => {
    const v = ivReadoutView(iv({ asOf: '2026-07-29', freshnessTier: 'STALE' }));
    expect(v.ivPercentile).toBe(63);
    expect(v.freshness.tier).toBe('STALE');
    expect(v.freshness.text).toContain('2026-07-29');
  });
});

// ═══════════ ⑦ 区间时序几何（FR-006 ~ FR-010） ═══════════

describe('四区间边界只依赖锚（FR-010：切窗口边界不变）', () => {
  it('锚 → 四边界；退化 / 缺值 → null（不画一条错的带）', () => {
    expect(parseZoneBounds(anchor())).toEqual(BOUNDS);
    expect(parseZoneBounds(anchor({ zoneCeiling: '50.00' }))).toBeNull();
    expect(parseZoneBounds(anchor({ w: '' }))).toBeNull();
    expect(parseZoneBounds(anchor({ v: 'abc' }))).toBeNull();
  });

  it('🚨 换窗口 / 换序列，四个边界价**逐值不变**', () => {
    const short = chartAxis([95, 96], BOUNDS);
    const long = chartAxis([40, 200], BOUNDS);
    expect(short).not.toEqual(long);
    expect(zoneBoundaryPrices(BOUNDS)).toEqual([60, 80, 100, 120]);
    expect(zoneRects(BOUNDS, short!, 150).map((r) => r.zone)).toEqual(
      zoneRects(BOUNDS, long!, 150).map((r) => r.zone),
    );
  });
});

describe('纵轴域（FR-010：容纳实际价格区间，禁裁数据）', () => {
  it('价格全在带内 → 域至少覆盖 [zoneFloor, zoneCeiling]', () => {
    const axis = chartAxis([90, 95, 100], BOUNDS)!;
    expect(axis.min).toBeLessThanOrEqual(60);
    expect(axis.max).toBeGreaterThanOrEqual(120);
  });

  it('🚨 价格穿出带外 → 域跟着扩，**不裁掉数据**', () => {
    const axis = chartAxis([30, 220], BOUNDS)!;
    expect(axis.min).toBeLessThan(30);
    expect(axis.max).toBeGreaterThan(220);
  });

  it('序列为空 → 仍按带区间给域（四区间带单独可呈现，state_branch #10）', () => {
    const axis = chartAxis([], BOUNDS)!;
    expect(axis.min).toBeLessThan(60);
    expect(axis.max).toBeGreaterThan(120);
  });

  it('无锚无序列 → null（不编造轴）；有序列无锚 → 按序列给域', () => {
    expect(chartAxis([], null)).toBeNull();
    const axis = chartAxis([10, 20], null)!;
    expect(axis.min).toBeLessThan(10);
    expect(axis.max).toBeGreaterThan(20);
  });

  it('单点序列（域退化）不除零，y 落中线', () => {
    const axis = chartAxis([50], null)!;
    expect(axis.max).toBeGreaterThan(axis.min);
    expect(priceToY(50, { min: 50, max: 50 }, 150)).toBe(75);
  });
});

describe('折线与背景带的像素几何', () => {
  it('priceToY 自顶向下：max 在 0、min 在 height', () => {
    const axis = { min: 0, max: 100 };
    expect(priceToY(100, axis, 150)).toBe(0);
    expect(priceToY(0, axis, 150)).toBe(150);
    expect(priceToY(50, axis, 150)).toBe(75);
  });

  it('polylinePoints 等距横排、点数与序列一致；<2 点 → 空串（不画一条假线）', () => {
    const axis = { min: 0, max: 100 };
    const pts = polylinePoints([0, 50, 100], axis, 300, 150);
    expect(pts).toBe('0.0,150.0 150.0,75.0 300.0,0.0');
    expect(polylinePoints([], axis, 300, 150)).toBe('');
    expect(polylinePoints([42], axis, 300, 150)).toBe('');
  });

  it('五段背景带自上而下 高估 → 深买区，段间无缝无叠', () => {
    const axis = chartAxis([30, 220], BOUNDS)!;
    const rects = zoneRects(BOUNDS, axis, 150);
    expect(rects.map((r) => r.zone)).toEqual([
      'overvalued',
      'expensive',
      'thin',
      'buy',
      'deep_buy',
    ]);
    for (let i = 1; i < rects.length; i += 1) {
      const cur = rects[i]!;
      const prev = rects[i - 1]!;
      expect(cur.top).toBeCloseTo(prev.top + prev.height, 6);
    }
    for (const r of rects) expect(r.height).toBeGreaterThan(0);
  });

  it('轴域切掉的端帽段不产出 0 高矩形（而不是产出一个看不见的 View）', () => {
    // 域恰好卡在内段上 ⇒ 两个端帽段整个被裁掉。
    const rects = zoneRects(BOUNDS, { min: 60, max: 120 }, 150);
    expect(rects.map((r) => r.zone)).toEqual(['expensive', 'thin', 'buy']);
  });
});

describe('序列取数与窗口标注（FR-007 / FR-008）', () => {
  it('收盘价序列跳过非数值行（不拿 0 填坑）', () => {
    expect(
      seriesCloses([{ close: '10.5' }, { close: '' }, { close: 'x' }, { close: '11' }]),
    ).toEqual([10.5, 11]);
  });

  it('序列自身的 asOf = 末根 bar 的交易日；空 → null', () => {
    expect(seriesAsOf([{ tradeDate: '2026-07-30' }, { tradeDate: '2026-07-31' }])).toBe(
      '2026-07-31',
    );
    expect(seriesAsOf([])).toBeNull();
  });

  it('窗口起点 = today 减 N 年（UTC 求值，与本机时区无关）', () => {
    expect(windowStartDate('1Y', TODAY)).toBe('2025-08-03');
    expect(windowStartDate('3Y', TODAY)).toBe('2023-08-03');
    expect(windowStartDate('5Y', TODAY)).toBe('2021-08-03');
    expect(windowStartDate('10Y', TODAY)).toBe('2016-08-03');
  });

  it('序列覆盖整窗 → 「日 K · 近 1 年」/「月 K · 近 10 年」', () => {
    expect(seriesRangeLabel('1Y', '2025-08-05', TODAY)).toBe(
      `${COPY.series.periodDay} · ${COPY.series.window1Y}`,
    );
    expect(seriesRangeLabel('10Y', '2016-08-01', TODAY)).toBe(
      `${COPY.series.periodMonth} · ${COPY.series.window10Y}`,
    );
  });

  it('🚨 序列短于窗口 → 标明实际起点（禁拉伸补空 / 禁静默截断）', () => {
    expect(seriesRangeLabel('1Y', '2026-04-17', TODAY)).toBe(
      `${COPY.series.periodDay} · ${COPY.series.actualStart('2026-04-17')}`,
    );
  });

  it('容差内的晚几天不算「短于窗口」（窗口起点撞周末 / 长假是常态）', () => {
    const within = windowStartDate('1Y', TODAY);
    const d = new Date(`${within}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + SERIES_START_TOLERANCE_DAYS);
    expect(seriesRangeLabel('1Y', d.toISOString().slice(0, 10), TODAY)).toContain(
      COPY.series.window1Y,
    );
  });

  it('序列为空 → 脚注仍报窗口档（空态另有文案，不在脚注里编起点）', () => {
    expect(seriesRangeLabel('3Y', null, TODAY)).toBe(
      `${COPY.series.periodWeek} · ${COPY.series.window3Y}`,
    );
  });
});

// ═══════════ ⑧ 机械防线：FR-035（禁 IV30d）/ FR-013（IVP 先于 IVR、零 iv_rank） ═══════════
//
// ⚠️ 断言面刻意**不是源码文本 grep**：Small 档禁磁盘 I/O（testing.md 分类学），且
//    「IV30d」「iv_rank」字样**合法地**出现在被测模块与本文件的警示注释里 —— 文本断言必假红，
//    还会诱人删警示注释来「修绿」（T020 / T012 已吃过这个教训）。改成**值面**断言。

/** 深走一棵 copy 子树，把所有字符串（含函数产物）收成一条扁平清单。O(n)。 */
function collectStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (typeof node === 'function')
    out.push(String((node as (x: never) => string)('X' as never)));
  else if (node && typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) collectStrings(v, out);
  }
  return out;
}

describe('🚨 FR-035 —— 一律「富途标的聚合 IV」，禁写 IV30d', () => {
  const strings = collectStrings(COPY);

  it('详情屏文案子树非空（防「扫了个空对象所以全绿」的假阳性）', () => {
    expect(strings.length).toBeGreaterThan(30);
  });

  it('文案零命中 iv30d / IV 30d / 30d / 30 天 / ATM 等口径措辞', () => {
    const banned = /iv\s*[-_]?\s*30\s*d|30\s*d\b|30\s*天|atm/i;
    expect(strings.filter((s) => banned.test(s))).toEqual([]);
  });

  it('IV 标注就是「富途标的聚合 IV」这一句', () => {
    expect(COPY.ivBlock.title).toContain('富途标的聚合 IV');
  });

  it('消费的 DTO 字段名里没有 iv30d 形态', () => {
    const consumed = [...IV_READOUT_FIELD_ORDER, ...Object.keys(iv())];
    expect(consumed.filter((k) => /30\s*d/i.test(k))).toEqual([]);
  });

  it('IV 读数视图的产出键面穷举 —— 塞不进第三个数值口径', () => {
    expect(Object.keys(ivReadoutView(iv())).sort()).toEqual([
      'aggregateIvText',
      'alert',
      'degradedText',
      'freshness',
      'ivPercentile',
      'ivpText',
      'showMarker',
      'state',
    ]);
  });
});

describe('🚨 FR-013 —— IVP 优先于 IVR，且 IVR 只落库不上屏', () => {
  it('呈现顺序里 IVP 在聚合 IV 之前', () => {
    expect(IV_READOUT_FIELD_ORDER[0]).toBe('ivPercentile');
    expect(IV_READOUT_FIELD_ORDER.indexOf('ivPercentile')).toBeLessThan(
      IV_READOUT_FIELD_ORDER.indexOf('aggregateIv'),
    );
  });

  it('呈现字段面 + 消费的 DTO 键面**零** iv_rank / ivRank', () => {
    const rank = /iv[_-]?rank/i;
    expect(IV_READOUT_FIELD_ORDER.filter((k) => rank.test(k))).toEqual([]);
    expect(Object.keys(iv()).filter((k) => rank.test(k))).toEqual([]);
    expect(Object.keys(ivReadoutView(iv())).filter((k) => rank.test(k))).toEqual([]);
    expect(collectStrings(COPY).filter((s) => rank.test(s))).toEqual([]);
  });

  it('锚卡字段面也不夹带 IVR（IV 读数只在温度计区块）', () => {
    expect(anchorCardFields(anchor()).filter((f) => /rank/i.test(f.key + f.label))).toEqual([]);
  });
});

// ════════════════ 047 T031 —— 选约区块的 section 组装（FR-001/005, plan D-UI-1） ════════════════

function leg(overrides: Partial<LegResponse> = {}): LegResponse {
  return {
    code: 'AOS260815P80000',
    strike: '80.00',
    expiryDate: '2026-08-15',
    dteDays: 12,
    bid: '1.20',
    ask: '1.35',
    // 053 契约增量（T004）：两者**服务端算**，客户端零处再乘一次合约乘数。
    contractPremium: '120.00',
    relativeSpread: '0.117647',
    bidSize: 25,
    askSize: 26,
    basis: 'weekly',
    periodRate: '0.015190',
    weeklyRate: '0.008861',
    annualizedRate: '0.462215',
    tier: 'good',
    askRate: null,
    effectiveCost: '78.80',
    effectiveCostVsWPct: '-1.50',
    absDelta: 0.42,
    sigmaDistance: 0.2,
    openInterest: 1200,
    volume: 88,
    turnover: '10560.00',
    // 053 契约收窄：一次请求只作答一个视角 ⇒ 档位与活跃标都是**本次视角**的标量
    //（`tierByTab` / `activityByTab` / 每腿 `tabs` 三者同批退役）。
    activity: null,
    isRecommended: false,
    isMonthlyChain: false,
    earningsMark: null,
    greeksComplete: true,
    // 064 `FR-009`: 逐行档位。夹具默认收盘档 —— 实时档的呈现分支由 T008 各自的用例喂。
    priceKind: 'eod_close',
    bandStatus: null,
    wideSpreadOpportunity: false,
    ...overrides,
  };
}

describe('选约区块 —— section 组装（三 Tab 共用同一个列表实例）', () => {
  it('恒返回一个 section —— 切 Tab 只换 data，MUST NOT 每 Tab 一个列表实例', () => {
    const sections = buildLegSections([leg(), leg({ code: 'B' })]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.key).toBe(LEG_SECTION_KEY);
    // 换一份 data（= 切 Tab）后仍是同一个 key 的单 section。
    expect(buildLegSections([leg({ code: 'C' })])[0]?.key).toBe(LEG_SECTION_KEY);
  });

  it('零适格腿仍返回 section 本体 —— 面板不隐藏（FR-021 空 Tab 可进入）', () => {
    const sections = buildLegSections([]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.data).toEqual([]);
  });

  it('🚨 section.data 是逻辑集合本体 —— 零 slice、零 top-N 截断（FR-005）', () => {
    const legs = Array.from({ length: 730 }, (_, i) => leg({ code: `L${i}` }));
    const sections = buildLegSections(legs);
    expect(sections[0]?.data).toHaveLength(730);
    expect(sections[0]?.data[729]?.code).toBe('L729');
  });

  it('🚨 计数条分母 = 逻辑行数，不是渲染窗口大小（SC-012 / plan D-UI-2 ③）', () => {
    expect(legRowTotal(buildLegSections(Array.from({ length: 730 }, () => leg())))).toBe(730);
    expect(legRowTotal(buildLegSections([]))).toBe(0);
  });
});

describe('选约区块 —— 四态（区块自降级，046 三块照常）', () => {
  it('pending → loading；契约状态此刻还没到，不许提前当 available', () => {
    expect(legBlockState(LOADING, undefined)).toBe('loading');
    expect(legBlockState(LOADING, 'available')).toBe('loading');
  });

  it('请求失败 → read_failed（整页 error 页在本屏不存在）', () => {
    expect(legBlockState(FAILED, undefined)).toBe('read_failed');
    expect(legBlockState(FAILED, 'available')).toBe('read_failed');
  });

  it('🚨 chain_not_ready 与 read_failed 蓄意分开 —— MUST NOT 合并成一个「加载失败」', () => {
    expect(legBlockState(OK, 'chain_not_ready')).toBe('chain_not_ready');
    expect(legBlockState(OK, 'read_failed')).toBe('read_failed');
    expect(legBlockState(OK, 'chain_not_ready')).not.toBe(legBlockState(OK, 'read_failed'));
  });

  it('成功且状态齐 → 逐字透传 server 的 state', () => {
    expect(legBlockState(OK, 'available')).toBe('available');
  });

  it('成功但状态字缺失 → 按读故障渲染，不假装 available', () => {
    expect(legBlockState(OK, null)).toBe('read_failed');
  });
});
