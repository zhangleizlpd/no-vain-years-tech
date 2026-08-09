// 036 T014 — 仅附图直发 send payload 组装（纯函数，无 IO，vitest=logic）。
//
// US3「仅附图直发」= 暂存原图**未进标注画布**（无 pin → 无 SoM 烧录图）+ 输入框文字 → 发送。
// 与 US1（标注烧录）的唯一差异：**无 annotationText**（没有 pin 注记），attachmentKeys = 原图
// 上传后的 ossKey（非烧录图）。多图顺序 = 缩略条顺序（FR-010）—— 调用方用 useIdeationImageUpload
// .uploadImages 顺序上传得到顺序一致的 keys，previewUris 同序取自缩略条 localUri（乐观回显）。
//
// 复用 T012 已通的 useIdeationSession.send(content, image) 链路，不新建发送路径：本函数只组 image
// 入参（attachmentKeys + previewUris，无 annotationText），交给同一 send。
import type { IdeationTurnImagePayload } from './ideation-stream-client';

/** send(content, image) 的 image 入参形态：带图字段 + 乐观回显 previewUris。 */
export type IdeationImageSendPayload = IdeationTurnImagePayload & { previewUris: string[] };

/**
 * 组「仅附图直发」send payload。复杂度 O(1)（仅组对象，不拷贝数组）。
 *
 * @param attachmentKeys 原图上传后的 ossKey（顺序 = 缩略条顺序，FR-010）。
 * @param previewUris 缩略条本地 uri（乐观回显，同序）。
 * @returns 非空 → `{ attachmentKeys, previewUris }`（**无** annotationText，无 pin 烧录）；
 *   attachmentKeys 为空 → `undefined`（退化为纯文本轮，行为零回归，由 send 走旧路径）。
 */
export function buildImageOnlySendPayload(
  attachmentKeys: string[],
  previewUris: string[],
): IdeationImageSendPayload | undefined {
  if (attachmentKeys.length === 0) return undefined;
  // 仅附图：无 annotationText（无 pin 注记）。顺序原样保留（调用方保证与缩略条一致）。
  return { attachmentKeys, previewUris };
}
