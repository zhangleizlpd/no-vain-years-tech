import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { guestUploadConfig } from './guest-upload.config.js';

const KEY = 'GUEST_UPLOAD_TOKEN';
const VALID = 'a'.repeat(43); // randomBytes(32).toString('base64url') 的长度

describe('guestUploadConfig', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
    delete process.env[KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('unset → token=null (app boots; the guard fail-closes on its own)', () => {
    expect(guestUploadConfig()).toEqual({ token: null });
  });

  it('empty string → token=null (compose ${VAR:-} feeds "" not undefined)', () => {
    process.env[KEY] = '';
    expect(guestUploadConfig()).toEqual({ token: null });
  });

  it('a configured token flows through verbatim', () => {
    process.env[KEY] = VALID;
    expect(guestUploadConfig()).toEqual({ token: VALID });
  });

  it('throws at boot when the token is shorter than 32 chars (弱 token 早暴露)', () => {
    process.env[KEY] = 'short-token';
    expect(() => guestUploadConfig()).toThrow();
  });
});
