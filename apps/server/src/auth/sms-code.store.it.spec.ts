import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { SmsCodeStore } from './sms-code.store';

const HMAC_SECRET = 'spec-hmac-secret-min-32-bytes-padding-zzzz';

describe('SmsCodeStore (Testcontainers Redis, HMAC-SHA256)', () => {
  let container: StartedRedisContainer;
  let redis: Redis;
  let repo: SmsCodeStore;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    redis = new Redis(container.getConnectionUrl());

    // Repository constructor takes positional (Redis, string) — not DI-resolvable
    // by type alone (production wires via useFactory with REDIS_CLIENT + ConfigService;
    // see auth.module.ts). Mirror that here with a test-scoped useFactory so the
    // SUT is sourced through the Nest DI container (satisfies no-bad-mocks hook
    // per ADR-0040 multi-layer test gate).
    const moduleRef = await Test.createTestingModule({
      providers: [
        {
          provide: SmsCodeStore,
          useFactory: () => new SmsCodeStore(redis, HMAC_SECRET),
        },
      ],
    }).compile();
    repo = moduleRef.get(SmsCodeStore);
  }, 60_000);

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
  });

  it('store + verify returns true for matching code', async () => {
    const phone = '+8613800138201';
    await repo.store(phone, '123456', 300);

    const result = await repo.verify(phone, '123456');
    expect(result).toBe(true);
  });

  it('store + verify returns false for non-matching code', async () => {
    const phone = '+8613800138202';
    await repo.store(phone, '123456', 300);

    const result = await repo.verify(phone, '654321');
    expect(result).toBe(false);
  });

  it('verify returns null when never stored', async () => {
    const phone = '+8613800138203';
    const result = await repo.verify(phone, '123456');
    expect(result).toBeNull();
  });

  it('store + clear + verify returns null', async () => {
    const phone = '+8613800138204';
    await repo.store(phone, '123456', 300);
    await repo.clear(phone);

    const result = await repo.verify(phone, '123456');
    expect(result).toBeNull();
  });

  it('TTL expires; verify returns null after ttlSec elapsed', async () => {
    const phone = '+8613800138205';
    await repo.store(phone, '123456', 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const result = await repo.verify(phone, '123456');
    expect(result).toBeNull();
  });

  it('HMAC deterministic — same code + same secret = same digest in redis', async () => {
    const phone1 = '+8613800138206';
    const phone2 = '+8613800138207';
    await repo.store(phone1, '123456', 300);
    await repo.store(phone2, '123456', 300);

    const d1 = await redis.get(`sms_code:${phone1}`);
    const d2 = await redis.get(`sms_code:${phone2}`);
    expect(d1).toBeTruthy();
    expect(d1).toBe(d2);
  });

  it('HMAC negative — different code → different digest', async () => {
    const phone1 = '+8613800138208';
    const phone2 = '+8613800138209';
    await repo.store(phone1, '123456', 300);
    await repo.store(phone2, '654321', 300);

    const d1 = await redis.get(`sms_code:${phone1}`);
    const d2 = await redis.get(`sms_code:${phone2}`);
    expect(d1).not.toBe(d2);
  });

  it('secret rotation — different secret reads same redis hash → verify false', async () => {
    const phone = '+8613800138210';
    await repo.store(phone, '123456', 300);

    const newSecretRepo = new SmsCodeStore(redis, 'rotated-secret-min-32-bytes-padding-yyyy');
    const result = await newSecretRepo.verify(phone, '123456');
    expect(result).toBe(false);
  });
});
