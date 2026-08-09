---
paths:
  - 'apps/mobile/src/**/*.ts'
  - 'apps/mobile/src/**/*.tsx'
  - 'apps/mobile/app/**/*.tsx'
---

# Mobile 实现 guardrails（path-triggered，改 mobile feature 文件自动加载）

> 🚨 **CRITICAL — 写 Expo/RN feature 时严守。** 详版 + mockup 模板 + 实证锚见 [`docs/conventions/mobile-impl-playbook.md`](../../docs/conventions/mobile-impl-playbook.md)（单源，本 rule 不复述）。

## RHF 表单 4 铁律（Golden Sample 分层）

唯一标准 = RHF + zodResolver。① **Controller ≠ register**（RN 必用 `<Controller>`）；② **表单态 ≠ 副作用态**分层；③ **isSubmitting 单源**（用 `formState.isSubmitting`，不另设 loading bool）；④ **错误 + a11y 一体**。

**起手对照样板**（文件头 `// GOLDEN SAMPLE` banner）：4 铁律逻辑权威 → `src/auth/use-login-form.ts`；最小标准编辑表单屏（默认 copy）→ `app/(app)/settings/account-security/name-edit.tsx`；进阶参照（复杂态机 + FROZEN modal + success overlay，login 专属勿整屏照抄）→ `app/(auth)/login.tsx`。分层见详版 § 1。

> **全量样板索引（跨 task kind）→ [golden-sample-registry](../../docs/conventions/golden-sample-registry.md)**（「task kind → 样板文件」单一索引；本 rule 仅列高频表单样板）。

## Strangler-Fig port

复用皮、重写肉：skin = **复用** `~/theme` + `~/ui`（design-token 直搬**不重设计**）；muscle = **Orval 函数式 hook**（**非 class** 包装、axios **不删**）；nervous/engine = 重写但沿用 Expo Router 结构。

## Mockup（design 先行，统一 mockup-first）

走 Claude Design **2 段模板**（context 表 + prompt block）→ 产出 **HTML preview baseline**（非 .tsx）→ 翻 RN，**0 新 token**。模板见详版 § 3 + [sdd.md](../../docs/conventions/sdd.md) § 前端 UI 工作流。

## RN 布局陷阱（web e2e 视口宽松 → 系统性漏测，须真机 / 窄视口验）

无确定高度父容器（bottom-sheet / 动态 sheet 等）内**禁裸 `flex-1`**（`flexBasis:0` 会塌缩、子项被挤出屏不可点）→ 给 intrinsic / 固定尺寸（如键高 `h-16`）；width class **不约束 `ScrollView` frame**（按内容撑开）→ 包 `View` wrapper。共性：Playwright Web 视口够高/够宽，CI 全绿但真机崩——**这类容器尺寸约束改动须真机或窄视口验**，别只信 web e2e。

## hermetic e2e mock = 契约镜像，非调用序

Playwright hermetic mock（`route.fulfill` 拦 server 端点）**写依赖方契约**：stateful mock 持单一 canonical 状态（如 append-only `turns[]`），handler 是 `(request, 服务端状态)` 纯函数，`POST` 追加 / `GET` **无条件**返回当前状态；**禁**按测试编排标志 / 客户端信号分支（如 `briefGenerated ? turns : []` —— 真 endpoint 不会因此分支，判断法「真 endpoint 会因为这个条件分支吗？」）。否则客户端行为一改（加 `invalidateQueries` / refetch）就破，**typecheck 拦不住**（行为 / 时序耦合非形状）。**改共享 hook / util → 跑全 `runtime-smoke` 非单 spec**（blast radius = 整套 e2e）。详版 + 实证锚（032 FU-1 / FU-1a）见详版 § 6。

## mutation 必失效 list key（React Query 缓存陈旧）

create / delete / 改 list-visible 字段（title/status/updatedAt）的 mutation **必失效对应 list query key**，否则列表屏陈旧到重启（根因放大器：`staleTime 30s` + bottom-tabs 常驻挂载不重挂 + `refetchOnWindowFocus:false`，列表缓存后无触发器自动重取）。双重盲区：mutation 后**导航离开列表屏**眼睛看不到陈旧 + hermetic e2e「创建后首访列表」假绿。范式优先**共置 wrapper + `onSuccess` 焊死**（样板 `ideation/use-session-mutations.ts`；另一形态 `chat/use-conversations.ts`）。SSE/流式终态（非 mutation）在 done/aborted 手动失效（与 `chat` onDone→invalidate 同范式、TanStack 默认；invalidate 只重取活跃 query + staleTime 兜底，每轮低频成本可忽略，真高频每 token 才用 `setQueryData`）。详版 + 实证锚（032 create/converge/turn）见详版 § 8。

## 已有单一家（引用不复述）

Metro `.js` extensionless（memory + ESLint 已拦）/ 测试分层 vitest=logic·Playwright=UI（memory）/ 目录·凭据（[fe-directory-structure.md](../../docs/conventions/fe-directory-structure.md)）/ enum→copy 映射用 `Record<Enum, X>`（**非 `Partial<Record>`**，tsc 强制穷举、漏 enum 成员即编译红，如 `alert-copy.ts` `ALERT_CONDITION_META`）。
