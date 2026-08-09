import { describe, it, expect } from 'vitest';
import {
  buildContext,
  estimateTokens,
  DEFAULT_CONTEXT_BUDGET,
  type Msg,
} from './chat-context.rules';

const user = (content: string): Msg => ({ role: 'user', content });
const assistant = (content: string): Msg => ({ role: 'assistant', content });

describe('chat-context.rules', () => {
  describe('DEFAULT_CONTEXT_BUDGET', () => {
    it('是保守正整数 (留足输出余量)', () => {
      expect(Number.isInteger(DEFAULT_CONTEXT_BUDGET)).toBe(true);
      expect(DEFAULT_CONTEXT_BUDGET).toBeGreaterThan(0);
    });
  });

  describe('estimateTokens (字符启发式 ~1.5 char/token)', () => {
    it('空串 → 0', () => {
      expect(estimateTokens('')).toBe(0);
    });
    it('3 字符 → ceil(3/1.5) = 2', () => {
      expect(estimateTokens('abc')).toBe(2);
    });
    it('中文 6 字 → ceil(6/1.5) = 4', () => {
      expect(estimateTokens('你好世界再见')).toBe(4);
    });
  });

  describe('buildContext', () => {
    it('空历史 → 空数组', () => {
      expect(buildContext([], DEFAULT_CONTEXT_BUDGET)).toEqual([]);
    });

    it('单轮原样返回 (在 budget 内)', () => {
      const history = [user('你好')];
      expect(buildContext(history, DEFAULT_CONTEXT_BUDGET)).toEqual(history);
    });

    it('全部在 budget 内 → 原样保序返回', () => {
      const history = [user('一'), assistant('二'), user('三')];
      const out = buildContext(history, DEFAULT_CONTEXT_BUDGET);
      expect(out).toEqual(history);
    });

    it('超长截断: 保留最新 N 轮, 丢最早, 且保持时间序', () => {
      // 每条 content 估 token = ceil(6/1.5) = 4。budget=8 只容 2 条。
      const m1 = user('AAAAAA');
      const m2 = assistant('BBBBBB');
      const m3 = user('CCCCCC');
      const out = buildContext([m1, m2, m3], 8);
      expect(out).toEqual([m2, m3]); // 丢最早 m1, 保留最新 2 条, 时间序
    });

    it('budget 边界: 恰好等于累加和 → 全保留 (<= budget 含等号)', () => {
      // 两条各 4 token, 累加 8, budget=8 恰好容纳。
      const m1 = user('AAAAAA');
      const m2 = assistant('BBBBBB');
      expect(buildContext([m1, m2], 8)).toEqual([m1, m2]);
    });

    it('budget 边界: 差 1 token → 丢最早一条', () => {
      const m1 = user('AAAAAA');
      const m2 = assistant('BBBBBB');
      expect(buildContext([m1, m2], 7)).toEqual([m2]);
    });

    it('最新一条单独就超 budget → 仍至少保留最新一条 (不返空, 否则无法发送)', () => {
      const m1 = user('AA');
      const m2 = assistant('BBBBBBBBBB'); // 估 ceil(10/1.5)=7 token
      expect(buildContext([m1, m2], 3)).toEqual([m2]);
    });
  });
});
