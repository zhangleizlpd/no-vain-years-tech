// 047 T034 — 档位着色 / 动作四态 / 财报 chip / 数据缺口体系的映射单测（logic-only）。
// 着色**长什么样**是 T035 Playwright 的事；本文件只钉「哪个输入映到哪个输出」。
//
// 五条机械防线（写错了不会红、但错得很贵）：
//   · 四档 × 四态**穷举** —— 少一格就是屏幕上某种腿没有动作建议
//   · 薄档行 MUST 同屏带出 `ask` 口径值（D-SOT-2：人要能自行套用 SoT 的二分）
//   · greeks 缺失的**三处处置一致**（费率占位 / 不着色 / 「无法判档」）—— 三处各写一份必 drift
//   · 死档**照常打财报标**（FR-006：死档是费率档，与到期日 / 财报日正交）
//   · 页面内**零涨跌色**（四档是费率质量档不是涨跌）+ 降级字**零 `ink-subtle`**（对比度 2.85:1）
import { describe, expect, it } from 'vitest';
import type { LegEarningsMarkResponse, LegResponse } from '@nvy/api-client';

import {
  LEG_ACTION_TAG_CLASS,
  LEG_STICKY_BADGE_BASE,
  LEG_STICKY_BADGE_BORDER,
  LEG_TIER_LEGEND,
  LEG_TIER_UNJUDGED_TONE,
  legActionLabel,
  legActionTextClass,
  legAsOfLabel,
  legBidTone,
  legEarningsChip,
  legPickerClassNames,
  legRateCell,
  legRowToneClass,
} from './leg-picker-copy';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.legPicker;
const NO_VALUE = COPY.noValue;

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
    basis: 'annualized',
    periodRate: '0.012000',
    weeklyRate: '0.019000',
    annualizedRate: '0.176000',
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
    ...overrides,
  };
}

function mark(overrides: Partial<LegEarningsMarkResponse> = {}): LegEarningsMarkResponse {
  return {
    mark: 'covered',
    bufferShortfallDays: null,
    lastEarningsDate: '2026-08-12',
    ...overrides,
  };
}

// ═══════════════ ① 四档着色 × 四态动作，穷举 ═══════════════

describe('🚨 FR-010 —— 四档 × 四态梯度穷举（少一格 = 某种腿没有动作建议）', () => {
  it('好 / 可接受合并为「挂 OCO」，靠着色区分档位', () => {
    expect(legActionLabel('good')).toBe(COPY.actionPlaceOco);
    expect(legActionLabel('acceptable')).toBe(COPY.actionPlaceOco);
    // 合并的前提是着色分得开 —— 两档的 bid 底色 MUST NOT 相同。
    expect(legBidTone('good').container).not.toBe(legBidTone('acceptable').container);
  });

  it('薄 →「暂不挂」（「暂」承时间性）· 死档 →「死档剔除」（永久性），两者 MUST NOT 同字', () => {
    expect(legActionLabel('thin')).toBe(COPY.actionHold);
    expect(legActionLabel('dead')).toBe(COPY.actionDead);
    expect(COPY.actionHold).not.toBe(COPY.actionDead);
  });

  it('未判档（tier = null，含 greeks 缺失与无 bid）→「无法判档」', () => {
    expect(legActionLabel(null)).toBe(COPY.actionUnjudgeable);
  });

  it('四个动作文案两两不同（合并只发生在好 / 可接受这一处）', () => {
    expect(
      new Set([COPY.actionPlaceOco, COPY.actionHold, COPY.actionDead, COPY.actionUnjudgeable]).size,
    ).toBe(4);
  });

  it('四档色阶两两不同底色；未判档**不着色**（容器 class 为空串）', () => {
    const tiers = (['good', 'acceptable', 'thin', 'dead'] as const).map(
      (tier) => legBidTone(tier).container,
    );
    expect(new Set(tiers).size).toBe(4);
    expect(tiers.every((c) => c.length > 0)).toBe(true);
    expect(legBidTone(null).container).toBe('');
    expect(legBidTone(null)).toEqual(LEG_TIER_UNJUDGED_TONE);
  });

  it('🚨 只死档整行灰底沉底 —— 其余档**不整行着色**（整行着色会糊）', () => {
    const dead = legRowToneClass('dead');
    for (const tier of ['good', 'acceptable', 'thin', null] as const) {
      expect(legRowToneClass(tier)).not.toBe(dead);
      expect(legRowToneClass(tier)).toBe('bg-surface');
    }
    expect(dead).toContain('surface-sunken');
  });

  it('动作列是**中性 tag 不是按钮** —— 底 + 描边固定一套，不随档位变饱和色', () => {
    expect(LEG_ACTION_TAG_CLASS).toContain('surface-sunken');
    expect(LEG_ACTION_TAG_CLASS).toContain('border-line-strong');
    // 「挂 OCO」是唯一用正文色的那档；其余三态一律降级字，且都不是最淡档。
    expect(legActionTextClass('good')).toBe('text-ink');
    for (const tier of ['thin', 'dead', null] as const) {
      expect(legActionTextClass(tier)).toBe('text-ink-muted');
    }
  });

  it('四档图例逐档给出边界值（口径注两族都在，跨族不比数值）', () => {
    expect(LEG_TIER_LEGEND.map((row) => row.tier)).toEqual(['good', 'acceptable', 'thin', 'dead']);
    for (const row of LEG_TIER_LEGEND) {
      expect(row.bounds.length).toBeGreaterThan(0);
      expect(row.tone.container).toBe(legBidTone(row.tier).container);
    }
  });
});

// ═══════════════ ② 薄档带 ask（D-SOT-2） ═══════════════

describe('🚨 D-SOT-2 —— 薄档行的费率列 MUST 同屏显出 `ask` 口径值', () => {
  it('薄档 + 有 askRate ⇒ 副标带出 ask 费率（人据此自行套用 SoT 的二分）', () => {
    // 🚨 051 FR-016：**腿上的 legacy `tier` 蓄意设成另一档** —— 判据只能来自入参那个档位，
    //    读回 `leg.tier` 的实现在这里当场红（两者相等时它照样绿，那才是没有分辨力的测法）。
    const cell = legRateCell(
      leg({ tier: 'good', basis: 'annualized', annualizedRate: '0.072000', askRate: '0.114000' }),
      'thin',
    );
    expect(cell.primary).toBe('7.2%');
    expect(cell.secondary).toBe(COPY.rateAskRef('11.4%'));
  });

  it('薄档的周化行同样带 ask —— 🚨 此时 ask 顶掉折年参照（折年是参照，ask 是 MUST）', () => {
    const cell = legRateCell(
      leg({ basis: 'weekly', weeklyRate: '0.008000', askRate: '0.012000' }),
      'thin',
    );
    expect(cell.primary).toBe('0.80%');
    expect(cell.secondary).toBe(COPY.rateAskRef('1.20%'));
  });

  it('非薄档不带 ask —— 其余档 `askRate` 契约上恒 null，带出来只会误导', () => {
    for (const tier of ['good', 'acceptable', 'dead'] as const) {
      const cell = legRateCell(leg({ basis: 'annualized', askRate: '0.114000' }), tier);
      expect(cell.secondary ?? '').not.toContain('ask');
    }
  });

  it('薄档但 askRate 缺失 ⇒ 退回基础呈现，MUST NOT 渲 `ask —`', () => {
    const cell = legRateCell(leg({ basis: 'weekly', askRate: null }), 'thin');
    expect(cell.secondary).toBe(COPY.rateAnnualizedRef('17.6%'));
  });
});

// ═══════════════ ③ greeks 缺失：三处处置一致 ═══════════════

describe('🚨 FR-007 —— greeks 缺失行的三处处置必须一致', () => {
  const gap = leg({ tier: null, greeksComplete: false, absDelta: null, sigmaDistance: null });

  it('① 费率列显缺失占位（算得出来但会骗人：深实值腿折年 307% 染绿最危险）', () => {
    expect(legRateCell(gap, null).primary).toBe(NO_VALUE);
    expect(legRateCell(gap, null).secondary).toBeNull();
  });

  it('② 不判档不着色', () => {
    expect(legBidTone(null)).toEqual(LEG_TIER_UNJUDGED_TONE);
  });

  it('③ 动作标「无法判档」', () => {
    expect(legActionLabel(null)).toBe(COPY.actionUnjudgeable);
  });

  it('🚨 行照常在表内、不沉底 —— 沉底是死档的处置，两者不同', () => {
    expect(legRowToneClass(null)).toBe(legRowToneClass('good'));
    expect(legRowToneClass(null)).not.toBe(legRowToneClass('dead'));
  });
});

// ═══════════════ ④ 财报 chip 五形态 + null ═══════════════

describe('🚨 FR-006/026/034 —— 财报 chip 五形态 + null，三个「无标」MUST NOT 合并', () => {
  it('长腿缓冲充足 →「覆盖 ✓」', () => {
    expect(legEarningsChip(mark({ mark: 'covered' })).label).toBe(COPY.earningsCovered);
  });

  it('缓冲不足带 +Nd —— N 的语义是**还差几天**凑够缓冲', () => {
    const chip = legEarningsChip(mark({ mark: 'buffer_short', bufferShortfallDays: 3 }));
    expect(chip.label).toBe(COPY.earningsBufferShort(3));
    expect(chip.label).toContain('3');
  });

  it('契约给了 buffer_short 却没给 N ⇒ 退无 N 的说法，MUST NOT 渲 `+nulld`', () => {
    const chip = legEarningsChip(mark({ mark: 'buffer_short', bufferShortfallDays: null }));
    expect(chip.label).toBe(COPY.earningsBufferShortUnknown);
  });

  it('短腿跨财报 →「跨财报 ⚠」（提醒非拦截）', () => {
    expect(legEarningsChip(mark({ mark: 'crosses_earnings' })).label).toBe(COPY.earningsCrosses);
  });

  it('🚨 `no_cross` / `no_date` / `null` 三者两两可分 —— 标签与形态都不许合并', () => {
    const noCross = legEarningsChip(mark({ mark: 'no_cross' }));
    const noDate = legEarningsChip(mark({ mark: 'no_date' }));
    const buildLeg = legEarningsChip(null);
    const labels = [noCross.label, noDate.label, buildLeg.label];
    expect(new Set(labels).size).toBe(3);
    expect(new Set([noCross.variant, noDate.variant, buildLeg.variant]).size).toBe(3);
  });

  it('「不跨」= 无 chip 纯文字；「无日期」= 虚线 chip（数据缺口体系）；建仓腿 = 占位符', () => {
    expect(legEarningsChip(mark({ mark: 'no_cross' })).container).toBe('');
    expect(legEarningsChip(mark({ mark: 'no_date' })).container).toContain('border-dashed');
    expect(legEarningsChip(mark({ mark: 'no_date' })).container).toContain('surface-sunken');
    expect(legEarningsChip(null).container).toBe('');
    expect(legEarningsChip(null).label).toBe(NO_VALUE);
  });

  it('🚨 FR-006：死档行照常打财报标 —— 打标函数**根本不吃档位**（结构上无法特殊化）', () => {
    const same = mark({ mark: 'crosses_earnings' });
    expect(legEarningsChip(same)).toEqual(legEarningsChip(same));
    // 死档腿与好档腿拿同一个 mark 得同一个 chip（判据是 mark 本身，不是行的档位）。
    expect(legEarningsChip(leg({ tier: 'dead', earningsMark: same }).earningsMark)).toEqual(
      legEarningsChip(leg({ tier: 'good', earningsMark: same }).earningsMark),
    );
  });

  it('五形态的 chip 形态穷举 —— 每个 mark 值都有归宿（漏一个即编译红 + 运行时红）', () => {
    for (const m of [
      'covered',
      'buffer_short',
      'crosses_earnings',
      'no_cross',
      'no_date',
    ] as const) {
      expect(legEarningsChip(mark({ mark: m })).label.length).toBeGreaterThan(0);
    }
  });
});

// ═══════════════ ④' 区块级 asOf 的两档呈现（T027a） ═══════════════
//
// 🚨 档位**由 server 下发**（`asOfFreshnessTier`）。客户端 MUST NOT 拿设备本地日期自判 ——
//    境内看美股本地日历恒领先市场一天 ⇒ 每个读数都判「陈旧」，永远为真的告警等于没有告警。
//    本组用例只钉「档位 → 文案 / class」这层映射；判据本身归 server 单测。

describe('T027a 区块级 asOf 二分（常态 vs 陈旧，档位来自 server）', () => {
  it('CURRENT ⇒ 「数据截至 X · 收盘」，**无**陈旧后缀', () => {
    const label = legAsOfLabel('2026-08-04', 'CURRENT');
    expect(label.text).toBe('数据截至 2026-08-04 · 收盘');
    expect(label.text).not.toContain(COPY.asOfStaleSuffix.trim());
  });

  it('STALE ⇒ 同一句加陈旧后缀，且 class **与常态不同**（醒目态）', () => {
    const stale = legAsOfLabel('2026-08-03', 'STALE');
    expect(stale.text).toBe(`数据截至 2026-08-03 · 收盘${COPY.asOfStaleSuffix}`);
    expect(stale.className).not.toBe(legAsOfLabel('2026-08-03', 'CURRENT').className);
  });

  it('UNAVAILABLE ⇒ 「无数据时点」，⚠️ 降级字用 ink-muted 而非 ink-subtle（2.85:1 不达 AA）', () => {
    const none = legAsOfLabel(null, 'UNAVAILABLE');
    expect(none.text).toBe(COPY.asOfUnavailable);
    expect(none.className).toContain('text-ink-muted');
    expect(none.className).not.toContain('ink-subtle');
  });

  it('🚨 asOf 缺失时无论 server 说什么都渲「无数据时点」—— 绝不渲「数据截至 null」', () => {
    for (const tier of ['CURRENT', 'STALE', 'UNAVAILABLE'] as const) {
      expect(legAsOfLabel(null, tier).text).toBe(COPY.asOfUnavailable);
    }
  });

  it('三档的 class 都进 class 面清单（否则配色禁令扫不到这块）', () => {
    const names = legPickerClassNames();
    for (const tier of ['CURRENT', 'STALE', 'UNAVAILABLE'] as const) {
      expect(names).toContain(legAsOfLabel('2026-08-04', tier).className);
    }
  });
});

// ═══════════════ ④'' 钉住列的两个标（051 FR-011a / FR-014b） ═══════════════

describe('🚨 051 FR-014b —— 推荐标与月度链标**同载体、以视觉权重区分**', () => {
  it('两个标共用同一条载体 class，差别只在描边这一处', () => {
    // 「同载体」不是形容词：两者的 base 逐字相同，各自只追加一个描边色。
    expect(LEG_STICKY_BADGE_BORDER.fit).not.toBe(LEG_STICKY_BADGE_BORDER.monthly);
    expect(LEG_STICKY_BADGE_BASE).toContain('border');
    expect(LEG_STICKY_BADGE_BASE).toContain('text-[8px]');
  });

  it('🚨 MUST NOT 退化成纯几何符号 —— 两个标的字都是**认得出来的汉字**', () => {
    // 判据来自 mockup 实证：月度链标初版是空心方块，spec 作者本人评审时仍需发问「这是什么」。
    // 空串 / ■ / ◆ 这类形态在这里当场红。
    for (const label of [COPY.fitBadge, COPY.monthlyBadge]) {
      expect(label).toMatch(/^[一-龥]+$/u);
    }
    expect(COPY.fitBadge).not.toBe(COPY.monthlyBadge);
  });

  it('🚨 FR-011a —— 推荐标 MUST NOT 用 success / 绿系（会被读成「建议买入」）', () => {
    expect(LEG_STICKY_BADGE_BORDER.fit).not.toMatch(/\b(ok|success|green|quote-up)\b/);
    // 推荐标用 tag 调色板；月度链标取中性描边（更弱的视觉权重）。
    expect(LEG_STICKY_BADGE_BORDER.fit).toContain('tag-');
    expect(LEG_STICKY_BADGE_BORDER.monthly).toContain('line');
  });

  it('两个标的 class 都进 class 面清单（否则配色禁令扫不到钉住列这块）', () => {
    const names = legPickerClassNames();
    expect(names).toContain(LEG_STICKY_BADGE_BASE);
    expect(names).toContain(LEG_STICKY_BADGE_BORDER.fit);
    expect(names).toContain(LEG_STICKY_BADGE_BORDER.monthly);
  });
});

// ═══════════════ ⑤ 配色禁令的值面机械防线 ═══════════════
//
// ⚠️ 断言面刻意**不是源码 grep**（Small 档禁磁盘 I/O，体例同 046 `thermometer.rules.spec.ts`）：
//    改扫本模块**实际吐出的每一个 class 串** —— 比 grep 更强，因为它连间接拼出来的都逮得到。
//    源码面的 `rg` 扫描（含腿行组件树零 `Pressable`）走 commit 期的 CLI verify 与 T035 e2e。

describe('🚨 四档是费率质量档不是涨跌 ⇒ 页面内零涨跌色', () => {
  it('class 面非空（防「扫了个空清单所以全绿」的假阳性）', () => {
    expect(legPickerClassNames().length).toBeGreaterThan(15);
  });

  it('零命中 quote 涨跌色 token', () => {
    expect(legPickerClassNames().filter((c) => /quote-/.test(c))).toEqual([]);
  });

  it('⚠️ 零命中最淡档 `ink-subtle`（白底实测 2.85:1，降级状态字不达 WCAG AA）', () => {
    expect(legPickerClassNames().filter((c) => /ink-subtle/.test(c))).toEqual([]);
  });

  it('🚫 FR-012：吐出的 class 里没有任何按钮观感（动作列是建议标签不是按钮）', () => {
    expect(legPickerClassNames().filter((c) => /\bbg-brand-500\b/.test(c))).toEqual([]);
  });
});
