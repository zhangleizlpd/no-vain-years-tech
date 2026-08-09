import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AlertModule } from '../../src/alert/alert.module';
import { narrowTestModule } from '../_support/narrow-boot';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';

// 024 T004 全 boot IT — 盘中 5min 类契约面增量 (实时引擎归 PR-2 T011):
//  ① 建含 2 新 5min 类 + 到价类混合预警 → 201 / EP1 个股可见 / EP2 平铺可见 / threshold 回显 string
//  ② EP4 编辑改 threshold (5min 涨超 3% → 5%) → 持久化回显
//  ③ EP5 删除 → 移除
//  ④ threshold 出域 (percent >100) / param 非 0 → 400 零落库
// 021/023 既有 CRUD IT (alert-crud / alert-indicators-crud) 零改动跑绿 (本文件仅加 024 增量)。
describe('024 alert realtime CRUD 契约面 (Testcontainers PG + Redis + Fastify)', () => {
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
    process.env.AUTH_JWT_SECRET = 'alert-t004-jwt-secret-min-32-bytes-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'alert-t004-hmac-secret-min-32-bytes-zyxwv';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: narrowTestModule([AlertModule]),
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
  const nextPhone = () => `+8613914${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }

  interface ConditionView {
    type: string;
    param?: number;
    threshold: string | null;
  }
  interface AlertView {
    id: string;
    market: string;
    code: string;
    conditions: ConditionView[];
    frequency: string;
    note: string | null;
    enabled: boolean;
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const authJson = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });

  const listInstrument = (token: string, market: string, code: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/alert/instruments/${market}/${code}/alerts`,
      headers: auth(token),
    });
  const listAll = (token: string) =>
    app.inject({ method: 'GET', url: '/api/v1/alert/alerts', headers: auth(token) });
  const createBatch = (token: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/alert/alerts', headers: authJson(token), payload });
  const patchAlert = (token: string, id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/alert/alerts/${id}`,
      headers: authJson(token),
      payload,
    });
  const deleteBatch = (token: string, ids: string[]) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/alert/alerts/delete-batch',
      headers: authJson(token),
      payload: { ids },
    });

  const alertsOf = (res: { json: () => unknown }) => (res.json() as { alerts: AlertView[] }).alerts;
  const condOf = (a: AlertView, type: string) => a.conditions.find((c) => c.type === type)!;

  /** 5min 涨超 3% + 5min 跌超 5% + 到价类混合草稿 (3 条件 AND)。 */
  const mixedBody = (code: string, extra: Record<string, unknown> = {}) => ({
    instruments: [{ market: 'cn', code }],
    conditions: [
      { type: 'PRICE_RISE_5MIN_OVER', threshold: 3 },
      { type: 'PRICE_FALL_5MIN_OVER', threshold: 5 },
      { type: 'PRICE_RISE_TO', threshold: 20 },
    ],
    frequency: 'DAILY',
    note: '盘中观察',
    ...extra,
  });

  // ── ① 建混合预警 → EP1/EP2 回显 ─────────────────────────────────────────
  it('① 建 5min 涨超/跌超 + 到价类混合 → 201; EP1 个股可见 / EP2 平铺可见; threshold 回显', async () => {
    const { id, token } = await activeToken();
    const created = await createBatch(token, mixedBody('603305'));
    expect(created.statusCode).toBe(201);
    const [alert] = alertsOf(created);
    expect(alert).toMatchObject({ market: 'cn', code: '603305', enabled: true, note: '盘中观察' });
    expect(alert.conditions).toHaveLength(3);
    expect(condOf(alert, 'PRICE_RISE_5MIN_OVER').threshold).toBe('3.0000');
    expect(condOf(alert, 'PRICE_FALL_5MIN_OVER').threshold).toBe('5.0000');
    expect(condOf(alert, 'PRICE_RISE_TO').threshold).toBe('20.0000');

    // EP1 个股可见
    const ep1 = alertsOf(await listInstrument(token, 'cn', '603305'));
    expect(ep1).toHaveLength(1);
    expect(ep1[0]!.conditions.map((c) => c.type).sort()).toEqual([
      'PRICE_FALL_5MIN_OVER',
      'PRICE_RISE_5MIN_OVER',
      'PRICE_RISE_TO',
    ]);
    // EP2 平铺可见
    expect(alertsOf(await listAll(token))).toHaveLength(1);
    expect(await prisma.alert.count({ where: { accountId: id } })).toBe(1);
  });

  // ── ② 编辑改 threshold ───────────────────────────────────────────────────
  it('② 编辑改 5min 涨超 threshold 3% → 5% → 持久化回显', async () => {
    const { token } = await activeToken();
    const [alert] = alertsOf(await createBatch(token, mixedBody('600519')));

    const patched = await patchAlert(token, alert.id, {
      conditions: [
        { type: 'PRICE_RISE_5MIN_OVER', threshold: 5 },
        { type: 'PRICE_FALL_5MIN_OVER', threshold: 5 },
        { type: 'PRICE_RISE_TO', threshold: 20 },
      ],
    });
    expect(patched.statusCode).toBe(200);
    expect(condOf(patched.json() as AlertView, 'PRICE_RISE_5MIN_OVER').threshold).toBe('5.0000');

    const refetched = alertsOf(await listInstrument(token, 'cn', '600519'));
    expect(condOf(refetched[0]!, 'PRICE_RISE_5MIN_OVER').threshold).toBe('5.0000');
  });

  // ── ③ 删除 ───────────────────────────────────────────────────────────────
  it('③ 删除含 5min 类预警 → 移除 + conditions 级联', async () => {
    const { id, token } = await activeToken();
    const [alert] = alertsOf(await createBatch(token, mixedBody('603305')));

    const res = await deleteBatch(token, [alert.id]);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { deleted: number }).deleted).toBe(1);
    expect(await prisma.alert.count({ where: { accountId: id } })).toBe(0);
    expect(await prisma.alertCondition.count({ where: { alertId: BigInt(alert.id) } })).toBe(0);
  });

  // ── ④ 出域校验 400 零落库 ─────────────────────────────────────────────────
  it('④ 5min threshold>100 / param 非 0 → 400 零落库', async () => {
    const { id, token } = await activeToken();
    const over = await createBatch(
      token,
      mixedBody('603305', { conditions: [{ type: 'PRICE_RISE_5MIN_OVER', threshold: 101 }] }),
    );
    const withParam = await createBatch(
      token,
      mixedBody('603305', {
        conditions: [{ type: 'PRICE_FALL_5MIN_OVER', param: 5, threshold: 3 }],
      }),
    );
    for (const res of [over, withParam]) {
      expect(res.statusCode).toBe(400);
      expect((res.json() as { code: string }).code).toBe('FORM_VALIDATION');
    }
    expect(await prisma.alert.count({ where: { accountId: id } })).toBe(0);
  });
});
