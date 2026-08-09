import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { AppModule } from '../../src/app/app.module';
import { PrismaService } from '../../src/security/prisma.service';
import { SmsCodeStore } from '../../src/auth/sms-code.store';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import type { Redis } from 'ioredis';

const REPS = Number.parseInt(process.env.PERF_IT_REPS ?? '1000', 10);
const RUN_PERF = process.env.RUN_PERF_IT === 'true';

const ACTIVE_PHONE_WRONG = '+8613800139001';
const ACTIVE_PHONE_EXPIRED = '+8613800139002';
const ANONYMIZED_PHONE = '+8613800139003';
const STORED_CODE = '123456';
const WRONG_CODE = '999999';

/**
 * FR-S06 SingleEndpointEnumerationDefenseIT — 1000-rep P95 wall-clock 时延差 ≤ 50ms.
 *
 * Per spec FR-S06 + SC-S03 (post-CL-006 amended) + tasks.md T034 unit baseline:
 *
 *   3 anti-enum 401 paths (timing pad fires 在 throw 401 前):
 *     P1. ACTIVE + 码错: smsCodeRepo.verify 返回 false → pad → 401
 *     P2. ACTIVE + 码过期: smsCodeRepo.verify 返回 null → pad → 401
 *     P3. ANONYMIZED + 任意码: account.isAnonymized() → pad → 401 (verify NOT called)
 *
 *   FROZEN 路径排除 (CL-006 disclosure path, 403 not 401, 单独由 spec D
 *   FrozenAccountStatusDisclosureIT 覆盖,本 IT 不测).
 *
 * 与 T034 unit 测的差别:
 *   - 本 IT 走完整 HTTP 栈 (Fastify + ValidationPipe + Guard + Filter)
 *   - 真 PG + Redis (Testcontainers), 不 mock
 *   - 真 bcrypt cost=10 pad + HMAC-SHA256 SMS code hash (per ADR-0023)
 *   - 阈值 ≤ 50ms (HTTP wall-clock variance > in-process 5ms)
 *
 * **机制说明** (per ADR-0023, 2026-05-18 切换):
 *   - SmsCodeStore 用 HMAC-SHA256 + crypto.timingSafeEqual 替换 bcrypt cost=12
 *   - verify <1ms,3 个反枚举路径(ACTIVE+码错 / ACTIVE+码过期 / ANONYMIZED) 时延均一
 *   - BcryptTimingDefenseExecutor.pad(cost=10) ~80ms 保留作纵深防御抹平 redis.get
 *     抖动 / Phone VO 构造等残余微差
 *   - 历史: mono PR #23 200-rep 实测 diff ≈ 193ms 违反阈值, 根因 = bcrypt verify
 *     ~150ms 单边支配仅 ACTIVE+码错 path. PR #25 (本 PR) 切 HMAC 后预期 diff ≤ 50ms
 *
 * **CI 默认 skip** (env-gated):
 *   - 本 IT 5-10min wall time, CI 不默认跑
 *   - 手动启动: `RUN_PERF_IT=true pnpm nx test server -- timing-defense.p95.it`
 *   - 缩 reps 调试: `RUN_PERF_IT=true PERF_IT_REPS=100 pnpm nx test server -- timing-defense.p95.it`
 *   - 推 Plan 2 加 dedicated nightly slow-IT job
 *
 * **ANONYMIZED phone NOT NULL hack** (per spec.md 2026-05-17 amend (d)):
 *   生产中 phone 应 NULL (per PRD § 5.5), 测试为触达 code path 用 NOT NULL.
 *   生产语义校验待 W3 deferred item 5 修.
 *
 * **authFailureLock 防干扰**: 每 rep 顶 DEL auth-fail / auth-lock keys, 保证 5-strike
 * threshold 不触发 (per FAIL_THRESHOLD=5 in AuthFailureLockService).
 */
describe.skipIf(!RUN_PERF)(
  'FR-S06 SingleEndpointEnumerationDefenseIT — 1000-rep P95 wall-clock',
  () => {
    let app: NestFastifyApplication;
    let prisma: PrismaService;
    let smsCodeStore: SmsCodeStore;
    let redis: Redis;

    let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

    beforeAll(async () => {
      stores = await setupIsolatedStores();
      process.env.DATABASE_URL = stores.databaseUrl;
      process.env.REDIS_URL = stores.redisUrl;
      process.env.AUTH_JWT_SECRET = 'p95-it-jwt-secret-min-32-bytes-pad-abcdef';
      process.env.SMS_CODE_HMAC_SECRET = 'p95-it-hmac-secret-min-32-bytes-pad-zzzzzz';

      const moduleRef: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
      app.setGlobalPrefix('api');
      await app.init();
      await app.getHttpAdapter().getInstance().ready();

      prisma = moduleRef.get(PrismaService);
      smsCodeStore = moduleRef.get(SmsCodeStore);
      redis = moduleRef.get<Redis>(REDIS_CLIENT);

      // Preseed: ACTIVE_WRONG + ACTIVE_EXPIRED + ANONYMIZED accounts.
      await prisma.account.create({
        data: { phone: ACTIVE_PHONE_WRONG, status: 'ACTIVE' },
      });
      await prisma.account.create({
        data: { phone: ACTIVE_PHONE_EXPIRED, status: 'ACTIVE' },
      });
      await prisma.account.create({
        data: { phone: ANONYMIZED_PHONE, status: 'ANONYMIZED' },
      });

      // ACTIVE_WRONG: pre-store correct SMS code (1h TTL). 1000 reps send WRONG_CODE → 401.
      await smsCodeStore.store(ACTIVE_PHONE_WRONG, STORED_CODE, 3600);
      // ACTIVE_EXPIRED: NEVER store SMS code → verify returns null → 码过期 path.
      await smsCodeStore.clear(ACTIVE_PHONE_EXPIRED);
      // ANONYMIZED: code state irrelevant (ANONYMIZED throws before verify).
    }, 180_000);

    afterAll(async () => {
      await app?.close();
      await stores.drop();
    });

    const clearLockKeys = async (): Promise<void> => {
      await redis.del(
        `auth-fail:${ACTIVE_PHONE_WRONG}`,
        `auth-lock:${ACTIVE_PHONE_WRONG}`,
        `auth-fail:${ACTIVE_PHONE_EXPIRED}`,
        `auth-lock:${ACTIVE_PHONE_EXPIRED}`,
        `auth-fail:${ANONYMIZED_PHONE}`,
        `auth-lock:${ANONYMIZED_PHONE}`,
      );
    };

    const callAuth = async (
      phone: string,
      code: string,
    ): Promise<{ statusCode: number; elapsedMs: number }> => {
      const t0 = performance.now();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts/phone-sms-auth',
        payload: { phone, code },
      });
      const elapsedMs = performance.now() - t0;
      return { statusCode: res.statusCode, elapsedMs };
    };

    const percentile = (arr: number[], p: number): number => {
      const sorted = [...arr].sort((a, b) => a - b);
      const idx = Math.min(Math.floor(p * sorted.length), sorted.length - 1);
      return sorted[idx];
    };

    it(`P95 wall-clock 时延差 ≤ 50ms across 3 anti-enum 401 paths (${REPS} reps)`, async () => {
      const lat: {
        activeWrong: number[];
        activeExpired: number[];
        anonymizedAny: number[];
      } = { activeWrong: [], activeExpired: [], anonymizedAny: [] };

      for (let i = 0; i < REPS; i++) {
        await clearLockKeys();

        // P1: ACTIVE + wrong code → 401
        const r1 = await callAuth(ACTIVE_PHONE_WRONG, WRONG_CODE);
        expect(r1.statusCode).toBe(401);
        lat.activeWrong.push(r1.elapsedMs);

        // P2: ACTIVE + expired (no code in redis) → 401
        const r2 = await callAuth(ACTIVE_PHONE_EXPIRED, STORED_CODE);
        expect(r2.statusCode).toBe(401);
        lat.activeExpired.push(r2.elapsedMs);

        // P3: ANONYMIZED + any code → 401 (反枚举吞, pad before verify)
        const r3 = await callAuth(ANONYMIZED_PHONE, STORED_CODE);
        expect(r3.statusCode).toBe(401);
        lat.anonymizedAny.push(r3.elapsedMs);

        if (i % 100 === 0 && i > 0) {
          // eslint-disable-next-line no-console
          console.log(`[timing-defense.p95.it] progress ${i}/${REPS} reps complete`);
        }
      }

      const p95Active = percentile(lat.activeWrong, 0.95);
      const p95Expired = percentile(lat.activeExpired, 0.95);
      const p95Anon = percentile(lat.anonymizedAny, 0.95);

      const p95s = [p95Active, p95Expired, p95Anon];
      const minP95 = Math.min(...p95s);
      const maxP95 = Math.max(...p95s);
      const diff = maxP95 - minP95;

      // eslint-disable-next-line no-console
      console.log(
        '[timing-defense.p95.it] result',
        JSON.stringify({
          reps: REPS,
          p95Active_wrong_ms: p95Active,
          p95Active_expired_ms: p95Expired,
          p95Anonymized_any_ms: p95Anon,
          minP95_ms: minP95,
          maxP95_ms: maxP95,
          diff_ms: diff,
          threshold_ms: 50,
          verdict: diff <= 50 ? 'PASS' : 'FAIL',
        }),
      );

      expect(diff).toBeLessThanOrEqual(50);
    }, 600_000); // 1000 reps × 3 paths × ~100ms each ≈ 5min; allow 10min headroom.
  },
);
