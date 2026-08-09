// 035 T006 — final 合并插入纯逻辑单测（FR-010：空框 / 光标中段 / 无焦点 / 既有文本保留 /
// 选区替换 / 越界兜底）。
import { describe, expect, it } from 'vitest';
import { insertAtCursor } from './insert-at-cursor';

describe('insertAtCursor (T006 / FR-010)', () => {
  it('空输入框：插入即全文，光标落末尾', () => {
    expect(insertAtCursor('', '语音转写', 0, 0)).toEqual({ text: '语音转写', cursor: 4 });
  });

  it('光标中段插入：既有文本一律保留、不覆盖', () => {
    // "前后" 光标在「前」「后」之间（pos=1）→ 插入 "中"。
    expect(insertAtCursor('前后', '中', 1, 1)).toEqual({ text: '前中后', cursor: 2 });
  });

  it('无焦点（selection=null）→ 追加末尾，既有保留', () => {
    expect(insertAtCursor('已有文字', '追加', null)).toEqual({
      text: '已有文字追加',
      cursor: 6,
    });
  });

  it('无焦点（selection=undefined）→ 追加末尾', () => {
    expect(insertAtCursor('abc', 'XYZ')).toEqual({ text: 'abcXYZ', cursor: 6 });
  });

  it('光标在开头：插到最前，既有全保留', () => {
    expect(insertAtCursor('既有', '新', 0, 0)).toEqual({ text: '新既有', cursor: 1 });
  });

  it('光标在末尾：等同追加', () => {
    expect(insertAtCursor('已有', '尾', 2, 2)).toEqual({ text: '已有尾', cursor: 3 });
  });

  it('有选区：选中部分被插入文本替换（用户主动选区，非静默覆盖）', () => {
    // "abcXYZdef"，选区 [3,6) = "XYZ" → 替换为 "_"。
    expect(insertAtCursor('abcXYZdef', '_', 3, 6)).toEqual({ text: 'abc_def', cursor: 4 });
  });

  it('越界光标（start > len）→ 兜底追加末尾，不崩', () => {
    expect(insertAtCursor('abc', 'X', 99)).toEqual({ text: 'abcX', cursor: 4 });
  });

  it('负数光标 → 兜底追加末尾', () => {
    expect(insertAtCursor('abc', 'X', -1)).toEqual({ text: 'abcX', cursor: 4 });
  });

  it('selectionEnd < start（反序）→ 按单点光标处理（end 钳到 start）', () => {
    expect(insertAtCursor('abcdef', 'X', 3, 1)).toEqual({ text: 'abcXdef', cursor: 4 });
  });

  it('selectionEnd 越界（> len）→ 钳到末尾，替换到末尾', () => {
    expect(insertAtCursor('abcdef', 'X', 3, 99)).toEqual({ text: 'abcX', cursor: 4 });
  });
});
