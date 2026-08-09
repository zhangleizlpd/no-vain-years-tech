import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { DeleteAnchorUseCase } from './delete-anchor.usecase';
import type { PrismaService } from '../security/prisma.service';

type Fn = ReturnType<typeof vi.fn>;

const anchorRow = {
  id: 7n,
  ticker: 'us:AOS',
  v: new Prisma.Decimal('50'),
  asof: new Date('2026-06-30T00:00:00Z'),
  method: 'dcf',
  confidence: new Prisma.Decimal('8'),
  confidenceSource: 'manual',
  excluded: false,
  excludeReason: null,
  nextReview: new Date('2026-09-30T00:00:00Z'),
  lastReviewedOn: new Date('2026-06-30T00:00:00Z'),
  vManual: null,
  lLevelManual: 'L3',
  positionCapManual: new Prisma.Decimal('0.10'),
  lLevelEffective: 'L3',
  lastClose: null,
  lastCloseDate: null,
  breachStartedOn: null,
  createdAt: new Date('2026-05-01T00:00:00Z'),
  updatedAt: new Date('2026-06-30T00:00:00Z'),
};

interface PrismaMock {
  prisma: PrismaService;
  findUnique: Fn;
  deleteMany: Fn;
  changeCreate: Fn;
}

function buildPrismaMock(): PrismaMock {
  const findUnique = vi.fn().mockResolvedValue(anchorRow);
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const changeCreate = vi.fn().mockResolvedValue(undefined);
  const tx = { anchor: { deleteMany }, anchorChange: { create: changeCreate } };
  const prisma = {
    anchor: { findUnique, deleteMany },
    anchorChange: { create: changeCreate },
    $transaction: vi.fn(async (cb: (client: unknown) => unknown) => cb(tx)),
  } as unknown as PrismaService;
  return { prisma, findUnique, deleteMany, changeCreate };
}

describe('DeleteAnchorUseCase — 删锚保留痕迹 (FR-031)', () => {
  let m: PrismaMock;
  let useCase: DeleteAnchorUseCase;

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new DeleteAnchorUseCase(m.prisma);
  });

  it('锚不存在 → 404 ANCHOR_NOT_FOUND, 不写痕迹', async () => {
    m.findUnique.mockResolvedValue(null);
    await expect(useCase.execute(7n)).rejects.toBeInstanceOf(NotFoundException);
    expect(m.changeCreate).not.toHaveBeenCalled();
  });

  it('读写窗内被并发删除 (deleteMany count = 0) → 404 且不写痕迹', async () => {
    m.deleteMany.mockResolvedValue({ count: 0 });
    await expect(useCase.execute(7n)).rejects.toMatchObject({
      message: expect.stringContaining('ANCHOR_NOT_FOUND'),
    });
    expect(m.changeCreate).not.toHaveBeenCalled();
  });

  it('删锚本身也落**恰好一条**痕迹', async () => {
    await useCase.execute(7n);
    expect(m.changeCreate).toHaveBeenCalledTimes(1);
  });

  it('痕迹存整行快照 (删后仍可 PIT 还原当时的 V / L 层 / 上限)', async () => {
    await useCase.execute(7n);
    const data = m.changeCreate.mock.calls[0]![0].data as Record<string, unknown>;
    const before = data.beforeValues as Record<string, unknown>;
    expect(before.v).toBe('50');
    expect(before.lLevelManual).toBe('L3');
    expect(before.positionCapManual).toBe('0.1');
  });

  it('痕迹挂 anchor_id 逻辑引用 (零 FK ⇒ 主行删了痕迹仍在, T005 已实证)', async () => {
    await useCase.execute(7n);
    expect(m.changeCreate.mock.calls[0]![0].data.anchorId).toBe(7n);
  });

  it('删主行与写痕迹同一个 tx (任一失败一起回滚)', async () => {
    await useCase.execute(7n);
    expect(m.deleteMany).toHaveBeenCalledTimes(1);
    expect(m.changeCreate).toHaveBeenCalledTimes(1);
    expect((m.prisma as unknown as { $transaction: Fn }).$transaction).toHaveBeenCalledTimes(1);
  });

  it('source 默认 manual, 可显式传 model (import 侧删锚)', async () => {
    await useCase.execute(7n);
    expect(m.changeCreate.mock.calls[0]![0].data.source).toBe('manual');

    await useCase.execute(7n, 'model');
    expect(m.changeCreate.mock.calls[1]![0].data.source).toBe('model');
  });
});
