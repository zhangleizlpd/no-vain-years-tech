import { describe, it, expect } from 'vitest';
import { GENDER_OPTIONS, GENDER_LABELS, genderLabel } from './gender';

describe('gender label map (008 FR-C07)', () => {
  it('options are the 4 enums in spec order', () => {
    expect(GENDER_OPTIONS).toEqual(['MALE', 'FEMALE', 'NON_BINARY', 'PRIVATE']);
  });

  it('maps each enum to its Chinese label', () => {
    expect(GENDER_LABELS).toEqual({
      MALE: '男',
      FEMALE: '女',
      NON_BINARY: '非二元',
      PRIVATE: '保密',
    });
  });

  it('genderLabel returns the Chinese label for a set value', () => {
    expect(genderLabel('MALE')).toBe('男');
    expect(genderLabel('PRIVATE')).toBe('保密');
  });

  it('genderLabel returns empty string for null / undefined / unknown (unset placeholder)', () => {
    expect(genderLabel(null)).toBe('');
    expect(genderLabel(undefined)).toBe('');
    expect(genderLabel('OTHER')).toBe('');
  });
});
