import { describe, it, expect, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { SendDeletionCodeUseCase } from './send-deletion-code.usecase';
import { SmsSendFailedException } from './sms-send-failed.exception';
import { SmsPurpose, hashDeletionCode } from './deletion-code.rules';
import type { InspectAccountStatusByIdUseCase } from '../account/inspect-account-status-by-id.usecase';
import type { DeletionCodeStore } from './deletion-code.store';
import type { SmsGateway } from './sms-gateway.port';
import type { AuthConfig } from '../config/auth.config';

type Fn = ReturnType<typeof vi.fn>;
const SECRET = 'x'.repeat(32);
const PHONE = '+8613800138000';
const ACCOUNT_ID = 42n;

function build(inspectionKind: { kind: string; phone?: string }) {
  const inspect = { execute: vi.fn().mockResolvedValue(inspectionKind) };
  const store = { issue: vi.fn().mockResolvedValue(undefined) };
  const gateway = { sendCode: vi.fn().mockResolvedValue(undefined) };
  const useCase = new SendDeletionCodeUseCase(
    inspect as unknown as InspectAccountStatusByIdUseCase,
    store as unknown as DeletionCodeStore,
    gateway as unknown as SmsGateway,
    { smsCodeHmacSecret: SECRET } as AuthConfig,
  );
  return { inspect, store, gateway, useCase };
}

describe('SendDeletionCodeUseCase', () => {
  let store: { issue: Fn };
  let gateway: { sendCode: Fn };

  it('ACTIVE → 发码: 落 DELETE_ACCOUNT 码 + 发 SMS, 发出的码与落库 hash 对应', async () => {
    const b = build({ kind: 'ACTIVE', phone: PHONE });
    store = b.store;
    gateway = b.gateway;

    await b.useCase.execute(ACCOUNT_ID);

    expect(store.issue).toHaveBeenCalledTimes(1);
    const [accId, purpose, codeHash, expiresAt] = store.issue.mock.calls[0]!;
    expect(accId).toBe(ACCOUNT_ID);
    expect(purpose).toBe(SmsPurpose.DELETE_ACCOUNT);
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now()); // 未来 (≈ +10min)

    expect(gateway.sendCode).toHaveBeenCalledTimes(1);
    const [sentPhone, sentCode, sentPurpose] = gateway.sendCode.mock.calls[0]!;
    expect(sentPhone).toBe(PHONE);
    expect(sentCode).toMatch(/^\d{6}$/);
    expect(sentPurpose).toBe(SmsPurpose.DELETE_ACCOUNT);
    // 发给用户的明文码 hash 后 == 落库的 codeHash (同一码)
    expect(hashDeletionCode(sentCode, SECRET)).toBe(codeHash);
  });

  describe.each([
    ['NOT_FOUND', { kind: 'NOT_FOUND' }],
    ['FROZEN', { kind: 'FROZEN', freezeUntil: new Date(Date.now() + 1e9) }],
    ['ANONYMIZED', { kind: 'ANONYMIZED' }],
  ])('非 ACTIVE (%s) → 反枚举 401, 不发码', (_label, inspection) => {
    it('throws UnauthorizedException(INVALID_CREDENTIALS), store/gateway 未触', async () => {
      const b = build(inspection as { kind: string });
      await expect(b.useCase.execute(ACCOUNT_ID)).rejects.toThrow(UnauthorizedException);
      await expect(b.useCase.execute(ACCOUNT_ID)).rejects.toThrow('INVALID_CREDENTIALS');
      expect(b.store.issue).not.toHaveBeenCalled();
      expect(b.gateway.sendCode).not.toHaveBeenCalled();
    });
  });

  it('SMS 发送失败 → 503 SmsSendFailedException (码已落库, T007b 端到端)', async () => {
    const b = build({ kind: 'ACTIVE', phone: PHONE });
    b.gateway.sendCode.mockRejectedValue(new Error('aliyun down'));

    await expect(b.useCase.execute(ACCOUNT_ID)).rejects.toThrow(SmsSendFailedException);
    expect(b.store.issue).toHaveBeenCalledTimes(1); // 码先落库
  });
});
