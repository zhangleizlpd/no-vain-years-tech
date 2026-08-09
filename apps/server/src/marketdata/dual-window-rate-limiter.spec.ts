import { describe, expect, it } from 'vitest';
import {
  DualWindowRateLimiter,
  bucketWaitMs,
  refillBucket,
  type BucketState,
  type WindowSpec,
} from './dual-window-rate-limiter.js';

/** 可控虚拟时钟: sleep 推进时间, 让限频逻辑无需真等待即可断言。 */
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

describe('refillBucket (纯函数)', () => {
  const spec: WindowSpec = { capacity: 10, windowMs: 1_000 };

  it('按 elapsed 比例连续补充, 不超过 capacity', () => {
    const s: BucketState = { tokens: 0, lastRefillMs: 0 };
    expect(refillBucket(s, spec, 500).tokens).toBeCloseTo(5); // 半窗 → 半容量
    expect(refillBucket(s, spec, 2_000).tokens).toBe(10); // 超窗 → 封顶
  });

  it('时钟未前进原样返回 (幂等)', () => {
    const s: BucketState = { tokens: 3, lastRefillMs: 100 };
    expect(refillBucket(s, spec, 100)).toBe(s);
    expect(refillBucket(s, spec, 50)).toBe(s);
  });
});

describe('bucketWaitMs (纯函数)', () => {
  const spec: WindowSpec = { capacity: 4, windowMs: 1_000 };

  it('有 ≥1 令牌 → 0 等待', () => {
    expect(bucketWaitMs({ tokens: 1, lastRefillMs: 0 }, spec)).toBe(0);
    expect(bucketWaitMs({ tokens: 2.5, lastRefillMs: 0 }, spec)).toBe(0);
  });

  it('空桶 → 补满 1 令牌所需时间 (向上取整)', () => {
    // capacity 4 / 1000ms → 补 1 令牌需 250ms
    expect(bucketWaitMs({ tokens: 0, lastRefillMs: 0 }, spec)).toBe(250);
    expect(bucketWaitMs({ tokens: 0.5, lastRefillMs: 0 }, spec)).toBe(125);
  });
});

describe('DualWindowRateLimiter', () => {
  it('冷启动允许 capacity 大小突发, 超 perSec 后排队节流 (不抛 429)', async () => {
    const clock = makeClock(0);
    const limiter = new DualWindowRateLimiter({ perSec: 3, perMin: 1_000 }, clock.now, clock.sleep);

    // 6 次获取: 前 3 个秒桶满立即通过, 后 3 个排队 sleep。
    for (let i = 0; i < 6; i++) await limiter.acquire();

    expect(clock.sleeps.length).toBe(3); // 仅超额的 3 个排队
    // 每个排队等待 ≈ 1/3 秒窗 (333ms), 把额外 3 个匀速摊到 1s 窗口内。
    for (const w of clock.sleeps) expect(w).toBeGreaterThanOrEqual(330);
    expect(clock.t).toBeGreaterThanOrEqual(990); // 总耗时落在秒窗量级, 非瞬时穿透
  });

  it('超 perMin 排队到分钟窗口 (秒窗宽松时分窗仍兜住)', async () => {
    const clock = makeClock(0);
    const limiter = new DualWindowRateLimiter({ perSec: 100, perMin: 3 }, clock.now, clock.sleep);

    for (let i = 0; i < 5; i++) await limiter.acquire();

    expect(clock.sleeps.length).toBe(2); // 前 3 个穿透, 后 2 个被分窗拦
    // 分窗补 1 令牌需 1/3 分钟 = 20s 量级 → 证明分窗生效而非秒窗。
    for (const w of clock.sleeps) expect(w).toBeGreaterThanOrEqual(19_000);
  });

  it('并发 acquire FIFO 串行, 不被并发击穿 (突发恰为 capacity)', async () => {
    const clock = makeClock(0);
    const limiter = new DualWindowRateLimiter({ perSec: 2, perMin: 1_000 }, clock.now, clock.sleep);

    // 同时发起 4 个 (不逐个 await) → 串行队列保证仅前 2 个免等。
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire(), limiter.acquire()]);

    expect(clock.sleeps.length).toBe(2); // 4 - capacity(2) = 2 个排队
  });
});
