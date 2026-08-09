---
feature_id: 005-device-management
spec_ref: ./spec.md
plan_ref: ./plan.md
status: done
created_at: '2026-05-29'
amends: '#201 (server US1-4); p4 子 plan B2'
---

# Tasks (client amend): 005-device-management — US5 登录管理屏（A→B→C 链的 B2）

**Spec**: [`spec.md`](./spec.md) § US5 / FR-C01..C09 / FR-S15 / SC-C01..C05 | **Plan**: [`plan.md`](./plan.md) § Client UI Plan | **Branch**: `005-device-management-client`

> server US1-4（`tasks.md`，#201）已 ship 不动；本文 = client 收口 + FR-S15 contract polish，server↔app 同 1 PR。

## Format

`- [ ] TC0NN [P?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- 层 = `[Server]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]`（**含一处 server 改** —— FR-S15 仅 `@ApiParam` 注解 + api-client regen，无 use case 逻辑）
- **TDD（强制）**：纯逻辑（`formatLastActive` / `mapDeviceError`）内联绑 **vitest**（红→绿→typecheck/lint→`[X]`→commit，6 步闭环，per `.claude/rules/implement-task-closure.md`）；presentational（DeviceIcon / 屏 / sheet）= typecheck/lint + **Playwright Expo Web e2e**（= US5 Independent Test 验收）
- 无 task-meta JSON（手动模式，per p3 §3）
- **drift guard 注意**：lefthook `tasks-md-drift` 可能只 glob `tasks.md` → 本 `tasks-client.md` 的 `[X]` flip 靠**手动纪律 + after_implement 软 hook**自守（每 task 同 commit stage 本文件）
- port 源：旧 app `~/Documents/projects/no-vain-years/no-vain-years-app/apps/native/`；import remap `@nvy/auth`→`~/auth`、`@nvy/design-tokens`(`colors`)→`~/theme`(`tokens.colors.*`)；相对 import **extensionless**（Metro web 陷阱，ESLint 已拦）

## Path Conventions

- 屏 route 文件（仅 `_layout`/`index`/`[recordId]` 进 `app/`）：`apps/mobile/app/(app)/settings/account-security/login-management/`
- app-local 制品：`apps/mobile/src/auth/`（wrapper `use-devices.ts` + `device-errors.ts`）/ `apps/mobile/src/format/`（`datetime.ts`）/ **`apps/mobile/src/settings/login-management/`（非 route 组件 `DeviceIcon` + `RemoveDeviceSheet` —— 禁进 `app/`，否则 phantom route）**
- server：`apps/server/src/auth/device-management.controller.ts`（FR-S15）/ `packages/api-client/`（regen）
- e2e：`apps/mobile/e2e/`（seed-authed via `addInitScript`；mock API `_support/api-mock.ts` `mockJson`）

---

## Phase 1: Foundational（阻塞 US5 — server contract + 纯逻辑 + wrapper）

- [x] TC01 [Server] [Contract] **FR-S15**：`apps/server/src/auth/device-management.controller.ts` revoke 的 `@ApiParam({ name:'recordId', ... })` 加 `type: 'string'` → 跑 `pnpm exec nx affected -t generate --base=origin/main`（server openapi → Orval regen）→ verify `packages/api-client/src/generated/devices/devices.ts` revoke 变量 `recordId: number → string` + `api-client` / `mobile` typecheck 绿。**纯注解，server 运行时不变**（`@Param(ParseBigIntPipe) recordId: bigint` 已从路径 string 解析）；**无新 server 测**（既有 revoke IT 回归绿）。commit 含 controller + 全部 regen 产物
- [x] TC02 [P] [Mobile] port `formatLastActive` → `apps/mobile/src/format/datetime.ts`（旧 app `lib/format/datetime.ts`：UTC-invariant，`granularity: 'minute'`→`YYYY.MM.DD HH:mm`、`'second'`→`+:ss`）+ `datetime.spec.ts`（**vitest，先红后绿**）：minute / second 两 granularity、UTC 不随时区漂移、月/日/时零填充、跨月跨年边界
- [x] TC03 [P] [Mobile] **重写** `mapDeviceError` + `deviceErrorCopy` → `apps/mobile/src/auth/device-errors.ts`（旧 app `lib/error/device-errors.ts`，但 **for mono `AxiosError<ProblemDetailResponse>`** —— `axios.isAxiosError(e)` + `e.response?.status` + `e.response?.data?.code`）+ `device-errors.spec.ts`（**vitest，先红后绿**）：401→session_expired / 403+`ACCOUNT_IN_FREEZE_PERIOD`→frozen / 404+`DEVICE_NOT_FOUND`→not_found / 409+`CANNOT_REMOVE_CURRENT_DEVICE`→cannot_remove_current / 429→rate_limit / ≥500→network / `TypeError`→network / 其余→unknown + 每 kind 文案。**禁** import `@nvy/api-client` `ApiClientError`/`ResponseError`（旧栈类型，mono 不存在）
- [x] TC04 [Mobile] wrapper `apps/mobile/src/auth/use-devices.ts`：`useDevices()` 包 Orval `useDeviceManagementControllerList`（**单页** `{ axios:{ params:{ size:100 }}}`，返 `{ items, isLoading, isError, refetch }`）+ `useRevokeDevice()` 包 `useDeviceManagementControllerRevoke`（`onSuccess`→`queryClient.invalidateQueries({ queryKey: getDeviceManagementControllerListQueryKey() })`，**不导航**）；export `getDeviceManagementControllerListQueryKey` 供详情页 cache-read。依赖 TC01（`recordId: string`）。presentational hook 无单测，靠 typecheck/lint + 下游 e2e

## Phase 2: User Story 5 — 登录管理屏（设备列表 + 远程撤销，P1）🎯

**Independent Test**（spec US5）：seed authed（注入 `x-device-id`）→ mock `GET /api/v1/auth/devices` 混 current + 另一设备 + legacy 行（`deviceName=null`/`deviceType=UNKNOWN`/`location=null`）→ 进登录管理屏 → 列表渲染 + 「本机」徽标 + UNKNOWN fallback 图标 + 「—」地点 → 点非当前设备 → `[recordId]` 详情 4 字段 → 移除 → sheet 确认 → mock `DELETE /api/v1/auth/devices/{recordId}` 200 → 行移除 + 返回；409/404 → 统一错误展示。

- [x] TC05 [P] [Mobile] port `DeviceIcon.tsx` → `apps/mobile/src/settings/login-management/DeviceIcon.tsx`（**非 route，落 `src/` 不进 `app/`**；5 形态 PHONE/TABLET/DESKTOP/WEB/UNKNOWN，stroke-outline svg；`colors.ink.muted`→`~/theme` `tokens.colors.ink.muted`，react-native-svg 已在 deps）。presentational 无单测
- [x] TC06 [Mobile] `app/(app)/settings/account-security/login-management/_layout.tsx`（port：`<Stack>` index title「登录管理」/ `[recordId]` title「登录设备详情」）+ `.../login-management/index.tsx`（port 列表：`useDevices()` → bespoke `DeviceRow`（`~/settings/login-management` DeviceIcon + 名 + 「本机」徽标 + `formatLastActive('minute')`·location + chevron）裹 `~/settings/primitives` `Card`；loading skeleton / 空列表 / 全屏错误态 = `~/ui ErrorRow`（**仅 `text`**）+ **另置重试 `Pressable`**（`refetch`，ErrorRow 无 onRetry）；行 `onPress`→`router.push('.../login-management/${item.id}')`；降级：`deviceName=null`→「未知设备」/`deviceType` 非枚举→UNKNOWN 图标/`location=null`→「—」）。依赖 TC04+TC05+TC02。FR-C01/C02/C03
- [x] TC07 [Mobile] port `RemoveDeviceSheet.tsx` → `apps/mobile/src/settings/login-management/RemoveDeviceSheet.tsx`（**非 route，落 `src/`**；RN `Modal` transparent slide，3 态 default/submitting/error 自持；prop `recordId: string`；confirm→`useRevokeDevice().mutateAsync({ recordId })`→成功 `onClose()`+`router.back()`，catch→`deviceErrorCopy(mapDeviceError(e))` 顶部 `~/ui ErrorRow`(text) 回 default；submitting 锁取消/scrim）。依赖 TC04+TC03。**非 Alert**（RN-Web 兼容）。FR-C05/C06
- [x] TC08 [Mobile] `login-management/[recordId].tsx`（port 详情：`useLocalSearchParams<{recordId:string}>`；数据 `queryClient.getQueryData<DeviceListResponse>(listQueryKey)`→`items.find(id===recordId)`，miss→fallback `useDevices()`，仍缺→「设备不存在或已被移除」NotFound+返回；4 字段 Card：设备名/登录地点/登录方式中文标签/`formatLastActive('second')` mono；`!isCurrent`→「移除该设备」按钮→`RemoveDeviceSheet`（import from `~/settings/login-management`））。依赖 TC04+TC02+TC07。**param `recordId` 非旧 `[id]`，string 直用无 `Number()`**。FR-C04
- [x] TC09 [Mobile] `apps/mobile/app/(app)/settings/account-security/index.tsx`「登录管理」行：006 disabled 占位 → **enabled** + `onPress`→`router.push('/(app)/settings/account-security/login-management')`（去 006 T006 标的 `// B2 ... 激活` 注释）。FR-C08 集成点
- [x] TC10 [Mobile-E2E] `apps/mobile/e2e/login-management.spec.ts`（seed authed via `addInitScript` 含 `x-device-id`；mock via `_support/api-mock.ts` `mockJson`）：① mock `GET /api/v1/auth/devices` 返 current+另一设备+legacy 行 → 进登录管理屏（经 account-security「登录管理」行）→ 断言列表渲染、current 行「本机」徽标且无移除入口、legacy 行「未知设备」+UNKNOWN 图标+「—」 ② 点非当前设备 → `[recordId]` 详情 4 字段 ③ 移除→sheet 确认→mock `DELETE .../{recordId}` 200 → 行移除+返回 ④ mock 409→「无法移除当前设备」错误态 ⑤ mock 404→「设备不存在或已被移除」。locator 优先 `getByRole`/`exact`。SC-C01..C04

## Phase 3: Polish & Verify

- [x] TC11 [Verify] 全量验收：`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main` 全绿（含 `runtime-smoke` —— mobile web export，per ADR-0040）+ `login-management.spec.ts` 全段绿 + grep 断言：无 `@nvy/auth`/`@nvy/design-tokens` 残留 import、无 `.js` 扩展相对 import、**无 `Number(` / `as unknown as number` recordId 桥接**（SC-C05）、无 `[id]` 残留路由 param。**catalog 无需改**（FR-S15 纯注解，无新 operation / 无边界变更）。spec/plan frontmatter `status` → `implemented`/`done`

---

## Dependencies & Story Completion Order

```text
Phase 1 Foundational
  TC01 (FR-S15 server+regen → recordId:string)  ──┐
  TC02 (formatLastActive ∥)                        │
  TC03 (device-errors ∥)                           │
  TC04 (wrapper use-devices)  ←── TC01             │
        │                                          │
        ▼                                          │
Phase 2 US5                                        │
  TC05 (DeviceIcon ∥)                              │
  TC06 (list)        ←── TC04 + TC05 + TC02        │
  TC07 (RemoveSheet) ←── TC04 + TC03               │
  TC08 (detail)      ←── TC04 + TC02 + TC07        │
  TC09 (flip 登录管理行)                            │
  TC10 (e2e)         ←── TC06 + TC08 + TC09         │
        │                                          │
        ▼                                          │
Phase 3  TC11 (verify) ←─────────────────────────┘
```

- **并行机会**：TC02 ∥ TC03 ∥ TC05；TC01 先行（解锁 recordId 类型）。
- **集成点**：TC09 一行 flip（006 disabled 占位 → 真 push）= A→B2 链打通。
- **关键 E2E** = TC10（US5 全程）—— 设备管理对用户可见的单一最高价值断言。

## Implementation Strategy

1. **Foundational first**：TC01（server FR-S15 + regen，解锁 string recordId）→ TC02/TC03（vitest 纯逻辑）→ TC04（wrapper）。
2. **US5 屏**：TC05 图标 → TC06 列表 → TC07 sheet → TC08 详情 → TC09 flip → TC10 e2e。
3. Phase 3 全量 gate（含 runtime-smoke + e2e）后单 PR ship（server contract polish + mobile client 同 PR）。
4. **模型路由**：implement 阶段切 Sonnet（per master）。

预估 11 task（1 server+contract + 3 foundational logic/wrapper + 6 US5 屏 + 1 verify）；含一处 server `@ApiParam` 注解改 + api-client regen，余为 mobile。
