import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupEmptyDb } from '../_support/isolated-db';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaService } from '../../src/security/prisma.service';

const SERVER_DIR = process.cwd();
const MONO_ROOT = resolve(SERVER_DIR, '../..');

// 047 T009 Phase 1 schema IT: marketdata M2b 三张期权链新表 + optionsdesk 锚表两列 + 三行
// 维度 seed (expand-only, ADR-0035) —— **必须真 PG**: 本条被测对象**就是 `migrate deploy` 的
// 产物本身** (DDL 落没落 / 唯一约束真不真拦 / nullable 到底 nullable 不 / 有没有多出一列 /
// seed 行在不在册)，这些在任何 mock 或 schema.prisma 静态读取里都不存在 ⇒ 取 `setupEmptyDb()`
// (三入口中「自己跑 migrate deploy 并验证其产物」那一个; 换成 setupIsolatedDb 的模板克隆会把
// 被测对象整个抽掉, **而且不会红、也不会变慢** —— 只是悄悄不再验证任何东西)。
//
// 验 ① 三表落 marketdata schema ② 锚表两列在册且 **nullable 无默认值** (FR-017: 默认任何
// 一档 = 替人做方向性假设) ③ 三个唯一键**真生效** (重复插撞 P2002 —— 唯一键即采集侧幂等的
// 语义载体, 同日重跑零翻倍靠它) ④ **快照三个时点列可各自独立取值** (`oi_as_of ≠ session_date`
// 的行可落库, plan D-DATA-4 的结构前提) ⑤ **合约表无「是否已到期」列** (FR-028a 反向断言)
// ⑥ 三行 SyncDimension seed 在册 ⑦ check-server-moat 0 违规。
// 纯数据层形态验证 —— 采集行为 (工作集闸 / A′ 日期 / 硬门 / vendor 降级) 归 T015 / T016 / T017。
describe('047 optionsdesk M2b schema expand (Testcontainers PG migrate deploy)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupEmptyDb>>;
  let instrumentId: bigint;
  let contractId: bigint;

  beforeAll(async () => {
    db = await setupEmptyDb();
    process.env.DATABASE_URL = db.databaseUrl;

    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: SERVER_DIR,
      env: process.env,
      stdio: 'inherit',
    });

    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();

    // 合约表 / 财报表都是 intra FK → instrument, 先落宿主行 (us 锚定标的形态)。
    const inst = await prisma.instrument.create({
      data: {
        market: 'us',
        code: 'PEP',
        name: 'PepsiCo',
        type: 'stock',
        currency: 'USD',
        status: 'active',
      },
      select: { id: true },
    });
    instrumentId = inst.id;
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  it('三张新表落 marketdata schema', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'marketdata'
          AND table_name IN ('option_contract', 'option_daily_snapshot', 'earnings_event')
        ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'earnings_event',
      'option_contract',
      'option_daily_snapshot',
    ]);
  });

  it('🚫 锚表两列在册且 nullable、**无默认值** (FR-017: 默认任何一档 = 替人做方向性假设)', async () => {
    const cols = await prisma.$queryRawUnsafe<
      { column_name: string; is_nullable: string; column_default: string | null }[]
    >(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'optionsdesk' AND table_name = 'anchor'
          AND column_name IN ('position_bucket_manual', 'position_bucket_set_at')
        ORDER BY column_name`,
    );
    // DDL 里若给了 DEFAULT, 「未选」这个常驻分支就永远不出现, 而读表侧一切正常、不会红。
    expect(
      cols.map((c) => `${c.column_name}:${c.is_nullable}:${c.column_default ?? 'null'}`),
    ).toEqual(['position_bucket_manual:YES:null', 'position_bucket_set_at:YES:null']);
  });

  it('🚫 合约表**无「是否已到期」列**, 也无合约乘数列 (FR-028a / FR-028 反向断言)', async () => {
    // expiry_date 本身就是权威判据, 再存一份布尔即双写必 drift; 乘数则表达不了非标合约的
    // 「整股 + 零碎股现金找零 + 特别现金分配」混合物。两者都是**加了也不会红**的列 ⇒ 这里
    // 钉死整张表的列集, 让任何多出来的列当场撞红 (比 NOT LIKE 之类的模糊断言拦得住更多形态)。
    const cols = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'marketdata' AND table_name = 'option_contract'
        ORDER BY column_name`,
    );
    expect(cols.map((c) => c.column_name)).toEqual([
      'code',
      'created_at',
      'expiration_cycle',
      'expiry_date',
      'id',
      'is_standard',
      'market',
      'option_type',
      'root',
      'settlement_mode',
      'strike_price',
      'underlying_instrument_id',
      'updated_at',
    ]);
  });

  it('option_contract 唯一键 (market, code) 真拦: 重复插撞 P2002', async () => {
    // ⚠️ Prisma 的 `@@unique(map: ...)` 建的是**唯一索引**而非 table constraint ⇒ 查 pg_indexes,
    // information_schema.table_constraints 看不见它 (查错表会得到「零约束」的假阴性, 045 已踩)。
    const idx = await prisma.$queryRawUnsafe<{ tablename: string; indexdef: string }[]>(
      `SELECT tablename, indexdef FROM pg_indexes
        WHERE schemaname = 'marketdata'
          AND tablename IN ('option_contract', 'option_daily_snapshot', 'earnings_event')
          AND indexdef LIKE 'CREATE UNIQUE INDEX%'
          AND indexname LIKE 'uk_%'
        ORDER BY tablename`,
    );
    expect(idx).toHaveLength(3);
    expect(idx[0]?.indexdef).toContain('(instrument_id, earnings_date)');
    expect(idx[1]?.indexdef).toContain('(market, code)');
    expect(idx[2]?.indexdef).toContain('(contract_id, session_date, source)');

    const seed = {
      market: 'us',
      code: 'US.PEP260918P130000',
      root: 'PEP',
      underlyingInstrumentId: instrumentId,
      expiryDate: new Date('2026-09-18T00:00:00Z'),
      strikePrice: '130.0000',
      optionType: 'PUT',
      expirationCycle: 'monthly',
      settlementMode: 'physical',
      isStandard: true,
    };
    const created = await prisma.optionContract.create({ data: seed, select: { id: true } });
    contractId = created.id;

    const dup = await prisma.optionContract.create({ data: { ...seed, root: 'PEP1' } }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    expect(dup?.code).toBe('P2002');
    // 链发现每日重跑, 幂等 upsert 就建在这条键上 —— 同票同日重跑零翻倍。
    expect(
      await prisma.optionContract.count({ where: { underlyingInstrumentId: instrumentId } }),
    ).toBe(1);
  });

  it('option_contract 采集端两侧全采: 同 (标的, 到期日, 行权价) 的 CALL 与 PUT 各存一行', async () => {
    // plan D-DATA-3 —— 「本片只含认沽」是**呈现面**的话; 唯一键含 code 而 code 自带 C/P,
    // 故双边天然并存。若哪天有人把唯一键收成 (标的, 到期, 行权价), 这条当场红。
    await prisma.optionContract.create({
      data: {
        market: 'us',
        code: 'US.PEP260918C130000',
        root: 'PEP',
        underlyingInstrumentId: instrumentId,
        expiryDate: new Date('2026-09-18T00:00:00Z'),
        strikePrice: '130.0000',
        optionType: 'CALL',
        isStandard: true,
      },
    });
    expect(
      await prisma.optionContract.count({ where: { underlyingInstrumentId: instrumentId } }),
    ).toBe(2);
  });

  it('🚨 快照三个时点列可各自独立取值 —— `oi_as_of ≠ session_date` 的行可落库 (plan D-DATA-4)', async () => {
    // 官方文档明写「美股期权 OI 在**盘前时段**更新」⇒ T 日收盘后采的快照, 其 OI 其实是 T−1 日的。
    // 正常路径 oi_as_of = 上一交易日、盘前补采路径 oi_as_of = session_date ⇒ 两列必须能各自
    // 取值。若 DDL 把它们做成同一列 / 加了「= session_date」的约束, 落库侧会静默把 OI 归错一天,
    // 而**永远不会红** (活跃度排名与 UI 的 asOf 全错一天)。
    const row = await prisma.optionDailySnapshot.create({
      data: {
        contractId,
        sessionDate: new Date('2026-08-04T00:00:00Z'),
        source: 'eod',
        quoteAsOf: new Date('2026-08-04T20:15:32Z'), // 收盘后墙钟, 与两个业务日均不同
        oiAsOf: new Date('2026-08-03T00:00:00Z'), // **上一交易日**
        bid: '1.2000',
        ask: '1.2500',
        delta: '-0.42000000',
        underlyingSpot: '148.7200',
        greeksComplete: true,
      },
    });
    expect(row.sessionDate.toISOString().slice(0, 10)).toBe('2026-08-04');
    expect(row.oiAsOf.toISOString().slice(0, 10)).toBe('2026-08-03');
    expect(row.oiAsOf.getTime()).not.toBe(row.sessionDate.getTime());
    expect(row.quoteAsOf.toISOString()).toBe('2026-08-04T20:15:32.000Z');
    // vendor 未下发的字段一律 null —— 禁 0 冒充 (0 与「没有」在 OI / greeks 上是两回事)。
    expect(row.openInterest).toBeNull();
    expect(row.gamma).toBeNull();
  });

  it('option_daily_snapshot 唯一键 (contract_id, session_date, source) 真拦, 且**来源维度是活的**', async () => {
    const dup = await prisma.optionDailySnapshot
      .create({
        data: {
          contractId,
          sessionDate: new Date('2026-08-04T00:00:00Z'),
          source: 'eod',
          quoteAsOf: new Date('2026-08-04T20:20:00Z'),
          oiAsOf: new Date('2026-08-03T00:00:00Z'),
          greeksComplete: false,
        },
      })
      .then(
        () => null,
        (e: unknown) => e as { code?: string },
      );
    expect(dup?.code).toBe('P2002');

    // FR-040 的第三段**不是纯占位**: 次日盘前兜底补采走 source='premarket_backfill' 另落一行,
    // 与 eod 行并存 (两条路径的 OI vintage 不同, 合并即毁证据)。
    await prisma.optionDailySnapshot.create({
      data: {
        contractId,
        sessionDate: new Date('2026-08-04T00:00:00Z'),
        source: 'premarket_backfill',
        quoteAsOf: new Date('2026-08-05T12:05:00Z'),
        oiAsOf: new Date('2026-08-04T00:00:00Z'), // 盘前补采拿到的 OI 反而是 T 日真值
        greeksComplete: true,
      },
    });
    const rows = await prisma.optionDailySnapshot.findMany({
      where: { contractId, sessionDate: new Date('2026-08-04T00:00:00Z') },
      orderBy: { source: 'asc' },
    });
    expect(rows.map((r) => r.source)).toEqual(['eod', 'premarket_backfill']);
    expect(rows[0]?.oiAsOf.toISOString().slice(0, 10)).toBe('2026-08-03');
    expect(rows[1]?.oiAsOf.toISOString().slice(0, 10)).toBe('2026-08-04');
  });

  it('earnings_event 唯一键 (instrument_id, earnings_date) 真拦 + PIT 三件套默认形态', async () => {
    const seed = {
      instrumentId,
      earningsDate: new Date('2026-10-08T00:00:00Z'),
      pubType: 'BEFORE',
      periodText: '2026Q3',
      epsPredict: '2.310000',
    };
    const created = await prisma.earningsEvent.create({ data: seed });
    // first_seen_at 由 DB 默认落; 未发生改期 ⇒ 另两件为 null (禁拿"改期时刻 = 首见时刻"冒充)。
    expect(created.firstSeenAt).toBeInstanceOf(Date);
    expect(created.dateChangedAt).toBeNull();
    expect(created.prevEarningsDate).toBeNull();
    expect(created.epsActual).toBeNull();

    const dup = await prisma.earningsEvent.create({ data: { ...seed, pubType: 'AFTER' } }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    expect(dup?.code).toBe('P2002');
    // 每日重拉整个前向视野 (FR-034), 零翻倍全靠这条键。
    expect(await prisma.earningsEvent.count({ where: { instrumentId } })).toBe(1);
  });

  it('三行 SyncDimension seed 在册; 快照 hard 依赖链发现 (FR-031)', async () => {
    const dims = await prisma.syncDimension.findMany({
      where: {
        dimensionKey: { in: ['option_contract', 'option_daily_snapshot', 'earnings_event'] },
      },
      orderBy: { dimensionKey: 'asc' },
    });
    expect(dims.map((d) => d.dimensionKey)).toEqual([
      'earnings_event',
      'option_contract',
      'option_daily_snapshot',
    ]);
    expect(dims.every((d) => d.enabled)).toBe(true);
    expect(dims.map((d) => d.marketScope)).toEqual([['us'], ['us'], ['us']]);
    // 🚨 earnings_event 的 priority = 4 而非其余 us 维度的 5 —— 取 5 会让它按 tie-break
    // (priority desc → key 字典序 asc) 插进既有 hard 边 corporate_action → eod_bar 中间,
    // 而 hard 边要求两端在派生全序里相邻 ⇒ **夜间 flow 装配运行期 throw**, 而 seed 本身绿绿的。
    expect(dims[0]?.priority).toBe(4);

    // 无合约表即无从取快照 ⇒ 链发现失败必须断下游 (failParentOnFailure)。这是 migration 侧的
    // 产物断言; 派生侧的拓扑相邻性由 dimension-executor.spec.ts 的守卫承担, 两者对象不同。
    const hard = await prisma.syncDependency.findMany({
      where: { downstream: 'option_daily_snapshot' },
    });
    expect(hard).toEqual([
      expect.objectContaining({
        upstream: 'option_contract',
        downstream: 'option_daily_snapshot',
        mode: 'hard',
      }),
    ]);
  });

  it('check-server-moat 0 违规 (三表 owner 已声明 marketdata)', () => {
    // 漏声明 MODEL_OWNERSHIP → 脚本非零退出 (lefthook + CI 同门); 此处固化为回归网。
    // ⚠️ 诚实标注: 探针只扫**被 src/** 访问**的 model —— 三表接进 executor (T015 / T016 起)
    // 与 optionsdesk 读端 (T021 起, 届时须带 CROSS-CONTEXT-READ) 后本断言才承重,
    // 在此之前是平凡绿。
    expect(() =>
      execFileSync('pnpm', ['tsx', 'scripts/checks/check-server-moat.ts'], {
        cwd: MONO_ROOT,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  }, 120_000);
});
