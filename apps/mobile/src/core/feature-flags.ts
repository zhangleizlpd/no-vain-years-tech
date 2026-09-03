// 编译期 feature flags（build-time inlined）。
//
// 合规背景（方向 B，docs/private/plans/2026-06/06-14-markets-feature-gate-mechanism.md）：
// 公开发布版**不得展示任何交易所行情** —— 行情/投资/预警 family 仅在封闭内测版与 web
// 自用版保留。本 flag 在公开 EAS `production` profile 设为 off，其余构建（dev / 内测 /
// 预览 / web / 测试）设 on。
//
// 关键性质：
// 1. **默认 OFF（fail-safe）**：任何未显式 opt-in 的构建 = 投资/行情关闭。忘配 = 公开安全，
//    而非公开泄露。只有显式 `=== 'true'` 才放行。
// 2. **build-time 内联**：`process.env.EXPO_PUBLIC_*` 的**点访问**会被 Metro 在打包时替换为
//    字面常量（沿 src/core/api/setup.ts 既有模式）。括号访问 `process.env['…']` 不会内联 —
//    勿改写法。因为是 bundle 常量，OTA（eas update）无法翻转它 → 公开构建恒 off。
//    EVIDENCE: Expo 官方明文 —— 「Every environment variable must be statically
//    referenced as a property of `process.env` using JavaScript's dot notation for it
//    to be inlined」，且「`process.env['EXPO_PUBLIC_KEY']` or `const {EXPO_PUBLIC_X} =
//    process.env` is invalid and will not be inlined」。
//    https://docs.expo.dev/guides/environment-variables/ (2026-09-03 复核)。
//    🚨 解构赋值同样不内联 —— 这条本文件此前没写，改这行时最容易顺手踩。
//
// 注入点（per profile / target，见 06-14 plan §Deploy 绑定）：
//   - EAS production（公开/商店）           → "false"
//   - EAS internal / preview / development   → "true"
//   - nx serve / build / e2e / runtime-smoke → "true"（命令内联，见 apps/mobile/project.json）
export const FEATURE_MARKETS_ENABLED = process.env.EXPO_PUBLIC_FEATURE_MARKETS === 'true';
