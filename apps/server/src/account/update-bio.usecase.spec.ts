import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { UpdateBioUseCase } from './update-bio.usecase';
import { AccountStatus } from './account.rules';
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
  bio: null,
  gender: null,
  freezeUntil: null,
  previousPhoneHash: null,
};

// 007 US2: ACTIVE account updates bio — happy path
describe('UpdateBioUseCase — happy path (ACTIVE, valid bio)', () => {
  let findUnique: Fn;
  let update: Fn;
  let useCase: UpdateBioUseCase;

  beforeEach(() => {
    const m = buildPrismaMock();
    findUnique = m.findUnique;
    update = m.update;
    useCase = new UpdateBioUseCase(m.prisma);
    findUnique.mockResolvedValue(activeRow);
  });

  it('result has exactly the expected keys (response shape, includes bio)', async () => {
    const result = await useCase.execute(42n, '美股研究员');
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

  it('returns accountId, phone, displayName, status, createdAt from account', async () => {
    const result = await useCase.execute(42n, '美股研究员');
    expect(result.accountId).toBe(42n);
    expect(result.phone).toBe('+8613800138001');
    expect(result.displayName).toBe('张三');
    expect(result.status).toBe(AccountStatus.ACTIVE);
    expect(result.createdAt).toEqual(activeRow.createdAt);
  });

  it('returns trimmed bio as primitive string', async () => {
    const result = await useCase.execute(42n, '量化交易员');
    expect(result.bio).toBe('量化交易员');
    expect(typeof result.bio).toBe('string');
  });

  it('persists trimmed bio via prisma update', async () => {
    await useCase.execute(42n, '新股专家');
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ where: { id: 42n }, data: { bio: '新股专家' } });
  });

  it('leading/trailing whitespace is trimmed before store (FR-S03)', async () => {
    const result = await useCase.execute(42n, '  美股研究员  ');
    expect(result.bio).toBe('美股研究员');
    expect(update.mock.calls[0]![0].data.bio).toBe('美股研究员');
  });
});

// 007 FR-S03: 允许清空 (empty / whitespace-only → null), 与 displayName 的 NotEmpty 区别
describe('UpdateBioUseCase — FR-S03 clear bio (empty allowed)', () => {
  let update: Fn;
  let useCase: UpdateBioUseCase;

  beforeEach(() => {
    const m = buildPrismaMock();
    update = m.update;
    useCase = new UpdateBioUseCase(m.prisma);
    m.findUnique.mockResolvedValue({ ...activeRow, bio: '旧简介' });
  });

  it('empty string clears bio → stored as null', async () => {
    const result = await useCase.execute(42n, '');
    expect(result.bio).toBeNull();
    expect(update).toHaveBeenCalledWith({ where: { id: 42n }, data: { bio: null } });
  });

  it('whitespace-only string (trims to empty) clears bio → null', async () => {
    const result = await useCase.execute(42n, '   ');
    expect(result.bio).toBeNull();
    expect(update.mock.calls[0]![0].data.bio).toBeNull();
  });
});

// 007 FR-S03: valid bio inputs — CJK / emoji / boundary 120
describe('UpdateBioUseCase — FR-S03 valid bio inputs', () => {
  let useCase: UpdateBioUseCase;

  beforeEach(() => {
    const m = buildPrismaMock();
    useCase = new UpdateBioUseCase(m.prisma);
    m.findUnique.mockResolvedValue(activeRow);
  });

  it('exactly 120 CJK code points is valid (upper boundary)', async () => {
    const maxBio = '字'.repeat(120);
    const result = await useCase.execute(42n, maxBio);
    expect(result.bio).toBe(maxBio);
  });

  it('emoji counted by Unicode code points not UTF-16 units', async () => {
    const emojiBio = String.fromCodePoint(0x1f60a).repeat(10);
    const result = await useCase.execute(42n, emojiBio);
    expect(result.bio).toBe(emojiBio);
  });
});

// 007 FR-S03: invalid bio — throws INVALID_BIO, update NOT called
describe('UpdateBioUseCase — FR-S03 invalid bio throws', () => {
  let update: Fn;
  let useCase: UpdateBioUseCase;

  beforeEach(() => {
    const m = buildPrismaMock();
    update = m.update;
    useCase = new UpdateBioUseCase(m.prisma);
    m.findUnique.mockResolvedValue(activeRow);
  });

  it('121 code points (exceeds max 120) throws INVALID_BIO', async () => {
    await expect(useCase.execute(42n, 'a'.repeat(121))).rejects.toMatchObject({
      message: expect.stringContaining('INVALID_BIO'),
    });
  });

  it('control character (U+0001) throws INVALID_BIO', async () => {
    await expect(useCase.execute(42n, 'abc\x01def')).rejects.toMatchObject({
      message: expect.stringContaining('INVALID_BIO'),
    });
  });

  it('zero-width space (U+200B) throws INVALID_BIO', async () => {
    const withZws = 'abc' + String.fromCodePoint(0x200b) + 'def';
    await expect(useCase.execute(42n, withZws)).rejects.toMatchObject({
      message: expect.stringContaining('INVALID_BIO'),
    });
  });

  it('line separator (U+2028) throws INVALID_BIO', async () => {
    const withLineSep = 'abc' + String.fromCodePoint(0x2028) + 'def';
    await expect(useCase.execute(42n, withLineSep)).rejects.toMatchObject({
      message: expect.stringContaining('INVALID_BIO'),
    });
  });

  it('update is NOT called when bio is invalid', async () => {
    await expect(useCase.execute(42n, 'a'.repeat(121))).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
});

// Account not found
describe('UpdateBioUseCase — account not found', () => {
  let update: Fn;
  let useCase: UpdateBioUseCase;

  beforeEach(() => {
    const m = buildPrismaMock();
    update = m.update;
    useCase = new UpdateBioUseCase(m.prisma);
    m.findUnique.mockResolvedValue(null);
  });

  it('throws NotFoundException', async () => {
    await expect(useCase.execute(1n, 'bio')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update is NOT called when account not found', async () => {
    await expect(useCase.execute(1n, 'bio')).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
});

// Non-ACTIVE account — rule guard blocks transition
describe('UpdateBioUseCase — non-ACTIVE account blocked by rule', () => {
  let update: Fn;
  let findUnique: Fn;
  let useCase: UpdateBioUseCase;

  beforeEach(() => {
    const m = buildPrismaMock();
    update = m.update;
    findUnique = m.findUnique;
    useCase = new UpdateBioUseCase(m.prisma);
  });

  it('FROZEN account throws ACCOUNT_NOT_ACTIVE', async () => {
    findUnique.mockResolvedValue({ ...activeRow, status: 'FROZEN' });
    await expect(useCase.execute(42n, 'bio')).rejects.toMatchObject({
      message: expect.stringContaining('ACCOUNT_NOT_ACTIVE'),
    });
  });

  it('update is NOT called when account is not ACTIVE', async () => {
    findUnique.mockResolvedValue({ ...activeRow, status: 'FROZEN' });
    await expect(useCase.execute(42n, 'bio')).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
});
