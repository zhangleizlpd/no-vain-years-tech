import { describe, expect, it } from 'vitest';

import { maskPhone } from './phone';

describe('maskPhone', () => {
  it('+86 standard 11-digit → spaces + 4-star mask', () => {
    expect(maskPhone('+8613900139000')).toBe('+86 139****9000');
  });

  it('+86 longest-prefix wins over +861 (no spurious split)', () => {
    // +861... must be parsed as +86 + 1..., not +861 + ...
    expect(maskPhone('+8613812345678')).toBe('+86 138****5678');
  });

  it('+852 Hong Kong (8-digit local → head=987, 4 stars, tail=5432)', () => {
    // +852 + 98765432 (8 digits): head=987, tail=5432, middle=1→padded to 4 stars
    expect(maskPhone('+85298765432')).toBe('+852 987****5432');
  });

  it('+1 US (10 digits)', () => {
    expect(maskPhone('+12025551234')).toBe('+1 202****1234');
  });

  it('null → 未绑定', () => {
    expect(maskPhone(null)).toBe('未绑定');
  });

  it('empty string → 未绑定', () => {
    expect(maskPhone('')).toBe('未绑定');
  });

  it('unknown country code → 未绑定', () => {
    expect(maskPhone('+9991234567890')).toBe('未绑定');
  });

  it('local number too short (< 7 digits after country code) → 未绑定', () => {
    expect(maskPhone('+86123456')).toBe('未绑定'); // only 9 chars, localNumber = 123456 = 6 digits
  });

  it('non-digit in local number → 未绑定', () => {
    expect(maskPhone('+8613a00139000')).toBe('未绑定');
  });

  it('middle segment has at least 4 stars even for 7-digit local numbers', () => {
    const result = maskPhone('+861234567'); // +86 + 7 digits: head=123, tail=4567, middle=0→padded 4 stars
    expect(result).toBe('+86 123****4567');
    expect(result).toMatch(/\*{4,}/);
  });
});
