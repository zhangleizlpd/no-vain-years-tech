// 046 T022 — 波动温度计屏纯函数单测（logic-only）。
// 渲染 / 交互 / a11y（表盘弧画出来了没、免责文案常驻可见）走 T024 Playwright e2e ——
// 本仓测试分层 vitest=logic / Playwright=UI，`~/ui` 与展示组件不写 vitest。
//
// 末三段是**机械防线**（写错了不会红、但错得很贵的那几条）：
//   · FR-017 指数不可得 ⇒ 指针角 `null`，**禁回落到 0 值那个角**
//   · FR-015 📌 全屏零 `regime`（mockup 帧⑦ 画了，2026-08-03 拍板移除）
//   · FR-035 文案与消费字段名零 `iv30d`
import { describe, expect, it } from 'vitest';
import type {
  ThermometerResponse,
  ThermometerUnderlyingRowResponse,
  UnderlyingIvReadoutResponse,
  UsIndexReadoutResponse,
  VvixVixRatioResponse,
} from '@nvy/api-client';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { IVP_SEGMENTS, IVP_TIER_BOUNDARIES } from './underlying-detail.rules';
import {
  VIX_CALM_MAX,
  VIX_ELEVATED_MAX,
  VIX_GAUGE_ARCS,
  VIX_GAUGE_MAX,
  VIX_GAUGE_MIN,
  VIX_TIERS,
  arcPath,
  gaugeAngle,
  indexReadoutView,
  polarPoint,
  ratioView,
  thermometerRowView,
  thermometerView,
  vixGaugeView,
  vixTier,
} from './thermometer.rules';

const TODAY = '2026-08-03';
const COPY = OPTIONSDESK_COPY.thermometer;

function idx(over: Partial<UsIndexReadoutResponse> = {}): UsIndexReadoutResponse {
  return { state: 'available', close: '20.65', asOf: TODAY, freshnessTier: 'CURRENT', ...over };
}

function ratio(over: Partial<VvixVixRatioResponse> = {}): VvixVixRatioResponse {
  return { state: 'available', value: '4.4373', basisDate: TODAY, ...over };
}

function iv(over: Partial<UnderlyingIvReadoutResponse> = {}): UnderlyingIvReadoutResponse {
  return {
    state: 'available',
    aggregateIv: '28.4',
    ivPercentile: '62',
    asOf: TODAY,
    freshnessTier: 'CURRENT',
    ...over,
  };
}

function row(
  over: Partial<ThermometerUnderlyingRowResponse> = {},
): ThermometerUnderlyingRowResponse {
  return { ticker: 'us:AAPL', excluded: false, excludeReason: null, iv: iv(), ...over };
}

function payload(over: Partial<ThermometerResponse> = {}): ThermometerResponse {
  return {
    vix: idx(),
    vvix: idx({ close: '91.64' }),
    vvixVixRatio: ratio(),
    underlyings: [row()],
    total: 1,
    ...over,
  };
}

// ═══════════ ① 表盘几何：值 → 角度的三档边界 ═══════════
//
// 半圆自左（180°）向右（360°）：`VIX_GAUGE_MIN` 在最左、`VIX_GAUGE_MAX` 在最右。

describe('gaugeAngle —— 值→角度线性映射 + 两端钳制', () => {
  it('量程两端各落半圆端点', () => {
    expect(gaugeAngle(VIX_GAUGE_MIN)).toBe(180);
    expect(gaugeAngle(VIX_GAUGE_MAX)).toBe(360);
  });

  it('量程中点落正上方 270°', () => {
    expect(gaugeAngle((VIX_GAUGE_MIN + VIX_GAUGE_MAX) / 2)).toBe(270);
  });

  it('两条档位分界各有确定角度，且严格递增', () => {
    const calm = gaugeAngle(VIX_CALM_MAX);
    const elevated = gaugeAngle(VIX_ELEVATED_MAX);
    expect(180 < calm && calm < elevated && elevated < 360).toBe(true);
  });

  it('越界值钳到端点（不产生半圆外的指针）', () => {
    expect(gaugeAngle(-999)).toBe(180);
    expect(gaugeAngle(999)).toBe(360);
  });
});

describe('vixTier —— 平静 <20 / 抬升 20–30 / 高波 >30，边界归属唯一', () => {
  it('20 与 30 都归「抬升」（分界值不落在相邻两档）', () => {
    expect(vixTier(VIX_CALM_MAX)).toBe('elevated');
    expect(vixTier(VIX_ELEVATED_MAX)).toBe('elevated');
  });

  it('分界外侧各归相邻档', () => {
    expect(vixTier(VIX_CALM_MAX - 0.01)).toBe('calm');
    expect(vixTier(VIX_ELEVATED_MAX + 0.01)).toBe('high');
  });

  it('任一值恰好命中一档（三档互斥且穷尽）', () => {
    for (const v of [0, 19.99, 20, 25, 30, 30.01, 65]) {
      const hit = VIX_TIERS.filter((t) => vixTier(v) === t);
      expect(hit, `VIX=${v}`).toHaveLength(1);
    }
  });
});

describe('VIX_GAUGE_ARCS —— 三段弧首尾相接、与档位分界同源', () => {
  it('三段按 calm → elevated → high 排列', () => {
    expect(VIX_GAUGE_ARCS.map((a) => a.tier)).toEqual(['calm', 'elevated', 'high']);
  });

  it('首尾覆盖整个半圆，中间无缝无叠', () => {
    expect(VIX_GAUGE_ARCS[0]?.fromDeg).toBe(180);
    expect(VIX_GAUGE_ARCS[VIX_GAUGE_ARCS.length - 1]?.toDeg).toBe(360);
    for (let i = 0; i < VIX_GAUGE_ARCS.length - 1; i += 1) {
      expect(VIX_GAUGE_ARCS[i]?.toDeg).toBe(VIX_GAUGE_ARCS[i + 1]?.fromDeg);
    }
  });

  it('段界 = 档位分界的角度（改阈值时弧自动跟着走，不会脱节）', () => {
    expect(VIX_GAUGE_ARCS[0]?.toDeg).toBe(gaugeAngle(VIX_CALM_MAX));
    expect(VIX_GAUGE_ARCS[1]?.toDeg).toBe(gaugeAngle(VIX_ELEVATED_MAX));
  });
});

describe('polarPoint / arcPath —— 半圆坐标', () => {
  it('180° / 270° / 360° 分别落左、上、右', () => {
    expect(polarPoint(100, 100, 50, 180)).toEqual({ x: 50, y: 100 });
    const top = polarPoint(100, 100, 50, 270);
    expect(top.x).toBeCloseTo(100, 6);
    expect(top.y).toBeCloseTo(50, 6);
    const right = polarPoint(100, 100, 50, 360);
    expect(right.x).toBeCloseTo(150, 6);
    expect(right.y).toBeCloseTo(100, 6);
  });

  it('弧 path 从起点画到终点，跨度 ≤180° 时 large-arc = 0', () => {
    const d = arcPath(100, 100, 50, 180, 270);
    expect(d.startsWith('M 50.00 100.00')).toBe(true);
    expect(d).toContain('A 50.00 50.00 0 0 1');
  });
});

// ═══════════ ② 指数读数 / 表盘视图（FR-017） ═══════════

describe('vixGaugeView —— 可得时给角度与档位', () => {
  it('齐备 ⇒ 值、档位、指针角俱全', () => {
    const view = vixGaugeView(idx({ close: '20.65' }));
    expect(view.valueText).toBe('20.65');
    expect(view.tier).toBe('elevated');
    expect(view.pointerAngle).toBe(gaugeAngle(20.65));
    expect(view.degradedText).toBeNull();
  });

  it('新鲜度取该指数自己的 asOf + server 下发的档（陈旧时带标注）', () => {
    expect(vixGaugeView(idx({ asOf: '2026-07-31', freshnessTier: 'STALE' })).freshness.tier).toBe(
      'STALE',
    );
    expect(vixGaugeView(idx()).freshness.tier).toBe('CURRENT');
  });
});

describe('🚨 FR-017 —— 指数不可得 ⇒ 显式不可用，指针 MUST NOT 停在 0', () => {
  const zeroAngle = gaugeAngle(0);

  it('missing / read_failed 两态的指针角都是 null，不是 0 值那个角', () => {
    for (const state of ['missing', 'read_failed'] as const) {
      const view = vixGaugeView(idx({ state, close: null, asOf: null }));
      expect(view.pointerAngle, state).toBeNull();
      expect(view.pointerAngle, state).not.toBe(zeroAngle);
      expect(view.tier, state).toBeNull();
      expect(view.valueText, state).toBeNull();
    }
  });

  it('两态各自成句、且都含「显示不可用」（FR-017 的字面要求）', () => {
    const missing = vixGaugeView(idx({ state: 'missing', close: null })).degradedText;
    const failed = vixGaugeView(idx({ state: 'read_failed', close: null })).degradedText;
    expect(missing).toContain(COPY.gauge.unavailable);
    expect(failed).toContain(COPY.gauge.unavailable);
    expect(missing).not.toBe(failed);
  });

  it('state 说 available 但 close 解析不出 ⇒ 退回不可用，不画 NaN 指针', () => {
    const view = vixGaugeView(idx({ close: null }));
    expect(view.pointerAngle).toBeNull();
    expect(view.degradedText).not.toBeNull();
  });
});

describe('indexReadoutView —— VVIX 侧（无表盘，只有数值与 asOf）', () => {
  it('齐备 ⇒ 两位小数 + 自己的 asOf', () => {
    const view = indexReadoutView(idx({ close: '91.6400' }));
    expect(view.valueText).toBe('91.64');
    expect(view.freshness.tier).toBe('CURRENT');
  });

  it('缺失 ⇒ 值 null + 显式不可用句（禁 0）', () => {
    const view = indexReadoutView(idx({ state: 'missing', close: null, asOf: null }));
    expect(view.valueText).toBeNull();
    expect(view.degradedText).toContain(COPY.gauge.unavailable);
  });
});

// ═══════════ ③ 比值展示决策四态（FR-016） ═══════════

describe('ratioView —— 同基准 / 基准不一致 / 缺一侧 / 读故障', () => {
  it('同基准 ⇒ 出数值 + 共同基准日 + 正常带读法', () => {
    const view = ratioView(ratio({ value: '4.4373', basisDate: '2026-08-01' }));
    expect(view.state).toBe('available');
    expect(view.valueText).toBe('4.44');
    expect(view.basisText).toContain('2026-08-01');
    expect(view.noteText).toBe(COPY.ratio.normalBand);
  });

  it('基准不一致 ⇒ **不计算**，显式标注（禁拿两个不同日的数硬除）', () => {
    const view = ratioView(ratio({ state: 'basis_mismatch', value: null, basisDate: null }));
    expect(view.valueText).toBeNull();
    expect(view.noteText).toBe(COPY.ratio.basisMismatch);
    expect(view.basisText).toBeNull();
  });

  it('缺一侧 ⇒ 显式不可用，MUST NOT 拿单侧推算', () => {
    const view = ratioView(ratio({ state: 'missing', value: null, basisDate: null }));
    expect(view.valueText).toBeNull();
    expect(view.noteText).toBe(COPY.ratio.missing);
  });

  it('跨 ctx 读故障 ⇒ 与「缺一侧」蓄意分开成句', () => {
    const view = ratioView(ratio({ state: 'read_failed', value: null, basisDate: null }));
    expect(view.valueText).toBeNull();
    expect(view.noteText).toBe(COPY.ratio.readFailed);
    expect(view.noteText).not.toBe(COPY.ratio.missing);
  });

  it('四态里只有 available 出数值（三态零值面，无一处回落 0）', () => {
    const degraded = (['basis_mismatch', 'missing', 'read_failed'] as const).map(
      (state) => ratioView(ratio({ state, value: '4.4', basisDate: TODAY })).valueText,
    );
    expect(degraded).toEqual([null, null, null]);
  });
});

// ═══════════ ④ IVP 行态分类（FR-018 / FR-036） ═══════════

describe('thermometerRowView —— 阈值档三分，边界 70 / 90 各归属唯一', () => {
  it('69.99 未越 / 70 已越高档 / 89.99 仍高档 / 90 已越极高档', () => {
    const alertAt = (pct: string) =>
      thermometerRowView(row({ iv: iv({ ivPercentile: pct }) })).iv.alert;
    expect(alertAt('69.99')).toBe('not_crossed');
    expect(alertAt('70')).toBe('crossed_high');
    expect(alertAt('89.99')).toBe('crossed_high');
    expect(alertAt('90')).toBe('crossed_extreme');
  });

  it('🚨「分位不可算」行保留在列表内，但 MUST NOT 出徽标、MUST NOT 画位置标记', () => {
    const view = thermometerRowView(
      row({ iv: iv({ state: 'percentile_unavailable', ivPercentile: null }) }),
    );
    expect(view.iv.alert).toBeNull();
    expect(view.iv.showMarker).toBe(false);
    expect(view.iv.ivPercentile).toBeNull();
    expect(view.iv.degradedText).not.toBeNull();
  });

  it('excluded 行带标记与原因（045 语义：锚 = 采集意愿、excluded = 交易意愿）', () => {
    const on = thermometerRowView(row({ excluded: true, excludeReason: '并购整合期' }));
    expect(on.excluded).toBe(true);
    expect(on.excludeReasonText).toContain('并购整合期');
    expect(thermometerRowView(row()).excludeReasonText).toBeNull();
  });

  it('展示码由 canonical ticker 派生（解析不出时退回原串，不丢信息）', () => {
    expect(thermometerRowView(row({ ticker: 'us:AAPL' })).code).toBe('AAPL');
    expect(thermometerRowView(row({ ticker: 'AAPL' })).code).toBe('AAPL');
  });
});

// ═══════════ ⑤ 零锚：列表空态，表盘照常（FR-018 / FR-027 / state_branch #22） ═══════════

describe('thermometerView —— 列表与表盘是两条独立的线', () => {
  it('零锚 ⇒ 列表空态，但表盘该怎么渲染还怎么渲染', () => {
    const view = thermometerView(payload({ underlyings: [], total: 0 }));
    expect(view.list).toBe('empty');
    expect(view.rows).toEqual([]);
    expect(view.gauge.pointerAngle).not.toBeNull();
    expect(view.gauge.tier).toBe('elevated');
  });

  it('有锚 ⇒ 列表常态，逐行成视图', () => {
    const view = thermometerView(payload({ underlyings: [row(), row({ ticker: 'us:MSFT' })] }));
    expect(view.list).toBe('ready');
    expect(view.rows.map((r) => r.code)).toEqual(['AAPL', 'MSFT']);
  });

  it('表盘不可得 ⇒ 列表照常（反向也独立）', () => {
    const view = thermometerView(
      payload({ vix: idx({ state: 'missing', close: null, asOf: null }) }),
    );
    expect(view.gauge.pointerAngle).toBeNull();
    expect(view.list).toBe('ready');
  });
});

// ═══════════ ⑥ 分段条段宽与 FR-036 边界同源（沿用 T021 常量，不另立一套） ═══════════

describe('🚨 FR-036 —— P7 列表复用 T021 的分段条常量', () => {
  it('边界就是 25 / 70 / 90', () => {
    expect(IVP_TIER_BOUNDARIES).toEqual([25, 70, 90]);
  });

  it('段宽 25 / 45 / 20 / 10 且合计 100（由边界派生，不是手抄）', () => {
    expect(IVP_SEGMENTS.map((s) => s.widthPct)).toEqual([25, 45, 20, 10]);
    expect(IVP_SEGMENTS.reduce((a, s) => a + s.widthPct, 0)).toBe(100);
  });

  it('刻度标签与段界同源（mockup 那组 0/50/90/100 是错的，别抄回来）', () => {
    const derived = IVP_SEGMENTS.slice(0, -1).map((_, i) =>
      IVP_SEGMENTS.slice(0, i + 1).reduce((a, s) => a + s.widthPct, 0),
    );
    expect(derived).toEqual([...IVP_TIER_BOUNDARIES]);
  });
});

// ═══════════ ⑦ 机械防线：FR-015 📌 零 regime / FR-035 零 iv30d ═══════════
//
// ⚠️ 断言面刻意**不是源码文本 grep**：Small 档禁磁盘 I/O（testing.md 分类学），且
//    「regime」「IV30d」字样**合法地**出现在被测模块与本文件的警示注释里 —— 文本断言必假红，
//    还会诱人删警示注释来「修绿」。改成**值面**断言（体例同 T021 / T012）。

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

describe('🚨 FR-015 📌 —— P7 不呈现 regime 读数', () => {
  const strings = collectStrings(COPY);

  it('温度计文案子树非空（防「扫了个空对象所以全绿」的假阳性）', () => {
    expect(strings.length).toBeGreaterThan(15);
  });

  it('文案零命中 regime / 状态 N / 状态 X 一类离散档位措辞', () => {
    expect(strings.filter((s) => /regime/i.test(s))).toEqual([]);
  });

  it('视图产出键面穷举 —— 塞不进一个 regime 字段', () => {
    expect(Object.keys(thermometerView(payload())).sort()).toEqual([
      'gauge',
      'list',
      'ratio',
      'rows',
      'vvix',
    ]);
  });
});

describe('🚨 FR-035 —— 一律「富途标的聚合 IV」，禁写 IV30d', () => {
  const strings = collectStrings(COPY);

  it('文案零命中 iv30d / 30d / 30 天 / ATM 等口径措辞', () => {
    const banned = /iv\s*[-_]?\s*30\s*d|30\s*d\b|30\s*天|atm/i;
    expect(strings.filter((s) => banned.test(s))).toEqual([]);
  });

  it('消费的 DTO 字段名里没有 iv30d 形态', () => {
    const consumed = [...Object.keys(row()), ...Object.keys(iv())];
    expect(consumed.filter((k) => /30\s*d/i.test(k))).toEqual([]);
  });

  it('IVP 列表题头写的是「富途标的聚合 IV」这一句', () => {
    expect(COPY.list.title).toContain('富途标的聚合 IV');
  });
});
