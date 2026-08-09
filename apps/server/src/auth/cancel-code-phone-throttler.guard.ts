import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { RetryAfterThrottlerGuard } from '../security/retry-after-throttler.guard.js';

/**
 * Throttler tracker by **phone hash** for the public cancel-deletion sms-code
 * endpoint (FR-S08: 手机号 MUST 以哈希作限流 key, 不明文落限流器)。
 *
 * 镜像 `SmsPhoneThrottlerGuard`, 但对 phone 做 SHA-256 再作 key —— public unauthed
 * 端点的唯一标识是手机号, Redis throttle 键绝不带明文号码。本 guard 的 getTracker
 * 供**无自带 getTracker** 的 throttler (cancel-code 1/60s) 使用; cancel-code-ip
 * 自带 IP getTracker (module 定义)。无 phone body → fallback IP 保守限流。
 */
@Injectable()
export class CancelCodePhoneThrottlerGuard extends RetryAfterThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const body = req['body'] as { phone?: unknown } | undefined;
    if (body && typeof body.phone === 'string' && body.phone.length > 0) {
      const hash = createHash('sha256').update(body.phone).digest('hex');
      return Promise.resolve(`cancel:${hash}`);
    }
    const ip = req['ip'];
    return Promise.resolve(typeof ip === 'string' ? ip : 'unknown');
  }
}
