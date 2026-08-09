import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AuthAttemptLockedException } from './auth-attempt-locked.exception';
import { REDIS_CLIENT } from '../security/redis.token';

const FAIL_KEY = (phone: string): string => `auth-fail:${phone}`;
const LOCK_KEY = (phone: string): string => `auth-lock:${phone}`;
const FAIL_WINDOW_SECONDS = 24 * 60 * 60;
const LOCK_DURATION_SECONDS = 30 * 60;
const FAIL_THRESHOLD = 5;

/**
 * FR-S07 第 4 条: auth:<phone> 5 次失败 → 锁 30min。
 *
 * Lock 状态存 Redis (per 2026-05-17 W3 起手 user choice "Redis lock store"):
 * - `auth-fail:<phone>` (INCR + EXPIRE 24h): 失败计数 in 24h sliding window
 * - `auth-lock:<phone>` (SET EX 1800): lock flag, TTL 30min
 *
 * Lock 触发 → throw AuthAttemptLockedException with remaining TTL → filter
 * maps to 429 + Retry-After header。
 */
@Injectable()
export class AuthFailureLockService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * 检查 phone 是否在锁定期。锁定 → throw AuthAttemptLockedException。
   */
  async assertNotLocked(phone: string): Promise<void> {
    const ttl = await this.redis.ttl(LOCK_KEY(phone));
    if (ttl > 0) {
      throw new AuthAttemptLockedException(ttl);
    }
  }

  /**
   * 记录一次认证失败。失败计数达 5 → 立即上锁 + reset 计数。
   */
  async recordFailure(phone: string): Promise<void> {
    const failKey = FAIL_KEY(phone);
    const count = await this.redis.incr(failKey);
    if (count === 1) {
      await this.redis.expire(failKey, FAIL_WINDOW_SECONDS);
    }
    if (count >= FAIL_THRESHOLD) {
      await this.redis.set(LOCK_KEY(phone), '1', 'EX', LOCK_DURATION_SECONDS);
      await this.redis.del(failKey);
    }
  }
}
