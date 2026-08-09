import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InspectAccountStatusByIdUseCase } from './inspect-account-status-by-id.usecase';
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

function build(): { findUnique: Fn; useCase: InspectAccountStatusByIdUseCase } {
  const findUnique = vi.fn();
  const prisma = { account: { findUnique } } as unknown as PrismaService;
  return { findUnique, useCase: new InspectAccountStatusByIdUseCase(prisma) };
}

describe('InspectAccountStatusByIdUseCase — by-id read-only 状态探查 (refresh 流复用)', () => {
  let findUnique: Fn;
  let useCase: InspectAccountStatusByIdUseCase;

  beforeEach(() => {
    const b = build();
    findUnique = b.findUnique;
    useCase = b.useCase;
  });

  it('queries by id (非 phone)', async () => {
    findUnique.mockResolvedValue(baseRow);
    await useCase.execute(7n);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 7n } });
  });

  it('ACTIVE row → { kind: ACTIVE, phone } (send-deletion-code 需手机号发码)', async () => {
    findUnique.mockResolvedValue(baseRow);
    expect(await useCase.execute(7n)).toEqual({ kind: 'ACTIVE', phone: '+8613800138701' });
  });

  it('account 不存在 → { kind: NOT_FOUND }', async () => {
    findUnique.mockResolvedValue(null);
    expect(await useCase.execute(404n)).toEqual({ kind: 'NOT_FOUND' });
  });

  it('phone-null row → { kind: NOT_FOUND } (沿用守卫语义)', async () => {
    findUnique.mockResolvedValue({ ...baseRow, phone: null });
    expect(await useCase.execute(7n)).toEqual({ kind: 'NOT_FOUND' });
  });

  it('FROZEN row → { kind: FROZEN, freezeUntil }', async () => {
    const freezeUntil = new Date('2026-06-17T00:00:00Z');
    findUnique.mockResolvedValue({ ...baseRow, status: 'FROZEN', freezeUntil });
    expect(await useCase.execute(7n)).toEqual({ kind: 'FROZEN', freezeUntil });
  });

  it('ANONYMIZED row → { kind: ANONYMIZED }', async () => {
    findUnique.mockResolvedValue({ ...baseRow, status: 'ANONYMIZED' });
    expect(await useCase.execute(7n)).toEqual({ kind: 'ANONYMIZED' });
  });
});
