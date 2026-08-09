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

// 023 T004 全 boot IT — 契约面 (PR-1) 校验/回显, 覆盖 spec state_branches「创建校验」+
// 「混类 AND」配置侧 (求值条目归 PR-2 T012):
//  ① 混类 AND 建档 (PE_BELOW 直比 + NEW_LOW 窗口) → 201 → EP1/EP2 回显 param/threshold
//    (带参条件 threshold=null / 直比条件 param=0 sentinel, plan D3) /
//  ② 创建校验拒 400 + 整批零落库: 词表外 type / param 出白名单 (MA 7) / 无参类型带
//    param / 无参类型带 threshold / 带阈值类型缺 threshold / RSI 阈值出域 (0 与 100,
//    开区间边界) / 同类型同参数重复 (MA20 ×2) /
//  ③ 同类型不同参数共存 (MA5 + MA20, FR-S07 重复键 (type,param)) → 201 两条回显 /
//  ④ EP4 整组替换带参条件 → 回显新 param; 同 type 同 param 替换组内重复 → 400。
// 021 既有 alert-crud.it.spec.ts 零改动跑绿 = FR-S09 验证面 (同跑双文件)。
describe('023 alert indicators CRUD 契约面 (Testcontainers PG + Redis + Fastify)', () => {
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
  const nextPhone = () => `+8613923${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }

  interface ConditionView {
    type: string;
    param: number;
    threshold: string | null;
  }
  interface AlertView {
    id: string;
    market: string;
    code: string;
    conditions: ConditionView[];
    frequency: string;
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

  const alertsOf = (res: { json: () => unknown }) => (res.json() as { alerts: AlertView[] }).alerts;
  const condOf = (a: AlertView, type: string, param?: number) =>
    a.conditions.find((c) => c.type === type && (param === undefined || c.param === param));

  /** 单标的草稿 (conditions 由用例覆盖)。 */
  const body = (conditions: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
    instruments: [{ market: 'cn', code: '603305' }],
    conditions,
    frequency: 'DAILY',
    ...extra,
  });

  const expect400 = (res: { statusCode: number; json: () => unknown }) => {
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('FORM_VALIDATION');
  };

  // ── ① 混类 AND 建档 → EP1/EP2 回显 param/threshold ───────────────────────
  it('① 混类 AND (PE_BELOW 10 + NEW_LOW 60) → 201; EP1/EP2 回显 param sentinel 与 threshold null', async () => {
    const { id, token } = await activeToken();
    const created = await createBatch(
      token,
      body([
        { type: 'PE_BELOW', threshold: 10 },
        { type: 'NEW_LOW', param: 60 },
      ]),
    );
    expect(created.statusCode).toBe(201);
    const [alert] = alertsOf(created);
    expect(alert!.conditions).toHaveLength(2);
    // 直比条件: param 省略 → 0 sentinel 落库回显; threshold Decimal string (015 体例)
    expect(condOf(alert!, 'PE_BELOW')).toEqual({
      type: 'PE_BELOW',
      param: 0,
      threshold: '10.0000',
    });
    // 窗口条件: threshold 禁带 → null 回显
    expect(condOf(alert!, 'NEW_LOW')).toEqual({ type: 'NEW_LOW', param: 60, threshold: null });

    // EP1 个股 / EP2 平铺均回显同 shape
    for (const res of [await listInstrument(token, 'cn', '603305'), await listAll(token)]) {
      const [a] = alertsOf(res);
      expect(condOf(a!, 'NEW_LOW')).toEqual({ type: 'NEW_LOW', param: 60, threshold: null });
      expect(condOf(a!, 'PE_BELOW')!.threshold).toBe('10.0000');
    }
    expect(await prisma.alert.count({ where: { accountId: id } })).toBe(1);
  });

  // ── ② 创建校验条全矩阵 → 400 + 零落库 ────────────────────────────────────
  it('② 词表外 / param 出域 / 无参带 param·threshold / 缺 threshold / RSI 出域 / 同 (type,param) 重复 → 400 零落库', async () => {
    const { id, token } = await activeToken();

    // 词表外类型在 DTO @IsIn 层即拒 (FORM_VALIDATION code 由 main.ts exceptionFactory
    // 映射; 此 IT 用简化 pipe 同其他 IT, 仅断状态 — devices.us1 先例)
    expect(
      (await createBatch(token, body([{ type: 'VWAP_CROSS_UP', param: 20 }]))).statusCode,
    ).toBe(400);

    const cases: Record<string, Record<string, unknown>[]> = {
      'MA param 出白名单 (7∉{5,10,20,60,120,250})': [{ type: 'MA_CROSS_UP', param: 7 }],
      '分位年限出白名单 (10∉{3,5})': [{ type: 'PE_PCTL_BELOW', param: 10, threshold: 20 }],
      '无参类型带 param (MACD 金叉)': [{ type: 'MACD_GOLDEN_CROSS', param: 9 }],
      '无参类型带 threshold (MACD 金叉)': [{ type: 'MACD_GOLDEN_CROSS', threshold: 5 }],
      '带阈值类型缺 threshold (PE_BELOW)': [{ type: 'PE_BELOW' }],
      'RSI 阈值出域下界 (0∉(0,100))': [{ type: 'RSI_OVERSOLD', threshold: 0 }],
      'RSI 阈值出域上界 (100∉(0,100))': [{ type: 'RSI_OVERBOUGHT', threshold: 100 }],
      '同类型同参数重复 (MA20 ×2)': [
        { type: 'MA_CROSS_UP', param: 20 },
        { type: 'MA_CROSS_UP', param: 20 },
      ],
    };
    for (const [label, conditions] of Object.entries(cases)) {
      const res = await createBatch(token, body(conditions));
      expect(res.statusCode, label).toBe(400);
      expect((res.json() as { code: string }).code, label).toBe('FORM_VALIDATION');
    }
    // 任一校验失败整批拒 → 零落库 (021 D5 原子语义沿用)
    expect(await prisma.alert.count({ where: { accountId: id } })).toBe(0);
  });

  // ── ③ 同类型不同参数共存 (重复键 (type,param), FR-S07) ───────────────────
  it('③ 同预警内 MA_CROSS_UP 5 + MA_CROSS_UP 20 → 201 两条共存回显', async () => {
    const { token } = await activeToken();
    const created = await createBatch(
      token,
      body([
        { type: 'MA_CROSS_UP', param: 5 },
        { type: 'MA_CROSS_UP', param: 20 },
      ]),
    );
    expect(created.statusCode).toBe(201);
    const [alert] = alertsOf(created);
    expect(alert!.conditions.map((c) => `${c.type}:${c.param}`).sort()).toEqual([
      'MA_CROSS_UP:20',
      'MA_CROSS_UP:5',
    ]);
    expect(alert!.conditions.every((c) => c.threshold === null)).toBe(true);
  });

  // ── ④ EP4 整组替换带参条件 ───────────────────────────────────────────────
  it('④ PATCH conditions 整组替换 → 新 param 回显; 替换组内同 (type,param) 重复 → 400 原条件不动', async () => {
    const { token } = await activeToken();
    const [alert] = alertsOf(
      await createBatch(token, body([{ type: 'RSI_OVERSOLD', threshold: 30 }])),
    );

    // 整组替换: RSI 30 → MA20 上穿 + 量比 2 倍
    const patched = await patchAlert(token, alert!.id, {
      conditions: [
        { type: 'MA_CROSS_UP', param: 20 },
        { type: 'VOLUME_RATIO_OVER', threshold: 2 },
      ],
    });
    expect(patched.statusCode).toBe(200);
    const after = patched.json() as AlertView;
    expect(after.conditions).toHaveLength(2);
    expect(condOf(after, 'MA_CROSS_UP', 20)).toEqual({
      type: 'MA_CROSS_UP',
      param: 20,
      threshold: null,
    });
    expect(condOf(after, 'VOLUME_RATIO_OVER')!.threshold).toBe('2.0000');

    // 替换组内重复 → 400, 既有条件原样
    expect400(
      await patchAlert(token, alert!.id, {
        conditions: [
          { type: 'NEW_HIGH', param: 250 },
          { type: 'NEW_HIGH', param: 250 },
        ],
      }),
    );
    const refetched = alertsOf(await listInstrument(token, 'cn', '603305'));
    expect(refetched[0]!.conditions.map((c) => c.type).sort()).toEqual([
      'MA_CROSS_UP',
      'VOLUME_RATIO_OVER',
    ]);
  });
});
