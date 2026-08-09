import { describe, expect, it } from 'vitest';
import {
  VendorRateLimiter,
  bucketWaitMs,
  isSlidingWindowLimit,
  pruneSlidingWindow,
  refillBucket,
  slidingWindowWaitMs,
  type BucketState,
  type SlidingWindowSpec,
  type WindowSpec,
} from './vendor-rate-limiter.js';

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
    /** 只推进时钟, **不**记一次 sleep —— 用来构造「限频器之外的时间流逝」(空闲 / 调用间隔)。 */
    advance: (ms: number) => {
      t += ms;
    },
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

describe('isSlidingWindowLimit (判别式)', () => {
  it('按字段形状区分两种声明, 无需 tag', () => {
    expect(isSlidingWindowLimit({ maxCalls: 10, windowMs: 30_000 })).toBe(true);
    expect(isSlidingWindowLimit({ perSec: 1, perMin: 20 })).toBe(false);
  });
});

describe('pruneSlidingWindow (纯函数)', () => {
  const spec: SlidingWindowSpec = { maxCalls: 3, windowMs: 1_000 };

  it('剔除已滑出窗口的时刻, 保留窗口内的', () => {
    expect(pruneSlidingWindow([0, 500, 900], spec, 1_200)).toEqual([500, 900]);
    expect(pruneSlidingWindow([0, 500, 900], spec, 500)).toEqual([0, 500, 900]);
  });

  it('全部滑出 → 空表 (状态不随运行时长增长)', () => {
    expect(pruneSlidingWindow([0, 500, 900], spec, 5_000)).toEqual([]);
    expect(pruneSlidingWindow([], spec, 5_000)).toEqual([]);
  });

  it('边界取严格大于: 恰好落在 cutoff 上的那一发算已滑出', () => {
    // nowMs=1000, windowMs=1000 → cutoff=0; t=0 不再计入, t=1 仍计入。
    expect(pruneSlidingWindow([0, 1], spec, 1_000)).toEqual([1]);
  });
});

describe('slidingWindowWaitMs (纯函数)', () => {
  const spec: SlidingWindowSpec = { maxCalls: 3, windowMs: 1_000 };

  it('窗口未满 → 0 等待', () => {
    expect(slidingWindowWaitMs([], spec, 100)).toBe(0);
    expect(slidingWindowWaitMs([0, 50], spec, 100)).toBe(0);
  });

  it('窗口已满 → 等到最早一发滑出为止', () => {
    // 最早一发在 t=0, 窗 1000ms → t=200 时还需等 800ms。
    expect(slidingWindowWaitMs([0, 50, 100], spec, 200)).toBe(800);
  });
});

describe('VendorRateLimiter — 双窗令牌桶形态', () => {
  it('冷启动允许 capacity 大小突发, 超 perSec 后排队节流 (不抛 429)', async () => {
    const clock = makeClock(0);
    const limiter = new VendorRateLimiter({ perSec: 3, perMin: 1_000 }, clock.now, clock.sleep);

    // 6 次获取: 前 3 个秒桶满立即通过, 后 3 个排队 sleep。
    for (let i = 0; i < 6; i++) await limiter.acquire();

    expect(clock.sleeps.length).toBe(3); // 仅超额的 3 个排队
    // 每个排队等待 ≈ 1/3 秒窗 (333ms), 把额外 3 个匀速摊到 1s 窗口内。
    for (const w of clock.sleeps) expect(w).toBeGreaterThanOrEqual(330);
    expect(clock.t).toBeGreaterThanOrEqual(990); // 总耗时落在秒窗量级, 非瞬时穿透
  });

  it('超 perMin 排队到分钟窗口 (秒窗宽松时分窗仍兜住)', async () => {
    const clock = makeClock(0);
    const limiter = new VendorRateLimiter({ perSec: 100, perMin: 3 }, clock.now, clock.sleep);

    for (let i = 0; i < 5; i++) await limiter.acquire();

    expect(clock.sleeps.length).toBe(2); // 前 3 个穿透, 后 2 个被分窗拦
    // 分窗补 1 令牌需 1/3 分钟 = 20s 量级 → 证明分窗生效而非秒窗。
    for (const w of clock.sleeps) expect(w).toBeGreaterThanOrEqual(19_000);
  });

  it('并发 acquire FIFO 串行, 不被并发击穿 (突发恰为 capacity)', async () => {
    const clock = makeClock(0);
    const limiter = new VendorRateLimiter({ perSec: 2, perMin: 1_000 }, clock.now, clock.sleep);

    // 同时发起 4 个 (不逐个 await) → 串行队列保证仅前 2 个免等。
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire(), limiter.acquire()]);

    expect(clock.sleeps.length).toBe(2); // 4 - capacity(2) = 2 个排队
  });
});

describe('VendorRateLimiter — 滚动窗形态', () => {
  /** 富途 shim 的 `option_chain` 真实档位 (`ratelimit.py` 的 `LIMITS`, 2026-08-09 PoC 实测吻合)。 */
  const OPTION_CHAIN: SlidingWindowSpec = { maxCalls: 10, windowMs: 30_000 };

  it('🚨 零突发容忍: 第 11 发必须等到首发滑出窗口 (2026-08-09 prod bug 的回归闸)', async () => {
    const clock = makeClock(0);
    const limiter = new VendorRateLimiter(OPTION_CHAIN, clock.now, clock.sleep);

    for (let i = 0; i < 10; i++) await limiter.acquire();
    expect(clock.sleeps.length).toBe(0); // 前 10 发不排队 —— 与上游「窗内 10 次」一致
    expect(clock.t).toBe(0);

    await limiter.acquire(); // 第 11 发
    // PoC 实测: 上游正是在第 11 发返 429 + `Retry-After: 29`, 第 33 秒才恢复。
    expect(clock.t).toBe(30_000);
    expect(clock.sleeps).toEqual([30_000]);
  });

  it('窗口滑动而非整块重置: 首发滑出后立刻空出 1 个名额', async () => {
    const clock = makeClock(0);
    const limiter = new VendorRateLimiter({ maxCalls: 2, windowMs: 1_000 }, clock.now, clock.sleep);

    await limiter.acquire(); // t=0
    clock.advance(400); // 调用间隔, 非限频器排队
    await limiter.acquire(); // t=400, 窗内 2 发 → 满
    await limiter.acquire(); // 须等 t=0 那发滑出 ⇒ 到 t=1000, 而非等第二发
    expect(clock.t).toBe(1_000);
  });

  it('状态不随运行时长增长: 长时间空闲后窗口表清空, 下一发立即放行', async () => {
    const clock = makeClock(0);
    const limiter = new VendorRateLimiter(OPTION_CHAIN, clock.now, clock.sleep);

    for (let i = 0; i < 10; i++) await limiter.acquire();
    clock.advance(60_000); // 空闲两个窗口
    const before = clock.sleeps.length;
    await limiter.acquire();
    expect(clock.sleeps.length).toBe(before); // 零排队
  });

  it('🚨 负控制 — 同一均值用双窗声明会超发, 这正是被「均值等价换算」掉的那个 bug', async () => {
    const clock = makeClock(0);
    // {perSec:1, perMin:20} 的稳态确实是 10 发/30 秒, 但桶初始装满 20。
    const limiter = new VendorRateLimiter({ perSec: 1, perMin: 20 }, clock.now, clock.sleep);

    for (let i = 0; i < 20; i++) await limiter.acquire();

    // 20 发在不到 30 秒内全部放出 —— 上游只允许 10 发/30 秒 ⇒ 第 11 发起必吃 429。
    expect(clock.t).toBeLessThan(30_000);
  });
});
