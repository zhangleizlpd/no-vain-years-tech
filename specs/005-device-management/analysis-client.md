# Specification Analysis Report (client amend): 005-device-management — US5

> 跨 `spec.md`(§US5/FR-C/FR-S15/SC-C) / `plan.md`(§Client UI Plan) / `tasks-client.md` / `constitution.md` 一致性扫描（read-only 分析，本文件为报告留痕，per mono 约定）。生成于 2026-05-29（analyze→implement gate 前）。amend 改了**已 ship 的 005 spec**（#201），故 findings 重点 = server/client FR 交叉 + port-source 与 mono 现状的 drift。
>
> **手动 analyze**（非 `/speckit-analyze` skill）：branch `005-device-management-client` ≠ dir `005-device-management` 且 tasks 在 `tasks-client.md` → skill 的 prereq 脚本会 mis-resolve；per memory `mono_sdd_artifacts_diverge_from_speckit_skill` 手动对齐 mono 形态。

## Findings

| ID  | Category                         | Severity   | Location(s)                                   | Summary                                                                                                                                                                                                                                                                                                                               | Status / Recommendation                                                                                                                                                                                                            |
| --- | -------------------------------- | ---------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Inconsistency（e2e 落地精度）    | **MEDIUM** | tasks TC10 + spec US5 Independent Test        | e2e 涉及 `[recordId]` 详情页 URL —— **expo-router web export 隐藏 `(app)/` group 段**（memory `expo_router_web_hides_route_groups`）；Web 实际 URL = `/settings/account-security/login-management/<id>`（无 `(app)`）。TC10 主体是**点击驱动**导航（经「登录管理」行 + 设备行），风险较 006 低，但任何 URL 断言须用 web-stripped 路径 | **implement-time**：TC10 优先点击驱动 + `getByRole`/`exact` locator，避开带 group 的 URL 断言；如需断言 URL 用 web-stripped。不改 artifact                                                                                         |
| F2  | Convention 违反（phantom route） | **MEDIUM** | spec FR-C07 / plan 路由结构 / tasks TC05/TC07 | 原稿把 `DeviceIcon.tsx` + `RemoveDeviceSheet.tsx` co-locate 进 `app/.../login-management/` —— Expo Router 扫 `app/**/*.tsx` 当 route（memory `expo_router_app_route_scan`），会生成 phantom route。006 先例：primitives 落 `~/settings` 不进 `app/`                                                                                   | **✅ 已修（本次 analyze）**：两组件迁 `apps/mobile/src/settings/login-management/`，route 文件夹仅留 `_layout`/`index`/`[recordId]`。spec/plan/tasks 路径已同步改                                                                  |
| F3  | API 不匹配（reuse 资产）         | **MEDIUM** | plan port-remap / tasks TC06                  | mono `~/ui` `ErrorRow` 实证签名 = `{ text }`，**无 `onRetry`**；旧 app list ErrorRow 带 `onRetry` 重试按钮 → 直接复用拿不到重试                                                                                                                                                                                                       | **✅ 已修（本次 analyze）**：list 错误态 = `~/ui ErrorRow`(text) + 另置重试 `Pressable`(refetch)；sheet 内错误 = `~/ui ErrorRow`(message-only，契合)。plan/tasks 已注明                                                            |
| F4  | Risk（regen blast radius）       | **MEDIUM** | tasks TC01                                    | `nx affected -t generate` 从**当前全量 openapi** 重生 api-client；若 committed api-client 自上次 regen 后已 drift（#202 throttler 429 / #216 / #217 等可能动 openapi），TC01 的 regen commit 会**夹带非 FR-S15 的 diff**                                                                                                              | **implement-time**：TC01 跑 regen 后 `git diff packages/api-client` 确认 diff 是否仅 `recordId: number→string`；若更广 = 既有 api-client 与 main 的 drift（非本 amend 引入），review 后要么一并 commit（注明）要么单独对齐。不阻塞 |
| F5  | Coverage（实现细节）             | LOW        | tasks TC08                                    | 详情页「登录方式」中文标签 —— 旧 app `LOGIN_METHOD_LABEL`(PHONE_SMS/GOOGLE/APPLE/WECHAT) + `?? raw` fallback；mono 现仅 PHONE_SMS 登录，server `loginMethod: string`                                                                                                                                                                  | **implement**：port label map + 未知值 fallback 到 raw string（forward-compat，无害）。TC08 已含「中文标签」意图                                                                                                                   |
| F6  | Inconsistency（FR 措辞）         | LOW        | spec FR-C06 vs tasks TC03                     | TC03 `mapDeviceError` 覆盖 401(session)/403(frozen) **超出** FR-C06 列举的 409/404/429/network/unknown                                                                                                                                                                                                                                | 接受：port-faithful 超集（更鲁棒）；FR-C06 主路径错误码完整，401/403 是防御兜底。不改                                                                                                                                              |
| F7  | Ambiguity（e2e fixture）         | LOW        | tasks TC10                                    | mock list 行的 `id`（string bigint）须与 `DELETE .../{recordId}` 的 path 一致，否则 mock 不命中                                                                                                                                                                                                                                       | **implement**：e2e fixture 用真实感 string id（如 `"1001"`/`"1002"`），list 与 DELETE mock 共用同值                                                                                                                                |

## Coverage Summary（Requirement → tasks）

| Req                                             | Has Task? | Task IDs               | Notes                      |
| ----------------------------------------------- | --------- | ---------------------- | -------------------------- |
| FR-S15 server `@ApiParam type:'string'` + regen | ✅        | TC01                   | 纯注解；F4 regen diff 范围 |
| FR-C01 Orval 消费 + 单页 size=100               | ✅        | TC04, TC06             |                            |
| FR-C02 server 真相源字段 + 降级口径             | ✅        | TC06, TC08             |                            |
| FR-C03 本机徽标 + 无移除入口                    | ✅        | TC06, TC08             |                            |
| FR-C04 详情读 list cache + fallback + NotFound  | ✅        | TC08                   |                            |
| FR-C05 撤销 + invalidate + 不导航               | ✅        | TC04, TC07             |                            |
| FR-C06 错误统一映射                             | ✅        | TC03, TC07             | F6：mapper 超集            |
| FR-C07 路由结构 + param recordId + 组件落 src/  | ✅        | TC05, TC06, TC07, TC08 | F2：组件迁 src/（已修）    |
| FR-C08 account-security 行 flip                 | ✅        | TC09                   | 006 占位行 L34-35 实证     |
| FR-C09 port remap + extensionless + 逻辑 vitest | ✅        | TC02, TC03             |                            |

**SC**：SC-C01→TC06/TC10 · SC-C02→TC07/TC10 · SC-C03→TC03/TC07/TC10 · SC-C04→TC02/TC06/TC10 · SC-C05→TC01/TC11。全部有覆盖（logic=vitest · UI=Playwright）。

## Constitution Alignment

无 MUST 违反。

| 原则                 | 状态                 | 备注                                                                                                                                                                                                                   |
| -------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. SDD               | ✅                   | specify→clarify(in-spec Session 2026-05-29)→plan→tasks→analyze(本)→implement                                                                                                                                           |
| II. TDD              | ✅                   | `formatLastActive`(TC02)/`mapDeviceError`(TC03) vitest 红绿；屏/sheet/图标 Playwright e2e(TC10) = US5 Independent Test。per mono 分层 logic=vitest·UI=Playwright                                                       |
| III. Atomic 30min-2h | ✅                   | 11 task 适中；最大 TC06(列表+状态)/TC10(全 e2e) 仍 < 2h                                                                                                                                                                |
| IV. Module Boundary  | ✅                   | server FR-S15 **纯注解**（无 use case 逻辑/无跨 ctx 边界变更 → **catalog 无需加行**）；mobile：logic→`~/auth`、presentational→`~/settings/login-management`（非 route）、复用 `~/ui`/`~/theme`/`~/settings/primitives` |
| V. 类型同步链        | ✅（**非 vacuous**） | FR-S15 → `server:export-openapi` → `nx affected -t generate`（Orval regen）→ mobile 消费，**同 1 PR**（per api-contract rule）。与 006 的 vacuous 不同                                                                 |

## Unmapped Tasks

TC11（verify）—— process/polish，必需，非问题。无独立 setup task（依赖 006 ship 的 `~/settings/primitives` + `~/format`，react-native-svg 已在 deps）。

## Metrics

- Requirements: server **1**（FR-S15）+ client **9**（FR-C01..C09）= **10** · SC **5**（SC-C01..C05）
- Total tasks: **11**（TC01..TC11）
- Req Coverage: **10/10 = 100%** · SC Coverage: **5/5 = 100%**
- Critical: **0** · High: **0** · **Medium: 4**（F2/F3 已在本 analyze 修入 artifact；F1/F4 implement-time 落实）· Low: **3**（F5/F6/F7 接受）
- Duplication: **0**

## Next Actions

- **无 CRITICAL / HIGH** → 可进 `/speckit-implement`。
- **已修（本 analyze）**：F2（组件迁 `~/settings/login-management` 防 phantom route）、F3（ErrorRow text-only + 另置重试）—— spec/plan/tasks 三处已同步。
- **implement 时落实**：F1（TC10 点击驱动 + web-stripped URL）、F4（TC01 regen 后核 diff 范围）、F5（loginMethod label map + fallback）、F7（e2e mock id 一致）。
- F6 接受不改。
- → gate：user 确认 + 切 `/model sonnet`（Stage 2）后进 implement（逐 task 6 步闭环 + `tasks-client.md` `[X]` 手动 flip）。
