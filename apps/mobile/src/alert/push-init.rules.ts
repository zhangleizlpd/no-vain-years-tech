// Pure gating decision for alert-push initialization (022 FR-001 / SC-004).
// Extracted so the init 双 gate truth table is unit-testable without mocking
// react-native / the consent store — same pattern as core/consent-gate-decision.
//
// Only `android && consented` initializes:
//   - web      → never (D7: web 零采集 SDK，上架合规面仅 Android 渠道)
//   - !consent → never (同意前零初始化、零网络行为、零设备标识收集)
//   - ios      → never (jpush 原生侧未集成；ios 接入时此处放行即可)

export interface PushInitGateInput {
  platform: string;
  consented: boolean;
}

export function shouldInitAlertPush(input: PushInitGateInput): boolean {
  return input.platform === 'android' && input.consented;
}
