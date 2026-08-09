// 032 T016 — brief 预览屏纯渲染数据准备（分段视图 / 状态徽标）vitest。
// 屏 render / 复制交互留 T017 e2e；本测覆盖 buildBriefSegments + STATUS_BADGE_META 纯逻辑。
import { describe, expect, it } from 'vitest';

import { buildBriefSegments, normalizeStatus, STATUS_BADGE_META } from './brief-view.rules';

const FULL_T1 = {
  problem: '用户缺少固定入口',
  user_stories: 'P1 作为用户...\nGiven... When... Then...',
  functional_requirements: 'FR-001 提供收藏切换',
  success_criteria: '上线 4 周 30% 收藏',
  non_goals: '不做板块收藏',
};

describe('buildBriefSegments（结构化分段，非 markdown 源码）', () => {
  it('T1 五段全渲（恒入列，内容非占位）', () => {
    const views = buildBriefSegments(FULL_T1);
    const t1 = views.filter((v) => v.tier === 't1');
    expect(t1).toHaveLength(5);
    expect(t1.every((v) => !v.isPlaceholder)).toBe(true);
    expect(t1.map((v) => v.key)).toEqual([
      'problem',
      'user_stories',
      'functional_requirements',
      'success_criteria',
      'non_goals',
    ]);
  });

  it('T2 接地段空 → 灰虚线占位（非阻塞，恒入列且 isPlaceholder）', () => {
    const views = buildBriefSegments(FULL_T1);
    const t2 = views.filter((v) => v.tier === 't2');
    expect(t2).toHaveLength(4);
    expect(t2.every((v) => v.isPlaceholder && v.content === '')).toBe(true);
  });

  it('T2 段有内容 → 正常渲（非占位）', () => {
    const views = buildBriefSegments({ ...FULL_T1, affected_surface: 'apps/mobile/src/portfolio' });
    const affected = views.find((v) => v.key === 'affected_surface');
    expect(affected?.isPlaceholder).toBe(false);
    expect(affected?.content).toBe('apps/mobile/src/portfolio');
  });

  it('T3 可选段空 → 整段跳（小颗粒自适应不入列）', () => {
    const views = buildBriefSegments(FULL_T1);
    expect(views.some((v) => v.tier === 't3')).toBe(false);
  });

  it('T3 段有内容 → 入列淡化渲', () => {
    const views = buildBriefSegments({ ...FULL_T1, open_questions: '收藏上限是否二期细化?' });
    const oq = views.find((v) => v.key === 'open_questions');
    expect(oq?.tier).toBe('t3');
    expect(oq?.content).toBe('收藏上限是否二期细化?');
  });

  it('非 string / null 段 → 当空处理（防御 briefJson 宽松类型）', () => {
    const views = buildBriefSegments({ ...FULL_T1, problem: null as unknown as string });
    const problem = views.find((v) => v.key === 'problem');
    expect(problem?.content).toBe('');
  });

  it('content trim：前后空白裁掉', () => {
    const views = buildBriefSegments({ ...FULL_T1, non_goals: '  不做分组  ' });
    expect(views.find((v) => v.key === 'non_goals')?.content).toBe('不做分组');
  });
});

describe('STATUS_BADGE_META + normalizeStatus（徽标穷举映射）', () => {
  it('三态穷举映射齐全', () => {
    expect(STATUS_BADGE_META.open.label).toBe('进行中');
    expect(STATUS_BADGE_META.converged.label).toBe('已收敛');
    expect(STATUS_BADGE_META['handed-off'].label).toBe('已交接');
  });

  it('normalizeStatus：已知态透传 / 未知态 → open 兜底', () => {
    expect(normalizeStatus('converged')).toBe('converged');
    expect(normalizeStatus('handed-off')).toBe('handed-off');
    expect(normalizeStatus('open')).toBe('open');
    expect(normalizeStatus('garbage')).toBe('open');
  });
});
