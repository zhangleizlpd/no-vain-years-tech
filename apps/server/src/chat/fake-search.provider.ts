import type { SearchProvider, SearchResult, SearchOptions } from './search-provider.port.js';

/**
 * FakeSearchProvider (030 T002, plan Gate 0.1) — 联网 ReAct loop IT 的确定性替身。
 *
 * 真 IQS 检索非确定 (结果/时延/可用性随外网),IT (T010) 注入本替身得可复现的检索结果 +
 * 可注入故障,精确驱动 state_branches (多轮去重 / 超时降级 / 零结果不 degraded)。通过 DI
 * override `SEARCH_PROVIDER` token 注入 (不 jest.mock, per plan「NO LIFECYCLE MOCKING」);
 * 契约冒烟真 boot 经 `CHAT_FAKE_SEARCH=1` 绑定 (chat.module.ts, 同 CHAT_FAKE_LLM 范式)。
 *
 * 构造配置:
 * - `results`   — scripted 每次检索返回的结果批 (按调用序取 `results[callIndex]`;
 *                 超出长度则返回**空数组** = 零结果, 非 error)。
 * - `error`     — true → 每次 search throw `FAKE_SEARCH_ERROR` (模拟后端超时/失败 → loop 降级)。
 * - `errorOnCall` — 仅第 N 次 (0-based) 调用 throw (前几轮成功后某轮失败的降级场景)。
 * - `failOnQueryMarker` — query 含此标记子串 → throw `FAKE_SEARCH_ERROR` (030 T016 content-driven
 *                 降级:env 注入路无法 .overrideProvider 注 error, 故按 query 内容自决降级,
 *                 驱动契约冒烟真 boot 下的 FR-009 降级路径)。未设 → 不按 query 触发 (向后兼容)。
 * - `delayMs`   — 返回前等待该毫秒 (为停止/断连测留时窗);期间 abort 即抛 AbortError。
 *
 * 尊重 `opts.signal`: 已 abort / 等待期间 abort → throw (模拟在途检索被取消)。
 */
export interface FakeSearchProviderConfig {
  results?: SearchResult[][];
  error?: boolean;
  errorOnCall?: number;
  failOnQueryMarker?: string;
  delayMs?: number;
}

export class FakeSearchProvider implements SearchProvider {
  private callIndex = 0;

  constructor(private readonly config: FakeSearchProviderConfig = {}) {}

  async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    const call = this.callIndex++;
    const { results, error, errorOnCall, failOnQueryMarker, delayMs } = this.config;

    if (opts.signal.aborted) throw new Error('FAKE_SEARCH_ABORTED');

    if (delayMs !== undefined && delayMs > 0) {
      const aborted = await this.sleepOrAbort(delayMs, opts.signal);
      if (aborted) throw new Error('FAKE_SEARCH_ABORTED');
    }

    const queryTriggeredFail =
      failOnQueryMarker !== undefined &&
      failOnQueryMarker.length > 0 &&
      query.includes(failOnQueryMarker);
    if (error || errorOnCall === call || queryTriggeredFail) {
      throw new Error('FAKE_SEARCH_ERROR: injected search failure');
    }

    // 超出 scripted 长度 → 零结果 (正常检索结果, loop 不标 degraded)。
    return results?.[call] ?? [];
  }

  /** 睡 ms 毫秒,期间 signal abort 则提前 resolve(true)。复用 fake-llm 同款无泄漏定时器。 */
  private sleepOrAbort(ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(true);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(false);
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
