import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { authConfig } from './auth.config.js';

const ENV_KEYS = ['AUTH_JWT_SECRET', 'SMS_CODE_HMAC_SECRET'] as const;

describe('authConfig (fail-fast at boot)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('throws when AUTH_JWT_SECRET missing', () => {
    process.env.SMS_CODE_HMAC_SECRET = 'x'.repeat(32);
    expect(() => authConfig()).toThrow();
  });

  it('throws when SMS_CODE_HMAC_SECRET shorter than 32 bytes', () => {
    process.env.AUTH_JWT_SECRET = 'x'.repeat(32);
    process.env.SMS_CODE_HMAC_SECRET = 'short';
    expect(() => authConfig()).toThrow(/32 bytes/);
  });

  it('parses when both secrets meet length requirement', () => {
    process.env.AUTH_JWT_SECRET = 'a'.repeat(32);
    process.env.SMS_CODE_HMAC_SECRET = 'b'.repeat(40);
    const cfg = authConfig();
    expect(cfg.jwtSecret).toHaveLength(32);
    expect(cfg.smsCodeHmacSecret).toHaveLength(40);
  });
});
