import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { UpdateGenderUseCase } from './update-gender.usecase';
import { AccountStatus, Gender } from './account.rules';
import type { PrismaService } from '../security/prisma.service';

type Fn = ReturnType<typeof vi.fn>;

function buildPrismaMock(): { prisma: PrismaService; findUnique: Fn; update: Fn } {
  const findUnique = vi.fn();
  const update = vi.fn().mockResolvedValue(undefined);
  const prisma = { account: { findUnique, update } } as unknown as PrismaService;
  return { prisma, findUnique, update };
}

const activeRow = {
  id: 42n,
  phone: '+8613800138001',
  status: 'ACTIVE',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  lastLoginAt: null,
  displayName: '张三',
  bio: '美股研究员',
  gender: null,
  avatarUrl: null,
  backgroundImageUrl: null,
  freezeUntil: null,
  previousPhoneHash: null,
};

// 008 US1: ACTIVE account sets gender — happy path
describe('UpdateGenderUseCase — happy path (ACTIVE, valid enum)', () => {
  let findUnique: Fn;
  let update: Fn;
  let useCase: UpdateGenderUseCase;

  beforeEach(() => {
    const m = buildPrismaMock();
    findUnique = m.findUnique;
    update = m.update;
    useCase = new UpdateGenderUseCase(m.prisma);
    findUnique.mockResolvedValue(activeRow);
  });

  it('result has exactly the expected keys (response shape, includes gender + bio)', async () => {
    const result = await useCase.execute(42n, 'MALE');
    expect(Object.keys(result).sort()).toEqual(
      [
        'accountId',
        'avatarUrl',
        'backgroundImageUrl',
        'bio',
        'createdAt',
        'displayName',
        'gender',
        'phone',
        'status',
      ].sort(),
    );
  });

  it('returns accountId, phone, displayName, bio, status, createdAt from account', async () => {
    const result = await useCase.execute(42n, 'FEMALE');
    expect(result.accountId).toBe(42n);
    expect(result.phone).toBe('+8613800138001');
    expect(result.displayName).toBe('张三');
    expect(result.bio).toBe('美股研究员');
    expect(result.status).toBe(AccountStatus.ACTIVE);
    expect(result.createdAt).toEqual(activeRow.createdAt);
  });

  it.each(['MALE', 'FEMALE', 'NON_BINARY', 'PRIVATE'])(
    'persists each valid enum %s via prisma update',
    async (g) => {
      const result = await useCase.execute(42n, g);
      expect(result.gender).toBe(g);
      expect(update).toHaveBeenCalledWith({ where: { id: 42n }, data: { gender: g } });
    },
  );
});

// 008 FR-S03: null / empty clears gender → stored as null
describe('UpdateGenderUseCase — clear gender (null/empty allowed)', () => {
  let update: Fn;
  let useCase: UpdateGenderUseCase;

  beforeEach(() => {
    const m = buildPrismaMock();
    update = m.update;
    useCase = new UpdateGenderUseCase(m.prisma);
    m.findUnique.mockResolvedValue({ ...activeRow, gender: Gender.MALE });
  });

  it('null clears gender → stored as null', async () => {
    const result = await useCase.execute(42n, null);
    expect(result.gender).toBeNull();
    expect(update).toHaveBeenCalledWith({ where: { id: 42n }, data: { gender: null } });
  });

  it('empty string clears gender → stored as null', async () => {
    const result = await useCase.execute(42n, '');
    expect(result.gender).toBeNull();
    expect(update.mock.calls[0]![0].data.gender).toBeNull();
  });
});

// 008 FR-S03: invalid gender — throws INVALID_GENDER, update NOT called
describe('UpdateGenderUseCase — FR-S03 invalid gender throws', () => {
  let update: Fn;
  let useCase: UpdateGenderUseCase;

  beforeEach(() => {
    const m = buildPrismaMock();
    update = m.update;
    useCase = new UpdateGenderUseCase(m.prisma);
    m.findUnique.mockResolvedValue(activeRow);
  });

  it.each(['male', 'OTHER', '男', 'mALE'])('unknown value %s throws INVALID_GENDER', async (g) => {
    await expect(useCase.execute(42n, g)).rejects.toMatchObject({
      message: expect.stringContaining('INVALID_GENDER'),
    });
  });

  it('update is NOT called when gender is invalid', async () => {
    await expect(useCase.execute(42n, 'OTHER')).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
});

// Account not found
describe('UpdateGenderUseCase — account not found', () => {
  let update: Fn;
  let useCase: UpdateGenderUseCase;

  beforeEach(() => {
    const m = buildPrismaMock();
    update = m.update;
    useCase = new UpdateGenderUseCase(m.prisma);
    m.findUnique.mockResolvedValue(null);
  });

  it('throws NotFoundException', async () => {
    await expect(useCase.execute(1n, 'MALE')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update is NOT called when account not found', async () => {
    await expect(useCase.execute(1n, 'MALE')).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
});

// Non-ACTIVE account — rule guard blocks transition
describe('UpdateGenderUseCase — non-ACTIVE account blocked by rule', () => {
  let update: Fn;
  let findUnique: Fn;
  let useCase: UpdateGenderUseCase;

  beforeEach(() => {
    const m = buildPrismaMock();
    update = m.update;
    findUnique = m.findUnique;
    useCase = new UpdateGenderUseCase(m.prisma);
  });

  it('FROZEN account throws ACCOUNT_NOT_ACTIVE', async () => {
    findUnique.mockResolvedValue({ ...activeRow, status: 'FROZEN' });
    await expect(useCase.execute(42n, 'MALE')).rejects.toMatchObject({
      message: expect.stringContaining('ACCOUNT_NOT_ACTIVE'),
    });
  });

  it('update is NOT called when account is not ACTIVE', async () => {
    findUnique.mockResolvedValue({ ...activeRow, status: 'FROZEN' });
    await expect(useCase.execute(42n, 'MALE')).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
});
