import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { QUALITY_CEILING_SPOT_RATIO, resolveCeilingAxis } from './leg-recall.rules';
import {
  MONEYNESS_PAD_RATIO,
  resolveDeltaSurfaceWindow,
  type DeltaFaceRow,
  type DeltaSurfaceInput,
} from './leg-delta-surface.rules';

const D = (v: string) => new Prisma.Decimal(v);
const E1 = new Date('2026-10-16T00:00:00Z');
const E2 = new Date('2027-01-15T00:00:00Z');
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * 夹具面: 昨日 spot = 100, 两个到期日, |Δ| 随 K 升单调升 (put 卖方视角取绝对值)。
 * 带 [0.10, 0.35] 下: E1 落带 K = {85, 90, 95}, E2 落带 K = {80, 85, 90} —— 远月带更靠下,
 * 两区间并起来就是梯形 (K=95 只在 E1 落带, K=80 只在 E2 落带, K=100 两处都不落)。
 */
const face = (over: Partial<Record<string, string | null>> = {}): DeltaFaceRow[] => {
  const rows: Array<[string, Date, string | null]> = [
    ['80', E1, '0.05'],
    ['85', E1, '0.10'],
    ['90', E1, '0.20'],
    ['95', E1, '0.35'],
    ['100', E1, '0.50'],
    ['80', E2, '0.15'],
    ['85', E2, '0.22'],
    ['90', E2, '0.30'],
    ['95', E2, '0.40'],
    ['100', E2, '0.52'],
  ];
  return rows.map(([strike, expiryDate, delta]) => {
    const key = `${strike}|${iso(expiryDate)}`;
    const v = key in over ? over[key] : delta;
    return { strike: D(strike), expiryDate, delta: v === null ? null : D(v as string) };
  });
};

const input = (over: Partial<DeltaSurfaceInput> = {}): DeltaSurfaceInput => ({
  faceRows: face(),
  previousSpot: D('100'),
  spot: D('100'),
  band: { lower: D('0.10'), upper: D('0.35') },
  pad: MONEYNESS_PAD_RATIO,
  w: null,
  ...over,
});

const ksOf = (outcome: ReturnType<typeof resolveDeltaSurfaceWindow>): string[] => {
  if (outcome.kind !== 'window') throw new Error(`expected window, got ${outcome.kind}`);
  return outcome.windowKs.map((k) => k.toString());
};

describe('leg-delta-surface.rules — K-梯形窗 (068 FR-002 / FR-003 / FR-004)', () => {
  it('① 任一到期日预测落带即进窗: K=95 仅 E1 落带、K=80 仅 E2 落带, 两者都进; K=100 两处不落不进', () => {
    const outcome = resolveDeltaSurfaceWindow(input());
    const ks = ksOf(outcome);
    expect(ks).toContain('95');
    expect(ks).toContain('80');
    expect(ks).not.toContain('100');
  });

  it('② 进窗 K 附段内全部到期日 (阶梯不断链): expiries 含 E1+E2, K=95 在 E2 的预测为带外但仍附带', () => {
    const outcome = resolveDeltaSurfaceWindow(input());
    if (outcome.kind !== 'window') throw new Error('expected window');
    expect(outcome.expiries.map(iso)).toEqual([iso(E1), iso(E2)]);
    expect(outcome.bandPrediction.get(`95|${iso(E1)}`)).toBe(true);
    expect(outcome.bandPrediction.get(`95|${iso(E2)}`)).toBe(false);
  });

  it('③ 收租帽经 axis 单点取交: spot > W 域收紧, 帽上全部 K 被剔 (帽值由常量派生不手抄)', () => {
    const w = D('85');
    const cap = resolveCeilingAxis(D('100'), w).times(QUALITY_CEILING_SPOT_RATIO.plus(1)); // 87.55
    const ks = ksOf(resolveDeltaSurfaceWindow(input({ w })));
    for (const k of ks) expect(D(k).lessThanOrEqualTo(cap)).toBe(true);
    expect(ks).toContain('85');
    expect(ks).not.toContain('90');
    expect(ks).not.toContain('95');
  });

  it('④ 建仓视角无帽 (w = null): 帽上 K 保留', () => {
    const ks = ksOf(resolveDeltaSurfaceWindow(input({ w: null })));
    expect(ks).toContain('90');
    expect(ks).toContain('95');
  });

  it('⑤ 部分缺失: 缺失 (K,expiry) 不参与包络且不整体失败 —— E1@85 缺 Δ 后 85 仍经 E2 进窗, E1 预测转带外', () => {
    const outcome = resolveDeltaSurfaceWindow(
      input({ faceRows: face({ [`85|${iso(E1)}`]: null }) }),
    );
    if (outcome.kind !== 'window') throw new Error('expected window');
    const ks = outcome.windowKs.map((k) => k.toString());
    expect(ks).toContain('85');
    // E1 落带集缩到 {90, 95} ⇒ 包络下沿抬到 90×(1−pad) = 88.2 > 85 ⇒ E1 对 85 预测带外
    expect(outcome.bandPrediction.get(`85|${iso(E1)}`)).toBe(false);
    expect(outcome.bandPrediction.get(`85|${iso(E2)}`)).toBe(true);
  });

  it('⑥ 整面零 Δ 读数 ⇒ 显式 bootstrap 信号 (非异常)', () => {
    const allNull = Object.fromEntries(
      face().map((r) => [`${r.strike.toString()}|${iso(r.expiryDate)}`, null]),
    );
    const outcome = resolveDeltaSurfaceWindow(input({ faceRows: face(allNull) }));
    expect(outcome.kind).toBe('bootstrap');
  });

  it('⑦ DTE 重叠区: 同一面按两视角带各算一次互不影响 (纯函数, 两带产出不同窗)', () => {
    const rent = ksOf(
      resolveDeltaSurfaceWindow(input({ band: { lower: D('0.05'), upper: D('0.35') } })),
    );
    const build = ksOf(
      resolveDeltaSurfaceWindow(input({ band: { lower: D('0.20'), upper: D('0.45') } })),
    );
    // 收租带下探 0.05 ⇒ 80 进 (E1@80=0.05 落带); 建仓带下沿 0.20 ⇒ 包络下沿 88.2, 80/85 不进
    expect(rent).toContain('80');
    expect(build).not.toContain('80');
    expect(build).toContain('95');
    expect(rent).not.toEqual(build);
  });
});
