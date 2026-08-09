import { describe, it, expect } from 'vitest';
import {
  decodeDeviceName,
  isActive,
  normalizeDeviceType,
  scrubPrivateIp,
  ACCESS_TTL_MIN,
  REFRESH_TTL_DAYS,
} from './refresh-token.rules';

const NOW = new Date('2026-05-25T12:00:00Z');
const future = new Date(NOW.getTime() + 60_000);
const past = new Date(NOW.getTime() - 60_000);

describe('refresh-token.rules', () => {
  it('常量与 JwtModule 单一来源对齐 (access 15min / refresh 30d)', () => {
    expect(ACCESS_TTL_MIN).toBe(15);
    expect(REFRESH_TTL_DAYS).toBe(30);
  });

  describe('isActive (now 注入)', () => {
    it.each([
      ['active: 未撤销 + 未过期', { revokedAt: null, expiresAt: future }, true],
      ['expired: 未撤销 + 已过期', { revokedAt: null, expiresAt: past }, false],
      ['revoked: 已撤销 + 未过期', { revokedAt: past, expiresAt: future }, false],
      ['revoked + expired', { revokedAt: past, expiresAt: past }, false],
      ['过期边界 expiresAt===now → 非 active (严格 >)', { revokedAt: null, expiresAt: NOW }, false],
    ] as const)('%s', (_label, rec, expected) => {
      expect(isActive(rec, NOW)).toBe(expected);
    });
  });

  describe('normalizeDeviceType (→ UPPERCASE 与 DB default 对齐)', () => {
    it.each([
      ['phone', 'PHONE'],
      ['Phone', 'PHONE'],
      ['MOBILE', 'PHONE'],
      ['tablet', 'TABLET'],
      ['desktop', 'DESKTOP'],
      ['web', 'WEB'],
      ['browser', 'WEB'],
      ['  Web  ', 'WEB'],
      ['garbage', 'UNKNOWN'],
      ['', 'UNKNOWN'],
      [null, 'UNKNOWN'],
      [undefined, 'UNKNOWN'],
    ])('%s → %s', (raw, expected) => {
      expect(normalizeDeviceType(raw)).toBe(expected);
    });
  });

  describe('scrubPrivateIp (私网/回环/链路本地/非法 → null; 公网 → 原样)', () => {
    it.each([
      ['10.0.0.5', null],
      ['172.16.0.1', null],
      ['172.31.255.255', null],
      ['192.168.1.100', null],
      ['127.0.0.1', null],
      ['169.254.10.1', null],
      ['::1', null],
      ['fe80::1', null],
      ['fc00::1', null],
      ['fd12:3456::1', null],
      ['::ffff:192.168.0.1', null],
      ['8.8.8.8', '8.8.8.8'],
      ['172.32.0.1', '172.32.0.1'],
      ['203.0.113.5', '203.0.113.5'],
      ['2001:4860:4860::8888', '2001:4860:4860::8888'],
      ['', null],
      ['not-an-ip', null],
      [null, null],
      [undefined, null],
    ])('%s → %s', (ip, expected) => {
      expect(scrubPrivateIp(ip)).toBe(expected);
    });
  });

  describe('decodeDeviceName (解 transport URL 编码 → 规范展示值)', () => {
    it.each([
      ['Web%20-%20Mozilla%2F5.0', 'Web - Mozilla/5.0'],
      ['iPhone%2015%20Pro', 'iPhone 15 Pro'],
      ['%E5%B0%8F%E6%98%8E%E7%9A%84%20iPad', '小明的 iPad'],
      ['plain-name', 'plain-name'],
      ['  Web%20App  ', 'Web App'],
      // 截断的转义序列 (header 长度上限切断 %XX) → 回退原始串而非抛
      ['Web%2', 'Web%2'],
      ['', null],
      ['   ', null],
      [null, null],
      [undefined, null],
    ])('%s → %s', (raw, expected) => {
      expect(decodeDeviceName(raw)).toBe(expected);
    });
  });
});
