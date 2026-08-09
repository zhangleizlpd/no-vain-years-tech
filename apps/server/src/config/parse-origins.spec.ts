import { describe, it, expect } from 'vitest';
import { parseOrigins } from './parse-origins.js';

describe('parseOrigins', () => {
  it('returns true for "*" (permissive dev mode)', () => {
    expect(parseOrigins('*')).toBe(true);
  });

  it('returns false for undefined (lock-down: no header emitted)', () => {
    expect(parseOrigins(undefined)).toBe(false);
  });

  it('returns false for empty / whitespace-only string', () => {
    expect(parseOrigins('')).toBe(false);
    expect(parseOrigins('   ')).toBe(false);
  });

  it('splits comma list into trimmed array', () => {
    expect(parseOrigins('https://a.com, https://b.com,https://c.com')).toEqual([
      'https://a.com',
      'https://b.com',
      'https://c.com',
    ]);
  });

  it('filters out empty entries from comma list', () => {
    expect(parseOrigins('https://a.com,,  ,https://b.com')).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
  });

  it('returns single-item array for single origin', () => {
    expect(parseOrigins('https://mbw.app')).toEqual(['https://mbw.app']);
  });
});
