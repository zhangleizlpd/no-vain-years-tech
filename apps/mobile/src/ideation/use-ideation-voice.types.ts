// 035 T006 — ideation 语音采集 hook 的跨平台共享类型（无 import、无 RN/native 依赖）。
//
// 🚨 平台拆分（web 安全）：`use-ideation-voice.ts`（native，import `react-native-nitro-sound`）与
// `use-ideation-voice.web.ts`（web，seam-or-noop，**不** import 任何原生模块）共用本类型文件。
// nitro-sound 的 peer `react-native-nitro-modules` 无 web entry → 在 web bundle 顶层 import 即崩
// （"importing from 'react-native' instead of 'react-native-web'"），故 web 走独立 .web.ts 变体。

/** 振幅回调：每帧裸 dBFS（由 waveform-normalize.normalizeMeter 归一化驱动波形）。 */
export type MeterCallback = (db: number) => void;

/** 麦克风权限结果（不 throw；拒绝时调用方落去设置 toast）。 */
export interface VoicePermission {
  granted: boolean;
  /** 系统是否仍允许再次弹窗（false = 用户已永久拒绝，须去设置）。 */
  canAskAgain: boolean;
}

export interface UseIdeationVoice {
  /** 申请麦克风权限。**拒绝不 throw**，返回 granted=false。iOS/web 乐观放行（拒绝经 start 失败兜底）。 */
  requestPermission: () => Promise<VoicePermission>;
  /** 起整段录音；`currentMetering` 经 onMeter 喂波形。返回是否成功起录（失败不 throw）。 */
  start: (onMeter: MeterCallback) => Promise<boolean>;
  /** 停录并返回录音文件 URI（交 asr-upload）。失败返回 null（不 throw）。 */
  stopAndGetUri: () => Promise<string | null>;
  /** 停录并丢弃（✗ 取消 / 中断；幂等，不 throw）。 */
  cancel: () => Promise<void>;
}

/**
 * e2e 采集替身 seam（hermetic）：Web 无真设备麦克风（Playwright headless）→ 经
 * `globalThis.__NVY_ASR_RECORDER_E2E__` 注入确定性 fixture（start/stopAndGetUri 返 sentinel）。
 * **仅 e2e harness 注入、生产 bundle 永不存在**（`__NVY_*` 全局铁律）。运行时取（非 import 期），
 * 让 harness 在首次调用前注入。
 */
export function getRecorderSeam(): UseIdeationVoice | null {
  return (
    (globalThis as { __NVY_ASR_RECORDER_E2E__?: UseIdeationVoice }).__NVY_ASR_RECORDER_E2E__ ?? null
  );
}
