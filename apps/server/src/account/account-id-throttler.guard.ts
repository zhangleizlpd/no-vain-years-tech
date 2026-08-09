import { Injectable } from '@nestjs/common';
import { RetryAfterThrottlerGuard } from '../security/retry-after-throttler.guard.js';
import type { AuthenticatedUser } from './jwt-auth.guard';

/**
 * Throttler tracker by accountId (FR-008 — me-get 60s 60 / me-patch 60s 10).
 *
 * Override the default IP-based tracker so 限流 scope is bound per
 * authenticated account, not per source IP. JwtAuthGuard runs first and
 * populates `req.user.accountId`; this guard reads it and emits
 * `me:<accountId>` as the throttle key. Two endpoints hitting /me from
 * the same IP under different tokens are independently rate-limited;
 * one account spamming behind a proxy still hits its own cap.
 *
 * Fallback to IP (or 'unknown') only when req.user is absent — that
 * means JwtAuthGuard didn't run / let an unauthenticated request through,
 * which would itself be a bug. Conservative IP cap then prevents abuse.
 */
@Injectable()
export class AccountIdThrottlerGuard extends RetryAfterThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req['user'] as AuthenticatedUser | undefined;
    if (user && user.accountId !== undefined && user.accountId !== null) {
      return Promise.resolve(`me:${String(user.accountId)}`);
    }
    const ip = req['ip'];
    return Promise.resolve(typeof ip === 'string' ? ip : 'unknown');
  }
}
