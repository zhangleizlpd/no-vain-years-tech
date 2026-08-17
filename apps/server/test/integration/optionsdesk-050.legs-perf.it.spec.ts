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

// 050 T016 选约表读端 perf 档位实测 (SC-007, plan D-TEST-3)。
//
// ## 它与 047 那份的关系: **同一份种子, 同一个档, 量的是新增流水线的代价**
//
// SC-007 的措辞是「端到端**不劣于** 047 基线」⇒ 判别性来自「两边跑的是同一份数据」。故本文件
// 的造数与 `optionsdesk-047.legs-perf.it.spec.ts` **逐字同形** (730 行 / 同样 12 个到期日 /
// 同样的权利金梯度), 档位也照抄那对起手档 —— 唯一的差是端点内部多了三层:
//
//   召回 (每腿 4 道判据) → 打标 (推荐标 + 月度链, 后者带一次跨 ctx 日历读) → 精排 (三个 Tab
//   各算一遍 13 项特征 + min-max 归一化 + 排序)
//
// 🚫 **MUST NOT 为了「跑快点」把种子改小或把到期日收窄** —— 那会让本文件与 047 的读数不可比,
// 而不可比的读数对 SC-007 一点用都没有。
//
// ## 🚨 断言里那几条「不是 perf」的判据是**防退化成空转**
//
// 精排是 `O(候选集)`: 若某天召回坏成空集, 三份列表全空、排序一次都不跑 ⇒ 端点当然很快,
// 而**只断言耗时的探针会给绿灯**。所以首请求那次除了 200 还要验:
//   ① `legs` 730 行 (053 起它**就是**那份精排后的有序列表, `tabOrder` 已退役)
//   ② `matchedCount` 也是 730 —— 截断没在这一发上生效, 量到的是全量精排
//   ③ 至少一条腿 `isMonthlyChain` 为真 (⇒ 那次日历跨 ctx 读真的查到了东西)
// 这三条一起把「量到的是满载」钉住。
//
// ## 为什么本文件不能进默认执行路径 (env-gated 默认 skip)
//
// 同 047 那份: `nx affected` 全量并行门下几十个 IT 同时跑, 那里量到的是本机 CPU 争用而不是端点
// 耗时。⇒ 沿用 `RUN_PERF_IT` + `PERF_IT_REPS` 范式, 默认 skip, 校准时**单跑**:
//
//   RUN_PERF_IT=true pnpm nx test server -- optionsdesk-050.legs-perf.it --skip-nx-cache
//
// ⚠️ `PERF_IT_REPS + PERF_IT_WARMUP` 必须 < 1000: `narrowTestModule` 注册的是宽松单桶
// 1000/60s, 超了会被限流打成 429 (断言当场红, 不会静默把 429 当成「很快」计入样本)。
const RUN_PERF = process.env.RUN_PERF_IT === 'true';
const REPS = Number.parseInt(process.env.PERF_IT_REPS ?? '200', 10);
const WARMUP = Number.parseInt(process.env.PERF_IT_WARMUP ?? '10', 10);

/** = 047 实测档 (`optionsdesk-047.legs-perf.it.spec.ts:53-54`)。本片 MUST NOT 放宽。 */
const P50_BUDGET_MS = 150;
const P95_BUDGET_MS = 300;

/** 单票单日快照行数上界 (p3b §6.3 实测 PEP 730)。 */
const LEG_COUNT = 730;

const MS_PER_DAY = 86_400_000;
const SYMBOL = 'us:PEP';
const CODE = 'PEP';
/** V = 150 ⇒ W = 120; spot 132.40 落 [W, V) ⇒ 全部行权价虚值侧 (同 047 的造数形态)。 */
const V = '150';
const SPOT = '132.4000';

const utcMidnight = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const ymd = (t: number): string => new Date(t).toISOString().slice(0, 10);
const isWeekday = (iso: string): boolean => {
  const dow = new Date(`${iso}T00:00:00.000Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
};

describe.skipIf(!RUN_PERF)('050 T016 选约表读端 perf 档位实测 (真 HTTP, 单跑, 暖样本)', () => {
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
  const todayMs = Date.parse(`${today}T00:00:00.000Z`);

  /** 已收盘那一段: cutoff 往回 90 个日历日内的工作日。最后一个 = 快照归属交易日。 */
  const sessions: string[] = [];
  for (let i = 90; i >= 0; i--) {
    const iso = ymd(Date.parse(`${cutoff}T00:00:00.000Z`) - i * MS_PER_DAY);
    if (isWeekday(iso)) sessions.push(iso);
  }
  const SESSION = sessions[sessions.length - 1];
  /** Guardrail 6: 收盘后采的快照, 其 OI 归属**上一个**交易日。 */
  const OI_SESSION = sessions[sessions.length - 2];

  /**
   * 🚨 **未来那一段日历是 050 才需要的**: 月度链标要查「该月第三个周五是不是交易日」, 窗口一直
   * 跨到链上最晚的到期日 (+365d)。047 的种子只有过去 90 天 ⇒ 那次查询会查到空表, 月度标全 false,
   * **这条流水线就没被量到**。多播 400 天的工作日, 让它满载。
   */
  const forwardDays: string[] = [];
  for (let i = 1; i <= 400; i++) {
    const iso = ymd(todayMs + i * MS_PER_DAY);
    if (isWeekday(iso)) forwardDays.push(iso);
  }

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    process.env.AUTH_JWT_SECRET = 'optionsdesk-050-t016-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-050-t016-hmac-secret-min-32-bytes';
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
      data: { phone: '+8613810000050', status: 'ACTIVE' },
    });
    token = moduleRef.get(JwtTokenService).signAccessToken({ accountId: account.id });

    await seedChain();
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    // 本文件的库是 `setupIsolatedDb()` 从模板克隆出来的**独立库**, drop 掉即全部收回。
    await db.drop();
  });

  /** 730 行合约 + 同期快照 + 交易日历 + 财报日。走 `createMany` 批量落, 逐行 create 要 1460 次往返。 */
  async function seedChain(): Promise<void> {
    await prisma.tradingDay.createMany({
      data: [...sessions, ...forwardDays].map((d) => ({ market: 'us', date: utcMidnight(d) })),
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

    // 12 个到期日 × 61 个行权价 → 取前 730 条 (与 047 那份逐字同形)。050 判据下:
    // 前 5 个到期日 (10–45d) 落建仓段 `[1,49]`, 第 4 个起 (31d–365d) 落收租段 `[30,365]`
    // ⇒ 31d / 45d 两批同时进两个意图 Tab, 三个候选集加起来 1500+ 个排序槽位。
    const offsets = [10, 17, 24, 31, 45, 60, 90, 120, 150, 180, 250, 365];
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
        // 行权价越高权利金越贵 —— 让年化落在一个有梯度的区间, 四档分档、死档剔除与精排的
        // min-max 归一化都真的分岔, 而不是 730 行全落同一档 (那会把这段成本量丢)。
        // 📌 副作用: 最低那档 bid 也有 3.9 ⇒ 权利金门槛一条都挡不下, 相对价差 ≈ 2% ⇒ 流动性
        // 门槛也一条都挡不下。两道门槛是 `O(n)` 逐腿判的, **判出什么结果不改变它跑几次**,
        // 故这不影响读数的代表性 (改成挡下一批反而会让行数与 047 不可比)。
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

  /** 最近秩法 (`ceil(p·n)` 的 0-based 形式), 与 047 那份 / `timing-defense.p95.it.spec.ts` 同口径。 */
  const percentile = (arr: readonly number[], p: number): number => {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(Math.floor(p * sorted.length), sorted.length - 1);
    return sorted[idx];
  };

  interface PerfBody {
    state: string;
    legs: { isMonthlyChain: boolean }[];
    matchedCount: number;
    displayLimit: number | null;
    gateCounts: { removedByPremiumFloor: number; excludedFromIntentTabs: number };
  }

  it(`选约表端点 ${LEG_COUNT} 行 × ${REPS} 次暖样本 → p50 / p95 实测 (SC-007)`, async () => {
    // 首请求单独断言一次: 它是**冷启样本**, 不进分布, 但契约得是对的 —— 否则后面 200 次可能
    // 全在量一个 404 / 空集合的耗时 (那当然很快)。
    const first = await call();
    expect(first.statusCode).toBe(200);
    const parsed = JSON.parse(first.body) as PerfBody;
    expect(parsed.state).toBe('available');

    // 🚨 满载判据 (见文件头): 精排是 O(候选集), 召回坏成空集会让端点变快而**只测耗时的探针
    // 给绿灯**。053 起一次请求只答一个视角 ⇒ 判据落在**被测的那个视角**上 (本探针量的是全腿,
    // 它恒是三者里最大的一份 —— 拿意图视角当满载会低估)。
    // 🚨 **满载看的是 `matchedCount` 而不是 `legs.length`**: 053 的表达层截断落在精排之后 ⇒
    // 本探针量的仍是**全量**召回 + 精排, 屏幕上那段只是末尾的一次 slice。拿 `legs.length` 当
    // 满载判据会在阈值 < 种子规模时恒红, 而端点其实是满载跑的。
    expect(parsed.matchedCount).toBe(LEG_COUNT);
    expect(parsed.legs).toHaveLength(Math.min(LEG_COUNT, parsed.displayLimit ?? LEG_COUNT));
    // 月度链标那次跨 ctx 日历读真的查到了东西 (未来段日历没播的话这条恒 false)。
    expect(parsed.legs.some((l) => l.isMonthlyChain)).toBe(true);

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
    // p99 不设门, 只作**写回 frontmatter 的原料** (spec schema 的 `perf_budgets` 要 p95 + p99,
    // 而档位定的是 p50 / p95 那一对)。
    const p99 = percentile(samples, 0.99);
    const result = {
      legs: LEG_COUNT,
      rankedSlots: parsed.matchedCount,
      displayLimit: parsed.displayLimit,
      gateCounts: parsed.gateCounts,
      monthlyChainLegs: parsed.legs.filter((l) => l.isMonthlyChain).length,
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
    console.log('[optionsdesk-050.legs-perf.it] result', JSON.stringify(result));

    expect(p50).toBeLessThanOrEqual(P50_BUDGET_MS);
    expect(p95).toBeLessThanOrEqual(P95_BUDGET_MS);
  }, 600_000);
});
