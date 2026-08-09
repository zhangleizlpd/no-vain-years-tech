import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { SendUnbindWechatCodeUseCase } from './send-unbind-wechat-code.usecase';
import { SmsPurpose } from './deletion-code.rules';
import { SmsSendFailedException } from './sms-send-failed.exception';
import type { InspectAccountStatusByIdUseCase } from '../account/inspect-account-status-by-id.usecase';
import type { InspectWechatBindingUseCase } from '../account/inspect-wechat-binding.usecase';
import type { DeletionCodeStore } from './deletion-code.store';
import type { SmsGateway } from './sms-gateway.port';
import type { AuthConfig } from '../config/auth.config';

function build(opts: { kind?: string; bound?: boolean; smsThrows?: boolean }) {
  const inspectAcc = {
    execute: vi.fn().mockResolvedValue({ kind: opts.kind ?? 'ACTIVE', phone: '+8613800138000' }),
  } as unknown as InspectAccountStatusByIdUseCase;
  const inspectWx = {
    execute: vi.fn().mockResolvedValue({ bound: opts.bound ?? true }),
  } as unknown as InspectWechatBindingUseCase;
  const issue = vi.fn().mockResolvedValue(undefined);
  const store = { issue } as unknown as DeletionCodeStore;
  const sendCode = opts.smsThrows
    ? vi.fn().mockRejectedValue(new Error('gateway down'))
    : vi.fn().mockResolvedValue(undefined);
  const sms = { sendCode } as unknown as SmsGateway;
  const cfg = { smsCodeHmacSecret: 'unbind-hmac-secret-min-32-bytes-pad-x' } as AuthConfig;
  const usecase = new SendUnbindWechatCodeUseCase(inspectAcc, inspectWx, store, sms, cfg);
  return { usecase, issue, sendCode };
}

describe('SendUnbindWechatCodeUseCase (auth 编排)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ACTIVE + 已绑 → 发 UNBIND_WECHAT 码 + SMS UNBIND_WECHAT', async () => {
    const { usecase, issue, sendCode } = build({});
    await expect(usecase.execute(1n)).resolves.toBeUndefined();
    expect(issue).toHaveBeenCalledWith(
      1n,
      SmsPurpose.UNBIND_WECHAT,
      expect.any(String),
      expect.any(Date),
    );
    expect(sendCode).toHaveBeenCalledWith(
      '+8613800138000',
      expect.any(String),
      SmsPurpose.UNBIND_WECHAT,
    );
  });

  it('未绑微信 → 401 折叠 + 不发码', async () => {
    const { usecase, issue } = build({ bound: false });
    await expect(usecase.execute(1n)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(issue).not.toHaveBeenCalled();
  });

  it('非 ACTIVE → 401 折叠 + 不发码', async () => {
    const { usecase, issue } = build({ kind: 'FROZEN' });
    await expect(usecase.execute(1n)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(issue).not.toHaveBeenCalled();
  });

  it('NOT_FOUND → 401 折叠 (与未绑/非 ACTIVE 同 message, 字节级一致)', async () => {
    const notFound = build({ kind: 'NOT_FOUND', bound: false });
    const unbound = build({ bound: false });
    const e1 = await notFound.usecase.execute(1n).catch((e: UnauthorizedException) => e.message);
    const e2 = await unbound.usecase.execute(1n).catch((e: UnauthorizedException) => e.message);
    expect(e1).toBe(e2);
  });

  it('SMS 发送失败 → 503 SmsSendFailedException (码已落库)', async () => {
    const { usecase, issue } = build({ smsThrows: true });
    await expect(usecase.execute(1n)).rejects.toBeInstanceOf(SmsSendFailedException);
    expect(issue).toHaveBeenCalledOnce(); // 码已落库, 仅发送失败
  });
});
