import { describe, expect, it } from 'vitest';

import { maskClientNo } from './broker';

describe('maskClientNo', () => {
  it('> 8 chars → keep first 4 + **** + last 4 (mockup maskCust 口径)', () => {
    expect(maskClientNo('311900002466')).toBe('3119****2466');
  });

  it('exactly 9 chars → masked (boundary above 8)', () => {
    expect(maskClientNo('123456789')).toBe('1234****6789');
  });

  it('= 8 chars → unchanged (baseline, not long enough to mask)', () => {
    expect(maskClientNo('12345678')).toBe('12345678');
  });

  it('short number (< 8 chars) → unchanged', () => {
    expect(maskClientNo('12345')).toBe('12345');
  });

  it('null → empty string (default account has no client number)', () => {
    expect(maskClientNo(null)).toBe('');
  });

  it('empty string → empty string', () => {
    expect(maskClientNo('')).toBe('');
  });
});
