import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../security/prisma.service';
import { resolveInstrumentName, resolveInstrumentNames } from './instrument-name';

/**
 * 045 plan D13 名字取数侧。被测面 = 「ticker 解析 + 去重 + 一次往返 + 未注册退 null」——
 * 真表读法归 IT, 这里只钉住形状与降级。
 */
function stubPrisma(rows: { market: string; code: string; name: string }[]) {
  const findMany = vi.fn(async (_args: unknown) => rows);
  const findUnique = vi.fn(
    async ({ where }: { where: { market_code: { market: string; code: string } } }) => {
      const hit = rows.find(
        (r) => r.market === where.market_code.market && r.code === where.market_code.code,
      );
      return hit === undefined ? null : { name: hit.name };
    },
  );
  const prisma = { instrument: { findMany, findUnique } } as unknown as PrismaService;
  return { prisma, findMany, findUnique };
}

describe('resolveInstrumentNames', () => {
  it('批量一次往返交回 `market:code` ⇒ 名字', async () => {
    const { prisma, findMany } = stubPrisma([
      { market: 'hk', code: '01024', name: '快手-W' },
      { market: 'us', code: 'TTD', name: 'The Trade Desk' },
    ]);
    const got = await resolveInstrumentNames(prisma, ['hk:01024', 'us:TTD']);
    expect(got.get('hk:01024')).toBe('快手-W');
    expect(got.get('us:TTD')).toBe('The Trade Desk');
    // 🚨 一页 50 行逐行点查 = 50 次往返, 这条断言就是防它。
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('🚨 谓词按市场分组成 `market = ? AND code IN (…)`, 不是每票一个 OR 子句', async () => {
    const { prisma, findMany } = stubPrisma([]);
    // 同市场重复 ticker 去重; 跨市场各成一组。
    await resolveInstrumentNames(prisma, ['hk:01024', 'hk:01024', 'hk:00700', 'us:AOS']);
    expect(findMany.mock.calls[0][0]).toEqual({
      where: {
        OR: [
          { market: 'hk', code: { in: ['01024', '00700'] } },
          { market: 'us', code: { in: ['AOS'] } },
        ],
      },
      select: { market: true, code: true, name: true },
    });
  });

  it('未注册的票不进 map (呈现层退回代号, 不伪造名字)', async () => {
    const { prisma } = stubPrisma([{ market: 'hk', code: '01024', name: '快手-W' }]);
    const got = await resolveInstrumentNames(prisma, ['hk:01024', 'hk:09999']);
    expect(got.has('hk:09999')).toBe(false);
  });

  it('不可解析的 ticker 被丢弃; 全不可解析 ⇒ 零往返', async () => {
    const { prisma, findMany } = stubPrisma([]);
    expect((await resolveInstrumentNames(prisma, ['garbage', ''])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('resolveInstrumentName', () => {
  it('单只命中 ⇒ 名字', async () => {
    const { prisma } = stubPrisma([{ market: 'hk', code: '01024', name: '快手-W' }]);
    expect(await resolveInstrumentName(prisma, 'hk:01024')).toBe('快手-W');
  });

  it('未注册 ⇒ null', async () => {
    const { prisma } = stubPrisma([]);
    expect(await resolveInstrumentName(prisma, 'hk:09999')).toBeNull();
  });

  it('ticker 不可解析 ⇒ null 且零往返 (不猜市场)', async () => {
    const { prisma, findUnique } = stubPrisma([]);
    expect(await resolveInstrumentName(prisma, 'garbage')).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
