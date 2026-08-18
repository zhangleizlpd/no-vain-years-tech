import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../src/security/prisma.service';
import { FreshnessSlaCheck } from '../../src/marketdata/freshness-sla.check';
import type { TradingCalendarPort } from '../../src/marketdata/trading-calendar.port';

// 2026-06-05 (周五) 08:30 Asia/Shanghai = 00:30Z — 检查时点锚。
const NOW = new Date('2026-06-05T00:30:00Z');

/** 工作日历 stub: 周一~周五交易日 (Mock adapter 同语义); 可整体关 (长假模拟)。 */
const weekdayCalendar = (allClosed = false): TradingCalendarPort => ({
  classify: async (_market: string, date: string) => {
    if (allClosed) return 'non-trading';
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    return day >= 1 && day <= 5 ? 'trading' : 'non-trading';
  },
  // 062 T010: 本文件只验折龄, 陈旧度基准恒不可判定。
  lastClosedSession: async () => null,
});

// 019 T017 新鲜度 SLA 检查 IT (US4/FR-S09, SC-S06 四态, PG-only): 超期告警字段齐 /
// event-calendar skipped 不误报 / 休市长假不误报 / 恢复后不再告警。基准 = SyncRun 最近
// success|partial|skipped 行 finishedAt, 按交易日历折算逾期。
describe('019 T017 FreshnessSlaCheck (SC-S06 四态)', () => {
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

  beforeEach(async () => {
    await prisma.syncRun.deleteMany();
    // 只留 eod_bar 一个受检维度 (sla 30h), 其余关检查 — 聚焦断言面。
    await prisma.syncDimension.updateMany({ data: { slaHours: null } });
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { slaHours: 30 },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 落一行终态 SyncRun (基准行)。 */
  async function seedRun(
    syncType: string,
    status: 'success' | 'partial' | 'skipped' | 'failed',
    finishedAt: Date,
  ): Promise<void> {
    await prisma.syncRun.create({
      data: { syncType, status, finishedAt, startedAt: finishedAt },
    });
  }

  function build(calendar: TradingCalendarPort = weekdayCalendar()): FreshnessSlaCheck {
    return new FreshnessSlaCheck(prisma, calendar);
  }

  it('① 超期 → 结构化 ERROR 告警字段齐 (维度名/最后成功时间/SLA 阈值/折算龄)', async () => {
    // 最近 success = 周二 (06-02) 22:30 Shanghai — 到周五 08:30 跨周三/周四全交易日,
    // 折算龄 ≈ 58h > 30h。
    const last = new Date('2026-06-02T14:30:00Z');
    await seedRun('sync:eod_bar', 'success', last);
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const stale = await build().check(NOW);
    expect(stale).toEqual(['eod_bar']);
    const msg = String(errorSpy.mock.calls.at(-1)?.[0]);
    expect(msg).toContain('freshness SLA exceeded');
    expect(msg).toContain('"dimensionKey":"eod_bar"');
    expect(msg).toContain(last.toISOString());
    expect(msg).toContain('"slaHours":30');
    expect(msg).toContain('tradingAgeHours');
  });

  it('② event-calendar skipped 视同按日历正常 — 不误报 (FR-S09)', async () => {
    // 旧 success 已超 30h, 但最近一行是昨日 (06-04) 的 skipped (平淡日 gate 跳过) → 基准
    // 以 skipped 行算, 折算龄 ~10h < 30h → 不告警。
    await seedRun('sync:eod_bar', 'success', new Date('2026-06-01T14:30:00Z'));
    await seedRun('sync:eod_bar', 'skipped', new Date('2026-06-04T14:30:00Z'));
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const stale = await build().check(NOW);
    expect(stale).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('③ 休市长假不误报: 日历全休市 → 折算龄 0, 物理龄再久也不算 stale', async () => {
    // 最近 success 5 天前 (物理 ~120h > 30h), 但长假全休市 → 交易折算龄 0 → 不告警。
    await seedRun('sync:eod_bar', 'success', new Date('2026-05-31T14:30:00Z'));
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const stale = await build(weekdayCalendar(true)).check(NOW);
    expect(stale).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('④ 恢复后不再告警: 超期告警 → 新 success 行落库 → 下次检查零告警', async () => {
    await seedRun('sync:eod_bar', 'success', new Date('2026-06-02T14:30:00Z'));
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const checker = build();
    expect(await checker.check(NOW)).toEqual(['eod_bar']); // 第一日: 告警。

    // 恢复: 当夜同步成功 (06-05 22:30) → 次日检查 (06-06 08:30, 周六但折算龄 ~0)。
    await seedRun('sync:eod_bar', 'success', new Date('2026-06-05T14:30:00Z'));
    errorSpy.mockClear();
    const nextDay = new Date('2026-06-06T00:30:00Z');
    expect(await checker.check(nextDay)).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('⑤ failed 行不是基准 (不延寿): 最近行 failed → 仍以上一 success 计龄', async () => {
    await seedRun('sync:eod_bar', 'success', new Date('2026-06-02T14:30:00Z'));
    await seedRun('sync:eod_bar', 'failed', new Date('2026-06-04T14:30:00Z')); // 失败不算新鲜。
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    expect(await build().check(NOW)).toEqual(['eod_bar']);
  });

  it('⑥ 无基准行 (首跑前) → 跳过判定 + WARN 不误报 (上线即告警防御)', async () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(await build().check(NOW)).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(String(warnSpy.mock.calls.at(-1)?.[0])).toContain('无 success/partial/skipped 基准行');
  });

  it('⑦ per-market 折算龄按维度 marketScope (非硬编码 cn): cn 恒休市但 hk 交易 → 用 hk 日历计龄 (S2-T1)', async () => {
    // eod_bar 改 hk-only; 日历: cn/us 恒休市, 仅 hk 周一~周五。旧 MARKET='cn' 硬编码会算龄 0 (cn 恒关)
    // → 漏报; per-market 用 hk 日历 → 周三/周四交易日累龄 ~58h > 30h → 正确 stale。
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { marketScope: ['hk'] },
    });
    await seedRun('sync:eod_bar', 'success', new Date('2026-06-02T14:30:00Z'));
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const hkOnlyCalendar: TradingCalendarPort = {
      classify: async (market, date) => {
        if (market !== 'hk') return 'non-trading'; // cn/us 恒休市 — 证明未走硬编码 cn。
        const day = new Date(`${date}T00:00:00Z`).getUTCDay();
        return day >= 1 && day <= 5 ? 'trading' : 'non-trading';
      },
      lastClosedSession: async () => null,
    };
    expect(await build(hkOnlyCalendar).check(NOW)).toEqual(['eod_bar']);
  });

  it('🚨 ⑧ 062 T006 Guardrail 1: 日历 `unknown` ≡ 当开市 (与全交易日日历逐点同结果)', async () => {
    // 本调用点的机械映射是 `!== 'non-trading'` —— `unknown` 走**当开市**侧 (保守多算龄), 与
    // 改动前日历未 populate 时 fail-open 返 true 逐点相同。写成 `=== 'trading'` 会让上线首刻
    // (覆盖声明空 ⇒ 全 unknown) 折算龄恒 0 ⇒ **再陈旧也永不告警**, 而没有任何既有断言会红。
    await seedRun('sync:eod_bar', 'success', new Date('2026-06-02T14:30:00Z'));
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const allUnknown: TradingCalendarPort = {
      classify: async () => 'unknown',
      lastClosedSession: async () => null,
    };
    const allTrading: TradingCalendarPort = {
      classify: async () => 'trading',
      lastClosedSession: async () => null,
    };
    expect(await build(allUnknown).check(NOW)).toEqual(await build(allTrading).check(NOW));
    // 且**不是**空数组 —— 两边同为 `[]` 时上面那条恒真, 起不到钉子作用。
    expect(await build(allUnknown).check(NOW)).toEqual(['eod_bar']);
  });
});
