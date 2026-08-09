import { describe, it, expect } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { SmsSendFailedException } from './sms-send-failed.exception';

// T007b (FR-S21): 503 SMS_SEND_FAILED 映射形态。catch→转的端到端 (gateway 抛 → 503)
// 在 send-deletion-code / send-cancel-deletion-code usecase 单测覆盖 (T008/T017)。
describe('SmsSendFailedException', () => {
  it('status 503 + code SMS_SEND_FAILED + 通用 message (不外泄网关细节)', () => {
    const ex = new SmsSendFailedException();
    expect(ex.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(SmsSendFailedException.code).toBe('SMS_SEND_FAILED');
    const body = ex.getResponse() as { code: string; message: string };
    expect(body.code).toBe('SMS_SEND_FAILED');
    expect(body.message).toBe('验证码发送失败,请稍后重试');
  });
});
