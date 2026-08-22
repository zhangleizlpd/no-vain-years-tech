import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupEmptyDb } from '../_support/isolated-db';
import { runMigrateDeploy } from '../_support/run-migrate';
import { PrismaService } from '../../src/security/prisma.service';

// 061 T006 schema IT: optionsdesk.anchor 加 `intraday_price` / `intraday_at` 两列
// (expand-only, ADR-0035) —— **必须真 PG**: 本条被测对象**就是 `migrate deploy` 的产物本身**
// (DDL 落没落 / 列类型到底是 timestamptz 还是 date / nullable 真不真 / 有没有多出一张历史表),
// 这些在任何 mock 或 schema.prisma 静态读取里都不存在 ⇒ 取 `setupEmptyDb()` (三入口中「自己跑
// migrate deploy 并验证其产物」那一个; 换成 setupIsolatedDb 的模板克隆会把被测对象整个抽掉,
// **而且不会红、也不会变慢** —— 只是悄悄不再验证任何东西)。
//
// 验 ① 两列在册且 nullable 无默认值 ② 🚨 `intraday_at` 是 **timestamptz(6) 不是 date**
// (Guardrail 14: 日期列会把「什么时候采的」压平成「哪天采的」, 新鲜度闸当场失效, 且**不会红**)
// ③ 既有行两列为 null (= 「还没经历过任何盘中采集」) 且 `last_close` 语义不变、可独立写入
// (FR-015: 盘中列是并列的第二列, 不是替代) ④ FR-019 反向断言: optionsdesk schema 内**没有**
// 任何实时行情历史表 (「最近一次」不是历史序列, 历史归 marketdata.daily_bar)。
// 采集行为 (时段闸 / 熔断 / 部分失败) 归 T009 / T010, 不在本文件。
describe('061 anchor 盘中价两列 schema expand (Testcontainers PG migrate deploy)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupEmptyDb>>;

  beforeAll(async () => {
    db = await setupEmptyDb();
    process.env.DATABASE_URL = db.databaseUrl;

    runMigrateDeploy();

    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  it('两列在册且 nullable、无默认值 (expand-only: 既有行落 null = 还没采过)', async () => {
    const cols = await prisma.$queryRawUnsafe<
      { column_name: string; is_nullable: string; column_default: string | null }[]
    >(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'optionsdesk' AND table_name = 'anchor'
          AND column_name IN ('intraday_price', 'intraday_at')
        ORDER BY column_name`,
    );
    expect(
      cols.map((c) => `${c.column_name}:${c.is_nullable}:${c.column_default ?? 'null'}`),
    ).toEqual(['intraday_at:YES:null', 'intraday_price:YES:null']);
  });

  it('🚨 intraday_at 是 timestamptz(6) **不是 date** —— 用日期列会让新鲜度闸当场失效且不报错', async () => {
    const cols = await prisma.$queryRawUnsafe<
      {
        column_name: string;
        data_type: string;
        datetime_precision: number | null;
        numeric_precision: number | null;
        numeric_scale: number | null;
      }[]
    >(
      `SELECT column_name, data_type, datetime_precision, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_schema = 'optionsdesk' AND table_name = 'anchor'
          AND column_name IN ('intraday_price', 'intraday_at')
        ORDER BY column_name`,
    );
    const at = cols.find((c) => c.column_name === 'intraday_at');
    // 闸判的是「距上次采集过了几秒」; date 列只留得下「哪天采的」⇒ 90 秒的闸恒为真, 陈旧价
    // 会被一路当成实时价用, 而排序、类型、测试全都不会红。
    expect(at?.data_type).toBe('timestamp with time zone');
    expect(at?.datetime_precision).toBe(6);

    const price = cols.find((c) => c.column_name === 'intraday_price');
    // 与 last_close 同量纲同精度 —— 两者是并列的两个价源, 精度不同会让降级瞬间数值跳一下。
    expect(price?.data_type).toBe('numeric');
    expect(price?.numeric_precision).toBe(18);
    expect(price?.numeric_scale).toBe(4);
  });

  it('新建锚两列为 null; last_close 语义不变、仍可独立写入 (FR-015 并列不替代)', async () => {
    const created = await prisma.anchor.create({
      data: {
        ticker: 'us:PEP',
        market: 'us:PEP'.split(':')[0]!,
        v: '150',
        asof: new Date('2026-08-14T00:00:00Z'),
        method: 'dcf',
        confidence: '8.5',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
      },
    });
    expect(created.intradayPrice).toBeNull();
    expect(created.intradayAt).toBeNull();

    // 两个价源各写各的: 写盘中列 MUST NOT 触碰收盘列 (降级的唯一落脚点)。
    const at = new Date('2026-08-17T18:30:12.345Z');
    const updated = await prisma.anchor.update({
      where: { id: created.id },
      data: { intradayPrice: '177.7700', intradayAt: at, lastClose: '165.4100' },
    });
    expect(updated.intradayPrice?.toString()).toBe('177.77');
    expect(updated.intradayAt?.toISOString()).toBe(at.toISOString()); // 秒以下精度不被压平
    expect(updated.lastClose?.toString()).toBe('165.41');
  });

  it('🚫 FR-019 反向断言: optionsdesk 内没有任何实时行情历史表 (「最近一次」不是序列)', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'optionsdesk'
        ORDER BY table_name`,
    );
    // 钉死整张 schema 的表集: 将来有人加 `anchor_intraday_history` 这类表当场撞红。
    // 盘中价的历史归 marketdata.daily_bar —— 每 30 秒一行的序列会把这张表灌成行情噪声库。
    expect(rows.map((r) => r.table_name)).toEqual(['anchor', 'anchor_change', 'anchor_submission']);
  });
});
