// 035 T006 — ideation 语音采集 hook（**native**：整段录音 → 一次性文件识别采集核心）。
//
// 🚨 平台拆分：本文件是 **native 变体**（iOS / Android），import `react-native-nitro-sound`。web
// 变体见 `use-ideation-voice.web.ts`（seam-or-noop，不 import 原生模块）—— nitro-sound 的 peer
// `react-native-nitro-modules` 无 web entry，web bundle 顶层 import 即崩。Metro 按平台解析：
// native → 本 `.ts`，web → `.web.ts`。共享类型在 `use-ideation-voice.types.ts`。
//
// 🚨 选型背景（06-24 Replan 翻案）：实测定位「逐字复读」根因 = `@mykin-ai/expo-audio-stream`
// 采集劣化（其 16kHz 重采样在出事华为机型坏）。退役 @mykin + 实时流式，换主流稳定
// `react-native-nitro-sound`（文件录制 m4a/aac + `meteringEnabled` 振幅，Nitro/JSI autolinking，
// 老牌 react-native-audio-recorder-player 的官方继任）。是新原生依赖（走 dev-client 重 prebuild）。
//
// 职责：申请麦克风权限（**拒绝不 throw**）→ start 起整段录音并把 `currentMetering`（dBFS）经
// onMeter 喂波形 → stopAndGetUri 停录拿文件 URI（交 asr-upload 转 base64 一次性识别）→ cancel
// 停录丢弃。**不持网络 / 不直连 DashScope / 不持 key**（FR-014）。
//
// 🚨 权限：nitro-sound 无独立权限 API。Android 用 RN 内置 `PermissionsAndroid` 预申请 RECORD_AUDIO
// （零新依赖）；iOS 无预检 API → startRecorder 触发系统弹窗，乐观放行，拒绝经 start 失败 → 上层
// 降级（FR-009）。app.config 麦克风权限串见 app.json。
//
// 测试分层：录音权限/起停交互 = T008 Playwright e2e（web 经 .web.ts seam 注确定性 fixture）+ 发版
// 前真机录音验证（T001 Spike 已华为真机实测采集 + metering + G-1）。本 hook 无 vitest（纯 IO）。
import { useCallback, useMemo } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import Sound, {
  AudioEncoderAndroidType,
  AVEncoderAudioQualityIOSType,
  OutputFormatAndroidType,
  type AudioSet,
} from 'react-native-nitro-sound';

import {
  getRecorderSeam,
  type MeterCallback,
  type UseIdeationVoice,
} from './use-ideation-voice.types';

export type { MeterCallback, VoicePermission, UseIdeationVoice } from './use-ideation-voice.types';

/** 目标录音格式：单声道 ~16kHz AAC（→ m4a 容器）。DashScope 同步识别原生接受 AAC，无需服务端转码。 */
const AUDIO_SET: AudioSet = {
  // iOS：AAC / 16kHz / 单声道 / 高质量。
  AVFormatIDKeyIOS: 'aac',
  AVSampleRateKeyIOS: 16_000,
  AVNumberOfChannelsKeyIOS: 1,
  AVEncoderAudioQualityKeyIOS: AVEncoderAudioQualityIOSType.high,
  // Android：AAC encoder + MPEG_4 容器（→ m4a）/ 16kHz / 单声道。
  AudioEncoderAndroid: AudioEncoderAndroidType.AAC,
  OutputFormatAndroid: OutputFormatAndroidType.MPEG_4,
  AudioSamplingRate: 16_000,
  AudioChannels: 1,
};

/** metering 回调粒度（秒）：0.1s ≈ 10 帧/秒，波形起伏平滑且不过载 JS 线程。 */
const METER_INTERVAL_SEC = 0.1;
/** metering 缺省静音值（dBFS）：某帧无 currentMetering 时按 iOS 静音底噪处理。 */
const SILENCE_DB = -160;

/**
 * ideation 语音采集 hook（native）。**不**持网络——只产录音文件 URI + metering；上传识别 + 降级
 * UI 由 use-ideation-recording 编排。`Sound` 是 nitro 单例，方法为稳定包装。
 */
export function useIdeationVoice(): UseIdeationVoice {
  const requestPermission = useCallback(async () => {
    const seam = getRecorderSeam();
    if (seam) return seam.requestPermission();

    if (Platform.OS === 'android') {
      // Android：MediaRecorder 须先有 RECORD_AUDIO 授权，预申请（拒绝不 throw）。
      try {
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        );
        return {
          granted: result === PermissionsAndroid.RESULTS.GRANTED,
          canAskAgain: result !== PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN,
        };
      } catch {
        return { granted: false, canAskAgain: false };
      }
    }
    // iOS：无预检 API。startRecorder 触发系统弹窗；乐观放行，拒绝经 start 失败 → 降级。
    return { granted: true, canAskAgain: true };
  }, []);

  const start = useCallback(async (onMeter: MeterCallback): Promise<boolean> => {
    const seam = getRecorderSeam();
    if (seam) return seam.start(onMeter);

    try {
      Sound.setSubscriptionDuration(METER_INTERVAL_SEC);
      Sound.addRecordBackListener((e) => {
        onMeter(e.currentMetering ?? SILENCE_DB);
      });
      // meteringEnabled=true 取 currentMetering；uri=undefined 用默认临时路径（音频瞬态、不落库）。
      await Sound.startRecorder(undefined, AUDIO_SET, true);
      return true;
    } catch {
      // 起录失败（权限拒绝竞态 / 原生异常）→ 收尾不 throw，调用方按未起录降级处理。
      Sound.removeRecordBackListener();
      return false;
    }
  }, []);

  const stopAndGetUri = useCallback(async (): Promise<string | null> => {
    const seam = getRecorderSeam();
    if (seam) return seam.stopAndGetUri();

    try {
      const uri = await Sound.stopRecorder();
      Sound.removeRecordBackListener();
      return uri ?? null;
    } catch {
      Sound.removeRecordBackListener();
      return null;
    }
  }, []);

  const cancel = useCallback(async (): Promise<void> => {
    const seam = getRecorderSeam();
    if (seam) {
      await seam.cancel();
      return;
    }
    try {
      await Sound.stopRecorder();
    } catch {
      // 停录失败不 throw：取消路径丢弃录音，原生资源由下次起录前的 stop 兜底。
    } finally {
      Sound.removeRecordBackListener();
    }
  }, []);

  // 稳定 identity（callbacks 皆 []-stable）：避免每 render 产新对象，否则消费方 useEffect 以
  // voice 为 dep 会每 render 重跑（含其 cleanup）—— use-ideation-recording 的 unmount teardown
  // 曾因此每 render 误置 cancelledRef=true，吞掉 ✓ 后的回填。
  return useMemo(
    () => ({ requestPermission, start, stopAndGetUri, cancel }),
    [requestPermission, start, stopAndGetUri, cancel],
  );
}
