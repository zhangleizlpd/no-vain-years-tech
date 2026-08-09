import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { AnonymizeFrozenAccountsScheduler } from './anonymize-frozen-accounts.scheduler';
import type { PrismaService } from '../security/prisma.service';
import type { CommitAccountAnonymizationUseCase } from './commit-account-anonymization.usecase';

function build(candidateIds: bigint[]) {
  const findMany = vi.fn().mockResolvedValue(candidateIds.map((id) => ({ id })));
  const execute = vi.fn().mockResolvedValue({ won: true });
  const scheduler = new AnonymizeFrozenAccountsScheduler(
    { account: { findMany } } as unknown as PrismaService,
    { execute } as unknown as CommitAccountAnonymizationUseCase,
  );
  return { findMany, execute, scheduler };
}

describe('AnonymizeFrozenAccountsScheduler — 扫描+派发逻辑 (注入 mock usecase)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('扫描 take:100 上限 + WHERE status=FROZEN ∧ freezeUntil<=now', async () => {
    const { findMany, scheduler } = build([1n, 2n]);
    const now = new Date('2026-06-01T03:00:00Z');
    await scheduler.run(now);

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0]![0] as {
      where: { status: string; freezeUntil: { lte: Date } };
      take: number;
    };
    expect(arg.take).toBe(100);
    expect(arg.where.status).toBe('FROZEN');
    expect(arg.where.freezeUntil.lte).toBe(now);
  });

  it('逐 id 派发 commitAnonymization(id, now); won/skip 统计', async () => {
    const { execute, scheduler } = build([10n, 20n, 30n]);
    execute
      .mockResolvedValueOnce({ won: true })
      .mockResolvedValueOnce({ won: false }) // 领域拒绝 → skip
      .mockResolvedValueOnce({ won: true });
    const now = new Date();

    const stats = await scheduler.run(now);

    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenNthCalledWith(1, 10n, now);
    expect(stats).toEqual({ scanned: 3, anonymized: 2, skipped: 1, failed: 0 });
  });

  it('单行抛异常被隔离, 不阻塞 sibling (后续 id 仍派发)', async () => {
    const { execute, scheduler } = build([1n, 2n, 3n]);
    execute
      .mockResolvedValueOnce({ won: true })
      .mockRejectedValueOnce(new Error('row 2 boom')) // 单行抛
      .mockResolvedValueOnce({ won: true });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const stats = await scheduler.run(new Date());

    expect(execute).toHaveBeenCalledTimes(3); // sibling 不受阻
    expect(stats).toEqual({ scanned: 3, anonymized: 2, skipped: 0, failed: 1 });
  });

  it('failure 累计达阈值 (3) → ERROR log 告警', async () => {
    const { execute, scheduler } = build([1n, 2n, 3n]);
    execute.mockRejectedValue(new Error('boom'));
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const stats = await scheduler.run(new Date());

    expect(stats.failed).toBe(3);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]![0])).toContain('threshold');
  });

  it('failure 低于阈值 (2) → 不升 ERROR (仅 warn)', async () => {
    const { execute, scheduler } = build([1n, 2n, 3n]);
    execute
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ won: true })
      .mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const stats = await scheduler.run(new Date());

    expect(stats.failed).toBe(2);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
