import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { PortfolioModule } from '../../src/portfolio/portfolio.module';
import { narrowTestModule } from '../_support/narrow-boot';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { BindBrokerAccountUseCase } from '../../src/portfolio/bind-broker-account.usecase';

// 012 T009 US2 Independent Test (FR-S02/S03/S04): authed POST 字典+禁字符校验 + 唯一性 dup→409。
// 含 D1 gate (⚠️ review): 并发同键 POST (service 层直测绕限流) → 唯一索引串行化 → 恰一 201、
// 余 409, 验 adapter-pg 下 P2002 catch 真生效 (不靠假设, per memory prisma_serializable_p2002)。
describe('US2 绑定券商账户 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let bindUseCase: BindBrokerAccountUseCase;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'broker-us2-bind-jwt-secret-min-32-bytes-ab';
    process.env.SMS_CODE_HMAC_SECRET = 'broker-us2-bind-hmac-secret-min-32-bytes-z';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: narrowTestModule([PortfolioModule]),
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtTokenService);
    bindUseCase = moduleRef.get(BindBrokerAccountUseCase);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  const nextPhone = () => `+8613811${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }
  const post = (token: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/portfolio/broker-accounts',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: payload as object,
    });
  const list = (token: string) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/portfolio/broker-accounts',
      headers: { authorization: `Bearer ${token}` },
    });

  it('POST 有效 {brokerCode∈字典, clientNo} → 201 落库 + GET 含新条 (raw 明文)', async () => {
    const { token } = await activeToken();
    const res = await post(token, { brokerCode: 'htai', clientNo: '3119000002466' });
    expect(res.statusCode).toBe(201);
    const item = res.json() as {
      brokerCode: string;
      brokerName: string;
      clientNo: string;
      isDefault: boolean;
    };
    expect(item.brokerCode).toBe('htai');
    expect(item.brokerName).toBe('华泰证券');
    expect(item.clientNo).toBe('3119000002466');
    expect(item.isDefault).toBe(false);

    const body = (await list(token)).json() as { accounts: Array<{ clientNo: string | null }> };
    expect(body.accounts.some((a) => a.clientNo === '3119000002466')).toBe(true);
  });

  it('重复 POST 同 {brokerCode, clientNo} → 409 BROKER_ACCOUNT_DUPLICATE + 不重复落库', async () => {
    const { id, token } = await activeToken();
    await post(token, { brokerCode: 'dfcf', clientNo: '8800001234' });
    const dup = await post(token, { brokerCode: 'dfcf', clientNo: '8800001234' });
    expect(dup.statusCode).toBe(409);
    expect((dup.json() as { code: string }).code).toBe('BROKER_ACCOUNT_DUPLICATE');

    const count = await prisma.brokerAccount.count({
      where: { accountId: id, brokerCode: 'dfcf', clientNo: '8800001234' },
    });
    expect(count).toBe(1);
  });

  it('并发同键 (D1 gate, service 层直测绕限流) → 唯一索引串行化 → 恰一 201、余 409 (验 adapter-pg P2002 真生效)', async () => {
    const { id } = await activeToken();
    const N = 6;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => bindUseCase.execute(id, 'gtja', '5550001111')),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1); // 唯一索引串行化: 恰一胜出
    expect(rejected).toHaveLength(N - 1);
    // 败者皆 409 BROKER_ACCOUNT_DUPLICATE (P2002 catch 真生效, 非 unmapped 500)。
    for (const r of rejected as PromiseRejectedResult[]) {
      expect(r.reason?.getStatus?.()).toBe(409);
    }
    const count = await prisma.brokerAccount.count({
      where: { accountId: id, brokerCode: 'gtja', clientNo: '5550001111' },
    });
    expect(count).toBe(1); // 仅一行落库
  });

  it('POST 未知 brokerCode → 400 FORM_VALIDATION', async () => {
    const { token } = await activeToken();
    const res = await post(token, { brokerCode: 'nope', clientNo: '123456' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('FORM_VALIDATION');
  });

  it('POST clientNo trim 后空 → 400 FORM_VALIDATION', async () => {
    const { token } = await activeToken();
    const res = await post(token, { brokerCode: 'htai', clientNo: '   ' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('FORM_VALIDATION');
  });

  it('POST clientNo 含控制字符 → 400 FORM_VALIDATION', async () => {
    const { token } = await activeToken();
    const res = await post(token, { brokerCode: 'htai', clientNo: '3119\t000' }); // \t = U+0009 deny
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('FORM_VALIDATION');
  });

  it('POST 同券商不同 clientNo 两条 → 均 201', async () => {
    const { token } = await activeToken();
    const a = await post(token, { brokerCode: 'zszq', clientNo: 'A0001' });
    const b = await post(token, { brokerCode: 'zszq', clientNo: 'A0002' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
  });

  it('缺 token → 401 反枚举', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/portfolio/broker-accounts',
      headers: { 'content-type': 'application/json' },
      payload: { brokerCode: 'htai', clientNo: '123' },
    });
    expect(res.statusCode).toBe(401);
  });
});
