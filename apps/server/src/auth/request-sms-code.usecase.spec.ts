import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RequestSmsCodeUseCase } from './request-sms-code.usecase';
import type { SmsCodeStore } from './sms-code.store';
import type { SmsGateway } from './sms-gateway.port';

describe('RequestSmsCodeUseCase', () => {
  let smsCodeStore: SmsCodeStore;
  let smsGateway: SmsGateway;
  let useCase: RequestSmsCodeUseCase;

  beforeEach(() => {
    smsCodeStore = {
      store: vi.fn().mockResolvedValue(undefined),
      verify: vi.fn().mockResolvedValue(null),
      clear: vi.fn().mockResolvedValue(undefined),
    } as unknown as SmsCodeStore;
    smsGateway = {
      sendCode: vi.fn().mockResolvedValue(undefined),
    };
    useCase = new RequestSmsCodeUseCase(smsCodeStore, smsGateway);
  });

  it('returns ttlSec=300 (FR-S02 default)', async () => {
    const phone = '+8613800138301';
    const result = await useCase.execute(phone);
    expect(result.ttlSec).toBe(300);
  });

  it('stores generated 6-digit code in repo before sending via gateway', async () => {
    const phone = '+8613800138302';
    await useCase.execute(phone);

    expect(smsCodeStore.store).toHaveBeenCalledTimes(1);
    expect(smsGateway.sendCode).toHaveBeenCalledTimes(1);

    const [storedPhone, storedCode, storedTtl] = vi.mocked(smsCodeStore.store).mock.calls[0];
    expect(storedPhone).toBe('+8613800138302');
    expect(typeof storedCode).toBe('string');
    expect(storedCode).toMatch(/^\d{6}$/);
    expect(storedTtl).toBe(300);
  });

  it('sends the same code that was stored (idempotent pair)', async () => {
    const phone = '+8613800138303';
    await useCase.execute(phone);

    const storedCode = vi.mocked(smsCodeStore.store).mock.calls[0][1];
    const sentCode = vi.mocked(smsGateway.sendCode).mock.calls[0][1];
    expect(storedCode).toBe(sentCode);
  });

  it('propagates gateway send error (store completes; retry on next call)', async () => {
    smsGateway.sendCode = vi.fn().mockRejectedValue(new Error('gateway timeout'));
    const phone = '+8613800138304';

    await expect(useCase.execute(phone)).rejects.toThrow('gateway timeout');
    expect(smsCodeStore.store).toHaveBeenCalledTimes(1);
  });
});
