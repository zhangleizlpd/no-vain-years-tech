// 047 T033 — 三视角 / 水位 chip / 意图落位的纯函数单测（logic-only）。
// Tab 栏与 chip 的**渲染 / 交互 / a11y** 走 T035 Playwright e2e —— 本仓测试分层 vitest=logic。
//
// 四条机械防线（写错了不会红、但错得很贵）：
//   · 未选水位 ⇒ 停「全腿」+ 两条显式提示，**MUST NOT 静默取某一 Δ 档**（FR-017）
//   · 两个门槛计数的**语义与交互都不对称**（051 FR-007/FR-007a）
//   · 空态三支一眼可分（051 FR-009 + 052 条件收窄那支）
//   · 053 计数三处分工：区块头报 `matchedCount`、非常驻区报 `D` 与 `N−D`、`K` 熔断另起异常位
//     —— 三处 **MUST NOT 报同一个数**（SC-005），截断与熔断 **MUST NOT 同款**（Guardrail 14）
//
// 🚨 **053 起本文件不再测「取序」** —— `tabOrder` / `activityByTab` / `tierByTab` / 每腿 `tabs`
//    随响应收窄一并删除，`legs[]` 就是该视角已排序已截断的腿，客户端连「取哪一格」都没有了
//    ⇒ `orderedLegsForTab` / `legPickerSections` / `legActivityForTab` / `legTierForTab`
//    四个函数与它们的用例同批退役（成员与顺序的判据全部落回 server IT，见 053 T005）。
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
  legCandidateCapLine,
  legEmptyState,
  legGateCountLines,
  legGateCountsQuiet,
  legPickerNotices,
  legRowCountLine,
  legTabLabel,
  legTruncationLine,
  promotePick,
  rateHeaderFor,
  resolveLegTab,
} from './leg-picker.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.legPicker;

function leg(overrides: Partial<LegResponse> = {}): LegResponse {
  return {
    code: 'PEP260815P133000',
    strike: '133.00',
    expiryDate: '2026-08-15',
    dteDays: 11,
    bid: '1.60',
    ask: '1.70',
    // 053 契约增量（T004）：两者**服务端算**，客户端零处再乘一次合约乘数。
    contractPremium: '160.00',
    relativeSpread: '0.060606',
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
    // 053 契约收窄：一次请求只作答一个视角 ⇒ 档位与活跃标都是**本次视角**的标量
    //（`tierByTab` / `activityByTab` / 每腿 `tabs` 三者同批退役）。
    activity: null,
    isRecommended: false,
    isMonthlyChain: false,
    earningsMark: null,
    greeksComplete: true,
    // 064 `FR-009`: 逐行档位。夹具默认收盘档 —— 实时档的呈现分支由 T008 各自的用例喂。
    priceKind: 'eod_close',
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
    livenessMin: null,
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
      livenessMin: untouched,
      relativeSpreadMax: untouched,
    },
  };
}

function table(overrides: Partial<LegTableResponse> = {}): LegTableResponse {
  return {
    symbol: 'us:PEP',
    // 053 契约增量：本次作答的视角，原样回显请求参数（迟到的那一发靠它认领，FR-008）。
    perspective: 'all',
    state: 'available',
    asOf: '2026-08-04',
    asOfFreshnessTier: 'CURRENT',
    // 064 `FR-009`: 区块级档位。夹具默认收盘档 (⇒ quoteAsOf 也是交易日形态)。
    priceKind: 'eod_close',
    // 064 T007a: 链级降级标。夹具默认 `null` —— 正常收盘档不是降级。
    realtimeDegrade: null,
    quoteAsOf: '2026-08-04',
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
    gateCounts: {
      removedByPremiumFloor: 0,
      // 053 起它就是「该视角自己的数」—— 一次请求只判定一个视角，051 的分视角映射随之退役。
      excludedFromIntentTabs: 0,
    },
    // 053 收窄：**本次视角**那一份口径 / 条件全景（`basisByTab` / `criteriaByTab` 同批退役）。
    basis: 'annualized',
    criteria: criteria(),
    // 053 契约增量：截断相关三数 + K 触及数。基线取「零截断、零覆盖、未触及」。
    matchedCount: 0,
    memberCount: 0,
    displayLimit: null,
    candidateCapDropped: 0,
    ...overrides,
  };
}

// ═══════════════ ① 三个视角的键与标签 ═══════════════

describe('三视角值域 —— 键取自契约 `perspective`，server 加一格即编译红', () => {
  it('三个视角的键与展示序逐字一致', () => {
    expect([...LEG_PICKER_TABS]).toEqual(['all', 'build', 'rent']);
    expect(LEG_PICKER_TABS.map(legTabLabel)).toEqual([
      COPY.tabs.all,
      COPY.tabs.build,
      COPY.tabs.rent,
    ]);
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

  it('🚨 契约到手前手点的 Tab MUST 留得住 —— 「意图从未知变已知」不算意图变了', () => {
    // 进详情页那一刻契约还没到手 ⇒ intent 为 null，而 Tab 栏此时**恒可点**（FR-020）。
    // 若把 null → rent 也当作「意图变了」，这一下点击会被静默丢弃、Tab 弹回收租腿 ——
    // 人看到的就是「点了没反应」（2026-08-12 真机实证形态）。
    expect(resolveLegTab(promotePick({ intent: null, tab: 'build' }, 'rent'), 'rent')).toBe(
      'build',
    );
  });

  it('升格之后真实意图变化仍然让位 —— 本修 MUST NOT 破坏 US3-AS1', () => {
    // 未选水位时（intent=pending）手点建仓 → 升格为 pending；选完水位矩阵输出 rent ⇒ 照旧让位。
    const promoted = promotePick({ intent: null, tab: 'build' }, 'pending');
    expect(resolveLegTab(promoted, 'rent')).toBe('rent');
  });
});

describe('promotePick —— 契约到手时把「点击时意图未知」的手点值升格', () => {
  it('契约到手 ⇒ 升格到当前意图，tab 不变', () => {
    expect(promotePick({ intent: null, tab: 'build' }, 'rent')).toEqual({
      intent: 'rent',
      tab: 'build',
    });
  });

  it('契约仍未到手 ⇒ 原样返回同一引用（调用方据此判断要不要写 state）', () => {
    const picked = { intent: null, tab: 'build' } as const;
    expect(promotePick(picked, null)).toBe(picked);
    expect(promotePick(picked, undefined)).toBe(picked);
  });

  it('点击时意图已知的手点值不动 —— 升格只针对 null 那一档', () => {
    const picked = { intent: 'pending', tab: 'all' } as const;
    expect(promotePick(picked, 'rent')).toBe(picked);
  });

  it('没手点过 ⇒ 恒 null', () => {
    expect(promotePick(null, 'rent')).toBeNull();
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
  // 🚨 两个数蓄意不同：任何一处取错都能被指出来。
  // 📌 053 起排除数只有**一份**（该视角自己的数）—— 051 那个「全表标量 vs 分视角数」的取数
  //    分支随契约收窄消失，故这里不再构造三值。
  const counts = { removedByPremiumFloor: 113, excludedFromIntentTabs: 20 };

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

  it('🚨 053 —— 排除数就是**该视角自己的数**，两个意图视角报的是各自响应里的那一个', () => {
    // 一次请求只判定一个视角 ⇒ 同一份 gateCounts 不可能同时属于两个视角；这里验的是
    // 「本函数不再对数做任何按视角的挑选」，取数分支消失后**没有取错的余地**。
    expect(legGateCountLines(counts, 'build')[1]?.count).toBe(20);
    expect(legGateCountLines(counts, 'rent')[1]?.count).toBe(20);
    expect(legGateCountLines(counts, 'build')[1]?.text).toContain('20');
  });

  it('全腿视角：措辞改口且**无入口**（已经在全腿视角，再给「去全腿视角」是死链）', () => {
    const line = legGateCountLines(counts, 'all')[1];
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
    const bothZero = { removedByPremiumFloor: 0, excludedFromIntentTabs: 0 };
    const onlyLiquidity = { removedByPremiumFloor: 0, excludedFromIntentTabs: 7 };
    expect(legGateCountsQuiet(legGateCountLines(bothZero, 'build'))).toBe(true);
    expect(legGateCountsQuiet(legGateCountLines(onlyLiquidity, 'build'))).toBe(false);
    expect(legGateCountsQuiet(legGateCountLines(counts, 'build'))).toBe(false);
  });
});

// ═══════════════ ④c 意图视角空态（051 FR-008 / FR-009 / SC-013） ═══════════════

describe('🚨 051 FR-009 —— 空态按**该视角自己的**排除数分支', () => {
  // 📌 053 起契约只发一份排除数（本视角自己的）⇒ 「取错视角那一格」这条风险由契约消掉，
  //    本组用例改为验分支本身：> 0 指向门槛并给入口、= 0 指向判据且不给入口。
  const counts = (excluded: number) => ({
    removedByPremiumFloor: 25,
    excludedFromIntentTabs: excluded,
  });

  it('该视角排除数 > 0 ⇒ 指向门槛 + 带入口（数字与入口都用该视角自己的数）', () => {
    const state = legEmptyState(counts(20), 'build');
    expect(state.text).toContain('20');
    expect(state.cta?.tab).toBe('all');
    expect(state.cta?.label).toContain('20');
  });

  it('该视角排除数为 0 ⇒ 指向「确实没有」+ **无入口**（没有可去看的腿）', () => {
    const state = legEmptyState(counts(0), 'build');
    expect(state.cta).toBeNull();
    expect(state.text).not.toContain('20');
    // 🚨 判别性：MUST NOT 借用权利金那条的 25 —— 两个数语义不同，混用不会红。
    expect(state.text).not.toContain('25');
  });

  it('两个意图视角各说各的判据（建仓多一道有效成本门槛，收租只有期限段）', () => {
    expect(legEmptyState(counts(0), 'build').text).not.toBe(legEmptyState(counts(0), 'rent').text);
    expect(legEmptyState(counts(0), 'build').title).not.toBe(
      legEmptyState(counts(0), 'rent').title,
    );
  });

  it('全腿视角沿用既有单行文案 —— 它不受流动性门槛约束，没有「被挡下」这一分支', () => {
    const state = legEmptyState(counts(20), 'all');
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

describe('🚨 051 FR-017/FR-017a —— 费率列头取自服务端下发的 `basis`，列头**就是口径**', () => {
  it('两个口径取值穷举：周化带折年参照副标 · 年化单行无副标', () => {
    expect(rateHeaderFor('weekly')).toEqual({
      main: COPY.rateBasisWeekly,
      sub: COPY.rateBasisWeeklySub,
    });
    expect(rateHeaderFor('annualized')).toEqual({ main: COPY.rateBasisAnnualized, sub: null });
  });

  it('🚨 列头 MUST NOT 是「费率」这层通用标题 —— 口径取自服务端这件事要在视觉上自明', () => {
    for (const basis of ['weekly', 'annualized'] as const) {
      expect(rateHeaderFor(basis).main).not.toBe(COPY.columns.rate);
    }
    // 判别性：两个口径的列头 MUST 不同，否则「读错了口径」照样绿。
    expect(rateHeaderFor('weekly').main).not.toBe(rateHeaderFor('annualized').main);
  });

  it('🚨 053 —— 签名里**没有视角入参**：客户端 MUST NOT 自带一份「视角 → 口径」映射（FR-017）', () => {
    // @ts-expect-error 第二个入参不存在: 硬编码一份映射必与 server 漂移, 而漂移时**两边都算得出
    // 结果**（列头写「周化」、数字却是年化判出来的档，没有任何一处会红）⇒ 靠签名钉死。
    // 若本行不再报错, 说明视角入参已被加回, 此时 `@ts-expect-error` 变成「未使用的抑制」而 typecheck 立刻红。
    rateHeaderFor('weekly', 'build');
  });

  it('🚨 FR-018 —— 口径取值超出客户端值域 ⇒ 降级为通用标题，不崩不猜', () => {
    // server 可能先于客户端上线新取值（如按月口径）：类型层这时已经骗不了运行时，
    // 故这里蓄意越过类型断言塞一个未知值 —— 穷举 `Record` 拦得住编译期，拦不住这一支。
    const unknown = 'monthly' as unknown as 'weekly';
    expect(rateHeaderFor(unknown)).toEqual({ main: COPY.columns.rate, sub: null });
  });

  it('契约还没到手（null）⇒ 同一个降级态 —— MUST NOT 先猜一个口径挂上去', () => {
    expect(rateHeaderFor(null)).toEqual({ main: COPY.columns.rate, sub: null });
  });
});

// ═══════════════ ⑥ 空态第三支：条件收窄出来的空（052 Edge Case） ═══════════════

describe('🚨 052 —— 用户收窄出来的空 MUST 与「本来就没有」一眼可分', () => {
  const CRITERIA_COPY = COPY.criteria;
  /** 在基线条件全景上把某一维改成「已覆盖」。 */
  const overridden = (state: 'widened' | 'narrowed'): PerspectiveCriteriaResponse => {
    const base = criteria();
    return { ...base, outcomes: { ...base.outcomes, strikeMax: { state, excludedCount: 8 } } };
  };
  const counts = { removedByPremiumFloor: 0, excludedFromIntentTabs: 0 };

  it('有覆盖 + 空 ⇒ 入口是「复位」，🚫 而不是「去别的视角看」（换视角在这里帮不上忙）', () => {
    const state = legEmptyState(counts, 'rent', overridden('narrowed'));
    expect(state.reset).toBe(CRITERIA_COPY.emptyResetCta);
    expect(state.cta).toBeNull();
    expect(state.title).toBe(CRITERIA_COPY.emptyTitle);
  });

  it('🚨 放宽也算覆盖 —— 放宽到空同样是用户自己动出来的（判据是「动过没」不是「收窄没」）', () => {
    expect(legEmptyState(counts, 'rent', overridden('widened')).reset).not.toBeNull();
  });

  it('🚨 全腿视角也走这一支 —— 它没有「被门槛挡下」那支，但照样能被条件收窄到空', () => {
    const state = legEmptyState(counts, 'all', overridden('narrowed'));
    expect(state.reset).not.toBeNull();
    expect(state.text).not.toBe(COPY.empty);
  });

  it('🚫 未覆盖 ⇒ 既有两支逐字不变（051 回归）', () => {
    const untouched = legEmptyState(counts, 'all', criteria());
    expect(untouched.text).toBe(COPY.empty);
    expect(untouched.reset).toBeNull();
    // 契约未到手同理：不凭空长出一个复位入口。
    expect(legEmptyState(counts, 'build', null).reset).toBeNull();
    expect(legEmptyState(counts, 'build').reset).toBeNull();
  });
});

// ═══════════════ ⑦ 053 计数三处分工（FR-016 / FR-017 / FR-018 / FR-019c） ═══════════════

/** 一段文案里出现的所有整数（`SC-005` 的机械判据 —— 「同一个数值」按数字本身比，不按措辞比）。 */
function numbersIn(text: string): string[] {
  return text.match(/\d+/g) ?? [];
}

/** 一张被截断的表：符合条件 153 条、下发 40 条 ⇒ 其余 113 条未显示。 */
const TRUNCATED = table({
  legs: Array.from({ length: 40 }, (_, i) => leg({ code: `L${i}` })),
  matchedCount: 153,
  memberCount: 153,
  displayLimit: 40,
});

describe('🚨 053 FR-016 —— 区块头报「符合条件的总数」，MUST NOT 报渲染出来的行数', () => {
  it('未覆盖（memberCount === matchedCount）⇒ 单数形态，MUST NOT 并列两个相等的数（FR-009）', () => {
    const line = legRowCountLine(table({ matchedCount: 153, memberCount: 153 }));
    expect(line).toBe(COPY.rowTotal(153));
    expect(numbersIn(line)).toEqual(['153']);
  });

  it('🚨 覆盖生效（memberCount > matchedCount）⇒ 并列「筛后 · 全量」，两个数都在', () => {
    const line = legRowCountLine(table({ matchedCount: 153, memberCount: 200 }));
    expect(numbersIn(line).sort()).toEqual(['153', '200']);
    // 判别性：两种形态 MUST 不同，否则「没接上 memberCount」照样绿。
    expect(line).not.toBe(legRowCountLine(table({ matchedCount: 153, memberCount: 153 })));
  });

  it('🚨 报的是 `matchedCount` 而不是 `legs.length` —— 截断之后两者不再相等', () => {
    // 接错的实现在这里会报 40（渲染出来的行数）：数字真实、句子通顺，只是答的不是「符合条件几条」。
    expect(numbersIn(legRowCountLine(TRUNCATED))).toEqual(['153']);
  });

  it('契约未到手 ⇒ 退「共 0 行」，MUST NOT 渲半截依据', () => {
    expect(legRowCountLine(null)).toBe(COPY.rowTotal(0));
  });
});

describe('🚨 053 FR-016/FR-017/FR-018 —— 截断计数第 3 条', () => {
  it('触发截断 ⇒ 报「已显示 D」与「未显示 N−D」，两数之和恒等于 matchedCount（SC-004）', () => {
    const line = legTruncationLine(TRUNCATED);
    expect(line).not.toBeNull();
    expect(line?.shown).toBe(40);
    expect(line?.hidden).toBe(113);
    expect((line?.shown ?? 0) + (line?.hidden ?? 0)).toBe(TRUNCATED.matchedCount);
  });

  it('🚨 FR-018 —— 未触发截断 ⇒ **整条不渲染**（null），MUST NOT 显空值或两个恒等的数', () => {
    // 恰等于阈值（边界取「严格大于才截」）与远小于阈值两支都不出。
    const atLimit = table({ legs: [leg()], matchedCount: 1, memberCount: 1, displayLimit: 1 });
    const under = table({ legs: [leg()], matchedCount: 1, memberCount: 1, displayLimit: 40 });
    expect(legTruncationLine(atLimit)).toBeNull();
    expect(legTruncationLine(under)).toBeNull();
    expect(legTruncationLine(null)).toBeNull();
  });

  it('🚨 收窄到阈值以下那一刻 ⇒ 计数消失，MUST NOT 停在旧值', () => {
    // 同一屏、同一个视角，条件收窄后 matchedCount 落回 D ⇒ 本函数是纯函数，无处存旧值。
    const narrowed = table({ ...TRUNCATED, matchedCount: 40, memberCount: 153 });
    expect(legTruncationLine(narrowed)).toBeNull();
  });

  it('🚨 SC-005 —— 计数区与 sticky 区块头**不出现同一个数值**', () => {
    const header = numbersIn(legRowCountLine(TRUNCATED));
    const footer = numbersIn(legTruncationLine(TRUNCATED)?.text ?? '');
    expect(footer.length).toBeGreaterThan(0);
    expect(footer.filter((n) => header.includes(n))).toEqual([]);
    // 覆盖生效那一支同样成立（区块头此时有**两个**数）。
    const overridden = table({ ...TRUNCATED, memberCount: 200 });
    const header2 = numbersIn(legRowCountLine(overridden));
    const footer2 = numbersIn(legTruncationLine(overridden)?.text ?? '');
    expect(footer2.filter((n) => header2.includes(n))).toEqual([]);
  });

  it('🚨 FR-016 —— MUST NOT 复述「符合条件 N 条」（那个数已由区块头承担）', () => {
    expect(legTruncationLine(TRUNCATED)?.text).not.toContain(String(TRUNCATED.matchedCount));
  });

  it('🚨 FR-018 —— 与 051 两条门槛计数**措辞不混用同一个词**（被条件挡下 ≠ 被截断）', () => {
    const truncated = legTruncationLine(TRUNCATED)?.text ?? '';
    const gates = legGateCountLines(
      { removedByPremiumFloor: 9, excludedFromIntentTabs: 7 },
      'rent',
    );
    // 门槛说「移出 / 排除」（腿不合格或不进本视角），截断说「未显示」（腿合格，只是排在阈值之后）。
    expect(truncated).not.toMatch(/移出|排除/);
    for (const gate of gates) expect(gate.text).not.toContain('未显示');
  });

  it('🚨 FR-017 —— 附收窄指引且指向**抽屉入口的那个措辞**（分页与「加载更多」都不存在）', () => {
    const truncated = legTruncationLine(TRUNCATED)?.text ?? '';
    expect(truncated).toContain(COPY.criteria.entry);
    // 🚫 FR-019 / US1-AS5：文案 MUST NOT 暗示存在分页或增量加载这条路。
    expect(truncated).not.toMatch(/加载更多|下一页|翻页|上拉|下拉/);
  });

  it('🚨 `shown === 0` 不渲染 —— 空表由空态说话，且那时 hidden 会恰好等于 matchedCount（撞 SC-005）', () => {
    const empty = table({ legs: [], matchedCount: 5, memberCount: 5, displayLimit: 40 });
    expect(legTruncationLine(empty)).toBeNull();
  });
});

describe('🚨 053 FR-019c —— 候选上限 `K` 的异常位（与截断计数不同款）', () => {
  it('未触及（0）⇒ null ⇒ 整块 100% 不出现（SC-016）', () => {
    expect(legCandidateCapLine(table({ candidateCapDropped: 0 }))).toBeNull();
    expect(legCandidateCapLine(null)).toBeNull();
  });

  it('触及 ⇒ 报出触及数，且说明**上面的数可能少报**（matchedCount 静默失真）', () => {
    const line = legCandidateCapLine(table({ candidateCapDropped: 812 }));
    expect(line?.dropped).toBe(812);
    expect(line?.text).toContain('812');
    // K 触及会让 matchedCount 算在已被砍过的集合上 ⇒「其余 N−D 条」少报，而条数与数值全都正常。
    expect(line?.text).toMatch(/少报|不完整/);
  });

  it('🚨 Guardrail 14 —— 与截断计数**不同款**：不借用截断的措辞，也不是第四条常规计数', () => {
    const cap = legCandidateCapLine(table({ ...TRUNCATED, candidateCapDropped: 812 }))?.text ?? '';
    const truncated = legTruncationLine(TRUNCATED)?.text ?? '';
    expect(cap).not.toBe(truncated);
    // 「未显示」是截断的词；`K` 熔断说的是「召回阶段就没进来」—— 混用会让「该调容量」被读成「该调展示」。
    expect(cap).not.toContain('未显示');
    // 它也不混进两条门槛计数（那三个数是「判据挡下了什么」，这一个是「保险丝熔断了」）。
    const gateKeys = legGateCountLines(
      { removedByPremiumFloor: 0, excludedFromIntentTabs: 0 },
      'all',
    ).map((g) => g.key);
    expect(gateKeys).toEqual(['premium_floor', 'liquidity']);
  });
});
