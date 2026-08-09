// 036 T013 — pin 注记语音转写「接线」纯逻辑（无 IO、无副作用，vitest=logic）。
//
// 035 录音 hook（useIdeationRecording）是「单注记框（draft/setDraft）」范式：✓ 后 transcript
// 经 insert-at-cursor 合并 → setDraft。本模块把它映射到「当前 selected pin 的注记框」上（多 pin
// 各一框，哪个 selected 录哪个，brief 决策⑤）：
//   - draft  = 选中 pin 当前注记（selectedPinNote；无选中 → ''）
//   - setDraft(merged) → setNote 派发到选中 pin（noteSetterFor；无选中 → no-op）
// 「不覆盖 + 光标处插/末尾追加」由 hook 内部复用的 insert-at-cursor 保证（本层不重实现，复用
// 035 不改，brief 决策①②）；「空转写/失败不改写」由 hook 失败/静音路径**不调 setDraft** 实现
// —— 选中 pin 注记保持不变（noteSetterFor 仅在「有 final 文本」时被调，brief 决策③）。
import type { AnnotationPin, PinAction } from './pin-reducer';

/** 选中 pin 的当前注记（喂给录音 hook 的 draft）。无选中 / 找不到 → 空串。 */
export function selectedPinNote(pins: AnnotationPin[], selectedPinId: string | null): string {
  if (selectedPinId === null) return '';
  return pins.find((p) => p.id === selectedPinId)?.note ?? '';
}

/**
 * 录音 hook 合并回调（setDraft）→ setNote 派发器：把 hook 合并出的整段注记路由到选中 pin。
 * 无选中 pin → 返回 no-op（录音面板本只在选中 pin 上开，防御性兜底）。复杂度 O(1)（派发构造）。
 */
export function noteSetterFor(
  selectedPinId: string | null,
  dispatch: (action: PinAction) => void,
): (note: string) => void {
  if (selectedPinId === null) return noopNoteSetter;
  return (note: string) => dispatch({ type: 'setNote', id: selectedPinId, note });
}

/** 无选中 pin 时的 no-op setter（录音面板本只在选中 pin 上开，此为防御性兜底）。 */
function noopNoteSetter(_note: string): void {
  /* 无选中 pin → 不派发 setNote（不改任何注记）。 */
}
