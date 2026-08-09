import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';

const KEY_PREFIX = 'sms_code:';

/**
 * SmsCodeStore — Redis-backed SMS code store (自有非 DB 基建, per ADR-0043 §4:
 * concrete service, 无 interface)。HMAC-SHA256 + crypto.timingSafeEqual。
 *
 * Per ADR-0023 (2026-05-18 切换): bcrypt cost=12 → HMAC,根因 = FR-S06 P95 ≤ 50ms
 * 实测违反 (mono PR #23 200-rep diff ≈ 193ms,单边 bcrypt.compare verify ~150ms).
 *
 * HMAC verify <1ms 让 3 个反枚举 401 路径(ACTIVE+码错 / ACTIVE+码过期 /
 * ANONYMIZED+任意码) 时延自然均一;BcryptTimingDefenseExecutor.pad 保留作纵深防御.
 *
 * verify() 返回: true=匹配(caller 应立即 clear) / false=stored 存在但码不符 /
 * null=过期或从未 store。
 */
@Injectable()
export class SmsCodeStore {
  constructor(
    private readonly redis: Redis,
    private readonly hmacSecret: string,
  ) {}

  async store(phone: string, code: string, ttlSec: number): Promise<void> {
    const digest = this.hmac(code);
    await this.redis.setex(this.key(phone), ttlSec, digest);
  }

  async verify(phone: string, code: string): Promise<boolean | null> {
    const stored = await this.redis.get(this.key(phone));
    if (stored === null) return null;
    const candidate = this.hmac(code);
    const storedBuf = Buffer.from(stored, 'base64url');
    const candidateBuf = Buffer.from(candidate, 'base64url');
    if (storedBuf.length !== candidateBuf.length) return false;
    return timingSafeEqual(storedBuf, candidateBuf);
  }

  async clear(phone: string): Promise<void> {
    await this.redis.del(this.key(phone));
  }

  private hmac(code: string): string {
    return createHmac('sha256', this.hmacSecret).update(code).digest('base64url');
  }

  private key(phone: string): string {
    return `${KEY_PREFIX}${phone}`;
  }
}
