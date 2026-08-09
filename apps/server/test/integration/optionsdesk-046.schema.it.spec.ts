import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupEmptyDb } from '../_support/isolated-db';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaService } from '../../src/security/prisma.service';

const SERVER_DIR = process.cwd();
const MONO_ROOT = resolve(SERVER_DIR, '../..');

// 046 T005 Phase 1 Independent Test: marketdata M2a 三张新表 + 两行维度 seed (expand-only,
// ADR-0035) —— **必须真 PG**: 本条被测对象就是 `migrate deploy` 的产物本身 (DDL 落没落 /
// 唯一约束真不真拦 / nullable 到底 nullable 不 / seed 行在不在册)，这些在任何 mock 或
// schema.prisma 静态读取里都不存在 ⇒ 取 `setupEmptyDb()` (三入口中「自己跑 migrate deploy
// 并验证其产物」那一个; 换成 setupIsolatedDb 的模板克隆会把被测对象整个抽掉, 而且不会红)。
//
// 验 ① 三表落 marketdata schema ② 三个唯一键**真生效**(重复插撞 P2002 —— 唯一键即采集侧
// 幂等的语义载体, 同日重跑零翻倍靠它) ③ **VVIX 行 OHLC 可为 null 且不是 0**(FR-025: VVIX
// 只有 CLOSE 一列; 填 0 会让假事实进库且下游分不出「无此列」与「真是 0」) ④ 两行 SyncDimension
// seed 在册且 us_index_daily **无 universe 入边**(FR-027 在依赖图上的形态) ⑤ check-server-moat
// 0 违规。纯数据层形态验证 —— 采集行为 (工作集闸 / A′ 日期 / vendor 降级) 归 T011 / T014。
describe('046 marketdata M2a schema expand (Testcontainers PG migrate deploy)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupEmptyDb>>;
  let instrumentId: bigint;

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

    // 两张标的级表是 intra FK → instrument, 先落宿主行 (us 锚定标的形态: 无锚不采, 故建行
    // 时 needSync 由 universe 写入点决定; 本条只验 schema 不验闸, 取默认即可)。
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
          AND table_name IN ('underlying_iv_daily', 'underlying_iv_history', 'us_index_daily')
        ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'underlying_iv_daily',
      'underlying_iv_history',
      'us_index_daily',
    ]);
  });

  it('唯一键落在预期列上 (uk_* 三条) —— 建错维度不会红, 只会在采集期悄悄翻倍', async () => {
    // ⚠️ Prisma 的 `@@unique(map: ...)` 建的是**唯一索引**而非 table constraint ⇒ 查 pg_indexes,
    // information_schema.table_constraints 看不见它 (查错表会得到「零约束」的假阴性, 045 已踩)。
    const idx = await prisma.$queryRawUnsafe<{ tablename: string; indexdef: string }[]>(
      `SELECT tablename, indexdef FROM pg_indexes
        WHERE schemaname = 'marketdata'
          AND tablename IN ('underlying_iv_daily', 'underlying_iv_history', 'us_index_daily')
          AND indexdef LIKE 'CREATE UNIQUE INDEX%'
          AND indexname LIKE 'uk_%'
        ORDER BY tablename`,
    );
    expect(idx).toHaveLength(3);
    expect(idx[0]?.indexdef).toContain('(instrument_id, date)');
    expect(idx[1]?.indexdef).toContain('(instrument_id, date)');
    // 指数表按 index_code 而非 instrument_id —— 它是指数级, 库里根本没有对应 Instrument 行。
    expect(idx[2]?.indexdef).toContain('(index_code, date)');
  });

  it('underlying_iv_daily 唯一键 (instrument_id, date) 真拦: 重复插撞 P2002', async () => {
    const seed = {
      instrumentId,
      date: new Date('2026-08-03T00:00:00Z'),
      iv: '25.5', // vendor 原样百分数 (25.5 = 25.5%), 落库不二次换算
      ivRank: '51.5',
      ivPercentile: '63.5',
      hv30: '18.42',
      hv30Percentile: '40.1',
    };
    const created = await prisma.underlyingIvDaily.create({ data: seed });
    expect(created.ivPercentile?.toString()).toBe('63.5');
    // vendor 未下发的字段一律 null —— 禁 0 冒充 (0 与「没有」在分位读数上是两回事)。
    expect(created.preIv).toBeNull();
    expect(created.hv365).toBeNull();
    expect(created.callOi).toBeNull();

    const dup = await prisma.underlyingIvDaily
      .create({ data: { ...seed, ivPercentile: '99.9' } })
      .then(
        () => null,
        (e: unknown) => e as { code?: string },
      );
    expect(dup?.code).toBe('P2002');

    // 同日重跑零翻倍 + 冲突方零副作用 —— 采集侧 upsert 幂等就建在这条约束上。
    const rows = await prisma.underlyingIvDaily.findMany({ where: { instrumentId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ivPercentile?.toString()).toBe('63.5');
  });

  it('underlying_iv_history 唯一键 (instrument_id, date) 真拦 + 与日快照互不干涉', async () => {
    const seed = {
      instrumentId,
      date: new Date('2026-08-03T00:00:00Z'),
      iv: '25.41',
      hv: '18.40',
      underlyingPrice: '148.7200',
    };
    await prisma.underlyingIvHistory.create({ data: seed });

    const dup = await prisma.underlyingIvHistory.create({ data: { ...seed, iv: '99' } }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    expect(dup?.code).toBe('P2002');
    expect(await prisma.underlyingIvHistory.count({ where: { instrumentId } })).toBe(1);

    // 同 (instrument, date) 在两张表各存一行是**预期形态**, 不是重复数据: 日快照是 vendor
    // 结论、历史序列是原始序列, 分表正是为了不糊掉「直读 vs 自算」的来源边界 (plan D5)。
    expect(await prisma.underlyingIvDaily.count({ where: { instrumentId } })).toBe(1);
  });

  it('FR-025 VVIX 行只有 close, 其余 OHLC 为 null 而非 0; VIX 行四列齐全', async () => {
    await prisma.usIndexDaily.create({
      data: {
        indexCode: 'VIX',
        date: new Date('2026-07-31T00:00:00Z'),
        open: '19.0700',
        high: '20.8800',
        low: '17.4500',
        close: '20.6600',
      },
    });
    // VVIX 的源 CSV 表头就是 `DATE,VVIX` 单值 —— 没有 OHLC 可填, **禁拿 0 顶位**。
    const vvix = await prisma.usIndexDaily.create({
      data: {
        indexCode: 'VVIX',
        date: new Date('2026-07-31T00:00:00Z'),
        close: '109.4700',
      },
    });
    expect(vvix.close.toString()).toBe('109.47');
    expect(vvix.open).toBeNull();
    expect(vvix.high).toBeNull();
    expect(vvix.low).toBeNull();
    // 反向确认列本身是 nullable 而不是被默认值兜住 —— DDL 里若给了 DEFAULT 0, 上面三条会
    // 变成 0 而不是 null, 这里直接查 DDL 钉死。
    const cols = await prisma.$queryRawUnsafe<
      { column_name: string; is_nullable: string; column_default: string | null }[]
    >(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'marketdata' AND table_name = 'us_index_daily'
          AND column_name IN ('open', 'high', 'low', 'close')
        ORDER BY column_name`,
    );
    expect(
      cols.map((c) => `${c.column_name}:${c.is_nullable}:${c.column_default ?? 'null'}`),
    ).toEqual(['close:NO:null', 'high:YES:null', 'low:YES:null', 'open:YES:null']);
  });

  it('us_index_daily 唯一键 (index_code, date) 真拦 —— 全量文件重放零翻倍', async () => {
    const dup = await prisma.usIndexDaily
      .create({
        data: { indexCode: 'VIX', date: new Date('2026-07-31T00:00:00Z'), close: '99.9999' },
      })
      .then(
        () => null,
        (e: unknown) => e as { code?: string },
      );
    expect(dup?.code).toBe('P2002');
    // 源是覆盖式全量历史文件 (无增量端点) ⇒ 每轮重放整个文件, 幂等全靠这条键。
    expect(await prisma.usIndexDaily.count()).toBe(2);
    const vix = await prisma.usIndexDaily.findFirstOrThrow({ where: { indexCode: 'VIX' } });
    expect(vix.close.toString()).toBe('20.66'); // 冲突方零副作用
  });

  it('两行 SyncDimension seed 在册 (清晨 cron, 两维度不同档); us_index_daily 无 universe 入边', async () => {
    const dims = await prisma.syncDimension.findMany({
      where: { dimensionKey: { in: ['underlying_iv_daily', 'us_index_daily'] } },
      orderBy: { dimensionKey: 'asc' },
    });
    expect(dims.map((d) => d.dimensionKey)).toEqual(['underlying_iv_daily', 'us_index_daily']);
    expect(dims.every((d) => d.enabled)).toBe(true);
    // 两维度都排在前一个 ET 交易日收盘之后的北京清晨, 但**不同档** —— 固定 cron 全年成立:
    //   标的级 06:00 = 18:00 EDT / 17:00 EST, 富途 overview 快照端点届时已就绪;
    //   指数级 10:00 = 22:00 EDT / 21:00 EST, 让开 CBOE 历史 CSV 的发布窗 (18:00, 21:00] ET
    //   —— 排 06:00 会稳定取到不含当日的旧文件 (08-04 首跑实测, migration 20260804_0910)。
    expect(dims[0]?.cronExpr).toBe('0 0 6 * * *');
    expect(dims[1]?.cronExpr).toBe('0 0 10 * * *');
    expect(dims.map((d) => d.marketScope)).toEqual([['us'], ['us']]);
    // 标的级: overview 批量上限 500 codes + his_volatility 滑动窗约 3 年 (首次拉满, FR-024)。
    expect(dims[0]?.batchSize).toBe(500);
    expect(dims[0]?.historyDepth).toBe(1095);
    // 指数级: 覆盖式全量文件, **没有「回填区间」这个概念** ⇒ history_depth 恒 NULL。
    expect(dims[1]?.historyDepth).toBeNull();

    // FR-027 在依赖图上的形态: 标的级挂 universe soft 边 (要 instrument_id); 指数级**无入边**
    // —— 它不读 Instrument, 连一条 universe 边就是把「指数不依赖标的注册」写反了。
    const edges = await prisma.syncDependency.findMany({
      where: { downstream: { in: ['underlying_iv_daily', 'us_index_daily'] } },
    });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      upstream: 'universe',
      downstream: 'underlying_iv_daily',
      mode: 'soft',
    });
  });

  it('check-server-moat 0 违规 (三表 owner 已声明 marketdata)', () => {
    // 漏声明 MODEL_OWNERSHIP → 脚本非零退出 (lefthook + CI 同门); 此处固化为回归网。
    // ⚠️ 诚实标注: 探针只扫**被 src/** 访问**的 model —— 三表接进 executor (T008 / T013 起)
    // 与 optionsdesk 读端 (T015 / T017, 届时须带 CROSS-CONTEXT-READ) 后本断言才承重,
    // 在此之前是平凡绿。
    expect(() =>
      execFileSync('pnpm', ['tsx', 'scripts/checks/check-server-moat.ts'], {
        cwd: MONO_ROOT,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  }, 120_000);
});
