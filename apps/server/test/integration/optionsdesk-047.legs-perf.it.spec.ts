import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { performance } from 'node:perf_hooks';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedDb } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import { lastClosedSessionCutoff, marketDateFor } from '../../src/marketdata/trading-day-gate';

// 047 T038 ① 选约表读端 perf 档位实测 (plan D-API-1, spec frontmatter `perf_budgets`)。
//
// ## 口径 = 服务端那一段, 所以必须走真 HTTP
//
// 档位定义的是「Fastify 路由 + 守卫 + usecase + PG + 序列化」这一段, **不含网络 RTT 与客户端
// 渲染**。`app.inject()` 恰好就是这一段: 它跑完整 lifecycle (CLS middleware → JwtAuthGuard /
// AccountIdThrottlerGuard → ValidationPipe → Controller → 序列化), 但不经真 socket ⇒ 量到的
// 是端点耗时而不是回环网络。🚫 **MUST NOT 退化成直接 `new GetLegsUseCase(prisma)` 掐表** ——
// 那样守卫与序列化两段就被量丢了, 而本端点的响应体是 150–200 KB JSON, 序列化不是噪声。
//
// ## 为什么本文件不能进默认执行路径 (env-gated 默认 skip)
//
// `nx affected` 全量并行门下有约 75 个 IT 文件同时跑 ⇒ 那里量到的是**本机 CPU 争用**, 不是
// 端点耗时 (`local-verification.md` 已记过同款: `anonymize.us7.it.spec.ts` 全量下 36.9s、单跑
// 3.7s)。⇒ 沿用仓内既有 `RUN_PERF_IT` + `PERF_IT_REPS` 范式 (`timing-defense.p95.it.spec.ts`),
// 默认 skip, 校准时**单跑**:
//
//   RUN_PERF_IT=true pnpm nx test server -- optionsdesk-047.legs-perf.it --skip-nx-cache
//
// ⚠️ `PERF_IT_REPS + PERF_IT_WARMUP` 必须 < 1000: `narrowTestModule` 注册的是宽松单桶
// 1000/60s, 超了会被限流打成 429, 断言当场红 (不会静默把 429 当成「很快」计入样本)。
//
// ## 暖样本: 剔除的是**进程冷启**, 不是慢样本
//
// 前 `PERF_IT_WARMUP` 次请求不计入分布 —— 那几次扛的是 V8 JIT 未热、Prisma 连接池首建连接、
// PG 首次 plan 该查询。留着它们等于把「进程启动一次的一次性成本」摊进稳态分布, 而档位要管的
// 是稳态。🚫 反过来也**MUST NOT** 借「暖机」之名剔任何一个稳态慢样本 —— p95 的全部意义就在
// 尾部, 剔了尾巴这个探针就再也发现不了回归。
//
// ## 数据体量取 730 行 = plan D-API-1 记的实测上界
//
// 730 = PEP 单票单日快照实测行数 (p3b §6.3)。用它而不是随手几十行: 本端点是「数百行 × 多列 +
// 请求时全量派生」, 派生是 O(n), 行数就是这个端点的主成本轴。⇒ **不建全市场规模的库**(那量的
// 是索引选择性, 不是本端点), 但**必须是单票的真实上界**。
const RUN_PERF = process.env.RUN_PERF_IT === 'true';
const REPS = Number.parseInt(process.env.PERF_IT_REPS ?? '200', 10);
const WARMUP = Number.parseInt(process.env.PERF_IT_WARMUP ?? '10', 10);

/** plan D-API-1 的起手档。实测低于它 ⇒ 写回 frontmatter 的是**实测校准值**, 不是本常量。 */
const P50_BUDGET_MS = 150;
const P95_BUDGET_MS = 300;

/** 单票单日快照行数上界 (p3b §6.3 实测 PEP 730)。 */
const LEG_COUNT = 730;

const MS_PER_DAY = 86_400_000;
const SYMBOL = 'us:PEP';
const CODE = 'PEP';
/** V = 150 ⇒ W = 120; spot 132.40 落 [W, V) ⇒ 全部行权价虚值侧 (同 T029 的造数形态)。 */
const V = '150';
const SPOT = '132.4000';

const utcMidnight = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const ymd = (t: number): string => new Date(t).toISOString().slice(0, 10);
const isWeekday = (iso: string): boolean => {
  const dow = new Date(`${iso}T00:00:00.000Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
};

describe.skipIf(!RUN_PERF)('047 T038 选约表读端 perf 档位实测 (真 HTTP, 单跑, 暖样本)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let token: string;

  /**
   * 🚨 全部日期由**跑测时刻**派生, 不写死 —— 端点按「交易所的今天」滤 `expiry > today`,
   * 写死日期的种子会在某天悄悄把 730 行滤成 0 行, 而 0 行当然很快 ⇒ 探针从此永远绿。
   */
  const now = new Date();
  const today = marketDateFor(['us'], now);
  const cutoff = lastClosedSessionCutoff('us', now);

  /** 交易日历: cutoff 往回 90 个日历日内的工作日。最后一个 = 快照归属交易日。 */
  const sessions: string[] = [];
  for (let i = 90; i >= 0; i--) {
    const iso = ymd(Date.parse(`${cutoff}T00:00:00.000Z`) - i * MS_PER_DAY);
    if (isWeekday(iso)) sessions.push(iso);
  }
  const SESSION = sessions[sessions.length - 1];
  /** Guardrail 6: 收盘后采的快照, 其 OI 归属**上一个**交易日。 */
  const OI_SESSION = sessions[sessions.length - 2];

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    process.env.AUTH_JWT_SECRET = 'optionsdesk-047-t038-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-047-t038-hmac-secret-min-32-bytes';
    // 本地 shell 常泄漏 MARKETDATA_PROVIDER=live 与 OSS_* 部署凭据 → 两者的 config 分支要求
    // 整组 env 齐备, 缺一个就在 boot 期 ZodError (CI 干净, 只有本地中招)。
    process.env.MARKETDATA_PROVIDER = 'mock';
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('OSS_')) delete process.env[key];
    }

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: narrowTestModule([OptionsdeskModule]),
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue({ call: () => undefined, quit: () => undefined, on: () => undefined })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      // logger 关掉: 每次请求一行 `request completed` 写 stdout, 200 次的 I/O 会混进被测的
      // 那一段耗时里 (本文件量的是端点, 不是终端)。
      new FastifyAdapter({ logger: false }),
    );
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = moduleRef.get(PrismaService);
    const account = await prisma.account.create({
      data: { phone: '+8613810000047', status: 'ACTIVE' },
    });
    token = moduleRef.get(JwtTokenService).signAccessToken({ accountId: account.id });

    await seedChain();
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    // 本文件的库是 `setupIsolatedDb()` 从模板克隆出来的**独立库**, drop 掉即全部收回 ——
    // 含写进 `marketdata.trading_day` 那 60 余行 (该表逻辑上是全市场共享表, 但这里不是共享库)。
    await db.drop();
  });

  /** 730 行合约 + 同期快照 + 交易日历 + 财报日。走 `createMany` 批量落, 逐行 create 要 1460 次往返。 */
  async function seedChain(): Promise<void> {
    await prisma.tradingDay.createMany({
      data: sessions.map((d) => ({ market: 'us', date: utcMidnight(d) })),
    });
    await prisma.anchor.create({
      data: {
        ticker: SYMBOL,
        v: V,
        asof: utcMidnight(sessions[0]),
        method: 'dcf',
        confidence: '8', // ≥7 ⇒ L2
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
        positionBucketManual: 'gte_two_thirds',
        positionBucketSetAt: now,
      },
    });
    const instrument = await prisma.instrument.create({
      data: {
        market: 'us',
        code: CODE,
        name: 'PepsiCo',
        type: 'stock',
        currency: 'USD',
        status: 'active',
        needSync: true,
      },
      select: { id: true },
    });

    // 12 个到期日 × 61 个行权价 → 取前 730 条。到期日横跨建仓带 (DTE ≤ 14) 到收租带
    // (DTE ∈ [150,365]) 再到 LEAPS, 让三个 Tab 的成员判据与三套活跃度排名都真的算满一遍。
    const offsets = [10, 17, 24, 31, 45, 60, 90, 120, 150, 180, 250, 365];
    const todayMs = Date.parse(`${today}T00:00:00.000Z`);
    const contracts: {
      market: string;
      code: string;
      root: string;
      underlyingInstrumentId: bigint;
      expiryDate: Date;
      strikePrice: string;
      optionType: string;
      isStandard: boolean;
    }[] = [];
    for (const offset of offsets) {
      const expiry = ymd(todayMs + offset * MS_PER_DAY);
      for (let strike = 70; strike <= 130; strike++) {
        if (contracts.length >= LEG_COUNT) break;
        contracts.push({
          market: 'us',
          code: `US.${CODE}${expiry.replaceAll('-', '').slice(2)}P${strike}000`,
          root: CODE,
          underlyingInstrumentId: instrument.id,
          expiryDate: utcMidnight(expiry),
          strikePrice: String(strike),
          optionType: 'PUT',
          isStandard: true,
        });
      }
    }
    await prisma.optionContract.createMany({ data: contracts });

    const created = await prisma.optionContract.findMany({
      where: { underlyingInstrumentId: instrument.id },
      select: { id: true, strikePrice: true },
    });
    await prisma.optionDailySnapshot.createMany({
      data: created.map((c) => {
        // 行权价越高权利金越贵 —— 让年化落在一个有梯度的区间, 四档分档与死档剔除都真的分岔,
        // 而不是 730 行全落同一档 (那会把分档 + 排序这段成本量丢)。
        const premium = 0.4 + Number(c.strikePrice) * 0.05;
        return {
          contractId: c.id,
          sessionDate: utcMidnight(SESSION),
          source: 'eod',
          quoteAsOf: new Date(`${SESSION}T20:31:07.000Z`),
          oiAsOf: utcMidnight(OI_SESSION),
          bid: premium.toFixed(2),
          ask: (premium + 0.1).toFixed(2),
          bidSize: '12',
          askSize: '18',
          last: (premium + 0.05).toFixed(2),
          prevClose: (premium + 0.02).toFixed(2),
          iv: '0.24500000',
          delta: '-0.25000000',
          gamma: '0.01200000',
          vega: '0.09000000',
          theta: '-0.02000000',
          rho: '-0.01500000',
          openInterest: '900',
          netOpenInterest: '120',
          volume: '40',
          turnover: '81000.00',
          underlyingSpot: SPOT,
          greeksComplete: true,
        };
      }),
    });

    // 财报日: 前向视野内两期 —— 收租长腿的「跨财报」打标要真的有东西可跨。
    await prisma.earningsEvent.createMany({
      data: [30, 120].map((offset) => ({
        instrumentId: instrument.id,
        earningsDate: utcMidnight(ymd(todayMs + offset * MS_PER_DAY)),
        pubType: 'AFTER',
      })),
    });
  }

  const call = async (): Promise<{ statusCode: number; elapsedMs: number; body: string }> => {
    const t0 = performance.now();
    const res = await app.inject({
      method: 'GET',
      // 053 FR-001: `perspective` 必填 —— 缺它是 400, 而 400 又小又快, 混进样本会把分布拉绿。
      url: `/api/v1/optionsdesk/underlyings/${SYMBOL}/legs?perspective=all`,
      headers: { authorization: `Bearer ${token}` },
    });
    const elapsedMs = performance.now() - t0;
    return { statusCode: res.statusCode, elapsedMs, body: res.body };
  };

  /** 最近秩法 (`ceil(p·n)` 的 0-based 形式), 与 `timing-defense.p95.it.spec.ts` 同口径。 */
  const percentile = (arr: readonly number[], p: number): number => {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(Math.floor(p * sorted.length), sorted.length - 1);
    return sorted[idx];
  };

  it(`选约表端点 ${LEG_COUNT} 行 × ${REPS} 次暖样本 → p50 / p95 实测`, async () => {
    // 首请求单独断言一次: 它是**冷启样本**, 不进分布, 但契约得是对的 —— 否则后面 200 次可能
    // 全在量一个 404 的耗时 (那当然很快)。
    const first = await call();
    expect(first.statusCode).toBe(200);
    const parsed = JSON.parse(first.body) as { state: string; legs: unknown[] };
    expect(parsed.state).toBe('available');
    expect(parsed.legs).toHaveLength(LEG_COUNT);

    for (let i = 1; i < WARMUP; i++) {
      expect((await call()).statusCode).toBe(200);
    }

    const samples: number[] = [];
    for (let i = 0; i < REPS; i++) {
      const r = await call();
      // 429 / 500 一律不许静默进样本 —— 错误响应又小又快, 混进来会把分布拉绿。
      expect(r.statusCode).toBe(200);
      samples.push(r.elapsedMs);
    }

    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    // p99 不设门, 只作**写回 frontmatter 的原料** —— spec schema 的 `perf_budgets` 要求
    // `p95_ms` + `p99_ms` 两个字段, 而 plan D-API-1 定的起手档是 p50 / p95 那一对。
    const p99 = percentile(samples, 0.99);
    const result = {
      legs: LEG_COUNT,
      warmupDiscarded: WARMUP,
      reps: REPS,
      coldFirstRequest_ms: Number(first.elapsedMs.toFixed(1)),
      min_ms: Number(Math.min(...samples).toFixed(1)),
      p50_ms: Number(p50.toFixed(1)),
      p95_ms: Number(p95.toFixed(1)),
      p99_ms: Number(p99.toFixed(1)),
      max_ms: Number(Math.max(...samples).toFixed(1)),
      responseBytes: Buffer.byteLength(first.body),
      budget_p50_ms: P50_BUDGET_MS,
      budget_p95_ms: P95_BUDGET_MS,
      verdict: p50 <= P50_BUDGET_MS && p95 <= P95_BUDGET_MS ? 'PASS' : 'FAIL',
    };
    console.log('[optionsdesk-047.legs-perf.it] result', JSON.stringify(result));

    expect(p50).toBeLessThanOrEqual(P50_BUDGET_MS);
    expect(p95).toBeLessThanOrEqual(P95_BUDGET_MS);
  }, 600_000);
});
