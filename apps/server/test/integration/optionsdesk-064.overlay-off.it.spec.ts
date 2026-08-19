import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupIsolatedStores } from '../_support/isolated-db';
import { AppModule } from '../../src/app/app.module';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { GetLegsUseCase } from '../../src/optionsdesk/get-legs.usecase';
import { GetChainReportUseCase } from '../../src/optionsdesk/get-chain-report.usecase';
import { LEG_TABS } from '../../src/optionsdesk/leg-tab.rules';
import { RECALL_CANDIDATE_CAP } from '../../src/optionsdesk/leg-recall.rules';
import {
  LEG_RETRIEVAL_PORT,
  type LegRetrievalPort,
} from '../../src/optionsdesk/leg-retrieval.port';
import {
  OPTION_SNAPSHOT_READ_PORT,
  type OptionSnapshotBatch,
  type OptionSnapshotPort,
  type OptionSnapshotQuery,
} from '../../src/marketdata/option-snapshot.port';

/**
 * 064 T003 —— **实时开关关态下的逐字节等价** (`FR-009` / `FR-015` / `FR-016` / `SC-005`,
 * `state_branch` 2, plan D6 / D7)。
 *
 * ## 为什么必须要真 PG + 真 DI 容器
 *
 * ① **真 PG**: 本文件要证的是「两个读端点的输出与上线前逐字节相同」。那份输出是**真查询取回的
 *    那批行**一路经召回 / 派生 / 打标组装出来的 —— 假 port 上「逐字节相同」退化成「我塞进去的
 *    夹具原样出来」, 而真正会漂的两处 (adapter 的 dedupe 与组装顺序、spot 取自哪一行) 结构上
 *    照不到。PG 从 `test/_support/isolated-db.ts` 的 `setupIsolatedStores()` 取 (共享 PG 的模板
 *    克隆 + 一个 Redis), 🚫 禁自起 Testcontainers。
 * ② **真 DI 容器**: 「对读取口的调用次数 = 0」这条判据要能在 T004a 接上 overlay 之后**继续**
 *    成立才有意义, 而那时读取口是经 `@Optional() @Inject()` 注入的 —— 可选注入解析不到时会
 *    静默拿到 `undefined`, 于是 overlay 永不发生、所有 `new` 出来的测试照样全绿, 而 prod 上
 *    实时档从此不生效。只有真容器答得了「注进去的到底是不是那个 token」。
 *    📌 `imports` 里 `AppModule` 与 `OptionsdeskModule` **两个都要**: 前者带进全局
 *    `ThrottlerModule` 等根级注册物 (只导 `OptionsdeskModule` 会在 `AccountIdThrottlerGuard`
 *    处解析失败, 与本 feature 无关); 后者是被测的那张接线图。
 *
 * ## 🚨 关态的唯一机器判据是**调用计数**, 不是「看起来没变」
 *
 * `overrideProvider(OPTION_SNAPSHOT_READ_PORT)` 换上一个**计数器**实现: 它一旦被调到, 计数就
 * 不是 0。这是 `FR-016` / `state_branch` 2 的唯一机器化 —— 靠肉眼比对响应永远发现不了「多打了
 * 一次外呼但结果恰好一样」(实时源在收盘后返回的就是同一批收盘值)。
 *
 * ## 基线夹具怎么来的 (golden file)
 *
 * `optionsdesk-064.baseline.json` 是**在 T003 动 src 之前**跑本文件、由
 * `NVY_064_WRITE_BASELINE=1` 写出的一份快照。之后它只读不写: 任何一处输出变了都会在这里逐字符
 * 红。要重新生成 (仅当**蓄意**改变输出契约时) 就带那个 env 再跑一次, 并在 PR 里说明为什么。
 */

/** 计数型读取口替身 —— 关态下它一次都不该被调到。 */
class CountingSnapshotReadPort implements OptionSnapshotPort {
  readonly calls: OptionSnapshotQuery[] = [];

  getSnapshots(query: OptionSnapshotQuery): Promise<OptionSnapshotBatch> {
    this.calls.push(query);
    return Promise.resolve({ asOf: new Date('2026-08-11T17:45:03.000Z'), rows: [] });
  }
}

/** `nx test server` 的 cwd 恒为 `apps/server` (同本目录其余 IT 的 `SERVER_DIR` 体例)。 */
const BASELINE_PATH = join(process.cwd(), 'test/integration/optionsdesk-064.baseline.json');
const WRITE_BASELINE = process.env.NVY_064_WRITE_BASELINE === '1';

/** `bigint` 是 `JSON.stringify` 的硬错; 其余 (Date / Decimal) 各自的 `toJSON` 已经稳定。 */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

describe('064 实时开关关态 · 逐字节等价 (Testcontainers PG + Redis, 真 DI 容器)', () => {
  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let readPort: CountingSnapshotReadPort;

  /** 请求时刻 = 2026-08-11 ET 16:00 ⇒ 交易所的今天恒为 2026-08-11 (钉住 DTE 基准)。 */
  const NOW = new Date('2026-08-11T20:00:00.000Z');
  const TODAY = '2026-08-11';
  const PREV_SESSION = '2026-08-10';

  const SYMBOL = 'us:PEP';
  /** 现价取 100 ⇒ 行权价与档位一眼可验。 */
  const SPOT = '100.0000';

  const dateOf = (isoDay: string): Date => new Date(`${isoDay}T00:00:00Z`);

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'optionsdesk-064-overlay-off-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-064-overlay-off-hmac-secret-min-32';
    // 读取口的绑定由 override 决定, 不受本机 env 影响 (且本文件一次外呼都不该发)。
    delete process.env.MARKETDATA_PROVIDER;

    readPort = new CountingSnapshotReadPort();
    moduleRef = await Test.createTestingModule({ imports: [AppModule, OptionsdeskModule] })
      .overrideProvider(OPTION_SNAPSHOT_READ_PORT)
      .useValue(readPort)
      .compile();
    prisma = moduleRef.get(PrismaService);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    readPort.calls.length = 0;
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
    readonly oi: string;
    readonly vol: string;
    readonly iv: string;
  }

  /**
   * 四条腿, 各占一条判别路径 —— 关态基线要覆盖到「进候选」与「被两道门槛各挡一次」两侧,
   * 否则 `gateCounts` 恒 0, 基线里那几个数就是平凡的。
   */
  const LEGS: readonly SeedLeg[] = [
    // 三视角全进 (价外 10%, DTE 落两段重叠区)。
    {
      code: 'L-OK',
      dte: 35,
      strike: '90',
      bid: '2.00',
      ask: '2.10',
      oi: '900',
      vol: '40',
      iv: '20',
    },
    // 只建仓 —— DTE 10 够不到收租段。
    {
      code: 'L-BUILD',
      dte: 10,
      strike: '95',
      bid: '1.50',
      ask: '1.60',
      oi: '300',
      vol: '20',
      iv: '22',
    },
    // 权利金门槛挡下 (removedByPremiumFloor ≥ 1)。
    {
      code: 'L-PENNY',
      dte: 35,
      strike: '80',
      bid: '0.05',
      ask: '0.10',
      oi: '900',
      vol: '40',
      iv: '18',
    },
    // 流动性门槛挡下 (相对价差 3 / 4.5 = 0.667)。
    {
      code: 'L-WIDE',
      dte: 35,
      strike: '85',
      bid: '3.00',
      ask: '6.00',
      oi: '900',
      vol: '40',
      iv: '30',
    },
  ];

  async function seedChain(): Promise<void> {
    const instrument = await prisma.instrument.create({
      data: {
        market: 'us',
        code: 'PEP',
        name: 'PEP Inc.',
        type: 'stock',
        currency: 'USD',
        status: 'active',
        needSync: true,
      },
      select: { id: true },
    });
    for (const leg of LEGS) {
      const expiry = new Date(dateOf(TODAY).getTime() + leg.dte * 86_400_000);
      const contract = await prisma.optionContract.create({
        data: {
          market: 'us',
          code: leg.code,
          root: 'PEP',
          underlyingInstrumentId: instrument.id,
          expiryDate: expiry,
          strikePrice: leg.strike,
          optionType: 'PUT',
          isStandard: true,
          expirationCycle: 'WEEK',
        },
        select: { id: true },
      });
      await prisma.optionDailySnapshot.create({
        data: {
          contractId: contract.id,
          sessionDate: dateOf(TODAY),
          source: 'eod',
          quoteAsOf: new Date(`${TODAY}T20:31:07Z`),
          // 🚨 OI 归属 T−1 —— 与 sessionDate 蓄意不同天 (`FR-004` 的判别性前提)。
          oiAsOf: dateOf(PREV_SESSION),
          bid: leg.bid,
          ask: leg.ask,
          bidSize: '25',
          askSize: '26',
          delta: '-0.30',
          iv: leg.iv,
          openInterest: leg.oi,
          netOpenInterest: '111',
          volume: leg.vol,
          underlyingSpot: SPOT,
          greeksComplete: true,
        },
      });
    }
    await prisma.anchor.create({
      data: {
        ticker: SYMBOL,
        v: '150',
        asof: dateOf('2026-06-30'),
        method: 'dcf',
        confidence: '8',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
      },
    });
  }

  /** 两个读端点的全部输出 —— 选约表三视角各一份 + 链分析报表一份。 */
  async function readBothEndpoints(): Promise<Record<string, unknown>> {
    const legs = moduleRef.get(GetLegsUseCase);
    const report = moduleRef.get(GetChainReportUseCase);
    const out: Record<string, unknown> = {};
    for (const tab of LEG_TABS) out[`legs:${tab}`] = await legs.execute(SYMBOL, tab, NOW);
    out['chain-report'] = await report.execute(SYMBOL, NOW);
    return out;
  }

  // ── 断言 ──────────────────────────────────────────────────────────────────

  it('🚨 `state_branch` 2 / `FR-016`: 两个读端点跑完, 对读取口的调用次数 = 0', async () => {
    await seedChain();
    await readBothEndpoints();
    expect(readPort.calls).toHaveLength(0);
  });

  it('🚨 `FR-009`: 关态下**逐行**与链级的档位均为 `eod_close` (页级一刀切在这里也是绿的, 故还有下一条)', async () => {
    await seedChain();
    const port = moduleRef.get<LegRetrievalPort>(LEG_RETRIEVAL_PORT);

    const chain = await port.retrieveChain({ symbol: SYMBOL, now: NOW, realtime: false });
    if (chain === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(chain.legs.length).toBe(LEGS.length);
    expect(chain.chain.priceKind).toBe('eod_close');
    expect(chain.legs.map((leg) => leg.priceKind)).toEqual(chain.legs.map(() => 'eod_close'));

    // 候选集走的是同一个根 (`loadChain`) ⇒ 两个 port 方法的档位必须同源 (`FR-017` 的前置)。
    const candidates = await port.retrieveCandidates({
      symbol: SYMBOL,
      now: NOW,
      perspectives: LEG_TABS,
      candidateCap: RECALL_CANDIDATE_CAP,
      override: null,
      realtime: false,
    });
    if (candidates === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(candidates.chain.priceKind).toBe('eod_close');
    expect(candidates.candidates.map(({ leg }) => leg.priceKind)).toEqual(
      candidates.candidates.map(() => 'eod_close'),
    );

    expect(readPort.calls).toHaveLength(0);
  });

  it('🚨 `SC-005`: 两个读端点的响应与基线夹具**逐字符**相同', async () => {
    await seedChain();
    const actual = stable(await readBothEndpoints());

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
});
