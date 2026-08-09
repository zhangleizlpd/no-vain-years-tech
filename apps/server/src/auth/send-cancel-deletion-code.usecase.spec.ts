import { describe, it, expect, vi } from 'vitest';
import { SendCancelDeletionCodeUseCase } from './send-cancel-deletion-code.usecase';
import { SmsSendFailedException } from './sms-send-failed.exception';
import { SmsPurpose, hashDeletionCode } from './deletion-code.rules';
import type { InspectAccountStatusUseCase } from '../account/inspect-account-status.usecase';
import type { DeletionCodeStore } from './deletion-code.store';
import type { SmsGateway } from './sms-gateway.port';
import type { TimingDefenseExecutor } from './timing-defense.port';
import type { AuthConfig } from '../config/auth.config';

const SECRET = 'x'.repeat(32);
const PHONE = '+8613800138000';
const ACCOUNT_ID = 77n;
const FUTURE = new Date(Date.now() + 60 * 60 * 1000); // +1h, in grace
const PAST = new Date(Date.now() - 1000); // grace expired

function build(inspection: Record<string, unknown>) {
  const inspect = { execute: vi.fn().mockResolvedValue(inspection) };
  const store = { issue: vi.fn().mockResolvedValue(undefined) };
  const gateway = { sendCode: vi.fn().mockResolvedValue(undefined) };
  const timingDefense = { pad: vi.fn().mockResolvedValue(undefined) };
  const useCase = new SendCancelDeletionCodeUseCase(
    inspect as unknown as InspectAccountStatusUseCase,
    store as unknown as DeletionCodeStore,
    gateway as unknown as SmsGateway,
    timingDefense as unknown as TimingDefenseExecutor,
    { smsCodeHmacSecret: SECRET } as AuthConfig,
  );
  return { inspect, store, gateway, timingDefense, useCase };
}

describe('SendCancelDeletionCodeUseCase', () => {
  it('eligible (FROZEN-in-grace) → 发码: 落 CANCEL_DELETION 码 (key=accountId) + 发 SMS, 不 pad', async () => {
    const b = build({ kind: 'FROZEN', accountId: ACCOUNT_ID, freezeUntil: FUTURE });

    await b.useCase.execute(PHONE);

    expect(b.store.issue).toHaveBeenCalledTimes(1);
    const [accId, purpose, codeHash, expiresAt] = b.store.issue.mock.calls[0]!;
    expect(accId).toBe(ACCOUNT_ID);
    expect(purpose).toBe(SmsPurpose.CANCEL_DELETION);
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now()); // 未来 (≈ +10min)

    expect(b.gateway.sendCode).toHaveBeenCalledTimes(1);
    const [sentPhone, sentCode, sentPurpose] = b.gateway.sendCode.mock.calls[0]!;
    expect(sentPhone).toBe(PHONE);
    expect(sentCode).toMatch(/^\d{6}$/);
    expect(sentPurpose).toBe(SmsPurpose.CANCEL_DELETION);
    expect(hashDeletionCode(sentCode, SECRET)).toBe(codeHash); // 发出码 hash == 落库 hash

    // eligible 路径不跑 pad (pad 仅 ineligible 对齐时延)。
    expect(b.timingDefense.pad).not.toHaveBeenCalled();
  });

  describe.each([
    ['未注册', { kind: 'NOT_FOUND' }],
    ['ACTIVE', { kind: 'ACTIVE' }],
    ['ANONYMIZED', { kind: 'ANONYMIZED' }],
    ['FROZEN-grace 已过', { kind: 'FROZEN', accountId: ACCOUNT_ID, freezeUntil: PAST }],
  ])('ineligible (%s) → pad + 静默返回, 不写码不发 SMS', (_label, inspection) => {
    it('pad() 调用 1 次, store/gateway 未触, 返 void', async () => {
      const b = build(inspection);
      await expect(b.useCase.execute(PHONE)).resolves.toBeUndefined();
      expect(b.timingDefense.pad).toHaveBeenCalledTimes(1);
      expect(b.store.issue).not.toHaveBeenCalled();
      expect(b.gateway.sendCode).not.toHaveBeenCalled();
    });
  });

  it('SMS 发送失败 → 503 SmsSendFailedException (码已落库, FR-S21)', async () => {
    const b = build({ kind: 'FROZEN', accountId: ACCOUNT_ID, freezeUntil: FUTURE });
    b.gateway.sendCode.mockRejectedValue(new Error('aliyun down'));

    await expect(b.useCase.execute(PHONE)).rejects.toThrow(SmsSendFailedException);
    expect(b.store.issue).toHaveBeenCalledTimes(1); // 码先落库
  });
});
