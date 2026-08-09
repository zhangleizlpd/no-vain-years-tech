import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { AppModule } from '../../src/app/app.module';
import { PrismaService } from '../../src/security/prisma.service';
import { MockSmsGateway } from '../../src/auth/mock-sms.gateway';
import { SMS_GATEWAY } from '../../src/auth/sms-gateway.port';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import type { Redis } from 'ioredis';
import { SendCancelDeletionCodeUseCase } from '../../src/auth/send-cancel-deletion-code.usecase';
import { SmsPurpose } from '../../src/auth/deletion-code.rules';

const TEN_MIN_MS = 10 * 60 * 1000;
const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;
const CANCEL_CODE_URL = '/api/v1/auth/cancel-deletion/sms-codes';

const REPS = Number.parseInt(process.env.PERF_IT_REPS ?? '200', 10);
const RUN_PERF = process.env.RUN_PERF_IT === 'true';

// US4 Independent Test (FR-S07/S08 / SC-S04):
//  ① eligible (FROZEN-in-grace 手机号) → 200 + DB 1 条 active CANCEL_DELETION 码 +
//     mock gateway 收到 CANCEL_DELETION send。
//  ② 4 ineligible (未注册 / ACTIVE / ANONYMIZED / grace 已过) 各 → 200 + 无码行 + 无 send。
//  ③ eligible vs ineligible 响应 body / status / content-type 字节级一致 (反枚举)。
//  ④ [env-gated] 4 ineligible 类 timing P95 diff ≤ 50ms —— 4 类均跑 dummy bcrypt pad,
//     彼此不可区分 (攻击者无法分辨 ineligible 子原因)。
//
// **eligible-vs-ineligible timing 不在此断言**: dummy pad (cost=10 ~80ms) 是按生产
// 真网关 (Aliyun ~80-200ms) 校准的, 用以抹平 eligible 的真实发码时延; mock gateway
// 发码近乎瞬时, 故 mock 下 eligible(~ms) ≪ ineligible(~80ms) 不代表生产时序。本 IT
// 只断言「4 个账号状态枚举向量彼此不可区分」(核心反枚举); eligible-vs-ineligible 的
// 时序对齐属生产网关性质 (镜像 001 timing IT 只比 failure 路径彼此、排除 disclosure)。
describe('US4 撤销发码 反枚举 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let mockSms: MockSmsGateway;
  let sendCancelCode: SendCancelDeletionCodeUseCase;
  let redis: Redis;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'cancel-us4-jwt-secret-min-32-bytes-pad-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'cancel-us4-hmac-secret-min-32-bytes-pad-z';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = moduleRef.get(PrismaService);
    mockSms = moduleRef.get<MockSmsGateway>(SMS_GATEWAY);
    sendCancelCode = moduleRef.get(SendCancelDeletionCodeUseCase);
    redis = moduleRef.get<Redis>(REDIS_CLIENT);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  // 清限流状态: 各 it 独立, 否则前一用例的 5 次 IP 调用吃满 cancel-code-ip 5/60s 预算。
  beforeEach(async () => {
    await redis.flushall();
  });

  const inGrace = () => new Date(Date.now() + FIFTEEN_DAYS_MS);
  const graceExpired = () => new Date(Date.now() - 60 * 60 * 1000);

  function postCancelCode(phone: string) {
    return app.inject({ method: 'POST', url: CANCEL_CODE_URL, payload: { phone } });
  }

  function countCancelCodes(accountId: bigint) {
    return prisma.accountSmsCode.count({
      where: { accountId, purpose: SmsPurpose.CANCEL_DELETION },
    });
  }

  it('eligible 200+1码+send; 4 ineligible 200+无码+无send; 5 响应字节级一致', async () => {
    // 5 类账号 (phone 唯一, 每号仅 1 次调用 → 不撞 1/60s 限流)。
    const eligiblePhone = '+8613800400001';
    const unregisteredPhone = '+8613800400002';
    const activePhone = '+8613800400003';
    const anonymizedPhone = '+8613800400004';
    const graceExpiredPhone = '+8613800400005';

    const eligible = await prisma.account.create({
      data: { phone: eligiblePhone, status: 'FROZEN', freezeUntil: inGrace() },
    });
    const active = await prisma.account.create({
      data: { phone: activePhone, status: 'ACTIVE' },
    });
    // ANONYMIZED phone 保留非 null 以触达 ANONYMIZED 分支 (生产 phone=null→NOT_FOUND,
    // 二者都 ineligible→pad; 此处测 ANONYMIZED 判定路径)。
    const anonymized = await prisma.account.create({
      data: { phone: anonymizedPhone, status: 'ANONYMIZED' },
    });
    const graceGone = await prisma.account.create({
      data: { phone: graceExpiredPhone, status: 'FROZEN', freezeUntil: graceExpired() },
    });

    // ① eligible → 200 + 1 active CANCEL_DELETION 码 + send。
    const before = Date.now();
    const eligibleRes = await postCancelCode(eligiblePhone);
    const after = Date.now();
    expect(eligibleRes.statusCode).toBe(200);

    const codes = await prisma.accountSmsCode.findMany({
      where: { accountId: eligible.id, purpose: SmsPurpose.CANCEL_DELETION },
    });
    expect(codes).toHaveLength(1);
    expect(codes[0]!.usedAt).toBeNull();
    const expiresMs = codes[0]!.expiresAt.getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + TEN_MIN_MS - 10_000);
    expect(expiresMs).toBeLessThanOrEqual(after + TEN_MIN_MS + 10_000);
    expect(mockSms.getLastPurpose(eligiblePhone)).toBe(SmsPurpose.CANCEL_DELETION);
    expect(mockSms.getLastCode(eligiblePhone)).toMatch(/^\d{6}$/);

    // ② 4 ineligible → 200 + 无码 + 无 send。
    const ineligibleResults = [
      { label: '未注册', phone: unregisteredPhone, accountId: null as bigint | null },
      { label: 'ACTIVE', phone: activePhone, accountId: active.id },
      { label: 'ANONYMIZED', phone: anonymizedPhone, accountId: anonymized.id },
      { label: 'grace已过', phone: graceExpiredPhone, accountId: graceGone.id },
    ];
    const ineligibleResponses = [];
    for (const c of ineligibleResults) {
      const res = await postCancelCode(c.phone);
      expect(res.statusCode, c.label).toBe(200);
      if (c.accountId !== null) {
        expect(await countCancelCodes(c.accountId), c.label).toBe(0);
      }
      // 无 send: mock gateway 从未对该号下发。
      expect(mockSms.getLastCode(c.phone), c.label).toBeUndefined();
      ineligibleResponses.push(res);
    }

    // ③ 字节级一致: eligible 与 4 ineligible 的 status / body / content-type 不可区分。
    const all = [eligibleRes, ...ineligibleResponses];
    const baseStatus = all[0]!.statusCode;
    const baseBody = all[0]!.payload;
    const baseCt = all[0]!.headers['content-type'];
    for (const res of all) {
      expect(res.statusCode).toBe(baseStatus);
      expect(res.payload).toBe(baseBody);
      expect(res.headers['content-type']).toBe(baseCt);
    }
  });

  it('非 E.164 手机号 → 422 INVALID_PHONE_FORMAT (先于 eligibility, 不写码不 send)', async () => {
    const res = await postCancelCode('12345');
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.payload) as { code?: string };
    expect(body.code).toBe('INVALID_PHONE_FORMAT');
  });

  const percentile = (arr: number[], p: number): number => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(Math.floor(p * sorted.length), sorted.length - 1)]!;
  };

  // env-gated: 4 ineligible 类彼此 timing P95 diff ≤ 50ms (service 层直测绕 1/60s 限流)。
  // 启动: RUN_PERF_IT=true pnpm nx test server -- cancel.us4-send-code-anti-enum
  it.skipIf(!RUN_PERF)(
    `4 ineligible 类 timing P95 diff ≤ 50ms (service 层, ${REPS} reps)`,
    async () => {
      // 专用 timing 账号 (与功能用例隔离)。
      const tActive = '+8613800401001';
      const tAnon = '+8613800401002';
      const tGrace = '+8613800401003';
      const tUnreg = '+8613800401004';
      await prisma.account.create({ data: { phone: tActive, status: 'ACTIVE' } });
      await prisma.account.create({ data: { phone: tAnon, status: 'ANONYMIZED' } });
      await prisma.account.create({
        data: { phone: tGrace, status: 'FROZEN', freezeUntil: graceExpired() },
      });

      const lat: Record<string, number[]> = { unreg: [], active: [], anon: [], grace: [] };
      const sample = async (bucket: string, phone: string) => {
        const t0 = performance.now();
        await sendCancelCode.execute(phone);
        lat[bucket]!.push(performance.now() - t0);
      };

      for (let i = 0; i < REPS; i++) {
        await sample('unreg', tUnreg);
        await sample('active', tActive);
        await sample('anon', tAnon);
        await sample('grace', tGrace);
      }

      const p95s = Object.fromEntries(
        Object.entries(lat).map(([k, v]) => [k, percentile(v, 0.95)]),
      ) as Record<string, number>;
      const values = Object.values(p95s);
      const diff = Math.max(...values) - Math.min(...values);

      // eslint-disable-next-line no-console
      console.log(
        '[cancel.us4 timing]',
        JSON.stringify({ reps: REPS, p95Ms: p95s, diffMs: diff, threshold: 50 }),
      );
      expect(diff).toBeLessThanOrEqual(50);
    },
    600_000,
  );
});
