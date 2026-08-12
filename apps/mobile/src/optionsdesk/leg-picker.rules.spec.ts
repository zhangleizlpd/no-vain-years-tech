// 047 T033 — 三 Tab / 水位 chip / 意图落位的纯函数单测（logic-only）。
// Tab 栏与 chip 的**渲染 / 交互 / a11y** 走 T035 Playwright e2e —— 本仓测试分层 vitest=logic。
//
// 四条机械防线（写错了不会红、但错得很贵）：
//   · Tab 过滤只读 `leg.tabs`，**MUST NOT 在客户端重算 D-SOT-4 的带判据**（判据单点在 server）
//   · 空 Tab 返**空集合**而非「隐藏面板」（FR-020）
//   · 活跃度**随 Tab 换**（排名是候选集内的相对量，同一条腿在两个 Tab 里不是同一个标）
//   · 未选水位 ⇒ 停「全腿」+ 两条显式提示，**MUST NOT 静默取某一 Δ 档**（FR-017）
import { describe, expect, it } from 'vitest';
import type { LegResponse, LegTableResponse } from '@nvy/api-client';

import {
  DEFAULT_TAB_BY_INTENT,
  LEG_PICKER_TABS,
  LEG_POSITION_BUCKETS,
  bucketLabel,
  defaultLegTab,
  filterLegsByTab,
  intentBasisLine,
  intentLabel,
  isManualBucket,
  legActivityForTab,
  legPickerNotices,
  legPickerSections,
  legTabLabel,
  rateSubForTab,
  resolveLegTab,
  showsBasisBadge,
} from './leg-picker.rules';
import { legRowTotal } from './underlying-detail.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.legPicker;

function activity(label: string | null) {
  return { isRoundStrike: label !== null, isTopRanked: false, label };
}

function leg(overrides: Partial<LegResponse> = {}): LegResponse {
  return {
    code: 'PEP260815P133000',
    strike: '133.00',
    expiryDate: '2026-08-15',
    dteDays: 11,
    bid: '1.60',
    ask: '1.70',
    bidSize: 25,
    askSize: 26,
    basis: 'weekly',
    periodRate: '0.012000',
    weeklyRate: '0.019000',
    annualizedRate: '1.110000',
    tier: 'good',
    askRate: null,
    effectiveCost: '131.40',
    effectiveCostVsWPct: '9.50',
    absDelta: 0.45,
    sigmaDistance: 0.13,
    openInterest: 1865,
    volume: 240,
    turnover: '39800',
    activityByTab: { all: null, build: null, rent: null },
    tabs: ['all'],
    // 050 契约增量（P1 只镜像形状，消费归 P2）：非成员格恒 null。
    tierByTab: { all: 'good', build: null, rent: null },
    isRecommended: false,
    isMonthlyChain: false,
    earningsMark: null,
    greeksComplete: true,
    ...overrides,
  };
}

function table(overrides: Partial<LegTableResponse> = {}): LegTableResponse {
  return {
    symbol: 'us:PEP',
    state: 'available',
    asOf: '2026-08-04',
    asOfFreshnessTier: 'CURRENT',
    quoteAsOf: '2026-08-04T20:10:00.000Z',
    oiAsOf: '2026-08-03',
    source: 'eod',
    spot: '145.20',
    w: '136.00',
    zone: 'buy',
    lLevel: 'L2',
    positionBucket: null,
    positionBucketSource: null,
    positionBucketSetAt: null,
    intent: 'pending',
    rentDepth: null,
    legs: [],
    // 050 契约增量（P1 只镜像形状，消费归 P2）：三份列表恒有值（空数组而非 undefined）。
    tabOrder: { all: [], build: [], rent: [] },
    gateCounts: {
      removedByPremiumFloor: 0,
      excludedFromIntentTabs: 0,
      // 051 FR-006a: 按视角拆的排除数。基线取 0；需要非零的用例走 `overrides`。
      excludedFromIntentTabsByTab: { build: 0, rent: 0 },
    },
    basisByTab: { all: 'annualized', build: 'weekly', rent: 'annualized' },
    ...overrides,
  };
}

// ═══════════════ ① Tab 过滤：只读 `tabs` 数组，零重算 ═══════════════

describe('🚨 Tab 过滤直接用 `leg.tabs`，MUST NOT 重算 D-SOT-4 的带判据', () => {
  it('三个 Tab 的键与契约的 `tabs` 值域逐字一致（server 加 Tab 即编译红）', () => {
    expect([...LEG_PICKER_TABS]).toEqual(['all', 'build', 'rent']);
    expect(LEG_PICKER_TABS.map(legTabLabel)).toEqual([
      COPY.tabs.all,
      COPY.tabs.build,
      COPY.tabs.rent,
    ]);
  });

  it('全腿 Tab 拿到全部腿 —— `all` 恒在每条腿的 `tabs` 里（server 保证）', () => {
    const legs = [leg({ code: 'A' }), leg({ code: 'B', tabs: ['all', 'rent'] })];
    expect(filterLegsByTab(legs, 'all').map((l) => l.code)).toEqual(['A', 'B']);
  });

  it('意图 Tab 只留 `tabs` 含它的腿', () => {
    const legs = [
      leg({ code: 'A', tabs: ['all'] }),
      leg({ code: 'B', tabs: ['all', 'build'] }),
      leg({ code: 'C', tabs: ['all', 'rent'] }),
    ];
    expect(filterLegsByTab(legs, 'build').map((l) => l.code)).toEqual(['B']);
    expect(filterLegsByTab(legs, 'rent').map((l) => l.code)).toEqual(['C']);
  });

  it('🚨 greeks 缺失腿合法进收租 Tab —— 卖put区走锚轴 `K ≤ W` 不读 Δ（客户端重算必漏掉这支）', () => {
    const gap = leg({
      code: 'GAP',
      absDelta: null,
      sigmaDistance: null,
      greeksComplete: false,
      tabs: ['all', 'rent'],
    });
    expect(filterLegsByTab([gap], 'rent').map((l) => l.code)).toEqual(['GAP']);
  });

  it('🚨 带外的 |Δ| 照样进建仓 Tab —— 成员判据归 server，客户端不复核', () => {
    // |Δ| 0.90 / DTE 300 全数落在 D-SOT-4 的建仓带外；重算过滤会把它筛掉，读 `tabs` 不会。
    const outOfBand = leg({ code: 'OOB', absDelta: 0.9, dteDays: 300, tabs: ['all', 'build'] });
    expect(filterLegsByTab([outOfBand], 'build').map((l) => l.code)).toEqual(['OOB']);
  });

  it('排序原样透传 —— 死档 / 未判档的位次由 server 定死，客户端零重排', () => {
    const legs = [
      leg({ code: 'GOOD', tier: 'good' }),
      leg({ code: 'GAP', tier: null, greeksComplete: false }),
      leg({ code: 'DEAD', tier: 'dead' }),
    ];
    expect(filterLegsByTab(legs, 'all').map((l) => l.code)).toEqual(['GOOD', 'GAP', 'DEAD']);
  });
});

// ═══════════════ ② 空 Tab：返空集合而非隐藏面板 ═══════════════

describe('🚨 FR-020 —— 空 Tab 返空集合，面板照常在（MUST NOT 隐藏 / 置灰）', () => {
  it('零适格腿的 Tab 过滤结果是空数组，不是 undefined / null', () => {
    expect(filterLegsByTab([leg({ tabs: ['all'] })], 'build')).toEqual([]);
  });

  it('空 Tab 仍产出**一个** section（列表实例不消失，只是 data 为空）', () => {
    const sections = legPickerSections([leg({ tabs: ['all'] })], 'build');
    expect(sections).toHaveLength(1);
    expect(sections[0]?.data).toEqual([]);
    expect(legRowTotal(sections)).toBe(0);
  });

  it('切 Tab 只换 data —— section 恒长度 1（三 Tab 共用同一个 SectionList）', () => {
    const legs = [leg({ code: 'A', tabs: ['all', 'build'] }), leg({ code: 'B', tabs: ['all'] })];
    for (const tab of LEG_PICKER_TABS) {
      expect(legPickerSections(legs, tab)).toHaveLength(1);
    }
    expect(legRowTotal(legPickerSections(legs, 'all'))).toBe(2);
    expect(legRowTotal(legPickerSections(legs, 'build'))).toBe(1);
  });
});

// ═══════════════ ③ 活跃度随 Tab 换 ═══════════════

describe('🚨 D-SOT-5 —— 活跃度是**当前 Tab 候选集内**的相对排名，换 Tab 归属就变', () => {
  const row = leg({
    tabs: ['all', 'rent'],
    activityByTab: { all: activity('整数档'), build: null, rent: activity('Top 3') },
  });

  it('同一条腿在两个 Tab 里拿到的不是同一个标', () => {
    expect(legActivityForTab(row, 'all')?.label).toBe('整数档');
    expect(legActivityForTab(row, 'rent')?.label).toBe('Top 3');
  });

  it('不属于该 Tab 的位置恒 null —— MUST NOT 拿别的 Tab 的标顶上', () => {
    expect(legActivityForTab(row, 'build')).toBeNull();
  });
});

// ═══════════════ ④ 意图落位 + 未选水位的两条显式提示 ═══════════════

describe('FR-016 —— Tab 默认停在意图对应的那个 Tab', () => {
  it('四个意图穷举映射（漏一个成员即编译红）', () => {
    expect(DEFAULT_TAB_BY_INTENT).toEqual({
      build_position: 'build',
      rent: 'rent',
      no_new_position: 'all',
      pending: 'all',
    });
    expect(Object.keys(DEFAULT_TAB_BY_INTENT).sort()).toEqual([
      'build_position',
      'no_new_position',
      'pending',
      'rent',
    ]);
  });

  it('意图 chip 四态各有其字；契约未到手退「待定」（不是 loading 的替身）', () => {
    expect(intentLabel('build_position')).toBe(COPY.intents.build_position);
    expect(intentLabel('rent')).toBe(COPY.intents.rent);
    expect(intentLabel('no_new_position')).toBe(COPY.intents.no_new_position);
    expect(intentLabel('pending')).toBe(COPY.intents.pending);
    expect(intentLabel(null)).toBe(COPY.intents.pending);
  });

  it('🚨 未选水位（pending）停「全腿」—— MUST NOT 猜一个意图 Tab', () => {
    expect(defaultLegTab('pending')).toBe('all');
  });

  it('不开新仓也停「全腿」—— 腿数据照常全量可读（FR-021）', () => {
    expect(defaultLegTab('no_new_position')).toBe('all');
  });

  it('契约还没到手（null / undefined）时退「全腿」，不闪一个意图 Tab', () => {
    expect(defaultLegTab(null)).toBe('all');
    expect(defaultLegTab(undefined)).toBe('all');
  });

  it('没手点过 ⇒ 跟随矩阵默认落位', () => {
    expect(resolveLegTab(null, 'rent')).toBe('rent');
  });

  it('同一意图内手点说了算 —— 切去看别的 Tab 不会被弹回来', () => {
    expect(resolveLegTab({ intent: 'rent', tab: 'all' }, 'rent')).toBe('all');
  });

  it('🚨 US3-AS1：选完水位意图一变，Tab 让位给新的默认落位（否则人以为水位没存上）', () => {
    // 未选水位时人手点过「全腿」；选完水位后矩阵输出 rent ⇒ 停收租腿，不被旧手点值压住。
    expect(resolveLegTab({ intent: 'pending', tab: 'all' }, 'rent')).toBe('rent');
  });
});

describe('🚨 FR-017 —— 未选水位是常驻分支：显式提示，MUST NOT 静默假设', () => {
  it('水位未选 ⇒ 全腿 Tab 出「选一次水位档以定位意图」', () => {
    expect(legPickerNotices(table(), 'all').map((n) => n.key)).toEqual(['bucket_unset']);
    expect(legPickerNotices(table(), 'all')[0]?.text).toBe(COPY.bucketUnsetHint);
  });

  it('🚨 水位未选 + 收租 Tab ⇒ 追加「展示全部 Δ 档」的就地注明（含并集上下界）', () => {
    const notices = legPickerNotices(table(), 'rent');
    expect(notices.map((n) => n.key)).toEqual(['bucket_unset', 'rent_depth_union']);
    const note = notices[1]?.text ?? '';
    expect(note).toContain('0.05');
    expect(note).toContain('0.40');
  });

  it('水位已选 ⇒ 两条提示都消失（三 Tab 均无）', () => {
    const picked = table({
      positionBucket: 'gte_two_thirds',
      positionBucketSource: 'manual',
      intent: 'rent',
      rentDepth: 'deep',
    });
    for (const tab of LEG_PICKER_TABS) {
      expect(legPickerNotices(picked, tab)).toEqual([]);
    }
  });

  it('契约未到手（table = null）不出提示 —— loading 不是「未选」', () => {
    expect(legPickerNotices(null, 'rent')).toEqual([]);
  });

  it('「人工输入」直接读 `positionBucketSource`，不靠前端记忆推', () => {
    expect(isManualBucket('manual')).toBe(true);
    expect(isManualBucket(null)).toBe(false);
  });

  it('三个水位 chip 由低到高，且**没有第四个「清空」档**（写端点三值必填）', () => {
    expect([...LEG_POSITION_BUCKETS]).toEqual([
      'lt_one_third',
      'one_to_two_thirds',
      'gte_two_thirds',
    ]);
  });

  it('🚫 未选显「未选」—— MUST NOT 显 0、MUST NOT 借用某一档的字', () => {
    expect(bucketLabel(null)).toBe(COPY.bucketUnselected);
    expect(LEG_POSITION_BUCKETS.map(bucketLabel)).not.toContain(COPY.bucketUnselected);
  });

  it('判定依据小字把矩阵三输入原样摊开（未选那一维照样显式说出来）', () => {
    expect(intentBasisLine(table())).toBe('L2 · 买区 · 水位 未选');
    expect(
      intentBasisLine(table({ lLevel: 'L3', zone: 'expensive', positionBucket: 'gte_two_thirds' })),
    ).toBe('L3 · 偏贵 · 水位 ≥2/3');
  });

  it('无 spot ⇒ 区间为 null ⇒ 该维显占位，MUST NOT 猜一个区间', () => {
    expect(intentBasisLine(table({ zone: null }))).toContain(COPY.noValue);
  });

  it('契约未到手 ⇒ 空串（调用方据此不渲染，绝不渲染半截依据）', () => {
    expect(intentBasisLine(null)).toBe('');
  });
});

// ═══════════════ ⑤ 口径随 Tab 换（列头副标 + 腿族徽标） ═══════════════

describe('FR-019 —— 全腿 Tab 混排标口径徽标，单口径 Tab 关掉', () => {
  it('徽标只在全腿 Tab 出', () => {
    expect(showsBasisBadge('all')).toBe(true);
    expect(showsBasisBadge('build')).toBe(false);
    expect(showsBasisBadge('rent')).toBe(false);
  });

  it('费率列副标随 Tab 口径换（三个 Tab 各不相同）', () => {
    expect(rateSubForTab('all')).toBe(COPY.columnSubRateMixed);
    expect(rateSubForTab('build')).toBe(COPY.columnSubRateWeekly);
    expect(rateSubForTab('rent')).toBe(COPY.columnSubRateAnnualized);
    expect(new Set(LEG_PICKER_TABS.map(rateSubForTab)).size).toBe(3);
  });
});
