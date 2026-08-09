import {
  ConsecutiveBreaker,
  ExponentialBackoff,
  circuitBreaker,
  handleType,
  retry,
  wrap,
  type IPolicy,
} from 'cockatiel';
import type { VendorConstraintProfile } from './vendor-constraint-profile.js';
import { VendorRateLimiter } from './vendor-rate-limiter.js';

/**
 * 429 后**采信** `Retry-After` 的上限 (ms)。超过它一律回落固定值 —— 理由见
 * {@link VendorHttpClient.rateLimitWaitMs}。
 */
const RETRY_AFTER_CAP_MS = 60_000;

/** 429 等待的 jitter 比例 —— **只加不减**, 理由见 {@link VendorHttpClient.rateLimitWaitMs}。 */
const RETRY_AFTER_JITTER_RATIO = 0.1;

/**
 * `Retry-After` → ms。RFC 9110 定义两种形态: **整数秒** 与 **HTTP-date**; 429 本身定义在
 * RFC 6585 §4, 原文是 **MAY** 带该头 ⇒ 调用方必须保留兜底值, 不能假设一定有。
 *
 * 两种形态都解: 只解秒的话, 遇到 date 形态会**静默**回落兜底值 —— 那正是本次要修掉的
 * 那一类「不报错、只是等错时长」的塌法。
 *
 * 非法 / 缺失 / 非正数 → `null` (交调用方回落)。**不在此处 clamp 上限**: 上限是策略、归
 * 调用方, 解析器只负责如实翻译 vendor 说了什么。复杂度 O(1)。
 */
export function parseRetryAfterMs(raw: string | null | undefined, nowMs: number): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // delta-seconds: RFC 只允许非负整数。
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1_000;
    return ms > 0 ? ms : null;
  }
  // 🚨 数字形态但不合 delta-seconds 规格 (带符号 / 小数) 必须**在这里**拒掉, 不能落到
  // `Date.parse`: V8 会把 `'-5'` 解成一个真实日期 (2001-05-01), 于是一个非法值变成一个
  // 看似合理的等待时长 —— 又一个「不报错、只是等错时长」的塌法 (单测已钉)。
  if (/^[+-]?[\d.]+$/.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  const ms = at - nowMs;
  return ms > 0 ? ms : null;
}

/**
 * 瞬时 (可重试) vendor 故障: 429 / 5xx / 网络错。被 cockatiel retry + circuitBreaker
 * 捕获并退避重试。4xx (非 429) = 永久错 → `VendorHttpError`, 不重试。
 */
export class TransientVendorError extends Error {
  constructor(
    readonly vendor: string,
    readonly status: number | 'network',
    cause?: unknown,
  ) {
    super(`[${vendor}] transient vendor failure: ${status}`);
    this.name = 'TransientVendorError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** 永久 vendor HTTP 错 (4xx 非 429), 不重试 —— 直抛给 adapter/UC。 */
export class VendorHttpError extends Error {
  constructor(
    readonly vendor: string,
    readonly status: number,
  ) {
    super(`[${vendor}] vendor HTTP ${status}`);
    this.name = 'VendorHttpError';
  }
}

/**
 * fetch 响应的最小面。`text` **可选**是刻意的: 真 `Response` 两个都有, 而仓内既有的假 fetch
 * 只造了 `json` —— 设成必填会把几十个无关单测一起改红。缺 `text` 的假 fetch 走
 * {@link VendorHttpClient.requestText} 时会拿到一条指名道姓的错, 不是静默空串。
 */
type FetchResponseLike = {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
  /**
   * `headers` **可选**同 {@link FetchResponseLike.text} 的先例, 且只收 `get` 这一个方法:
   * 真 `Response.headers` 满足它, 而仓内既有的假 fetch 一个都没造 header —— 设成必填会把
   * 几十个无关单测一起改红。要覆盖 429 的 `Retry-After` 路径, 造 `{ get: () => '29' }` 即可;
   * 不造则如实回落 `transientWaitMs` (与本改动前的行为一致)。
   */
  headers?: { get: (name: string) => string | null };
};

type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export interface VendorHttpClientDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** jitter 源 —— 注入以确定化单测 (镜像 `BackfillPacer` 的 now/sleep/random 范式)。 */
  random?: () => number;
}

export interface VendorRequest {
  url: string;
  method?: string;
  /** adapter 提供的 vendor-specific header (鉴权等), 与 profile.headers 合并; 同名 profile 优先于无意覆盖前者 → 此处请求 header 优先。 */
  headers?: Record<string, string>;
  body?: string;
}

/**
 * 共享 vendor HTTP 传输 (015 T005, US5 / ADR-0047)。
 *
 * 每个外部源**一个实例** (各自持限频器 + 熔断状态, 按 profile 构造)。统一执行
 * Vendor Constraint Profile: ① 注入必需 header; ② 过限频器 (双窗令牌桶 / 滚动窗, 按
 * profile 声明的形状; 超限排队, 不抛 429 给 caller); ③ cockatiel 退避重试 + 连续熔断
 * (仅对 `TransientVendorError`); ④ 命中 429 先等 {@link VendorHttpClient.rateLimitWaitMs}
 * 再交重试 (优先采信 vendor 的 `Retry-After`)。
 *
 * adapter 负责 vendor 语义 (URL / 鉴权 body / 解析); 本类只管传输纪律。
 *
 * 直 `import from 'cockatiel'` 自配 policy, **不** DI `auth/cockatiel-retry.executor.ts`
 * —— marketdata 叶子不依赖 auth, 且 vendor policy (双窗 + transientWait) 与 SMS 不同
 * (C1 修, plan §R3.114)。
 */
export class VendorHttpClient {
  private readonly limiter: VendorRateLimiter;
  private readonly policy: IPolicy;
  private readonly fetchFn: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly profile: VendorConstraintProfile,
    deps: VendorHttpClientDeps = {},
  ) {
    this.fetchFn = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? Math.random;
    this.limiter = new VendorRateLimiter(profile.rateLimit, this.now, this.sleep);

    const handleTransient = handleType(TransientVendorError);
    this.policy = wrap(
      retry(handleTransient, {
        maxAttempts: profile.retry.maxAttempts,
        backoff: new ExponentialBackoff({ initialDelay: 500, maxDelay: 8_000 }),
      }),
      circuitBreaker(handleTransient, {
        halfOpenAfter: 10_000,
        breaker: new ConsecutiveBreaker(5),
      }),
    );
  }

  /** 发请求并解析 JSON; 限频 + 退避重试 + 熔断由本类透明执行。 */
  async request<T>(req: VendorRequest): Promise<T> {
    return this.policy.execute(() =>
      this.executeOnce<T>(req, (res) => res.json() as Promise<T>),
    ) as Promise<T>;
  }

  /**
   * 同 {@link request}, 但**按文本读 body** —— 给非 JSON 的 vendor 通路用 (046: CBOE 官方
   * 历史 CSV, 全仓第一个)。传输纪律 (限频 / 退避重试 / 熔断 / 超时 abort) 与 JSON 通路
   * **完全同一条**: 分歧只在最后那一步怎么读 body, 故共用 `executeOnce`。
   *
   * 🚨 走这条不是「绕开 profile」的后门: 新源照样要有自己的 `VendorConstraintProfile`。
   */
  async requestText(req: VendorRequest): Promise<string> {
    return this.policy.execute(() =>
      this.executeOnce<string>(req, (res) => {
        if (typeof res.text !== 'function') {
          throw new Error(`[${this.profile.vendor}] fetch 响应无 text() (假 fetch 未实现?)`);
        }
        return res.text();
      }),
    ) as Promise<string>;
  }

  private async executeOnce<T>(
    req: VendorRequest,
    readBody: (res: FetchResponseLike) => Promise<T>,
  ): Promise<T> {
    await this.limiter.acquire();

    const headers = { ...this.profile.headers, ...req.headers };
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchFn(req.url, {
        method: req.method ?? 'GET',
        headers,
        body: req.body,
        // 🚨 signal **必须在 executeOnce 内建** (每次重试一个新的), 不能提到 request()/构造器:
        // AbortSignal 一旦 abort 就永久 abort ⇒ 复用会让第 2 次重试**当场**失败, 重试形同虚设。
        // 超时 abort 抛 DOMException('TimeoutError') → 落进下面的 catch → TransientVendorError
        // ('network') → 与网络错同路走退避重试 + 熔断 (语义正确: 超时就是一种瞬时故障)。
        signal: AbortSignal.timeout(this.profile.timeoutMs),
      });
    } catch (cause) {
      throw new TransientVendorError(this.profile.vendor, 'network', cause);
    }

    if (res.status === 429) {
      // 限频缓释: 先等待再交 cockatiel 退避重试 (不向 caller 抛 429)。等多久见 rateLimitWaitMs。
      await this.sleep(this.rateLimitWaitMs(res));
      throw new TransientVendorError(this.profile.vendor, 429);
    }
    if (res.status >= 500) {
      throw new TransientVendorError(this.profile.vendor, res.status);
    }
    if (!res.ok) {
      // 4xx (非 429) = 永久错 (鉴权/参数), 重试无意义。
      throw new VendorHttpError(this.profile.vendor, res.status);
    }
    return readBody(res);
  }

  /**
   * 429 后、重试前的等待 (ms)。
   *
   * 取 `max(profile.transientWaitMs, Retry-After)` —— 即 **`transientWaitMs` 是下界, 不是
   * 「没有 Retry-After 时才用的兜底」**。两边都不能丢:
   * · vendor 说的是**它**什么时候肯再收 (下界), 比我们猜得准;
   * · profile 的值是**我们**对该 vendor 的已知约束 (理杏仁 429 = 分钟级封禁 ⇒ ≥60 s),
   *   vendor 报了个更短的数不代表那份保守可以抹掉。
   * 取 max 让两条约束同时成立, 且对「不发 Retry-After 的 vendor」行为逐字节不变。
   *
   * 🚨 **为什么不能只用固定值** (本方法存在的全部理由): 2026-08-09 prod 实测, futu-shim 的
   * `option_chain` 是 30 秒滚动窗、429 时明说 `Retry-After: 29`, 而固定值只有 2s ⇒
   * 「等 2s → 重试 → 又 429」直到 attempts 耗尽总共约 7.8 秒, **结构上熬不过一次限频窗**,
   * 必然升级成 `budgetExhausted` 丢给上层顺延重入队。读了 `Retry-After` 之后第一次重试就能过。
   *
   * 🚨 **上限 {@link RETRY_AFTER_CAP_MS} 是刻意的**: vendor 要求等到分钟级以上时, 那已不是
   * 偶发抖动而是系统性限频 —— 该让整轮任务走 `budgetExhausted` 交上层顺延, 而不是把一个
   * worker 卡在这里空等。
   *
   * 🚨 **jitter 只加不减**: `Retry-After` 是 vendor 给的**下界**, 减了必然再撞一次 429;
   * 完全不加则多个并发 caller 会同时醒来再次撞闸 (thundering herd)。
   *
   * 复杂度 O(1)。
   */
  private rateLimitWaitMs(res: FetchResponseLike): number {
    const advertised = parseRetryAfterMs(res.headers?.get('retry-after'), this.now());
    const honored = advertised !== null && advertised <= RETRY_AFTER_CAP_MS ? advertised : 0;
    const base = Math.max(this.profile.transientWaitMs, honored);
    return base + Math.floor(base * RETRY_AFTER_JITTER_RATIO * this.random());
  }
}
