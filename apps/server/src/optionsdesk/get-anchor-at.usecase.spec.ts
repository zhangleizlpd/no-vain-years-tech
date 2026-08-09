import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { GetAnchorAtUseCase } from './get-anchor-at.usecase';
import type { PrismaService } from '../security/prisma.service';

type Fn = ReturnType<typeof vi.fn>;

const currentRow = {
  id: 7n,
  ticker: 'us:AOS',
  v: new Prisma.Decimal('60'),
  asof: new Date('2026-07-01T00:00:00Z'),
  method: 'dcf',
  confidence: new Prisma.Decimal('9.2'),
  confidenceSource: 'model',
  excluded: false,
  excludeReason: null,
  nextReview: new Date('2026-09-30T00:00:00Z'),
  lastReviewedOn: new Date('2026-05-01T00:00:00Z'),
  vManual: null,
  lLevelManual: null,
  positionCapManual: null,
  lLevelEffective: 'L1',
  lastClose: new Prisma.Decimal('47.5'),
  lastCloseDate: new Date('2026-08-01T00:00:00Z'),
  breachStartedOn: null,
  createdAt: new Date('2026-05-01T00:00:00Z'),
  updatedAt: new Date('2026-07-01T00:00:00Z'),
};

const importChange = {
  changedAt: new Date('2026-07-01T10:00:00Z'),
  changedFields: ['v', 'confidence', 'confidenceSource', 'lLevelEffective'],
  beforeValues: { v: '50', confidence: '8', confidenceSource: 'manual', lLevelEffective: 'L2' },
  source: 'model',
};

interface PrismaMock {
  prisma: PrismaService;
  findUnique: Fn;
  findMany: Fn;
}

function buildPrismaMock(): PrismaMock {
  const findUnique = vi.fn().mockResolvedValue(currentRow);
  const findMany = vi.fn().mockResolvedValue([importChange]);
  const prisma = {
    anchor: { findUnique },
    anchorChange: { findMany },
  } as unknown as PrismaService;
  return { prisma, findUnique, findMany };
}

describe('GetAnchorAtUseCase — PIT 还原查询 (SC-011, plan D15)', () => {
  let m: PrismaMock;
  let useCase: GetAnchorAtUseCase;
  const at = new Date('2026-06-15T00:00:00Z');

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new GetAnchorAtUseCase(m.prisma);
  });

  it('只取时点之后的痕迹 (倒放范围 = changed_at > at), 按 changed_at 倒序', async () => {
    await useCase.execute(7n, at);
    const args = m.findMany.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.where).toEqual({ anchorId: 7n, changedAt: { gt: at } });
    expect(args.orderBy).toEqual([{ changedAt: 'desc' }, { id: 'desc' }]);
  });

  it('回放出当时的 V / W / L 层 / 单票上限 / 愿卖锚', async () => {
    const pit = await useCase.execute(7n, at);
    expect(pit).not.toBeNull();
    expect(pit!.v.toString()).toBe('50');
    expect(pit!.w.toString()).toBe('40');
    expect(pit!.lLevel).toBe('L2');
    expect(pit!.positionCap!.toString()).toBe('0.05');
    expect(pit!.willingSell.rent.toString()).toBe('50');
  });

  it('锚已删除 (当前行不存在) → 仍能凭删锚痕迹还原', async () => {
    m.findUnique.mockResolvedValue(null);
    m.findMany.mockResolvedValue([
      {
        changedAt: new Date('2026-07-20T10:00:00Z'),
        changedFields: ['v', 'confidence', 'lLevelEffective'],
        beforeValues: { v: '50', confidence: '8', lLevelEffective: 'L2' },
        source: 'manual',
      },
    ]);
    const pit = await useCase.execute(7n, at);
    expect(pit!.v.toString()).toBe('50');
  });

  it('时点早于建锚 (痕迹里有 beforeValues 为空的建锚条) → null', async () => {
    m.findMany.mockResolvedValue([
      importChange,
      {
        changedAt: new Date('2026-05-01T10:00:00Z'),
        changedFields: ['v'],
        beforeValues: {},
        source: 'manual',
      },
    ]);
    expect(await useCase.execute(7n, new Date('2026-04-01T00:00:00Z'))).toBeNull();
  });

  it('锚不存在且无任何痕迹 → null (不抛)', async () => {
    m.findUnique.mockResolvedValue(null);
    m.findMany.mockResolvedValue([]);
    expect(await useCase.execute(7n, at)).toBeNull();
  });
});
