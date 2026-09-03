import { describe, expect, it } from 'vitest';
import { SEARCH_QUERY_MAX_LENGTH, escapeLike, normalizeSearchQuery } from './anchor-search.rules';

describe('normalizeSearchQuery — trim + 64 截断 + 空 → null (074 FR-009, plan D1)', () => {
  it('前后空白剥掉, 内容原样', () => {
    expect(normalizeSearchQuery('  腾讯  ')).toBe('腾讯');
    expect(normalizeSearchQuery('\tBRK.B\n')).toBe('BRK.B');
  });

  it('空串 / 纯空白串 → null (空输入是常态分支, 不是校验错误)', () => {
    expect(normalizeSearchQuery('')).toBeNull();
    expect(normalizeSearchQuery('   ')).toBeNull();
    expect(normalizeSearchQuery('\t\n')).toBeNull();
  });

  it(`截断恰在 ${SEARCH_QUERY_MAX_LENGTH}: 第 65 个字符起被丢弃, 第 64 个保留`, () => {
    const base63 = 'x'.repeat(63);
    // 恰好 64 → 原样; 65 → 截到 64 且内容 = 前 64 个字符。
    expect(normalizeSearchQuery(`${base63}A`)).toBe(`${base63}A`);
    expect(normalizeSearchQuery(`${base63}AB`)).toBe(`${base63}A`);
  });

  it('截断按字符数不按 UTF-16 code unit 数 (CJK 与 ASCII 同一口径)', () => {
    const cjk63 = '锚'.repeat(63);
    expect(normalizeSearchQuery(`${cjk63}腾讯`)).toBe(`${cjk63}腾`);
  });

  it('截断发生在 trim 之后 (前导空白不吃配额)', () => {
    const padded = `  ${'y'.repeat(SEARCH_QUERY_MAX_LENGTH)}`;
    expect(normalizeSearchQuery(padded)).toBe('y'.repeat(SEARCH_QUERY_MAX_LENGTH));
  });

  it('模糊匹配元字符原样通过 —— 转义是 escapeLike 的事, 不在归一化里做', () => {
    expect(normalizeSearchQuery('50%_off')).toBe('50%_off');
    expect(normalizeSearchQuery('hk:007')).toBe('hk:007');
  });
});

describe('escapeLike — LIKE 元字符字面化 (074 Edge「元字符字面」, plan D4)', () => {
  it('% 转义', () => {
    expect(escapeLike('%')).toBe('\\%');
    expect(escapeLike('50%')).toBe('50\\%');
  });

  it('_ 转义', () => {
    expect(escapeLike('_')).toBe('\\_');
    expect(escapeLike('a_b')).toBe('a\\_b');
  });

  it('\\ 转义', () => {
    expect(escapeLike('\\')).toBe('\\\\');
  });

  it('混合串逐字符各转一次', () => {
    expect(escapeLike('50%_off')).toBe('50\\%\\_off');
  });

  // 🚨 双重转义的典型病灶: 先转 % 再转 \, 会把刚插入的转义符自己再翻倍, % 反而裸奔。
  // 正确语义 = 单趟, 每个元字符恰好吃一个 \: `a\%b` (4 字符) → `a\\\%b` (6 字符)。
  it('已带反斜杠的串不被双重转义 (单趟, 每字符恰一次)', () => {
    expect(escapeLike('a\\%b')).toBe('a\\\\\\%b');
    expect(escapeLike('\\\\')).toBe('\\\\\\\\');
  });

  it('无元字符的串原样返回 (中文 / 代码 / 冒号都不该被碰)', () => {
    expect(escapeLike('腾讯')).toBe('腾讯');
    expect(escapeLike('BRK.B')).toBe('BRK.B');
    expect(escapeLike('hk:00700')).toBe('hk:00700');
  });
});
