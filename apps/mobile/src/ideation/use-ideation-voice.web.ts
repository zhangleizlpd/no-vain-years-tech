// 035 T006 — ideation 语音采集 hook（**web** 变体）。
//
// 🚨 web 安全铁律：**绝不** import `react-native-nitro-sound` —— 其 peer `react-native-nitro-modules`
// 无 web entry，在 web bundle 顶层 import 即崩（"importing from 'react-native' instead of
// 'react-native-web'"，整屏白）。native 变体见 `use-ideation-voice.ts`；Metro 按平台解析（web → 本文件）。
//
// web 无真设备麦克风：① e2e 经 seam `__NVY_ASR_RECORDER_E2E__` 注确定性 fixture（hermetic UI 验证）；
// ② 生产 web（若有）无录音器 → 权限拒 + 起录 no-op（与旧 requireOptionalNativeModule==null 行为等价）。
import { useCallback, useMemo } from 'react';

import {
  getRecorderSeam,
  type MeterCallback,
  type UseIdeationVoice,
} from './use-ideation-voice.types';

export type { MeterCallback, VoicePermission, UseIdeationVoice } from './use-ideation-voice.types';

/**
 * ideation 语音采集 hook（web）。有 e2e seam → 委托；否则 web 无 mic → 权限拒 + 起录 no-op
 * （调用方按权限拒/未起录降级，会话不崩）。
 */
export function useIdeationVoice(): UseIdeationVoice {
  const requestPermission = useCallback(async () => {
    const seam = getRecorderSeam();
    if (seam) return seam.requestPermission();
    return { granted: false, canAskAgain: false }; // web 无 mic → 拒（不 throw）。
  }, []);

  const start = useCallback(async (onMeter: MeterCallback): Promise<boolean> => {
    const seam = getRecorderSeam();
    if (seam) return seam.start(onMeter);
    return false; // web 无录音器 → 起录 no-op。
  }, []);

  const stopAndGetUri = useCallback(async (): Promise<string | null> => {
    const seam = getRecorderSeam();
    if (seam) return seam.stopAndGetUri();
    return null;
  }, []);

  const cancel = useCallback(async (): Promise<void> => {
    const seam = getRecorderSeam();
    if (seam) await seam.cancel();
  }, []);

  // 稳定 identity（同 native 变体）：避免每 render 产新对象致消费方 useEffect 重跑 cleanup。
  return useMemo(
    () => ({ requestPermission, start, stopAndGetUri, cancel }),
    [requestPermission, start, stopAndGetUri, cancel],
  );
}
