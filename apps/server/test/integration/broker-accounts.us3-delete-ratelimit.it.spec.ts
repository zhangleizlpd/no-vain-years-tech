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

// 012 T010 US3 Independent Test (FR-S05/S06 删除 + SC-S05 限流): 删本账号→204 + GET 不再含;
// 删默认 (id=accountId)→400 DEFAULT_ACCOUNT_NOT_DELETABLE 列表不变; 不存在 / 他人 id→404
// 字节级一致 (剥 traceId+instance, 反枚举); 已删幂等→404; 限流 get 61 / post 31 / delete 31
// → 429 + Retry-After。beforeEach redis flushall 隔离限流桶。
describe('US3 删除券商账户 + 限流 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let redis: Redis;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'broker-us3-del-jwt-secret-min-32-bytes-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'broker-us3-del-hmac-secret-min-32-bytes-zz';

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
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    await redis.flushall(); // 隔离限流桶
  });

  const nextPhone = () => `+8613812${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }
  // 显式 id 控碰撞 (D3): 测试 DB 中 account.id 与 broker_account.id 均从 1 自增, 默认会
  // 数值碰撞 (首账号首行 id==accountId), 掩盖被测分支。用 HI 区段 (远超 accountId) 隔离,
  // 仅「碰巧==accountId」用例显式置 id=accountId 验 scoped-delete 先判 (不误判默认)。
  let hi = 9_000_000_000_000n;
  const seedBroker = (accountId: bigint, brokerCode: string, clientNo: string, id?: bigint) =>
    prisma.brokerAccount.create({
      data: { id: id ?? (hi += 1n), accountId, brokerCode, clientNo },
    });
  const del = (token: string, id: bigint | string) =>
    app.inject({
      method: 'DELETE',
      url: `/api/v1/portfolio/broker-accounts/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
  const list = (token: string) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/portfolio/broker-accounts',
      headers: { authorization: `Bearer ${token}` },
    });

  it('删本账号已绑 id → 204 + GET 不再含', async () => {
    const { id, token } = await activeToken();
    const row = await seedBroker(id, 'htai', '111222333');
    const res = await del(token, row.id);
    expect(res.statusCode).toBe(204);

    const body = (await list(token)).json() as { accounts: Array<{ id: string }> };
    expect(body.accounts.some((a) => a.id === row.id.toString())).toBe(false);
  });

  it('删默认账户 (id=accountId) → 400 DEFAULT_ACCOUNT_NOT_DELETABLE + 列表不变', async () => {
    const { id, token } = await activeToken();
    await seedBroker(id, 'dfcf', 'keep-me');
    const before = (await list(token)).json() as { accounts: unknown[] };

    const res = await del(token, id); // id = accountId = 默认虚拟 id
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('DEFAULT_ACCOUNT_NOT_DELETABLE');

    const after = (await list(token)).json() as { accounts: unknown[] };
    expect(after.accounts).toHaveLength(before.accounts.length); // 列表不变
  });

  it('不存在 id vs 他人账号 id → 均 404 字节级一致 (剥 traceId+instance, 反枚举)', async () => {
    const { token } = await activeToken();
    const other = await activeToken();
    const otherRow = await seedBroker(other.id, 'gtja', 'x-9999');

    const nonexistent = await del(token, '888888888888');
    const crossAccount = await del(token, otherRow.id);
    expect(nonexistent.statusCode).toBe(404);
    expect(crossAccount.statusCode).toBe(404);

    // 剥 traceId (随机) + instance (回显请求 URL, 含 id) 后深等 → 不泄露存在性。
    const strip = (raw: string) => {
      const { traceId, instance, ...rest } = JSON.parse(raw) as Record<string, unknown>;
      void traceId;
      void instance;
      return rest;
    };
    expect(strip(nonexistent.body)).toEqual(strip(crossAccount.body));
  });

  it('已删 id 幂等 → 404', async () => {
    const { id, token } = await activeToken();
    const row = await seedBroker(id, 'zszq', 'once');
    expect((await del(token, row.id)).statusCode).toBe(204);
    expect((await del(token, row.id)).statusCode).toBe(404); // 幂等再删
  });

  it('本账号真实 broker 行 id 数值 == 自己 accountId 仍先删命中 204 (不误判默认, D3 核心)', async () => {
    // scoped-delete 先于 id===accountId 判定 (D3): 显式置 broker 行 id=accountId 制造碰撞 →
    // deleteMany{id, accountId} 命中本账号真实行 → count 1 → 204, **不**落入默认 400 分支。
    const { id, token } = await activeToken();
    const row = await seedBroker(id, 'pazq', 'real-row', id); // id == accountId 显式碰撞
    expect(row.id).toBe(id);
    expect((await del(token, row.id)).statusCode).toBe(204);
  });

  it('限流: DELETE 第 31 次 60s 内 → 429 + Retry-After', async () => {
    const { token } = await activeToken();
    let last;
    for (let i = 0; i < 31; i += 1) last = await del(token, '777000111000'); // 均 404 但计入桶
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('限流: GET 第 61 次 → 429; POST 第 31 次 → 429 (独立桶)', async () => {
    const { token } = await activeToken();
    let lastGet;
    for (let i = 0; i < 61; i += 1) lastGet = await list(token);
    expect(lastGet!.statusCode).toBe(429);

    await redis.flushall();
    const post = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/portfolio/broker-accounts',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { brokerCode: 'nope', clientNo: 'x' }, // 400 但计入桶
      });
    let lastPost;
    for (let i = 0; i < 31; i += 1) lastPost = await post();
    expect(lastPost!.statusCode).toBe(429);
  });
});
