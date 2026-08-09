import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractToken, isAuthorized } from '../src/auth.js';

describe('extractToken', () => {
  it('parses a Bearer header (case-insensitive)', () => {
    expect(extractToken('Bearer abc123')).toBe('abc123');
    expect(extractToken('bearer abc123')).toBe('abc123');
  });
  it('returns null for missing or malformed headers', () => {
    expect(extractToken(undefined)).toBeNull();
    expect(extractToken('Basic xxx')).toBeNull();
    expect(extractToken('abc123')).toBeNull();
  });
});

describe('isAuthorized (fail-closed, constant-time)', () => {
  const saved = process.env.CODE_INDEX_SERVICE_TOKEN;
  beforeEach(() => {
    process.env.CODE_INDEX_SERVICE_TOKEN = 's3cr3t-token';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CODE_INDEX_SERVICE_TOKEN;
    else process.env.CODE_INDEX_SERVICE_TOKEN = saved;
  });

  it('authorizes the exact token', () => {
    expect(isAuthorized('s3cr3t-token')).toBe(true);
  });
  it('rejects wrong / empty / null tokens', () => {
    expect(isAuthorized('wrong')).toBe(false);
    expect(isAuthorized('s3cr3t-toke')).toBe(false); // length mismatch
    expect(isAuthorized('')).toBe(false);
    expect(isAuthorized(null)).toBe(false);
  });
  it('never authorizes when the configured token is unset', () => {
    delete process.env.CODE_INDEX_SERVICE_TOKEN;
    expect(isAuthorized('anything')).toBe(false);
    expect(isAuthorized('')).toBe(false);
  });
});
