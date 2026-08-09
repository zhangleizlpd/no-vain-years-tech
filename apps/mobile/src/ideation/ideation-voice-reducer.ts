// 035 T006 — ideation 语音录音态机纯 reducer（一次性文件识别；无 IO、无副作用，vitest=logic）。
//
// 设计（同 032 ideation-reducer / 027 chat-reducer 分层）：副作用（nitro 起录/停录、metering
// 喂波形、权限申请、文件上传转写、insert-at-cursor 回填、60s 计时、降级 toast）与纯态转换分层
// —— 本文件只做 (state, action) → state 的纯转换；use-ideation-recording 是薄壳，把点击（mic /
// ✓ / ✗）+ 权限结果 + 上传结果（成功/空/失败）+ 中断（后台/离屏）翻成 dispatch 并据态发起副作用。
//
// 🚨 交互范式翻案（06-24 Replan）：从「长按 push-to-talk + 实时 partial + 下滑取消」改为
//    「点 mic → 录音面板（波形 + ✓/✗）→ ✓ 整段一次性识别 → 回填可编辑框」。故删 cancel-armed /
//    finalizing 态与 drag 语义；新增 processing（上传转写中）/ filled（转写成功已回填）态。
//
// 态机 6 态：
//   idle            空闲（mic 待命，面板关）
//   requesting-perm 申请麦克风权限中（首次点 mic；允许 → recording，拒绝 → idle + 去设置 toast）
//   recording       录音中（面板开：波形随 metering 起伏 + ✓ 确认 / ✗ 取消）
//   processing      ✓ 后停录、整段上传 DashScope 一次性识别中（spinner）
//   filled          转写成功、文本经 insert-at-cursor 回填可编辑框（面板关，成功终态）
//   error           转写失败（上传/识别异常）→ 丢弃本段、不阻断会话（FR-009）
//
// 🚨 取消语义（FR-005 改 ✗ 按钮）：recording 态点 ✗ = cancel → idle（零副作用，草稿不动）。
// 🚨 中断语义（FR-015）：录音中/处理中切后台/离屏 = cancel（丢弃本段；目标输入框可能已不在场）。
// 🚨 静音空转写：processing 收到空 transcript = empty → idle（不回填，给「未识别到语音」轻提示）。
// 🚨 60s 上限（FR-008）：client 计时到 60s 主动 confirm（等同点 ✓，停录走识别路径）。

/** 录音态机 6 态。 */
export type VoiceStatus =
  | 'idle'
  | 'requesting-perm'
  | 'recording'
  | 'processing'
  | 'filled'
  | 'error';

export interface VoiceState {
  status: VoiceStatus;
  /** 当前 error 文案 reason（status==='error' 时有值），否则 null。降级 toast 文案由 T007 据此映射。 */
  errorReason: string | null;
}

export const initialVoiceState: VoiceState = {
  status: 'idle',
  errorReason: null,
};

export type VoiceAction =
  // 点 mic（首次）→ 申请权限。流式态 / 录音中由调用方先把关（不 dispatch）。
  | { type: 'request-perm' }
  // 权限允许 → 进录音。
  | { type: 'perm-granted' }
  // 权限拒绝 → 回 idle（调用方落去设置 toast）。
  | { type: 'perm-denied' }
  // 已有权限直接起录（非首次点 mic）。
  | { type: 'start' }
  // 点 ✓ / 60s 上限 → 停录、整段上传识别（进 processing）。
  | { type: 'confirm' }
  // 点 ✗ / 后台 / 离屏中断 → 丢弃本段回 idle（零副作用，草稿不动）。
  | { type: 'cancel' }
  // 转写成功非空 → 已经 insert-at-cursor 回填可编辑框（成功终态）。
  | { type: 'fill' }
  // 转写为空（静音/未识别）→ 回 idle（不回填，调用方给轻提示）。
  | { type: 'empty' }
  // 上传/识别失败 → error 态（丢弃本段、不阻断会话，FR-009）。
  | { type: 'error'; reason: string }
  // 显式回 idle（error 提示已落 toast 后归位 / filled 后复位 / reset）。
  | { type: 'reset' };

// per-action 处理拆小函数，守卫局部化 —— reducer 主体只分发（同 ideation-reducer 范式）。
// 守卫不满足返回原引用 = 被拒/忽略，薄壳不发起对应副作用。
const handlers: {
  [K in VoiceAction['type']]: (
    state: VoiceState,
    action: Extract<VoiceAction, { type: K }>,
  ) => VoiceState;
} = {
  // 点 mic 申请权限（仅空闲态：idle / filled（上一段已完成）可再起）。
  'request-perm': (state) =>
    state.status === 'idle' || state.status === 'filled'
      ? { status: 'requesting-perm', errorReason: null }
      : state,

  // 权限弹窗允许 → 进录音（仅 requesting-perm 态）。
  'perm-granted': (state) =>
    state.status !== 'requesting-perm' ? state : { status: 'recording', errorReason: null },

  // 权限拒绝 → 回 idle（调用方落去设置 toast）。仅 requesting-perm 态。
  'perm-denied': (state) =>
    state.status !== 'requesting-perm' ? state : { status: 'idle', errorReason: null },

  // 已有权限直接起录（非首次点 mic）。空闲态（idle / filled）可起。
  start: (state) =>
    state.status === 'idle' || state.status === 'filled'
      ? { status: 'recording', errorReason: null }
      : state,

  // 点 ✓ / 60s 上限 → 停录、整段上传识别。仅 recording 态。
  confirm: (state) =>
    state.status !== 'recording' ? state : { status: 'processing', errorReason: null },

  // 取消（✗ / 后台 / 离屏中断）→ 丢弃本段回 idle。录音中或处理中均可（中断可在两态发生）。
  cancel: (state) =>
    state.status === 'recording' || state.status === 'processing'
      ? { status: 'idle', errorReason: null }
      : state,

  // 转写成功非空 → 已回填（成功终态）。仅 processing 态。
  fill: (state) =>
    state.status !== 'processing' ? state : { status: 'filled', errorReason: null },

  // 转写为空 → 回 idle（不回填，调用方给轻提示）。仅 processing 态。
  empty: (state) => (state.status !== 'processing' ? state : { status: 'idle', errorReason: null }),

  // 上传/识别失败 → error 态。录音中或处理中均可收 error（录音器异常 / 上传失败）。
  error: (state, action) =>
    state.status === 'recording' || state.status === 'processing'
      ? { status: 'error', errorReason: action.reason }
      : state,

  // 显式归位 idle（error toast 落后 / filled 复位 / 离屏强制收尾）。任意态可 reset。
  reset: () => initialVoiceState,
};

/** 纯态机转换。分发到 per-action handler（守卫局部化）。复杂度 O(1)。 */
export function voiceReducer(state: VoiceState, action: VoiceAction): VoiceState {
  const handler = handlers[action.type] as (s: VoiceState, a: VoiceAction) => VoiceState;
  return handler(state, action);
}

/** 录音会话进行中（录音或上传识别中；面板开 + 阻止重入起录判定用）。 */
export function isVoiceActive(status: VoiceStatus): boolean {
  return status === 'recording' || status === 'processing';
}
