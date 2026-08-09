import { describe, it, expect } from 'vitest';
import {
  DELETION_CODE_TTL_MIN,
  hashDeletionCode,
  SmsPurpose,
  verifyDeletionCode,
} from './deletion-code.rules';

const SECRET = 'test-deletion-hmac-secret';

describe('deletion-code.rules — 常量 + 枚举', () => {
  it('DELETION_CODE_TTL_MIN = 10 (注销/撤销码 10 分钟有效)', () => {
    expect(DELETION_CODE_TTL_MIN).toBe(10);
  });

  it('SmsPurpose 枚举值与 account_sms_code.purpose 列字面一致', () => {
    expect(SmsPurpose.DELETE_ACCOUNT).toBe('DELETE_ACCOUNT');
    expect(SmsPurpose.CANCEL_DELETION).toBe('CANCEL_DELETION');
  });

  it('SmsPurpose.UNBIND_WECHAT 存在 (010 微信解绑码) 且不破既有两值', () => {
    expect(SmsPurpose.UNBIND_WECHAT).toBe('UNBIND_WECHAT');
    // 010 唯一改动: 新增枚举值, 既有 DELETE_ACCOUNT/CANCEL_DELETION 字面不变
    expect(Object.values(SmsPurpose)).toEqual([
      'DELETE_ACCOUNT',
      'CANCEL_DELETION',
      'UNBIND_WECHAT',
    ]);
  });
});

describe('deletion-code.rules — HMAC-SHA256 hash (与 sms-code.store 同 hasher: base64url)', () => {
  it('确定性: 同 (code, secret) → 同 hash', () => {
    expect(hashDeletionCode('123456', SECRET)).toBe(hashDeletionCode('123456', SECRET));
  });

  it('码不同 → hash 不同', () => {
    expect(hashDeletionCode('123456', SECRET)).not.toBe(hashDeletionCode('654321', SECRET));
  });

  it('secret 不同 → hash 不同 (绑定 ADR-0023 secret)', () => {
    expect(hashDeletionCode('123456', SECRET)).not.toBe(hashDeletionCode('123456', 'other-secret'));
  });

  it('输出为 base64url 编码的 SHA-256 (43 字符, 无 padding), 入 VarChar(64)', () => {
    const h = hashDeletionCode('123456', SECRET);
    expect(h).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('deletion-code.rules — verifyDeletionCode (timing-safe compare)', () => {
  it('正确码 → true', () => {
    const stored = hashDeletionCode('246810', SECRET);
    expect(verifyDeletionCode('246810', stored, SECRET)).toBe(true);
  });

  it('错误码 → false', () => {
    const stored = hashDeletionCode('246810', SECRET);
    expect(verifyDeletionCode('999999', stored, SECRET)).toBe(false);
  });

  it('secret 不符 → false', () => {
    const stored = hashDeletionCode('246810', SECRET);
    expect(verifyDeletionCode('246810', stored, 'wrong-secret')).toBe(false);
  });

  it('畸形 stored hash (长度不符) → false 不抛', () => {
    expect(verifyDeletionCode('246810', 'short', SECRET)).toBe(false);
  });
});
