import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import { RateLimitExceededException } from './rate-limit-exceeded.exception.js';

/**
 * canonical `Retry-After` 限流基类 (平台层, per ADR-0032 单向 import — account + auth 共用)。
 *
 * `@nestjs/throttler` v6 默认对 named throttler 抛 ThrottlerException 并只设带桶名
 * 后缀的 `Retry-After-<bucket>` 头 (throttler.guard.ts L121), body 无 retryAfterSeconds
 * → ProblemDetailFilter 无法透出 canonical `Retry-After`。各 feature spec (FR-S07 /
 * FR-S13 ...) 均承诺 429 + `Retry-After`, 故在此统一覆写 throwThrottlingException,
 * 复用 RateLimitExceededException → 既有 retryAfterSeconds 通道补齐 canonical 头 + body。
 *
 * 所有限流路由的 guard 都应继承本类: tracker-override guard (AccountIdThrottlerGuard /
 * SmsPhoneThrottlerGuard / CancelCodePhoneThrottlerGuard) extends 本类; 无自定 tracker
 * 的 EP (device-management / logout-all) 直接 @UseGuards(RetryAfterThrottlerGuard)。
 */
@Injectable()
export class RetryAfterThrottlerGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(
    _context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    // timeToBlockExpire 为秒 (ThrottlerStorageRecord) — 与 Retry-After delta-seconds 语义一致。
    throw new RateLimitExceededException(detail.timeToBlockExpire);
  }
}
