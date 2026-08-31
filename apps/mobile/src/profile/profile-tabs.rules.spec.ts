import { describe, expect, it } from 'vitest';

import {
  defaultProfileTab,
  resolveActiveProfileTab,
  visibleProfileTabs,
} from './profile-tabs.rules';

// 072 T015 —「我的」三栏可见性（FR-011 / sb-19 / sb-20 / US6）。
// logic-only：渲染 / sticky 索引 / 深链重定向归 T016 与 markets-feature-gate e2e
// （per mono 测试分层：vitest 只测判定，UI 归 Playwright）。
//
// 用例照 spec 写，不照实现写：markets×isAdmin 四象限逐个点名，
// 「markets off ∧ admin」是合规判据的唯一分辨点 —— 只测 admin 维度的话，
// 一个漏判 marketsEnabled 的实现照样全绿。

describe('visibleProfileTabs — markets × isAdmin 四象限（sb-19 / sb-20）', () => {
  it('markets on ∧ admin → 三栏全出，顺序为 审批 → 消息 → 知识库', () => {
    expect(visibleProfileTabs({ marketsEnabled: true, isAdmin: true })).toEqual([
      'review',
      'messages',
      'kb',
    ]);
  });

  it('markets on ∧ 非 admin → 审批栏不渲染，消息与知识库照出（sb-20）', () => {
    expect(visibleProfileTabs({ marketsEnabled: true, isAdmin: false })).toEqual([
      'messages',
      'kb',
    ]);
  });

  it('markets off ∧ admin → 审批与消息**两栏都不渲染** —— 合规闸在权限之上（sb-19）', () => {
    expect(visibleProfileTabs({ marketsEnabled: false, isAdmin: true })).toEqual(['kb']);
  });

  it('markets off ∧ 非 admin → 只剩知识库', () => {
    expect(visibleProfileTabs({ marketsEnabled: false, isAdmin: false })).toEqual(['kb']);
  });

  it('isAdmin 未知（/me 未落地的冷启动那一瞬）→ 按非 admin 渲染，fail-closed（sb-20）', () => {
    expect(visibleProfileTabs({ marketsEnabled: true, isAdmin: undefined })).toEqual([
      'messages',
      'kb',
    ]);
    expect(visibleProfileTabs({ marketsEnabled: true, isAdmin: null })).toEqual(['messages', 'kb']);
  });

  it('知识库在四象限里恒可见 ⇒ 可见集合恒非空，默认栏永远解得出', () => {
    for (const marketsEnabled of [true, false]) {
      for (const isAdmin of [true, false]) {
        expect(visibleProfileTabs({ marketsEnabled, isAdmin })).toContain('kb');
      }
    }
  });
});

describe('defaultProfileTab — 默认栏 = 可见集合的第一项', () => {
  it('admin 进来落在审批栏（他是唯一有活要干的人）', () => {
    expect(defaultProfileTab({ marketsEnabled: true, isAdmin: true })).toBe('review');
  });

  it('非 admin 落在消息栏', () => {
    expect(defaultProfileTab({ marketsEnabled: true, isAdmin: false })).toBe('messages');
  });

  it('markets off 落在知识库 —— 公开构建里它是唯一一栏', () => {
    expect(defaultProfileTab({ marketsEnabled: false, isAdmin: true })).toBe('kb');
    expect(defaultProfileTab({ marketsEnabled: false, isAdmin: false })).toBe('kb');
  });
});

describe('resolveActiveProfileTab — 渲染期派生，不靠 useEffect 纠偏', () => {
  it('没选过（首帧）→ 默认栏', () => {
    expect(resolveActiveProfileTab(null, ['review', 'messages', 'kb'])).toBe('review');
  });

  it('选中的栏仍可见 → 原样保留，不被默认栏抢回去', () => {
    expect(resolveActiveProfileTab('kb', ['review', 'messages', 'kb'])).toBe('kb');
    expect(resolveActiveProfileTab('messages', ['messages', 'kb'])).toBe('messages');
  });

  it('停在审批栏时 isAdmin 翻 false（/me 落地纠正冷启动种子）→ 当帧就回落，不多渲一帧管理面', () => {
    expect(resolveActiveProfileTab('review', ['messages', 'kb'])).toBe('messages');
  });

  it('markets off 下即便选中态是消息 → 回落知识库（sb-19 不留后门）', () => {
    expect(resolveActiveProfileTab('messages', ['kb'])).toBe('kb');
  });
});
