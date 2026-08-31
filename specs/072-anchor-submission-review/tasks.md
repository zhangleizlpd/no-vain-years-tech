---
feature_id: 072-anchor-submission-review
spec_ref: ./spec.md
plan_ref: ./plan.md
status: in-progress
created_at: '2026-08-31'
updated_at: '2026-08-31'
---

# Tasks: 072-anchor-submission-review（锚待审箱审批线上化 + 「我的」三栏改版）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **架构 canonical**: [`ADR-0069`](../../docs/adr/0069-anchor-submission-review-surface.md)
**Branch**: `072-anchor-submission-review`（单分支单 PR #312 —— mobile 已按 Principle V 并入，stacked 分支已废弃）
**病根一句话**：059 刻意不做审阅面，代价是这条流程从没上线过 —— 08-31 直查 prod，47 条 PENDING 躺着、`REJECTED` 恒为 0、还有 2 组逐值全等的重复投递。

> 🚨 **T001–T012 是补写的**（实装在前、tasks 在后，见 spec §过程留痕）。它们的 `[X]` 依据是
> PR #312 里**真实跑过**的验证，不是回填打勾。T013 起为正常前置。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan §Dx; state_branches n; USn）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收；新测试必须证明「能红」（定向变异留档）。
- 层级：`[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Contract-Smoke]` / `[Gate]` / `[Docs]`。

## Path Conventions

| 用途 | 路径 |
| --- | --- |
| 单写路径探针（改） | `scripts/checks/check-server-moat.ts`（+ 同名 spec） |
| asof 判据（新） | `apps/server/src/optionsdesk/anchor-submission.rules.ts`（+ 同名 spec） |
| 审批 use cases（新） | `apps/server/src/optionsdesk/{list,approve,reject}-anchor-submission*.usecase.ts` |
| 审批 controller（新） | `apps/server/src/optionsdesk/anchor-submission.controller.ts` |
| 准入闸（新） | `apps/server/src/account/admin-only.guard.ts`（+ 同名 spec） |
| 冷启动读面（新） | `apps/server/src/marketdata/get-anchor-cold-start-runs.usecase.ts` |
| 三栏可见性（新） | `apps/mobile/src/profile/profile-tabs.rules.ts`（+ 同名 spec） |
| 审批屏（新） | `apps/mobile/src/optionsdesk/anchor-submission-*.tsx` |

---

## Phase 1 — 决策记录与探针（零行为）

- [X] T001 [Gate] **单写路径探针 Check 3**（FR-003; SC-002; plan §D1）：`check-server-moat.ts` 加 `WRITE_ALLOWLIST`，锚表写操作只允许出现在登记文件里 → verify: 干净树 `EXIT=0`；在 approve use case 写一句 `prisma.anchor.update` → `EXIT=1` 且点名行号；撤销回 `EXIT=0`。**已实测**，且当场抓到手工清单漏了 `get-radar.usecase.ts`。
- [X] T002 [Docs] **三处 normative 文本反转 + ADR-0069**（FR-003, FR-008; plan §D1/§D5）：schema 注释 / 059 plan §6 / moat 条目注释统一改口径，原文保留标 superseded → verify: `check-adr-index.ts` 51 ADR ✓。
- [X] T003 [Server] **schema 扩容两支 migration**（FR-008; state_branches 15,16）：`account.is_admin`、`anchor_submission.review_note`/`consumed_anchor_id`、去重、partial unique → verify: dev DB 真跑 —— 重复行转 `REJECTED` 并写明与哪条一致；`pg_indexes.indexdef` 带 `WHERE ((status)::text = 'PENDING'::text)`；同键再插 `PENDING` 被拒 / 插 `REJECTED` 放行。

## Phase 2 — 准入与判据

- [X] T004 [Server] **`Account.isAdmin` + `AdminOnlyGuard`**（FR-010; state_branches 20; US6）：`JwtAuthGuard` 从已加载的行填 `isAdmin`（零额外查询）；guard 零 DI 零 I/O → verify: 单测经 `Test.createTestingModule` 取实例（`no-bad-mocks` 闸拦隔离 `new`）；变异成 `user && !user.isAdmin` ⇒「user 缺失 fail-closed」当场红。
- [X] T005 [P] [Server] **`TradingCalendarPort.previousTradingDay`**（FR-005; plan §D3; state_branches 5,6）：端口 + `DbTradingCalendarAdapter` + 共享 stub → verify: typecheck 把全部实现方与 test double 逼出（15 处）；覆盖声明之外返 `null`。
- [X] T006 [Server] **asof 五档判据**（FR-005; plan §D2; state_branches 1–4）：`anchor-submission.rules.ts` 纯函数 → verify: 14 条单测；删 `unknown` 分支 ⇒「MUST NOT 折进 OK」红；把 `TODAY` 算进需确认档 ⇒ 穷尽闸红。

## Phase 3 — 审批 API

- [X] T007 [Server] **待审读侧 + 采纳前预览**（FR-001, FR-002; state_branches 9–11）：`list-anchor-submissions.usecase.ts`（含 `getDetail`）；`isImportNoop` 从 use case 私有搬进 `anchor-import.rules.ts` 供读侧复用 → verify: `import-anchor-from-model` 既有 43 条单测全绿（搬移行为保持）。
- [X] T008 [Server] **采纳 use case**（FR-003, FR-004, FR-005, FR-006; plan §D4; state_branches 5–8,12,13）：委托 import、先导入后翻状态、409 三态 → verify: T001 的探针红绿即其护栏。
- [X] T009 [P] [Server] **批量驳回**（FR-007; state_branches 14）：`REJECTED` 仓里第一个写者 → verify: `status:'PENDING'` 谓词即幂等；`skipped` 不折叠。
- [X] T010 [Server] **审批 controller（类级 `AdminOnlyGuard`）+ 限流桶 6/60s**（FR-010; plan §D7）→ verify: 桶折进 `OPTIONSDESK_ALL` ⇒ 其它 controller 零改动。
- [X] T011 [P] [Server] **投递口幂等**（FR-008; plan §D5; state_branches 15,16）：find-then-write + P2002 兜并发 → verify: **实测 `upsert` 运行时炸**（`no unique or exclusion constraint matching`），故禁用。
- [X] T012 [Server] **冷启动读面 + attention 分档**（FR-009; SC-003; plan §D6; state_branches 17,18; US5）→ verify: 塞进第 11 个 outcome 不归类 ⇒ 穷尽闸两条红。
- [X] T013 [Contract] **契约同步**：`nx run server:export-openapi` **然后** `nx affected -t generate` → verify: `git diff --stat packages/api-client/src/generated` 非空（435 行）—— 这正是「只跑第二步会拿 stale json 且全绿」的判据。

## Phase 4 — 移动端（前置，尚未实装）

- [X] T025 [Gate] **补 Mockup baseline**（plan §Constitution Check C2）：`/mockup-gen 072` 产
  `specs/072-anchor-submission-review/design/`（gitignored，local-only —— 截图里可能有真实持仓 /
  手机号，「像素里的 PII」没有扫描器能抓）→ verify: `design/` 存在且含本片四个新面的 preview。
  🚨 **这是 T014 起所有 mobile task 的前置卡点**：Principle I「跳过 Mockup 直接 plan = 违规」。

- [X] T014 [Mobile] **删「待办」栏 + 抽出可内嵌消息列表**（FR-011; plan §D8）：`message-center-screen.tsx` 去掉单项 `AlertTabRow`；卡片列表抽成无滚动器的 `AlertMessagePanel`；清理 `alert-copy.ts` 的 `tabRemind`/`tabTodo` 两个 orphan；`alert-tab-row.tsx` 头注释去掉屏 6 → verify: 改写 `alert.spec.ts` 中「待办 disabled」用例；`nx lint mobile` 无新 orphan。
- [ ] T015 [Mobile] **三栏可见性纯函数**（FR-011; plan §D8; state_branches 19,20; US6）：`profile-tabs.rules.ts` 的 `visibleProfileTabs` / `defaultProfileTab`；渲染期派生 activeTab，**不用 `useEffect`** → verify: 单测覆盖 markets×isAdmin 四象限；让它忽略 `marketsEnabled` ⇒ 合规用例红。
- [ ] T016 [Mobile] **`profile.tsx` 三栏改版**（FR-011; SC-005; US6）：`审批/消息/知识库`；面板从各自 feature 目录 import；`MARKETS_SURFACES` 登记两个新受控面 → verify: ScrollView 恒三子节点（sticky 索引不移位）；`markets-feature-gate.spec.ts` 扩断言。
- [ ] T017 [Mobile] **消息面接线 + `markRead` 改判据**（FR-012; plan §D8）：只在消息栏激活时置已读，只解构 `mutateAsync` → verify: e2e —— 停在审批栏时未读**不清零**，切到消息栏才清。
- [ ] T018 [Mobile] **审批列表 + 内嵌面板**（FR-001; SC-001; US1）：行首「中文名 + 代号」、disposition/asof 徽标、多选批量驳回 → verify: hermetic e2e。
- [ ] T019 [Mobile] **审批详情 + 复述闸 + 三出口对话框**（FR-002, FR-005; US2, US3; state_branches 5–7,10,11）：RHF + zod（4 字段 + 审核备注）；`refresh` 时逐条列出会被冲掉的人工位；`asofSuggested` 为 null 时**不出现**「改送」出口 → verify: e2e 覆盖三出口。
- [ ] T020 [Mobile] **缓存失效包装 hook**（SC-004; US4）：approve/reject 复用 `useInvalidateAnchorQueries` → verify: e2e **先访问列表**再采纳再返回（反序是假绿）。
- [ ] T021 [Mobile] **冷启动结局面板**（FR-009; US5; state_branches 17,18）：十档全显、五档置顶；缺席 = 排队中 → verify: 单测覆盖「缺席不等于失败」。
- [ ] T022 [Contract-Smoke] **契约冒烟**：`apps/mobile/e2e/contract-smoke/072-anchor-submission.contract.ts` 覆盖屏上解构的每个字段 → verify: `check-contract-smoke-drift.ts` 绿。
- [ ] T023 [Gate] **state_branches 覆盖补齐**（plan §Gate 0.4 的 partially-deferred 项）：20 条分支逐条对上 IT/e2e 的 `it()` → verify: 覆盖表进 PR body，届时那个 hard-gate checkbox 才是真的。
- [ ] T024 [Docs] **`anchor-approve.sh` 降级为 break-glass**（FR-013; SC-006）：`mark_consumed()` 补写 `consumed_anchor_id`（否则两条路径写出形状不同的 CONSUMED 行，孤儿锚检出假阳性）；「八种 outcome」改十种；`watch` 注释「这四种」改五种 → verify: `shellcheck` 绿。
