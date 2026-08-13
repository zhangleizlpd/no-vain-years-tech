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
import type {
  LegResponse,
  LegTableResponse,
  PerspectiveCriteriaResponse,
  RetrievalCriteriaResponse,
} from '@nvy/api-client';

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
  legEmptyState,
  legGateCountLines,
  legGateCountsQuiet,
  legPickerNotices,
  legPickerSections,
  legTabLabel,
  legTierForTab,
  orderedLegsForTab,
  rateHeaderFor,
  resolveLegTab,
  type LegPickerTab,
  type LegTabOrder,
} from './leg-picker.rules';
import { LEG_TIER_UNJUDGED_TONE, legBidTone } from './leg-picker-copy';
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

/**
 * 一个视角的检索条件全景（052 T011）—— 基线取「全维度不限 + 三态全 default」。
 *
 * 🚨 六个维度**逐个写出**而不是 `Partial`：漏一维的话，消费侧读到 `undefined` 会当成「不限」
 * 渲染出一个空控件，而 typecheck 不报（`Partial` 把缺席合法化了）。要非默认值的用例走 overrides。
 */
function criteria(): PerspectiveCriteriaResponse {
  const values: RetrievalCriteriaResponse = {
    strikeMax: null,
    strikeMin: null,
    dteBand: null,
    premiumMin: null,
    openInterestMin: null,
    relativeSpreadMax: null,
  };
  const untouched = { state: 'default' as const, excludedCount: 0 };
  return {
    defaults: values,
    effective: values,
    outcomes: {
      strikeMax: untouched,
      strikeMin: untouched,
      dteBand: untouched,
      premiumMin: untouched,
      openInterestMin: untouched,
      relativeSpreadMax: untouched,
    },
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
    // 052 契约增量（T011 只镜像形状，消费归 T012）：三视角恒有一份条件全景，六维穷举。
    criteriaByTab: { all: criteria(), build: criteria(), rent: criteria() },
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

// ═══════════════ ③a 档位随 Tab 换（051 FR-015 / FR-016） ═══════════════

describe('🚨 051 FR-015/FR-016 —— 档位取当前视角那一格，MUST NOT 回落到 legacy 的 `leg.tier`', () => {
  // 🚨 三个视角**蓄意判出三个不同结果**：建仓走周化档界、收租与全腿走年化 ⇒ 同一条腿在两
  //    个视角判出不同档是**定义如此**。若三格同值，「读错了格子」照样绿。
  const row = leg({
    tier: 'good',
    tabs: ['all', 'build', 'rent'],
    tierByTab: { all: 'acceptable', build: 'thin', rent: 'good' },
  });

  it('同一条腿三个视角三个档 —— 且没有一格恒等于 legacy 标量', () => {
    expect(legTierForTab(row, 'all')).toBe('acceptable');
    expect(legTierForTab(row, 'build')).toBe('thin');
    expect(legTierForTab(row, 'rent')).toBe('good');
    expect(new Set(LEG_PICKER_TABS.map((tab) => legTierForTab(row, tab))).size).toBe(3);
  });

  it('🚨 不属于该视角 ⇒ null ⇒ 呈现层显**缺省态**，MUST NOT 回落到 legacy 标量的那一档', () => {
    // legacy 标量说「好档」，而这条腿根本不在建仓视角里 —— 回落的实现会把它染成好档的绿。
    const outsider = leg({
      tier: 'good',
      tabs: ['all'],
      tierByTab: { all: 'good', build: null, rent: null },
    });
    expect(legTierForTab(outsider, 'build')).toBeNull();
    expect(legBidTone(legTierForTab(outsider, 'build'))).toEqual(LEG_TIER_UNJUDGED_TONE);
    expect(legBidTone(legTierForTab(outsider, 'build')).container).not.toBe(
      legBidTone('good').container,
    );
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

  it('🚨 051 FR-020 —— 水位未选 + 收租视角 ⇒ 追加的就地注明说的是「成员集合不变、只是零推荐标」', () => {
    const notices = legPickerNotices(table(), 'rent');
    expect(notices.map((n) => n.key)).toEqual(['bucket_unset', 'rent_depth_union']);
    const note = notices[1]?.text ?? '';
    // 🚨 **否定式断言才有内容**：正向断言文案会自指（`toBe(COPY.x)` 改成什么都绿，Guardrail 12），
    //    而这一条断的是 050 的事实 —— Δ 与水位已结构性地退出收租召回入参 ⇒ 这句注明 MUST NOT
    //    再拿 Δ 档说事。它是 047 旧文案「展示全部 Δ 档（0.05–0.40Δ）」回潮的唯一机械防线，
    //    那条旧文案不会红：数字照显、句子照通顺，只是把范围说得比实际窄。
    expect(note).not.toMatch(/Δ|0\.05|0\.40/);
    // 差别只在于零推荐标 ⇒ 注明必须提到标本身，且与钉住列那个标同一个落字处。
    expect(note).toContain(COPY.fitBadge);
  });

  it('水位已选 ⇒ 两条**水位**提示都消失（三 Tab 均无）', () => {
    const picked = table({
      positionBucket: 'gte_two_thirds',
      positionBucketSource: 'manual',
      // 意图取 build_position —— 收租意图会另外触发 FR-012 那条（与水位无关，见下一组）。
      intent: 'build_position',
      rentDepth: null,
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

// ═══════════════ ④a 收租意图 × 建仓视角的就地说明（051 FR-012） ═══════════════

describe('🚨 051 FR-012 —— 收租意图下打开建仓视角，MUST 就地说明「标按收租意图打」', () => {
  const rentIntent = table({ intent: 'rent', positionBucket: 'lt_one_third' });

  it('收租意图 + 建仓视角 ⇒ 出说明；同一意图下的其余两个视角不出', () => {
    expect(legPickerNotices(rentIntent, 'build').map((n) => n.key)).toEqual([
      'marks_follow_intent',
    ]);
    expect(legPickerNotices(rentIntent, 'rent')).toEqual([]);
    expect(legPickerNotices(rentIntent, 'all')).toEqual([]);
  });

  it('🚨 与水位无关：已选照出（见上条）· 未选时与水位提示**并存**', () => {
    // 挂在「未选水位」那个 early return 后面的话，本条在**最常见的路径**（水位已选）上恒不出现；
    // 挂在它前面又会吞掉水位提示。两条互不隶属，故这里逐字钉住共存时的顺序。
    const unset = legPickerNotices(table({ intent: 'rent', positionBucket: null }), 'build');
    expect(unset.map((n) => n.key)).toEqual(['bucket_unset', 'marks_follow_intent']);
  });

  it('其余意图不出 —— 建仓 / 不开新仓 / 待定三态在建仓视角均无此说明', () => {
    for (const intent of ['build_position', 'no_new_position', 'pending'] as const) {
      expect(legPickerNotices(table({ intent, positionBucket: 'lt_one_third' }), 'build')).toEqual(
        [],
      );
    }
  });

  it('🚨 口径是「按收租意图打」而不是「这个视角没有推荐」（后者会让人以为标丢了）', () => {
    const text = legPickerNotices(rentIntent, 'build')[0]?.text ?? '';
    expect(text).toContain(COPY.intents.rent);
    expect(text).toContain(COPY.fitBadge);
  });
});

// ═══════════════ ④b 两个门槛计数（051 FR-006/FR-007/FR-007a/FR-010） ═══════════════

describe('🚨 051 FR-007/FR-007a —— 两个计数语义与交互**都**不对称', () => {
  const counts = {
    removedByPremiumFloor: 113,
    // 🚨 标量与两个分视角数蓄意三值互不相同：任何一处取错都能被指出来。
    excludedFromIntentTabs: 47,
    excludedFromIntentTabsByTab: { build: 20, rent: 31 },
  };

  it('两条各自可辨识：key / 文案都不同，且顺序恒定（权利金在前）', () => {
    const lines = legGateCountLines(counts, 'build');
    expect(lines.map((l) => l.key)).toEqual(['premium_floor', 'liquidity']);
    expect(lines[0]?.text).not.toBe(lines[1]?.text);
  });

  it('🚨 交互不对称：权利金那条恒无入口（腿不在响应里，给入口 = 空承诺），流动性那条可点去全腿', () => {
    const lines = legGateCountLines(counts, 'build');
    expect(lines[0]?.goTab).toBeNull();
    expect(lines[1]?.goTab).toBe('all');
  });

  it('🚨 措辞不对称：一条说「三个视角都看不到」，另一条指向全腿视角（MUST NOT 用同一个「滤掉」的词）', () => {
    const [gone, still] = legGateCountLines(counts, 'build');
    expect(still?.text).toContain(COPY.tabs.all);
    expect(gone?.text).not.toContain(COPY.tabs.all);
  });

  it('🚨 意图视角取**该视角自己的**数，MUST NOT 用全表标量', () => {
    expect(legGateCountLines(counts, 'build')[1]?.text).toContain('20');
    expect(legGateCountLines(counts, 'rent')[1]?.text).toContain('31');
    for (const tab of ['build', 'rent'] as const) {
      expect(legGateCountLines(counts, tab)[1]?.text).not.toContain('47');
    }
  });

  it('全腿视角：标量是它唯一诚实的用处（那些腿就在本视角内）⇒ 措辞改口且**无入口**', () => {
    const line = legGateCountLines(counts, 'all')[1];
    expect(line?.text).toContain('47');
    // 已经在全腿视角了，再给一个「去全腿视角」的入口是死链。
    expect(line?.goTab).toBeNull();
    expect(line?.text).not.toBe(legGateCountLines(counts, 'build')[1]?.text);
  });

  it('计数为 0 ⇒ 该行只报数、不带解释后缀（「移出 0 条 · 三个视角都看不到」自相矛盾）', () => {
    const zero = { ...counts, removedByPremiumFloor: 0 };
    expect(legGateCountLines(zero, 'build')[0]?.text).toBe(COPY.gatePremiumFloor(0));
  });

  it('契约未到手 ⇒ 空数组（MUST NOT 渲「移出 — 条」）', () => {
    expect(legGateCountLines(null, 'build')).toEqual([]);
  });

  it('🚨 FR-008 —— 两数**皆** 0 才降权；任一非零都是要被看见的真数据', () => {
    const zeroBuild = {
      removedByPremiumFloor: 0,
      excludedFromIntentTabs: 47,
      excludedFromIntentTabsByTab: { build: 0, rent: 7 },
    };
    // 同一份数据两个视角判出不同结果 —— 降权也按视角算，不看全表。
    expect(legGateCountsQuiet(legGateCountLines(zeroBuild, 'build'))).toBe(true);
    expect(legGateCountsQuiet(legGateCountLines(zeroBuild, 'rent'))).toBe(false);
    expect(legGateCountsQuiet(legGateCountLines(counts, 'build'))).toBe(false);
  });
});

// ═══════════════ ④c 意图视角空态（051 FR-008 / FR-009 / SC-013） ═══════════════

describe('🚨 051 FR-009 —— 空态按**该视角自己的**排除数分支', () => {
  const counts = (build: number, rent: number, scalar = 99) => ({
    removedByPremiumFloor: 25,
    excludedFromIntentTabs: scalar,
    excludedFromIntentTabsByTab: { build, rent },
  });

  it('该视角排除数 > 0 ⇒ 指向门槛 + 带入口（数字与入口都用该视角自己的数）', () => {
    const state = legEmptyState(counts(20, 3), 'build');
    expect(state.text).toContain('20');
    expect(state.cta?.tab).toBe('all');
    expect(state.cta?.label).toContain('20');
  });

  it('该视角排除数为 0 ⇒ 指向「确实没有」+ **无入口**（没有可去看的腿）', () => {
    const state = legEmptyState(counts(0, 0), 'build');
    expect(state.cta).toBeNull();
    expect(state.text).not.toContain('20');
  });

  it('🚨 SC-013 交叉验证：建仓排除数 0、收租排除数 > 0 ⇒ **建仓空态仍指向「确实没有」**', () => {
    // 这条正是「服务端按视角拆计数」买来的东西 —— 不验等于没买。
    // 用全表标量的实现在这里会给建仓视角一个「有 99 条被挡了，去看看」的入口：数字真实、
    // 文案通顺、指向的却是收租视角的腿，而且不会红。
    const build = legEmptyState(counts(0, 31), 'build');
    const rent = legEmptyState(counts(0, 31), 'rent');

    expect(build.cta).toBeNull();
    expect(build.text).not.toContain('31');
    expect(build.text).not.toContain('99');
    expect(rent.cta?.tab).toBe('all');
    expect(rent.text).toContain('31');
    // 两种情形的文案 MUST 互不相同（SC-013 的字面要求）。
    expect(build.text).not.toBe(rent.text);
  });

  it('两个意图视角各说各的判据（建仓多一道有效成本门槛，收租只有期限段）', () => {
    expect(legEmptyState(counts(0, 0), 'build').text).not.toBe(
      legEmptyState(counts(0, 0), 'rent').text,
    );
    expect(legEmptyState(counts(0, 0), 'build').title).not.toBe(
      legEmptyState(counts(0, 0), 'rent').title,
    );
  });

  it('全腿视角沿用既有单行文案 —— 它不受流动性门槛约束，没有「被挡下」这一分支', () => {
    const state = legEmptyState(counts(20, 31), 'all');
    expect(state.title).toBeNull();
    expect(state.text).toBe(COPY.empty);
    expect(state.cta).toBeNull();
  });

  it('契约未到手 ⇒ 退同一个通用空态（MUST NOT 渲「被挡下 — 条」）', () => {
    expect(legEmptyState(null, 'build').cta).toBeNull();
    expect(legEmptyState(null, 'build').text).toBe(COPY.empty);
  });
});

// ═══════════════ ⑤ 费率列头随视角口径换 ═══════════════
//
// 📌 原「腿族口径徽标只在全腿 Tab 出」那组用例随 `showsBasisBadge` 整条退役（051 FR-019a）——
//    徽标的取值其实是 **Tab 成员关系**却顶着口径形状的标签，而全腿视角档位恒年化。

describe('🚨 051 FR-017/FR-017a —— 费率列头取自 `basisByTab`，列头**就是口径**', () => {
  // 契约下发的映射（全腿恒年化 —— 混着 10 天与 200 天的腿，周化档界会让整列全死档）。
  const basisByTab = { all: 'annualized', build: 'weekly', rent: 'annualized' } as const;

  it('两个口径取值穷举：周化带折年参照副标 · 年化单行无副标', () => {
    expect(rateHeaderFor(basisByTab, 'build')).toEqual({
      main: COPY.rateBasisWeekly,
      sub: COPY.rateBasisWeeklySub,
    });
    expect(rateHeaderFor(basisByTab, 'rent')).toEqual({
      main: COPY.rateBasisAnnualized,
      sub: null,
    });
    expect(rateHeaderFor(basisByTab, 'all')).toEqual({ main: COPY.rateBasisAnnualized, sub: null });
  });

  it('🚨 列头 MUST NOT 是「费率」这层通用标题 —— 口径取自服务端这件事要在视觉上自明', () => {
    for (const tab of LEG_PICKER_TABS) {
      expect(rateHeaderFor(basisByTab, tab).main).not.toBe(COPY.columns.rate);
    }
    // 判别性：两个口径的列头 MUST 不同，否则「读错了 tab」照样绿。
    expect(rateHeaderFor(basisByTab, 'build').main).not.toBe(
      rateHeaderFor(basisByTab, 'rent').main,
    );
  });

  it('🚨 FR-018 —— 口径取值超出客户端值域 ⇒ 降级为通用标题，不崩不猜', () => {
    // server 可能先于客户端上线新取值（如按月口径）：类型层这时已经骗不了运行时，
    // 故这里蓄意越过类型断言塞一个未知值 —— 穷举 `Record` 拦得住编译期，拦不住这一支。
    const unknown = { ...basisByTab, build: 'monthly' } as unknown as typeof basisByTab;
    expect(rateHeaderFor(unknown, 'build')).toEqual({ main: COPY.columns.rate, sub: null });
  });

  it('契约还没到手（null）⇒ 同一个降级态 —— MUST NOT 先猜一个口径挂上去', () => {
    expect(rateHeaderFor(null, 'build')).toEqual({ main: COPY.columns.rate, sub: null });
    expect(rateHeaderFor(null, 'rent')).toEqual(rateHeaderFor(null, 'all'));
  });
});
