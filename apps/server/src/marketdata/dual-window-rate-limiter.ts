/**
 * 双窗令牌桶限频器 (015 T005, US5 / FR-S09)。
 *
 * 多数外部行情源同时约束**秒级**与**分钟级**请求数 (理杏仁 perSec=36 / perMin=1000)。
 * 任一窗口超限即**排队 await**, **不向 caller 抛 429** (plan §R3 / spec state_branch
 * 「vendor constraint enforce」) —— 把限频压力收敛在传输层, adapter / UC 无感。
 *
 * 设计 = 两个独立连续补充令牌桶 (秒桶 + 分桶), 仅当两桶均有 ≥1 令牌才放行;
 * 否则取两窗所需等待的较大者 sleep 后重试。cockatiel **无原生 rate-limit** (仅
 * Bulkhead 并发控制), D4 gate 落「自写纯函数令牌桶」(plan §D4)。
 *
 * 桶数学为**纯函数** (refillBucket / bucketWaitMs), 单测无需真时钟; 有状态串行
 * 入队在 DualWindowRateLimiter (注入 now/sleep 供测)。
 */

/** 秒/分窗各自的令牌数 + 上次补充时刻 (ms epoch)。 */
export interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

/** 窗口配置: 容量 (该窗口最大请求数) + 窗口跨度 (ms)。 */
export interface WindowSpec {
  capacity: number;
  windowMs: number;
}

export interface RateLimit {
  perSec: number;
  perMin: number;
}

/**
 * 纯函数: 按 `nowMs` 连续补充令牌桶 (补充速率 = capacity / windowMs 每 ms),
 * 上限 capacity。`nowMs <= lastRefillMs` (时钟未前进) 原样返回。
 * 复杂度 O(1)。
 */
export function refillBucket(state: BucketState, spec: WindowSpec, nowMs: number): BucketState {
  if (nowMs <= state.lastRefillMs) return state;
  const refilled = ((nowMs - state.lastRefillMs) / spec.windowMs) * spec.capacity;
  return {
    tokens: Math.min(spec.capacity, state.tokens + refilled),
    lastRefillMs: nowMs,
  };
}

/**
 * 纯函数: 该桶补满到 ≥1 令牌所需等待 (ms); 已有 ≥1 → 0。
 * 向上取整避免亚毫秒忙等。复杂度 O(1)。
 */
export function bucketWaitMs(state: BucketState, spec: WindowSpec): number {
  if (state.tokens >= 1) return 0;
  return Math.ceil(((1 - state.tokens) / spec.capacity) * spec.windowMs);
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;

/**
 * 双窗 (秒+分) 串行令牌桶限频器。
 *
 * `acquire()` 经一条链式 tail 串行化 —— 并发调用 FIFO 排队, 避免多个并发请求同时
 * 读到同一令牌的竞态 (令初始突发数恰为 capacity 而非被并发击穿)。两桶初始装满 →
 * 冷启动允许 capacity 大小的突发, 之后按窗口速率匀速放行。
 *
 * 注入 `now` / `sleep` 仅为单测可控虚拟时钟; 生产用 Date.now + setTimeout。
 */
export class DualWindowRateLimiter {
  private sec: BucketState;
  private min: BucketState;
  private readonly secSpec: WindowSpec;
  private readonly minSpec: WindowSpec;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    limit: RateLimit,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.secSpec = { capacity: limit.perSec, windowMs: SECOND_MS };
    this.minSpec = { capacity: limit.perMin, windowMs: MINUTE_MS };
    const start = now();
    this.sec = { tokens: limit.perSec, lastRefillMs: start };
    this.min = { tokens: limit.perMin, lastRefillMs: start };
  }

  /** 获取一个令牌 —— 两窗都满足才 resolve, 否则内部 sleep 排队 (不抛)。 */
  acquire(): Promise<void> {
    const next = this.tail.then(() => this.acquireOne());
    // tail 吞错以免单次失败阻塞后续 (acquireOne 本身不抛)。
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async acquireOne(): Promise<void> {
    for (;;) {
      const nowMs = this.now();
      this.sec = refillBucket(this.sec, this.secSpec, nowMs);
      this.min = refillBucket(this.min, this.minSpec, nowMs);
      const wait = Math.max(
        bucketWaitMs(this.sec, this.secSpec),
        bucketWaitMs(this.min, this.minSpec),
      );
      if (wait === 0) {
        this.sec = { tokens: this.sec.tokens - 1, lastRefillMs: this.sec.lastRefillMs };
        this.min = { tokens: this.min.tokens - 1, lastRefillMs: this.min.lastRefillMs };
        return;
      }
      await this.sleep(wait);
    }
  }
}
