import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { CancelDeletionUseCase } from './cancel-deletion.usecase';
import { hashDeletionCode } from './deletion-code.rules';
import type { DeletionCodeStore } from './deletion-code.store';
import type { PrismaService } from '../security/prisma.service';
import type { JwtTokenService } from '../security/jwt-token.service';
import type { RefreshTokenService } from '../security/refresh-token.service';
import type { OutboxPublisher } from '../security/outbox/outbox-publisher.port';
import type { InspectAccountStatusUseCase } from '../account/inspect-account-status.usecase';
import type { CommitAccountCancellationUseCase } from '../account/commit-account-cancellation.usecase';
import type { TimingDefenseExecutor } from './timing-defense.port';
import type { AuthConfig } from '../config/auth.config';
import { ACCOUNT_DELETION_CANCELLED_EVENT_TYPE } from '../account/account-deletion-cancelled.event';

const SECRET = 'cancel-deletion-unit-secret-min-32-bytes-x';
const CODE = '654321';
const PHONE = '+8613800138000';
const ACCOUNT_ID = 88n;
const CODE_ID = 9n;
const FUTURE = new Date(Date.now() + 60 * 60 * 1000); // in grace
const PAST = new Date(Date.now() - 1000); // grace expired

// sentinel tx — collaborators 全 mock, 仅断言被透传同一引用。
const TX = { __tx: true } as const;

describe('CancelDeletionUseCase (auth 持 tx 跨 3 ctx 编排, public)', () => {
  let inspect: ReturnType<typeof vi.fn>;
  let findActive: ReturnType<typeof vi.fn>;
  let markUsed: ReturnType<typeof vi.fn>;
  let commitCancel: ReturnType<typeof vi.fn>;
  let persist: ReturnType<typeof vi.fn>;
  let publish: ReturnType<typeof vi.fn>;
  let pad: ReturnType<typeof vi.fn>;
  let transaction: ReturnType<typeof vi.fn>;
  let usecase: CancelDeletionUseCase;

  const storedRow = { id: CODE_ID, codeHash: hashDeletionCode(CODE, SECRET) };

  beforeEach(() => {
    inspect = vi
      .fn()
      .mockResolvedValue({ kind: 'FROZEN', accountId: ACCOUNT_ID, freezeUntil: FUTURE });
    findActive = vi.fn().mockResolvedValue(storedRow);
    markUsed = vi.fn().mockResolvedValue(true);
    commitCancel = vi.fn().mockResolvedValue({ won: true });
    persist = vi.fn().mockResolvedValue(undefined);
    publish = vi.fn().mockResolvedValue(undefined);
    pad = vi.fn().mockResolvedValue(undefined);
    transaction = vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(TX));

    usecase = new CancelDeletionUseCase(
      { $transaction: transaction } as unknown as PrismaService,
      { findActive, markUsed } as unknown as DeletionCodeStore,
      { execute: inspect } as unknown as InspectAccountStatusUseCase,
      { execute: commitCancel } as unknown as CommitAccountCancellationUseCase,
      { persist } as unknown as RefreshTokenService,
      {
        signAccessToken: vi.fn().mockReturnValue('access.jwt'),
        generateRefreshToken: vi.fn().mockReturnValue('refresh.raw'),
      } as unknown as JwtTokenService,
      { pad } as unknown as TimingDefenseExecutor,
      { publish } as unknown as OutboxPublisher,
      { smsCodeHmacSecret: SECRET } as AuthConfig,
    );
  });

  it('happy: markUsed → commitCancel → persist → publish 顺序 + 各步同一 tx + 返 LoginResponse', async () => {
    const res = await usecase.execute(PHONE, CODE);
    expect(res).toEqual({
      accountId: ACCOUNT_ID,
      accessToken: 'access.jwt',
      refreshToken: 'refresh.raw',
    });

    // 步序: markUsed < commitCancel < persist < publish。
    expect(markUsed.mock.invocationCallOrder[0]!).toBeLessThan(
      commitCancel.mock.invocationCallOrder[0]!,
    );
    expect(commitCancel.mock.invocationCallOrder[0]!).toBeLessThan(
      persist.mock.invocationCallOrder[0]!,
    );
    expect(persist.mock.invocationCallOrder[0]!).toBeLessThan(publish.mock.invocationCallOrder[0]!);

    // markUsed(codeId, now, tx)
    const [codeId, , markTx] = markUsed.mock.calls[0]!;
    expect(codeId).toBe(CODE_ID);
    expect(markTx).toBe(TX);

    // commitCancel.execute(tx, accountId, now)
    const [cancelTx, cancelAcc] = commitCancel.mock.calls[0]!;
    expect(cancelTx).toBe(TX);
    expect(cancelAcc).toBe(ACCOUNT_ID);

    // persist(accountId, rawToken, meta{loginMethod:PHONE_SMS}, tx)
    const [persistAcc, rawToken, meta, persistTx] = persist.mock.calls[0]!;
    expect(persistAcc).toBe(ACCOUNT_ID);
    expect(rawToken).toBe('refresh.raw');
    expect((meta as { loginMethod: string }).loginMethod).toBe('PHONE_SMS');
    expect(persistTx).toBe(TX);

    // publish(tx, eventType, payload) — accountId stringified。
    const [pubTx, eventType, payload] = publish.mock.calls[0]!;
    expect(pubTx).toBe(TX);
    expect(eventType).toBe(ACCOUNT_DELETION_CANCELLED_EVENT_TYPE);
    expect((payload as { accountId: string }).accountId).toBe('88');

    // happy 不 pad。
    expect(pad).not.toHaveBeenCalled();
  });

  it('threads device context (deviceId/name/type + clientIp) into persist (FR-S14)', async () => {
    await usecase.execute(PHONE, CODE, {
      deviceId: 'dev-c',
      deviceName: 'iPad',
      deviceType: 'TABLET',
      clientIp: '8.8.8.8',
    });
    const meta = persist.mock.calls[0]![2] as Record<string, unknown>;
    expect(meta).toMatchObject({
      deviceId: 'dev-c',
      deviceName: 'iPad',
      deviceType: 'TABLET',
      clientIp: '8.8.8.8',
      loginMethod: 'PHONE_SMS',
    });
  });

  describe.each([
    ['未注册', { kind: 'NOT_FOUND' }],
    ['ACTIVE', { kind: 'ACTIVE' }],
    ['ANONYMIZED', { kind: 'ANONYMIZED' }],
    ['grace 已过', { kind: 'FROZEN', accountId: ACCOUNT_ID, freezeUntil: PAST }],
  ])('phone-class 失败 (%s) → pad + 401, 不查码不开 tx', (_label, inspection) => {
    it('折叠 INVALID_CREDENTIALS, pad 1 次, findActive/tx 未触', async () => {
      inspect.mockResolvedValue(inspection);
      await expect(usecase.execute(PHONE, CODE)).rejects.toMatchObject({
        message: 'INVALID_CREDENTIALS',
      });
      expect(pad).toHaveBeenCalledTimes(1);
      expect(findActive).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });
  });

  it('code-class 失败 (码未找到) → pad + 401, 不开 tx (与 phone-class 同时延防泄漏)', async () => {
    findActive.mockResolvedValue(null);
    await expect(usecase.execute(PHONE, CODE)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(pad).toHaveBeenCalledTimes(1);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('code-class 失败 (码哈希不符) → pad + 401, 不开 tx', async () => {
    await expect(usecase.execute(PHONE, '111111')).rejects.toMatchObject({
      message: 'INVALID_CREDENTIALS',
    });
    expect(pad).toHaveBeenCalledTimes(1);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('并发输者 (markUsed false) → 401 回滚, 不解冻/不持久化/不发事件', async () => {
    markUsed.mockResolvedValue(false);
    await expect(usecase.execute(PHONE, CODE)).rejects.toMatchObject({
      message: 'INVALID_CREDENTIALS',
    });
    expect(commitCancel).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('commitCancel lost (won=false, 被并发/scheduler 抢先) → 401 回滚, 不持久化/不发事件', async () => {
    commitCancel.mockResolvedValue({ won: false });
    await expect(usecase.execute(PHONE, CODE)).rejects.toMatchObject({
      message: 'INVALID_CREDENTIALS',
    });
    expect(persist).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('token persist 抛 → 整 tx 回滚 (异常透传), 无事件', async () => {
    persist.mockRejectedValue(new Error('persist boom'));
    await expect(usecase.execute(PHONE, CODE)).rejects.toThrow('persist boom');
    expect(publish).not.toHaveBeenCalled();
  });
});
