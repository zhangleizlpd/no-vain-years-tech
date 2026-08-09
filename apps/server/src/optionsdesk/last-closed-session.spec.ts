import { describe, expect, it, vi } from 'vitest';
import { resolveLastClosedSessions } from './last-closed-session';
import type { PrismaService } from '../security/prisma.service';

/** stub prisma: 只喂 `tradingDay.findFirst`, 记录 where 供断言 cutoff 传对。 */
function stubPrisma(rows: Record<string, string | null>) {
  const findFirst = vi.fn(async ({ where }: { where: { market: string; date: { lte: Date } } }) => {
    const ymd = rows[where.market];
    return ymd === undefined || ymd === null ? null : { date: new Date(`${ymd}T00:00:00.000Z`) };
  });
  return { prisma: { tradingDay: { findFirst } } as unknown as PrismaService, findFirst };
}

describe('resolveLastClosedSessions', () => {
  /** 北京 2026-08-04(二) 10:00 = ET 08-03(一) 22:00 —— 周一早已收盘。 */
  const beijingTueMorning = new Date('2026-08-04T02:00:00Z');

  it('取 ≤ 收盘上界的最大交易日, 出参为 YYYY-MM-DD', async () => {
    const { prisma, findFirst } = stubPrisma({ us: '2026-08-03' });
    const got = await resolveLastClosedSessions(prisma, ['us'], beijingTueMorning);
    expect(got.get('us')).toBe('2026-08-03');
    // cutoff = ET 当地已过 16:00 的那一天 (08-03), 而不是北京日期 (08-04)。
    expect(findFirst.mock.calls[0]?.[0].where.date.lte).toEqual(
      new Date('2026-08-03T00:00:00.000Z'),
    );
  });

  it('日历无行 ⇒ null (交由 freshnessTier fail-open)', async () => {
    const { prisma } = stubPrisma({ us: null });
    expect(
      (await resolveLastClosedSessions(prisma, ['us'], beijingTueMorning)).get('us'),
    ).toBeNull();
  });

  it('多市场各查各的; 重复市场只查一次 (Set 去重)', async () => {
    const { prisma, findFirst } = stubPrisma({ us: '2026-08-03', cn: '2026-08-04' });
    const got = await resolveLastClosedSessions(prisma, ['us', 'cn', 'us'], beijingTueMorning);
    expect(got.get('us')).toBe('2026-08-03');
    expect(got.get('cn')).toBe('2026-08-04');
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('空市场列表 ⇒ 空 Map, 零查询', async () => {
    const { prisma, findFirst } = stubPrisma({});
    expect((await resolveLastClosedSessions(prisma, [], beijingTueMorning)).size).toBe(0);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
