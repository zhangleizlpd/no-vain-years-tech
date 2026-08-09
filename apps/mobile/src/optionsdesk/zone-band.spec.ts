// 045 T023 — 四区间色带**几何契约**单测（FR-011 / FR-012, plan D12）。
//
// 测的是 `zone-band.rules.ts` 的纯映射（值 → 百分比位置 + 端帽钳制）；渲染 / 视觉走 T025 E2E
// （mono 测试分层：vitest = logic-only，UI 走 Playwright）。文件名沿用 tasks.md T023 verify
// 段点名的 `zone-band.spec.ts`；被测模块拆成 `.rules.ts` 是因为 vitest 环境是 node，
// 不能 import 会拉起 `react-native` 的 `.tsx`（同 MarketBadge / market-badge.rules 体例）。
import { describe, expect, it } from 'vitest';

import {
  BAND_CAP_PCT,
  BAND_INNER_END_PCT,
  BAND_INNER_START_PCT,
  BAND_LEFT_CLAMP_PCT,
  BAND_RIGHT_CLAMP_PCT,
  BAND_SEGMENTS,
  BAND_V_PCT,
  BAND_W_PCT,
  bandPosition,
  spotPosition,
  type ZoneBandAnchor,
} from './zone-band.rules';

// 参照票：V = 100 ⇒ 0.6V = 60 / W = 0.8V = 80 / 1.2V = 120。
const FLOOR = 60;
const W = 80;
const V = 100;
const CEILING = 120;

/** 只取色带几何用得上的字段（组件与规则都按结构子集吃，不依赖整个 AnchorResponse）。 */
function anchor(over: Partial<ZoneBandAnchor> = {}): ZoneBandAnchor {
  return { zoneFloor: '60.00', zoneCeiling: '120.00', lastClose: '90.00', ...over };
}

describe('bandPosition — 内段 [0.6V, 1.2V] 严格等比例（FR-011 几何契约）', () => {
  it('0.6V → 7%（内段左端 = 左端帽右缘）', () => {
    expect(bandPosition(FLOOR, FLOOR, CEILING)).toEqual({ pct: 7, clamped: false });
    expect(BAND_INNER_START_PCT).toBe(7);
  });

  it('W = 0.8V → 35.67%（恒定位置，welds 常量与运行时映射）', () => {
    expect(bandPosition(W, FLOOR, CEILING)).toEqual({ pct: BAND_W_PCT, clamped: false });
    expect(BAND_W_PCT).toBe(35.67);
  });

  it('V → 64.33%（标在真实值轴位置）', () => {
    expect(bandPosition(V, FLOOR, CEILING)).toEqual({ pct: BAND_V_PCT, clamped: false });
    expect(BAND_V_PCT).toBe(64.33);
  });

  it('1.2V → 93%（内段右端 = 右端帽左缘）', () => {
    expect(bandPosition(CEILING, FLOOR, CEILING)).toEqual({ pct: 93, clamped: false });
    expect(BAND_INNER_END_PCT).toBe(93);
  });

  it('带宽以 V 归一化 ⇒ 换一只 V 完全不同的票，W / V 百分比不变', () => {
    // V = 250 ⇒ 0.6V = 150 / W = 200 / 1.2V = 300。
    expect(bandPosition(200, 150, 300)?.pct).toBe(BAND_W_PCT);
    expect(bandPosition(250, 150, 300)?.pct).toBe(BAND_V_PCT);
  });

  it('内段线性：中点 (0.6V+1.2V)/2 落在 7% 与 93% 的中点 50%', () => {
    expect(bandPosition((FLOOR + CEILING) / 2, FLOOR, CEILING)?.pct).toBe(50);
  });
});

describe('端帽内 spot 钳制（越界不越出色带、不当真实比例位）', () => {
  it('spot < 0.6V → 钳到左端帽中点 3.5% 且 clamped=true', () => {
    expect(bandPosition(10, FLOOR, CEILING)).toEqual({ pct: BAND_LEFT_CLAMP_PCT, clamped: true });
    expect(BAND_LEFT_CLAMP_PCT).toBe(3.5);
  });

  it('spot > 1.2V → 钳到右端帽中点 96.5% 且 clamped=true', () => {
    expect(bandPosition(9_999, FLOOR, CEILING)).toEqual({
      pct: BAND_RIGHT_CLAMP_PCT,
      clamped: true,
    });
    expect(BAND_RIGHT_CLAMP_PCT).toBe(96.5);
  });

  it('钳制落点严格落在端帽内（0 < pct < 100，永不越出色带）', () => {
    for (const raw of [-1e6, 0, 1e6]) {
      const p = bandPosition(raw, FLOOR, CEILING);
      expect(p?.clamped).toBe(true);
      const pct = p?.pct ?? Number.NaN; // null 会让两条比较都红，等价于「必须有位置」
      expect(pct).toBeGreaterThan(0);
      expect(pct).toBeLessThan(100);
    }
  });

  it('恰好等于 0.6V / 1.2V 不算钳制（边界闭区间，归内段同一侧）', () => {
    expect(bandPosition(FLOOR, FLOOR, CEILING)?.clamped).toBe(false);
    expect(bandPosition(CEILING, FLOOR, CEILING)?.clamped).toBe(false);
  });
});

describe('退化 / 非法输入 → null（不编造位置）', () => {
  it('ceiling <= floor → null', () => {
    expect(bandPosition(80, 120, 120)).toBeNull();
    expect(bandPosition(80, 120, 60)).toBeNull();
  });

  it('非有限值 → null', () => {
    expect(bandPosition(Number.NaN, FLOOR, CEILING)).toBeNull();
    expect(bandPosition(80, Number.NaN, CEILING)).toBeNull();
    expect(bandPosition(80, FLOOR, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('BAND_SEGMENTS — 5 段矩形', () => {
  it('合计恰好 100%', () => {
    expect(BAND_SEGMENTS.reduce((sum, s) => sum + s.widthPct, 0)).toBe(100);
  });

  it('两端各 7% 端帽，内段三段由 W / V 切分', () => {
    expect(BAND_SEGMENTS.map((s) => s.widthPct)).toEqual([7, 28.67, 28.66, 28.67, 7]);
  });

  it('段序 = server 五区间枚举顺序（深买 → 高估）', () => {
    expect(BAND_SEGMENTS.map((s) => s.zone)).toEqual([
      'deep_buy',
      'buy',
      'thin',
      'expensive',
      'overvalued',
    ]);
    expect(BAND_SEGMENTS[0]?.widthPct).toBe(BAND_CAP_PCT);
    expect(BAND_SEGMENTS[4]?.widthPct).toBe(BAND_CAP_PCT);
  });
});

describe('spotPosition — 吃 server 下发的 Decimal string', () => {
  it('行情可得 → 按 lastClose 定位', () => {
    // 90 落在 [60,120] 的 50% 处 ⇒ 7 + 86*0.5 = 50%。
    expect(spotPosition(anchor())).toEqual({ pct: 50, clamped: false });
  });

  it('lastClose = null（行情不可用）→ null，禁伪造位置', () => {
    expect(spotPosition(anchor({ lastClose: null }))).toBeNull();
  });

  it('lastClose 非数字串 → null', () => {
    expect(spotPosition(anchor({ lastClose: '' }))).toBeNull();
    expect(spotPosition(anchor({ lastClose: 'n/a' }))).toBeNull();
  });

  it('lastClose 越界 → 端帽内钳制，clamped=true 供上层改画空心点', () => {
    expect(spotPosition(anchor({ lastClose: '20.50' }))).toEqual({
      pct: BAND_LEFT_CLAMP_PCT,
      clamped: true,
    });
    expect(spotPosition(anchor({ lastClose: '400.00' }))).toEqual({
      pct: BAND_RIGHT_CLAMP_PCT,
      clamped: true,
    });
  });

  it('zoneFloor / zoneCeiling 非法 → null（不落回默认几何）', () => {
    expect(spotPosition(anchor({ zoneCeiling: 'x' }))).toBeNull();
  });
});
