import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';

// 015 T001 PR1 Independent Test (③ migrate deploy 6 表 + pg_trgm + GIN index 落库)。
// 验 marketdata schema 的 expand-only migration 在全新 PG 上干净 deploy, 015 6 张事实/注册表
// + 016 T001 新增 3 张同步配置/审计表共 9 张可读写, DailyBar 唯一键含 adjust (三复权各一行),
// pg_trgm extension 可用 (本地搜索备援地基)。
describe('015 marketdata schema migration (Testcontainers PG migrate deploy)', () => {
  let prisma: PrismaService;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;

    // PrismaService = v7 driver-adapter wrapper, 构造直传 Testcontainers URI。
    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  it('pg_trgm extension 已安装 (本地搜索备援地基)', async () => {
    const rows = await prisma.$queryRawUnsafe<{ extname: string }[]>(
      `SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('36 张 marketdata 表全部落库 (015 6 事实表 + 016 3 同步配置/审计表 + 017 依赖边表 + 019 因子表 + 039 5 量化信号表 + 040 volatility/hot 2 表 + 041 4 事件流表 + 042 3 报告期表 + 043 2 分类文本表 + 044 日历心跳表 + 046 标的级 IV 2 表 + 046 美股指数日线表 + 047 链合约/逐日快照/财报日历 3 表 + 060 冷启动运行记录表 + 062 日历覆盖声明表)', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'marketdata' ORDER BY table_name`,
    );
    const names = rows.map((r) => r.table_name);
    expect(names).toEqual([
      'adjustment_factor', // 019 T002
      'allotment_event', // 041 T001
      'anchor_cold_start_run', // 060 T004
      'announcement', // 043 T001
      'buyback_event', // 041 T001
      'calendar_coverage', // 062 T002
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
      'sync_blacklist', // 016 T001
      'sync_dependency', // 017 T005
      'sync_dimension', // 016 T001
      'sync_run', // 016 T001
      'trading_day',
      'underlying_iv_daily', // 046 T001
      'underlying_iv_history', // 046 T001
      'us_index_daily', // 046 T001
      'volatility_daily', // 040 T001
    ]);
  });

  it('GIN trgm index on pinyin_abbr 已建', async () => {
    const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'marketdata' AND indexname = 'ix_instrument_pinyin_abbr_trgm'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('Instrument 可写读, (market, code) 唯一', async () => {
    const created = await prisma.instrument.create({
      data: {
        market: 'cn',
        code: '600519',
        name: '贵州茅台',
        type: 'stock',
        currency: 'CNY',
        pinyinAbbr: 'gzmt',
        pinyinFull: 'guizhoumaotai',
        status: 'listed',
      },
    });
    expect(created.id).toBeDefined();
    expect(created.syncTier).toBe(2); // 默认 2 (016 重算)

    await expect(
      prisma.instrument.create({
        data: {
          market: 'cn',
          code: '600519',
          name: 'dup',
          type: 'stock',
          currency: 'CNY',
          status: 'listed',
        },
      }),
    ).rejects.toThrow();
  });

  it('DailyBar 唯一键含 adjust → 三复权各一行 (修正 PRD)', async () => {
    const inst = await prisma.instrument.create({
      data: {
        market: 'cn',
        code: '000001',
        name: '平安银行',
        type: 'stock',
        currency: 'CNY',
        status: 'listed',
      },
    });
    const base = {
      instrumentId: inst.id,
      tradeDate: new Date('2026-06-01'),
      open: '10',
      high: '11',
      low: '9',
      close: '10.5',
    };
    await prisma.dailyBar.create({ data: { ...base, adjust: 'none' } });
    await prisma.dailyBar.create({ data: { ...base, adjust: 'forward' } });
    await prisma.dailyBar.create({ data: { ...base, adjust: 'backward' } });

    const bars = await prisma.dailyBar.findMany({ where: { instrumentId: inst.id } });
    expect(bars).toHaveLength(3); // 同 (instrumentId, tradeDate) 三 adjust 不冲突

    // close 是 Decimal — Prisma 返 Decimal 实例, toString 保精度
    expect(bars[0].close.toString()).toBe('10.5');

    // 同 (instrumentId, tradeDate, adjust) 重复 → 唯一键拒
    await expect(prisma.dailyBar.create({ data: { ...base, adjust: 'none' } })).rejects.toThrow();
  });
});
