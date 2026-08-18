import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { DIMENSION_KEYS } from '../../src/marketdata/dimension-executor';

// 016 T001 PR1 Independent Test ①②: marketdata 同步配置/审计 3 表 (SyncDimension/
// SyncBlacklist/SyncRun) 在 015 的 6 表之上增量 migrate deploy 干净落库 (唯一键/索引齐全),
// 且 SyncDimension seed 6 维度行存在 + 重 deploy idempotent (ON CONFLICT DO NOTHING)。
describe('016 marketdata sync schema migration (Testcontainers PG migrate deploy)', () => {
  let prisma: PrismaService;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

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

  it('35 张 marketdata 表全部落库 (015 的 6 + 016 的 3 + 017 依赖边表 + 019 因子表 + 039 5 量化信号表 + 040 volatility/hot 2 表 + 041 4 事件流表 + 042 3 报告期表 + 043 2 分类文本表 + 044 日历心跳表 + 046 标的级 IV 2 表 + 046 美股指数日线表 + 047 链合约/逐日快照/财报日历 3 表 + 060 冷启动运行记录表)', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'marketdata' ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'adjustment_factor', // 019 T002
      'allotment_event', // 041 T001
      'anchor_cold_start_run', // 060 T004
      'announcement', // 043 T001
      'buyback_event', // 041 T001
      'calendar_sync_health', // 044 T002
      'connect_holding_daily', // 039 T001
      'corporate_action',
      'daily_bar',
      'earnings_event', // 047 T002
      'employee_snapshot', // 042 T001
      'equity_change', // 041 T001
      'financial_metric',
      'fund_company_holding', // 039 T001
      'fund_holding', // 039 T001
      'fundamental_snapshot',
      'hot_snapshot', // 040 T001
      'index_membership', // 039 T001
      'industry_classification', // 043 T001
      'instrument',
      'option_contract', // 047 T002
      'option_daily_snapshot', // 047 T002
      'revenue_segment', // 042 T001
      'shareholder_change', // 041 T001
      'shareholder_snapshot', // 042 T001
      'short_selling_daily', // 039 T001
      'sync_blacklist',
      'sync_dependency', // 017 T005
      'sync_dimension',
      'sync_run',
      'trading_day',
      'underlying_iv_daily', // 046 T001
      'underlying_iv_history', // 046 T001
      'us_index_daily', // 046 T001
      'volatility_daily', // 040 T001
    ]);
  });

  it('SyncDimension seed 28 维度行存在 (6 核心 + 039 5 港股量化维度 + 040 volatility/hot_snapshot + 041 4 事件流维度 + 042 3 报告期维度 + 043 2 分类文本维度 + sellput-viz us_equity_bar + 046 underlying_iv_daily/us_index_daily + 047 option_contract/option_daily_snapshot/earnings_event)', async () => {
    const dims = await prisma.syncDimension.findMany({
      // priority desc, key asc 二级序: 040 volatility(4)/hot_snapshot(3) 与 039 short_selling(4)/
      // connect_holding(3) 撞 priority 值 → 加 dimensionKey asc 二级键定死平局序 (与派生执行序 tie-break 同);
      // 041 buyback(4)/equity_change(3)/shareholder_change(2)/allotment(1) 同 tier 撞值同规则插入;
      // 042 revenue_segment(4)/shareholder_snapshot(3)/employee(2) 同 tier 撞值同规则插入;
      // 043 industry_classification(2)/announcement(1) 同 tier 撞值同规则插入。
      orderBy: [{ priority: 'desc' }, { dimensionKey: 'asc' }],
      select: {
        dimensionKey: true,
        vendor: true,
        cronExpr: true,
        marketScope: true,
        adjustTypes: true,
        batchSize: true, // 019 T015 批量上限断言。
      },
    });
    // priority desc → key asc 序 (019 T005 调值 + T011 corp 6/eod 5 ≡ 派生执行序: corp 提至 eod 前;
    // 039/040/041/042/043 港股维度 priority 4/3/2/1/0 均低于核心 6 维 5-10; 撞值对 key 字典序后置)。
    expect(dims.map((d) => d.dimensionKey)).toEqual([
      'universe',
      'profile',
      'fundamental',
      'financial',
      'corporate_action',
      'eod_bar',
      'option_contract', // 047 priority 5 (撞 eod_bar → key 后置: 'eod_bar' < 'option_contract')
      'option_daily_snapshot', // 047 priority 5 (hard 边 option_contract→option_daily_snapshot 的相邻性由此 key 序保证)
      'underlying_iv_daily', // 046 priority 5 (撞 us_equity_bar → key 前置: 'option_daily_snapshot' < 'underlying_iv_daily' < 'us_equity_bar')
      'us_equity_bar', // sellput-viz priority 5 (eod_bar 之后、priority 4 组之前)
      'us_index_daily', // 046 priority 5 (撞 us_equity_bar → key 后置: 'us_equity_bar' < 'us_index_daily')
      'buyback', // 041 priority 4 (key 'buyback' < 'revenue_segment' < 'short_selling' 前置)
      'earnings_event', // 047 priority 4 (刻意不取 5 —— 取 5 会插进 corporate_action→eod_bar 那条 hard 边中间, 见 seed migration 注释)
      'revenue_segment', // 042 priority 4 ('earnings_event' < 'revenue_segment' < 'short_selling')
      'short_selling', // 039 priority 4
      'volatility', // 040 priority 4 (撞 short_selling → key 后置)
      'connect_holding', // 039 priority 3
      'equity_change', // 041 priority 3 ('connect_holding' < 'equity_change' < 'hot_snapshot')
      'hot_snapshot', // 040 priority 3 (撞 connect_holding → key 后置)
      'shareholder_snapshot', // 042 priority 3 ('hot_snapshot' < 'shareholder_snapshot')
      'employee', // 042 priority 2 ('employee' < 'fund_holding' 前置)
      'fund_holding', // 039 priority 2
      'industry_classification', // 043 priority 2 ('fund_holding' < 'industry_classification' < 'shareholder_change')
      'shareholder_change', // 041 priority 2 ('fund_holding' < 'shareholder_change')
      'allotment', // 041 priority 1 ('allotment' < 'fund_company_holding' 前置)
      'announcement', // 043 priority 1 ('allotment' < 'announcement' < 'fund_company_holding')
      'fund_company_holding', // 039 priority 1
      'index_membership', // 039 priority 0
    ]);
    // universe 走东财 clist; 其余走理杏仁 (D6 同源)。
    expect(dims.find((d) => d.dimensionKey === 'universe')?.vendor).toBe('eastmoney');
    expect(dims.find((d) => d.dimensionKey === 'eod_bar')?.vendor).toBe('lixinger');
    // 22:00 cron (D4); 扫描节奏 (019 T015): universe/corp 周一周扫, financial 周二周扫
    // (T001 fallback 形态错峰), eod/fundamental/profile 保持 daily。
    expect(dims.find((d) => d.dimensionKey === 'universe')?.cronExpr).toBe('0 0 22 * * 1');
    expect(dims.find((d) => d.dimensionKey === 'corporate_action')?.cronExpr).toBe('0 0 22 * * 1');
    expect(dims.find((d) => d.dimensionKey === 'financial')?.cronExpr).toBe('0 0 22 * * 2');
    // 041 cron 分档 (FR-012, plan Decision 6): buyback/equity_change 日频 (高频事件及时入库);
    // shareholder_change/allotment 周频 (Monday, 低频披露省调用) — 与 universe/corp 同 '0 0 22 * * 1'。
    expect(dims.find((d) => d.dimensionKey === 'buyback')?.cronExpr).toBe('0 0 22 * * *');
    expect(dims.find((d) => d.dimensionKey === 'equity_change')?.cronExpr).toBe('0 0 22 * * *');
    expect(dims.find((d) => d.dimensionKey === 'shareholder_change')?.cronExpr).toBe(
      '0 0 22 * * 1',
    );
    expect(dims.find((d) => d.dimensionKey === 'allotment')?.cronExpr).toBe('0 0 22 * * 1');
    // 042 cron 统一季频 (FR-011, plan Decision 5): revenue_segment/shareholder_snapshot/employee 报告期
    // 低频 (半年报/年报 ~2x/年) → '0 0 22 1 */3 *' (每季度首月 1 日 22:00 上海时区), 非 daily/weekly。
    expect(dims.find((d) => d.dimensionKey === 'revenue_segment')?.cronExpr).toBe('0 0 22 1 */3 *');
    expect(dims.find((d) => d.dimensionKey === 'shareholder_snapshot')?.cronExpr).toBe(
      '0 0 22 1 */3 *',
    );
    expect(dims.find((d) => d.dimensionKey === 'employee')?.cronExpr).toBe('0 0 22 1 */3 *');
    // 043 cron 统一夜频 (FR-011, plan Decision 5): industry_classification/announcement 分类文本均日频
    // '0 0 22 * * *' (共用错峰夜窗, 同 index_membership/short_selling, 异于 042 报告期季频 / 041 shareholder_change
    // /allotment 周频) → 纳入下方 daily-cadence 断言集 (不进 exclusion filter, 由 .every() 一并校验)。
    expect(dims.find((d) => d.dimensionKey === 'industry_classification')?.cronExpr).toBe(
      '0 0 22 * * *',
    );
    expect(dims.find((d) => d.dimensionKey === 'announcement')?.cronExpr).toBe('0 0 22 * * *');
    // 046 两维度都吃美股当日收盘数据 (排 22:00 会取到「尚未产生」的当日值) ⇒ 均排北京清晨,
    // 但**不同档**。标的级走富途 overview 快照端点, 18:00 ET 即已就绪 ⇒ 与 us_equity_bar 同档。
    expect(dims.find((d) => d.dimensionKey === 'underlying_iv_daily')?.cronExpr).toBe(
      '0 0 6 * * *',
    );
    // 指数级晚 4 小时: CBOE 历史 CSV 的发布落在 (18:00, 21:00] ET, 排 06:00 (= 18:00 EDT /
    // 17:00 EST) 恒取到旧文件 —— 08-04 首跑实测 run 绿(14314/14314)但最新行停在 07-31。
    // 10:00 = 22:00 EDT / 21:00 EST, 两个 DST 档都在发布之后 (migration 20260804_0910)。
    expect(dims.find((d) => d.dimensionKey === 'us_index_daily')?.cronExpr).toBe('0 0 10 * * *');
    // 047 三维度同属美股清晨档 (06:00 = 前一交易日 18:00 EDT / 17:00 EST, 均在 16:00 收盘之后)。
    // 快照比链发现晚 30 分钟 —— hard 依赖边保证执行序, cron 错开是同一约束在调度侧的第二道表达。
    expect(dims.find((d) => d.dimensionKey === 'option_contract')?.cronExpr).toBe('0 0 6 * * *');
    expect(dims.find((d) => d.dimensionKey === 'option_daily_snapshot')?.cronExpr).toBe(
      '0 30 6 * * *',
    );
    expect(dims.find((d) => d.dimensionKey === 'earnings_event')?.cronExpr).toBe('0 0 6 * * *');
    expect(
      dims
        .filter(
          (d) =>
            ![
              'universe',
              'corporate_action',
              'financial',
              'shareholder_change', // 041 周频
              'allotment', // 041 周频
              'revenue_segment', // 042 季频
              'shareholder_snapshot', // 042 季频
              'employee', // 042 季频
              // sellput-viz: us 日线排**北京清晨** 06:00 而非 22:00 —— 美股 16:00 ET 收盘落在
              // 北京次日凌晨, 22:00 跑的话当日 bar 根本还没产生 (那时美股尚未开盘)。
              'us_equity_bar',
              'underlying_iv_daily', // 046 同上 06:00 档 (值已由上方显式断言钉死)
              'us_index_daily', // 046 清晨档但晚 4 小时 = 10:00 (值已由上方显式断言钉死)
              'option_contract', // 047 清晨 06:00 档 (值已由上方显式断言钉死)
              'option_daily_snapshot', // 047 清晨 06:30 档 (值已由上方显式断言钉死)
              'earnings_event', // 047 清晨 06:00 档 (值已由上方显式断言钉死)
            ].includes(d.dimensionKey),
        )
        .every((d) => d.cronExpr === '0 0 22 * * *'),
    ).toBe(true);
    // 批量上限 (019 T015, T001 实测 100): fundamental/financial 1 → 100。
    expect(dims.find((d) => d.dimensionKey === 'fundamental')?.batchSize).toBe(100);
    expect(dims.find((d) => d.dimensionKey === 'financial')?.batchSize).toBe(100);
    // 核心 6 维 A 股 scope 含 cn; 039 5 港股量化维度 + 040 volatility/hot_snapshot + 041 4 事件流维度
    // + 042 3 报告期维度 + 043 2 分类文本维度 marketScope={hk} (不含 cn, 港股专属信号); sellput-viz us_equity_bar={us}。
    const hkOnlyDims = [
      'short_selling',
      'connect_holding',
      'fund_holding',
      'fund_company_holding',
      'index_membership',
      'volatility', // 040
      'hot_snapshot', // 040
      'buyback', // 041
      'equity_change', // 041
      'shareholder_change', // 041
      'allotment', // 041
      'revenue_segment', // 042
      'shareholder_snapshot', // 042
      'employee', // 042
      'industry_classification', // 043
      'announcement', // 043
    ];
    // sellput-viz: marketScope = {us} —— 与港股维度一样「不含 cn」, 但它也**不含 hk**,
    // 故必须与 hkOnlyDims 分开: 前者用于「其余维度含 cn」的排除集, 后者才断言含 hk。
    // 046 两维度同为 {us}: underlying_iv_daily 的 scope 兼作工作集判据 (无锚不采),
    // us_index_daily 的 scope 只是元数据 (工作集 = VIX/VVIX 固定常量, 不查 Instrument)。
    // 047 三维度同为 {us}, 且**同一个 scope 值承担两种角色**: option_contract /
    // option_daily_snapshot 是 per-code 接口, scope 兼作工作集判据 (挂锚闸, FR-035);
    // earnings_event 是市场级接口, scope **只是元数据** (工作集 = 固定前向时间窗, 不挂锚闸, FR-035a)。
    const usOnlyDims = [
      'us_equity_bar',
      'underlying_iv_daily',
      'us_index_daily',
      'option_contract', // 047
      'option_daily_snapshot', // 047
      'earnings_event', // 047
    ];
    expect(
      dims
        .filter((d) => ![...hkOnlyDims, ...usOnlyDims].includes(d.dimensionKey))
        .every((d) => d.marketScope.includes('cn')),
    ).toBe(true);
    expect(
      dims
        .filter((d) => hkOnlyDims.includes(d.dimensionKey))
        .every((d) => d.marketScope.includes('hk')),
    ).toBe(true);
    expect(
      dims
        .filter((d) => usOnlyDims.includes(d.dimensionKey))
        .every((d) => d.marketScope.length === 1 && d.marketScope[0] === 'us'),
    ).toBe(true);
    // 020 T010 配置收窄 (FR-A01): 写路径只落 none 单口径, adjust_types deprecated 恒 {none}。
    expect(dims.find((d) => d.dimensionKey === 'eod_bar')?.adjustTypes).toEqual(['none']);
    expect(dims.find((d) => d.dimensionKey === 'fundamental')?.adjustTypes).toEqual([]);
  });

  it('SyncDimension.dimensionKey 唯一 (重复 insert 拒)', async () => {
    await expect(
      prisma.syncDimension.create({
        data: { dimensionKey: 'universe', cronExpr: '0 0 22 * * *', vendor: 'eastmoney' },
      }),
    ).rejects.toThrow();
  });

  it('seed migration idempotent — 再跑 ON CONFLICT DO NOTHING 不重复行', async () => {
    // 模拟 deploy 重放 seed 语句 (migration.sql 同款)。
    await prisma.$executeRawUnsafe(
      `INSERT INTO "marketdata"."sync_dimension"
         ("dimension_key", "enabled", "cron_expr", "vendor", "market_scope", "adjust_types", "batch_size", "priority")
       VALUES ('universe', true, '0 0 22 * * *', 'eastmoney', '{cn}'::text[], '{}'::text[], 200, 10)
       ON CONFLICT ("dimension_key") DO NOTHING`,
    );
    // 从 DIMENSION_KEYS 派生而非写死数字: 本断言要钉的是「重放 seed 不多出行」, 具体维度数只是
    // 副产品。派生后既保住原意, 又顺带守住「seed 行数 ≡ 注册表维度数」(与 dimension-executor.spec.ts
    // 「seed 快照每个键都在 DIMENSION_KEYS 在册」合成双向), 且加维度时不再假红。
    expect(await prisma.syncDimension.count()).toBe(DIMENSION_KEYS.length);
  });

  it('SyncBlacklist (market, code) 唯一', async () => {
    await prisma.syncBlacklist.create({ data: { market: 'cn', code: '000333', reason: 'test' } });
    await expect(
      prisma.syncBlacklist.create({ data: { market: 'cn', code: '000333', reason: 'dup' } }),
    ).rejects.toThrow();
  });

  it('SyncRun 可写读 + 审计计数/failedTargets/status', async () => {
    const run = await prisma.syncRun.create({ data: { syncType: 'eod_bar', status: 'running' } });
    expect(run.scanned).toBe(0);
    const done = await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        scanned: 10,
        ok: 8,
        skipped: 1,
        failed: 1,
        failedTargets: [{ symbol: 'cn:600519', step: 'eod_bar', error: 'timeout' }],
        status: 'partial',
        finishedAt: new Date(),
      },
    });
    expect(done.status).toBe('partial');
    expect(done.failedTargets).toEqual([
      { symbol: 'cn:600519', step: 'eod_bar', error: 'timeout' },
    ]);
  });

  it('ix_sync_run_type_started 索引已建 (审计查询 type+startedAt desc)', async () => {
    const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'marketdata' AND indexname = 'ix_sync_run_type_started'`,
    );
    expect(rows).toHaveLength(1);
  });
});
