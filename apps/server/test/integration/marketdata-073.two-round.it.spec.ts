import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupEmptyDb } from '../_support/isolated-db';
import { runMigrateDeploy } from '../_support/run-migrate';
import { stubTradingCalendar } from '../_support/trading-calendar-stub';
import { PrismaService } from '../../src/security/prisma.service';
import type {
  ExecutorSyncDimensionRow,
  WorkingInstrument,
} from '../../src/marketdata/dimension-executor';
import {
  closeSettleBufferMinutes,
  oiRefreshedAtEod,
  quoteLadderEndMinute,
} from '../../src/marketdata/market-session.rules';
import type {
  OptionSnapshotPort,
  OptionSnapshotQuery,
  OptionSnapshotRow,
} from '../../src/marketdata/option-snapshot.port';
import { emptyStats } from '../../src/marketdata/sync-run.recorder';
import { SyncOptionOiSettleUseCase } from '../../src/marketdata/sync-option-oi-settle.usecase';
import { SyncOptionSnapshotUseCase } from '../../src/marketdata/sync-option-snapshot.usecase';
import { computeNext } from '../../src/marketdata/sync-tick-driver';

const SERVER_DIR = process.cwd();

/**
 * 073 港股期权两轮采集 IT (Testcontainers PG `migrate deploy`)。
 *
 * ## 为什么用 `setupEmptyDb()` + 自己跑 `migrate deploy`
 *
 * 本片被测对象之一**就是那条 migration**。共享 PG 的模板克隆拿到的是「migration 已经跑完」
 * 的库 —— 断言照样绿, 但绿的是模板, 不是本片新写的 SQL。⇒ 走
 * `marketdata-066.hk-dimension-seed.it.spec.ts` 同一档: 空库 + `runMigrateDeploy()`,
 * 顺带把「migration 在空库单向可用」也验掉 (跑不通就在 beforeAll 当场炸)。
 *
 * ## 🚨 本文件断的是**性质**, 不是 cron 字符串
 *
 * `expect(cronExpr).toBe('0 20 16 * * *')` 对 `0 20 16 * * 1-5` 这类不违反任何 FR 的改动
 * 同样会红, 而对「把 16:20 改成 16:05」这种**真的踩闸**的改动给不出任何解释。⇒ 一律折成
 * 下一触发时刻, 再拿仓内既有的判据函数 (`closeSettleBufferMinutes` / `oiRefreshedAtEod`) 去问。
 */

/** 本片新增的 migration —— 单一真相源, 读文件, 绝不内联复制。 */
const MIGRATION_SQL = readFileSync(
  resolve(
    SERVER_DIR,
    'prisma/migrations/20260901_1502_split_hk_option_collection_into_two_rounds/migration.sql',
  ),
  'utf8',
);

const HK_CHAIN = 'hk_option_contract';
const HK_SNAPSHOT = 'hk_option_daily_snapshot';
const HK_IV = 'hk_underlying_iv_daily';
const HK_OI_SETTLE = 'hk_option_oi_settle';

/** 港股收盘 16:00 —— 与 `MARKET_SESSION` 同源的事实, 此处只作断言基准的可读锚。 */
const HK_CLOSE_MINUTE = 16 * 60;

describe('073 两轮采集 seed + 时刻窗口 (Testcontainers PG migrate deploy)', () => {
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

  it('轮2 维度行落库, 取值逐列 (market_scope 恰为 {hk} / futu lane / 无 backfill 语义)', async () => {
    const row = await prisma.syncDimension.findUnique({
      where: { dimensionKey: HK_OI_SETTLE },
      select: {
        enabled: true,
        marketScope: true,
        queueLane: true,
        batchSize: true,
        historyDepth: true,
        retryMax: true,
        priority: true,
      },
    });
    expect(row).toEqual({
      // 归属判据已在代码里落地且有单测钉住 ⇒ 不存在 066 那次「开了会静默写错标签」的窗口。
      enabled: true,
      // 🚨 恰为 {hk}: 掺进 us 会撞 `exchangeCalendarDateForScope` 的 scope 日历 throw。
      marketScope: ['hk'],
      // 漏登记会落回 default lane, 与理杏仁那条夜间链排队 (#210)。
      queueLane: 'futu',
      // get_option_snapshot 官方批量上限, 同主轮。
      batchSize: 400,
      // 期权快照无跨日补救 (vendor 不给历史交易日的快照) ⇒ 本维度没有 backfill 语义。
      historyDepth: null,
      retryMax: 3,
      priority: 5,
    });
  });

  it('🚨 主轮两维前移后落在写入窗 [16:10, 16:30] 内 —— 早于下界撞 close-write 闸, 晚于上界盘口已塌', async () => {
    const rows = await prisma.syncDimension.findMany({
      where: { dimensionKey: { in: [HK_CHAIN, HK_SNAPSHOT] } },
      select: { dimensionKey: true, cronExpr: true },
      orderBy: { dimensionKey: 'asc' },
    });
    expect(rows).toHaveLength(2);

    // 2026-08-24 周一 12:00 Asia/Shanghai —— 让 computeNext 落在同一自然日内。
    const now = new Date('2026-08-24T04:00:00Z');
    // 下界 = 收盘 + 该市场的定稿缓冲 (HKEX CAS 16:08–16:10 随机收市 ⇒ 官方收盘价最早 16:10)。
    // 🚨 取自 `closeSettleBufferMinutes('hk')` 而不是写死 10: 那个值改了本例必须跟着动,
    //    而写死会让「有人把缓冲调大、cron 却没跟着挪」这件事静默通过。
    const bufferMinutes = closeSettleBufferMinutes('hk');
    // 基点是**当地午夜**, 再加「收盘分钟 + 缓冲」。⚠️ 拿一个已经带钟点的 UTC 时刻当基点,
    // 加上去的是第二天的分钟数, 而断言只会说「日期不对」。
    const hkMidnightMs = Date.UTC(2026, 7, 24, 0, 0) - 8 * 60 * 60_000;
    const lowerBoundMs = hkMidnightMs + (HK_CLOSE_MINUTE + bufferMinutes) * 60_000;

    for (const row of rows) {
      const next = computeNext(row.cronExpr, now);
      expect(
        next.getTime(),
        `${row.dimensionKey} 的 cron "${row.cronExpr}" 触发早于 close-write 闸解除 ` +
          `(收盘 16:00 + ${bufferMinutes}min) —— 那一刻官方收盘价还不存在`,
      ).toBeGreaterThanOrEqual(lowerBoundMs);
    }
    // 上界 = 盘口台阶上界 (073 T009, FR-022)。同样取自单点常量而不是字面量 16:30 ——
    // T012 的补样本会把断点夹紧并**重标**它, 那时本例必须跟着动。
    // 🚨 断的是**触发时刻**落在窗内, 不含链发现耗时: 耗时是随锚集增长的变量, 由主轮收尾的
    //    抓价时刻越界告警 (FR-022) 盯着, 两条判据各管一段, MUST NOT 在这里合成一个数。
    const ladderEndMinute = quoteLadderEndMinute('hk') as number;
    expect(ladderEndMinute, '港股台阶上界未登记 ⇒ 主轮时刻失去上界约束').not.toBeNull();
    const upperBoundMs = hkMidnightMs + ladderEndMinute * 60_000;
    for (const row of rows) {
      expect(
        computeNext(row.cronExpr, now).getTime(),
        `${row.dimensionKey} 的 cron "${row.cronExpr}" 触发晚于盘口台阶上界 ` +
          `(收盘后 ${ladderEndMinute - HK_CLOSE_MINUTE} 分钟) —— 抓价时刻必然已滑出台阶`,
      ).toBeLessThanOrEqual(upperBoundMs);
    }
  });

  it('🚨 主轮两维仍在**同一 tick** (依赖边只在同一 tick 内装配, ADR-0049 §3)', async () => {
    const rows = await prisma.syncDimension.findMany({
      where: { dimensionKey: { in: [HK_CHAIN, HK_SNAPSHOT] } },
      select: { dimensionKey: true, cronExpr: true },
    });
    const now = new Date('2026-08-24T04:00:00Z');
    const byKey = new Map(rows.map((r) => [r.dimensionKey, computeNext(r.cronExpr, now)]));
    expect(
      byKey.get(HK_SNAPSHOT)?.getTime(),
      '链发现与快照不同 tick ⇒ 分进两棵 flow 树 ⇒ 依赖边静默失效 (#210 的根因)',
    ).toBe(byKey.get(HK_CHAIN)?.getTime());
  });

  it('🚨 轮2 的触发时刻上 OI **已定稿** —— 判据用 `oiRefreshedAtEod` 自己问, 不数分钟', async () => {
    const row = await prisma.syncDimension.findUniqueOrThrow({
      where: { dimensionKey: HK_OI_SETTLE },
      select: { cronExpr: true },
    });
    const now = new Date('2026-08-24T04:00:00Z'); // 12:00 Asia/Shanghai
    const next = computeNext(row.cronExpr, now);
    expect(
      oiRefreshedAtEod('hk', '2026-08-24', next),
      `轮2 cron "${row.cronExpr}" 落在 OI 定稿之前 ⇒ 每晚都会走 use case 那条 skip 分支, ` +
        `OI 永远回填不上 (而采集本身全绿)`,
    ).toBe(true);
  });

  it('🚨 轮2 与主轮**不在同一 tick** —— 这正是「不给它连依赖边」的理由', async () => {
    const rows = await prisma.syncDimension.findMany({
      where: { dimensionKey: { in: [HK_SNAPSHOT, HK_OI_SETTLE] } },
      select: { dimensionKey: true, cronExpr: true },
    });
    const now = new Date('2026-08-24T04:00:00Z');
    const byKey = new Map(rows.map((r) => [r.dimensionKey, computeNext(r.cronExpr, now)]));
    expect(byKey.get(HK_OI_SETTLE)?.getTime()).not.toBe(byKey.get(HK_SNAPSHOT)?.getTime());
  });

  it('🚨 轮2 **零依赖边** (裁决落成断言: 跨 tick 的边装不上, 连了是空话)', async () => {
    const edges = await prisma.syncDependency.findMany({
      where: { OR: [{ upstream: HK_OI_SETTLE }, { downstream: HK_OI_SETTLE }] },
    });
    expect(edges).toEqual([]);
  });

  it('IV 那行本片不动, 仍留 23:00 档 (前移是条件项 FR-017, 待探针定型)', async () => {
    const row = await prisma.syncDimension.findUniqueOrThrow({
      where: { dimensionKey: HK_IV },
      select: { cronExpr: true },
    });
    const now = new Date('2026-08-24T04:00:00Z');
    const next = computeNext(row.cronExpr, now);
    expect(next.getTime()).toBeGreaterThan(new Date('2026-08-24T14:00:00Z').getTime());
  });

  // 🚨 FR-012 的**唯一**机械守卫。
  //
  // 「改 cron_expr 必须同条 migration 置 next_fire_at = NULL」这条约束今天只写在
  // `schema.prisma` 的列注释与 20260827_2112 的正文里 —— 而漏掉它的表现是**改动静默滞后一个
  // 周期**, 无报错、无红、cron 列也确实是新值。
  // 🚫 **在库里断言 next_fire_at IS NULL 证明不了这件事**: 空库 `migrate deploy` 之后那一列
  //    本来就全是 NULL (从没触发过), 断言恒真。⇒ 判据只能落在 migration 文本上。
  it('FR-012 改了 cron 的那两行, 同条 migration 里被复位 next_fire_at', () => {
    const retimed = [HK_CHAIN, HK_SNAPSHOT];
    const resetStatement = MIGRATION_SQL.split(';').find(
      (stmt) => /SET\s+"next_fire_at"\s*=\s*NULL/i.test(stmt) && /UPDATE/i.test(stmt),
    );
    expect(
      resetStatement,
      'migration 里没有 next_fire_at 复位语句 —— 改动会滞后一个周期',
    ).toBeDefined();
    for (const key of retimed) {
      expect(resetStatement, `复位语句漏了 ${key}`).toContain(`'${key}'`);
    }
  });

  /**
   * 🚨 轮2 两段写的真库验证 (073 T005, SC-003 / SC-004 / SC-007)。
   *
   * ## 为什么这一片 MUST 走真库 (Testing Invariant 3)
   *
   * 本轮的核心承诺是「**只**改三列」。mock prisma 能断言「我调用了 updateMany 且 data 里只有
   * 三个键」—— 但那证明的是**调用形状**, 不是**库里那一行**。差别在于:
   * ① 唯一键 `(contract_id, session_date, source)` 的碰撞行为 (段 b 的 `skipDuplicates` 靠它
   *    挡住重写主轮已有行) 只有真库有;
   * ② 「其余列逐值不变」要的是**落库前后逐字段对拍**, 而 mock 里根本没有「落库后的行」。
   *
   * ⇒ 三臂都先把主轮那份写进库, 再跑轮2, 再把整行读回来逐字段比。
   */
  describe('轮2 两段写 —— 只有真库能证「只改三列」(T005)', () => {
    /** 样本期那天 (2026-08-31 周一); 上一交易日 08-28 周五。 */
    const SESSION = '2026-08-31';
    const PREV_SESSION = '2026-08-28';
    /** 轮2 触发时刻 = hk 当地 21:40, 晚于 OI 定稿 (21:30)。 */
    const ROUND_TWO_NOW = new Date(`${SESSION}T13:40:00Z`);
    /** 主轮 16:20 那轮的抓价时刻 (hk 当地 16:28) —— 本片抢的就是这份盘口。 */
    const MAIN_QUOTE_AS_OF = new Date(`${SESSION}T08:28:00Z`);
    /** 轮2 自己的抓价时刻 (hk 当地 21:41) —— 段 b 补出来的行才会带它。 */
    const SETTLE_QUOTE_AS_OF = new Date(`${SESSION}T13:41:00Z`);
    const UNDERLYING_CODE = 'HK.00700';

    const day = (s: string) => new Date(`${s}T00:00:00Z`);

    /** 轮2 唯一被允许改的三列。其余列进「逐值不变」的对拍。 */
    const MUTABLE_COLUMNS = new Set(['openInterest', 'netOpenInterest', 'oiAsOf']);

    /**
     * 主轮 16:2x 落的那一行 (值取自 `sync-option-snapshot.usecase` 的列映射, 逐列有值 ——
     * 🚨 留 null 的列在「逐值不变」里恒等, 证不出任何东西)。
     */
    const MAIN_ROUND_ROW = {
      quoteAsOf: MAIN_QUOTE_AS_OF,
      // 主轮跑在 16:20, 那一刻 OI 还没定稿 ⇒ 标签退到上一交易日。轮2 要修的正是这一格。
      oiAsOf: day(PREV_SESSION),
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
      underlyingSpot: '148.21',
      vendorUpdateTime: new Date(`${SESSION}T08:07:49Z`),
      greeksComplete: true,
    };

    /**
     * 轮2 时刻端点返的那一行 —— **每一列都与主轮不同**。
     *
     * 🚨 盘口那几列取的是 21:40 塌掉后的形态 (bid 0.01 / ask 9.90): 若轮2 顺手把报价列一起
     * 刷新, 主轮 16:2x 抢到的那份就被盖掉 —— 而抢那份是本片存在的全部理由 (SC-004)。
     */
    const SETTLE_VENDOR_ROW = {
      bid: '0.01',
      ask: '9.90',
      bidSize: '1',
      askSize: '2',
      last: '2.50',
      prevClose: '2.29',
      iv: '33.3',
      delta: '-0.44',
      gamma: '0.055',
      vega: '0.077',
      theta: '-0.066',
      rho: '0.022',
      openInterest: '9999',
      netOpenInterest: '-1111',
      volume: '4321',
      turnover: '999999',
      vendorUpdateTime: new Date(`${SESSION}T13:39:00Z`),
      greeksComplete: true,
    };

    let dim: ExecutorSyncDimensionRow;

    beforeEach(async () => {
      await prisma.optionDailySnapshot.deleteMany();
      await prisma.optionContract.deleteMany();
      await prisma.instrument.deleteMany();
      await prisma.tradingDay.deleteMany();
      // 归属判据要两天: 本场 (= session_date 的来源) 与它的上一交易日 (主轮 oi_as_of 的来源)。
      await prisma.tradingDay.createMany({
        data: [PREV_SESSION, SESSION].map((d) => ({
          market: 'hk',
          date: day(d),
          sessionKind: 'whole',
        })),
      });
      // 🚨 维度行取**库里那一行** (migration 落的), 不是手搓字面量 —— 轮2 只读 marketScope,
      //    而 marketScope 写错正是 066 那次「掺进 us 撞 scope 日历 throw」的形态。
      dim = (await prisma.syncDimension.findUniqueOrThrow({
        where: { dimensionKey: HK_OI_SETTLE },
      })) as ExecutorSyncDimensionRow;
    });

    /** 一只港股标的 + `count` 张未到期 PUT 合约。 */
    async function seedChain(
      code: string,
      count: number,
    ): Promise<{ instrument: WorkingInstrument; contracts: { id: bigint; code: string }[] }> {
      const inst = await prisma.instrument.create({
        data: {
          market: 'hk',
          code,
          name: `hk:${code}`,
          type: 'stock',
          currency: 'HKD',
          status: 'active',
          needSync: true,
        },
      });
      const contracts: { id: bigint; code: string }[] = [];
      for (let i = 0; i < count; i++) {
        const contractCode = `HK.TCH260918P${100 + i}000`;
        const row = await prisma.optionContract.create({
          data: {
            market: 'hk',
            code: contractCode,
            root: 'TCH',
            underlyingInstrumentId: inst.id,
            // 到期日远于 session_date ⇒ 落在工作集口径 (`expiry_date >= session_date`) 内。
            expiryDate: day('2026-09-18'),
            strikePrice: 100 + i,
            optionType: 'PUT',
            isStandard: true,
          },
        });
        contracts.push({ id: row.id, code: contractCode });
      }
      return { instrument: { id: inst.id, market: 'hk', code }, contracts };
    }

    /** 把主轮那一轮的行写进库 (只给 `codes` 里点名的合约 —— 其余的就是「主轮整行缺失」)。 */
    async function seedMainRoundRows(contracts: { id: bigint; code: string }[]): Promise<void> {
      await prisma.optionDailySnapshot.createMany({
        data: contracts.map((c) => ({
          ...MAIN_ROUND_ROW,
          contractId: c.id,
          sessionDate: day(SESSION),
          source: 'eod',
        })),
      });
    }

    /** 轮2 时刻的端点替身: 期权行 + 标的自身那行 (spot 与主轮同源, 同批下发不另发调用)。 */
    function settlePort(): OptionSnapshotPort {
      return {
        getSnapshots: async (q: OptionSnapshotQuery) => ({
          asOf: SETTLE_QUOTE_AS_OF,
          rows: [
            ...q.contractCodes.map(
              (code): OptionSnapshotRow => ({
                ...SETTLE_VENDOR_ROW,
                code,
                isOption: true,
                underlyingCode: UNDERLYING_CODE,
              }),
            ),
            {
              ...SETTLE_VENDOR_ROW,
              code: UNDERLYING_CODE,
              isOption: false,
              underlyingCode: null,
              last: '148.21',
              bid: null,
              ask: null,
              delta: null,
              greeksComplete: null,
            },
          ],
        }),
      };
    }

    function buildRoundTwo(port: OptionSnapshotPort): SyncOptionOiSettleUseCase {
      const calendar = stubTradingCalendar({ status: 'trading' });
      // 🚨 段 b 的执行体是**主轮那个 use case 的真实例**, 不是替身 —— 「不另抄一份行映射」
      //    这条纪律只有真的调它才成立 (plan §D3 Guardrail 3)。
      const collector = new SyncOptionSnapshotUseCase(port, prisma, calendar);
      return new SyncOptionOiSettleUseCase(port, prisma, calendar, collector);
    }

    /** 整表读回 (按合约 id 排序), 供逐字段对拍。 */
    async function readSnapshots() {
      return prisma.optionDailySnapshot.findMany({
        orderBy: [{ contractId: 'asc' }, { source: 'asc' }],
      });
    }

    it('🚨 ① 主轮写行 → 轮2 → **只有三列变**, 其余列逐字段不变 (SC-004)', async () => {
      const { instrument, contracts } = await seedChain('00700', 3);
      await seedMainRoundRows(contracts);
      const before = await readSnapshots();

      const stats = emptyStats();
      await buildRoundTwo(settlePort()).run([instrument], dim, stats, {
        mode: 'delta',
        asOf: SESSION,
        now: ROUND_TWO_NOW,
      });

      const after = await readSnapshots();
      // 段 a 是 UPDATE 不是 INSERT —— 多出行意味着唯一键没碰撞 (#306 的 555× 放大形态)。
      expect(after).toHaveLength(before.length);
      for (const [i, row] of after.entries()) {
        // 三列: OI 值换成定稿后的, 标签从「上一交易日」抬到本场自己。
        expect(row.openInterest?.toString()).toBe('9999');
        expect(row.netOpenInterest?.toString()).toBe('-1111');
        expect(row.oiAsOf).toEqual(day(SESSION));
        // 🚨 逐字段对拍 (不是抽查): 少比一列, 那一列就是下一次静默回归的入口。
        for (const key of Object.keys(before[i]) as (keyof (typeof before)[number])[]) {
          if (MUTABLE_COLUMNS.has(key as string)) continue;
          expect(row[key], `轮2 改了它不该改的列: ${String(key)}`).toEqual(before[i][key]);
        }
      }
      // 🚨 报价那份仍是主轮 16:28 抢到的 —— 拿 21:40 的盘口盖掉它就是本片自我否定。
      expect(after.every((r) => r.quoteAsOf.getTime() === MAIN_QUOTE_AS_OF.getTime())).toBe(true);
      expect(after.every((r) => r.bid?.toString() === '2.3')).toBe(true);
      expect(stats.failed).toBe(0);
      expect(stats.written).toBe(3);
    });

    it('🚨 ② 主轮缺一批 → 段 b 补齐, 且**不重写**主轮已有的行 (SC-003)', async () => {
      const { instrument, contracts } = await seedChain('00700', 3);
      const [c1, c2, missing] = contracts;
      // 主轮只写成两张 —— 第三张是「整行缺失」, 归段 b。
      await seedMainRoundRows([c1, c2]);

      const stats = emptyStats();
      await buildRoundTwo(settlePort()).run([instrument], dim, stats, {
        mode: 'delta',
        asOf: SESSION,
        now: ROUND_TWO_NOW,
      });

      const after = await readSnapshots();
      expect(after).toHaveLength(3);
      const byContract = new Map(after.map((r) => [r.contractId, r]));

      // 段 b 补出来的那张: 整行俱全, source 与段 a 面对的那批**同值** (唯一键必须碰撞)。
      const filled = byContract.get(missing.id);
      expect(filled?.source).toBe('eod');
      expect(filled?.sessionDate).toEqual(day(SESSION));
      // 它的报价是**轮2 时刻**的 —— 这是补漏的已知代价, 不是 bug: 有一份塌掉的盘口, 好过没有行。
      expect(filled?.quoteAsOf.getTime()).toBe(SETTLE_QUOTE_AS_OF.getTime());
      expect(filled?.bid?.toString()).toBe('0.01');
      // 定稿判据为真 ⇒ 补出来的行 OI 标签直接落本场, 不退到上一交易日。
      expect(filled?.oiAsOf).toEqual(day(SESSION));

      // 🚨 两段对象集不相交的**可观测判据**: 主轮已有的两行 `quote_as_of` 逐值不变 ⇒ 段 b 的
      //    `createMany(skipDuplicates)` 真的被唯一键挡住了, 没有把 16:28 那份盖成 21:41。
      for (const c of [c1, c2]) {
        const row = byContract.get(c.id);
        expect(row?.quoteAsOf.getTime()).toBe(MAIN_QUOTE_AS_OF.getTime());
        expect(row?.bid?.toString()).toBe('2.3');
        // 而它们的 OI 由段 a 更新过。
        expect(row?.openInterest?.toString()).toBe('9999');
        expect(row?.oiAsOf).toEqual(day(SESSION));
      }
      expect(stats.failed).toBe(0);
    });

    it('🚨 ③ 定稿判据为假 (17:00 跑) → **零写入**, 库里一个字节都不动 (SC-007)', async () => {
      const { instrument, contracts } = await seedChain('00700', 3);
      await seedMainRoundRows(contracts);
      const before = await readSnapshots();

      const stats = emptyStats();
      await buildRoundTwo(settlePort()).run([instrument], dim, stats, {
        mode: 'delta',
        asOf: SESSION,
        // hk 当地 17:00 —— 晚于收盘、**早于** 21:30 定稿。misfire 补触发就会落在这一档。
        now: new Date(`${SESSION}T09:00:00Z`),
      });

      // 🚫 判据为假时正确动作是**不写**, 不是「写个近似值」: 此刻端点返的仍是上一场的持仓量,
      //    写进去就是数字与标签双错, 且不可逆 (供应方不提供历史快照)。
      expect(await readSnapshots()).toEqual(before);
      expect(stats.written).toBe(0);
      expect(stats.skipped).toBe(1);
      expect(stats.ok).toBe(0);
      expect(stats.failed).toBe(0);
    });
  });
});
