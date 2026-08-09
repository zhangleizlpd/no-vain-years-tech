import { describe, expect, it } from 'vitest';
import { displayNameSchema, onboardingFormSchema } from './onboarding-form.schema';

// Forbidden chars built via fromCharCode/fromCodePoint so this source stays ASCII
// (literal control / zero-width / line-separator chars would break the parser).
const cc = String.fromCharCode;

describe('displayNameSchema (mirrors server FR-005 / account.rules.ts)', () => {
  // SC-018 — 8-case table covering server FR-005 boundaries.
  it.each([
    ['empty', '', false],
    ['whitespace-only', '   ', false],
    ['control char U+0001', `a${cc(0x01)}b`, false],
    ['zero-width space U+200B', `a${cc(0x200b)}b`, false],
    ['33 code points (over max)', '阿'.repeat(33), false],
    ['32 CJK code points (upper boundary)', '阿'.repeat(32), true],
    ['emoji-only', String.fromCodePoint(0x1f389, 0x1f338), true],
    ['mixed valid', '小明123', true],
  ])('%s -> success=%s', (_label, value, expected) => {
    expect(displayNameSchema.safeParse(value).success).toBe(expected);
  });

  // Forbidden chars are checked on the RAW string before trim — trim() would eat a
  // leading/trailing BOM and let it slip through (matches server ordering).
  it('rejects a leading BOM (U+FEFF) that trim would otherwise swallow', () => {
    expect(displayNameSchema.safeParse(`${cc(0xfeff)}hi`).success).toBe(false);
  });

  it('rejects line separator U+2028', () => {
    expect(displayNameSchema.safeParse(`a${cc(0x2028)}b`).success).toBe(false);
  });

  it('trims surrounding whitespace and returns the trimmed value', () => {
    const r = displayNameSchema.safeParse('  小明  ');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe('小明');
  });

  it('counts CJK by code point, not byte (32 CJK passes)', () => {
    expect(displayNameSchema.safeParse('阿'.repeat(32)).success).toBe(true);
    expect(displayNameSchema.safeParse('阿'.repeat(33)).success).toBe(false);
  });
});

describe('onboardingFormSchema (RHF object wrapper)', () => {
  it('parses { displayName } and exposes the trimmed value', () => {
    const r = onboardingFormSchema.safeParse({ displayName: '  小明  ' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.displayName).toBe('小明');
  });

  it('fails when displayName is invalid', () => {
    expect(onboardingFormSchema.safeParse({ displayName: '' }).success).toBe(false);
  });
});
