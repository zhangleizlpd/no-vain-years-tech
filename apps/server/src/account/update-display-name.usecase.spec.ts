import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { UpdateDisplayNameUseCase } from './update-display-name.usecase';
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
  displayName: null,
  bio: null,
  gender: null,
  freezeUntil: null,
  previousPhoneHash: null,
};

// US2: ACTIVE account updates displayName — happy path
describe('UpdateDisplayNameUseCase — happy path (ACTIVE, valid displayName)', () => {
  let findUnique: Fn;
  let update: Fn;
  let useCase: UpdateDisplayNameUseCase;

  beforeEach(() => {
    const m = buildPrismaMock();
    findUnique = m.findUnique;
    update = m.update;
    useCase = new UpdateDisplayNameUseCase(m.prisma);
    findUnique.mockResolvedValue(activeRow);
  });

  it('result has exactly the expected keys (FR-003 response shape)', async () => {
    const result = await useCase.execute(42n, '张三');
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

  it('returns accountId, phone, status, createdAt from account', async () => {
    const result = await useCase.execute(42n, '张三');
    expect(result.accountId).toBe(42n);
    expect(result.phone).toBe('+8613800138001');
    expect(result.status).toBe(AccountStatus.ACTIVE);
    expect(result.createdAt).toEqual(activeRow.createdAt);
  });

  it('returns trimmed displayName as primitive string (not VO object)', async () => {
    const result = await useCase.execute(42n, '张三');
    expect(result.displayName).toBe('张三');
    expect(typeof result.displayName).toBe('string');
  });

  it('queries findUnique with the provided accountId', async () => {
    await useCase.execute(42n, 'Alice');
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 42n } });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('persists trimmed display_name via prisma update', async () => {
    await useCase.execute(42n, 'Alice');
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ where: { id: 42n }, data: { displayName: 'Alice' } });
  });
});

// FR-005 trim behaviour — whitespace stripped before store
describe('UpdateDisplayNameUseCase — FR-005 trim behaviour', () => {
  let update: Fn;
  let useCase: UpdateDisplayNameUseCase;

  beforeEach(() => {
    const m = buildPrismaMock();
    update = m.update;
    useCase = new UpdateDisplayNameUseCase(m.prisma);
    m.findUnique.mockResolvedValue(activeRow);
  });

  it('leading/trailing whitespace is trimmed, stored trimmed value', async () => {
    const result = await useCase.execute(42n, '  Alice  ');
    expect(result.displayName).toBe('Alice');
  });

  it('trimmed value is persisted (not the raw input)', async () => {
    await useCase.execute(42n, '  Bob  ');
    expect(update.mock.calls[0]![0].data.displayName).toBe('Bob');
  });
});

// FR-005 valid display names — CJK / emoji / boundary
describe('UpdateDisplayNameUseCase — FR-005 valid displayName inputs', () => {
  let useCase: UpdateDisplayNameUseCase;

  beforeEach(() => {
    const m = buildPrismaMock();
    useCase = new UpdateDisplayNameUseCase(m.prisma);
    m.findUnique.mockResolvedValue(activeRow);
  });

  it('CJK characters are valid', async () => {
    const result = await useCase.execute(42n, '你好世界');
    expect(result.displayName).toBe('你好世界');
  });

  it('single emoji is valid (1 Unicode code point, FR-005)', async () => {
    const emoji = String.fromCodePoint(0x1f60a);
    const result = await useCase.execute(42n, emoji);
    expect(result.displayName).toBe(emoji);
  });

  it('exactly 32 ASCII code points is valid (upper boundary)', async () => {
    const maxName = 'a'.repeat(32);
    const result = await useCase.execute(42n, maxName);
    expect(result.displayName).toBe(maxName);
  });

  it('emoji counted by Unicode code points not UTF-16 units', async () => {
    const emojiName = String.fromCodePoint(0x1f60a, 0x1f60a, 0x1f60a, 0x1f60a);
    const result = await useCase.execute(42n, emojiName);
    expect(result.displayName).toBe(emojiName);
  });
});

// FR-005 invalid displayName — throws INVALID_DISPLAY_NAME, update NOT called
describe('UpdateDisplayNameUseCase — FR-005 invalid displayName throws', () => {
  let update: Fn;
  let useCase: UpdateDisplayNameUseCase;

  beforeEach(() => {
    const m = buildPrismaMock();
    update = m.update;
    useCase = new UpdateDisplayNameUseCase(m.prisma);
    m.findUnique.mockResolvedValue(activeRow);
  });

  it('empty string throws INVALID_DISPLAY_NAME', async () => {
    await expect(useCase.execute(42n, '')).rejects.toMatchObject({
      message: expect.stringContaining('INVALID_DISPLAY_NAME'),
    });
  });

  it('whitespace-only string (trims to empty) throws INVALID_DISPLAY_NAME', async () => {
    await expect(useCase.execute(42n, '   ')).rejects.toMatchObject({
      message: expect.stringContaining('INVALID_DISPLAY_NAME'),
    });
  });

  it('33 code points (exceeds max) throws INVALID_DISPLAY_NAME', async () => {
    await expect(useCase.execute(42n, 'a'.repeat(33))).rejects.toMatchObject({
      message: expect.stringContaining('INVALID_DISPLAY_NAME'),
    });
  });

  it('control character (U+0001) throws INVALID_DISPLAY_NAME', async () => {
    await expect(useCase.execute(42n, 'abc\x01def')).rejects.toMatchObject({
      message: expect.stringContaining('INVALID_DISPLAY_NAME'),
    });
  });

  it('zero-width space (U+200B) throws INVALID_DISPLAY_NAME', async () => {
    const withZws = 'abc' + String.fromCodePoint(0x200b) + 'def';
    await expect(useCase.execute(42n, withZws)).rejects.toMatchObject({
      message: expect.stringContaining('INVALID_DISPLAY_NAME'),
    });
  });

  it('BOM (U+FEFF) throws INVALID_DISPLAY_NAME', async () => {
    const withBom = String.fromCodePoint(0xfeff) + 'name';
    await expect(useCase.execute(42n, withBom)).rejects.toMatchObject({
      message: expect.stringContaining('INVALID_DISPLAY_NAME'),
    });
  });

  it('line separator (U+2028) throws INVALID_DISPLAY_NAME', async () => {
    const withLineSep = 'abc' + String.fromCodePoint(0x2028) + 'def';
    await expect(useCase.execute(42n, withLineSep)).rejects.toMatchObject({
      message: expect.stringContaining('INVALID_DISPLAY_NAME'),
    });
  });

  it('update is NOT called when displayName is invalid', async () => {
    await expect(useCase.execute(42n, '')).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
});

// Account not found
describe('UpdateDisplayNameUseCase — account not found', () => {
  let update: Fn;
  let useCase: UpdateDisplayNameUseCase;

  beforeEach(() => {
    const m = buildPrismaMock();
    update = m.update;
    useCase = new UpdateDisplayNameUseCase(m.prisma);
    m.findUnique.mockResolvedValue(null);
  });

  it('throws NotFoundException', async () => {
    await expect(useCase.execute(1n, 'Alice')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('NotFoundException message is ACCOUNT_NOT_FOUND', async () => {
    await expect(useCase.execute(1n, 'Alice')).rejects.toMatchObject({
      message: 'ACCOUNT_NOT_FOUND',
    });
  });

  it('update is NOT called when account not found', async () => {
    await expect(useCase.execute(1n, 'Alice')).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
});

// Non-ACTIVE account — rule guard blocks transition
describe('UpdateDisplayNameUseCase — non-ACTIVE account blocked by rule', () => {
  let update: Fn;
  let findUnique: Fn;
  let useCase: UpdateDisplayNameUseCase;

  beforeEach(() => {
    const m = buildPrismaMock();
    update = m.update;
    findUnique = m.findUnique;
    useCase = new UpdateDisplayNameUseCase(m.prisma);
  });

  it('FROZEN account throws ACCOUNT_NOT_ACTIVE', async () => {
    findUnique.mockResolvedValue({ ...activeRow, status: 'FROZEN' });
    await expect(useCase.execute(42n, 'Alice')).rejects.toMatchObject({
      message: expect.stringContaining('ACCOUNT_NOT_ACTIVE'),
    });
  });

  it('ANONYMIZED account throws ACCOUNT_NOT_ACTIVE', async () => {
    findUnique.mockResolvedValue({ ...activeRow, status: 'ANONYMIZED' });
    await expect(useCase.execute(42n, 'Alice')).rejects.toMatchObject({
      message: expect.stringContaining('ACCOUNT_NOT_ACTIVE'),
    });
  });

  it('update is NOT called when account is not ACTIVE', async () => {
    findUnique.mockResolvedValue({ ...activeRow, status: 'FROZEN' });
    await expect(useCase.execute(42n, 'Alice')).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
});
