---
paths:
  - 'apps/mobile/e2e/**/*.spec.ts'
---

# Mobile e2e hermetic 边界（path-triggered，写 Expo Web e2e spec 时自动加载）

seed-authed e2e（`addInitScript` 注 `nvy-auth` 假 session）必须把后端边界拦死，否则泄漏到 `:3000` → env-dependent flake（CI 恰好无后端时假绿）。两条边界：

1. **GET /me 必拦（CI 硬强制）**：`mockJson(page, ME_URL, …, 'GET')` 或 raw `page.route(ME_URL, …)`。seed session 无 accessToken，boot 时 AuthGate `useMe` 必发 `GET /accounts/me`；不拦 → 真后端 401 → clearSession 跳 `/login` → 假绿。由 lefthook + `pr-validation.yml` 的 `check-e2e-seed-auth-mock` 强制；唯一豁免 = 真后端 smoke 标 `e2e-seed-auth-mock-check: real-backend-exempt`。

2. **refresh-token 端点必 mock（本规则约束，CI 不强制）**：任何会触发 **authed 业务 401** 的 spec —— 401 命中 003-tokens refresh 拦截器的 retry-once；不 mock refresh 端点 → refresh 失败 → clearSession 误登出跳 `/login`（per memory `reference_authed_business_401_triggers_refresh_interceptor`）。该触发条件非静态可判（取决于 spec 是否打到 authed 业务 401），故无 CI gate，写 e2e 时自查。public 流不触发，无需。

## 断言可用性：`react-native-web` 不认 `accessibilityState`

🚨 **`react-native-web@0.21` 完全不处理 `accessibilityState`**（dist 内零处理）⇒ web DOM 上**永远不会出现** `aria-selected` / `aria-checked` 这类属性，即便源码写了。

后果是这类断言**两个方向都不可用**：

- **正向**（`expect(tab).toHaveAttribute('aria-selected', 'true')`）→ 必红，但红的是渲染层不支持，不是功能坏了；
- **反向**（`expect(page.locator('[aria-selected]')).toHaveCount(0)`）→ **恒真 = 假绿**，任何页面都成立，等于没断言。

⇒ **选中态/勾选态改验两层**：① **值面自比较** —— 取选中与未选中元素的 computed style 互相对照（别硬编码具体色值，那会随 token 改动而碎）；② **功能面** —— 点了之后内容真的换了（`section.data` 变了、URL 变了、请求发了）。

🚫 **不要为了让 web 断言绿去改组件** —— 源码侧写 `accessibilityState` 是 RN 正道，真机读屏器依赖它；改组件迁就 web 渲染层的缺失 = 拿 a11y 换一条测试。**读屏器语义只能真机验**。

实证：047 T035 首轮 4 条红全是这条；同片另一条只能留真机的是**大规模虚拟化窗口**（`VirtualizedList` 默认 `windowSize=21` ≈369 行，而 e2e 承受得起的行数够不到那条线，web 下全渲染 ⇒ 「只渲染视口那一窗」在 web 验不出来）。

> 测试分层：UI / render / 交互走本层 Playwright Expo Web；纯逻辑走 vitest（per [mobile-impl-playbook](mobile-impl-playbook.md)）。
