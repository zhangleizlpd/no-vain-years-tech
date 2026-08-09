import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { AuthFailureLockService } from './auth-failure-lock.service';
import { AuthAttemptLockedException } from './auth-attempt-locked.exception';

/**
 * T047 unit-with-real-Redis spec for AuthFailureLockService。
 *
 * Testcontainers Redis 验证：
 * 1. 初始 assertNotLocked → 不抛
 * 2. 4 次 recordFailure 后 assertNotLocked → 仍不抛 (阈值 5)
 * 3. 第 5 次 recordFailure 触发 lock → assertNotLocked throw + 带 ttl
 * 4. exception 实例 retryAfterSeconds > 0
 */
describe('AuthFailureLockService (Testcontainers Redis)', () => {
  let redisContainer: StartedRedisContainer;
  let redis: Redis;
  let service: AuthFailureLockService;

  beforeAll(async () => {
    redisContainer = await new RedisContainer('redis:7-alpine').start();
    redis = new Redis(redisContainer.getConnectionUrl());
    service = new AuthFailureLockService(redis);
  }, 60_000);

  afterAll(async () => {
    await redis?.quit();
    await redisContainer?.stop();
  });

  it('初始 assertNotLocked: 不抛', async () => {
    const phone = '+8613800138101';
    await expect(service.assertNotLocked(phone)).resolves.toBeUndefined();
  });

  it('4 次 recordFailure 后 assertNotLocked: 仍不抛 (阈值 5)', async () => {
    const phone = '+8613800138102';
    for (let i = 0; i < 4; i++) {
      await service.recordFailure(phone);
    }
    await expect(service.assertNotLocked(phone)).resolves.toBeUndefined();
  });

  it('第 5 次 recordFailure → 触发 lock → assertNotLocked throw AuthAttemptLockedException', async () => {
    const phone = '+8613800138103';
    for (let i = 0; i < 5; i++) {
      await service.recordFailure(phone);
    }
    await expect(service.assertNotLocked(phone)).rejects.toBeInstanceOf(AuthAttemptLockedException);
  });

  it('exception 实例: retryAfterSeconds > 0 + status 429', async () => {
    const phone = '+8613800138104';
    for (let i = 0; i < 5; i++) {
      await service.recordFailure(phone);
    }
    try {
      await service.assertNotLocked(phone);
      expect.fail('expected AuthAttemptLockedException');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthAttemptLockedException);
      const ex = err as AuthAttemptLockedException;
      expect(ex.retryAfterSeconds).toBeGreaterThan(0);
      expect(ex.getStatus()).toBe(429);
    }
  });
});
