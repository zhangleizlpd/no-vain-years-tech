import { describe, it, expect } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import {
  deriveAdjustedBars,
  type AdjustableBarRow,
  type FactorJumpVersion,
} from './adjusted-bars.rules.js';

// 020 T002 读时换算纯函数 (US1, plan D1/D2; 2026-06-05 模型改判后比值口径): none 行 ×
// per-event 跃变 f_i → forward/backward 派生序列。B(t) = ∏ f_i (exDate_i ≤ t) 缺省 1
// (running product, 首个已存事件前 B=1 约定); forward 再除 B_latest (全版本乘积)。

const dec = (v: string | number) => new Prisma.Decimal(v);

function bar(
  tradeDate: string,
  close: string,
  overrides: Partial<AdjustableBarRow> = {},
): AdjustableBarRow {
  return {
    tradeDate,
    open: dec(close),
    high: dec(close),
    low: dec(close),
    close: dec(close),
    changePct: null,
    prevClose: null,
    volume: null,
    amount: null,
    turnoverRate: null,
    ...overrides,
  };
}

function jump(exDate: string, factorJump: string): FactorJumpVersion {
  return { exDate, factorJump: dec(factorJump) };
}

describe('020 T002 deriveAdjustedBars (读时换算, per-event 跃变累积)', () => {
  it('跨段乘对: backward(t) = none(t) × B(t), B(t) = ∏ f_i (exDate_i ≤ t)', () => {
    const bars = [bar('2026-06-01', '100'), bar('2026-06-03', '100'), bar('2026-06-05', '100')];
    const versions = [jump('2026-06-02', '1.1'), jump('2026-06-04', '1.1')];
    const out = deriveAdjustedBars(bars, versions, 'backward');
    expect(out.map((b) => b.close.toFixed(4))).toEqual(['100.0000', '110.0000', '121.0000']);
  });

  it('首段隐含 1: 首个 exDate 前的 bar B = 1 (FR-A02)', () => {
    const out = deriveAdjustedBars(
      [bar('2026-06-01', '88.5')],
      [jump('2026-06-02', '1.5')],
      'backward',
    );
    expect(out[0].close.toFixed(4)).toBe('88.5000');
  });

  it('零版本标的: forward = backward = none (B_latest 缺省 1)', () => {
    const bars = [bar('2026-06-01', '100.1234')];
    for (const adjust of ['forward', 'backward'] as const) {
      const out = deriveAdjustedBars(bars, [], adjust);
      expect(out[0].close.toFixed(4)).toBe('100.1234');
      expect(out[0].open.toFixed(4)).toBe('100.1234');
    }
  });

  it('forward = backward ÷ B_latest 恒等 (B_latest = 全版本乘积, 不限 bar 窗口)', () => {
    const bars = [bar('2026-06-01', '100'), bar('2026-06-03', '100')];
    // B_latest = 1.1 × 1.25 = 1.375, 含 exDate > 全部 bar 的 06-10 版本 — forward 基准
    // 是标的当前状态。
    const versions = [jump('2026-06-02', '1.1'), jump('2026-06-10', '1.25')];
    const fwd = deriveAdjustedBars(bars, versions, 'forward');
    const bwd = deriveAdjustedBars(bars, versions, 'backward');
    expect(bwd.map((b) => b.close.toFixed(4))).toEqual(['100.0000', '110.0000']);
    expect(fwd.map((b) => b.close.toFixed(4))).toEqual(['72.7273', '80.0000']); // ÷1.375
  });

  it('exDate 当日 prevClose 用前段因子, 与前一根换算 close 一致 (AS-3)', () => {
    const bars = [
      bar('2026-06-01', '100', { prevClose: dec('99') }),
      // 06-02 = exDate: none prevClose = 前日 none close (100); 换算用前段 B = 1。
      bar('2026-06-02', '91', { prevClose: dec('100') }),
      // 06-03 非 exDate: prevClose 同段 B = 1.1。
      bar('2026-06-03', '92', { prevClose: dec('91') }),
    ];
    const versions = [jump('2026-06-02', '1.1')];
    const out = deriveAdjustedBars(bars, versions, 'backward');
    expect(out[0].prevClose?.toFixed(4)).toBe('99.0000'); // 首段 ×1。
    expect(out[1].close.toFixed(4)).toBe('100.1000'); // 91 × 1.1。
    expect(out[1].prevClose?.toFixed(4)).toBe('100.0000'); // exDate 当日 → 前段 B=1 = 前一根换算 close。
    expect(out[0].close.toFixed(4)).toBe(out[1].prevClose?.toFixed(4)); // 与前一根换算 close 一致。
    expect(out[2].prevClose?.toFixed(4)).toBe('100.1000'); // 非 exDate → 同段 ×1.1。
  });

  it('多版本跳段推进: 段内无 bar 的版本仍计入乘积, exDate 当日前段因子取紧邻前版本', () => {
    const bars = [bar('2026-06-01', '100'), bar('2026-06-09', '100', { prevClose: dec('100') })];
    // 06-09 恰为第三版本 exDate; 第二段 (06-05~06-08) 无 bar → prevClose 用 B(前段) = 1.1×1.2。
    const versions = [
      jump('2026-06-02', '1.1'),
      jump('2026-06-05', '1.2'),
      jump('2026-06-09', '1.3'),
    ];
    const out = deriveAdjustedBars(bars, versions, 'backward');
    expect(out[1].close.toFixed(4)).toBe('171.6000'); // 100 × 1.1×1.2×1.3。
    expect(out[1].prevClose?.toFixed(4)).toBe('132.0000'); // 前段 = 1.32 (非 1.1)。
  });

  it('直拷字段零变化: volume/amount/turnoverRate 不乘因子', () => {
    const bars = [
      bar('2026-06-03', '100', {
        volume: dec('123456'),
        amount: dec('9876543.21'),
        turnoverRate: dec('2.3456'),
      }),
    ];
    const out = deriveAdjustedBars(bars, [jump('2026-06-02', '2')], 'backward');
    expect(out[0].close.toFixed(4)).toBe('200.0000');
    expect(out[0].volume?.toString()).toBe('123456');
    expect(out[0].amount?.toString()).toBe('9876543.21');
    expect(out[0].turnoverRate?.toString()).toBe('2.3456');
  });

  it('价格字段全乘 + 4dp 刻度 (Decimal(18,4) 对齐 019 推导)', () => {
    const bars = [
      bar('2026-06-03', '0', {
        open: dec('10.1111'),
        high: dec('10.3333'),
        low: dec('9.9999'),
        close: dec('10.2222'),
        prevClose: dec('10.0001'),
      }),
    ];
    const out = deriveAdjustedBars(bars, [jump('2026-06-01', '1.2345')], 'backward');
    expect(out[0].open.toFixed(4)).toBe(dec('10.1111').mul('1.2345').toFixed(4));
    expect(out[0].high.toFixed(4)).toBe(dec('10.3333').mul('1.2345').toFixed(4));
    expect(out[0].low.toFixed(4)).toBe(dec('9.9999').mul('1.2345').toFixed(4));
    expect(out[0].close.toFixed(4)).toBe(dec('10.2222').mul('1.2345').toFixed(4));
    expect(out[0].prevClose?.toFixed(4)).toBe(dec('10.0001').mul('1.2345').toFixed(4));
    // 刻度断言: 输出恰 4dp (无多余尾数)。
    expect(out[0].close.decimalPlaces()).toBeLessThanOrEqual(4);
  });

  it('prevClose null 防御: 直透 null 不 throw', () => {
    const out = deriveAdjustedBars(
      [bar('2026-06-03', '100', { prevClose: null })],
      [jump('2026-06-01', '1.5')],
      'forward',
    );
    expect(out[0].prevClose).toBeNull();
  });

  it('空输入防御: 空 bars → []; 版本乱序输入 → 内部排序后乘积语义不变', () => {
    expect(deriveAdjustedBars([], [jump('2026-06-01', '1.1')], 'forward')).toEqual([]);
    const out = deriveAdjustedBars(
      [bar('2026-06-06', '100')],
      [jump('2026-06-05', '1.2'), jump('2026-06-01', '1.1')], // 乱序。
      'backward',
    );
    expect(out[0].close.toFixed(4)).toBe('132.0000'); // 1.1 × 1.2。
  });

  it('非法跃变防御 (≤0): 该版本按 1 跳过, 不 throw 不传染 (数据破损隔离)', () => {
    const out = deriveAdjustedBars(
      [bar('2026-06-06', '100')],
      [jump('2026-06-01', '0'), jump('2026-06-05', '1.2')],
      'backward',
    );
    expect(out[0].close.toFixed(4)).toBe('120.0000'); // 0 → 按 1, 仅 1.2 生效。
  });
});
