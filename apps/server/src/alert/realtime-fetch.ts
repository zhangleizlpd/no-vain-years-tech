/**
 * 024 T007 alert 自持轻量字节级 HTTP GET (plan D2 轻量决策 — 不镜像 marketdata VendorHttpClient
 * 的 cockatiel retry+circuitBreaker; 重试 / 熔断单层下沉到 T008 Redis failstreak, 避免双层熔断)。
 *
 * 实时快照源返 GBK 字节 (非 JSON) → 取 arraybuffer 原始字节交 realtime-quote.rules 解码解析。
 * 注入式 (adapter 构造默认 = httpFetchBytes) 便于单测 stub, 真实请求由 T012 env-gated IT 校真。
 */
export type RealtimeFetch = (url: string, headers?: Record<string, string>) => Promise<Uint8Array>;

/** 实时源单请求超时 (ms); 5min tick 节奏下保守取 5s, 超时即抛供 FallbackChain 切源。 */
export const REALTIME_FETCH_TIMEOUT_MS = 5000;

/** 默认实现: 全局 fetch + AbortSignal 超时 → 非 2xx 抛 → 返原始字节 (Uint8Array)。 */
export const httpFetchBytes: RealtimeFetch = async (url, headers = {}) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(REALTIME_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`realtime HTTP ${res.status}: ${url}`);
  return new Uint8Array(await res.arrayBuffer());
};
