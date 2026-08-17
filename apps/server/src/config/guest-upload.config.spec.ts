import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { guestUploadConfig } from './guest-upload.config.js';

const KEYS = ['GUEST_UPLOAD_TOKEN'] as const;
const VALID = 'a'.repeat(43); // randomBytes(32).toString('base64url') 的长度

describe('guestUploadConfig', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('unset → null (app boots; the guard fail-closes on its own)', () => {
    expect(guestUploadConfig()).toEqual({ token: null });
  });

  it('empty string → token=null (compose ${VAR:-} feeds "" not undefined)', () => {
    process.env.GUEST_UPLOAD_TOKEN = '';
    expect(guestUploadConfig()).toEqual({ token: null });
  });

  /**
   * `toEqual` 是精确匹配 ⇒ 本条同时钉住**键集只有一个** —— 将来谁再加第二把 token 会在
   * 这里红一次, 那正是读 config 顶部「要开第二把先证明不共命」那段的时机。
   */
  it('已配 → 原样流经, 且 config 键集只有 token 一个', () => {
    process.env.GUEST_UPLOAD_TOKEN = VALID;
    expect(guestUploadConfig()).toEqual({ token: VALID });
  });

  it.each(KEYS)('%s 短于 32 字符 → boot 时抛 (弱 token 早暴露)', (key) => {
    process.env[key] = 'short-token';
    expect(() => guestUploadConfig()).toThrow();
  });
});
