import { Logger } from '@nestjs/common';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';
import { PrismaService } from '../../src/security/prisma.service';
import { DbTradingCalendarAdapter } from '../../src/marketdata/db-trading-calendar.adapter';
import { OptionSnapshotCoverageCheck } from '../../src/marketdata/option-snapshot-coverage.check';
import { OptionSnapshotRemediation } from '../../src/marketdata/option-snapshot-remediation';
import { SyncOptionSnapshotUseCase } from '../../src/marketdata/sync-option-snapshot.usecase';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import type {
  OptionSnapshotBatch,
  OptionSnapshotPort,
  OptionSnapshotQuery,
  OptionSnapshotRow,
} from '../../src/marketdata/option-snapshot.port';
import { stubTradingCalendar } from '../_support/trading-calendar-stub';

// 047 T023 完整性核对 + 两级自动补救 IT (FR-045/046/052, SC-002 三向 · SC-011 双向)。
//
// ## 为什么**必须**要真 PG
//
// 本文件验的四件事在 mock 上全部**不成立**, 且不会红、只会静默退化成平凡绿:
//   ① **覆盖率的分母是一条跨表 SQL 谓词** —— 「基线日快照 × 到期日 ≥ 当日」是
//      `option_daily_snapshot ⋈ option_contract` 上的连接查询 (Guardrail 7 的 `>=` 就写在
//      那里)。把 `findMany` mock 掉等于把分母当入参喂进去, 「大到期日次日不假红」这条
//      假阳性守卫就退化成同义反复 —— 而它正是本判据换口径的**理由**。
//   ② **两条路径的行在同一张表里共存** —— `(contract_id, session_date, source)` 唯一键让
//      `eod` 与 `premarket_backfill` 同日同合约各留一行 (幂等键第三段, FR-040)。mock 里
//      「补采没有覆盖掉正常行」断言不到, 而覆盖掉才是最坏结局 (真值被兜底值顶掉且无痕)。
//   ③ **降级留痕 MUST 是 SQL 读得到的行状态** —— 本文件用 `$queryRaw` 直接数
//      `source='premarket_backfill'` 的行, **蓄意绕开 app 的任何 API**: T025a 那条探针是
//      独立进程, 只认列不认 log。这条断言在 mock 上无从谈起。
//   ④ **交易日闸读的是真 `trading_day` 表** —— 非交易日两级都不跑 / 「上一交易日」跨周末不是
//      「减一天」, 两者都靠 `DbTradingCalendarAdapter` 的真查询。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 **`setupIsolatedDb()`** 取 (共享 PG 的模板克隆,
// **禁自起 Testcontainers**)。装配 = 直接 new 各 service 打真 `PrismaService` (样板
// `optionsdesk-047.chain-sync.it.spec.ts`)。
//
// 🚨 **⑤⑥ 两个方向都验才算这道防线成立** —— 只验「兜底跑通不告警」证不了它会响, 只验
// 「两级都失败会响」证不了它不乱响; 三向假阳性守卫 (③④) 同理。
describe('047 T023 完整性核对 + 两级补救 (Testcontainers PG, 真判据 + 真日历)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let port: RecordingSnapshotPort;
  let coverage: OptionSnapshotCoverageCheck;
  let remediation: OptionSnapshotRemediation;
  let useCase: SyncOptionSnapshotUseCase;

  /** 2026-06 的 us 交易日 (周末不在表内)。06-19 = **第三个周五 = 月度到期日**。 */
  const TRADING_DAYS = [
    '2026-06-11',
    '2026-06-12',
    '2026-06-15',
    '2026-06-16',
    '2026-06-17',
    '2026-06-18',
    '2026-06-19',
    '2026-06-22',
  ];

  /** 基线日 (周一) 与被核对日 (周二)。 */
  const MON = '2026-06-15';
  const TUE = '2026-06-16';
  /** 月度到期日 (第三个周五) 与其次日 (下周一)。 */
  const EXPIRY_FRI = '2026-06-19';
  const NEXT_MON = '2026-06-22';

  /** 北京 18:00 周三 = ET 周三 06:00 (盘前窗内) ⇒ 待补的是上一交易日 = 周二 06-16。 */
  const PREMARKET_AT = new Date('2026-06-17T10:00:00Z');

  const dateOf = (isoDay: string): Date => new Date(`${isoDay}T00:00:00Z`);
  const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

  /**
   * test-local fake `OPTION_SNAPSHOT_PORT`: 请求的每个合约一行 + 标的自身一行 (spot 的来源)。
   *
   * 🚨 spot 128.40 < K 130 ⇒ PUT 虚值侧过得了落库前硬门 (`ask ≥ 内在价值 − 容差`);
   * 抄成期权价会让整批被拒, 于是「补救到底落没落库」根本走不到。
   */
  class RecordingSnapshotPort implements OptionSnapshotPort {
    readonly calls: OptionSnapshotQuery[] = [];
    /** 这些标的**返空** (vendor 当日不可用): 用来造「两级都失败」。 */
    readonly blackout = new Set<string>();
    asOf = new Date('2026-06-17T10:02:11Z');

    async getSnapshots(query: OptionSnapshotQuery): Promise<OptionSnapshotBatch> {
      this.calls.push({ ...query, contractCodes: [...query.contractCodes] });
      const owner = `US.${query.underlyingSymbol.split(':')[1]}`;
      if (this.blackout.has(query.underlyingSymbol)) {
        // 「一行都没返回」是 vendor 侧的合法状态 (端口契约), 不是异常 —— 缺口由覆盖率核对认。
        return { asOf: this.asOf, rows: [] };
      }
      const rows: OptionSnapshotRow[] = query.contractCodes.map((code) => quoteRow(code, owner));
      rows.push({
        ...quoteRow(owner, owner),
        isOption: false,
        underlyingCode: null,
        last: '128.40',
      });
      return { asOf: this.asOf, rows };
    }
  }

  function quoteRow(code: string, owner: string): OptionSnapshotRow {
    return {
      code,
      isOption: true,
      underlyingCode: owner,
      bid: '2.30',
      ask: '2.40',
      bidSize: '45',
      askSize: '60',
      last: '2.35',
      prevClose: '2.28',
      iv: '21.4',
      delta: '-0.31',
      gamma: '0.041',
      vega: '0.092',
      theta: '-0.058',
      rho: '0.011',
      openInterest: '3120',
      netOpenInterest: '-410',
      volume: '1204',
      turnover: '283940',
      vendorUpdateTime: new Date('2026-06-16T20:00:00Z'),
      greeksComplete: true,
    };
  }

  async function seedInstrument(code: string): Promise<bigint> {
    const row = await prisma.instrument.create({
      data: {
        market: 'us',
        code,
        name: `${code} Inc.`,
        type: 'stock',
        currency: 'USD',
        status: 'active',
        needSync: true,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** 一条合约 (落 `option_contract`); 返回库内 id + vendor code。 */
  async function seedContract(
    instrumentId: bigint,
    root: string,
    expiry: string,
    strike: number,
  ): Promise<{ id: bigint; code: string }> {
    const code = `US.${root}${expiry.replaceAll('-', '').slice(2)}P${strike}000`;
    return prisma.optionContract.create({
      data: {
        market: 'us',
        code,
        root,
        underlyingInstrumentId: instrumentId,
        expiryDate: dateOf(expiry),
        strikePrice: String(strike),
        optionType: 'PUT',
        isStandard: true,
      },
      select: { id: true, code: true },
    });
  }

  /** 一行快照 (直接落库 —— 本文件造的是「昨天有、今天没有」这种**数据形态**)。 */
  async function seedSnapshot(
    contractId: bigint,
    sessionDate: string,
    source = 'eod',
  ): Promise<void> {
    await prisma.optionDailySnapshot.create({
      data: {
        contractId,
        sessionDate: dateOf(sessionDate),
        source,
        quoteAsOf: new Date(`${sessionDate}T20:31:07Z`),
        // 正常路径: OI 归上一交易日 (Guardrail 6)。这里只需一个合法值, 不是被测面。
        oiAsOf: dateOf(sessionDate),
        bid: '2.30',
        ask: '2.40',
        greeksComplete: true,
      },
    });
  }

  /** ERROR log 探针 —— log-based alerting 范式下, 「告警」就是这条 log。 */
  const spyError = (): ReturnType<typeof vi.spyOn> =>
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.optionDailySnapshot.deleteMany();
    await prisma.optionContract.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.tradingDay.deleteMany();
    await prisma.tradingDay.createMany({
      data: TRADING_DAYS.map((d) => ({ market: 'us', date: dateOf(d) })),
    });
    // 🚨 062 T006: 「表里没这一行 ⇒ 真非交易日」现在必须有**覆盖声明**背书 —— 旧的「近窗有别的
    // 行就算填过」这条近似判据已删除。没有这一行, 周末给的是 `unknown` (还没填到) 而非
    // `non-trading`, ⑦ 那条非交易日守卫就验不到它想验的东西。
    await prisma.calendarCoverage.deleteMany();
    await prisma.calendarCoverage.create({
      data: {
        market: 'us',
        coveredFrom: dateOf('2026-06-01'),
        coveredTo: dateOf('2026-06-30'),
        servedBy: 'seed',
      },
    });
    port = new RecordingSnapshotPort();
    coverage = new OptionSnapshotCoverageCheck(prisma, {
      // 先验起手 100%: 「基线日在、当日未到期、当日却没数据」一条都不许有。
      optionCoverageThreshold: 1,
    } as unknown as MarketdataSyncConfig);
    useCase = new SyncOptionSnapshotUseCase(port, prisma, stubTradingCalendar());
    // 🚨 日历走**真** adapter (读 trading_day 表): 「非交易日不跑」与「上一交易日跨周末」
    // 两条都是那张表上的查询, stub 掉就没验。
    remediation = new OptionSnapshotRemediation(
      coverage,
      useCase,
      prisma,
      new DbTradingCalendarAdapter(prisma),
      new SyncRunRecorder(prisma),
    );
  });

  // ── ① 整票缺席 → ERROR (SC-002 第 ① 向) ──
  it('① 整票缺席: 大票全在也盖不住小票整票消失 → ERROR 指名道姓', async () => {
    const pep = await seedInstrument('PEP');
    const vici = await seedInstrument('VICI');
    const pepContracts = [
      await seedContract(pep, 'PEP', '2026-07-17', 130),
      await seedContract(pep, 'PEP', '2026-07-17', 135),
      await seedContract(pep, 'PEP', '2026-07-17', 140),
    ];
    const viciContracts = [
      await seedContract(vici, 'VICI', '2026-07-17', 30),
      await seedContract(vici, 'VICI', '2026-07-17', 32),
    ];
    for (const c of [...pepContracts, ...viciContracts]) await seedSnapshot(c.id, MON);
    // 当日只有 PEP 采到 —— VICI 整票消失。
    for (const c of pepContracts) await seedSnapshot(c.id, TUE);
    const err = spyError();

    const report = await coverage.check('us', TUE);

    expect(report.status).toBe('degraded');
    expect(report.degraded.map((u) => u.symbol)).toEqual(['us:VICI']);
    expect(report.degraded[0]).toMatchObject({ expected: 2, covered: 0 });
    expect(String(err.mock.calls[0][0])).toContain('us:VICI');
    err.mockRestore();
  });

  // ── ② 一批存续合约当日无数据 → ERROR (SC-002 第 ② 向) ──
  it('② 一批存续合约当日无数据 → ERROR 且列出缺的**合约 code**', async () => {
    const pep = await seedInstrument('PEP');
    const contracts = [
      await seedContract(pep, 'PEP', '2026-07-17', 130),
      await seedContract(pep, 'PEP', '2026-07-17', 135),
      await seedContract(pep, 'PEP', '2026-07-17', 140),
    ];
    for (const c of contracts) await seedSnapshot(c.id, MON);
    await seedSnapshot(contracts[0].id, TUE);
    const err = spyError();

    const report = await coverage.check('us', TUE);

    expect(report.degraded[0]).toMatchObject({ symbol: 'us:PEP', expected: 3, covered: 1 });
    expect(report.degraded[0].missingContractCodes.sort()).toEqual(
      [contracts[1].code, contracts[2].code].sort(),
    );
    expect(String(err.mock.calls[0][0])).toContain(contracts[1].code);
    err.mockRestore();
  });

  // ── ③ 回放真实大到期日次日 → 不告警 (SC-002 第 ③ 向, 假阳性守卫) ──
  it('③ 月度到期日 (06-19 第三个周五) 次日: 已到期腿不进分母 → **不**告警', async () => {
    // 换判据前的「逐票总行数 [0.7,1.3]×」在这里必假红: 9 → 3 是 33%。每月一次的假红 =
    // 等于没有告警。逐合约覆盖率对「到期减少」天然免疫 —— 靠的正是分母口径, 不是日期特判。
    const pep = await seedInstrument('PEP');
    const expiring = [
      await seedContract(pep, 'PEP', EXPIRY_FRI, 128),
      await seedContract(pep, 'PEP', EXPIRY_FRI, 130),
      await seedContract(pep, 'PEP', EXPIRY_FRI, 132),
      await seedContract(pep, 'PEP', EXPIRY_FRI, 134),
      await seedContract(pep, 'PEP', EXPIRY_FRI, 136),
      await seedContract(pep, 'PEP', EXPIRY_FRI, 138),
    ];
    const surviving = [
      await seedContract(pep, 'PEP', '2026-07-17', 130),
      await seedContract(pep, 'PEP', '2026-07-17', 135),
      await seedContract(pep, 'PEP', '2026-07-17', 140),
    ];
    // 到期日当天两批都在 (FR-028a: 当日到期的合约当日**仍可**取快照)。
    for (const c of [...expiring, ...surviving]) await seedSnapshot(c.id, EXPIRY_FRI);
    // 次日只剩存续那三条。
    for (const c of surviving) await seedSnapshot(c.id, NEXT_MON);
    const err = spyError();

    const report = await coverage.check('us', NEXT_MON);

    expect(report).toMatchObject({
      status: 'ok',
      baselineDate: EXPIRY_FRI,
      expected: 3,
      covered: 3,
    });
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();

    // 🚨 反向绊线: 判据若写成 `>` (当日到期不进分母), 到期日**当天**的整批缺失会被静默放行。
    await prisma.optionDailySnapshot.deleteMany({ where: { sessionDate: dateOf(EXPIRY_FRI) } });
    for (const c of [...expiring, ...surviving]) await seedSnapshot(c.id, '2026-06-18');
    const onExpiryDay = await coverage.evaluate('us', EXPIRY_FRI);
    expect(onExpiryDay).toMatchObject({ status: 'degraded', expected: 9, covered: 0 });
  });

  // ── ④ 零锚 → 不告警 (state_branch 21) ──
  it('④ 零锚 (链发现未跑 ⇒ 全表无快照) → 判「无对象」而非 0%, 零告警', async () => {
    const pep = await seedInstrument('PEP');
    // 合约表可以有行 (或没有), 关键是**快照一行都没有** —— 分母为空。
    await seedContract(pep, 'PEP', '2026-07-17', 130);
    const err = spyError();

    const report = await coverage.check('us', TUE);

    expect(report).toMatchObject({ status: 'no_subject', baselineDate: null, expected: 0 });
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  // ── ⑤ 收盘后整体失败 + 次日盘前兜底跑通 → 补齐、不升 ERROR、但有痕 (SC-011 正向) ──
  it('⑤ 当日整体失败 → 次日盘前兜底补齐: 不升 ERROR, 但留下 SQL 读得到的降级痕', async () => {
    const pep = await seedInstrument('PEP');
    // ⚠️ 这两条会被**真的重采一遍**, 故行权价必须让 PUT 过得了落库前硬门: spot 128.40 下
    // K=135 的内在价值 6.60 > ask 2.40 ⇒ 整批被 `ask_below_intrinsic` 拒掉, 补救看着就像
    // 「跑了但没补回来」(本文件第一版实撞)。K ≤ 130 时内在价值 ≤ 1.60 < ask, 两侧都过。
    const contracts = [
      await seedContract(pep, 'PEP', '2026-07-17', 125),
      await seedContract(pep, 'PEP', '2026-07-17', 130),
    ];
    for (const c of contracts) await seedSnapshot(c.id, MON);
    // 周二整体失败: 一行都没有。
    const before = await coverage.evaluate('us', TUE);
    expect(before).toMatchObject({ status: 'degraded', expected: 2, covered: 0 });

    const err = spyError();
    const outcome = await remediation.backfillPremarket('us', PREMARKET_AT);

    expect(outcome).toMatchObject({
      level: 'premarket_backfill',
      sessionDate: TUE,
      status: 'recovered',
      attempted: ['us:PEP'],
    });
    // 缺口补上了 ⇒ 不升 ERROR (FR-046: 两级都失败才升)。
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
    expect((await coverage.evaluate('us', TUE)).status).toBe('ok');

    const rows = await prisma.optionDailySnapshot.findMany({
      where: { sessionDate: dateOf(TUE) },
      orderBy: { contractId: 'asc' },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.source).toBe('premarket_backfill');
      // 🚨 Guardrail 6 反向: 盘前 OI 已翻新 ⇒ 正是**被补那天**的真值 (= session_date),
      // 与正常路径的「上一交易日」方向相反。
      expect(dayOf(row.oiAsOf)).toBe(TUE);
      expect(row.quoteAsOf.getTime()).toBe(port.asOf.getTime());
    }

    // 🚨 留痕的权威形态 = **行状态**, 用一条裸 SQL 数出来 (T025a 的探针是独立进程, 不读 log)。
    const [degraded] = await prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM marketdata.option_daily_snapshot
      WHERE source = 'premarket_backfill' AND session_date = DATE '2026-06-16'`;
    expect(degraded.count).toBe(2);
  });

  it('⑤b 一级已补回 → 二级复判达标 ⇒ 零外呼、不留兜底痕 (天天有痕 = 那条痕就废了)', async () => {
    const pep = await seedInstrument('PEP');
    const contracts = [
      await seedContract(pep, 'PEP', '2026-07-17', 130),
      await seedContract(pep, 'PEP', '2026-07-17', 135),
    ];
    for (const c of contracts) {
      await seedSnapshot(c.id, MON);
      await seedSnapshot(c.id, TUE); // 当日正常采到 (= ① 级已补回或本就没缺)
    }

    const outcome = await remediation.backfillPremarket('us', PREMARKET_AT);

    expect(outcome.status).toBe('not_needed');
    expect(port.calls).toHaveLength(0);
    const backfilled = await prisma.optionDailySnapshot.count({
      where: { source: 'premarket_backfill' },
    });
    expect(backfilled).toBe(0);
  });

  // ── ⑥ 两级都失败 → ERROR 且指明哪一票哪一天 (SC-011 反向) ──
  it('⑥ 两级都失败 (vendor 持续返空) → 升 ERROR, 且写明哪一票、哪一天', async () => {
    const pep = await seedInstrument('PEP');
    const vici = await seedInstrument('VICI');
    const pepContracts = [
      await seedContract(pep, 'PEP', '2026-07-17', 130),
      await seedContract(pep, 'PEP', '2026-07-17', 135),
    ];
    const viciContract = await seedContract(vici, 'VICI', '2026-07-17', 30);
    for (const c of [...pepContracts, viciContract]) await seedSnapshot(c.id, MON);
    // 周二 PEP 采到了, VICI 整票失败; 且 vendor 到次日盘前**仍然**给不出 VICI。
    for (const c of pepContracts) await seedSnapshot(c.id, TUE);
    port.blackout.add('us:VICI');
    const err = spyError();

    const outcome = await remediation.backfillPremarket('us', PREMARKET_AT);

    expect(outcome).toMatchObject({
      status: 'still_missing',
      sessionDate: TUE,
      stillMissing: ['us:VICI'],
    });
    // 只补缺的那一票 —— PEP 没被重采 (整轮重跑会给正常票盖上兜底痕)。
    expect(port.calls.map((c) => c.underlyingSymbol)).toEqual(['us:VICI']);
    const logged = err.mock.calls.map((c: unknown[]) => String(c[0])).join(' | ');
    expect(logged).toContain('us:VICI');
    expect(logged).toContain(TUE);
    expect(logged).toContain(viciContract.code);
    err.mockRestore();
    // 补采没落任何 VICI 行 (vendor 返空), 而 PEP 的正常行一字未动。
    expect(await prisma.optionDailySnapshot.count({ where: { sessionDate: dateOf(TUE) } })).toBe(2);
  });

  // ── 非交易日守卫 (与 ③④ 同属「证不了它不乱响」那一半) ──
  it('⑦ 周末跑 ② 级 → 零外呼、零告警 (当日没有 session, 照跑会读成整批缺失)', async () => {
    const pep = await seedInstrument('PEP');
    const contract = await seedContract(pep, 'PEP', '2026-07-17', 130);
    await seedSnapshot(contract.id, MON);
    const err = spyError();

    // 北京 18:00 周六 = ET 周六 06:00; trading_day 没有 06-20 这一行且 06 月已声明覆盖 ⇒ 真非交易日。
    const outcome = await remediation.backfillPremarket('us', new Date('2026-06-20T10:00:00Z'));

    expect(outcome.status).toBe('not_needed');
    expect(port.calls).toHaveLength(0);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
