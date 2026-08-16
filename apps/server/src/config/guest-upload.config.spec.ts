import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { guestUploadConfig } from './guest-upload.config.js';

const KEYS = ['GUEST_UPLOAD_TOKEN', 'ANCHOR_IMPORT_TOKEN'] as const;
const VALID = 'a'.repeat(43); // randomBytes(32).toString('base64url') 的长度
const VALID_ANCHOR = 'b'.repeat(43);

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

  it('unset → 两把都是 null (app boots; the guard fail-closes on its own)', () => {
    expect(guestUploadConfig()).toEqual({ token: null, anchorImportToken: null });
  });

  it('empty string → token=null (compose ${VAR:-} feeds "" not undefined)', () => {
    process.env.GUEST_UPLOAD_TOKEN = '';
    process.env.ANCHOR_IMPORT_TOKEN = '';
    expect(guestUploadConfig()).toEqual({ token: null, anchorImportToken: null });
  });

  it('两把 token 各自流经、互不串位 (串位的表现是授权分流形同虚设, 不是报错)', () => {
    process.env.GUEST_UPLOAD_TOKEN = VALID;
    process.env.ANCHOR_IMPORT_TOKEN = VALID_ANCHOR;
    expect(guestUploadConfig()).toEqual({ token: VALID, anchorImportToken: VALID_ANCHOR });
  });

  it('只配一把 → 另一把 null (未配 ≠ 借用隔壁那把)', () => {
    process.env.GUEST_UPLOAD_TOKEN = VALID;
    expect(guestUploadConfig()).toEqual({ token: VALID, anchorImportToken: null });
  });

  it.each(KEYS)('%s 短于 32 字符 → boot 时抛 (弱 token 早暴露)', (key) => {
    process.env[key] = 'short-token';
    expect(() => guestUploadConfig()).toThrow();
  });
});
