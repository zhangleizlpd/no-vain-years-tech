import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { PortfolioModule } from '../../src/portfolio/portfolio.module';
import { narrowTestModule } from '../_support/narrow-boot';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';

// 012 T008 US1 Independent Test (FR-S01): authed GET → 系统默认账户置顶 (虚拟派生, 不落库)
// + 本账号已绑券商按 createdAt asc + 跨账号隔离 (他人行不可见) + clientNo raw 明文 (FR-S07
// 脱敏在客户端); 缺 token / 非 ACTIVE → 401 反枚举 (与 /me 一致路径)。全 boot (PG + Redis +
// Fastify) 亦验 PortfolioModule broker 接线 + throttler 桶注册。
describe('US1 列出券商账户 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'broker-us1-list-jwt-secret-min-32-bytes-ab';
    process.env.SMS_CODE_HMAC_SECRET = 'broker-us1-list-hmac-secret-min-32-bytes-z';

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
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  const nextPhone = () => `+8613810${String(++seq).padStart(6, '0')}`;
  const activeAccount = () =>
    prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
  const listAccounts = (token?: string) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/portfolio/broker-accounts',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  type BrokerItem = {
    id: string;
    brokerCode: string | null;
    brokerName: string;
    clientNo: string | null;
    isDefault: boolean;
    createdAt: string | null;
  };

  it('新账号 (无已绑行) → 200 仅默认账户一条 (isDefault, id=accountId, brokerCode/clientNo=null)', async () => {
    const acc = await activeAccount();
    const res = await listAccounts(jwt.signAccessToken({ accountId: acc.id }));
    expect(res.statusCode).toBe(200);

    const body = res.json() as { accounts: BrokerItem[] };
    expect(body.accounts).toHaveLength(1);
    const def = body.accounts[0];
    expect(def.isDefault).toBe(true);
    expect(def.id).toBe(acc.id.toString());
    expect(def.brokerCode).toBeNull();
    expect(def.clientNo).toBeNull();
    expect(def.createdAt).toBeNull();
    expect(def.brokerName).toBe('默认账户');
  });

  it('本账号 2 已绑 + 他人 1 → 默认置顶 + 本账号 2 按 createdAt asc, 他人不可见, clientNo raw 明文', async () => {
    const me = await activeAccount();
    const other = await activeAccount();

    // 本账号 2 条 (显式 createdAt 控顺序: gfzq 早于 dfcf)。
    await prisma.brokerAccount.create({
      data: {
        accountId: me.id,
        brokerCode: 'gfzq',
        clientNo: '3119000002466',
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    });
    await prisma.brokerAccount.create({
      data: {
        accountId: me.id,
        brokerCode: 'dfcf',
        clientNo: '8800001234',
        createdAt: new Date('2026-06-02T00:00:00.000Z'),
      },
    });
    // 他人 1 条 (跨账号隔离断言不可见)。
    await prisma.brokerAccount.create({
      data: { accountId: other.id, brokerCode: 'htai', clientNo: '9999999999' },
    });

    const res = await listAccounts(jwt.signAccessToken({ accountId: me.id }));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { accounts: BrokerItem[] };

    expect(body.accounts).toHaveLength(3);
    expect(body.accounts[0].isDefault).toBe(true);
    expect(body.accounts[0].id).toBe(me.id.toString());

    const bound = body.accounts.slice(1);
    expect(bound.map((b) => b.brokerCode)).toEqual(['gfzq', 'dfcf']); // createdAt asc
    expect(bound[0].brokerName).toBe('广发证券');
    expect(bound[0].clientNo).toBe('3119000002466'); // raw 明文
    expect(bound[1].clientNo).toBe('8800001234');
    expect(bound.every((b) => b.isDefault === false)).toBe(true);
    // 跨账号隔离: 他人 clientNo 不出现。
    expect(body.accounts.some((b) => b.clientNo === '9999999999')).toBe(false);
  });

  it('缺 token → 401 ProblemDetail (反枚举)', async () => {
    const res = await listAccounts();
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('非 ACTIVE 账号 (FROZEN) → 401 (与缺 token 一致路径, 反枚举不泄露存在性)', async () => {
    const frozen = await prisma.account.create({
      data: { phone: nextPhone(), status: 'FROZEN' },
    });
    const res = await listAccounts(jwt.signAccessToken({ accountId: frozen.id }));
    expect(res.statusCode).toBe(401);
  });
});
