/**
 * Vendor 限频器 (015 T005, US5 / FR-S09; 滚动窗形态为 2026-08-09 修复追加)。
 *
 * 两种形态, 按 vendor 上游闸的**真实形状**选, **不做等价换算**:
 *
 * | 形态 | 声明 | 语义 | 用在 |
 * | --- | --- | --- | --- |
 * | 双窗令牌桶 | `{ perSec, perMin }` | 秒 + 分两个连续补充桶; 冷启动允许 capacity 大小突发 | 上游本就是「秒限 + 分限」(理杏仁官方值), 或无 SLA 源的保守自定值 |
 * | 滚动窗 | `{ maxCalls, windowMs }` | 任意 `windowMs` 滚动窗内不超过 `maxCalls` 次; **零突发容忍** | 上游是硬滚动窗 + 429 (`services/futu-shim/src/futu_shim/ratelimit.py` 的 `LIMITS`) |
 *
 * 🚨 **两者不可互相换算 —— 这就是本文件有两种形态的全部理由。** 把「10 次 / 30 秒」写成
 * 均值等价的 `{perSec:1, perMin:20}` 看着对（稳态确实是 10/30 s），但令牌桶**初始装满**,
 * 空闲后首轮会在 30 秒内放出约 30 发, 撞上游硬闸。2026-08-09 prod 实测: 富途链发现每
 * 30 分钟顺延一次、12 只锚永远只采到前 2 只, 根因就是这个换算 (同日 PoC 直打 shim: 第 11
 * 发即 429, `Retry-After: 29`, 第 33 秒恢复 —— 上游确是 30 秒滚动窗)。
 * ⇒ **上游是滚动窗就声明滚动窗**, 让两侧算法同构; 换算一次就再也说不清客户端到底放行多少。
 *
 * 桶数学与窗口数学均为**纯函数** (单测无需真时钟); 有状态的串行入队在
 * {@link VendorRateLimiter} (注入 now/sleep 供测)。
 */

/** 秒/分窗各自的令牌数 + 上次补充时刻 (ms epoch)。 */
export interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

/** 令牌桶窗口配置: 容量 (该窗口最大请求数) + 窗口跨度 (ms)。 */
export interface WindowSpec {
  capacity: number;
  windowMs: number;
}

/** 滚动窗配置: 任意 `windowMs` 跨度内最多 `maxCalls` 次。 */
export interface SlidingWindowSpec {
  maxCalls: number;
  windowMs: number;
}

/** 双窗令牌桶限额 (秒 + 分)。 */
export interface DualWindowLimit {
  perSec: number;
  perMin: number;
}

/**
 * Vendor 限额声明 —— 判别式联合, 由字段形状区分, 无需 tag。
 *
 * 🚨 新增 vendor 时**先看上游文档写的是哪种**: 「每 N 秒内最多 M 次」= 滚动窗;
 * 「每秒 X 且每分 Y」= 双窗。猜错不会报错, 只会在空闲后的首轮静默超发。
 */
export type RateLimit = DualWindowLimit | SlidingWindowSpec;

/** 判别式: 是否滚动窗形态。 */
export function isSlidingWindowLimit(limit: RateLimit): limit is SlidingWindowSpec {
  return 'maxCalls' in limit;
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

/**
 * 纯函数: 剔除已滑出窗口的放行时刻。入参须**升序** (调用方只往尾部追加, 天然成立)。
 *
 * 判据是 `t > nowMs - windowMs` 即**严格大于**: 恰好落在窗口边界上的那一发, 上游按
 * 「最近 windowMs 内」计数时通常已不计入 —— 取 `>=` 会让客户端比上游更严一发, 长期
 * 白丢吞吐。边界那 1ms 的误差由 {@link VendorRateLimiter} 之外的 429 + `Retry-After`
 * 兜底 (客户端是第一道软闸, 硬闸永远在上游)。
 *
 * 复杂度 O(n), n = 窗口内放行数 (个位到百量级)。
 */
export function pruneSlidingWindow(
  hits: readonly number[],
  spec: SlidingWindowSpec,
  nowMs: number,
): number[] {
  const cutoff = nowMs - spec.windowMs;
  const idx = hits.findIndex((t) => t > cutoff);
  return idx === -1 ? [] : hits.slice(idx);
}

/**
 * 纯函数: 滚动窗已满时, 距**最早一次存活放行**滑出窗口所需等待 (ms); 未满 → 0。
 * 入参须为 {@link pruneSlidingWindow} 的产物 (已剔除滑出者)。
 *
 * 向上取整避免亚毫秒忙等。复杂度 O(1)。
 */
export function slidingWindowWaitMs(
  prunedHits: readonly number[],
  spec: SlidingWindowSpec,
  nowMs: number,
): number {
  if (prunedHits.length < spec.maxCalls) return 0;
  // prune 保证 prunedHits[0] > nowMs - windowMs ⇒ 本式恒为正。
  return Math.ceil(prunedHits[0] + spec.windowMs - nowMs);
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;

/**
 * 单形态的限频算法: 问「现在还要等多久」+「放行了, 记一笔」。有状态, 由
 * {@link VendorRateLimiter} 串行调用, 故实现内无需自己处理并发。
 */
interface RateGate {
  waitMs(nowMs: number): number;
  commit(nowMs: number): void;
}

/** 双窗 (秒 + 分) 连续补充令牌桶 —— 允许 capacity 大小的冷启动突发。 */
class DualWindowGate implements RateGate {
  private sec: BucketState;
  private min: BucketState;
  private readonly secSpec: WindowSpec;
  private readonly minSpec: WindowSpec;

  constructor(limit: DualWindowLimit, startMs: number) {
    this.secSpec = { capacity: limit.perSec, windowMs: SECOND_MS };
    this.minSpec = { capacity: limit.perMin, windowMs: MINUTE_MS };
    this.sec = { tokens: limit.perSec, lastRefillMs: startMs };
    this.min = { tokens: limit.perMin, lastRefillMs: startMs };
  }

  waitMs(nowMs: number): number {
    this.sec = refillBucket(this.sec, this.secSpec, nowMs);
    this.min = refillBucket(this.min, this.minSpec, nowMs);
    return Math.max(bucketWaitMs(this.sec, this.secSpec), bucketWaitMs(this.min, this.minSpec));
  }

  commit(_nowMs: number): void {
    this.sec = { tokens: this.sec.tokens - 1, lastRefillMs: this.sec.lastRefillMs };
    this.min = { tokens: this.min.tokens - 1, lastRefillMs: this.min.lastRefillMs };
  }
}

/**
 * 滚动窗 —— **零突发容忍**, 与上游 (`ratelimit.py` 的 `deque` 闸) 同算法。
 *
 * 状态是「窗口内放行时刻的升序表」, 上限 `maxCalls` 条 ⇒ 内存 O(maxCalls), 与运行时长无关。
 */
class SlidingWindowGate implements RateGate {
  private hits: number[] = [];

  constructor(private readonly spec: SlidingWindowSpec) {}

  waitMs(nowMs: number): number {
    this.hits = pruneSlidingWindow(this.hits, this.spec, nowMs);
    return slidingWindowWaitMs(this.hits, this.spec, nowMs);
  }

  commit(nowMs: number): void {
    this.hits.push(nowMs);
  }
}

/**
 * Vendor 限频器: 超限**排队 await**, **不向 caller 抛 429** (plan §R3 / spec state_branch
 * 「vendor constraint enforce」) —— 把限频压力收敛在传输层, adapter / UC 无感。
 *
 * `acquire()` 经一条链式 tail 串行化 —— 并发调用 FIFO 排队, 避免多个并发请求同时读到
 * 同一令牌 / 同一个窗口名额的竞态。
 *
 * 注入 `now` / `sleep` 仅为单测可控虚拟时钟; 生产用 Date.now + setTimeout。
 */
export class VendorRateLimiter {
  private readonly gate: RateGate;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    limit: RateLimit,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.gate = isSlidingWindowLimit(limit)
      ? new SlidingWindowGate(limit)
      : new DualWindowGate(limit, now());
  }

  /** 获取一个放行名额 —— 满足限额才 resolve, 否则内部 sleep 排队 (不抛)。 */
  acquire(): Promise<void> {
    const next = this.tail.then(() => this.acquireOne());
    // tail 吞错以免单次失败阻塞后续 (acquireOne 本身不抛)。
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async acquireOne(): Promise<void> {
    for (;;) {
      const nowMs = this.now();
      const wait = this.gate.waitMs(nowMs);
      if (wait === 0) {
        this.gate.commit(nowMs);
        return;
      }
      await this.sleep(wait);
    }
  }
}
