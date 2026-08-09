import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { assertValidSmsCode, generateSmsCode, issueSmsCode } from './sms-code.rules';

describe('sms-code.rules — assertValidSmsCode (原 SmsCode VO 校验,R-VO 拍平)', () => {
  it('accepts 6-digit code (no throw)', () => {
    expect(() => assertValidSmsCode('123456')).not.toThrow();
    expect(() => assertValidSmsCode('000000')).not.toThrow();
    expect(() => assertValidSmsCode('999999')).not.toThrow();
  });

  it('rejects non-6-digit', () => {
    expect(() => assertValidSmsCode('12345')).toThrow(/Invalid SMS code/i);
    expect(() => assertValidSmsCode('1234567')).toThrow(/Invalid SMS code/i);
    expect(() => assertValidSmsCode('12345a')).toThrow(/Invalid SMS code/i);
    expect(() => assertValidSmsCode('')).toThrow(/Invalid SMS code/i);
  });
});

describe('sms-code.rules — generateSmsCode', () => {
  it('produces random 6-digit string (CSPRNG)', () => {
    for (let i = 0; i < 100; i++) {
      const c = generateSmsCode();
      expect(c).toMatch(/^\d{6}$/);
    }
  });

  it('output passes assertValidSmsCode', () => {
    expect(() => assertValidSmsCode(generateSmsCode())).not.toThrow();
  });
});

describe('sms-code.rules — issueSmsCode (统一发码入口 + dev 固定码 gate)', () => {
  let savedNodeEnv: string | undefined;
  let savedVitest: string | undefined;

  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV;
    savedVitest = process.env.VITEST;
  });

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    if (savedVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = savedVitest;
  });

  it('returns CSPRNG under the automated suite (VITEST set), even in development', () => {
    // The vitest suite always has process.env.VITEST set — guards IT like
    // accounts.us1 that hardcode '999999' as the *wrong* code.
    process.env.NODE_ENV = 'development';
    for (let i = 0; i < 50; i++) {
      expect(issueSmsCode()).toMatch(/^\d{6}$/);
    }
  });

  it('returns the fixed 999999 only in interactive development (NODE_ENV=development, no VITEST)', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.VITEST;
    expect(issueSmsCode()).toBe('999999');
  });

  it('returns CSPRNG outside development (prod/staging) regardless of VITEST', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.VITEST;
    // 100 draws — fixed code would collide deterministically; CSPRNG won't all be 999999.
    const codes = new Set(Array.from({ length: 100 }, () => issueSmsCode()));
    expect(codes.size).toBeGreaterThan(1);
    for (const c of codes) expect(c).toMatch(/^\d{6}$/);
  });
});
