import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { DeleteAccountUseCase } from './delete-account.usecase';
import { hashDeletionCode } from './deletion-code.rules';
import type { DeletionCodeStore } from './deletion-code.store';
import type { PrismaService } from '../security/prisma.service';
import type { RefreshTokenService } from '../security/refresh-token.service';
import type { OutboxPublisher } from '../security/outbox/outbox-publisher.port';
import type { CommitAccountFreezeUseCase } from '../account/commit-account-freeze.usecase';
import type { AuthConfig } from '../config/auth.config';
import { ACCOUNT_DELETION_REQUESTED_EVENT_TYPE } from '../account/account-deletion-requested.event';

const SECRET = 'del-account-unit-secret-min-32-bytes-pad-xx';
const CODE = '123456';
const ACCOUNT_ID = 42n;
const CODE_ID = 7n;
const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;

// sentinel tx — collaborators 全 mock, 不实际读 tx, 仅断言被透传同一引用。
const TX = { __tx: true } as const;

describe('DeleteAccountUseCase (auth 持 tx 跨 3 ctx 编排)', () => {
  let findActive: ReturnType<typeof vi.fn>;
  let markUsed: ReturnType<typeof vi.fn>;
  let commitFreeze: ReturnType<typeof vi.fn>;
  let revokeAll: ReturnType<typeof vi.fn>;
  let publish: ReturnType<typeof vi.fn>;
  let transaction: ReturnType<typeof vi.fn>;
  let usecase: DeleteAccountUseCase;

  // 正确码哈希落 stored.codeHash → verifyDeletionCode(CODE) 真比对通过。
  const storedRow = { id: CODE_ID, codeHash: hashDeletionCode(CODE, SECRET) };

  beforeEach(() => {
    findActive = vi.fn().mockResolvedValue(storedRow);
    markUsed = vi.fn().mockResolvedValue(true);
    commitFreeze = vi.fn().mockResolvedValue({ won: true });
    revokeAll = vi.fn().mockResolvedValue(undefined);
    publish = vi.fn().mockResolvedValue(undefined);
    // $transaction(cb, opts): 用 sentinel TX 调 cb, 透传其 reject (模拟回滚传播)。
    transaction = vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(TX));

    usecase = new DeleteAccountUseCase(
      { $transaction: transaction } as unknown as PrismaService,
      { findActive, markUsed } as unknown as DeletionCodeStore,
      { execute: commitFreeze } as unknown as CommitAccountFreezeUseCase,
      { revokeAllForAccount: revokeAll } as unknown as RefreshTokenService,
      { publish } as unknown as OutboxPublisher,
      { smsCodeHmacSecret: SECRET } as AuthConfig,
    );
  });

  it('happy: markUsed → freeze → revoke → publish 顺序 + 各步入参 + 同一 tx', async () => {
    await expect(usecase.execute(ACCOUNT_ID, CODE)).resolves.toBeUndefined();

    // 各步序 (invocationCallOrder 全局单调递增)。
    expect(markUsed.mock.invocationCallOrder[0]!).toBeLessThan(
      commitFreeze.mock.invocationCallOrder[0]!,
    );
    expect(commitFreeze.mock.invocationCallOrder[0]!).toBeLessThan(
      revokeAll.mock.invocationCallOrder[0]!,
    );
    expect(revokeAll.mock.invocationCallOrder[0]!).toBeLessThan(
      publish.mock.invocationCallOrder[0]!,
    );

    // markUsed(codeId, now, tx)
    const [codeId, markNow, markTx] = markUsed.mock.calls[0]!;
    expect(codeId).toBe(CODE_ID);
    expect(markNow).toBeInstanceOf(Date);
    expect(markTx).toBe(TX);

    // commitFreeze.execute(tx, accountId, freezeUntil≈now+15d)
    const [freezeTx, freezeAcc, freezeUntil] = commitFreeze.mock.calls[0]!;
    expect(freezeTx).toBe(TX);
    expect(freezeAcc).toBe(ACCOUNT_ID);
    const delta = (freezeUntil as Date).getTime() - Date.now();
    expect(delta).toBeGreaterThan(FIFTEEN_DAYS_MS - 5_000);
    expect(delta).toBeLessThanOrEqual(FIFTEEN_DAYS_MS);

    // revokeAllForAccount(accountId, now, tx)
    const [revAcc, revNow, revTx] = revokeAll.mock.calls[0]!;
    expect(revAcc).toBe(ACCOUNT_ID);
    expect(revNow).toBeInstanceOf(Date);
    expect(revTx).toBe(TX);

    // publish(tx, eventType, payload) — accountId stringified + freezeUntil 与 freeze 入参一致。
    const [pubTx, eventType, payload] = publish.mock.calls[0]!;
    expect(pubTx).toBe(TX);
    expect(eventType).toBe(ACCOUNT_DELETION_REQUESTED_EVENT_TYPE);
    expect((payload as { accountId: string }).accountId).toBe('42');
    expect((payload as { freezeUntil: string }).freezeUntil).toBe(
      (freezeUntil as Date).toISOString(),
    );
  });

  it('码未找到 (findActive null) → 401 INVALID_DELETION_CODE, 不开 tx', async () => {
    findActive.mockResolvedValue(null);
    await expect(usecase.execute(ACCOUNT_ID, CODE)).rejects.toMatchObject({
      message: 'INVALID_DELETION_CODE',
    });
    await expect(usecase.execute(ACCOUNT_ID, CODE)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(transaction).not.toHaveBeenCalled();
    expect(markUsed).not.toHaveBeenCalled();
  });

  it('码哈希不符 (错误码) → 401 INVALID_DELETION_CODE, 不开 tx', async () => {
    await expect(usecase.execute(ACCOUNT_ID, '999999')).rejects.toMatchObject({
      message: 'INVALID_DELETION_CODE',
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('并发输者 (markUsed count=0 → false) → 401 回滚, 不冻结/不撤/不发事件', async () => {
    markUsed.mockResolvedValue(false);
    await expect(usecase.execute(ACCOUNT_ID, CODE)).rejects.toMatchObject({
      message: 'INVALID_DELETION_CODE',
    });
    expect(commitFreeze).not.toHaveBeenCalled();
    expect(revokeAll).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('commitFreeze lost (won=false, 账号非 ACTIVE) → 统一 401 回滚, 不撤/不发事件', async () => {
    commitFreeze.mockResolvedValue({ won: false });
    await expect(usecase.execute(ACCOUNT_ID, CODE)).rejects.toMatchObject({
      message: 'INVALID_DELETION_CODE',
    });
    expect(revokeAll).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('revoke 抛 → 整 tx 回滚 (异常透传), 无事件', async () => {
    revokeAll.mockRejectedValue(new Error('revoke boom'));
    await expect(usecase.execute(ACCOUNT_ID, CODE)).rejects.toThrow('revoke boom');
    expect(publish).not.toHaveBeenCalled();
  });
});
