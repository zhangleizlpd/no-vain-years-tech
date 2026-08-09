import {
  ConsecutiveBreaker,
  ExponentialBackoff,
  circuitBreaker,
  handleType,
  retry,
  wrap,
  type IPolicy,
} from 'cockatiel';
import { DualWindowRateLimiter } from './dual-window-rate-limiter.js';
import type { VendorConstraintProfile } from './vendor-constraint-profile.js';

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
 * 每个外部源**一个实例** (各自持双窗限频器 + 熔断状态, 按 profile 构造)。统一执行
 * Vendor Constraint Profile: ① 注入必需 header; ② 过双窗令牌桶限频 (超限排队, 不抛
 * 429 给 caller); ③ cockatiel 退避重试 + 连续熔断 (仅对 `TransientVendorError`);
 * ④ 命中 429 先等 `transientWaitMs` 再交重试 (理杏仁分钟级封禁缓释)。
 *
 * adapter 负责 vendor 语义 (URL / 鉴权 body / 解析); 本类只管传输纪律。
 *
 * 直 `import from 'cockatiel'` 自配 policy, **不** DI `auth/cockatiel-retry.executor.ts`
 * —— marketdata 叶子不依赖 auth, 且 vendor policy (双窗 + transientWait) 与 SMS 不同
 * (C1 修, plan §R3.114)。
 */
export class VendorHttpClient {
  private readonly limiter: DualWindowRateLimiter;
  private readonly policy: IPolicy;
  private readonly fetchFn: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly profile: VendorConstraintProfile,
    deps: VendorHttpClientDeps = {},
  ) {
    this.fetchFn = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.limiter = new DualWindowRateLimiter(profile.rateLimit, deps.now, this.sleep);

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
      // 限频封禁缓释: 先固定等待再交 cockatiel 退避重试 (不向 caller 抛 429)。
      await this.sleep(this.profile.transientWaitMs);
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
}
