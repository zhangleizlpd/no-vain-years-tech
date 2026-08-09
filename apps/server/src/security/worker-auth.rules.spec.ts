import { describe, it, expect } from 'vitest';
import { extractBearerToken, isWorkerAuthorized } from './worker-auth.rules.js';

describe('extractBearerToken', () => {
  it('extracts token from a well-formed Bearer header', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });

  it('is case-insensitive on the scheme', () => {
    expect(extractBearerToken('bearer abc123')).toBe('abc123');
    expect(extractBearerToken('BEARER abc123')).toBe('abc123');
  });

  it('returns null for missing / malformed headers', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken('abc123')).toBeNull(); // no scheme
    expect(extractBearerToken('Basic abc123')).toBeNull(); // wrong scheme
    expect(extractBearerToken('Bearer')).toBeNull(); // no token
    expect(extractBearerToken('Bearer a b')).toBeNull(); // extra parts
  });
});

describe('isWorkerAuthorized', () => {
  const TOKEN = 'a'.repeat(43); // base64url(32 bytes) 形态

  it('对: presented 与 expected 完全一致 → 授权', () => {
    expect(isWorkerAuthorized(TOKEN, TOKEN)).toBe(true);
  });

  it('错: presented 与 expected 不符 → 拒', () => {
    expect(isWorkerAuthorized('b'.repeat(43), TOKEN)).toBe(false);
  });

  it('错: 长度不同 → 拒 (不抛, timingSafeEqual 等长前置)', () => {
    expect(isWorkerAuthorized('short', TOKEN)).toBe(false);
    expect(isWorkerAuthorized(TOKEN, 'short')).toBe(false);
  });

  it('缺: presented 缺失 → fail-closed 拒', () => {
    expect(isWorkerAuthorized(null, TOKEN)).toBe(false);
  });

  it('缺: expected 未配 (null/空) → fail-closed 拒 (即使 presented 非空)', () => {
    expect(isWorkerAuthorized(TOKEN, null)).toBe(false);
    expect(isWorkerAuthorized(TOKEN, '')).toBe(false);
    expect(isWorkerAuthorized(null, null)).toBe(false);
  });
});
