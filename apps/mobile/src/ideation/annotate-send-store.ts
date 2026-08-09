// 036 T015 — 标注画布 → 澄清对话屏「带图轮发送」跨屏交接 store（zustand，进程内非持久）。
//
// 为什么需要：标注画布（image-annotate）是 [id] 详情屏经 Stack push 的独立路由，与渲染对话的
// ClarifyChatScreen 不共享同一个 useIdeationSession 实例。标注完成（烧录 + 上传 + 合成文字）后
// 须把「带图轮 payload」交回 [id] 屏的 send 链路，才能让该轮进入既有澄清闭环 + user turn 缩略
// 回显。机制 = 模块级 store 暂存一笔 pending 发送（同 last-session-store zustand 范式）：
//   1. 标注屏 flatten → upload → compose → setPendingSend({ sessionId, ... }) → router.back()。
//   2. ClarifyChatScreen effect 监听：同会话 pending → onSend(annotationText, image) → clear()。
//
// 非持久（无 AsyncStorage）：交接是瞬态的（同一冷启会话内立即消费），不跨进程留存。带 sessionId
// 防串话（不同会话的残留 pending 不被误消费）。
import { create } from 'zustand';

/** 标注完成后待发送的带图轮 payload（交回 [id] 屏 send 链路）。 */
export interface PendingAnnotatedSend {
  /** 归属会话 id（消费方校验同会话，防串话）。 */
  sessionId: string;
  /** 烧录图上传后的 OSS key（带图轮 attachmentKeys）。 */
  attachmentKeys: string[];
  /** SoM 同编号合成标注文字（注入视觉模型 text part + user turn 文本）。 */
  annotationText: string;
  /** 烧录图本地 uri（user turn 乐观缩略回显）。 */
  previewUris: string[];
}

export interface AnnotateSendState {
  pending: PendingAnnotatedSend | null;
  setPendingSend: (p: PendingAnnotatedSend) => void;
  clearPendingSend: () => void;
}

export const useAnnotateSendStore = create<AnnotateSendState>()((set) => ({
  pending: null,
  setPendingSend: (p) => set({ pending: p }),
  clearPendingSend: () => set({ pending: null }),
}));
