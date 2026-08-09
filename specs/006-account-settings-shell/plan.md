---
feature_id: 006-account-settings-shell
spec_ref: ./spec.md
status: done
created_at: '2026-05-29'
updated_at: '2026-05-29'
adr_refs: ['0017', '0024', '0027', '0030']
context7_verified: []
---

# Implementation Plan: 006-account-settings-shell（设置 / 账号与安全 导航壳 — A→B→C 链的 B）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `006-account-settings-shell` | **Master**: [`account-migration master`](../../docs/private/plans/2026-05/05-25-account-migration-master.md) → 子 plan 4（client UI 链）B1 | **p4**: [`p4-client-ui-shell-chain`](../../docs/private/plans/2026-05/05-25-account-migration-p4-client-ui-shell-chain.md)

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**（per p3 §3）。
> **纯 mobile feature、无 server 改动**：壳是导航容器；退出登录复用 003 #196 已 ship 的 `logoutAll()` wrapper + 既有 api-client（**无新端点、无 contract regen**）。

## Summary _(mandatory)_

B1 = client UI 链 A→B→C 的 **B（settings 壳骨架）**，解锁 002「我的」页 ⚙️ 占位入口。三屏：①**设置首页**（`settings/index`，分组卡片：账号与安全 → push / 通用·通知·隐私·关于 disabled / 切换账号 disabled + 退出登录 destructive）②**账号与安全页**（`settings/account-security/index`：手机号脱敏行 disabled / 实名·第三方 disabled / **登录管理 disabled 占位**（B2 翻）/ **注销账号 disabled 占位**（B3 翻）/ 安全小知识 disabled）③ 退出登录交互（确认对话 → `logoutAll()` → 清会话 → AuthGate 回登录）。

范式 = **Strangler-Fig port**（复用皮 `~/theme` + `~/ui`，port 旧 app `apps/native/app/(app)/settings/` 设置屏结构 + `components/settings/primitives.tsx`，import remap 到 mono per ADR-0030）。旧 app 设置屏已是视觉成熟成品 → B1 直接 port 完成态视觉（非 placeholder→mockup 两段，per p3 §Step4 / plan-4 类 1 note），但 **list-card primitives 保持 app-local**（`apps/mobile/src/settings/`，不进 `~/ui`，per 占位 UI 4 边界 + plan-4 决策）。新增纯逻辑 util `maskPhone`（`apps/mobile/src/format/phone.ts`）。

**关键集成点**：002 `profile.tsx` 的 ⚙️ 现 `router.push('/(app)/settings' as Parameters<...>)`（强转占位，route 未建）→ B1 建 route 后该 cast 可移除（FR-C02）。「登录管理」「注销账号」行在 B1 为 disabled 占位，B2(amend 005) / B3(amend 004) ship 时单行 flip 为真实 `router.push`（clarify 2026-05-29 定）。

## API Contracts _(mandatory)_

**无新增 server 端点。** 退出登录复用既有：

| # | Method | Path | Auth | 消费方式 | trace FR |
|---|---|---|---|---|---|
| （复用）| POST | `/api/v1/accounts/logout-all` | bearer | 经既有 `logoutAll()` wrapper（`apps/mobile/src/auth/logout-all.ts`，调 `accountTokenControllerLogoutAll`，#196 已 ship）；wrapper `finally` 无条件 `clearSession`、**不导航** | FR-C05, FR-C06 |

- api-client `accountTokenControllerLogoutAll` 已生成（`packages/api-client/src/generated/accounts/accounts.ts:240`）→ **无 `nx affected -t generate` regen 需求**（Constitution V 同步链对本批 vacuous）。
- 读 `phone` / 登出经 `clearSession` 走 `useAuthStore`（`apps/mobile/src/auth/store.ts` 已暴露，无改动）。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则（`.specify/memory/constitution.md`） | 状态 | 备注 |
|---|---|---|
| I. SDD（NON-NEGOTIABLE） | ✅ | spec ✅ → clarify ✅（1 问答 + 2 grep 自决写回）→ plan（本）→ tasks → analyze → implement |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ | `maskPhone` 纯逻辑 → vitest 红绿（per mono 测试分层 logic=vitest）；导航 / 渲染 / 登出全链 / disabled 不导航 → Playwright Expo Web e2e（UI=Playwright）。presentational primitives 无单测（typecheck/lint + e2e 覆盖） |
| III. Atomic 30min-2h + 独立 commit | ✅ | tasks 按此拆；纯 mobile 单 PR |
| IV. Module Boundary（扁平 + 贫血 + 护城河） | ✅（mobile 维度）| 无 server module 改动 → 服务端 Moat N/A。mobile 维度遵 ADR-0030 包 5→2：primitives/maskPhone app-local（`src/settings`/`src/format`），**不进 `~/ui`**（占位 UI 4 边界）；复用 `~/auth`(logoutAll/store) `~/theme` `~/ui`（既有），import 走 `~/` alias 不跨包新建 |
| V. 类型同步链 Nx-driven | ✅（vacuous）| 无新 server endpoint / DTO → openapi 不变 → 无 api-client regen；消费的 `logoutAll` 端点契约 #196 已固化 |

## Architecture Notes _(mandatory)_

### 路由结构（Expo Router，per 002 CL-006：落 `(tabs)` 之外，底 tab 自动隐藏）

```text
apps/mobile/app/(app)/settings/
  _layout.tsx                 [B1] <Stack screenOptions headerShown>; index title「设置」; account-security headerShown:false（嵌套 stack 自带 header）
  index.tsx                   [B1] 设置首页（4 组卡片 + 退出登录）
  account-security/
    _layout.tsx               [B1] <Stack>; index title「账号与安全」（B2/B3 ship 时各自加 Stack.Screen）
    index.tsx                 [B1] 账号与安全（手机号脱敏 + disabled 行 + 2 个延后激活占位）
```

> B1 **只建上述 4 文件**；`login-management/` `delete-account.tsx` `phone.tsx` `legal/` 等不建（disabled 占位行不导航；B2/B3 各自建自己的 route + 在 `account-security/_layout.tsx` 注册 Stack.Screen + 把 index 对应行 flip 为真实 push）。

### Strangler-Fig port 映射（旧 app → mono）

| 旧 app（`apps/native/`）| mono 落点 | import remap / 适配 |
|---|---|---|
| `app/(app)/settings/index.tsx` | `apps/mobile/app/(app)/settings/index.tsx` | `@nvy/auth`→`~/auth`（`logoutAll`）；**删法务页脚**（FR-C03，避免 dangling route）；`Card/Row/Divider` 从 `~/settings/primitives` 引 |
| `app/(app)/settings/_layout.tsx` | 同路径 mono | 删 `legal` Stack.Screen（不建） |
| `app/(app)/settings/account-security/index.tsx` | 同路径 mono | `@nvy/auth`→`~/auth`（`useAuthStore`）；`maskPhone` 从 `~/format/phone` 引；手机号行 + 登录管理行 + 注销账号行**改 disabled 占位**（去 onPress，加 disabled） |
| `app/(app)/settings/account-security/_layout.tsx` | 同路径 mono | 只留 index Stack.Screen（phone/delete/login-management 不建） |
| `components/settings/primitives.tsx`（`Card`/`Row`/`Divider`）| `apps/mobile/src/settings/primitives.tsx`（**app-local，非 `~/ui`**）| `@nvy/design-tokens`→`~/theme`；className token 对齐 mono（见 D2） |
| `lib/format/phone.ts`（`maskPhone`）| `apps/mobile/src/format/phone.ts` | 纯逻辑直 port + vitest |

- **Web 确认对话分支必 port**（Context 已述）：`settings/index.tsx` 的 `confirmLogout` Platform 分支（Web `window.confirm` / native `Alert.alert`）原样保留 —— RN-Web `Alert.alert` 单按钮 fallback 会 ignore buttons 数组致 onPress 不 fire（load-bearing）。
- **登出后导航**：mono `logoutAll()` 不导航，AuthGate 观察 `isAuthenticated` 翻转重定向（与 login 同模式）。旧 app `handleLogout` 末尾的显式 `router.replace('/(auth)/login')` 在 mono 冗余但无害 → port 时**保留显式 replace 兜底**（AuthGate + 显式双保险，避免 web 上 AuthGate 重定向时序边缘）。

### UI 类别处理（类 1，但 port 成熟视觉）

类 1 标准 UI。**但** port 源（旧 app 设置屏）已是 PHASE-2 视觉成熟成品 → B1 直接落完成态视觉（Strangler-Fig skin 复用 `~/theme` token），**不走 placeholder→mockup 两段、不加 `// PHASE 1 PLACEHOLDER` banner、不另起 mockup 子流程**（per p3 §Step4 / plan-4 类 1 note + memory `design_tokens_reuse_not_redesign`）。视觉决策已凝固在 port 源，本批仅做 token/className 对齐 + 行为适配。

### Cross-cutting

- **AuthGate 复用**：settings 路由在 `(app)/` 组内，受第一层 `!authed → /(auth)/login` 保护（FR-C10），不重立。
- **无 contract / 无 server / 无新依赖**：B1 不装任何 npm 包（RN + NativeWind + 既有 `~/` 模块足够）。
- **Metro `.js` 陷阱**（per memory `metro_web_cannot_resolve_js_extension_imports`）：新文件相对 import 一律 **extensionless**（mobile 侧 ESLint `no-restricted-syntax` 已机械拦）。
- **002 ⚙️ cast 清理**：route 建立后，`profile.tsx` 的 `router.push('/(app)/settings' as Parameters<...>)` 可去 cast（FR-C02）；作低风险收尾 task，全仓 grep 确认无其他强转占位引用。

## UI 结构（port 成熟视觉，复用 `~/theme`；非占位版）

**设置首页**（`settings/index`）— ScrollView + 3 张 Card：

1. Card：`账号与安全`（Row，showChevron，onPress → `router.push('/(app)/settings/account-security')`）
2. Card：`通用` / `通知` / `隐私与权限` / `关于`（4 Row + Divider，全 `disabled`）
3. Card：`切换账号`（Row disabled，center，无 chevron）+ Divider + `退出登录`（Row destructive，center，无 chevron，`busy`=登出 in-flight，onPress → `confirmLogout`）
   - **无法务页脚**（旧 app 的两个 legal Pressable 链接删除）

**账号与安全页**（`settings/account-security/index`）— ScrollView + 3 张 Card：

1. Card：`手机号`（Row，value=`maskPhone(phone)`，**disabled**）+ Divider + `实名认证`（disabled）+ Divider + `第三方账号绑定`（disabled）
2. Card：`登录管理`（Row，**disabled 占位** ← B2 翻真实 push）
3. Card：`注销账号`（Row destructive，**disabled 占位** ← B3 翻）+ Divider + `安全小知识`（disabled）

**primitives**（`~/settings/primitives`）：`Card`（圆角卡片容器）/ `Row`（props: `label` / `value?` / `disabled?` / `destructive?` / `showChevron?` / `align?` / `busy?` / `onPress?`）/ `Divider`（细分隔线）。视觉走 `~/theme` token + NativeWind class。

> mockup 留迹：本 feature **无独立 mockup 阶段**（视觉源 = 旧 app 成品）。plan UI 段即终版，无需 PHASE 2 回填。

## Open Decisions Resolved（plan→tasks gate review — ⚠️ 标注项请 review）

| # | 决策 | 结论 | gate? |
|---|---|---|---|
| **D1** scope 切分 / 延后行呈现 | 见 plan-4 + clarify | **分 3 feature**（B1 壳 / B2 设备 amend 005 / B3 注销 amend 004，设备先）；B1 即渲染登录管理/注销账号为 disabled 占位，B2/B3 单行 flip（plan-4 Q1/Q2 + clarify 2026-05-29 user 定） | — |
| **D2** className token 对齐 | 旧 app 用 `bg-surface-sunken`/`text-accent`/`px-md` 等 | **已实证 token 不缺**：mono `~/theme/colors.ts` 含 `surface.sunken`(#F2F4F7)/`accent`(#FF8C00)/`ink`/`line`/`brand` 全套（迁 login/profile 时 meta design-tokens 已整体直搬）；`tailwind.config.ts:17 colors: tokens.colors` 喂入；`profile.tsx` 已在用 `bg-surface-sunken`/`text-ink` → 旧设置屏 className **原样即解析**，无对齐工作。**政策**（若未来真遇缺失 token）：从 meta `design-tokens` **直搬原值进 `~/theme/colors.ts`**（直搬不重写，per memory `design_tokens_reuse_not_redesign`），**禁映射近似 / claude-design 重设计**（变相 drift） | ✅ resolved |
| **D3** 登出后导航机制 | AuthGate 自动 vs 显式 replace | **双保险**：`logoutAll()`(清会话→AuthGate 重定向) + port 旧 app 末尾显式 `router.replace('/(auth)/login')` 兜底（web AuthGate 时序边缘防护） | — |
| **D4** primitives 落点 | `~/ui` vs app-local | **app-local `apps/mobile/src/settings/primitives.tsx`**（占位 UI 4 边界禁占位期引 `~/ui` 抽象；升 `~/ui` 需「第二个 settings 外模块复用」，plan-4 决策） | — |
| **D5** settings header | native Stack vs 自定义 | **Expo Router native Stack header**（title + 系统返回键，port 旧 app `_layout`；clarify grep 自决） | — |
| **D6** maskPhone 格式 | — | `<国码> <前3>****<后4>`（中段 ≥4 星）/ 缺失→`未绑定`（clarify grep 自决，port 旧 app 实现含国码白名单 longest-prefix） | — |

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| — | — | — |

**Note**：纯导航壳 + 1 个登出动作（复用既有 wrapper）+ 2 个 port 屏 + 1 纯函数 util + 3 presentational primitives。无 server / 无 form / 无新依赖 / 无 contract regen。复杂度显著低于 002-005 任一后端 feature。

## Performance Budget

N/A —— 无新 server 端点。退出登录复用 003 `logout-all`（perf 预算在 003 frontmatter，p95 80 / p99 150ms）。客户端导航为本地渲染，无网络预算项。

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

建议 tasks.md 层级（纯 mobile 单 PR，per p3 §Step2；每 task 30min-2h + 独立 commit + TDD 红绿 + `[X]` flip）：

- `[Mobile]` util：`apps/mobile/src/format/phone.ts`（`maskPhone` port）+ `phone.spec.ts`（vitest：`+86` 脱敏、国码白名单 longest-prefix（`+86138...` 不误切 `+861`）、`null`/空/越界/非数字 → `未绑定`、中段 ≥4 星）→ **先红后绿**
- `[Mobile]` primitives：`apps/mobile/src/settings/primitives.tsx`（`Card`/`Row`/`Divider` port，`@nvy/design-tokens`→`~/theme`；className 原样解析，D2 已实证不缺）—— presentational，无单测，靠 typecheck/lint + 下游 e2e
- `[Mobile]` 设置首页：`app/(app)/settings/{_layout,index}.tsx`（port，删法务页脚，`~/auth` logoutAll，`confirmLogout` Platform 分支保留）
- `[Mobile]` 账号与安全页：`app/(app)/settings/account-security/{_layout,index}.tsx`（port，`maskPhone` 行 + disabled 占位行（手机号/实名/第三方/登录管理/注销账号/安全小知识），登录管理 & 注销账号标注「B2/B3 激活点」注释）
- `[Mobile]` ⚙️ 解锁：`app/(app)/(tabs)/profile.tsx` 去 `as Parameters<...>` cast（route 已建）+ 全仓 grep 确认无残留强转占位
- `[Mobile-E2E]` Playwright Expo Web（`apps/mobile/e2e/settings-shell.spec.ts`，复用 `_support/api-mock.ts` `mockJson`，仿 `profile.spec.ts`/`cancel-deletion.spec.ts`）：
  - US1：seed authed → profile 点 ⚙️ → URL 进 `/(app)/settings`、卡片渲染、**底 tab bar 不可见** → 系统返回 → 回 profile、底 tab 恢复
  - US2：进账号与安全 → 手机号行显脱敏（`+86 1XX****XXXX`，断言无完整号）→ 登录管理/注销账号行 disabled（点击无导航）
  - US3：点退出登录 →（web）`window.confirm` 确认 → mock `POST /accounts/logout-all` 204 → 会话清、落 `/(auth)/login`；另路径 mock 500 → 仍登出落登录页；取消 → 留页保持登录
  - locator 优先 `getByRole`/`exact`，警惕中文 label 子串撞
- `[Verify]`：`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main` 全绿（**含 `runtime-smoke`** —— mobile web export 路径靠它 + e2e 抓，per ADR-0040）+ web e2e 绿

预估 task 数：~7-9（util + primitives + 2 屏 + ⚙️ 解锁 + e2e + verify；无 server / 无 contract / 无新依赖）。**复杂度最低的一个 feature**；主要风险 = Metro extensionless import + web Alert fallback（均有 memory/既有机制兜底）；className token 已实证不缺（D2 resolved，原样解析）。

---

**Plan Version**: 1.0.0 | **Created**: 2026-05-29 | **ID-namespace**: US1-3 / FR-C01..C10 / SC-001..006
