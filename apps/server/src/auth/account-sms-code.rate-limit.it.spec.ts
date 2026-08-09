import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { AccountSmsCodeController } from './account-sms-code.controller';
import { RequestSmsCodeUseCase } from './request-sms-code.usecase';
import { SmsPhoneThrottlerGuard } from './sms-phone-throttler.guard';

/**
 * Integration test (T044): FR-S07 第 1 条 sms:<phone> 60s 1 次。
 *
 * Testcontainers Redis + minimal NestJS Fastify stack。验证：
 * 1. 同 phone 60s 内第 2 次 → 429 + Retry-After header
 * 2. 不同 phone 60s 内仍 → 200（tracker key 是 phone 不是 IP）
 *
 * UseCase mocked to avoid pulling Prisma / Mock SMS / Redis 业务连接（IT
 * 仅验证 throttler + 自定义 guard 真 enforce）。
 */
describe('AccountSmsCodeController rate-limit IT (sms:<phone> 60s 1 次)', () => {
  let app: NestFastifyApplication;
  let redisContainer: StartedRedisContainer;
  let throttlerRedis: Redis;
  const executeMock = vi.fn().mockResolvedValue({ ttlSec: 300 });

  beforeAll(async () => {
    redisContainer = await new RedisContainer('redis:7-alpine').start();
    throttlerRedis = new Redis(redisContainer.getConnectionUrl());

    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ limit: 1, ttl: 60_000 }],
          storage: new ThrottlerStorageRedisService(throttlerRedis),
        }),
      ],
      controllers: [AccountSmsCodeController],
      providers: [
        SmsPhoneThrottlerGuard,
        { provide: RequestSmsCodeUseCase, useValue: { execute: executeMock } },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await throttlerRedis?.quit();
    await redisContainer?.stop();
  });

  it('1st request: 200; 2nd same phone within 60s: 429 + Retry-After', async () => {
    const phone = '+8613800138000';

    const first = await app.inject({
      method: 'POST',
      url: '/v1/accounts/sms-codes',
      payload: { phone },
    });
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ ttlSec: 300 });

    const second = await app.inject({
      method: 'POST',
      url: '/v1/accounts/sms-codes',
      payload: { phone },
    });
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBeDefined();
  });

  it('different phone within 60s: still 200 (tracker key 是 phone 不是 IP)', async () => {
    const second = await app.inject({
      method: 'POST',
      url: '/v1/accounts/sms-codes',
      payload: { phone: '+8613800138999' },
    });
    expect(second.statusCode).toBe(200);
  });
});
