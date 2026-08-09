import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AuthModule } from '../../src/auth/auth.module';
import { PortfolioModule } from '../../src/portfolio/portfolio.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import { UpdateMarketPreferenceUseCase } from '../../src/portfolio/update-market-preference.usecase';

// 011 T009 US2: 并发 (SC-M03 server 锚) — N 端并发关不同核心市场 → FOR UPDATE 串行化
// → 恰保留 ≥1 激活 (无 0 激活中间态, 证 D1 跨行不变性); 限流 (SC-S05) — get 61 / put 31
// → 429 + Retry-After, 限流命中未触 DB 写。
describe('US2 并发 + 限流 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let redis: Redis;
  let updateUseCase: UpdateMarketPreferenceUseCase;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'mkt-us2-conc-jwt-secret-min-32-bytes-pad-a';
    process.env.SMS_CODE_HMAC_SECRET = 'mkt-us2-conc-hmac-secret-min-32-bytes-pad';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule, PortfolioModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtTokenService);
    redis = moduleRef.get(REDIS_CLIENT);
    updateUseCase = moduleRef.get(UpdateMarketPreferenceUseCase);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    await redis.flushall(); // 隔离限流桶
  });

  const nextPhone = () => `+8613804${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }
  it('并发关核心市场 → 单行 conditional UPDATE 串行化 → 恒 ≥1 激活 (无 0 激活), N 轮确定性', async () => {
    const { id } = await activeToken();
    const reset = () =>
      prisma.portfolioPreference.upsert({
        where: { accountId: id },
        create: { accountId: id, activeMarkets: ['cn', 'hk', 'us'] },
        update: { activeMarkets: ['cn', 'hk', 'us'] },
      });

    // N 轮 × 3 并发各关一个核心市场 (service 层直测绕限流)。ADR-0046: 单行 row-lock +
    // READ COMMITTED EvalPlanQual 重检 `array_length(... remove ...) >= 1` → 末位归 0 者
    // 0 affected → min-1 拒,恒 ≥1。**确定性自检**: 临时移除 WHERE 守卫 → 某轮必现 0 激活
    // 红 (多轮放大,治单轮 flaky-fail——race 是否暴露取决于时序)。
    for (let round = 0; round < 12; round += 1) {
      await reset();
      const results = await Promise.allSettled([
        updateUseCase.execute(id, 'cn', false),
        updateUseCase.execute(id, 'hk', false),
        updateUseCase.execute(id, 'us', false),
      ]);

      const row = await prisma.portfolioPreference.findUnique({ where: { accountId: id } });
      expect((row?.activeMarkets ?? []).length).toBeGreaterThanOrEqual(1); // 无 0 激活
      expect(results.filter((r) => r.status === 'rejected').length).toBeGreaterThanOrEqual(1);
    }
  });

  it('GET 限流 61 次 → 429 + Retry-After', async () => {
    const { token } = await activeToken();
    let last;
    for (let i = 0; i < 61; i += 1) {
      last = await app.inject({
        method: 'GET',
        url: '/api/v1/portfolio/market-preferences',
        headers: { authorization: `Bearer ${token}` },
      });
    }
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('PUT 限流 31 次 → 429 + Retry-After + 限流命中未触 DB 写', async () => {
    const { id, token } = await activeToken();
    const put = (market: string, active: boolean) =>
      app.inject({
        method: 'PUT',
        url: `/api/v1/portfolio/market-preferences/${market}`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { active },
      });

    // 前 30 次 PUT {hk,true} 耗尽桶 (首次 materialize + 落 hk active, 其余幂等)。
    let last;
    for (let i = 0; i < 30; i += 1) last = await put('hk', true);
    expect(last!.statusCode).toBe(200);

    // 第 31 次尝试写 {us,true} → 429 (guard 在 handler 前拒) → us 不应被写。
    const limited = await put('us', true);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    const row = await prisma.portfolioPreference.findUnique({ where: { accountId: id } });
    expect((row?.activeMarkets ?? []).includes('us')).toBe(false); // 限流命中未触 DB 写
  });
});
