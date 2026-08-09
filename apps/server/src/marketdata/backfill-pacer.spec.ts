import { describe, expect, it } from 'vitest';
import { BackfillPacer, baseIntervalMs, pacerWaitMs } from './backfill-pacer.js';

/** 可控虚拟时钟: sleep 推进时间, 让节流逻辑无需真等待即可断言 (镜像 dual-window-rate-limiter.spec)。 */
function makeClock(start = 0) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    get t() {
      return t;
    },
  };
}

/** 确定化随机源: 循环给定序列 (替代 Math.random, 让 jitter 可复现)。 */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('baseIntervalMs (纯函数)', () => {
  it('600/min → 100ms 基础间隔', () => {
    expect(baseIntervalMs(600)).toBe(100);
  });

  it('非整除向上取整 (不放行超目标)', () => {
    expect(baseIntervalMs(700)).toBe(Math.ceil(60_000 / 700)); // 86ms (>85.7 → 保守偏慢)
  });

  it('targetPerMin ≤ 0 → 0 (关节流)', () => {
    expect(baseIntervalMs(0)).toBe(0);
    expect(baseIntervalMs(-10)).toBe(0);
  });
});

describe('pacerWaitMs (纯函数)', () => {
  it('elapsed ≥ required → 0 (无需等待)', () => {
    expect(pacerWaitMs(0, 200, 100)).toBe(0);
    expect(pacerWaitMs(0, 100, 100)).toBe(0);
  });

  it('elapsed < required → 补齐差值', () => {
    expect(pacerWaitMs(0, 30, 100)).toBe(70);
    expect(pacerWaitMs(1_000, 1_040, 120)).toBe(80);
  });
});

describe('BackfillPacer', () => {
  it('把有效速率节流到 ~600/min 目标内 (N 次 pace 总耗时 ≥ (N-1)×base)', async () => {
    const clock = makeClock(0);
    // jitter=0 隔离基础节流 (速率精确钳到 base=100ms)。
    const pacer = new BackfillPacer(
      { targetPerMin: 600, jitterMs: 0 },
      clock.now,
      clock.sleep,
      () => 0,
    );
    const N = 10;
    for (let i = 0; i < N; i++) await pacer.pace();

    // 首次免等, 其余 9 次各补到 100ms 间隔 → 总耗时 ≥ 900ms (平均间隔 ≥ base)。
    expect(clock.t).toBeGreaterThanOrEqual((N - 1) * 100);
    // 稳态速率 = 放行间隔数 / 耗时分钟 (N 次调用张成 N-1 个间隔, 端点不重复计) ≤ 600/min。
    const sustainedPerMin = (N - 1) / (clock.t / 60_000);
    expect(sustainedPerMin).toBeLessThanOrEqual(600 + 1e-6);
  });

  it('jitter 把调用时刻打散 (非等间隔) 且仍恒 ≥ base (只增不减)', async () => {
    const clock = makeClock(0);
    // 不同 jitter → 每次 required 间隔不同 → sleep 时长不同 (打散)。
    const pacer = new BackfillPacer(
      { targetPerMin: 600, jitterMs: 40 },
      clock.now,
      clock.sleep,
      seq([0.0, 0.25, 0.5, 0.75, 0.99]), // → jitter = floor(r×41) = 0,10,20,30,40
    );
    for (let i = 0; i < 6; i++) await pacer.pace();

    // 至少两种不同 sleep 时长 = jitter 确实打散 (非固定等间隔 → 无机器人特征)。
    expect(new Set(clock.sleeps).size).toBeGreaterThan(1);
    // 每个 sleep 恒 ≥ base(100): jitter 只加不减 → 有效速率恒 ≤ 目标 (不会短暂超速)。
    for (const s of clock.sleeps) expect(s).toBeGreaterThanOrEqual(100);
  });

  it('enabled=false → pace() no-op (零节流零 sleep, 护既有直调 IT)', async () => {
    const clock = makeClock(0);
    const pacer = new BackfillPacer(
      { targetPerMin: 600, jitterMs: 40, enabled: false },
      clock.now,
      clock.sleep,
      seq([0.9, 0.9, 0.9]),
    );
    for (let i = 0; i < 5; i++) await pacer.pace();

    expect(clock.sleeps.length).toBe(0); // 从不 sleep
    expect(clock.t).toBe(0); // 不推进注入时钟
  });

  it('disabled() 静态工厂 = 关节流 pacer', async () => {
    const pacer = BackfillPacer.disabled();
    // 无注入时钟: 仅断言多次 pace 不抛 / 不真等待 (enabled=false 早返)。
    await expect(Promise.all([pacer.pace(), pacer.pace(), pacer.pace()])).resolves.toBeDefined();
  });
});
