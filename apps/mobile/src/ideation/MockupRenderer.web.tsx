// 037 T010 — mockup 隔离渲染组件（**web** 变体，供 Playwright Expo Web e2e + 生产 web）。
//
// 🚨 web 安全铁律：**绝不** import `react-native-webview`——其原生模块无 web entry，web bundle
// 顶层 import 即崩。native 变体见 `MockupRenderer.tsx`；Metro 按平台解析（web → 本文件）。
//
// 🚨 渲染隔离（FR-005 / SC-004，不可信 LLM-HTML）：用浏览器原生 `<iframe sandbox>`——
//   - `sandbox="allow-same-origin"`（**不含** `allow-scripts`）：禁脚本执行（呼应 native JS-off）、
//     禁 top-navigation / 禁表单提交 / 禁弹窗；`allow-same-origin` 仅让 iframe 加载备案同源文档
//     （否则 opaque origin 连静态资源都加载不了）。
//   - `referrerPolicy="no-referrer"`：不外泄主上下文 referrer。
//   - mockup 文档自身 CSP 由备案展示域服务端下发（meta 串构造逻辑见 mockup-render.rules
//     buildCspMetaContent，e2e fixture 经 route.fulfill 注入）。
// e2e（T013）经 `route.fulfill` 把 uri 镜像为确定性 fixture HTML，iframe `src` 指向即渲染。
import { View } from 'react-native';

import type { MockupRendererProps } from './mockup-renderer.types';

/**
 * mockup 隔离渲染（web）。`<iframe sandbox>` 静态隔离；加载失败 → onError 上抛屏做降级（FR-009）。
 */
export function MockupRenderer({ uri, onError, testID }: MockupRendererProps) {
  return (
    <View className="flex-1 bg-bg" testID={testID ?? 'mockup-renderer'}>
      {/* RN-Web 把 View 渲为 div；iframe 是纯 web 原语，直接用 createElement-free JSX。 */}
      <iframe
        title="mockup-preview"
        src={uri}
        // 隔离沙箱：仅 same-origin（加载备案文档），不放 allow-scripts / allow-forms / allow-popups。
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
        onError={() => onError?.(uri)}
        style={{ flex: 1, border: 'none', width: '100%', height: '100%' }}
        data-testid="mockup-iframe"
      />
    </View>
  );
}
