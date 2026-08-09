// 035 T006 — final transcript 合并插入纯函数（FR-010，无状态、无 IO，vitest=logic 层）。
//
// 语义（spec FR-010 + Clarifications Q）：final transcript 落入输入框时插入**当前光标处**；
// 无光标焦点（selection 缺省/越界）→ 追加到**末尾**；既有文本一律保留、绝不静默覆盖。
//
// 录音中输入框 editable=false（partial 机器写入态）；松手 final 调用本函数原地合并为可编辑。
// 取消/静音空 final 不调用本函数（由调用方分流，本函数只负责「有 final 文本时如何合并」）。

/** 合并结果：新文本 + 插入后光标应落的位置（caret = 插入文本之后）。 */
export interface InsertAtCursorResult {
  /** 合并后的完整文本。 */
  text: string;
  /** 插入后新光标位置（= 插入起点 + 插入文本长度），供调用方设回 selection。 */
  cursor: number;
}

/**
 * 把 insertText 插入 existing 的光标处（无焦点追加末尾），既有文本保留。复杂度 O(n)，
 * n = existing 长度（字符串切片拼接线性）。
 *
 * @param existing 输入框现有文本（用户手敲 + 之前的 final，可能为空）。
 * @param insertText 待插入的 final transcript（调用方保证非空；空串由上层按静音分流）。
 * @param selectionStart 光标起点（无焦点传 null/undefined → 末尾）。RN TextInput
 *   selection 的 start。
 * @param selectionEnd 光标终点（有选区时 > start，选区文本被替换）。缺省 = selectionStart
 *   （单点光标无选区）。
 */
export function insertAtCursor(
  existing: string,
  insertText: string,
  selectionStart?: number | null,
  selectionEnd?: number | null,
): InsertAtCursorResult {
  // 无焦点 / 非法光标 → 追加末尾（既有文本全保留）。
  if (
    selectionStart === null ||
    selectionStart === undefined ||
    selectionStart < 0 ||
    selectionStart > existing.length
  ) {
    return { text: existing + insertText, cursor: existing.length + insertText.length };
  }

  // 选区终点：缺省 = 单点光标；钳制到 [start, len] 防越界（选区文本被替换，仍非「静默覆盖
  // 既有」—— 用户主动选中的部分替换是预期编辑行为）。
  const start = selectionStart;
  const rawEnd = selectionEnd ?? start;
  const end = Math.min(Math.max(rawEnd, start), existing.length);

  const before = existing.slice(0, start);
  const after = existing.slice(end);
  return { text: before + insertText + after, cursor: start + insertText.length };
}
