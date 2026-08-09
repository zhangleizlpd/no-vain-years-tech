import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { GetAccountProfileUseCase } from './get-account-profile.usecase';
import { AccountStatus } from './account.rules';
import type { PrismaService } from '../security/prisma.service';

type AccountFindUnique = ReturnType<typeof vi.fn>;

function buildPrismaMock(): { prisma: PrismaService; findUnique: AccountFindUnique } {
  const findUnique = vi.fn();
  const prisma = { account: { findUnique } } as unknown as PrismaService;
  return { prisma, findUnique };
}

// US1: new user — displayName null (profile missing signal, FR-007)
describe('GetAccountProfileUseCase US1 — new user, displayName null', () => {
  let findUnique: AccountFindUnique;
  let useCase: GetAccountProfileUseCase;

  const accountId = 42n;
  const row = {
    id: accountId,
    phone: '+8613800138001',
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    lastLoginAt: null,
    displayName: null,
    bio: null,
    gender: null,
    freezeUntil: null,
    previousPhoneHash: null,
  };

  beforeEach(() => {
    const m = buildPrismaMock();
    findUnique = m.findUnique;
    useCase = new GetAccountProfileUseCase(m.prisma);
    findUnique.mockResolvedValue(row);
  });

  it('displayName is null when not yet set (FR-007 auto-create default)', async () => {
    const result = await useCase.execute(accountId);
    expect(result.displayName).toBeNull();
  });

  it('bio is null when not yet set (007 FR-S06 default)', async () => {
    const result = await useCase.execute(accountId);
    expect(result.bio).toBeNull();
  });

  it('returns correct accountId, phone, status, createdAt', async () => {
    const result = await useCase.execute(accountId);
    expect(result.accountId).toBe(accountId);
    expect(result.phone).toBe('+8613800138001');
    expect(result.status).toBe(AccountStatus.ACTIVE);
    expect(result.createdAt).toEqual(row.createdAt);
  });

  it('phone is raw E.164 string — mask deferred to frontend (FR-001)', async () => {
    const result = await useCase.execute(accountId);
    expect(result.phone).toBe('+8613800138001');
    expect(result.phone.startsWith('+')).toBe(true);
  });

  it('response has exactly the expected keys (AccountProfileResult shape)', async () => {
    const result = await useCase.execute(accountId);
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

  it('queries findUnique with the provided accountId', async () => {
    await useCase.execute(accountId);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: accountId } });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});

// US3: returning user — profile already complete
describe('GetAccountProfileUseCase US3 — returning user, displayName set', () => {
  let useCase: GetAccountProfileUseCase;

  const accountId = 99n;
  const row = {
    id: accountId,
    phone: '+8613900139001',
    status: 'ACTIVE',
    createdAt: new Date('2025-06-01T00:00:00Z'),
    updatedAt: new Date('2026-05-20T12:00:00Z'),
    lastLoginAt: new Date('2026-05-20T12:00:00Z'),
    displayName: '张三',
    bio: '价值投资者',
    gender: 'MALE',
    freezeUntil: null,
    previousPhoneHash: null,
  };

  beforeEach(() => {
    const m = buildPrismaMock();
    useCase = new GetAccountProfileUseCase(m.prisma);
    m.findUnique.mockResolvedValue(row);
  });

  it('returns displayName string when set', async () => {
    const result = await useCase.execute(accountId);
    expect(result.displayName).toBe('张三');
  });

  it('returns bio string when set (007 FR-S06 readback)', async () => {
    const result = await useCase.execute(accountId);
    expect(result.bio).toBe('价值投资者');
  });

  it('displayName is the trimmed string value (not a VO object)', async () => {
    const result = await useCase.execute(accountId);
    expect(typeof result.displayName).toBe('string');
  });

  it('returns correct full profile shape', async () => {
    const result = await useCase.execute(accountId);
    expect(result.accountId).toBe(accountId);
    expect(result.phone).toBe('+8613900139001');
    expect(result.status).toBe(AccountStatus.ACTIVE);
    expect(result.createdAt).toEqual(row.createdAt);
  });
});

// Not found path
describe('GetAccountProfileUseCase — account not found', () => {
  let useCase: GetAccountProfileUseCase;

  beforeEach(() => {
    const m = buildPrismaMock();
    useCase = new GetAccountProfileUseCase(m.prisma);
    m.findUnique.mockResolvedValue(null);
  });

  it('throws NotFoundException when account does not exist', async () => {
    await expect(useCase.execute(1n)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('NotFoundException message is ACCOUNT_NOT_FOUND', async () => {
    await expect(useCase.execute(1n)).rejects.toMatchObject({
      message: 'ACCOUNT_NOT_FOUND',
    });
  });
});
