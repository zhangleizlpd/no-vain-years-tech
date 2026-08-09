# Frontend Directory & Coding Rules

> mono frontend (`apps/mobile/`) coding 操作约束单源。物理布局 / 包边界 / pnpm 策略 / TS module resolution 已由 ADR 治理，本文件聚焦操作纪律（API client 单源 / 依赖引入 / token 存储）。

按需 read 触发：改 `apps/mobile/src/**` / 加 frontend dependency / 处理凭证存储。

## 目录与边界（已由 ADR 治理）

| 关心点                                                               | 单源                                                                                                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| apps/\* + packages/\* 物理边界 + ESLint boundaries + Nx project 边界 | [ADR-0032](../adr/0032-backend-bounded-context.md) + [ADR-0043](../adr/0043-server-flat-module-paradigm.md)（ADR-0020 已 Superseded）；scope-tag depConstraints SoT 在 `eslint.config.mjs` |
| Package decomposition（mono 5 包减 2，留 api-client + types）        | [ADR-0030](../adr/0030-package-decomposition.md)                                                                                                                                           |
| pnpm policy（shamefully-hoist + Expo 兼容）                          | [ADR-0028](../adr/0028-monorepo-pnpm-policy.md)                                                                                                                                            |
| TS module resolution（bundler 基线 + apps/server nodenext override） | [ADR-0029](../adr/0029-ts-module-resolution-policy.md)                                                                                                                                     |
| 业务模块字符串前后端一致                                             | [business-naming.md](business-naming.md)                                                                                                                                                   |

本文件不重复物理目录布局 / 跨包依赖纪律 / pnpm 配置 / TS 解析策略。

## API client 单源

- mobile 通过 `@nvy/api-client` workspace 包消费 server endpoints；**禁手写 `fetch` / `axios` 直调业务 API**
- API client 由 Orval typed codegen 派生（per [ADR-0027](../adr/0027-frontend-data-test-layer.md)；同步链见 [sdd.md § server impl 后的 mobile types 同步](sdd.md#server-impl-后的-mobile-types-同步)）
- HTTP wire format（URL / method / 错误响应 / 鉴权 header）见 [api-contract.md](api-contract.md)

## 依赖引入

- **Expo SDK / RN 生态包**（任何 `expo-*` / `react-native` / `react-native-*`）必走 `cd apps/mobile && pnpm exec expo install <pkg>`；**禁** `pnpm add` — 后者拉 npm latest，撞 Expo SDK 兼容版本错位
- **非 Expo 包**（`zustand` / `@tanstack/react-query` / `react-hook-form` / `zod` 等纯 JS lib）走 `pnpm add --filter mobile <pkg>` 或 `pnpm add -Dw <pkg>`
- **版本漂移修复**：`cd apps/mobile && pnpm exec expo install --fix`
- 不确定包属哪类时，停下来问

## 客户端 token 存储

- `refresh_token` / `access_token` 等敏感凭证只走 [`expo-secure-store`](https://docs.expo.dev/versions/latest/sdk/securestore/)（实证 `apps/mobile/src/auth/device-store.ts`）
- **禁**写进 MMKV / AsyncStorage（明文 / 未加密）
- 后端 token issue / verify / rotation 设计见 [ADR-0037 JWT HS256 双 token + Redis jti 白名单](../adr/0037-security-credentials-governance.md)
