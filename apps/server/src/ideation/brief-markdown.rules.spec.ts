import { describe, it, expect } from 'vitest';
import { renderBriefMarkdown, T2_PLACEHOLDER } from './brief-markdown.rules';
import { briefSchema, type Brief } from './brief.schema';

/** T1 五段齐的最小合法 brief (过 zod)。 */
function fullT1(): Brief {
  return briefSchema.parse({
    problem: '行情页缺收藏',
    user_stories: 'P1 收藏股票',
    functional_requirements: 'FR-001 收藏/取消',
    success_criteria: 'SC-001 1 步可达',
    non_goals: '不做分组',
  });
}

describe('brief-markdown.rules / renderBriefMarkdown', () => {
  it('T1 齐 → 全 5 段标题 + 内容都渲', () => {
    const md = renderBriefMarkdown(fullT1());
    expect(md).toContain('## 问题 / 动机');
    expect(md).toContain('行情页缺收藏');
    expect(md).toContain('## 用户故事');
    expect(md).toContain('P1 收藏股票');
    expect(md).toContain('## 功能需求');
    expect(md).toContain('FR-001 收藏/取消');
    expect(md).toContain('## 成功标准');
    expect(md).toContain('## 非目标');
    expect(md).toContain('不做分组');
  });

  it('T2 空段 → 渲标题 + 占位行「_本期留空/手填_」(非报错)', () => {
    const md = renderBriefMarkdown(fullT1());
    expect(md).toContain('## 影响面');
    expect(md).toContain(T2_PLACEHOLDER);
    // 4 个 T2 段都应有占位行
    const placeholderCount = md.split(T2_PLACEHOLDER).length - 1;
    expect(placeholderCount).toBe(4);
  });

  it('T2 有内容 → 渲真内容，不渲占位行', () => {
    const md = renderBriefMarkdown(
      briefSchema.parse({ ...fullT1(), affected_surface: 'markets 屏 + WatchlistItem 表' }),
    );
    expect(md).toContain('markets 屏 + WatchlistItem 表');
    // affected_surface 段不应再有占位行 (其余 3 个 T2 仍占位)
    const placeholderCount = md.split(T2_PLACEHOLDER).length - 1;
    expect(placeholderCount).toBe(3);
  });

  it('T3 空 → 整段跳过 (标题都不出现)', () => {
    const md = renderBriefMarkdown(fullT1());
    expect(md).not.toContain('## 边界情况');
    expect(md).not.toContain('## 非功能需求');
    expect(md).not.toContain('## 待澄清');
    expect(md).not.toContain('## 阶段边界');
  });

  it('T3 有内容 → 该段渲 (标题 + 内容)，其余 T3 仍跳过', () => {
    const md = renderBriefMarkdown(briefSchema.parse({ ...fullT1(), edge_cases: '重复收藏幂等' }));
    expect(md).toContain('## 边界情况');
    expect(md).toContain('重复收藏幂等');
    expect(md).not.toContain('## 非功能需求'); // nfr 空仍跳
  });

  it('往返稳定：同一 JSON 渲两次结果一致', () => {
    const brief = briefSchema.parse({
      ...fullT1(),
      affected_surface: 'markets',
      edge_cases: '幂等',
    });
    expect(renderBriefMarkdown(brief)).toBe(renderBriefMarkdown(brief));
  });

  it('段顺序：T1 在 T2 之前，T2 在 T3 之前', () => {
    const md = renderBriefMarkdown(
      briefSchema.parse({ ...fullT1(), affected_surface: 'X', edge_cases: 'Y' }),
    );
    const idxT1 = md.indexOf('## 问题 / 动机');
    const idxT2 = md.indexOf('## 影响面');
    const idxT3 = md.indexOf('## 边界情况');
    expect(idxT1).toBeGreaterThanOrEqual(0);
    expect(idxT1).toBeLessThan(idxT2);
    expect(idxT2).toBeLessThan(idxT3);
  });

  it('输出以换行结尾 (稳定)', () => {
    expect(renderBriefMarkdown(fullT1()).endsWith('\n')).toBe(true);
  });
});
