// 027 T012 — chat-copy 纯逻辑单测（昵称回退 greeting()）。组件 render / 交互留 T013 e2e
// （per 测试分层 vitest=logic·Playwright=UI）。
import { describe, expect, it } from 'vitest';
import { greeting } from './chat-copy';

describe('greeting (FR-001 空态问候昵称回退)', () => {
  it('带昵称 → 「嗨 {昵称}，今天聊点什么」', () => {
    expect(greeting('登月者3766')).toBe('嗨 登月者3766，今天聊点什么');
  });

  it('null（/me 未就位）→ 通用问候，不显示空昵称', () => {
    expect(greeting(null)).toBe('嗨，今天聊点什么');
  });

  it('undefined（profile 缺字段）→ 通用问候', () => {
    expect(greeting(undefined)).toBe('嗨，今天聊点什么');
  });

  it('空串 → 通用问候', () => {
    expect(greeting('')).toBe('嗨，今天聊点什么');
  });

  it('纯空白 → 通用问候（不显示空昵称占位）', () => {
    expect(greeting('   ')).toBe('嗨，今天聊点什么');
  });

  it('两侧空白 → trim 后带昵称', () => {
    expect(greeting('  阿白  ')).toBe('嗨 阿白，今天聊点什么');
  });
});
