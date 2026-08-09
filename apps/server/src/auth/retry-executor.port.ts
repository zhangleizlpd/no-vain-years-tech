/**
 * RetryExecutor port (FR-S03 retry policy, W3 A3)。
 *
 * Abstract retry + circuit breaker policy execution。Infrastructure 实装 (e.g.
 * CockatielRetryExecutor) 注入到 application 层 use case 包外部依赖调用 (SMS
 * gateway / 未来 IM / 第三方 API)。Application layer 不直接依赖 cockatiel,
 * port + adapter 保持 hexagonal 边界。
 */
export const RETRY_EXECUTOR = Symbol('RETRY_EXECUTOR');

export interface RetryExecutor {
  /**
   * 执行 operation, 失败时 retry per policy (max attempts + backoff +
   * circuit breaker)。所有 attempts 失败 → throws last error。
   */
  execute<T>(operation: () => Promise<T>): Promise<T>;
}
