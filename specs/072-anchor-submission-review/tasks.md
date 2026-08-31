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

> 🚨 **T001–T013 是补写的**（实装在前、tasks 在后，见 spec §过程留痕）。T014 起为正常前置。
>
> 🚨 **更正（review 后）**：这段原本写着「它们的 `[X]` 依据是 PR #312 里真实跑过的验证」——
> **那句话高估了覆盖**。当时真正被测的只有两个纯函数文件、guard 与 moat 探针；四个 use case
> 与 controller **一行单测都没有**，也没有 072 IT。「server unit 5697 passed」证明的是套件通过，
> 与这些新文件有没有被覆盖无关（正是「**通过数对得上 ≠ 新测试跑了**」那条）。
>
> 验证已于 review 后补齐（各 task 的 `verify:` 已重写），并因此**当场揪出两个真 bug**。
> 补测**从 `spec.md` 的 FR / `state_branches` 写起、动手前不重读实现** —— 照着实现写测试
> 会把 bug 一起固化成断言。每条补的测试都做了定向变异证明能红。

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

- [X] T007 [Server] **待审读侧 + 采纳前预览**（FR-001, FR-002; state_branches 9–11）：`list-anchor-submissions.usecase.ts`（含 `getDetail`）；`isImportNoop` 从 use case 私有搬进 `anchor-import.rules.ts` 供读侧复用 → verify: `list-anchor-submissions.usecase.spec.ts` **13 条**（截断/筛选/N+1 单次批量/disposition/asofFlag/预览四态）；变异「`asof` 改 `toISOString()`」⇒ **4 红**；`import-anchor-from-model` 既有 43 条全绿（搬移行为保持）。
- [X] T008 [Server] **采纳 use case**（FR-003, FR-004, FR-005, FR-006; plan §D4; state_branches 5–8,12,13）：委托 import、先导入后翻状态、409 三态 → verify: `approve-anchor-submission.usecase.spec.ts` **14 条** + T001 探针红绿。三发变异各自命中：调换导入/翻转顺序 ⇒ **2 红**；`unknown` 从 asof 闸放行 ⇒ **1 红**；直写 `prisma.anchor` ⇒ **1 红**。
  ⚠️ 顺序断言写的是**序列本身**（`['import','flip']`）而不是「两个都被调过」—— 后者在顺序颠倒时照样绿，等于没测。
- [X] T009 [P] [Server] **批量驳回**（FR-007; state_branches 14）：`REJECTED` 仓里第一个写者 → verify: `reject-anchor-submissions.usecase.spec.ts` **8 条**（用**行为 fake** 而非桩 —— 桩会把 bug 一起固化成断言）。
  🐞 **review 揪出的真 bug**：`findMany` 排在 `updateMany` **之后** ⇒ 读到更新**后**状态 ⇒ 早已 REJECTED 的行被误报成本次成功驳回，正是 FR-007 明禁的「折成一句 ok」。已改成**先读后写、按前置状态判**，并立不变量 `rejected + skipped === 去重 id 数`。
- [X] T010 [Server] **审批 controller（类级 `AdminOnlyGuard`）+ 限流桶 6/60s**（FR-010; plan §D7）→ verify: `anchor-submission.controller.spec.ts` **7 条**，含**类级 guard 元数据断言**；变异「把 `AdminOnlyGuard` 从类装饰器摘掉」⇒ **2 红**。
  ⚠️ 第一次变异被 typecheck 拦住（unused import）、**测试根本没跑** —— 没跑到的变异证明不了任何事；改成连 import 一起删才是有效变异。
  🐞 **review 揪出的真 bug**：本 controller 自建的 `skipExcept` 漏了 `EXISTING_BUCKETS`，只 spread 了 `OPTIONSDESK_ALL` ⇒ 4 个端点不跳过 `DEFAULT` 与其它 feature 的桶，限流静默偏离设计。已改为**复用**兄弟 controller 导出的 `skipExcept`（不造第三份表）。
- [X] T011 [P] [Server] **投递口幂等**（FR-008; plan §D5; state_branches 15,16）：find-then-write + P2002 兜并发 → verify: **实测 `upsert` 运行时炸**（`no unique or exclusion constraint matching`），故禁用。
- [X] T012 [Server] **冷启动读面 + attention 分档**（FR-009; SC-003; plan §D6; state_branches 17,18; US5）→ verify: `anchor-cold-start.rules.spec.ts` 穷尽闸（塞第 11 个 outcome 不归类 ⇒ **2 红**）+ `get-anchor-cold-start-runs.usecase.spec.ts` **5 条**（五档 needsAttention / 缺席不补占位 / 去重截顶）。
- [X] T013 [Contract] **契约同步**：`nx run server:export-openapi` **然后** `nx affected -t generate` → verify: `git diff --stat packages/api-client/src/generated` 非空（435 行）—— 这正是「只跑第二步会拿 stale json 且全绿」的判据。

## Phase 4 — 移动端（前置，尚未实装）

- [X] T025 [Gate] **补 Mockup baseline**（plan §Constitution Check C2）：`/mockup-gen 072` 产
  `specs/072-anchor-submission-review/design/`（gitignored，local-only —— 截图里可能有真实持仓 /
  手机号，「像素里的 PII」没有扫描器能抓）→ verify: `design/` 存在且含本片四个新面的 preview。
  🚨 **这是 T014 起所有 mobile task 的前置卡点**：Principle I「跳过 Mockup 直接 plan = 违规」。

- [X] T014 [Mobile] **删「待办」栏 + 抽出可内嵌消息列表**（FR-011; plan §D8）：`message-center-screen.tsx` 去掉单项 `AlertTabRow`；卡片列表抽成无滚动器的 `AlertMessagePanel`；清理 `alert-copy.ts` 的 `tabRemind`/`tabTodo` 两个 orphan；`alert-tab-row.tsx` 头注释去掉屏 6 → verify: 改写 `alert.spec.ts` 中「待办 disabled」用例；`nx lint mobile` 无新 orphan。
- [X] T015 [Mobile] **三栏可见性纯函数**（FR-011; plan §D8; state_branches 19,20; US6）：`profile-tabs.rules.ts` 的 `visibleProfileTabs` / `defaultProfileTab`，外加 `resolveActiveProfileTab`（渲染期派生 activeTab，**不用 `useEffect`** —— 派生本身是判定，留在 JSX 里就没有单点可验）→ verify: `profile-tabs.rules.spec.ts` **13 条**（四象限 + `isAdmin` 未知 fail-closed + 默认栏 + 三条回落）。三发变异各自命中且**都真跑到了断言**（非 typecheck 拦停）：删 markets 闸 ⇒ **3 红**（含 sb-19 那条合规用例）；`isAdmin === true` 改 `!== false` ⇒ **1 红**（/me 未落地那一瞬会闪出管理入口）；回落改成「总是保留 selected」⇒ **2 红**。
  ⚠️ 合规闸判在权限闸**之上** —— markets off 时 `isAdmin` 不参与判定；只测 admin 维度的话，一个漏判 `marketsEnabled` 的实现照样四象限里三格全绿。
  可见集合的返回类型写成以 `'kb'` 收尾的**非空元组**（`noUncheckedIndexedAccess` 下普通数组取 `[0]` 带 `undefined`）—— 「知识库恒可见」这条不变量因此编进类型，取首项的两处都不需要一个永远走不到的兜底分支。
- [X] T016 [Mobile] **`profile.tsx` 三栏改版**（FR-011; SC-005; US6）：`审批/消息/知识库`；三栏可见性接 T015 的纯函数（渲染期派生，无 `useEffect`）；文案表加 `satisfies Record<ProfileTabKey, string>`（加栏漏文案即编译红）；`MARKETS_SURFACES` 登记两个 `tab-panel` 受控面 —— 这是第三种门控形态（无自己的路由，门控是宿主屏的渲染判定），已在 `markets-gate.tsx` 文件头的「新增受控面怎么办」里补上 → verify: markets-ON 全量 e2e **254 passed**（新增非 admin / admin 两条 profile 用例，日志确认 `[233/254]`、`[234/254]` 真跑到）；markets-OFF 合规门 **5 passed**（新增「我的」只剩知识库一栏那条）。两发变异都红在**同一条**断言（`审批` tab Expected 0 / Received 1）：钉死 `marketsEnabled: true` ⇒ markets-OFF 那条红；钉死 `isAdmin: true` ⇒ 非 admin 那条红。
  📌 markets-OFF 的 `/me` stub **故意给 `isAdmin: true`** —— 「markets off ∧ admin」是四象限里唯一能分辨「漏判 `marketsEnabled` 的实现」的那格；给 false 的话，一个只看 `isAdmin` 的实现在合规门下照样全绿。
  ⚠️ **「面板从各自 feature 目录 import」这半条没做**：审批面板归 T018、消息面接线归 T017，本 task 三栏内容仍是占位（`TabPlaceholder`）。admin 那条 e2e 现在断的是「审批内容即将推出」，T018 落真列表时改断列表容器 —— 已在用例里标注。
  ⚠️ **「ScrollView 恒三子节点」是结构性保证，不是被测出来的**：三个子节点（Hero / SlideTabs / 内容）均无条件渲染，过滤只发生在 `SlideTabs` 内部。sticky 本身在 web e2e 下**验不出来** —— 视口 720 高于本屏内容 ~590，页面根本不可滚，写出来的断言会恒真。宁可留一条「验不到」也不交付恒真断言。
  ⚠️ **background 跑 e2e 时 harness 报的退出码是 0，而 nx 实为 `Failed tasks`**（两发变异都撞上）—— 正是 local-verification §3「exit code 会说谎」；判据只能 grep 终态串。
- [X] T017 [Mobile] **消息面接线 + `markRead` 改判据**（FR-012; plan §D8）：新建 `alert-message-tab.tsx`（内嵌宿主：`useAlertMessages` + 段头「提醒 / 查看全部 ›」+ `limit=3`，与全屏 `MessageCenterScreen` 共用 T014 那份 `AlertMessagePanel`）；置已读判据抽成 `shouldMarkMessagesRead(selected, active)` 纯函数 → verify: 单测 **4 条**；e2e 三条（停在审批栏不清 / 切过去才清 / 默认落栏不清）。三发变异各红在对的用例：忽略 `selected` ⇒ 「默认落栏」1 红；丢掉 `active` 合取 ⇒ 「选过但已不可见」1 红；**接线**改成 `activeTab === 'messages'` ⇒ e2e **2 红**。全量 markets-ON **255 passed** / markets-OFF **5 passed**。
  🚨 **实现期撞到 spec 洞，已停下请示并定案（2026-08-31）**：FR-012 只写了「不许跟路由 focus 走」，没回答「**默认**落在消息栏算不算激活」。第一版按「挂载即置已读」写，被两条测试当场揪出：① 新写的 FR-012 用例 —— admin 停在审批栏却已发出置已读（冷启动种子不持久化 `isAdmin`，首帧按非 admin 渲染，消息栏短暂成为默认栏）；② 既有 `alert.spec` 未读角标 —— App 落地屏就是「我的」，非 admin 的默认栏正是消息栏 ⇒ **开一次 App 就把 021 的未读红点清光**。**定案：只有用户主动点选消息栏才置已读**（`selected` 而非 `active`），默认落栏不算。
  ⚠️ 只断「零置已读」，**不断**「列表一次都没拉」—— 冷启动那一帧消息栏会短暂挂载并拉一次 EP6（sb-20 本就接受「审批栏要等 /me 落地才出现」）。那是无副作用的读；连它一起断 = 断一条本设计没做出的保证。
  🔁 `MessageCenterScreen` 根加 `testID="alert-message-center"`：同一份卡片列表现在有两个宿主，而「我的」屏在 tab navigator 里仍挂着 ⇒ 裸 `getByText('预警触发')` 双命中且 `.first()` 先命中被 `aria-hidden` 的那份（实撞 `Expected visible / Received hidden`）。`alert.spec` 三条卡片断言随之钉进那一屏。
- [X] T018 [Mobile] **审批列表 + 内嵌面板**（FR-001; SC-001; US1）：`anchor-submission.rules.ts`（徽标 / 事实行 / 市场筛 / 多选判定）+ `anchor-submission-row.tsx`（两宿主共用）+ `anchor-submission-panel.tsx`（「我的」审批栏，limit 4 + 「查看全部」）+ `anchor-submission-list-screen.tsx`（全屏 + 多选批量驳回）+ 路由常量与薄 route → verify: 单测 **14 条**；hermetic e2e **3 条**（面板徽标 / 批量驳回 skipped / chips 切走不参与驳回）；全量 markets-ON **258 passed**、markets-OFF **5 passed**。三发变异各红在对的用例：`UNKNOWN` 折进 `OK` ⇒ **2 红**；`visibleSelection` 忽略可见性 ⇒ **3 红**；屏内接线绕过它（直接 `[...selected]`）⇒ e2e **1 红**（「已选 2 项」）。
  🚨 **看不见的选中项不许被驳回**：切市场 chip 会让已选行离开视野，而驳回是写操作 —— 「屏上选了 1 条、实际驳回 2 条」是不可接受的偏差。判据 `visibleSelection` 单独成函数就是为了能被变异证伪。
  🚨 `skipped` 逐条成句（FR-007）：e2e 里用 `consumeExternally()` 模拟「这一行在别的设备上被处置掉了」—— 那是一个**真实事件**，不是「第 N 次调用换一份答案」（mock 仍是契约镜像）。
  ⚠️ 待审箱路由挂在 `/(app)/optionsdesk/` 下并在 `markets-feature-gate.spec.ts` 追了第 12 条深链：「我的」那两栏靠**渲染门**，深链靠**路由门**，两道门盖的是同一件事的两个入口，缺一个就等于没门。`optionsdesk-routes.spec.ts` 另加了「不长在 (tabs) 下」的结构断言。
  ⚠️ 两个坑留痕：① `@nvy/api-client` 的**运行时**枚举常量在 mobile vitest 下解析不到（`Failed to resolve entry`），整个 spec 文件 0 用例跑起来**而 exit code 照样是 1** —— 在变异语境下极易读成「断言生效」；判据文件一律 `import type` + 字面量。② 同一条待审在内嵌面板与全屏列表各渲一次，profile 屏在栈里仍挂着 ⇒ 行定位必须钉进容器（`optionsdesk-submission-panel` / `-list`），否则 strict mode 双命中。
  🔁 T016/T017 里断「审批内容即将推出」的两条 e2e 已按当时的标注改断面板容器；profile.spec 补 pin 待审箱边界（空箱）。
- [X] T019 [Mobile] **审批详情 + 复述闸 + 三出口对话框**（FR-002, FR-005; US2, US3; state_branches 5–7,10,11）：`anchor-submission.schema.ts`（RHF + zod：4 字段 + 审核备注；`ticker` **不在表单里** —— FR-006 是「没有编辑路径」而非 disabled 输入框）+ `anchor-submission-detail.rules.ts`（出口集合 / 提示分档 / 载荷 diff / 三个 409 判别 / 半截态）+ `anchor-submission-detail-screen.tsx`（详情 + 复述闸 sheet + 采纳回执）→ verify: 单测 **21 条**；e2e **5 条**（人工位逐条 / noop 零警告 / 三出口改送 / 出口缺席 / 半截态回执）；全量 markets-ON **263 passed**、markets-OFF **5 passed**。两发变异在**两层**都红：「改送」出口无视 `null` ⇒ 单测 1 红 + e2e 1 红；`fallbackPreview` 抢在 `willBeNoop` 前 ⇒ 单测 1 红。
  🚨 **载荷只带改过的字段**：全量回传也能工作，但 `appliedAsof ≠ 提交行 asof` 是「这条被审核方改过」的唯一痕迹，四个字段一律回传等于把痕迹抹平。
  ⚠️ **服务端 409 里的 `asofFlag` / `asofSuggested` 到不了客户端** —— `ProblemDetailFilter` 只透传白名单（`code` / `freezeUntil` / `retryAfterSeconds` / `invalidAttributes`），045 EC-7 已在 `anchor-form.rules.ts` 踩过同一处。⇒ 建议日一律取自**详情响应**；审核方改过口径日时我们没有新的建议日，此时按「解不出」渲染（只剩「按原日期照发」），与「不猜」同一个态度。e2e 的 mock **如实镜像**这一点（409 只回 `code`），否则测试会为一条客户端根本收不到的字段建立信心。approve use case 里那句「客户端据此隐掉改送出口」的注释与实际不符，已就地更正。
  ⚠️ 过程坑：一条「python 编辑 + nx 验证」的复合命令因带 `| head` 被 PreToolUse hook **整条**拒绝 —— 编辑压根没落盘，而随后单跑的 typecheck 照样绿（什么都没改）。是 e2e 探针里「tap 后 URL 没变」把它揪出来的。**hook 拒绝 = 整条命令没执行**，别只当成「验证被拦」。
- [X] T020 [Mobile] **缓存失效包装 hook**（SC-004; US4）：`useInvalidateAnchorQueries` 收「处置后该刷什么」于一处（待审箱 + 锚列表 + 雷达，均传**前缀键**故所有筛选变体一并失效），approve / reject 共用 → verify: e2e **全程 App 内导航**、先取一次列表再采纳；变异（去掉待审箱那把 key）⇒ **2 红**（T018 批量驳回那条 + 本条）。全量 markets-ON **264 passed**。
  🚨 **第一版 e2e 是我自己判掉的假绿**：用 `page.goto('/optionsdesk/anchors')` 观察 —— 而 `page.goto` 在 web 上是整页重载，react-query 缓存直接清空，失效做没做都会绿。改成全程 App 内导航后才可证伪。「先访问列表再采纳」（tasks 原文点名的反序陷阱）与「不许整页重载」是同一个陷阱的两面。
  📌 最硬的一条断言落在**「我的」审批栏面板**的计数上：它在 tab navigator 里全程没有重挂，计数变了就只可能是失效触发的重取 —— 重挂 / 冷取都解释不了。本仓 `staleTime=30s`，30 秒内重挂不会自动重取，这是列表那条断言也成立的前提。
  ⚠️ **锚列表 / 雷达那两把 key 没有可证伪的覆盖**：要在 App 内到达锚列表得先过雷达屏（那套 mock 另有一整份），本 task 未搭。它们与待审箱同一个判据、同一处代码，但「少失效一处」的失败模式在这里**测不出来** —— 如实记一条覆盖不到，而不是拿一条恒真断言冒充。
- [X] T021 [Mobile] **冷启动结局面板**（FR-009; US5; state_branches 17,18）：`anchor-cold-start.rules.ts`（进度 / 分档 / 取批）+ `anchor-cold-start-screen.tsx`（十档 `outcome` **原样呈现**、需人工介入置顶、排队中单列）→ verify: 单测 **11 条** + e2e 1 条；全量 markets-ON **265 passed**、markets-OFF **5 passed**（深链第 14 条）。三发变异各红在对的用例：「缺席即视为已出结局」⇒ 单测 **2 红**；客户端自己抄一份 outcome 名单 ⇒ 单测 **2 红** + e2e **1 红**。
  🚨 **分档只认服务端的 `needsAttention`**（判据与那十个值同处一点）。e2e 里特意让一条 `backfilled` 带 `needsAttention=true` —— 抄名单的实现会把它掉进「已完成」，而线上的表现正是**某个永久缺口在界面上悄悄降级**。这条数据在真实系统里不该出现，它存在的唯一目的就是让「抄名单」这个错误可被证伪。
  📌 「本批新锚」取自待审箱 `status=CONSUMED` 行的 `consumedAnchorId`，**不另存本地清单** —— 本地清单会在换设备 / 清缓存后凭空消失，而那正是「我上次采纳的锚跑成什么了」最需要它的时候。
  📌 缺席（服务端查不到该 anchorId）在屏上是「还有 N 只在排队 · 未出结局」，既不叫失败也不叫未知（sb-18）。
- [X] T022 [Contract-Smoke] **契约冒烟**：`072-anchor-submission.contract.ts` —— 403 准入 → 提权 → 列表/详情逐字段 → 采纳真落锚 → 驳回 skipped → 冷启动读面；注册进 `run.ts`，并给 `check-contract-smoke-drift.ts` 的 `PREFIX_TO_MODULE` 补 `anchorSubmission → optionsdesk`（缺映射本身就会告警）→ verify: `RUN_REAL_BACKEND_SMOKE=true nx run mobile:contract-smoke` **30/30 passed**（真 server + testcontainers PG）。
  🚨 **它当场揪出两处我凭空假设的契约**，而 hermetic e2e 永远戳不穿（那边的响应是我自己造的）：① `account.id` 是 BigInt 自增，我按 uuid 拼 SQL；② approve / reject 都是 `@HttpCode(200)`（处置一条已存在的待审，不是造新资源），我按 201 断言。**这两次红就是这条 spec「能红」的实证**，不是补出来的变异。
  📌 靶心四条：admin-only 是真的（同一 token 提权前 403、提权后通 —— 客户端那一位只管渲染）；屏上解构的每个键真的在响应里（`instrumentName` / `asofSuggested` / `note` 断的是**键在**而非值非空 —— null 与 undefined 在屏上处置完全不同）；采纳后 `consumedAnchorId` 回指落成的锚（FR-013 孤儿检出的前提）；冷启动对还没出行的锚**不返回该行**（sb-18 缺席即排队）。
- [ ] T023 [Gate] **state_branches 覆盖补齐**（plan §Gate 0.4 的 partially-deferred 项）：20 条分支逐条对上 IT/e2e 的 `it()` → verify: 覆盖表进 PR body，届时那个 hard-gate checkbox 才是真的。
- [ ] T024 [Docs] **`anchor-approve.sh` 降级为 break-glass**（FR-013; SC-006）：`mark_consumed()` 补写 `consumed_anchor_id`（否则两条路径写出形状不同的 CONSUMED 行，孤儿锚检出假阳性）；「八种 outcome」改十种；`watch` 注释「这四种」改五种 → verify: `shellcheck` 绿。
