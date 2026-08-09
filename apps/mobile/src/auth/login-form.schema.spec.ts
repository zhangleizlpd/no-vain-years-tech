import { describe, expect, it } from 'vitest';
import { PHONE_REGEX, SMS_CODE_REGEX, phoneSmsAuthSchema } from './login-form.schema';

const validPhone = '+8613800138000';
const validCode = '123456';

describe('phoneSmsAuthSchema', () => {
  it('accepts a valid +86 CN mobile + 6-digit code', () => {
    const r = phoneSmsAuthSchema.safeParse({ phone: validPhone, code: validCode });
    expect(r.success).toBe(true);
  });

  describe('phone', () => {
    it.each([
      ['missing +86 prefix', '13800138000'],
      ['wrong country code', '+8513800138000'],
      ['2nd digit not 1[3-9]', '+8612800138000'],
      ['too short', '+861380013800'],
      ['too long', '+86138001380000'],
      ['trailing non-digit', '+861380013800a'],
    ])('rejects %s', (_label, phone) => {
      const r = phoneSmsAuthSchema.safeParse({ phone, code: validCode });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.message).toBe('INVALID_PHONE_FORMAT');
    });
  });

  describe('code', () => {
    it.each([
      ['5 digits', '12345'],
      ['7 digits', '1234567'],
      ['non-numeric', '12a456'],
      ['empty', ''],
    ])('rejects %s', (_label, code) => {
      const r = phoneSmsAuthSchema.safeParse({ phone: validPhone, code });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.message).toBe('INVALID_SMS_CODE_FORMAT');
    });
  });

  // Cross-anchor with server DTO (apps/server/src/auth/phone-sms-auth.request.ts):
  // @Matches(/^\+861[3-9]\d{9}$/) phone + @Matches(/^\d{6}$/) code. If this fails,
  // the two copies have drifted — fix both, not just one.
  it('mirrors server @Matches regex sources', () => {
    expect(PHONE_REGEX.source).toBe('^\\+861[3-9]\\d{9}$');
    expect(SMS_CODE_REGEX.source).toBe('^\\d{6}$');
  });
});
