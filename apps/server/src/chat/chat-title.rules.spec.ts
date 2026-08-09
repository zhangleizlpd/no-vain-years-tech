import { describe, it, expect } from 'vitest';
import { deriveTitle, TITLE_MAX_LEN, EMPTY_TITLE_FALLBACK } from './chat-title.rules';

describe('chat-title.rules', () => {
  describe('TITLE_MAX_LEN', () => {
    it('是正整数', () => {
      expect(Number.isInteger(TITLE_MAX_LEN)).toBe(true);
      expect(TITLE_MAX_LEN).toBeGreaterThan(0);
    });
  });

  describe('deriveTitle', () => {
    it('正常短消息: 原样返回 (trim 后未超长)', () => {
      expect(deriveTitle('帮我写一段代码')).toBe('帮我写一段代码');
    });

    it('超长: 截前 TITLE_MAX_LEN 字', () => {
      const long = '一'.repeat(TITLE_MAX_LEN + 10);
      const out = deriveTitle(long);
      expect(out).toBe('一'.repeat(TITLE_MAX_LEN));
      expect([...out].length).toBe(TITLE_MAX_LEN);
    });

    it('含换行: 折叠为空格 (单行标题)', () => {
      expect(deriveTitle('第一行\n第二行')).toBe('第一行 第二行');
    });

    it('含回车换行 + 多空白: 折叠并 trim', () => {
      expect(deriveTitle('  你好\r\n\t世界  ')).toBe('你好 世界');
    });

    it('空串 → 兜底「新对话」', () => {
      expect(deriveTitle('')).toBe(EMPTY_TITLE_FALLBACK);
    });

    it('纯空白 → 兜底「新对话」', () => {
      expect(deriveTitle('   \n\t  ')).toBe(EMPTY_TITLE_FALLBACK);
    });

    it('换行 + 超长: 先折叠去换行再截断', () => {
      const long = '甲\n' + '乙'.repeat(TITLE_MAX_LEN + 5);
      const out = deriveTitle(long);
      expect([...out].length).toBe(TITLE_MAX_LEN);
      expect(out.startsWith('甲 乙')).toBe(true);
    });
  });
});
