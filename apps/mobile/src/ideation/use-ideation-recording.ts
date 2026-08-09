// 035 T006 — ideation 一次性录音编排薄壳（副作用层；纯态机 = ideation-voice-reducer）。
//
// 🚨 交互范式翻案（06-24 Replan）：点 mic（非长按）→ 录音面板（波形 ✓/✗）→ ✓ 停录整段一次性
// 识别 → transcript 经 insert-at-cursor 回填可编辑框（不自动发送）；✗ 取消零副作用。删 WS 流式 /
// 实时 partial / 下滑取消（onPanY/drag）/ finalizing。
//
// 职责（把态机 dispatch 翻成真副作用）：
//   - 点 mic：首次申请权限（拒绝走去设置 toast）→ useIdeationVoice.start(onMeter) 起整段录音，
//     metering 经 normalizeMeter 喂波形 shared value（滚动条）。
//   - ✓ / 60s 上限：confirm → stopAndGetUri → transcribeRecording → insert-at-cursor 合并落框
//     可编辑（FR-003/010），不自动发送；空 transcript → 'empty' 轻提示；失败 → 'transcribe' 降级。
//   - ✗ / 中断（后台/离屏）：cancel → 停录丢弃，零副作用（草稿不动，FR-005/015）。
//   - 流式互斥（FR-011）：isStreaming → canRecord=false（ClarifyChatScreen 把 mic disabled）。
//
// 🚨 client 不直连 DashScope、不持 key（FR-014）：录音文件经 asr-upload 调生成 fn 上行本 server。
//
// 测试分层：态机转换 = ideation-voice-reducer.spec.ts（vitest）；本编排薄壳的点击/录音/上传走
// T008 Playwright e2e（fake recorder seam + route.fulfill，per 测试分层 vitest=logic）。
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';

import { transcribeRecording } from './asr-upload';
import { insertAtCursor } from './insert-at-cursor';
import { normalizeMeter } from './waveform-normalize';
import { useIdeationVoice } from './use-ideation-voice';
import {
  initialVoiceState,
  isVoiceActive,
  voiceReducer,
  type VoiceStatus,
} from './ideation-voice-reducer';

/** 单段录音时长上限（FR-008，spec Clarifications = 60s）。到限自动 ✓（停录走识别路径）。 */
export const MAX_RECORDING_MS = 60_000;

/** 波形滚动条数量（metering 滚动窗口长度）。波形组件据此渲染等量 SVG bar。 */
export const WAVEFORM_BAR_COUNT = 32;

/** 当前输入框选区（合并插入用；null = 无焦点 → 追加末尾，FR-010）。 */
export interface DraftSelection {
  start: number | null;
  end: number | null;
}

/** 降级 reason（识别失败 / 静音空 transcript / 60s 上限）—— T007 据此映射三态 toast。 */
export type VoiceDegradeReason = 'transcribe' | 'empty' | 'limit';

export interface UseIdeationRecordingArgs {
  /** 目标会话 id（null = 未就绪，禁录）。transcribe 端点本身无状态，此处仅作 UX 起录闸。 */
  sessionId: string | null;
  /** 当前草稿（✓ 时 transcript 合并插入它的光标处；录音中输入框仍可编辑）。 */
  draft: string;
  /** 写草稿（✓ 成功合并落框）。 */
  setDraft: (text: string) => void;
  /** 当前选区（合并插入光标处用）。 */
  selection: DraftSelection;
  /** 设置选区（落框后把光标移到插入文本之后）。 */
  setSelection: (sel: { start: number; end: number }) => void;
  /** 流式澄清回复中（FR-011 互斥：true → 禁录）。 */
  isStreaming: boolean;
  /** 权限拒绝去设置 toast（T007 接文案）。 */
  onPermissionDenied: () => void;
  /** 降级提示（转写失败 / 未识别 / 已达上限，T007 接三态文案）。 */
  onDegrade: (reason: VoiceDegradeReason) => void;
}

export interface UseIdeationRecording {
  /** 录音态（面板可见性 / spinner / error row 判定）。 */
  status: VoiceStatus;
  /** 录音会话进行中（recording || processing；面板开 + 阻止重入）。 */
  isActive: boolean;
  /** 可起录（非流式 + sessionId 就绪 + 空闲态 idle/filled/error）。 */
  canRecord: boolean;
  /** 波形条强度（[0,1]，metering 归一化滚动窗口；交 IdeationWaveform 动画）。 */
  levels: SharedValue<number[]>;
  /** 点 mic 起录（普通点击，非长按）。首次申请权限，已授权直接起。 */
  onPressMic: () => void;
  /** 点 ✓ 确认（停录 → 整段一次性识别 → 回填）。 */
  onConfirm: () => void;
  /** 点 ✗ 取消（停录丢弃，零副作用）。 */
  onCancel: () => void;
}

export function useIdeationRecording(args: UseIdeationRecordingArgs): UseIdeationRecording {
  const {
    sessionId,
    draft,
    setDraft,
    selection,
    setSelection,
    isStreaming,
    onPermissionDenied,
    onDegrade,
  } = args;

  const voice = useIdeationVoice();
  const [state, dispatch] = useReducer(voiceReducer, initialVoiceState);
  const levels = useSharedValue<number[]>(new Array(WAVEFORM_BAR_COUNT).fill(0));

  const limitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // processing 重入闸（双击 ✓ / 60s 与 ✓ 撞）。
  const processingRef = useRef(false);
  // 取消代沟标记：cancel 置 true，async confirm 每步 await 后据此 bail，防中断后仍 setDraft。
  const cancelledRef = useRef(false);

  // 最新可变值经 ref 透传给 stable 回调（避免回调随每 render 重建）。
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const setDraftRef = useRef(setDraft);
  setDraftRef.current = setDraft;
  const setSelectionRef = useRef(setSelection);
  setSelectionRef.current = setSelection;
  const onDegradeRef = useRef(onDegrade);
  onDegradeRef.current = onDegrade;
  const onPermissionDeniedRef = useRef(onPermissionDenied);
  onPermissionDeniedRef.current = onPermissionDenied;
  const statusRef = useRef(state.status);
  statusRef.current = state.status;

  const clearLimitTimer = useCallback(() => {
    if (limitTimerRef.current !== null) {
      clearTimeout(limitTimerRef.current);
      limitTimerRef.current = null;
    }
  }, []);

  const resetLevels = useCallback(() => {
    levels.value = new Array(WAVEFORM_BAR_COUNT).fill(0);
  }, [levels]);

  // ── ✓ / 60s 上限：停录 → 整段一次性识别 → fill / empty / error ──
  const confirm = useCallback(() => {
    if (processingRef.current) return;
    if (statusRef.current !== 'recording') return;
    processingRef.current = true;
    clearLimitTimer();
    dispatch({ type: 'confirm' });
    void (async () => {
      try {
        const uri = await voice.stopAndGetUri();
        if (cancelledRef.current) return; // 中断：丢弃，不回填。
        if (uri === null) {
          onDegradeRef.current('transcribe');
          dispatch({ type: 'error', reason: 'transcribe' });
          return;
        }
        const text = (await transcribeRecording(uri)).trim();
        if (cancelledRef.current) return; // 上传期间中断：丢弃识别结果。
        if (text.length === 0) {
          // 静音 / 未识别：不回填，给「未识别到语音」轻提示（会话不受影响，FR-008）。
          onDegradeRef.current('empty');
          dispatch({ type: 'empty' });
          return;
        }
        // transcript 合并插入当前光标处（既有草稿保留；录音中用户若编辑过，以最新为准，FR-010）。
        const { start, end } = selectionRef.current;
        const { text: merged, cursor } = insertAtCursor(draftRef.current, text, start, end);
        setDraftRef.current(merged);
        setSelectionRef.current({ start: cursor, end: cursor });
        dispatch({ type: 'fill' });
      } catch {
        // 读文件 / 识别失败（AxiosError 等）→ 丢弃本段、不阻断会话（FR-009）。
        if (cancelledRef.current) return;
        onDegradeRef.current('transcribe');
        dispatch({ type: 'error', reason: 'transcribe' });
      } finally {
        processingRef.current = false;
        resetLevels();
      }
    })();
  }, [voice, clearLimitTimer, resetLevels]);
  // 60s 计时回调经 ref 取最新 confirm（避免起录闭包捕获旧引用 / 前向引用）。
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;

  // ── 起录核心（已授权后）：起整段录音，metering 喂波形 + 起 60s 计时 ──
  const startRecording = useCallback(() => {
    cancelledRef.current = false;
    resetLevels();
    void voice.start((db) => {
      const v = normalizeMeter(db);
      levels.value = [...levels.value.slice(1), v]; // 滚动窗口：丢最旧、推最新。
    });
    clearLimitTimer();
    limitTimerRef.current = setTimeout(() => {
      onDegradeRef.current('limit');
      confirmRef.current(); // 到限自动 ✓（停录走识别路径，FR-008）。
    }, MAX_RECORDING_MS);
  }, [voice, levels, clearLimitTimer, resetLevels]);

  // ── 点 mic 起录（普通点击；首次申请权限，已授权直接起） ──
  const onPressMic = useCallback(() => {
    if (isStreaming || sessionId === null) return; // 流式互斥 / 未就绪。
    if (isVoiceActive(state.status) || state.status === 'requesting-perm') return; // 已在录不重入。
    void (async () => {
      if (state.status === 'error') dispatch({ type: 'reset' }); // 上一段降级遗留先归位。
      dispatch({ type: 'request-perm' });
      const perm = await voice.requestPermission();
      if (!perm.granted) {
        onPermissionDeniedRef.current();
        dispatch({ type: 'perm-denied' });
        return;
      }
      dispatch({ type: 'perm-granted' });
      startRecording();
    })();
  }, [isStreaming, sessionId, state.status, voice, startRecording]);

  // ── ✗ / 中断：停录丢弃零副作用（草稿不动，FR-005/015） ──
  const cancel = useCallback(() => {
    cancelledRef.current = true; // 让 in-flight confirm 在 await 后 bail。
    clearLimitTimer();
    void voice.cancel();
    resetLevels();
    dispatch({ type: 'cancel' });
  }, [voice, clearLimitTimer, resetLevels]);

  // ── 中断（FR-015）：录音中/处理中切后台/离屏 → cancel（丢弃本段） ──
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      // 仅真正切后台（'background'）丢弃；'inactive'（来电横幅 / 控制中心 / web blur）是瞬态，
      // 不 nuke 录音（否则 web 上点击引发的 blur 会误取消，且 iOS 下拉通知也会误取消）。
      if (next === 'background' && isVoiceActive(statusRef.current)) cancel();
    });
    return () => sub.remove();
  }, [cancel]);

  // ── 卸载 / 离屏：teardown = 停录丢弃（目标输入框已不在场，FR-015） ──
  useEffect(
    () => () => {
      cancelledRef.current = true;
      clearLimitTimer();
      void voice.cancel();
    },
    [voice, clearLimitTimer],
  );

  const canRecord =
    !isStreaming &&
    sessionId !== null &&
    (state.status === 'idle' || state.status === 'filled' || state.status === 'error');

  return {
    status: state.status,
    isActive: isVoiceActive(state.status),
    canRecord,
    levels,
    onPressMic,
    onConfirm: confirm,
    onCancel: cancel,
  };
}
