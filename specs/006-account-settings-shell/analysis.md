# Specification Analysis Report: 006-account-settings-shell

> `/speckit-analyze` 跨 `spec.md` / `plan.md` / `tasks.md` / `constitution.md` 一致性扫描（read-only 分析，本文件为报告留痕，per mono 约定）。生成于 2026-05-29（analyze→implement gate 前）。三件套同一会话连续起草 → 高度一致；findings 以 e2e 落地精度为主。

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| F1 | Inconsistency（e2e 落地精度）| **MEDIUM** | tasks T005/T007 + spec US1/US2 Independent Test | e2e 断言写「进 `/(app)/settings`」/「`/(app)/settings/account-security`」—— 但 **expo-router web export 隐藏 `(group)/` URL 段**（memory `expo_router_web_hides_route_groups`），Web 实际 URL = `/settings` / `/settings/account-security`（无 `(app)`）。直接断言带 group 的路径会 e2e 必败 | T005/T007 URL 断言改用 **web-stripped 路径** `/settings`·`/settings/account-security`；「底 tab 隐藏」检测用 ARIA-aware locator（bottom-tabs role=`tab` 非 `button`，同 memory）。implement 时落实，不改 spec/plan |
| F2 | Coverage（跨 story 同文件）| LOW | tasks T003 [US1] | T003（`settings/index.tsx`）同时承载 US3 登出 handler（confirmLogout + logoutAll 调用）—— 单文件含两 story。tasks 已显式注明「含 US3 登出 handler（同文件）」+ US3 phase 仅 e2e | 可接受：故意设计（settings/index 物理上含导航卡片 + 登出 Row）；story 独立性由 T005(US1)/T008(US3) e2e 分别验，非文件切分 |
| F3 | Coverage Gap（reuse）| LOW | spec FR-C10 / tasks | FR-C10（settings 路由受 AuthGate 第一层保护）无独立 impl task —— AuthGate 既有（002 ship），settings 落 `(app)/` 组内自动继承，**无新逻辑可写** | 非缺口：by-design 复用。T005 e2e seed-authed 隐式覆盖（未登录拦截是既有机制，本批不重测） |
| F4 | Ambiguity | LOW | tasks T009 grep 项 | T009 verify 含「grep 无 `.js` 扩展相对 import」—— 范围应限 B1 新增文件，非全仓（全仓有历史 server/orchestrator Node-ESM `.js` 合法） | implement 时 grep 限 `apps/mobile/app/(app)/settings` + `apps/mobile/src/{settings,format}` 新文件；mobile 侧 ESLint 已机械拦（无需手 grep 全仓） |

## Coverage Summary（Client FR → tasks）

| FR | Has Task? | Task IDs | Notes |
|---|---|---|---|
| FR-C01 settings stack 外置 + native header + 底 tab 隐 | ✅ | T003, T005 | F1：e2e URL/tab 检测落地精度 |
| FR-C02 ⚙️ → 真实 settings | ✅ | T004, T005 | |
| FR-C03 设置首页卡片 + 无法务页脚 | ✅ | T003, T005 | |
| FR-C04 账号与安全行集 | ✅ | T006, T007 | |
| FR-C05 登出确认对话（Platform 分支）| ✅ | T003, T008 | |
| FR-C06 登出回登录 + server 失败仍登出 | ✅ | T003, T008 | |
| FR-C07 maskPhone 格式 + 未绑定 | ✅ | T001, T006, T007 | |
| FR-C08 disabled 行不导航 | ✅ | T003, T006, T005, T007 | |
| FR-C09 登录管理/注销账号激活点 | ✅ | T006 | 注释标 B2/B3 flip |
| FR-C10 AuthGate 保护 | ✅（复用）| —（既有）| F3：reuse，无新 task |

**SC**：SC-001→T005/T007 / SC-002→T005 / SC-003→T008 / SC-004→T005,T007 / SC-005→T007 / SC-006→T004,T005。全部有 e2e 覆盖。

## Constitution Alignment

无 MUST 违反。

| 原则 | 状态 | 备注 |
|---|---|---|
| I. SDD | ✅ | specify→clarify→plan→tasks→analyze（本）→implement |
| II. TDD | ✅ | `maskPhone` vitest 红绿（T001）；UI/导航/登出 Playwright e2e（T005/T007/T008，= 各 US Independent Test）。per mono 分层 logic=vitest·UI=Playwright |
| III. Atomic 30min-2h | ✅ | 9 task 均适中（最大 T003 双文件 port，仍 < 2h） |
| IV. Module Boundary | ✅（mobile 维度）| 无 server module 改；primitives/maskPhone app-local（`src/settings`/`src/format`）不进 `~/ui`（占位 4 边界）；复用 `~/auth`/`~/theme`/`~/ui` |
| V. 类型同步链 | ✅（vacuous）| 无新端点/DTO → 无 openapi 变 → 无 Orval regen（logout-all #196 已固化） |

## Unmapped Tasks

T009（verify）—— process/polish，非 FR 映射但必需，非问题。（无 setup/contract task，本批零依赖、零 server。）

## Metrics

- Total Client FR: **10** · SC: **6**
- Total tasks: **9**
- FR Coverage: **10/10 = 100%**（FR-C10 复用既有 AuthGate，无新 task）
- SC Coverage: **6/6 = 100%**
- Ambiguity: **1**（F4，e2e grep 范围，LOW）
- Duplication: **0**
- Critical Issues: **0** · High: **0**

## Next Actions

- **无 CRITICAL / HIGH** → 可进 `/speckit-implement`。
- 建议 implement 时落实 **F1**（e2e 用 web-stripped 路径 `/settings` + ARIA-aware tab 检测，per memory `expo_router_web_hides_route_groups`）—— 这是 e2e 一次写对的关键，否则 T005/T007 必败。F1 是 implement 阶段落地约束，**无需现在改 spec/plan/tasks 文字**（tasks 措辞「进 /(app)/settings」是逻辑意图，实现层翻成 web 路径）。
- F2/F3/F4 不阻塞。

## Resolution（待 analyze→implement gate）

- F1 → implement 阶段 e2e task 内落实（web 路径 + ARIA tab 检测），不预改文件。
- F2/F3/F4 → 接受，不改。
- → gate：user 确认 + 切 `/model sonnet`（Stage 2）后进 `/speckit-implement`。
