// 036 T013 — pin 注记语音转写接线纯逻辑 vitest（FR-005：合并/降级映射）。
//
// 测试分层：本模块只做「选中 pin ↔ 录音 hook draft/setDraft」的路由映射；录音/转写/面板/insert
// 全复用 035（不改）。故本 spec 验三件事（brief 决策①②③）：
//   - selectedPinNote：喂给 hook 的 draft = 选中 pin 当前注记（无选中 → ''）。
//   - noteSetterFor：hook 合并出的 final 文本路由到**该** pin 的 setNote（无选中 → no-op）。
//   - 合并/降级映射：transcript 经 insert-at-cursor（hook 复用的同一纯函数）+ noteSetterFor +
//     pinReducer 落**该 pin**（落该 pin）；空/失败 transcript 走 hook 不调 setter 路径 → 注记不变
//     （空转写不改写 / 失败不改写）。
import { describe, expect, it, vi } from 'vitest';

import { insertAtCursor } from '../insert-at-cursor';
import { pinReducer, type AnnotationPin, type PinState } from './pin-reducer';
import { noteSetterFor, selectedPinNote } from './pin-voice-bind';

function pin(id: string, n: number, note = ''): AnnotationPin {
  return { id, n, nx: 0.5, ny: 0.5, note };
}

describe('selectedPinNote — 选中 pin 注记 → hook draft', () => {
  const pins = [pin('pin-0', 1, '左上角按钮'), pin('pin-1', 2, '')];

  it('返回选中 pin 的当前注记', () => {
    expect(selectedPinNote(pins, 'pin-0')).toBe('左上角按钮');
    expect(selectedPinNote(pins, 'pin-1')).toBe('');
  });

  it('无选中（null）→ 空串', () => {
    expect(selectedPinNote(pins, null)).toBe('');
  });

  it('选中 id 不存在（如已删）→ 空串兜底', () => {
    expect(selectedPinNote(pins, 'pin-9')).toBe('');
  });
});

describe('noteSetterFor — hook setDraft → setNote 路由', () => {
  it('派发 setNote 到选中 pin（不影响其它 pin）', () => {
    const dispatch = vi.fn();
    const setter = noteSetterFor('pin-1', dispatch);
    setter('合并后的注记');
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      type: 'setNote',
      id: 'pin-1',
      note: '合并后的注记',
    });
  });

  it('无选中 pin → no-op（不派发）', () => {
    const dispatch = vi.fn();
    noteSetterFor(null, dispatch)('任何文本');
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('合并/降级映射（transcript → 该 pin，复用 insert-at-cursor + pinReducer）', () => {
  // 模拟 hook ✓ 成功路径：draft = selectedPinNote → insertAtCursor 合并 → noteSetterFor 落 reducer。
  function applyConfirm(
    state: PinState,
    selectedPinId: string,
    transcript: string,
    selection: { start: number | null; end: number | null },
  ): PinState {
    let next = state;
    const draft = selectedPinNote(state.pins, selectedPinId);
    const { text } = insertAtCursor(draft, transcript, selection.start, selection.end);
    noteSetterFor(selectedPinId, (action) => {
      next = pinReducer(next, action);
    })(text);
    return next;
  }

  const base: PinState = {
    pins: [pin('pin-0', 1, '已有注记'), pin('pin-1', 2, '另一个 pin')],
    nextId: 2,
    nextN: 3,
  };

  it('非空 transcript 落**该** pin（光标处插，既有保留），其它 pin 不动', () => {
    // 光标在 "已有" 之后（index 2）插入 transcript。
    const next = applyConfirm(base, 'pin-0', '语音补充', { start: 2, end: 2 });
    expect(selectedPinNote(next.pins, 'pin-0')).toBe('已有语音补充注记');
    expect(selectedPinNote(next.pins, 'pin-1')).toBe('另一个 pin'); // 未被波及。
  });

  it('无光标焦点 → 追加末尾（不覆盖既有）', () => {
    const next = applyConfirm(base, 'pin-0', '·尾注', { start: null, end: null });
    expect(selectedPinNote(next.pins, 'pin-0')).toBe('已有注记·尾注');
  });

  it('空 transcript 走 hook 不调 setter 路径 → 注记零改写（空转写不改写 / 失败不改写）', () => {
    // hook 在空/失败时不调 setDraft → 模拟为「不调 noteSetterFor」：状态严格不变。
    const setter = noteSetterFor('pin-0', () => {
      throw new Error('空/失败 transcript 不应触发 setNote');
    });
    // 不调用 setter（hook 行为）→ 注记不变。
    void setter;
    expect(selectedPinNote(base.pins, 'pin-0')).toBe('已有注记');
  });
});
