// 036 T012 — SoM 合成标注文字（纯函数，无 IO，vitest=logic）。
//
// 发送带图轮时，把「有注记的 pin」按编号合成一段 annotationText（注入视觉模型 text part，
// 与烧录图上的编号 overlay 同编号 1:1，FR-006 严格 1:1）。
//
// 🚨 FR-006 严格 1:1：仅纳入**有注记**（note trim 后非空）的 pin —— 空 pin 既不烧录进图
// （som-flatten 据 pinsWithNotes 决定烧哪些编号），也不计入合成文字。编号沿用 pin.n（不重排、
// 不压缩），保证烧录图 overlay 编号与文字编号严格对应。全空 → 空串（调用方据此不附 annotationText，
// 退化为「仅附图」由 T014 管）。复杂度 O(n log n)（按 n 排序，n ≤ 9 软上限）。
import type { AnnotationPin } from './pin-reducer';

/** 有注记（note trim 后非空）的 pin，按展示编号 n 升序（与烧录图 overlay 编号 1:1）。 */
export function pinsWithNotes(pins: AnnotationPin[]): AnnotationPin[] {
  return pins.filter((p) => p.note.trim().length > 0).sort((a, b) => a.n - b.n);
}

/**
 * 按编号顺序合成 annotationText（「n：note」逐行）。仅纳入有注记的 pin（FR-006），编号沿用 pin.n。
 * 全空 / 无 pin → 空串（调用方据此判定无 annotation，不附 annotationText）。
 */
export function composeAnnotationText(pins: AnnotationPin[]): string {
  return pinsWithNotes(pins)
    .map((p) => `${p.n}：${p.note.trim()}`)
    .join('\n');
}
