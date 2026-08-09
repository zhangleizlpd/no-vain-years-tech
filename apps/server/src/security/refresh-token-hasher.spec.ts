import { describe, it, expect } from 'vitest';
import { hashRefreshToken } from './refresh-token-hasher';

describe('hashRefreshToken', () => {
  it('同输入稳定 (deterministic — 查找靠哈希命中唯一索引)', () => {
    expect(hashRefreshToken('a-256-bit-token')).toBe(hashRefreshToken('a-256-bit-token'));
  });

  it('输出 64 字符小写 hex (无大写; 与 DB token_hash CHAR(64) 对齐)', () => {
    expect(hashRefreshToken('whatever')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('不同输入 → 不同哈希', () => {
    expect(hashRefreshToken('token-a')).not.toBe(hashRefreshToken('token-b'));
  });

  it('匹配已知 SHA-256 向量 (sha256 of empty string)', () => {
    expect(hashRefreshToken('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
