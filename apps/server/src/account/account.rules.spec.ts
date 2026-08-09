import { describe, it, expect } from 'vitest';
import {
  AccountStatus,
  ANONYMIZED_DISPLAY_NAME,
  canAnonymize,
  canCancelFromFrozen,
  canFreeze,
  FREEZE_DURATION_DAYS,
  Gender,
  isActive,
  isAnonymized,
  isFrozen,
  isFrozenInGrace,
  isWithinGrace,
  normalizeBio,
  normalizeDisplayName,
  normalizeGender,
  normalizePhone,
} from './account.rules';
import type { Account } from '../generated/prisma/client';

// Minimal raw `Account` row — rules only read `.status` / `.freezeUntil`, rest
// is padding to satisfy the generated type shape (per ADR-0043 贫血: data = Prisma row).
const row = (status: string, freezeUntil: Date | null = null): Account =>
  ({
    id: 1n,
    phone: '+8613800138000',
    status,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
    displayName: null,
    freezeUntil,
    previousPhoneHash: null,
  }) as Account;

describe('account.rules — 纯函数不变量 (per ADR-0043 §2)', () => {
  it('isActive true only for ACTIVE', () => {
    expect(isActive(row(AccountStatus.ACTIVE))).toBe(true);
    expect(isActive(row(AccountStatus.FROZEN))).toBe(false);
    expect(isActive(row(AccountStatus.ANONYMIZED))).toBe(false);
  });

  it('isFrozen true only for FROZEN', () => {
    expect(isFrozen(row(AccountStatus.FROZEN))).toBe(true);
    expect(isFrozen(row(AccountStatus.ACTIVE))).toBe(false);
    expect(isFrozen(row(AccountStatus.ANONYMIZED))).toBe(false);
  });

  it('isAnonymized true only for ANONYMIZED', () => {
    expect(isAnonymized(row(AccountStatus.ANONYMIZED))).toBe(true);
    expect(isAnonymized(row(AccountStatus.ACTIVE))).toBe(false);
    expect(isAnonymized(row(AccountStatus.FROZEN))).toBe(false);
  });

  it('unknown status → all predicates false (贫血 row 容错)', () => {
    const unknown = row('PENDING_DELETION');
    expect(isActive(unknown)).toBe(false);
    expect(isFrozen(unknown)).toBe(false);
    expect(isAnonymized(unknown)).toBe(false);
  });
});

describe('account.rules — 状态转换门槛 (FR-S03 freeze / FR-S09 cancel / FR-S13 anonymize)', () => {
  it('constants pin the lifecycle (FR-S03 15d / FR-S14 匿名化展示名)', () => {
    expect(FREEZE_DURATION_DAYS).toBe(15);
    expect(ANONYMIZED_DISPLAY_NAME).toBe('已注销用户');
  });

  it('canFreeze true only for ACTIVE (freezeUntil irrelevant)', () => {
    expect(canFreeze(row(AccountStatus.ACTIVE))).toBe(true);
    expect(canFreeze(row(AccountStatus.FROZEN, new Date()))).toBe(false);
    expect(canFreeze(row(AccountStatus.ANONYMIZED))).toBe(false);
    expect(canFreeze(row('PENDING_DELETION'))).toBe(false);
  });

  // Grace boundary table — freezeUntil at now-1ms / now / now+1ms across each
  // status. `>` (in-grace, cancel) vs `<=` (expired, anonymize) MUST partition
  // the freezeUntil===now instant strictly: at the boundary anonymize wins,
  // cancel loses (plan §2 concurrency 互斥 + FR-S16).
  const now = new Date('2026-06-01T03:00:00.000Z');
  const before = new Date(now.getTime() - 1); // grace expired
  const exact = new Date(now.getTime()); // boundary instant
  const after = new Date(now.getTime() + 1); // still in grace

  describe('isFrozenInGrace / canCancelFromFrozen (FROZEN ∧ freezeUntil > now)', () => {
    it('true only when FROZEN and freezeUntil strictly after now', () => {
      expect(isFrozenInGrace(row(AccountStatus.FROZEN, after), now)).toBe(true);
      expect(isFrozenInGrace(row(AccountStatus.FROZEN, exact), now)).toBe(false); // boundary → not in grace
      expect(isFrozenInGrace(row(AccountStatus.FROZEN, before), now)).toBe(false);
      expect(isFrozenInGrace(row(AccountStatus.FROZEN, null), now)).toBe(false);
      expect(isFrozenInGrace(row(AccountStatus.ACTIVE, after), now)).toBe(false);
      expect(isFrozenInGrace(row(AccountStatus.ANONYMIZED, after), now)).toBe(false);
    });

    it('canCancelFromFrozen mirrors isFrozenInGrace exactly', () => {
      for (const f of [after, exact, before, null]) {
        const a = row(AccountStatus.FROZEN, f);
        expect(canCancelFromFrozen(a, now)).toBe(isFrozenInGrace(a, now));
      }
    });

    // isWithinGrace = status-free `>` 边界 (auth 仅持 inspection freezeUntil 时复用)。
    // 严格与 isFrozenInGrace 的时间分量同源: FROZEN row 套用必一致。
    it('isWithinGrace: freezeUntil 严格晚于 now (null / 边界 / 过去 → false)', () => {
      expect(isWithinGrace(after, now)).toBe(true);
      expect(isWithinGrace(exact, now)).toBe(false); // 边界 → 不在 grace (匿名化恒赢)
      expect(isWithinGrace(before, now)).toBe(false);
      expect(isWithinGrace(null, now)).toBe(false);
    });

    it('isFrozenInGrace(FROZEN row) === isWithinGrace(freezeUntil) (委托一致)', () => {
      for (const f of [after, exact, before, null]) {
        expect(isFrozenInGrace(row(AccountStatus.FROZEN, f), now)).toBe(isWithinGrace(f, now));
      }
    });
  });

  describe('canAnonymize (FROZEN ∧ freezeUntil != null ∧ freezeUntil <= now)', () => {
    it('true only when FROZEN and freezeUntil at-or-before now', () => {
      expect(canAnonymize(row(AccountStatus.FROZEN, before), now)).toBe(true);
      expect(canAnonymize(row(AccountStatus.FROZEN, exact), now)).toBe(true); // boundary → anonymize wins
      expect(canAnonymize(row(AccountStatus.FROZEN, after), now)).toBe(false);
      expect(canAnonymize(row(AccountStatus.FROZEN, null), now)).toBe(false);
      expect(canAnonymize(row(AccountStatus.ACTIVE, before), now)).toBe(false);
      expect(canAnonymize(row(AccountStatus.ANONYMIZED, before), now)).toBe(false);
    });

    it('boundary is mutually exclusive: at freezeUntil===now exactly one of cancel/anonymize holds', () => {
      const a = row(AccountStatus.FROZEN, exact);
      expect(canCancelFromFrozen(a, now)).toBe(false);
      expect(canAnonymize(a, now)).toBe(true);
    });
  });
});

describe('account.rules — normalizePhone (原 Phone VO,R-VO 拍平)', () => {
  it('accepts valid CN mobile, returns trimmed', () => {
    expect(normalizePhone('+8613800138000')).toBe('+8613800138000');
    expect(normalizePhone('+8615912345678')).toBe('+8615912345678');
    expect(normalizePhone('+8619987654321')).toBe('+8619987654321');
  });

  it('trims whitespace before validation', () => {
    expect(normalizePhone('  +8613800138000  ')).toBe('+8613800138000');
  });

  it('rejects missing +86 prefix / trailing junk', () => {
    expect(() => normalizePhone('13800138000')).toThrow(/Invalid phone/i);
    expect(() => normalizePhone('+8613800138000a')).toThrow(/Invalid phone/i);
  });

  it('rejects non-CN mobile prefixes (1[3-9])', () => {
    expect(() => normalizePhone('+8612345678901')).toThrow(/Invalid phone/i);
    expect(() => normalizePhone('+8610000000000')).toThrow(/Invalid phone/i);
  });

  it('rejects wrong length', () => {
    expect(() => normalizePhone('+86138001380')).toThrow(/Invalid phone/i);
    expect(() => normalizePhone('+861380013800099')).toThrow(/Invalid phone/i);
  });
});

describe('account.rules — normalizeDisplayName (原 DisplayName VO,R-VO 拍平)', () => {
  it('returns trimmed value', () => {
    expect(normalizeDisplayName('  Alice  ')).toBe('Alice');
    expect(normalizeDisplayName('你好世界')).toBe('你好世界');
  });

  it('accepts single emoji (1 code point) + 32-cp upper boundary', () => {
    expect(normalizeDisplayName(String.fromCodePoint(0x1f60a))).toBe(String.fromCodePoint(0x1f60a));
    expect(normalizeDisplayName('a'.repeat(32))).toBe('a'.repeat(32));
  });

  it('counts by Unicode code points, not UTF-16 units', () => {
    const four = String.fromCodePoint(0x1f60a, 0x1f60a, 0x1f60a, 0x1f60a);
    expect(normalizeDisplayName(four)).toBe(four);
  });

  it('rejects empty / whitespace-only / 33 cp', () => {
    expect(() => normalizeDisplayName('')).toThrow(/INVALID_DISPLAY_NAME/);
    expect(() => normalizeDisplayName('   ')).toThrow(/INVALID_DISPLAY_NAME/);
    expect(() => normalizeDisplayName('a'.repeat(33))).toThrow(/INVALID_DISPLAY_NAME/);
  });

  it('rejects forbidden chars (control / zero-width / BOM / line separator)', () => {
    expect(() => normalizeDisplayName('abc\x01def')).toThrow(/INVALID_DISPLAY_NAME/);
    expect(() => normalizeDisplayName('abc' + String.fromCodePoint(0x200b) + 'def')).toThrow(
      /INVALID_DISPLAY_NAME/,
    );
    expect(() => normalizeDisplayName(String.fromCodePoint(0xfeff) + 'name')).toThrow(
      /INVALID_DISPLAY_NAME/,
    );
    expect(() => normalizeDisplayName('abc' + String.fromCodePoint(0x2028) + 'def')).toThrow(
      /INVALID_DISPLAY_NAME/,
    );
  });
});

// normalizeBio (007 FR-S03) — 镜像 displayName 口径但上限 120 且【允许空】。
describe('normalizeBio — 007 FR-S03', () => {
  it('trims and returns valid bio', () => {
    expect(normalizeBio('  美股研究员  ')).toBe('美股研究员');
  });

  it('allows empty string (clear bio) — returns empty, does NOT throw', () => {
    expect(normalizeBio('')).toBe('');
    expect(normalizeBio('   ')).toBe('');
  });

  it('accepts exactly 120 code points (upper boundary)', () => {
    const max = '字'.repeat(120);
    expect(normalizeBio(max)).toBe(max);
  });

  it('counts emoji by Unicode code points, not UTF-16 units', () => {
    const emoji = String.fromCodePoint(0x1f60a).repeat(60);
    expect(normalizeBio(emoji)).toBe(emoji);
  });

  it('rejects 121 code points (exceeds max)', () => {
    expect(() => normalizeBio('a'.repeat(121))).toThrow(/INVALID_BIO/);
  });

  it('rejects forbidden chars (control / zero-width / BOM / line separator)', () => {
    expect(() => normalizeBio('abc\x01def')).toThrow(/INVALID_BIO/);
    expect(() => normalizeBio('abc' + String.fromCodePoint(0x200b) + 'def')).toThrow(/INVALID_BIO/);
    expect(() => normalizeBio(String.fromCodePoint(0xfeff) + 'bio')).toThrow(/INVALID_BIO/);
    expect(() => normalizeBio('abc' + String.fromCodePoint(0x2028) + 'def')).toThrow(/INVALID_BIO/);
  });
});

// normalizeGender (008 FR-S03) — 严格 4 枚举或 null（清空），其余抛 INVALID_GENDER。
describe('normalizeGender — 008 FR-S03', () => {
  it('accepts each of the 4 valid enum values', () => {
    expect(normalizeGender('MALE')).toBe(Gender.MALE);
    expect(normalizeGender('FEMALE')).toBe(Gender.FEMALE);
    expect(normalizeGender('NON_BINARY')).toBe(Gender.NON_BINARY);
    expect(normalizeGender('PRIVATE')).toBe(Gender.PRIVATE);
  });

  it('normalizes null / empty / whitespace to null (clear gender)', () => {
    expect(normalizeGender(null)).toBeNull();
    expect(normalizeGender('')).toBeNull();
    expect(normalizeGender('   ')).toBeNull();
  });

  it('rejects unknown values (not one of the 4 enums)', () => {
    expect(() => normalizeGender('male')).toThrow(/INVALID_GENDER/);
    expect(() => normalizeGender('OTHER')).toThrow(/INVALID_GENDER/);
    expect(() => normalizeGender('男')).toThrow(/INVALID_GENDER/);
  });
});
