// 037 T010 — mockup 隔离渲染组件（**native** 变体，iOS/Android）。
//
// 🚨 平台拆分：本文件 import `react-native-webview`（**无 web 支持**——其原生模块在 web bundle
// 顶层 import 即 Metro 解析失败）。web 变体见 `MockupRenderer.web.tsx`（`<iframe sandbox>`，
// 不 import webview）。Metro 按平台解析：native → 本 `.tsx`，web → `.web.tsx`。
// 范式同 `use-ideation-voice.{ts,web.ts}`。
//
// 🚨 渲染隔离（FR-005 / SC-004，不可信 LLM-HTML）：静态硬化三件套——
//   ① `javaScriptEnabled={false}`：静态稿不需 JS，关脚本执行（杜绝越界读 cookie/凭据 / 自动跳转）
//   ② `originWhitelist`：锁备案展示域 origin（mockup-render.rules.deriveOriginWhitelist）
//   ③ `onShouldStartLoadWithRequest`：拦非备案域导航（isNavigationAllowed），任意外链一律拒
// 另：不在 webview 处理敏感数据（无 Authorization 注入、无 onMessage 桥）；加载失败 → onError 上抛
// 给屏做一次性降级（FR-009，记录存在 ≠ 渲染成功，解耦）。
import { useCallback } from 'react';
import { View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type {
  ShouldStartLoadRequest,
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
} from 'react-native-webview/lib/WebViewTypes';

import { deriveOriginWhitelist, isNavigationAllowed } from './mockup-render.rules';
import type { MockupRendererProps } from './mockup-renderer.types';

/**
 * mockup 隔离渲染（native）。`uri` = server 派生的备案展示域 mockup URL（调用方已校 renderable）。
 * 渲染失败（产物不可达 / HTTP 非 2xx）→ onError 一次性上抛，不崩、不阻断 session。
 */
export function MockupRenderer({ uri, onError, testID }: MockupRendererProps) {
  const originWhitelist = deriveOriginWhitelist();

  const onShouldStart = useCallback(
    (request: ShouldStartLoadRequest): boolean => isNavigationAllowed(request.url, originWhitelist),
    [originWhitelist],
  );

  const handleError = useCallback(
    (e: WebViewErrorEvent | WebViewHttpErrorEvent) => {
      // 不泄露内部错误细节给 UI（vendor / code）；仅通知屏走泛化降级文案。
      onError?.(e.nativeEvent.url ?? uri);
    },
    [onError, uri],
  );

  // 静态稿无需 JS → 不应有任何 postMessage；若 HTML 仍尝试 onMessage，忽略（不建桥、不回传）。
  const onMessage = useCallback((_e: WebViewMessageEvent) => {
    /* no-op: 静态隔离渲染不接受 webview→native 桥消息 */
  }, []);

  return (
    <View className="flex-1 bg-bg" testID={testID ?? 'mockup-renderer'}>
      <WebView
        source={{ uri }}
        // ① 静态稿关脚本（核心隔离）。
        javaScriptEnabled={false}
        // ② origin 锁备案展示域。
        originWhitelist={originWhitelist}
        // ③ 拦非备案域导航（任意外链跳转）。
        onShouldStartLoadWithRequest={onShouldStart}
        // 关 DOM storage / 第三方 cookie / 文件协议访问（收窄攻击面）。
        domStorageEnabled={false}
        thirdPartyCookiesEnabled={false}
        allowFileAccess={false}
        allowUniversalAccessFromFileURLs={false}
        // 不自动打开新窗 / 不进 incognito 外的共享 cookie。
        javaScriptCanOpenWindowsAutomatically={false}
        onMessage={onMessage}
        onError={handleError}
        onHttpError={handleError}
        startInLoadingState
        style={{ flex: 1 }}
      />
    </View>
  );
}
