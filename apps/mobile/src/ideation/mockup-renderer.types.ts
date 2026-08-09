// 037 T010 — MockupRenderer 跨平台共享 props 契约（native `.tsx` + web `.web.tsx` 同实现此型）。
// 抽出避免 web 变体顶层 import `react-native-webview` 的类型（其原生模块无 web entry）。

export interface MockupRendererProps {
  /** 备案展示域 mockup URL（server 派生；调用方已 isRenderableMockupUrl 校验）。 */
  uri: string;
  /** 渲染失败（产物不可达 / HTTP 非 2xx）回调 → 屏做一次性降级（FR-009）。参数 = 失败 url。 */
  onError?: (url: string) => void;
  /** 测试锚（默认 'mockup-renderer'）。 */
  testID?: string;
}
