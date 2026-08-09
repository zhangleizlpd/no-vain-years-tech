// 035 T006 — normalizeMeter 边界单测（不渲染组件，遵测试分层 vitest=logic）。
import { describe, expect, it } from 'vitest';
import { METER_DB_CEIL, METER_DB_FLOOR, normalizeMeter } from './waveform-normalize';

describe('normalizeMeter (T006 波形归一化)', () => {
  it('满刻度 0 dB → 1', () => {
    expect(normalizeMeter(METER_DB_CEIL)).toBe(1);
  });

  it('静音下限 -60 dB → 0', () => {
    expect(normalizeMeter(METER_DB_FLOOR)).toBe(0);
  });

  it('区间中点 -30 dB → 0.5', () => {
    expect(normalizeMeter(-30)).toBeCloseTo(0.5, 5);
  });

  it('上限以上钳制为 1', () => {
    expect(normalizeMeter(6)).toBe(1);
  });

  it('下限以下钳制为 0', () => {
    expect(normalizeMeter(-120)).toBe(0);
  });

  it('-Infinity（iOS 静音帧）→ 0', () => {
    expect(normalizeMeter(-Infinity)).toBe(0);
  });

  it('NaN → 0（不炸波形）', () => {
    expect(normalizeMeter(NaN)).toBe(0);
  });

  it('输出恒在 [0,1]（采样扫一遍区间）', () => {
    for (let db = -80; db <= 10; db += 1) {
      const v = normalizeMeter(db);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
