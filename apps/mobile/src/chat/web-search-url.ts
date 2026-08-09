// 030 T014 — 来源 URL scheme 安全校验纯函数（无 IO、无 RN/expo 依赖，per 测试分层 vitest=logic）。
//
// 抽成独立纯模块（非内联 web-search-sources.tsx）：tsx 顶层 import expo-web-browser + RN，
// 不宜进 vitest（logic-only）；本模块零外部依赖，可直接单测。

/**
 * URL scheme 安全校验（FR-005 防注入）。仅 `http:` / `https:` 协议放行 —— 拒
 * `javascript:` / `file:` / `data:` 等可在 in-app browser 触发副作用的 scheme。
 * 解析失败（非法 URL）一律拒。复杂度 O(1)（URL 构造）。
 *
 * @param url 来源链接（server 归一化后落库的 link）。
 * @returns 是否可安全交给 expo-web-browser 打开。
 */
export function isSafeHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
