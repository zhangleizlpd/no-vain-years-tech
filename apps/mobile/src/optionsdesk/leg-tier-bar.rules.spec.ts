// 064 T008 — 档位条 / 行级档位标的纯函数单测（logic-only）。
// 版面、DOM、a11y 走 T011 Playwright Expo Web —— 本仓测试分层 vitest=logic / Playwright=UI。
//
// 四条机械防线（写错了不会红、但错得很贵）：
//   · 两档的时间**粒度即档位**：实时呈时刻含秒、收盘呈交易日（混成一种不会红任何一处）
//   · OI 列恒取 `oiAsOf` 而非区块级 `quoteAsOf`（后者在实时档下是今天此刻）
//   · 收盘档 / 未就绪两档**必须给得出原因**（FR-011）
//   · 配色零 `quote-*`（涨跌）、零 `info`（本 DS 里它就是 primary，会和实时档撞脸）
import { describe, expect, it } from 'vitest';

import {
  formatQuoteClock,
  formatQuoteSessionDay,
  legEodRowCount,
  legQuoteColumnSubs,
  legQuotePhase,
  legQuoteTier,
  legRowEodMarked,
  legTierBarClassNames,
} from './leg-tier-bar.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.legPicker;

/** 无时区后缀的日期时间串按**本地时间**解析（ES 规范）⇒ 断言不随跑测机器的 TZ 漂移。 */
const LIVE_ISO = '2026-08-19T21:47:32';
const SESSION_DAY = '2026-08-18';

describe('🚨 FR-010 两档的时间格式化 —— 粒度即档位', () => {
  it('实时档呈**时刻含秒**（下拉刷新后要看得见它在推进，分钟粒度看不见）', () => {
    expect(formatQuoteClock(LIVE_ISO)).toBe('21:47:32');
  });

  it('缺失 / 非法时刻 → null（调用方据此不渲染，绝不渲染裸时点）', () => {
    expect(formatQuoteClock(null)).toBeNull();
    expect(formatQuoteClock('')).toBeNull();
    expect(formatQuoteClock('not-a-time')).toBeNull();
  });

  it('收盘档呈**交易日**（短形 MM-DD），🚫 一个冒号都不许有', () => {
    const day = formatQuoteSessionDay(SESSION_DAY);
    expect(day).toBe('08-18');
    expect(day).not.toContain(':');
  });

  it('🚨 反例：拿一个 ISO 时刻喂交易日格式化器 → 仍只解出日期部分，不会渗出时分秒', () => {
    expect(formatQuoteSessionDay(LIVE_ISO)).toBe('08-19');
  });

  it('非日期串 → null', () => {
    expect(formatQuoteSessionDay('2026/08/18')).toBeNull();
    expect(formatQuoteSessionDay(null)).toBeNull();
  });
});

describe('🚨 FR-009 区块级档位条的三形态', () => {
  it('实时档：呈时刻含秒 + 品牌蓝，全到齐时**不报原因**（没有降级就没有要解释的事）', () => {
    const view = legQuoteTier({ priceKind: 'realtime', quoteAsOf: LIVE_ISO, eodRowCount: 0 });

    expect(view.variant).toBe('realtime');
    expect(view.name).toBe(COPY.tierLive);
    expect(view.stamp).toBe('21:47:32');
    expect(view.reason).toBe('');
    expect(view.container).toBe('bg-brand-soft');
  });

  it('收盘档：呈交易日 + 中性灰，且**原因非空**（FR-011）', () => {
    const view = legQuoteTier({ priceKind: 'eod_close', quoteAsOf: SESSION_DAY, eodRowCount: 0 });

    expect(view.variant).toBe('eod_close');
    expect(view.name).toBe(COPY.tierEod);
    expect(view.stamp).toBe('08-18');
    expect(view.reason.length).toBeGreaterThan(0);
    expect(view.container).toBe('bg-surface-alt');
  });

  it('未就绪：**不渲染任何时点**，warning 底 + 3px 左边框 + 正文色的字，且原因非空', () => {
    const view = legQuoteTier({ priceKind: null, quoteAsOf: null, eodRowCount: 0 });

    expect(view.variant).toBe('not_ready');
    expect(view.name).toBe(COPY.tierNotReady);
    expect(view.stamp).toBeNull();
    expect(view.reason.length).toBeGreaterThan(0);
    expect(view.container).toContain('bg-warn-soft');
    expect(view.container).toContain('border-l-[3px]');
    expect(view.container).toContain('border-warn');
    // 🚫 降级不是错误 ⇒ 不用 err / danger 体系（同 046 起「数据缺口 ≠ 红标」纪律）。
    expect(view.container).not.toContain('err');
  });

  it('🚨 反例：档位说 realtime、时点却是个交易日 → 落**未就绪**，MUST NOT 把交易日当时刻渲上去', () => {
    // 这类自相矛盾的响应正是「昨收伪装成此刻」的入口 —— 宁可显式未就绪。
    const view = legQuoteTier({ priceKind: 'realtime', quoteAsOf: SESSION_DAY, eodRowCount: 0 });

    expect(view.variant).toBe('not_ready');
    expect(view.stamp).toBeNull();
  });

  it('🚨 降级三态的文案与原因**逐条非空**（收盘档 / 未就绪 / 实时档部分缺失）', () => {
    const degraded = [
      legQuoteTier({ priceKind: 'eod_close', quoteAsOf: SESSION_DAY, eodRowCount: 0 }),
      legQuoteTier({ priceKind: null, quoteAsOf: null, eodRowCount: 0 }),
      legQuoteTier({ priceKind: 'realtime', quoteAsOf: LIVE_ISO, eodRowCount: 2 }),
    ];

    for (const view of degraded) {
      expect(view.name.length).toBeGreaterThan(0);
      expect(view.reason.length).toBeGreaterThan(0);
    }
    // 部分缺失那条必须报**条数**（不报条数 = 让人不知道要去行内找几枚「收」标）。
    expect(degraded[2]?.reason).toContain('2');
  });

  it('三形态的底色两两不同 —— 靠底色区分档位，撞色即失去信号', () => {
    const containers = (
      [
        { priceKind: 'realtime', quoteAsOf: LIVE_ISO, eodRowCount: 0 },
        { priceKind: 'eod_close', quoteAsOf: SESSION_DAY, eodRowCount: 0 },
        { priceKind: null, quoteAsOf: null, eodRowCount: 0 },
      ] as const
    ).map((input) => legQuoteTier(input).container);

    expect(new Set(containers).size).toBe(3);
  });
});

describe('🚨 FR-014 / FR-013 两个列头副标', () => {
  it('🚨 反例：喂两个**不同**的时间 —— OI 列取的是 `oiAsOf`，不是区块级 `quoteAsOf`', () => {
    // 实时档下 quoteAsOf 是今天此刻（08-19），而 OI 盘中冻结、归属日仍是 08-18。
    // 读错那一个的话，OI 列会跟着标成今天而**列里的数字一个都没变** ⇒ 屏幕上不会红。
    const subs = legQuoteColumnSubs({
      priceKind: 'realtime',
      quoteAsOf: LIVE_ISO,
      oiAsOf: SESSION_DAY,
    });

    expect(subs.oi).toBe(COPY.oiAsOfSub('08-18'));
    expect(subs.oi).not.toContain('08-19');
  });

  it('OI 归属日缺失 → 占位，🚫 不拿区块级时点顶替', () => {
    const subs = legQuoteColumnSubs({ priceKind: 'realtime', quoteAsOf: LIVE_ISO, oiAsOf: null });

    expect(subs.oi).toBe(COPY.oiAsOfSub(COPY.noValue));
    expect(subs.oi).not.toContain('08-19');
  });

  it('成交量口径随档位切：实时「至此刻」/ 收盘「当日」（FR-013）', () => {
    expect(
      legQuoteColumnSubs({ priceKind: 'realtime', quoteAsOf: LIVE_ISO, oiAsOf: SESSION_DAY }).vol,
    ).toBe(COPY.volSubRealtime);
    expect(
      legQuoteColumnSubs({ priceKind: 'eod_close', quoteAsOf: SESSION_DAY, oiAsOf: SESSION_DAY })
        .vol,
    ).toBe(COPY.volSubEod);
  });

  it('档位未知（契约未到手）→ 成交量副标走保守的「当日」，不先挂上实时档才成立的口径', () => {
    expect(legQuoteColumnSubs({ priceKind: null, quoteAsOf: null, oiAsOf: null }).vol).toBe(
      COPY.volSubEod,
    );
  });
});

describe('🚨 FR-009 行级档位标 —— 逐行成立，不页级一刀切', () => {
  it('区块实时 + 该行收盘 → 打标（这一行不是此刻的，必须看得出来）', () => {
    expect(legRowEodMarked('realtime', 'eod_close')).toBe(true);
  });

  it('区块实时 + 该行实时 → 不打标', () => {
    expect(legRowEodMarked('realtime', 'realtime')).toBe(false);
  });

  it('🚨 反例：整表收盘档 → **逐行都不打标**（每行一枚角标只是噪点，还会吃掉 053 的四档色）', () => {
    expect(legRowEodMarked('eod_close', 'eod_close')).toBe(false);
    expect(legRowEodMarked(null, 'eod_close')).toBe(false);
  });

  it('未取到实时的条数只在实时档下计（整表收盘档恒 0，否则档位条会报「全都没取到」）', () => {
    const legs = [
      { priceKind: 'realtime' as const },
      { priceKind: 'eod_close' as const },
      { priceKind: 'eod_close' as const },
    ];

    expect(legEodRowCount('realtime', legs)).toBe(2);
    expect(legEodRowCount('eod_close', legs)).toBe(0);
    expect(legEodRowCount('realtime', [])).toBe(0);
  });
});

describe('🚨 Guardrail 9 / 10 配色禁令（值面扫描，非源码 grep）', () => {
  it('🚫 一处不用涨跌色 —— 档位不是方向，`quote-up` 会让「实时」被读成「涨」', () => {
    for (const name of legTierBarClassNames()) {
      expect(name).not.toContain('quote-');
    }
  });

  it('🚫 一处不用 info —— 本 DS 里 `--nvy-info` 就是 `--nvy-primary`，会和实时档撞脸', () => {
    for (const name of legTierBarClassNames()) {
      expect(name).not.toContain('info');
    }
  });

  it('🚫 不用最淡的 `ink-subtle`（白底实测 2.85:1，不达 WCAG AA）', () => {
    for (const name of legTierBarClassNames()) {
      expect(name).not.toContain('ink-subtle');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 064 T009 —— 在途相位（首屏等待态 / 刷新保表，FR-022）
// ════════════════════════════════════════════════════════════════════════════
describe('🚨 FR-022 在途相位压过档位', () => {
  it('首屏等待态：不给任何时点（屏上还没有任何一批数），且说明**不先出收盘档**', () => {
    const view = legQuoteTier({
      priceKind: null,
      quoteAsOf: null,
      eodRowCount: 0,
      phase: 'first_load',
    });

    expect(view.variant).toBe('busy');
    expect(view.name).toBe(COPY.tierBusyFirstLoad);
    expect(view.stamp).toBeNull();
    expect(view.reason).toBe(COPY.tierBusyFirstLoadNote);
  });

  it('刷新中：报**「上次」的时点**并标明屏上这批仍是它（粒度随它自己的档位走）', () => {
    const view = legQuoteTier({
      priceKind: 'realtime',
      quoteAsOf: LIVE_ISO,
      eodRowCount: 0,
      phase: 'refreshing',
    });

    expect(view.variant).toBe('busy');
    expect(view.name).toBe(COPY.tierBusyRefreshing);
    expect(view.note).toBe(COPY.tierBusyKeptNote);
    expect(view.stamp).toBe('21:47:32');
  });

  it('🚨 刷新中的收盘档报的仍是**交易日**不是时刻 —— 「上次」不改变那一批的粒度', () => {
    const view = legQuoteTier({
      priceKind: 'eod_close',
      quoteAsOf: SESSION_DAY,
      eodRowCount: 0,
      phase: 'refreshing',
    });

    expect(view.stamp).toBe('08-18');
  });

  it('🚨 在途相位**压过档位**：刷新中不渲「实时」那一档 —— 时点尚未推进，说了就是假的', () => {
    const view = legQuoteTier({
      priceKind: 'realtime',
      quoteAsOf: LIVE_ISO,
      eodRowCount: 0,
      phase: 'refreshing',
    });

    expect(view.variant).not.toBe('realtime');
    expect(view.name).not.toBe(COPY.tierLive);
  });

  it('相位映射：首屏 loading → first_load；有表在飞 → refreshing；其余 → settled', () => {
    expect(legQuotePhase('loading', false)).toBe('first_load');
    // 🚨 首屏优先：`isRefreshing` 在首屏本就恒 false，两条同时为真时也不许报成「刷新」。
    expect(legQuotePhase('loading', true)).toBe('first_load');
    expect(legQuotePhase('available', true)).toBe('refreshing');
    expect(legQuotePhase('available', false)).toBe('settled');
    expect(legQuotePhase('chain_not_ready', false)).toBe('settled');
  });

  it('在途那一档的配色仍受两条禁令约束（值面扫描覆盖全部形态）', () => {
    const names = legTierBarClassNames();
    expect(names).toContain('bg-surface-alt');
    for (const name of names) expect(name).not.toContain('quote-');
  });
});
