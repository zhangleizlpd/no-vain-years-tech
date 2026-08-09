// Alert-push initialization — native implementation (022 T011, PoC #364 正式化).
// Caller (app/_layout.tsx ConsentGate effect) gates on shouldInitAlertPush
// (consented && android) BEFORE invoking — this module assumes the privacy
// gate has already passed (FR-001). jpush-react-native is lazily require()d so
// the SDK module is never evaluated unless init actually runs.
//
// Boot sequence:
//   1. expo-notifications.setNotificationChannelAsync — 自建 importance=MAX 渠道
//      (FR-006: server 推送 payload 的 android.channel_id 与此同源 @nvy/types
//      常量；channel 属性建后系统级不可改，改强度双端换 _v2)。channel 先于权限
//      弹框建好，Android 13+ 授权后首条通知即走横幅强度。
//   2. requestPermissionsAsync — Android 13+ POST_NOTIFICATIONS 系统弹框
//      (12- 自动授予返回 granted)。拒绝不阻断 init：推送仍送达系统但不展示，
//      App 内消息中心兜底（spec Edge），设置页引导行负责挽回（T012）。
//   3. JPush.init + ConnectEvent 监听 + 轮询兜底取 RegID（PoC 实证模式：连接
//      事件在部分 ROM 不可靠，10×3s 轮询双保险）。
//
// RegID 出口：模块级缓存 + listener seam — T012 push-binding 经
// setRegistrationIdListener 订阅「RegID 就绪」时机做 PUT 上报，经
// getRegistrationId 在登录事件时补读。

import { ALERT_PUSH_CHANNEL_ID } from '@nvy/types';
import * as Notifications from 'expo-notifications';

import { initAlertPushClick } from './push-click';

// Android 侧 init() 读 AndroidManifest 的 JPUSH_APPKEY / JPUSH_CHANNEL（由
// 本地 with-jpush plugin 在 prebuild 时注入）；JS 入参仅 iOS 路径消费。
const JPUSH_APP_KEY = '584825d7430a0c2132c82212';

const REG_ID_POLL_LIMIT = 10;
const REG_ID_POLL_INTERVAL_MS = 3000;

let registrationId: string | null = null;
let regIdListener: ((regId: string) => void) | null = null;
let initialized = false;

/** 当前 RegID（init 后异步就绪；未就绪 / 未 init → null）。T012 登录补上报用。 */
export function getRegistrationId(): string | null {
  return registrationId;
}

/** RegID 首次就绪回调（单 listener 够用：唯一消费者是 T012 push-binding）。 */
export function setRegistrationIdListener(listener: (regId: string) => void): void {
  regIdListener = listener;
  // init 先于订阅完成的时序兜底：RegID 已在手即刻补触发。
  if (registrationId !== null) listener(registrationId);
}

function captureRegId(regId: string | undefined): boolean {
  if (!regId) return false;
  if (registrationId === null) {
    registrationId = regId;
    regIdListener?.(regId);
  }
  return true;
}

export async function initAlertPush(): Promise<void> {
  if (initialized) return;
  initialized = true;

  await Notifications.setNotificationChannelAsync(ALERT_PUSH_CHANNEL_ID, {
    name: '预警通知',
    importance: Notifications.AndroidImportance.MAX,
  });
  // 拒绝授权不阻断（推送静默送达，消息中心兜底）；结果不消费。
  await Notifications.requestPermissionsAsync();

  // 惰性 require：保证未同意 / web / iOS 路径永不触发 SDK 模块求值。
  const JPush = (
    require('jpush-react-native') as { default: typeof import('jpush-react-native').default }
  ).default;
  const JCore = (
    require('jcore-react-native') as { default: typeof import('jcore-react-native').default }
  ).default;
  // 解除 native onCreate 的合规闸（with-jpush plugin 注入 JCollectionAuth.setAuth
  // (false) 压住自启，FR-001）。JCore 实测 setAuth(false) 持久化 → JPush.init() 单独
  // 不翻转（logcat「user don't auth, so return init」），同意路径必须显式 setAuth(true)
  // 再 init（jiguang 合规文档 + 022 T015 真机实证）。本模块只在 consent gate 放行后调。
  JCore.setAuth(true);
  JPush.init({
    appKey: JPUSH_APP_KEY,
    channel: 'developer-default',
    production: !__DEV__,
  });

  // 通知点击 → 消息中心路由（T012，与 init 同一已同意路径内挂载）
  initAlertPushClick();

  JPush.addConnectEventListener(() => {
    JPush.getRegistrationID((res) => {
      captureRegId(res.registerID);
    });
  });
  let polls = 0;
  const timer = setInterval(() => {
    polls += 1;
    JPush.getRegistrationID((res) => {
      if (captureRegId(res.registerID) || polls >= REG_ID_POLL_LIMIT) {
        clearInterval(timer);
      }
    });
  }, REG_ID_POLL_INTERVAL_MS);
}
