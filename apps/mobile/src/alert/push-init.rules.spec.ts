import { describe, expect, it } from 'vitest';

import { shouldInitAlertPush } from './push-init.rules';

describe('shouldInitAlertPush — 022 FR-001 init 双 gate（consented && android）', () => {
  it('web → false (D7: web 零采集 SDK，无论同意与否)', () => {
    expect(shouldInitAlertPush({ platform: 'web', consented: true })).toBe(false);
    expect(shouldInitAlertPush({ platform: 'web', consented: false })).toBe(false);
  });

  it('未同意 → false (FR-001: 同意前零初始化，android 也不例外)', () => {
    expect(shouldInitAlertPush({ platform: 'android', consented: false })).toBe(false);
  });

  it('ios → false (原生侧未集成 jpush，US1 范围 android-only)', () => {
    expect(shouldInitAlertPush({ platform: 'ios', consented: true })).toBe(false);
  });

  it('android + 已同意 → true（唯一放行组合）', () => {
    expect(shouldInitAlertPush({ platform: 'android', consented: true })).toBe(true);
  });
});
