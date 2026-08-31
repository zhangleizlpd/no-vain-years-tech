---
feature_id: 072-anchor-submission-review
spec_ref: ./spec.md
status: approved
created_at: '2026-08-31'
updated_at: '2026-08-31'
adr_refs: ['0024', '0032', '0034', '0035', '0040', '0041', '0043', '0062', '0066', '0069']
context7_verified: []
---

# Implementation Plan: 锚待审箱审批线上化 + 「我的」三栏改版

> 🚨 **本 plan 与 spec 同为实装 server 半程之后补写**（原委见 `spec.md` §过程留痕）。
> 技术细节的第一手记录在 local-only 的
> `docs/private/plans/2026-08/08-31-anchor-submission-review-online.md`；
> 本文是它的**入仓可公开版**，两者冲突以本文为准。

## Summary _(mandatory)_

把 059 刻意留白的「零审阅面」补成 App 内的 admin 审批面：5 个新端点（待审列表 / 详情 /
单条采纳 / 批量驳回 / 冷启动结局），`Account` 加 `is_admin`，`anchor_submission` 加
`review_note` + `consumed_anchor_id` 并对 `(ticker, asof)` 建 **partial unique**
（`WHERE status='PENDING'`）。采纳仍只经 `ImportAnchorFromModelUseCase` 落锚 —— FR-012 原文不变，
但保证方式从**拓扑性质**换成**委托纪律 + 探针强制**。移动端把「我的」三栏
`笔记/图谱/知识库` 换成 `审批/消息/知识库`。零新 bounded context。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| ---------------------------------------- | ---- | --------------- |
| None（零新三方包）                        | N/A  | N/A             |

## Constitution Check _(mandatory gate)_

- [x] **Passed（含两处显式偏离，已在 spec / PR body / ADR-0069 三处留痕）**：
  ① **单 feature 单 PR 被拆成两个** —— PR #312（schema + 探针 + 文档 + server API + 契约 regen）
  与后续 mobile PR。契约三件套（server impl + api-client regen + mobile 消费）**本应同 PR**；
  本片把 regen 与 server 同 PR（客户端不 stale），mobile 消费滞后一个 PR。
  ② **未走 specify→clarify→plan 前置** —— 见 spec §过程留痕。
- TDD 红绿闭环：每条新判据都做了定向变异留档（见 tasks 各 `verify`）。
- 扁平 / 贫血 / 护城河：零新表以外的结构变化，跨 ctx 面只多一个 marketdata 读端点方法。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: `optionsdesk-059.anchor-import.it.spec.ts`（Testcontainers 真 PG）承载 schema 面；
  两条钉死旧决策的用例已按新语义改写并通过。
- [ ] **Mobile / Web**: Playwright Expo Web hermetic e2e + 契约冒烟（后半程）。
- **Evidence**: PR #312 CI 12 pass / 0 fail。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

零新三方依赖。但**下游有真 vendor 外呼**：一次 `action=create` 采纳 ⇒ 一个
`sync:anchor-cold-start` job（worker `concurrency=1`，分钟级）。这是限流桶取 6/60s 的**唯一**理由。
**Evidence**: `ops/bin/anchor-approve.sh` 的 `PACE_SECONDS=11` 注释。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] mono-native。**Evidence**: N/A。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
| --- | --- | --- | --- |
| ADR-0043 §5 | 护城河「当前仅约定」的部分 | mitigated | 新增 Check 3 `WRITE_ALLOWLIST`，把 ctx **内部**单写路径也机器化 |
| ADR-0062 | optionsdesk↔marketdata module 边 | mitigated | 只多一个端口方法 `previousTradingDay`，不新开边 |
| ADR-0035 | migration 三步法 | accepted-as-is | 两支均 expand-only；去重那步是**数据**变更非结构变更，已在 PR body flag 建议人工合并 |
| ADR-0040 | state_branches 门禁 | **partially-deferred** | spec 补写后 20 条分支已列；IT 覆盖在后半程补齐（当前非 100%） |

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**：新增 `AdminOnlyGuard` 是 lifecycle 组件 ⇒ 其 spec **必须**经
  `Test.createTestingModule` 取实例。本片实撞过：初版写 `new AdminOnlyGuard()` 被 lefthook
  `no-bad-mocks` 当场拒（per ADR-0040 / PR-79 retro）。
  ⚠️ 但**不 import 整个 `AccountModule`** —— 那会拖起 Prisma/ioredis，把一个零 DI 的判据变成
  需要外部依赖的测试；最小 `providers: [AdminOnlyGuard]` 容器已覆盖它全部构造面。
- **EXHAUSTIVE BRANCHING**：spec `state_branches` 20 条，后半程补齐 IT 对应 `it()`。

### D1 — FR-012 的保证方式换代（本片最重要的一条）

| | 059 | 072 |
| --- | --- | --- |
| 保证 | 拓扑：待审表到锚表没有边 | 委托：只有一条边且指向 `ImportAnchorFromModelUseCase` |
| 强制 | 结构（无需强制） | `check-server-moat.ts` Check 3 `WRITE_ALLOWLIST` |
| 强度 | 「不可能」 | 「会被发现」 |

**二者不等价，且代价已知**：探针只在 CI/lefthook 跑，改白名单即可绕过。接受它的理由是审批面
的价值 > 这一档强度差，**不是**「其实一样」。

🚨 既有 Check 1 只管**跨 ctx**；`anchor` 与 `anchor_submission` 同属 optionsdesk ⇒ 同 ctx 直写
它看不见。Check 3 补的正是这个洞。落地当场抓到手工清单漏了一个真实写者
（`get-radar.usecase.ts` 在读路径推进 `breach_started_on` 状态机）⇒ **名单真值用 AST 复算，
别手工 grep**。

### D2 — asof fail-closed 闸：比 shell 强一档

`anchor-approve.sh` 自己写着「这条判不了节假日」，只能筛未来/周末。服务端有
`TradingCalendarPort.classify` 三态 ⇒ `NON_TRADING` 把周末与**节假日**一起盖住。
🚨 `unknown` 单列一档、**MUST NOT 折进 `OK`**。
🚨 闸判**最终 asof**（含审核方修正），否则编辑框成了闸的绕过口。
🚨 用 **409** 不是 400：仓里 class-validator 失败统一折成 `400 FORM_VALIDATION`，用 400 会让
这道闸掉进「你数字填错了」那个桶，三出口对话框永远渲染不出来。

### D3 — `previousTradingDay` 必须新增，`lastClosedSession` 顶不了

后者给的是相对**今天**的最近已收盘场；一条 asof 落在两个月前某周六的陈年提交，拿它当改期建议
会把口径日直接拨到今天。不走 Q7-B 直查 `trading_day`：端口自己的注释写明上移的理由正是
「日历判据散成两份必然漂移，且只让日期悄悄差一天、不报错」。

### D4 — 采纳的顺序与半截态

导入成功 → 才条件更新翻 `CONSUMED`。
🚨 **MUST NOT 同事务**：callee 在自己 tx 内发 outbox 且 `seedLastClose` 有同步 vendor 调用；
回滚锚写入还得「取消发布」冷启动事件，那恰是 outbox 做不到的事。
🚨 翻转失败回 **200 + `statusFlipped:false`**，不是 5xx —— 锚已经写了，回 5xx 会让客户端重试
并写第二遍。`consumed_anchor_id` 让这种半截态收敛成一条 `LEFT JOIN` 可查。

### D5 — 唯一键与幂等（反转 059 第二处）

`(ticker, asof)` **partial unique `WHERE status='PENDING'`**。必须 partial：全表唯一会让
「驳回后重投修正版」永久不可能。
🚨 **投递口 MUST NOT 用 `upsert`** —— 已实测运行时炸：Prisma 把 partial unique 建模成**全表**
复合唯一，谓词在类型系统里消失，生成的 `ON CONFLICT (ticker, asof)` 撞上 PG「部分索引要求
谓词一致」。**类型全绿、运行时失败**，mock Prisma 抓不到 ⇒ 必须有真 PG 的 IT 兜底。

### D6 — 冷启动读面落 marketdata 而非折进待审详情

① 它不是采纳的决策输入，是采纳**之后**才看的；② 两个面刷新节奏不相容（轮询 vs 30s
staleTime 不轮询）；③ 主键本就是 `anchor_id`，045/046 锚屏日后要的是同一份数据。
🚨 `COLD_START_NEEDS_ATTENTION` 与十档值域**同处一点**，MUST NOT 在 App 抄名单。

### D7 — 审批 controller 独立（类级 guard）

**类级是保证，方法级是纪律**。共享 controller 上一个忘写 `@UseGuards` 的新路由会对每个登录
账号静默敞开且不报红。同 tag 同前缀 ⇒ orval 按 tag 分文件，barrel 无需改。

### D8 — 移动端两处结构约束

🚨 三栏内容渲染在 profile 那个 `stickyHeaderIndices={[1]}` 的**父 ScrollView 内**：
① 面板**不能自带纵向滚动器**；② ScrollView 必须恒三子节点，过滤发生在 `SlideTabs` **内部**。
🚨 `markRead` 必须跟随「消息栏是否激活」，而非路由 focus —— 否则停在审批栏也会把所有预警静默置已读。

## 复杂度

无 Complexity Tracking 条目。
