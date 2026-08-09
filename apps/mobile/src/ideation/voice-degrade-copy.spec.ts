// 035 T008 — 语音降级三态文案映射 + 麦克风权限拒绝兜底（US2/US3，FR-006/007/009）。
//
// 纯逻辑层（文案映射穷举 / 非空 / 不泄露内部错误细节）= vitest；
// UI render（toast pill 渲染、权限弹窗交互）= T009 Playwright e2e（本 task 不写 e2e）。
import { describe, expect, it } from 'vitest';

import { IDEATION_COPY, VOICE_DEGRADE_COPY, voiceDegradeToast } from './ideation-copy';
import type { VoiceDegradeReason } from './use-ideation-recording';

// 降级原因联合的全集（与 use-ideation-recording.ts `VoiceDegradeReason` 同步；
// 漏列成员 → 下方穷举断言 + Record 编译双重拦）。
const ALL_REASONS: VoiceDegradeReason[] = ['transcribe', 'empty', 'limit'];

describe('VOICE_DEGRADE_COPY — 三态文案映射（穷举 + 非空）', () => {
  it('每个降级 reason 都有非空文案（无遗漏）', () => {
    for (const reason of ALL_REASONS) {
      const copy = VOICE_DEGRADE_COPY[reason];
      expect(copy, `reason "${reason}" 缺文案`).toBeTruthy();
      expect(copy.trim().length).toBeGreaterThan(0);
    }
  });

  it('映射 key 集合 === 降级 reason 全集（无多余 / 无缺失）', () => {
    expect(new Set(Object.keys(VOICE_DEGRADE_COPY))).toEqual(new Set(ALL_REASONS));
  });

  it('voiceDegradeToast 返回与映射表一致的文案', () => {
    expect(voiceDegradeToast('transcribe')).toBe('转写失败，请重试或改用键盘');
    expect(voiceDegradeToast('empty')).toBe('未识别到语音');
    expect(voiceDegradeToast('limit')).toBe('已达单段上限（60 秒）');
  });

  it('transcribe 文案不泄露内部错误细节（FR-009 安全：无 vendor / 状态码 / 技术词）', () => {
    const copy = voiceDegradeToast('transcribe');
    expect(copy).not.toMatch(/dashscope|websocket|401|403|5\d{2}|timeout|token|key/i);
    expect(copy).not.toMatch(/超时|鉴权|断流|不可达/); // 内部原因码不外泄
  });
});

describe('micPermissionDenied — 麦克风权限拒绝引导（FR-006）', () => {
  it('麦克风权限文案非空且与相册/相机 permissionDenied 区分（录音专用）', () => {
    expect(IDEATION_COPY.micPermissionDenied.trim().length).toBeGreaterThan(0);
    expect(IDEATION_COPY.micPermissionDenied).not.toBe(IDEATION_COPY.permissionDenied);
  });

  it('麦克风权限文案引导去设置（FR-006 前往系统设置开启）', () => {
    expect(IDEATION_COPY.micPermissionDenied).toContain('设置');
  });
});
