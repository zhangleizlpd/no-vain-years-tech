---
paths:
  - 'apps/mobile/src/**/*.ts'
  - 'apps/mobile/src/**/*.tsx'
  - 'apps/mobile/app/**/*.tsx'
---

# Mobile 实现 guardrails（path-triggered，改 mobile feature 文件自动加载）

> 🚨 **CRITICAL — 写 Expo/RN feature 时严守。** 详版 + 实证锚见 [`docs/conventions/mobile-impl-playbook.md`](../../docs/conventions/mobile-impl-playbook.md)（单源，本 rule 不复述；本 rule 另持「RN 布局陷阱」「GHRV」两条 src 侧 invariant）。

## RHF 表单 4 铁律（Golden Sample 分层）

唯一标准 = RHF + zodResolver。① **Controller ≠ register**（RN 必用 `<Controller>`）；② **表单态 ≠ 副作用态**分层；③ **isSubmitting 单源**（用 `formState.isSubmitting`，不另设 loading bool）；④ **错误 + a11y 一体**。

**起手对照样板**（文件头 `// GOLDEN SAMPLE` banner）：4 铁律逻辑权威 → `src/auth/use-login-form.ts`；最小标准编辑表单屏（默认 copy）→ `app/(app)/settings/account-security/name-edit.tsx`；进阶参照（复杂态机 + FROZEN modal + success overlay，login 专属勿整屏照抄）→ `app/(auth)/login.tsx`。分层见详版 § 1。

> **全量样板索引（跨 task kind）→ [golden-sample-registry](../../docs/conventions/golden-sample-registry.md)**（「task kind → 样板文件」单一索引；本 rule 仅列高频表单样板）。

## Strangler-Fig port

port 老 app 屏 → 详版 § 2（复用皮、重写肉）。

## RN 布局陷阱（web e2e 视口宽松 → 系统性漏测，须真机 / 窄视口验）

无确定高度父容器（bottom-sheet / 动态 sheet 等）内**禁裸 `flex-1`**（`flexBasis:0` 会塌缩、子项被挤出屏不可点）→ 给 intrinsic / 固定尺寸（如键高 `h-16`）；width class **不约束 `ScrollView` frame**（按内容撑开）→ 包 `View` wrapper。共性：Playwright Web 视口够高/够宽，CI 全绿但真机崩——**这类容器尺寸约束改动须真机或窄视口验**，别只信 web e2e。

## hermetic e2e mock

改**共享 hook / util 行为** → 跑全 `runtime-smoke` 非单 spec（blast radius = 整套 e2e，typecheck 拦不住时序耦合；详版 § 6）。mock 写法 canonical = [`mobile-e2e-hermetic.md`](mobile-e2e-hermetic.md)（写 e2e spec 时自动装载）。

## mutation 必失效 list key

create / delete / 改 list-visible 字段（title / status / updatedAt）的 mutation **必失效对应 list query key** —— 否则列表陈旧到重启（`staleTime` + tabs 常驻不重挂 + `refetchOnWindowFocus:false`，无触发器重取）。范式优先**共置 wrapper + `onSuccess` 焊死**（样板 `ideation/use-session-mutations.ts`）；SSE / 流式终态在 done / aborted 手动失效。根因、盲区与业内依据见详版 § 8。

## 用手势的屏必自套 GestureHandlerRootView

根 `app/_layout.tsx` **不**全局挂 GHRV；用 `GestureDetector` / `SwipeRow` / `LongPressMenu` / `DraggableList` 的路由屏顶层自套 `<GestureHandlerRootView style={{ flex: 1 }}>`（漏套 = 一进屏红屏，web e2e 不一定触发；详版 § 9.1）。

## 已有单一家（引用不复述）

Metro `.js` extensionless（ESLint 已拦）/ 测试分层 vitest=logic·Playwright=UI（[testing.md](../../docs/conventions/testing.md) 不变量 4）/ 目录·凭据（[fe-directory-structure.md](../../docs/conventions/fe-directory-structure.md)；`refresh_token` 等持久化凭证走 expo-secure-store，`access_token` 仅内存，`auth/store.ts`）/ enum→copy 映射用 `Record<Enum, X>`（**非 `Partial<Record>`**，tsc 强制穷举、漏 enum 成员即编译红，如 `alert-copy.ts` `ALERT_CONDITION_META`）。
