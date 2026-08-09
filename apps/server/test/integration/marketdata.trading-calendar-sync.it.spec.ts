import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';
import type { TradingCalendarSource } from '../../src/marketdata/trading-calendar-source.port';
import {
  CALENDAR_MARKETS,
  TradingCalendarSyncService,
} from '../../src/marketdata/trading-calendar-sync.service';

/**
 * TradingCalendarSyncService 真落库 IT (sync-1 S1-T2, Testcontainers PG)。补 mock 单测覆盖
 * 不到的缝 —— createMany skipDuplicates 真幂等 + `trading_day` (market,date) 复合主键真去重 +
 * populate 近窗口计算 (to=今日 / from=今日-30)。vendor 由 stub source 供 (确定性, 无外呼)。
 *
 * 🚨 **044 T012 认领**: 本文件是日历填充唯一的既有 IT。心跳 (`calendar_sync_health`) 落地后,
 * 「单市场源抛错 → **只** WARN 续跑」这条旧断言**已被推翻** —— 续跑保留 (韧性, FR-004),
 * 静默废除 (病根, FR-008): 失败市场必写 `lastError` 且 `lastSuccessAt` 不动。成功路径的
 * 心跳断言补在既有 upsert / 幂等 it 上。心跳写入意图的穷举 (create 分支 / servedBy 各值 /
 * 心跳自身写失败) 见 `src/marketdata/trading-calendar-sync.service.spec.ts`。
 */

/** stub 交易日历源: 记录调用参数 + 按 market 返回预置日期 (未预置 → 空)。 */
function stubSource(byMarket: Record<string, string[]>): {
  source: TradingCalendarSource;
  calls: { market: string; from: string; to: string }[];
} {
  const calls: { market: string; from: string; to: string }[] = [];
  const source: TradingCalendarSource = {
    async fetchTradingDates(market, from, to) {
      calls.push({ market, from, to });
      return { dates: byMarket[market] ?? [], servedBy: 'stub' };
    },
  };
  return { source, calls };
}

/** syncRange/populate 不读 cfg (仅 @Cron handleCron 读 tickEnabled) → IT 传最小占位。 */
const CFG = { tickEnabled: true } as unknown as MarketdataSyncConfig;

describe('TradingCalendarSyncService (Testcontainers PG) — 真落库填充 + 幂等', () => {
  let prisma: PrismaService;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.tradingDay.deleteMany();
    await prisma.calendarSyncHealth.deleteMany();
  });

  /** 心跳行读取 helper (per-market, 未写过 → null)。 */
  const healthOf = (market: string) => prisma.calendarSyncHealth.findUnique({ where: { market } });

  it('syncRange → 逐市场 upsert trading_day; result.inserted = 新落库行数', async () => {
    const { source, calls } = stubSource({
      cn: ['2026-07-13', '2026-07-14'],
      hk: ['2026-07-13'],
    });
    const svc = new TradingCalendarSyncService(source, prisma, CFG);

    const results = await svc.syncRange(['cn', 'hk'], '2026-07-01', '2026-07-14');

    expect(results).toEqual([
      { market: 'cn', fetched: 2, inserted: 2 },
      { market: 'hk', fetched: 1, inserted: 1 },
    ]);
    // 源被按市场调用, 参数透传。
    expect(calls).toEqual([
      { market: 'cn', from: '2026-07-01', to: '2026-07-14' },
      { market: 'hk', from: '2026-07-01', to: '2026-07-14' },
    ]);
    // 真落库: cn 2 行 + hk 1 行, date 存为 UTC 零点 (与 alert 读法 new Date('YYYY-MM-DD') 同)。
    const cn = await prisma.tradingDay.findMany({
      where: { market: 'cn' },
      orderBy: { date: 'asc' },
    });
    expect(cn.map((r) => r.date.toISOString().slice(0, 10))).toEqual(['2026-07-13', '2026-07-14']);
    expect(await prisma.tradingDay.count({ where: { market: 'hk' } })).toBe(1);

    // 044 T012: 成功 → per-market 心跳真落库 (lastSuccessAt 新 + servedBy 记胜出层 + 无 error)。
    for (const market of ['cn', 'hk']) {
      const h = await healthOf(market);
      expect(h?.lastSuccessAt).toBeInstanceOf(Date);
      expect(h?.servedBy).toBe('stub'); // 链的自报家门原样落库 → 探针据此判「是否降级运行」。
      expect(h?.lastError).toBeNull();
    }
  });

  it('重跑同区间 → skipDuplicates 幂等 (inserted=0, 总行数不变)', async () => {
    const { source } = stubSource({ cn: ['2026-07-13', '2026-07-14'] });
    const svc = new TradingCalendarSyncService(source, prisma, CFG);

    const first = await svc.syncRange(['cn'], '2026-07-01', '2026-07-14');
    expect(first[0]).toEqual({ market: 'cn', fetched: 2, inserted: 2 });
    const firstBeat = (await healthOf('cn'))?.lastSuccessAt;

    const second = await svc.syncRange(['cn'], '2026-07-01', '2026-07-14');
    expect(second[0]).toEqual({ market: 'cn', fetched: 2, inserted: 0 }); // 全已存在 → 0 新增

    expect(await prisma.tradingDay.count({ where: { market: 'cn' } })).toBe(2);

    // 🚨 044 T012 — 心跳判 **liveness 而非 freshness**: 第二轮零新增照样刷 lastSuccessAt。
    // 这正是长假语义 (每晚填充成功但无新交易日) → 心跳恒新 → 探针不误报 (SC-005)。
    // 若心跳跟着 `inserted` 走, 春节长假就会天天喊「日历坏了」, 把告警训练成狼来了。
    const secondBeat = (await healthOf('cn'))?.lastSuccessAt;
    expect(secondBeat?.getTime()).toBeGreaterThanOrEqual(firstBeat!.getTime());
    expect((await healthOf('cn'))?.lastError).toBeNull();
  });

  it('🚨 单市场源抛错 → 续跑其余市场, **且**该市场写 lastError / 不刷 lastSuccessAt (044 T012)', async () => {
    // 旧断言 =「WARN 续跑」即通过 —— 那正是 044 事故的形状: 源被下线, 日志里一行 WARN,
    // 库里什么都没变, 于是没有任何自动化看得见, 静默停摆 2 天。续跑对, 只 WARN 不对。
    const source: TradingCalendarSource = {
      async fetchTradingDates(market) {
        if (market === 'cn') throw new Error('vendor down');
        return { dates: ['2026-07-13'], servedBy: 'stub' };
      },
    };
    const svc = new TradingCalendarSyncService(source, prisma, CFG);

    // 先埋一行「昨天成功过」的心跳 —— 失败必须**保住**它 (而非刷新), 心跳才会随时间陈旧。
    const yesterday = new Date(Date.now() - 24 * 3600_000);
    await prisma.calendarSyncHealth.create({
      data: { market: 'cn', lastSuccessAt: yesterday, lastAttemptAt: yesterday, servedBy: 'stub' },
    });

    const results = await svc.syncRange(['cn', 'hk'], '2026-07-01', '2026-07-14');

    // ① 续跑不变 (FR-004「一市场坏不拖垮全局」) —— 本 task 不砍韧性, 只砍静默。
    expect(results).toEqual([
      { market: 'cn', fetched: 0, inserted: 0 }, // 抛错 → 计 0, 不阻塞
      { market: 'hk', fetched: 1, inserted: 1 },
    ]);
    expect(await prisma.tradingDay.count()).toBe(1); // 仅 hk 落库

    // ② 静默废除 (FR-008): 失败在库里留痕, 且 lastSuccessAt 停在昨天 → 陈旧 → 探针可告警。
    const cn = await healthOf('cn');
    expect(cn?.lastError).toContain('vendor down');
    expect(cn?.lastSuccessAt?.getTime()).toBe(yesterday.getTime()); // 🚨 纹丝不动
    expect(cn?.servedBy).toBe('stub'); // 失败不覆盖「上次由谁服务」
    expect(cn?.lastAttemptAt?.getTime()).toBeGreaterThan(yesterday.getTime()); // 但「跑过」有记录

    // ③ 健康市场心跳不被邻居的故障污染。
    const hk = await healthOf('hk');
    expect(hk?.lastError).toBeNull();
    expect(hk?.lastSuccessAt).toBeInstanceOf(Date);
  });

  it('populate → 近 30 日窗口 (to=今日, from=今日-30), 覆盖 CALENDAR_MARKETS 三市场', async () => {
    const { source, calls } = stubSource({
      cn: ['2026-07-14'],
      hk: ['2026-07-14'],
      us: ['2026-07-13'],
    });
    const svc = new TradingCalendarSyncService(source, prisma, CFG);

    // 固定 now = 2026-07-14T12:00:00+08:00 → shanghaiToday = 2026-07-14。
    await svc.populate(new Date('2026-07-14T04:00:00Z'));

    expect(calls.map((c) => c.market)).toEqual([...CALENDAR_MARKETS]); // cn/hk/us 全遍历
    for (const c of calls) {
      expect(c.to).toBe('2026-07-14');
      expect(c.from).toBe('2026-06-14'); // 今日 - 30 日
    }
    expect(await prisma.tradingDay.count()).toBe(3); // cn+hk+us 各 1
  });
});
