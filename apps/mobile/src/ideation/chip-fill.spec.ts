// 032 T015 — chip 点选 → 草稿填充值纯函数（契约 §4.5：chip 不直接发送，先填入可编辑输入条）。
// 屏 render / 交互留 T017 e2e；本测覆盖 chipFillValue 纯逻辑（推荐标记剥离 / 逃生项清空）。
import { describe, expect, it } from 'vitest';

import { chipDisplayLabel, chipFillValue } from './clarify-chip.rules';

describe('chipFillValue（chip → 输入条草稿）', () => {
  it('普通项：原样填入 label', () => {
    expect(chipFillValue({ label: '实时流式刷新' })).toBe('实时流式刷新');
  });

  it('推荐项：剥离内嵌「（推荐）」标记，只填语义 label', () => {
    expect(chipFillValue({ label: '进页面拉一次（推荐）', recommended: true })).toBe(
      '进页面拉一次',
    );
  });

  it('推荐项：半角括号「(推荐)」同样剥离', () => {
    expect(chipFillValue({ label: '进页面拉一次(推荐)', recommended: true })).toBe('进页面拉一次');
  });

  it('逃生项（都不是 / 自己说）：清空草稿让用户自由输入', () => {
    expect(chipFillValue({ label: '都不是 / 自己说', escapeHatch: true })).toBe('');
  });

  it('逃生项优先于推荐：escapeHatch 命中即清空', () => {
    expect(chipFillValue({ label: '其它（推荐）', recommended: true, escapeHatch: true })).toBe('');
  });

  it('有 fill：填入完整正文而非短 label（采纳整段推荐 chip）', () => {
    expect(
      chipFillValue({
        label: '采纳（可再改）',
        recommended: true,
        fill: '1. 收藏准确率 100%\n2. 操作 ≤2 步\n3. 300ms 反馈',
      }),
    ).toBe('1. 收藏准确率 100%\n2. 操作 ≤2 步\n3. 300ms 反馈');
  });

  it('逃生项优先于 fill：escapeHatch 命中即清空', () => {
    expect(chipFillValue({ label: '我要改', escapeHatch: true, fill: '不该用的正文' })).toBe('');
  });

  it('空 fill：回退到 label（剥推荐标记）', () => {
    expect(chipFillValue({ label: '进页面拉一次（推荐）', recommended: true, fill: '' })).toBe(
      '进页面拉一次',
    );
  });
});

describe('chipDisplayLabel（chip 显示/a11y 干净 label）', () => {
  it('普通 label 原样', () => {
    expect(chipDisplayLabel({ label: '实时刷新' })).toBe('实时刷新');
  });

  it('剥内嵌「（推荐）」（存量数据防与渲染层叠成「（推荐）（推荐）」）', () => {
    expect(chipDisplayLabel({ label: '采纳（推荐）', recommended: true })).toBe('采纳');
    expect(chipDisplayLabel({ label: '进页面拉一次(推荐)', recommended: true })).toBe(
      '进页面拉一次',
    );
  });
});
