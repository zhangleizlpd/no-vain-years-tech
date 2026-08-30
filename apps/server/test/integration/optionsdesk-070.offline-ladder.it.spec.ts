import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { setupIsolatedStores } from '../_support/isolated-db';
import { AppModule } from '../../src/app/app.module';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { Prisma } from '../../src/generated/prisma/client';
import { GetLegsUseCase, type LegTableView } from '../../src/optionsdesk/get-legs.usecase';
import {
  LEG_RETRIEVAL_PORT,
  type LegRetrievalPort,
} from '../../src/optionsdesk/leg-retrieval.port';
import {
  TRADING_CALENDAR_PORT,
  type TradingCalendarPort,
} from '../../src/marketdata/trading-calendar.port';
import { MARCH_EXCLUSION_CATEGORIES } from '../../src/optionsdesk/leg-fwd-chain.rules';
import {
  OPTION_SNAPSHOT_READ_PORT,
  type OptionSnapshotBatch,
  type OptionSnapshotPort,
  type OptionSnapshotQuery,
} from '../../src/marketdata/option-snapshot.port';
import {
  MARKET_STATE_PORT,
  type MarketSession,
  type MarketSessionState,
  type MarketStatePort,
} from '../../src/marketdata/market-state.port';

/**
 * 070 (ADR-0068 P4) —— 离线档收租阶梯接线的路径级 IT (T002 十臂)。
 *
 * ## 为什么必须要真 PG + 真 DI 容器
 *
 * 与 069 IT 同一组理由: 门控放宽与剔→标处置全长在「检索层真产物」上 (收盘链装配 / 护栏留痕 /
 * 口径分派), 假 port 上「点亮了」退化成「夹具原样出来」。PG 从 `setupIsolatedStores()` 取,
 * 🚫 禁自起 Testcontainers。
 *
 * 📌 分工: 剔→标处置的四臂在 `leg-recall.rules.spec.ts` (070 T001) 已穷举; 本文件管**接线面**:
 * 门控放宽后判决挂在哪些请求上 (收租 ∧ us, 两档一律)、离线成员不变 (golden)、行为闸三臂
 * (剔→标 / 零外呼 / 零 #12)、回落收盘档点亮、`marchMode` 传导。
 *
 * ## 基线夹具怎么来的 (golden file)
 *
 * `optionsdesk-070.baseline.json` 是**在 T002 动 src 之前** (T001 已合、门控仍是 069 语义) 跑
 * 本文件、由 `NVY_070_WRITE_BASELINE=1` 写出的四视图快照 (us 收租 / us 建仓 / us 全腿 /
 * hk 收租, 全离线)。之后它只读不写: 既有字段任何一处变了都会逐字符红。要重新生成 (仅当**蓄意**
 * 改变输出契约时) 就带那个 env 再跑一次, 并在 PR 里说明为什么。
 */

const REALTIME_AS_OF = new Date('2026-08-11T17:45:03.000Z');

class SpySnapshotReadPort implements OptionSnapshotPort {
  readonly calls: OptionSnapshotQuery[] = [];
  respond: (query: OptionSnapshotQuery) => OptionSnapshotBatch = () => ({
    asOf: REALTIME_AS_OF,
    rows: [],
  });

  getSnapshots(query: OptionSnapshotQuery): Promise<OptionSnapshotBatch> {
    this.calls.push(query);
    return Promise.resolve(this.respond(query));
  }
}

class FakeMarketStatePort implements MarketStatePort {
  session: MarketSession = 'regular';

  getMarketSessions(): Promise<MarketSessionState[]> {
    return Promise.resolve([{ market: 'us', session: this.session }]);
  }
}

/** `nx test server` 的 cwd 恒为 `apps/server` (同本目录其余 IT 的体例)。 */
const BASELINE_PATH = join(process.cwd(), 'test/integration/optionsdesk-070.baseline.json');
const WRITE_BASELINE = process.env.NVY_070_WRITE_BASELINE === '1';

/**
 * 🚨 **`march` (069 既有键, 本片离线从恒 null 转有值) / `marchMode` (本片新增键) /
 * `wideSpreadOpportunity` (071 新增腿级键) 逐个剔除**:
 * 它们是本 feature 的蓄意产出而不是回归。⇒ 基线夹具**保持冻结**在 070 接线之前那一份, 断言退成
 * 「除了这两个蓄意变动的键, 其余逐字符相同」—— 这正是 FR-012「既有字段逐值不变」与 FR-006
 * 「成员集恒等」的机器化 (`legs` 数组含在其中 ⇒ 行集合与行序一并钉死)。
 * 🚫 **MUST NOT 改成重新生成一份基线** —— 重生成会把「既有字段的值有没有被改动」这个问题一起
 * 抹掉 (新旧两份都是本次跑出来的, 逐字符自然相同), 而 SC-002 要的正是那个问题的答案。
 */
function stable(value: unknown): string {
  return JSON.stringify(
    value,
    (key, v: unknown) => {
      if (key === 'march' || key === 'marchMode' || key === 'wideSpreadOpportunity')
        return undefined;
      return typeof v === 'bigint' ? v.toString() : v;
    },
    2,
  );
}

describe('070 离线档收租阶梯 (Testcontainers PG + Redis, 真 DI 容器)', () => {
  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let readPort: SpySnapshotReadPort;
  let marketState: FakeMarketStatePort;
  let usecase: GetLegsUseCase;

  /** 请求时刻 = 2026-08-11 ET 12:00 (与 069 IT 同刻 —— 判别面在档位与门控, 不在日历)。 */
  const NOW = new Date('2026-08-11T16:00:00.000Z');
  const TODAY = '2026-08-11';
  const PREV_SESSION = '2026-08-10';
  const SYMBOL = 'us:MCH';
  const HK_SYMBOL = 'hk:MHK';
  const EOD_SPOT = '100.0000';

  const dateOf = (isoDay: string): Date => new Date(`${isoDay}T00:00:00Z`);

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'optionsdesk-070-offline-ladder-jwt-32b';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-070-offline-hmac-32b';
    delete process.env.MARKETDATA_PROVIDER;

    readPort = new SpySnapshotReadPort();
    marketState = new FakeMarketStatePort();
    moduleRef = await Test.createTestingModule({ imports: [AppModule, OptionsdeskModule] })
      .overrideProvider(OPTION_SNAPSHOT_READ_PORT)
      .useValue(readPort)
      .overrideProvider(MARKET_STATE_PORT)
      .useValue(marketState)
      .compile();
    prisma = moduleRef.get(PrismaService);
    usecase = moduleRef.get(GetLegsUseCase);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  }, 180_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await moduleRef?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    readPort.calls.length = 0;
    marketState.session = 'regular';
    await prisma.earningsEvent.deleteMany();
    await prisma.optionDailySnapshot.deleteMany();
    await prisma.optionContract.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.anchorChange.deleteMany();
    await prisma.anchor.deleteMany();
  });

  // ── 造数 ──────────────────────────────────────────────────────────────────

  interface SeedLeg {
    readonly code: string;
    readonly dte: number;
    readonly strike: string;
    readonly bid: string;
    readonly ask: string;
    readonly delta: string;
  }

  /**
   * 与 069 IT 同一张梯 (判别面在门控与处置, 不在梯形状):
   * K=92 三档 (45/90/180d) fwd 全 ≥ φ(good)=0.15 ⇒ 推荐链尾 180d;
   * K=96 两档 (60/120d) 120d fwd < φ ⇒ 推荐 60d; K=88 单档 fwd < φ ⇒ 无合格档。
   */
  const LEGS: readonly SeedLeg[] = [
    { code: 'M-92-45', dte: 45, strike: '92', bid: '2.70', ask: '2.90', delta: '-0.20' },
    { code: 'M-92-90', dte: 90, strike: '92', bid: '4.50', ask: '4.70', delta: '-0.25' },
    { code: 'M-92-180', dte: 180, strike: '92', bid: '7.50', ask: '7.70', delta: '-0.30' },
    { code: 'M-96-60', dte: 60, strike: '96', bid: '3.00', ask: '3.20', delta: '-0.40' },
    { code: 'M-96-120', dte: 120, strike: '96', bid: '5.00', ask: '5.20', delta: '-0.45' },
    { code: 'M-88-60', dte: 60, strike: '88', bid: '1.55', ask: '1.75', delta: '-0.15' },
  ];

  /** 逐腿收盘报价覆盖 (交叉变体用) —— 只动 bid/ask, 其余列与主种子逐值相同。 */
  type QuoteOverride = Readonly<Record<string, { bid: string; ask: string }>>;

  async function seedInstrumentChain(
    market: string,
    code: string,
    ticker: string,
    opts: { snapshots?: boolean; quotes?: QuoteOverride } = {},
  ): Promise<void> {
    const instrument = await prisma.instrument.create({
      data: {
        market,
        code,
        name: `${code} Inc.`,
        type: 'stock',
        currency: market === 'hk' ? 'HKD' : 'USD',
        status: 'active',
        needSync: true,
      },
      select: { id: true },
    });
    for (const leg of LEGS) {
      const expiry = new Date(dateOf(TODAY).getTime() + leg.dte * 86_400_000);
      const contract = await prisma.optionContract.create({
        data: {
          market,
          code: `${code}-${leg.code}`,
          root: code,
          underlyingInstrumentId: instrument.id,
          expiryDate: expiry,
          strikePrice: leg.strike,
          optionType: 'PUT',
          isStandard: true,
          expirationCycle: 'MONTH',
        },
        select: { id: true },
      });
      if (opts.snapshots === false) continue;
      const quote = opts.quotes?.[leg.code] ?? { bid: leg.bid, ask: leg.ask };
      await prisma.optionDailySnapshot.create({
        data: {
          contractId: contract.id,
          sessionDate: dateOf(PREV_SESSION),
          source: 'eod',
          quoteAsOf: new Date(`${PREV_SESSION}T20:31:07Z`),
          oiAsOf: dateOf('2026-08-07'),
          bid: quote.bid,
          ask: quote.ask,
          bidSize: '25',
          askSize: '26',
          delta: leg.delta,
          iv: '21',
          openInterest: '900',
          netOpenInterest: '111',
          volume: '40',
          underlyingSpot: EOD_SPOT,
          greeksComplete: true,
        },
      });
    }
    await prisma.anchor.create({
      data: {
        ticker,
        market,
        v: '150',
        asof: dateOf('2026-06-30'),
        method: 'dcf',
        confidence: '8',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
        intradayPrice: EOD_SPOT,
        intradayAt: new Date(NOW.getTime() - 10_000),
      },
    });
  }

  const seedChain = (opts: { snapshots?: boolean; quotes?: QuoteOverride } = {}) =>
    seedInstrumentChain('us', 'MCH', SYMBOL, opts);
  const seedHkChain = () => seedInstrumentChain('hk', 'MHK', HK_SYMBOL);

  const view = (
    symbol: string,
    perspective: 'all' | 'build' | 'rent',
    realtime = false,
  ): Promise<LegTableView> => usecase.execute(symbol, perspective, NOW, null, null, realtime);

  const rent = (realtime = false): Promise<LegTableView> => view(SYMBOL, 'rent', realtime);

  const marchOf = (v: LegTableView, strike: string) =>
    v.march?.find((m) => m.strike.equals(new Prisma.Decimal(strike)));

  /** 与主实例同一批真 DI 依赖、仅 config 换 θ 模式的第二实例 (069 IT 同款体例)。 */
  const thetaUsecase = (): GetLegsUseCase =>
    new GetLegsUseCase(
      prisma,
      moduleRef.get<LegRetrievalPort>(LEG_RETRIEVAL_PORT),
      moduleRef.get<TradingCalendarPort>(TRADING_CALENDAR_PORT),
      { marchPhiTier: 'good', marchMode: 'theta' },
    );

  const readBaseline = (): {
    usRent: { legs: { code: string }[] };
    usBuild: unknown;
    usAll: unknown;
    hkRent: unknown;
  } => {
    expect(
      existsSync(BASELINE_PATH),
      `缺基线夹具 ${BASELINE_PATH} —— 见文件头「golden file」段`,
    ).toBe(true);
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as ReturnType<typeof readBaseline>;
  };

  // ── 十臂 ──────────────────────────────────────────────────────────────────

  it('① us 收盘收租点亮: march 非 null + 三态判决真落 + 每非推荐档恰一条 + 行序零改动 (FR-001/FR-013)', async () => {
    await seedChain();
    const offline = await rent();
    expect(offline.state).toBe('available');
    expect(offline.priceKind).toBe('eod_close');
    expect(offline.march).not.toBeNull();
    expect(offline.march!.map((m) => m.strike.toString())).toEqual(['88', '92', '96']);

    // 三态判决真落 —— 与 069 实时同一批判据在收盘数据上的原生结论 (计划/执行同口径的行为面)。
    const k92 = marchOf(offline, '92')!;
    expect(k92.verdict).toBe('recommended');
    expect(k92.recommendedDteDays).toBe(180);
    const k96 = marchOf(offline, '96')!;
    expect(k96.verdict).toBe('recommended');
    expect(k96.recommendedDteDays).toBe(60);
    const k96Stop = k96.audits.find((a) => a.dteDays === 120)!;
    expect(k96Stop.category).toBe('fwd_below_phi');
    const k88 = marchOf(offline, '88')!;
    expect(k88.verdict).toBe('no_qualified');

    // SC-004 离线镜像: 每个非推荐档恰一条原因, 类目在 13 类封闭枚举内。
    for (const strikeView of offline.march!) {
      const dtes = offline.legs
        .filter((leg) => leg.strike.equals(strikeView.strike))
        .map((leg) => leg.dteDays);
      for (const dte of dtes) {
        const entries = strikeView.audits.filter((a) => a.dteDays === dte);
        expect(entries).toHaveLength(dte === strikeView.recommendedDteDays ? 0 : 1);
      }
      for (const entry of strikeView.audits) {
        expect(MARCH_EXCLUSION_CATEGORIES).toContain(entry.category);
      }
    }

    // FR-013 排序零改动的机器判据: 行序与门控放宽前 (基线夹具) 逐行相同。
    expect(offline.legs.map((leg) => leg.code)).toEqual(
      readBaseline().usRent.legs.map((leg) => leg.code),
    );
  });

  it('② us 收盘收租 golden: 既有字段逐值不变 + 行集合恒等 (FR-006 成员不变 / FR-012; SC-002)', async () => {
    await seedChain();
    await seedHkChain();
    const actual = stable({
      usRent: await rent(),
      usBuild: await view(SYMBOL, 'build'),
      usAll: await view(SYMBOL, 'all'),
      hkRent: await view(HK_SYMBOL, 'rent'),
    });

    if (WRITE_BASELINE) {
      writeFileSync(BASELINE_PATH, `${actual}\n`, 'utf8');
      return;
    }
    expect(
      existsSync(BASELINE_PATH),
      `缺基线夹具 ${BASELINE_PATH} —— 见文件头「golden file」段`,
    ).toBe(true);
    expect(actual).toBe(readFileSync(BASELINE_PATH, 'utf8').trimEnd());
  });

  it('③ 剔→标行为闸: 交叉腿行保留 + 审计 #1 + 净链除名; 全梯交叉 ⇒ 整梯无可成交且全部行可见 (FR-006/FR-007)', async () => {
    await seedChain({
      quotes: {
        // K=92 中档交叉 (ask < bid) —— 净链除名后推荐档在剩余两档上重定。
        'M-92-90': { bid: '4.50', ask: '4.40' },
        // K=96 全梯交叉 —— Edge「净链为空」的离线形态。
        'M-96-60': { bid: '3.00', ask: '2.90' },
        'M-96-120': { bid: '5.00', ask: '4.90' },
      },
    });
    const offline = await rent();

    // (a) 成员不变: 交叉腿保持可见 —— 069 语义下这三行整条消失, 本断言在门控放宽前红。
    const codes = offline.legs.map((leg) => leg.code);
    for (const code of ['MCH-M-92-90', 'MCH-M-96-60', 'MCH-M-96-120']) {
      expect(codes).toContain(code);
    }

    // (b) 净链除名 + #1 留痕: 推荐档计算不含交叉档 —— 漏掉 pool 跳过时交叉档会进阶梯,
    // ladderCount 双计成 4、netChainCount 回到 3, 下面三条当场红。
    const k92 = marchOf(offline, '92')!;
    expect(k92.summary.ladderCount).toBe(3);
    expect(k92.summary.netChainCount).toBe(2);
    expect(k92.summary.removedCount).toBe(1);
    expect(k92.audits.filter((a) => a.category === 'crossed_quote').map((a) => a.dteDays)).toEqual([
      90,
    ]);
    // 净链 [45d, 180d]: 除名**不断链** —— 45→180 并成单段, 其 fwd 仍 ≥ φ ⇒ 延伸到链尾 180d。
    expect(k92.verdict).toBe('recommended');
    expect(k92.recommendedDteDays).toBe(180);

    // (c) 全梯交叉 ⇒ 判整梯无可成交, 审计逐档 #1 带 bid/ask 证据。
    const k96 = marchOf(offline, '96')!;
    expect(k96.verdict).toBe('untradable');
    expect(k96.recommendedDteDays).toBeNull();
    expect(k96.summary.netChainCount).toBe(0);
    expect(k96.audits.map((a) => [a.dteDays, a.category])).toEqual([
      [60, 'crossed_quote'],
      [120, 'crossed_quote'],
    ]);
    for (const entry of k96.audits) {
      expect(entry.evidence.bid).not.toBeNull();
      expect(entry.evidence.ask).not.toBeNull();
    }
  });

  it('④ hk 收租离线: march 恒 null + 响应 golden 零 diff (FR-001 排除 / FR-012)', async () => {
    await seedChain();
    await seedHkChain();
    const hk = await view(HK_SYMBOL, 'rent');
    expect(hk.march).toBeNull();
    expect(hk.marchMode).toBeNull();
    if (!WRITE_BASELINE) {
      expect(stable(hk)).toBe(stable(readBaseline().hkRent));
    }
  });

  it('⑤ 全腿/建仓离线: march 恒 null + golden 零 diff (FR-012)', async () => {
    await seedChain();
    await seedHkChain();
    const build = await view(SYMBOL, 'build');
    const all = await view(SYMBOL, 'all');
    expect(build.march).toBeNull();
    expect(build.marchMode).toBeNull();
    expect(all.march).toBeNull();
    expect(all.marchMode).toBeNull();
    if (!WRITE_BASELINE) {
      const baseline = readBaseline();
      expect(stable(build)).toBe(stable(baseline.usBuild));
      expect(stable(all)).toBe(stable(baseline.usAll));
    }
  });

  it('⑥ 行为闸: 离线请求零 vendor 外呼 (FR-007; 068 计数臂体例)', async () => {
    await seedChain();
    const offline = await rent();
    expect(offline.march).not.toBeNull();
    expect(readPort.calls).toHaveLength(0);
  });

  it('⑦ 行为闸: 离线响应零 #12 带外横档 + 行级带内外标恒缺省 (FR-007 / SC-003)', async () => {
    await seedChain();
    const offline = await rent();
    const categories = offline.march!.flatMap((m) => m.audits.map((a) => a.category));
    expect(categories).not.toContain('band_out');
    expect(offline.legs.map((leg) => leg.bandStatus)).toEqual(offline.legs.map(() => null));
  });

  it('⑧ 实时请求整体回落收盘档 ⇒ march 点亮且口径 = 收盘 (plan §D1 决策臂)', async () => {
    await seedChain();
    marketState.session = 'other';
    const fallback = await rent(true);
    expect(fallback.priceKind).toBe('eod_close');
    expect(fallback.march).not.toBeNull();
    expect(marchOf(fallback, '92')!.verdict).toBe('recommended');
    // 回落态与离线正路同口径同判决 (「回落态呈现即收盘档语义」的机器面)。
    marketState.session = 'regular';
    const offline = await rent(false);
    expect(stable(fallback.march)).toBe(stable(offline.march));
  });

  it('⑨ 无收盘链新锚: 既有空态语义原样 —— march null、不抛错 (state_branch 11)', async () => {
    await seedChain({ snapshots: false });
    const offline = await rent();
    expect(offline.state).toBe('chain_not_ready');
    expect(offline.march).toBeNull();
    expect(offline.marchMode).toBeNull();
  });

  it('⑩ marchMode 传导: 默认 config ⇒ φ; θ config ⇒ θ 且判决 ≡ 年化 argmax (FR-009; state_branch 7)', async () => {
    await seedChain();
    const phiView = await rent();
    expect(phiView.marchMode).toBe('phi');
    expect(marchOf(phiView, '92')!.recommendedDteDays).toBe(180);

    const thetaView = await thetaUsecase().execute(SYMBOL, 'rent', NOW, null, null, false);
    expect(thetaView.marchMode).toBe('theta');
    // θ 判决 ≡ 年化 argmax: K=92 年化 [45d 最大] ⇒ 45d (069 IT 臂⑨ 在离线档的镜像)。
    expect(marchOf(thetaView, '92')!.recommendedDteDays).toBe(45);
    // 模式与判决同步切换 (SC-005 的「标示与判决语义同步」server 半)。
    expect(thetaView.march).not.toBeNull();
  });
});
