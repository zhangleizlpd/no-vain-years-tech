# Specification Analysis Report (client amend): 004-account-deletion — US10

> 跨 `spec.md`(§US10/FR-C01·C02/SC-C01) / `plan.md`(§Client UI Plan) / `tasks-client.md` / `constitution.md` 一致性扫描（read-only，本文件留痕）。生成于 2026-05-29（analyze→implement gate 前）。amend 改了**已 ship 的 004 spec**（#198）—— 但 US10/FR-C01/FR-C02/SC-C01 早以 forward-doc 写好，本 amend 仅 un-defer，故 drift 面小。
>
> **手动 analyze**（非 skill）：branch `004-account-deletion-client` ≠ dir，tasks 在 `tasks-client.md` → skill prereq 会 mis-resolve；per memory `mono_sdd_artifacts_diverge_from_speckit_skill`。

## Findings

| ID  | Category                      | Severity   | Location(s)                           | Summary                                                                                                                                                                                                                                     | Status / Recommendation                                                                                                                                                                                     |
| --- | ----------------------------- | ---------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Risk（成功路由可达性）        | **MEDIUM** | tasks TD04/TD06 + plan 成功路由       | delete 成功 → `useDeleteAccount` onSuccess `clearSession()` → AuthGate 立即重定向 login，**success state 不作 stable paint frame**（memory `visual_smoke_unreachable_when_finally_clears_session`）。若 e2e 断言「success overlay」会不可达 | **implement-time（TD06 已正确）**：e2e 断言 **`/login` URL + localStorage 会话清空**（非 success overlay），与 settings-shell US3a（登出）同款 —— 该路径已被 US3a e2e 证实可达。`router.replace` 仅作双保险 |
| F2  | Inconsistency（命名 drift）   | LOW        | spec FR-C02 / Clarifications / SC-C01 | spec 写 `mapDeletionError`，但 plan/tasks + 复用 sibling 用 `deleteAccountErrorToast`（mirror `cancel-deletion-errors`）                                                                                                                    | **✅ 已修（本 analyze）**：spec 3 处 `mapDeletionError` → `deleteAccountErrorToast`（与 shipped sibling 命名一致）                                                                                          |
| F3  | Inconsistency（e2e 落地精度） | **MEDIUM** | tasks TD06                            | delete-account 屏 Web URL = `/settings/account-security/delete-account`（expo-router 隐 `(app)` group 段，memory `expo_router_web_hides_route_groups`）；`/login` 同理 web-stripped                                                         | **implement-time**：TD06 点击驱动导航（经「注销账号」行）+ 终态断言 `/login`（web-stripped），避带 group 的 URL 断言。mirror B2 F1                                                                          |
| F4  | Coverage（行为细节）          | LOW        | tasks TD03                            | 旧 app `delete-account.tsx` 在 send 收 `rate_limit` 时启 cooldown；mono 拟 mirror `use-cancel-deletion-form`（**不**在 429 启 cooldown，仅 error toast）                                                                                    | 接受：follow Golden Sample 一致性（cancel form 范式）；429 toast 已提示「操作太频繁」，cooldown 非必需。implement 时若要复刻可加，但不强制                                                                  |
| F5  | Coverage（占位 flip）         | LOW        | tasks TD05                            | 006 `account-security/index.tsx` L44-45「注销账号」行 = `destructive disabled` + `// B3 ... 激活` 注释（已 grep 实证）；primitives `Row` 对 `destructive` **不显 chevron**                                                                  | 非问题：flip 去 `disabled` + 加 `onPress`，destructive 保留（无 chevron 符合 settings 视觉），accessibilityLabel `注销账号` 供 e2e locator                                                                  |

## Coverage Summary（Requirement → tasks）

| Req                                                                                       | Has Task? | Task IDs             | Notes                  |
| ----------------------------------------------------------------------------------------- | --------- | -------------------- | ---------------------- |
| FR-C01 注销发起屏（双勾选 gate + 发码 + 输码 + 确认 + 清 session + 路由 login + 行 flip） | ✅        | TD03, TD04, TD05     | RHF mirror cancel form |
| FR-C02 错误统一展示（`deleteAccountErrorToast`）                                          | ✅        | TD01, TD04           | F2 已对齐命名          |
| SC-C01 注销屏流程 e2e + 错误统一                                                          | ✅        | TD06 (+ TD01 vitest) | F1/F3 implement-time   |

## Constitution Alignment

无 MUST 违反。

| 原则                 | 状态              | 备注                                                                                                                                             |
| -------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| I. SDD               | ✅                | specify→clarify(in-spec Session 2026-05-29)→plan→tasks→analyze(本)→implement                                                                     |
| II. TDD              | ✅                | `deleteAccountErrorToast`(TD01) + `use-delete-account-form` renderHook(TD03) vitest 红绿；屏/导航 Playwright e2e(TD06) = US10 Independent Test   |
| III. Atomic 30min-2h | ✅                | 7 task；最大 TD04（屏 port + RHF 接线）仍 < 2h                                                                                                   |
| IV. Module Boundary  | ✅                | **无 server / 无新 operation → catalog 无需改**；mobile：logic→`~/auth`、屏 route + inline 子件、复用 `~/ui`(SmsInput/ErrorRow/Button)/`~/theme` |
| V. 类型同步链        | ✅（**vacuous**） | 无 server endpoint/DTO 改 → 无 openapi 变 → 无 Orval regen（deletion 端点 #198 已固化）。与 006 同（B2 因 FR-S15 非 vacuous，本批回到 vacuous）  |

## Unmapped Tasks

TD07（verify）—— process/polish，必需。无 setup task（依赖 006 ship 的 `~/settings/primitives` 不直接用；复用 `~/ui` + `~/auth` 既有；`@hookform/resolvers` + happy-dom + @testing-library/react 随 login/cancel slice 已装）。

## Metrics

- Requirements: client FR **2**（FR-C01/C02）· SC **1**（SC-C01）（server FR/SC 不在本 amend scope）
- Total tasks: **7**（TD01–TD07）
- Req Coverage: **100%** · SC Coverage: **100%**
- Critical: **0** · High: **0** · **Medium: 2**（F1/F3 implement-time）· Low: **3**（F2 已修 / F4 / F5 接受）
- Duplication: **0**

## Next Actions

- **无 CRITICAL / HIGH** → 可进 implement。
- **已修（本 analyze）**：F2（spec 命名对齐 `deleteAccountErrorToast`）。
- **implement 时落实**：F1（TD06 断言 `/login` + session-cleared，非 success overlay）、F3（点击驱动 + web-stripped URL）。
- F4 / F5 接受不改。
- → gate：user 确认后进 implement（逐 task 6 步闭环 + `tasks-client.md` `[X]` 手动 flip）。
