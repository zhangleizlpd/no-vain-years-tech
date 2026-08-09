import { describe, it, expect, vi } from 'vitest';
import type { MarketdataSyncConfig } from '../config/marketdata.config.js';
import type { PrismaService } from '../security/prisma.service.js';
import type { TradingCalendarSource } from './trading-calendar-source.port.js';
import { TradingCalendarSyncService } from './trading-calendar-sync.service.js';

/**
 * 044 T012 — `TradingCalendarSyncService` 心跳写入纯逻辑 (mock 链 + mock prisma, 无 DB)。
 *
 * ★ **本 task 的立意**: 旧实现 per-market catch **只 WARN + `inserted:0` 续跑** —— 这正是
 * 044 事故潜伏 2 天的直接成因 (「本次跑过」被当成「本次成功」, 无人看得见失败)。
 * 改后: 成功 → 刷心跳 (`lastSuccessAt` + `servedBy` + 清 `lastError`); 失败 → 只记
 * `lastAttemptAt` + `lastError`, **`lastSuccessAt`/`servedBy` 纹丝不动** → 心跳陈旧 → 探针告警。
 *
 * 🚨 **续跑是韧性, 静默才是病 —— 两者不矛盾**: 「一市场坏不拖垮全局」(FR-004) 保留不动,
 * 废除的只是「坏了没人知道」(FR-008)。
 *
 * 🚨 **降级 ≠ 健康** (FR-014): L2 接住时填充虽成功, 但 `servedBy` 必须如实落库 ('static'),
 * 供探针判「降级运行」(谓词 T013 / 探针 T014)。真落库/幂等/PG 语义由 IT 覆盖
 * (`test/integration/marketdata.trading-calendar-sync.it.spec.ts`), 此处只验写入意图。
 */

/** mock prisma: 记录 `calendar_sync_health` upsert 入参 (断言面) + `trading_day` 落库计数。 */
function mockPrisma(): {
  prisma: PrismaService;
  upserts: { where: { market: string }; create: UpsertData; update: UpsertData }[];
} {
  const upserts: { where: { market: string }; create: UpsertData; update: UpsertData }[] = [];
  const prisma = {
    tradingDay: {
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
    },
    calendarSyncHealth: {
      upsert: vi.fn(async (args: (typeof upserts)[number]) => {
        upserts.push(args);
        return args.create;
      }),
    },
  } as unknown as PrismaService;
  return { prisma, upserts };
}

/** 心跳写入数据形状 (Prisma `CalendarSyncHealth` 的可写列子集)。 */
interface UpsertData {
  market?: string;
  lastSuccessAt?: Date;
  lastAttemptAt?: Date;
  lastError?: string | null;
  servedBy?: string;
}

/** syncRange 不读 cfg (仅 @Cron handleCron 读 tickEnabled) → 最小占位。 */
const CFG = { tickEnabled: true } as unknown as MarketdataSyncConfig;

/** 健康链: 按 market 返日历 + 自报服务方 (未预置 → throw, 模拟该市场取数失败)。 */
function chain(byMarket: Record<string, string[]>, servedBy: string): TradingCalendarSource {
  return {
    fetchTradingDates: vi.fn(async (market: string) => {
      const dates = byMarket[market];
      if (!dates) throw new Error(`[${servedBy}] 无 ${market} 数据`);
      return { dates, servedBy };
    }),
  };
}

const heartbeatOf = (
  upserts: ReturnType<typeof mockPrisma>['upserts'],
  market: string,
): { where: { market: string }; create: UpsertData; update: UpsertData } | undefined =>
  upserts.find((u) => u.where.market === market);

describe('TradingCalendarSyncService — 心跳写入 (044 T012: 失败不再静默吞)', () => {
  it('per-market 成功 → upsert 心跳: 刷 lastSuccessAt + 记 servedBy + 清 lastError', async () => {
    const { prisma, upserts } = mockPrisma();
    const svc = new TradingCalendarSyncService(
      chain({ cn: ['2026-07-13', '2026-07-14'] }, 'tencent'),
      prisma,
      CFG,
    );

    const results = await svc.syncRange(['cn'], '2026-07-01', '2026-07-14');

    expect(results).toEqual([{ market: 'cn', fetched: 2, inserted: 2 }]);
    const hb = heartbeatOf(upserts, 'cn');
    expect(hb).toBeDefined();
    expect(hb?.update.lastSuccessAt).toBeInstanceOf(Date);
    expect(hb?.update.lastAttemptAt).toBeInstanceOf(Date);
    expect(hb?.update.servedBy).toBe('tencent');
    // 上一轮的错误必须被清 —— 否则「已恢复」的市场永远挂着陈年 lastError。
    expect(hb?.update.lastError).toBeNull();
    // create 分支 (首次填充, 表内无行) 同样带齐四列。
    expect(hb?.create.market).toBe('cn');
    expect(hb?.create.servedBy).toBe('tencent');
    expect(hb?.create.lastSuccessAt).toBeInstanceOf(Date);
    expect(hb?.create.lastError).toBeNull();
  });

  it('🚨 L2 接住 (降级运行) → 填充成功但 servedBy 如实落 "static" (降级 ≠ 健康, FR-014)', async () => {
    const { prisma, upserts } = mockPrisma();
    // 链已把 L1 死/L2 活消化掉 → service 只看到胜出节点的自报家门。
    const svc = new TradingCalendarSyncService(
      chain({ hk: ['2026-07-13'] }, 'static'),
      prisma,
      CFG,
    );

    const results = await svc.syncRange(['hk'], '2026-07-01', '2026-07-14');

    // 填充「成功」—— 但已失去冗余, 心跳必须暴露这一事实, 否则降级静默数月到跨年才爆炸。
    expect(results).toEqual([{ market: 'hk', fetched: 1, inserted: 1 }]);
    expect(heartbeatOf(upserts, 'hk')?.update.servedBy).toBe('static');
    expect(heartbeatOf(upserts, 'hk')?.update.lastSuccessAt).toBeInstanceOf(Date);
  });

  it('🚨 per-market 失败 → 写 lastError + lastAttemptAt, **不动** lastSuccessAt/servedBy', async () => {
    const { prisma, upserts } = mockPrisma();
    const source: TradingCalendarSource = {
      fetchTradingDates: vi.fn(async () => {
        throw new Error('全链失败: [tencent] 端点 503 / [static] 区间外');
      }),
    };
    const svc = new TradingCalendarSyncService(source, prisma, CFG);

    const results = await svc.syncRange(['cn'], '2026-07-01', '2026-07-14');

    expect(results).toEqual([{ market: 'cn', fetched: 0, inserted: 0 }]);
    const hb = heartbeatOf(upserts, 'cn');
    expect(hb).toBeDefined();
    expect(hb?.update.lastAttemptAt).toBeInstanceOf(Date);
    expect(hb?.update.lastError).toContain('端点 503');
    // 🚨 「本次跑过」绝不等于「本次成功」: 失败刷新 lastSuccessAt = 探针永远看不到故障 = 静默停摆重演。
    expect(hb?.update).not.toHaveProperty('lastSuccessAt');
    expect(hb?.update).not.toHaveProperty('servedBy');
    // create 分支 (从未成功过的市场) 同理: 只有 attempt + error, 无 success/servedBy。
    expect(hb?.create).not.toHaveProperty('lastSuccessAt');
    expect(hb?.create).not.toHaveProperty('servedBy');
    // 日历表零写入 (取数失败 → 无数据可落)。
    expect(prisma.tradingDay.createMany).not.toHaveBeenCalled();
  });

  it('🚨 失败不再被静默吞: 旧实现只 WARN + inserted:0 → 现在每次失败必留库内痕迹', async () => {
    const { prisma, upserts } = mockPrisma();
    const svc = new TradingCalendarSyncService(chain({}, 'tencent'), prisma, CFG);

    const results = await svc.syncRange(['cn'], '2026-07-01', '2026-07-14');

    // 返回值仍是旧形状 (调用方 API 不变) —— 病根不在返回值, 在「除了返回值以外什么都没留下」。
    expect(results).toEqual([{ market: 'cn', fetched: 0, inserted: 0 }]);
    expect(prisma.calendarSyncHealth.upsert).toHaveBeenCalledOnce();
    expect(heartbeatOf(upserts, 'cn')?.update.lastError).toBeTruthy();
  });

  it('🚨 一市场失败其余照跑 (FR-004 续跑保留) + 各自心跳独立 (成功/失败形状互不污染)', async () => {
    const { prisma, upserts } = mockPrisma();
    // cn 未预置 → 抛; hk 正常。
    const svc = new TradingCalendarSyncService(
      chain({ hk: ['2026-07-13'] }, 'tencent'),
      prisma,
      CFG,
    );

    const results = await svc.syncRange(['cn', 'hk'], '2026-07-01', '2026-07-14');

    // 续跑不变: cn 坏了但 hk 照常落库。
    expect(results).toEqual([
      { market: 'cn', fetched: 0, inserted: 0 },
      { market: 'hk', fetched: 1, inserted: 1 },
    ]);
    expect(upserts.map((u) => u.where.market)).toEqual(['cn', 'hk']);
    // 坏市场: 有 error 无 success。
    expect(heartbeatOf(upserts, 'cn')?.update.lastError).toBeTruthy();
    expect(heartbeatOf(upserts, 'cn')?.update).not.toHaveProperty('lastSuccessAt');
    // 好市场: 有 success 且 error 被清 —— 一个市场的故障不污染另一个市场的健康信号。
    expect(heartbeatOf(upserts, 'hk')?.update.lastSuccessAt).toBeInstanceOf(Date);
    expect(heartbeatOf(upserts, 'hk')?.update.lastError).toBeNull();
  });

  it('心跳写入本身失败 → 记 ERROR 但不连坐其余市场 (心跳是观测面, 不该反过来当故障源)', async () => {
    const { prisma } = mockPrisma();
    vi.mocked(prisma.calendarSyncHealth.upsert).mockRejectedValue(new Error('PG 连接中断'));
    const svc = new TradingCalendarSyncService(
      chain({ hk: ['2026-07-13'] }, 'tencent'),
      prisma,
      CFG,
    );

    // cn 取数失败 → 走失败心跳 (也炸) ; hk 取数成功 → 走成功心跳 (也炸)。整体仍不抛。
    const results = await svc.syncRange(['cn', 'hk'], '2026-07-01', '2026-07-14');

    expect(results).toEqual([
      { market: 'cn', fetched: 0, inserted: 0 },
      { market: 'hk', fetched: 1, inserted: 1 },
    ]);
  });
});
