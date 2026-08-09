import { describe, expect, it } from 'vitest';

import { isAllSelected, toggleSelectAll, toggleSelection } from './alert-selection';

describe('toggleSelection — 单项翻选（FR-M05）', () => {
  it('未选中 → 加入；原集不变（不可变）', () => {
    const prev = new Set(['a']);
    const next = toggleSelection(prev, 'b');
    expect([...next].sort()).toEqual(['a', 'b']);
    expect([...prev]).toEqual(['a']);
  });

  it('已选中 → 剔除', () => {
    expect([...toggleSelection(new Set(['a', 'b']), 'a')]).toEqual(['b']);
  });
});

describe('isAllSelected — 全选态判定', () => {
  it('全部命中 → true', () => {
    expect(isAllSelected(new Set(['a', 'b']), ['a', 'b'])).toBe(true);
  });

  it('部分命中 / 空选 → false', () => {
    expect(isAllSelected(new Set(['a']), ['a', 'b'])).toBe(false);
    expect(isAllSelected(new Set(), ['a'])).toBe(false);
  });

  it('空列表恒 false（删除保持 disabled）', () => {
    expect(isAllSelected(new Set(), [])).toBe(false);
    expect(isAllSelected(new Set(['ghost']), [])).toBe(false);
  });
});

describe('toggleSelectAll — 全选翻转（mockup DeleteFooter）', () => {
  it('未全选 → 全选', () => {
    expect([...toggleSelectAll(new Set(['a']), ['a', 'b'])].sort()).toEqual(['a', 'b']);
  });

  it('已全选 → 清空', () => {
    expect(toggleSelectAll(new Set(['a', 'b']), ['a', 'b']).size).toBe(0);
  });

  it('选中集含已删残留 id → 重置为当前列表全集', () => {
    expect([...toggleSelectAll(new Set(['gone']), ['a'])]).toEqual(['a']);
  });
});
