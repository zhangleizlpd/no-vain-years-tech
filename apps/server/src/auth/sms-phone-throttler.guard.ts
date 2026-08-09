import { Injectable } from '@nestjs/common';
import { RetryAfterThrottlerGuard } from '../security/retry-after-throttler.guard.js';

/**
 * Throttler tracker by phone (FR-S07 第 1 条 sms:<phone> 60s 1 次).
 *
 * Override default IP-based tracker with `sms:<phone>` key so 限流 scope
 * is phone-number-bound (per FR-S07 spec). 同一手机 60s 内只能请求 1 次
 * SMS code,不论来源 IP。无 phone body fallback IP 保守限流。
 */
@Injectable()
export class SmsPhoneThrottlerGuard extends RetryAfterThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const body = req['body'] as { phone?: unknown } | undefined;
    if (body && typeof body.phone === 'string' && body.phone.length > 0) {
      return Promise.resolve(`sms:${body.phone}`);
    }
    const ip = req['ip'];
    return Promise.resolve(typeof ip === 'string' ? ip : 'unknown');
  }
}
