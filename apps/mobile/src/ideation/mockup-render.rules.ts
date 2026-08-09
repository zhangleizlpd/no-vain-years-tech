// 037 T010 — mockup 隔离渲染纯逻辑（URL 校验 / originWhitelist 派生 / CSP 串组装 /
// 导航放行判定）。抽出便于 vitest（render 组件本身 = T013 Playwright Web e2e）。
//
// 🚨 渲染隔离（FR-005 / SC-004）：mockup HTML 是 LLM 生成的**不可信内容**。渲染端硬化三件套
// 由本文件的纯函数喂给 MockupRenderer（native WebView / web iframe）：
//   ① originWhitelist = 配置的备案展示域（origin 锁定，禁跳任意外链）
//   ② onShouldStartLoadWithRequest 用 `isNavigationAllowed` 拦非备案域导航
//   ③ CSP meta（`buildCspMetaTag`）收紧 default-src，禁 script / form / 任意 connect
// 配置化：备案展示域 base = `EXPO_PUBLIC_OSS_PUBLIC_BASE_URL`（与 server `mockupUrl` 派生同源；
// 见 use-ideation-session.ts 既有用法）。base 未配 → originWhitelist 退化为空 + URL 视为不可信。

/** 备案展示域 base（与 server mockupUrl 派生同源）。缺省空串 → 视为未配置。 */
export const MOCKUP_DISPLAY_BASE_URL = process.env.EXPO_PUBLIC_OSS_PUBLIC_BASE_URL ?? '';

/**
 * 从 https(s) URL 取 origin（`scheme://host[:port]`）。非法 / 非 http(s) → null。
 * 自实现（不依赖 `new URL`，RN Hermes 对 URL 支持历史不稳）：仅解析 `scheme://authority` 段。
 */
export function originOf(url: string): string | null {
  const m = /^(https?):\/\/([^/?#]+)/i.exec(url.trim());
  if (!m) return null;
  const [, scheme, authority] = m;
  if (!scheme || !authority) return null;
  return `${scheme.toLowerCase()}://${authority.toLowerCase()}`;
}

/**
 * 派生 WebView `originWhitelist`：仅放行配置的备案展示域 origin（精确 origin，不带通配）。
 * base 未配 / 非法 → 返空数组（无放行 origin → 一切导航被 onShouldStartLoadWithRequest 拦）。
 * @param baseUrl 备案展示域 base（默认取 `MOCKUP_DISPLAY_BASE_URL`）。
 */
export function deriveOriginWhitelist(baseUrl: string = MOCKUP_DISPLAY_BASE_URL): string[] {
  const origin = originOf(baseUrl);
  return origin ? [origin] : [];
}

/**
 * 导航放行判定（喂 `onShouldStartLoadWithRequest`）：仅放行落在备案展示域 origin 下的 http(s)
 * 导航；其余（任意外链 / about:blank 外 / data: / file: / 跨域）一律拒。base 未配 → 全拒。
 * @param requestUrl WebView 拟导航的 URL。
 * @param allowedOrigins 放行 origin 列表（默认据 `MOCKUP_DISPLAY_BASE_URL` 派生）。
 */
export function isNavigationAllowed(
  requestUrl: string,
  allowedOrigins: string[] = deriveOriginWhitelist(),
): boolean {
  const reqOrigin = originOf(requestUrl);
  if (!reqOrigin) return false;
  return allowedOrigins.includes(reqOrigin);
}

/**
 * 判定 server 派生的 mockupUrl 是否可渲染：非空 + 落在备案展示域 origin 下。
 * server 在 OSS 未配时返 `null`（→ App 走渲染降级）；本函数额外兜住「非备案域」脏 URL。
 * @param mockupUrl server 返的 mockupUrl（可能为 null）。
 */
export function isRenderableMockupUrl(
  mockupUrl: string | null | undefined,
  allowedOrigins: string[] = deriveOriginWhitelist(),
): mockupUrl is string {
  if (!mockupUrl) return false;
  const origin = originOf(mockupUrl);
  return origin !== null && allowedOrigins.includes(origin);
}

/**
 * 收紧 CSP 的 `<meta http-equiv>` 串（web iframe 注入 / native 文档级兜底参考）：
 * - `default-src 'none'`：默认全禁
 * - `img-src / style-src / font-src` 放行 self + data + 备案展示域（mockup 单文档内联 CSS，
 *   但仍可能引同域图/字）
 * - **无 `script-src`**（= 继承 default-src 'none' → 禁脚本，呼应 native `javaScriptEnabled=false`）
 * - **无 `form-action`/`connect-src`**（禁表单外发 / 任意 fetch，FR-005）
 * @param baseUrl 备案展示域 base（用于 origin 放行）。
 */
export function buildCspMetaContent(baseUrl: string = MOCKUP_DISPLAY_BASE_URL): string {
  const origin = originOf(baseUrl);
  const self = origin ? ` ${origin}` : '';
  return [
    `default-src 'none'`,
    `img-src 'self' data:${self}`,
    `style-src 'self' 'unsafe-inline'${self}`,
    `font-src 'self' data:${self}`,
    `base-uri 'none'`,
    `form-action 'none'`,
  ].join('; ');
}
