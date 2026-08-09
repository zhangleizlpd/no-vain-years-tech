import { Injectable } from '@nestjs/common';
import {
  ConsecutiveBreaker,
  ExponentialBackoff,
  circuitBreaker,
  handleAll,
  type IPolicy,
  retry,
  wrap,
} from 'cockatiel';
import type { RetryExecutor } from './retry-executor.port';

/**
 * Cockatiel adapter for RetryExecutor port (FR-S03 retry policy, W3 A3)。
 *
 * Policy 组合 (per plan.md R0.5):
 * - Retry: maxAttempts=3, ExponentialBackoff(initialDelay=200ms, maxDelay=2s)
 * - Circuit breaker: ConsecutiveBreaker(5), halfOpenAfter=10s
 *
 * 5 次连续失败 → circuit open 10s, 期间所有 execute 立即抛 BrokenCircuitError
 * 不打外部依赖; 10s 后 half-open 试 1 次, 成功 → close, 失败 → re-open 10s。
 *
 * NestJS DI singleton scope → 所有 caller 共享同一 breaker state (W3 仅
 * SmsGateway 使用; W4+ 若多 caller 需独立 breaker 再 split instance)。
 */
@Injectable()
export class CockatielRetryExecutor implements RetryExecutor {
  private readonly policy: IPolicy;

  constructor() {
    const retryPolicy = retry(handleAll, {
      maxAttempts: 3,
      backoff: new ExponentialBackoff({ initialDelay: 200, maxDelay: 2_000 }),
    });
    const breakerPolicy = circuitBreaker(handleAll, {
      halfOpenAfter: 10_000,
      breaker: new ConsecutiveBreaker(5),
    });
    this.policy = wrap(retryPolicy, breakerPolicy);
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    return this.policy.execute(operation);
  }
}
