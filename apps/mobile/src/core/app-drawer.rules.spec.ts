import { describe, expect, it } from 'vitest';

import { headerLeadingFor, nextDrawerOpenOnAppState } from './app-drawer.rules';

// 045 T021 — 全局抽屉两条纯判定（FR-023 / FR-024 / EC-16 / EC-17）。
// logic-only：render / 手势 / 遮罩层级归 T025 Playwright e2e（per mono 测试分层）。

describe('headerLeadingFor — 题头 leading 三态（FR-023 / FR-024 / EC-17）', () => {
  it('一级 tab 屏 → 汉堡（首页 / 期权台 / 投资 / 我的 四屏一致）', () => {
    expect(headerLeadingFor(['(app)', '(tabs)'])).toBe('hamburger');
    expect(headerLeadingFor(['(app)', '(tabs)', 'index'])).toBe('hamburger');
    expect(headerLeadingFor(['(app)', '(tabs)', 'optionsdesk'])).toBe('hamburger');
    expect(headerLeadingFor(['(app)', '(tabs)', 'portfolio'])).toBe('hamburger');
    expect(headerLeadingFor(['(app)', '(tabs)', 'profile'])).toBe('hamburger');
  });

  it('二级页（(tabs) 之外的兄弟栈）→ 返回箭头，不渲汉堡', () => {
    expect(headerLeadingFor(['(app)', 'settings'])).toBe('back');
    expect(headerLeadingFor(['(app)', 'optionsdesk', 'anchors'])).toBe('back');
    expect(headerLeadingFor(['(app)', 'portfolio', 'holdings'])).toBe('back');
    expect(headerLeadingFor(['(app)', 'alert', '[symbol]'])).toBe('back');
  });

  it('灵感列表（(tabs) 内的嵌套 stack 根）→ 返回箭头 —— 045 起它不占 tab 槽、由抽屉进入', () => {
    expect(headerLeadingFor(['(app)', '(tabs)', 'ideation'])).toBe('back');
  });

  it('EC-17 灵感全屏子屏（详情 / 图片查看 / 图片标注）→ 都不渲染（无悬空汉堡、无双返回）', () => {
    expect(headerLeadingFor(['(app)', '(tabs)', 'ideation', '[id]'])).toBe('none');
    expect(headerLeadingFor(['(app)', '(tabs)', 'ideation', 'image-viewer'])).toBe('none');
    expect(headerLeadingFor(['(app)', '(tabs)', 'ideation', 'image-annotate'])).toBe('none');
  });

  it('灵感的非全屏子屏（mockups，自带 navigator 返回）→ 返回箭头而非 none', () => {
    expect(headerLeadingFor(['(app)', '(tabs)', 'ideation', 'mockups'])).toBe('back');
  });
});

describe('nextDrawerOpenOnAppState — EC-16 切后台即关（状态确定，无半开残留）', () => {
  it('开着时切后台 / 转 inactive → 关（回前台一定是关的确定态）', () => {
    expect(nextDrawerOpenOnAppState(true, 'background')).toBe(false);
    expect(nextDrawerOpenOnAppState(true, 'inactive')).toBe(false);
  });

  it('关着时切后台 → 仍关（幂等）', () => {
    expect(nextDrawerOpenOnAppState(false, 'background')).toBe(false);
  });

  it('回到 active 本身不改变开关态 —— 关是在切走那一刻发生的，不是回来时才补', () => {
    expect(nextDrawerOpenOnAppState(false, 'active')).toBe(false);
    expect(nextDrawerOpenOnAppState(true, 'active')).toBe(true);
  });

  it('后台 → 前台整条往返后必为关（EC-16 唯一可预期终态）', () => {
    const afterBackground = nextDrawerOpenOnAppState(true, 'background');
    expect(nextDrawerOpenOnAppState(afterBackground, 'active')).toBe(false);
  });
});
