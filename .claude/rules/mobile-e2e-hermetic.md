---
paths:
  - 'apps/mobile/e2e/**/*.spec.ts'
  - 'apps/mobile/e2e/contract-smoke/*.contract.ts'
---

# Mobile e2e hermetic 边界（path-triggered，写 Expo Web e2e spec 时自动加载）

seed-authed e2e（`addInitScript` 注 `nvy-auth` 假 session）必须把后端边界拦死，否则泄漏到 `:3000` → env-dependent flake（CI 恰好无后端时假绿）。两条边界：

1. **GET /me 必拦（CI 硬强制）**：`mockJson(page, ME_URL, …, 'GET')` 或 raw `page.route(ME_URL, …)`。seed session 无 accessToken，boot 时 AuthGate `useMe` 必发 `GET /accounts/me`；不拦 → 真后端 401 → clearSession 跳 `/login` → 假绿。由 lefthook + `pr-validation.yml` 的 `check-e2e-seed-auth-mock` 强制；唯一豁免 = 真后端 smoke 标 `e2e-seed-auth-mock-check: real-backend-exempt`。

2. **refresh-token 端点必 mock（本规则约束，CI 不强制）**：任何会触发 **authed 业务 401** 的 spec —— 401 命中 003-tokens refresh 拦截器的 retry-once；不 mock refresh 端点 → refresh 失败 → clearSession 误登出跳 `/login`（per memory `reference_authed_business_401_triggers_refresh_interceptor`）。该触发条件非静态可判（取决于 spec 是否打到 authed 业务 401），故无 CI gate，写 e2e 时自查。public 流不触发，无需。

## Mock 是契约镜像，不是调用序

🚨 **handler MUST 是 `(请求参数, canonical 数据集) → 响应` 的纯函数** —— 判据在 mock 里**真的算一遍**，不是按测试编排摆好两份答案。

🚫 **反面写法**：`callCount === 0 ? 默认表 : 收窄表`。它在**当时那个文件的所有断言下照样全绿**，而客户端一旦改变请求次数（加个 `invalidateQueries`、加个预取），mock 就静默返回错误的那一份 —— **typecheck 拦不住、断言照样绿**。

📌 **「纯函数」不等于「恒定答案」**。允许按入参给不同出参，禁的是把**调用次序**当入参：

| 形态                                                      | 判定          |
| --------------------------------------------------------- | ------------- |
| `perspective === 'rent' → 500`（单视角失败）              | ✅ 参数驱动   |
| `perspective → 不同 asOf`（跨业务日不一致）               | ✅ 参数驱动   |
| `(params) → (response, delay)`（迟到响应 / 预取命中与否） | ✅ 仍是纯函数 |
| `callCount === 2 → 换一份表`                              | 🚫 调用序     |

📌 **恒定答案常常是更严的测法**：验「最多重取一次」时让 handler 恒答不一致，「无限重取」就直接表现为**请求数爆炸**；`callCount` 版本反而会在第二次「自己修好」，把 bug 藏起来。

📌 **撞到「同一组参数、前后要给不同答案」的分支，先想能不能改由参数表达** —— 如「重取后恢复一致」可由「用户改了条件 ⇒ 换了 query key ⇒ 换了参数」承载。真表达不了 ⇒ **如实登记一条覆盖不到，MUST NOT 塞调用序标志冒充覆盖**（一条恒真断言比缺一条更坏，它会冒充覆盖）。

实证：`052` T013 立此纪律（原文在其 `tasks.md`，2026-08-14 提进本 rule 使其随路径自动装载）；`053` 把选约表请求数**从 1 变成 3** 并加了错峰预取 —— 正是它预言的那类改动。`053` T014 期实撞：`052` 遗留的请求日志断言必须重定成只看**非 `perspective` 参数**，才免疫请求数变化。

## 断言可用性：`react-native-web` 不认 `accessibilityState`

🚨 **`react-native-web@0.21` 完全不处理 `accessibilityState`**（dist 内零处理）⇒ web DOM 上**永远不会出现** `aria-selected` / `aria-checked` 这类属性，即便源码写了。

后果是这类断言**两个方向都不可用**：

- **正向**（`expect(tab).toHaveAttribute('aria-selected', 'true')`）→ 必红，但红的是渲染层不支持，不是功能坏了；
- **反向**（`expect(page.locator('[aria-selected]')).toHaveCount(0)`）→ **恒真 = 假绿**，任何页面都成立，等于没断言。

⇒ **选中态/勾选态改验两层**：① **值面自比较** —— 取选中与未选中元素的 computed style 互相对照（别硬编码具体色值，那会随 token 改动而碎）；② **功能面** —— 点了之后内容真的换了（`section.data` 变了、URL 变了、请求发了）。

🚫 **不要为了让 web 断言绿去改组件** —— 源码侧写 `accessibilityState` 是 RN 正道，真机读屏器依赖它；改组件迁就 web 渲染层的缺失 = 拿 a11y 换一条测试。**读屏器语义只能真机验**。

实证：047 T035 首轮 4 条红全是这条；同片另一条只能留真机的是**大规模虚拟化窗口**（`VirtualizedList` 默认 `windowSize=21` ≈369 行，而 e2e 承受得起的行数够不到那条线，web 下全渲染 ⇒ 「只渲染视口那一窗」在 web 验不出来）。

## 契约冒烟（`*.contract.ts`，跨端 feature 第二层）

- 用**生成的** `@nvy/api-client` 打 `bootRealBackend()` 起的真 server；不做 UI 断言（点通归 hermetic）。
- **写完从另一个端点读回**证真落库；专属 ticker / 数据 + 末尾自清理，保同 boot 内多 spec 幂等。
- 多分支（happy + 降级 / 错误路径）走 **content-driven**：Fake provider 读 user message 内嵌关键字自行分支（先例 `chat-model-switch.contract.ts`），**不靠 DI override**（外部真进程拿不到 `overrideProvider`）；分支只在命中关键字时触发，Fake 默认行为零改。
- 新 spec 在 `contract-smoke/run.ts` `SPECS` 注册一行；HOW 详版 [mobile-impl-playbook § 5](../../docs/conventions/mobile-impl-playbook.md)。

## testID

定位一律 `getByTestId`，体例 `<feature>-<element>[-<state>]` → [mobile-testid.md](../../docs/conventions/mobile-testid.md)。

> 测试分层：UI / render / 交互走本层 Playwright Expo Web；纯逻辑走 vitest（[testing.md](../../docs/conventions/testing.md) 不变量 4）。
