// 035 T006 — ideation 语音录音态机纯 reducer 单测（穷举态转换 + 交互边界）。
// 一次性文件识别范式（点 mic → 波形 ✓/✗ → processing → filled）。
// 点击 / metering / 上传 / render 留 T008 e2e（per 测试分层 vitest=logic）。
import { describe, expect, it } from 'vitest';
import {
  voiceReducer,
  initialVoiceState,
  isVoiceActive,
  type VoiceState,
} from './ideation-voice-reducer';

/** 推到 recording 态（已授权直接起录）。 */
function recording(): VoiceState {
  return voiceReducer(initialVoiceState, { type: 'start' });
}

/** 推到 processing 态（recording → ✓ confirm）。 */
function processing(): VoiceState {
  return voiceReducer(recording(), { type: 'confirm' });
}

describe('voiceReducer (T006 一次性录音态机)', () => {
  it('初始 idle，无 error', () => {
    expect(initialVoiceState).toEqual({ status: 'idle', errorReason: null });
  });

  // ── 首次权限链 ──
  it('request-perm: idle → requesting-perm', () => {
    const s = voiceReducer(initialVoiceState, { type: 'request-perm' });
    expect(s.status).toBe('requesting-perm');
  });

  it('perm-granted: requesting-perm → recording', () => {
    let s = voiceReducer(initialVoiceState, { type: 'request-perm' });
    s = voiceReducer(s, { type: 'perm-granted' });
    expect(s.status).toBe('recording');
  });

  it('perm-denied: requesting-perm → idle（调用方落去设置 toast）', () => {
    let s = voiceReducer(initialVoiceState, { type: 'request-perm' });
    s = voiceReducer(s, { type: 'perm-denied' });
    expect(s.status).toBe('idle');
  });

  it('已授权 start: idle → recording（非首次）', () => {
    expect(recording().status).toBe('recording');
  });

  // ── US1 一次性识别正常链：点录 → ✓ → processing → filled ──
  it('confirm: recording → processing（✓ / 60s 上限停录上传）', () => {
    expect(processing().status).toBe('processing');
  });

  it('fill: processing → filled（转写成功回填可编辑框）', () => {
    const s = voiceReducer(processing(), { type: 'fill' });
    expect(s).toEqual({ status: 'filled', errorReason: null });
  });

  it('empty: processing → idle（静音空转写，不回填给轻提示）', () => {
    const s = voiceReducer(processing(), { type: 'empty' });
    expect(s.status).toBe('idle');
  });

  it('filled 后可再起录（request-perm / start）', () => {
    const filled = voiceReducer(processing(), { type: 'fill' });
    expect(voiceReducer(filled, { type: 'request-perm' }).status).toBe('requesting-perm');
    expect(voiceReducer(filled, { type: 'start' }).status).toBe('recording');
  });

  // ── US2 取消（✗ 按钮 / 中断），零副作用 ──
  it('cancel: recording → idle（点 ✗ 取消零副作用）', () => {
    const s = voiceReducer(recording(), { type: 'cancel' });
    expect(s.status).toBe('idle');
  });

  it('cancel: processing → idle（上传中后台/离屏中断丢弃，FR-015）', () => {
    const s = voiceReducer(processing(), { type: 'cancel' });
    expect(s.status).toBe('idle');
  });

  // ── US3 降级 ──
  it('error: recording → error 带 reason（录音器异常丢弃本段）', () => {
    const s = voiceReducer(recording(), { type: 'error', reason: 'transcribe' });
    expect(s).toEqual({ status: 'error', errorReason: 'transcribe' });
  });

  it('error: processing → error（上传/识别失败，FR-009）', () => {
    const s = voiceReducer(processing(), { type: 'error', reason: 'transcribe' });
    expect(s.status).toBe('error');
  });

  it('reset: error → idle（toast 落后归位）', () => {
    let s = voiceReducer(recording(), { type: 'error', reason: 'x' });
    s = voiceReducer(s, { type: 'reset' });
    expect(s).toEqual(initialVoiceState);
  });

  // ── 守卫：非法态转换返回原引用（被忽略，薄壳不发起副作用） ──
  it('idle 态 confirm / fill / cancel / empty 忽略（返回原引用）', () => {
    expect(voiceReducer(initialVoiceState, { type: 'confirm' })).toBe(initialVoiceState);
    expect(voiceReducer(initialVoiceState, { type: 'fill' })).toBe(initialVoiceState);
    expect(voiceReducer(initialVoiceState, { type: 'cancel' })).toBe(initialVoiceState);
    expect(voiceReducer(initialVoiceState, { type: 'empty' })).toBe(initialVoiceState);
  });

  it('recording 态 perm-granted / start 忽略（已在录不重入）', () => {
    const s = recording();
    expect(voiceReducer(s, { type: 'perm-granted' })).toBe(s);
    expect(voiceReducer(s, { type: 'start' })).toBe(s);
  });

  it('processing 态 confirm / fill 重复忽略外，fill 之后迟到 fill/empty 忽略', () => {
    const p = processing();
    expect(voiceReducer(p, { type: 'confirm' })).toBe(p); // 已 processing，重复 confirm 忽略。
    const filled = voiceReducer(p, { type: 'fill' });
    expect(voiceReducer(filled, { type: 'fill' })).toBe(filled); // filled 后迟到 fill 忽略。
    expect(voiceReducer(filled, { type: 'empty' })).toBe(filled);
  });

  // ── isVoiceActive 派生（录音或上传中 = 面板开 / 阻止重入） ──
  it('isVoiceActive: recording / processing 为 true，其余 false', () => {
    expect(isVoiceActive('recording')).toBe(true);
    expect(isVoiceActive('processing')).toBe(true);
    expect(isVoiceActive('idle')).toBe(false);
    expect(isVoiceActive('requesting-perm')).toBe(false);
    expect(isVoiceActive('filled')).toBe(false);
    expect(isVoiceActive('error')).toBe(false);
  });
});
