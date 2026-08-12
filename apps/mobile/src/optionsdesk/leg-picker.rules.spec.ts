// 047 T033 — 三 Tab / 水位 chip / 意图落位的纯函数单测（logic-only）。
// Tab 栏与 chip 的**渲染 / 交互 / a11y** 走 T035 Playwright e2e —— 本仓测试分层 vitest=logic。
//
// 四条机械防线（写错了不会红、但错得很贵）：
//   · 取序读 `tabOrder[tab]`（051 FR-001），成员与顺序**都**归 server —— MUST NOT 在客户端
//     重算带判据、MUST NOT 拿 `legs[]` 的 legacy 载体序当呈现序（FR-004）
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
  intentBasisLine,
  intentLabel,
  isManualBucket,
  legActivityForTab,
  legPickerNotices,
  legPickerSections,
  legTabLabel,
  orderedLegsForTab,
  rateSubForTab,
  resolveLegTab,
  showsBasisBadge,
  type LegPickerTab,
  type LegTabOrder,
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

/** 三份有序列表，未给的 Tab 取空数组（契约保证三份恒有值，不会是 undefined）。 */
function tabOrderOf(over: Partial<Record<LegPickerTab, readonly string[]>> = {}): LegTabOrder {
  return { all: [], build: [], rent: [], ...over };
}

// ═══════════════ ① 取序：按 server 下发的 `tabOrder`，零客户端重排 ═══════════════

describe('🚨 FR-001/FR-004 —— 渲染序取自 `tabOrder`，`legs[]` 的载体序 MUST NOT 当呈现序', () => {
  it('三个 Tab 的键与契约的 `tabs` 值域逐字一致（server 加 Tab 即编译红）', () => {
    expect([...LEG_PICKER_TABS]).toEqual(['all', 'build', 'rent']);
    expect(LEG_PICKER_TABS.map(legTabLabel)).toEqual([
      COPY.tabs.all,
      COPY.tabs.build,
      COPY.tabs.rent,
    ]);
  });

  it('🚨 渲染序与 `tabOrder` 逐行相同，且**与 `legs[]` 的载体序不同**（判别性）', () => {
    const legs = [leg({ code: 'A' }), leg({ code: 'B' }), leg({ code: 'C' })];
    const order = tabOrderOf({ all: ['C', 'A', 'B'] });

    expect(orderedLegsForTab(legs, order, 'all').map((l) => l.code)).toEqual(['C', 'A', 'B']);
    // 🚨 两个序蓄意不同 —— 「映射时顺手拿 legs[] 的序」这种实现会让上一行红。
    // 相等的话本条对 FR-004 完全没有分辨力（050 server 侧同款判别性构造）。
    expect(legs.map((l) => l.code)).not.toEqual(['C', 'A', 'B']);
  });

  it('意图 Tab 只出现在**该 Tab 有序列表**里的腿 —— 成员判据不在客户端重算', () => {
    const legs = [leg({ code: 'A' }), leg({ code: 'B' }), leg({ code: 'C' })];
    const order = tabOrderOf({ all: ['A', 'B', 'C'], build: ['B'], rent: ['C'] });

    expect(orderedLegsForTab(legs, order, 'build').map((l) => l.code)).toEqual(['B']);
    expect(orderedLegsForTab(legs, order, 'rent').map((l) => l.code)).toEqual(['C']);
  });

  it('🚨 greeks 缺失腿照常出现 —— 050 起 Δ 整个退出召回判据，客户端重算必漏掉这支', () => {
    const gap = leg({
      code: 'GAP',
      absDelta: null,
      sigmaDistance: null,
      greeksComplete: false,
      tabs: ['all', 'rent'],
    });
    const order = tabOrderOf({ all: ['GAP'], rent: ['GAP'] });
    expect(orderedLegsForTab([gap], order, 'rent').map((l) => l.code)).toEqual(['GAP']);
  });

  it('🚨 带外的 |Δ| 照样出现在建仓 Tab —— 成员归 server，客户端不复核', () => {
    // |Δ| 0.90 / DTE 300 全数落在旧建仓带外；重算过滤会把它筛掉，读 `tabOrder` 不会。
    const outOfBand = leg({ code: 'OOB', absDelta: 0.9, dteDays: 300, tabs: ['all', 'build'] });
    const order = tabOrderOf({ all: ['OOB'], build: ['OOB'] });
    expect(orderedLegsForTab([outOfBand], order, 'build').map((l) => l.code)).toEqual(['OOB']);
  });

  it('🚨 `tabOrder` 里有 code 而 `legs[]` 定位不到 → 跳过且不崩，MUST NOT 塞占位行', () => {
    const legs = [leg({ code: 'A' }), leg({ code: 'C' })];
    const order = tabOrderOf({ all: ['A', 'MISSING', 'C'] });

    const rows = orderedLegsForTab(legs, order, 'all');
    expect(rows.map((l) => l.code)).toEqual(['A', 'C']);
    // 「跳过」而非「留个洞」—— 数组里 MUST NOT 出现 undefined 占位。
    expect(rows.every((l) => l !== undefined)).toBe(true);
  });

  it('`legs[]` 有而 `tabOrder` 无 → 该 Tab 不含它（反向缺口同样不崩）', () => {
    const legs = [leg({ code: 'A' }), leg({ code: 'ORPHAN' })];
    expect(orderedLegsForTab(legs, tabOrderOf({ all: ['A'] }), 'all').map((l) => l.code)).toEqual([
      'A',
    ]);
  });

  it('三视角来回切，每个 Tab 的顺序恒定（顺序不因切换而变）', () => {
    const legs = [leg({ code: 'A' }), leg({ code: 'B' }), leg({ code: 'C' })];
    const order = tabOrderOf({ all: ['C', 'B', 'A'], build: ['B', 'A'], rent: ['C', 'B'] });
    const codesOf = (tab: LegPickerTab) => orderedLegsForTab(legs, order, tab).map((l) => l.code);

    const first = LEG_PICKER_TABS.map(codesOf);
    // 来回切两轮后逐 Tab 比对 —— 取序是纯函数，任何隐式状态都会在这里露出来。
    void LEG_PICKER_TABS.map(codesOf);
    expect(LEG_PICKER_TABS.map(codesOf)).toEqual(first);
    expect(first).toEqual([
      ['C', 'B', 'A'],
      ['B', 'A'],
      ['C', 'B'],
    ]);
  });

  it('🚨 FR-021 —— 本片只改顺序，**成员集合与开工前逐条相同**（对同一份自洽契约）', () => {
    // 开工前的成员判据是 `legs.filter(l => l.tabs.includes(tab))`（已退役的 `filterLegsByTab`）。
    // server 保证 `tabOrder[t]` 与每腿 `tabs` 同源派生（050 Guardrail 9）⇒ 在一份自洽的契约上，
    // 换成按 `tabOrder` 取序**只能改顺序、不能改成员**。本条把那个「只能」钉成机械判据。
    const legs = [
      leg({ code: 'A', tabs: ['all', 'build'] }),
      leg({ code: 'B', tabs: ['all', 'rent'] }),
      leg({ code: 'C', tabs: ['all', 'build', 'rent'] }),
      leg({ code: 'D', tabs: ['all'] }),
    ];
    // 有序列表由 `tabs` 派生（契约镜像，不写死）；顺序蓄意逆着 `legs[]` 排，好让「顺序变了、
    // 成员没变」这件事在同一条用例里同时可见。
    const order = tabOrderOf(
      Object.fromEntries(
        LEG_PICKER_TABS.map((t) => [
          t,
          legs
            .filter((l) => l.tabs.includes(t))
            .map((l) => l.code)
            .reverse(),
        ]),
      ),
    );

    for (const tab of LEG_PICKER_TABS) {
      const before = legs.filter((l) => l.tabs.includes(tab)).map((l) => l.code);
      const after = orderedLegsForTab(legs, order, tab).map((l) => l.code);

      expect([...after].sort()).toEqual([...before].sort()); // 成员逐条相同
      expect(after).not.toEqual(before); // 顺序确实变了 ⇒ 上一行不是同义反复
    }
  });

  it('🚨 取序函数签名里**没有**比较器 / 排序键 —— 结构保证不是事后约定（类型层证明）', () => {
    // @ts-expect-error 第四个入参不存在: 「排序不在客户端」(FR-002) 靠签名钉死 —— 想在客户端
    // 排就必须先改签名, 那一步 review 看得见。若本行不再报错, 说明签名已被加回排序入口,
    // 此时 `@ts-expect-error` 变成「未使用的抑制」而 typecheck 立刻红。
    orderedLegsForTab([], tabOrderOf(), 'all', (a: LegResponse, b: LegResponse) =>
      a.code.localeCompare(b.code),
    );
  });
});

// ═══════════════ ② 空 Tab：返空集合而非隐藏面板 ═══════════════

describe('🚨 FR-005 —— 空 Tab 返空集合，面板照常在（MUST NOT 隐藏 / 置灰）', () => {
  it('该 Tab 的有序列表为空 → 取序结果是空数组，不是 undefined / null', () => {
    expect(orderedLegsForTab([leg({ code: 'A' })], tabOrderOf({ all: ['A'] }), 'build')).toEqual(
      [],
    );
  });

  it('空 Tab 仍产出**一个** section（列表实例不消失，只是 data 为空）', () => {
    const sections = legPickerSections([leg({ code: 'A' })], tabOrderOf({ all: ['A'] }), 'build');
    expect(sections).toHaveLength(1);
    expect(sections[0]?.data).toEqual([]);
    expect(legRowTotal(sections)).toBe(0);
  });

  it('切 Tab 只换 data —— section 恒长度 1（三 Tab 共用同一个 SectionList）', () => {
    const legs = [leg({ code: 'A' }), leg({ code: 'B' })];
    const order = tabOrderOf({ all: ['A', 'B'], build: ['A'] });
    for (const tab of LEG_PICKER_TABS) {
      expect(legPickerSections(legs, order, tab)).toHaveLength(1);
    }
    expect(legRowTotal(legPickerSections(legs, order, 'all'))).toBe(2);
    expect(legRowTotal(legPickerSections(legs, order, 'build'))).toBe(1);
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
