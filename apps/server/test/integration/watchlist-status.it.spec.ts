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

// 014 T003 全 boot IT — watchlist-status 端点 (覆盖 spec frontmatter state_branches 每条):
//  ① 在自选组 → inWatchlist=true + memberships 含自选组
//  ② 仅自定义组 (systemKind=null) → false 但 memberships 非空 (验 null 纳入, D2)
//  ③ 仅持仓组 → false + 空 (持仓派生排除, 直 prisma seed 因 holdings API 只读)
//  ④ 未加 → false + 空
//  ⑤ 未知 symbol → false + 空 (200 非 404, 反枚举)
//  ⑥ 非法 market → false + 空 (无新 400 分支, D4)
//  反枚举 401 (未认证 / 非 ACTIVE 字节级一致) / 限流 429 (读桶 120/60s)。
// beforeEach redis flushall 隔离限流桶 (读桶 per-account key)。
describe('014 watchlist-status (Testcontainers PG + Redis + Fastify)', () => {
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
    process.env.AUTH_JWT_SECRET = 'watchlist-status-t003-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'watchlist-status-t003-hmac-secret-min-32-byte';

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

  // ── helpers ───────────────────────────────────────────────────────────────
  const nextPhone = () => `+8613814${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const authJson = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });

  interface GroupItem {
    id: string;
    type: 'system' | 'custom';
    systemKind: 'watchlist' | 'holdings' | null;
  }
  interface StatusBody {
    inWatchlist: boolean;
    memberships: Array<{ groupId: string; itemId: string }>;
  }

  const watchlistStatus = (token: string, market: string, code: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/portfolio/instruments/${market}/${code}/watchlist-status`,
      headers: auth(token),
    });
  const createGroup = (token: string, name: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/portfolio/watchlist-groups',
      headers: authJson(token),
      payload: { name },
    });
  const addItem = (token: string, groupId: string, market: string, code: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/portfolio/watchlist-groups/${groupId}/items`,
      headers: authJson(token),
      payload: { market, code },
    });
  const statusOf = (res: { json: () => unknown }) => res.json() as StatusBody;

  // ── ① 在自选组 ─────────────────────────────────────────────────────────────
  it('① 在系统「自选」组 → inWatchlist=true + memberships 含自选组', async () => {
    const { token } = await activeToken();
    await addItem(token, 'watchlist', 'cn', '600519'); // EP7 默认落自选 + materialize

    const body = statusOf(await watchlistStatus(token, 'cn', '600519'));
    expect(body.inWatchlist).toBe(true);
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0]!.groupId).toMatch(/^\d+$/);
    expect(body.memberships[0]!.itemId).toMatch(/^\d+$/);
  });

  // ── ② 仅自定义组 (D2 null 纳入) ───────────────────────────────────────────
  it('② 仅自定义组 (systemKind=null) → inWatchlist=false 但 memberships 非空 (D2)', async () => {
    const { token } = await activeToken();
    const groups = (await createGroup(token, '科技股').then((r) => r.json())) as {
      groups: GroupItem[];
    };
    const custom = groups.groups.find((g) => g.type === 'custom')!;
    await addItem(token, custom.id, 'cn', '000001');

    const body = statusOf(await watchlistStatus(token, 'cn', '000001'));
    expect(body.inWatchlist).toBe(false);
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0]!.groupId).toBe(custom.id);
  });

  // ── ③ 仅持仓组 (持仓派生排除) ─────────────────────────────────────────────
  it('③ 仅持仓组 → false + 空 (持仓派生排除)', async () => {
    const { id, token } = await activeToken();
    // holdings 组 API 只读 (EP7 → 422), 直 prisma seed 构造「仅持仓组」态。
    const hold = await prisma.group.create({
      data: { accountId: id, name: '持仓', type: 'system', systemKind: 'holdings', order: 1 },
    });
    await prisma.watchlistItem.create({
      data: { groupId: hold.id, market: 'cn', code: '601318', order: 0 },
    });

    const body = statusOf(await watchlistStatus(token, 'cn', '601318'));
    expect(body.inWatchlist).toBe(false);
    expect(body.memberships).toEqual([]);
  });

  // ── ④ 未加 ─────────────────────────────────────────────────────────────────
  it('④ 未加该标的 → false + 空', async () => {
    const { token } = await activeToken();
    await addItem(token, 'watchlist', 'cn', '600519'); // 加了别的

    const body = statusOf(await watchlistStatus(token, 'cn', '000333'));
    expect(body.inWatchlist).toBe(false);
    expect(body.memberships).toEqual([]);
  });

  // ── ⑤ 未知 symbol → 200 非 404 (反枚举) ───────────────────────────────────
  it('⑤ 未知 symbol → 200 { false, [] } 非 404', async () => {
    const { token } = await activeToken();
    const res = await watchlistStatus(token, 'cn', '999999');
    expect(res.statusCode).toBe(200);
    expect(statusOf(res)).toEqual({ inWatchlist: false, memberships: [] });
  });

  // ── ⑥ 非法 market → 200 空 (无新 400 分支, D4) ────────────────────────────
  it('⑥ 非法 market → 200 { false, [] } (无行匹配, 不报枚举)', async () => {
    const { token } = await activeToken();
    const res = await watchlistStatus(token, 'xx', '600519');
    expect(res.statusCode).toBe(200);
    expect(statusOf(res)).toEqual({ inWatchlist: false, memberships: [] });
  });

  // ── 反枚举 401 (未认证 / 非 ACTIVE 字节级一致) ─────────────────────────────
  it('未认证 vs 非 ACTIVE → 均 401 字节级一致 (反枚举)', async () => {
    const frozen = await prisma.account.create({ data: { phone: nextPhone(), status: 'FROZEN' } });
    const frozenToken = jwt.signAccessToken({ accountId: frozen.id });

    const noAuth = await app.inject({
      method: 'GET',
      url: '/api/v1/portfolio/instruments/cn/600519/watchlist-status',
    });
    const nonActive = await watchlistStatus(frozenToken, 'cn', '600519');
    expect(noAuth.statusCode).toBe(401);
    expect(nonActive.statusCode).toBe(401);
    const strip = (raw: string) => {
      const { traceId, ...rest } = JSON.parse(raw) as Record<string, unknown>;
      void traceId;
      return rest;
    };
    expect(strip(noAuth.body)).toEqual(strip(nonActive.body));
  });

  // ── 限流 429 (读桶 120/60s) ────────────────────────────────────────────────
  it('限流: GET 第 121 次 → 429 (读桶 120/60s)', async () => {
    const { token } = await activeToken();
    let last;
    for (let i = 0; i < 121; i += 1) last = await watchlistStatus(token, 'cn', '600519');
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });
});
