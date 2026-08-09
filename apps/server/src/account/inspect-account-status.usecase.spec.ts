import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InspectAccountStatusUseCase } from './inspect-account-status.usecase';
import type { PrismaService } from '../security/prisma.service';

type Fn = ReturnType<typeof vi.fn>;

const baseRow = {
  id: 7n,
  phone: '+8613800138701',
  status: 'ACTIVE',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  lastLoginAt: null,
  displayName: null,
  freezeUntil: null as Date | null,
  previousPhoneHash: null,
};

function build(): { findUnique: Fn; useCase: InspectAccountStatusUseCase } {
  const findUnique = vi.fn();
  const prisma = { account: { findUnique } } as unknown as PrismaService;
  return { findUnique, useCase: new InspectAccountStatusUseCase(prisma) };
}

describe('InspectAccountStatusUseCase — read-only 状态探查 (两段式 Saga 第 1 段)', () => {
  let findUnique: Fn;
  let useCase: InspectAccountStatusUseCase;

  beforeEach(() => {
    const b = build();
    findUnique = b.findUnique;
    useCase = b.useCase;
  });

  it('queries by phone', async () => {
    findUnique.mockResolvedValue(baseRow);
    await useCase.execute('+8613800138701');
    expect(findUnique).toHaveBeenCalledWith({ where: { phone: '+8613800138701' } });
  });

  it('null row → NOT_FOUND', async () => {
    findUnique.mockResolvedValue(null);
    expect(await useCase.execute('+8613800138701')).toEqual({ kind: 'NOT_FOUND' });
  });

  it('phone-null row → NOT_FOUND (沿用旧守卫语义)', async () => {
    findUnique.mockResolvedValue({ ...baseRow, phone: null });
    expect(await useCase.execute('+8613800138701')).toEqual({ kind: 'NOT_FOUND' });
  });

  it('ACTIVE row → ACTIVE', async () => {
    findUnique.mockResolvedValue({ ...baseRow, status: 'ACTIVE' });
    expect(await useCase.execute('+8613800138701')).toEqual({ kind: 'ACTIVE' });
  });

  it('FROZEN row → FROZEN with accountId + freezeUntil', async () => {
    const freezeUntil = new Date('2026-06-17T00:00:00Z');
    findUnique.mockResolvedValue({ ...baseRow, status: 'FROZEN', freezeUntil });
    expect(await useCase.execute('+8613800138701')).toEqual({
      kind: 'FROZEN',
      accountId: baseRow.id,
      freezeUntil,
    });
  });

  it('ANONYMIZED row → ANONYMIZED', async () => {
    findUnique.mockResolvedValue({ ...baseRow, status: 'ANONYMIZED' });
    expect(await useCase.execute('+8613800138701')).toEqual({ kind: 'ANONYMIZED' });
  });

  it('does not mutate (read-only) — only findUnique invoked', async () => {
    findUnique.mockResolvedValue(baseRow);
    await useCase.execute('+8613800138701');
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});
