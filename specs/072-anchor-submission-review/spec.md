---
feature_id: 072-anchor-submission-review
modules: [optionsdesk, account, marketdata, alert]
owners: ['@zhangleizlpd']
status: implementing
created_at: '2026-08-31'
updated_at: '2026-08-31'
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'

# --- v2 fields (mono-orchestrator-ready 0.2.0) ---

web_compat: full

agent_friction_observed: true
agent_friction_notes: >-
  本 spec 是**实装后补写**的（server 半程已 ship，见「过程留痕」）。摩擦点不在代码而在流程：
  harness 的 /plan 模式把产物导向 docs/private/plans/，agent 全程没有把「要不要走 SDD」这个
  岔路显式摆给维护者，只在 plan 头部与 PR body 里备注了一句「未走 /speckit-specify」——
  备注不等于征求同意。后果是模块倒查断链、state_branches 无处落、6 条澄清散在对话里。

state_branches:
  - 'asof 晚于交易所今天 → FUTURE：那天的收盘价还不存在，无论它是不是交易日；未带 asofAck ⇒ 409 ASOF_SUSPECT 且**一次 import 都不发**'
  - 'asof 落在日历判定的非交易日（周末**或节假日**）→ NON_TRADING；未带 asofAck ⇒ 409'
  - 'asof 落在日历覆盖声明之外 → UNKNOWN；**MUST NOT 折进 OK**，未带 asofAck ⇒ 409（放行等于替日历做主）'
  - 'asof 等于交易所今天 → TODAY：仅 warning，**不阻断**（服务端判不了该场收没收盘）'
  - 'asofAck=shift ∧ 日历解得出前一交易日 → 用建议日落库，appliedAsof ≠ 提交行 asof'
  - 'asofAck=shift ∧ 日历解不出 → 409 ASOF_SHIFT_UNRESOLVABLE，**不猜**、不拿最接近的日期凑'
  - 'asofAck=accept → 原样发，asofFlag 照实回给客户端留痕'
  - '待审条目 status ≠ PENDING → 409 SUBMISSION_NOT_PENDING（**不是 404**：「已被处置过」与「不存在」是两件事）'
  - '锚表无该 ticker → disposition=create；采纳后 coldStartExpected=true（排一个分钟级、concurrency=1 的真 vendor 冷启动）'
  - '锚表已有该 ticker ∧ 四个模型事实不全等 → disposition=refresh：冲掉三处人工位并把 confidence_source 翻 model，fallbackPreview 逐条列出'
  - '锚表已有该 ticker ∧ 四个模型事实全等 ∧ 来源已是 model → willBeNoop=true，fallbackPreview 恒空（什么都不写的操作 MUST NOT 配「将清掉 3 处人工位」的警告）'
  - '导入成功 ∧ 条件更新命中 → statusFlipped=true，consumedAnchorId 落库'
  - '导入成功 ∧ 条件更新 0 行（并发抢跑）→ **200 + statusFlipped=false**，ERROR 级留痕；MUST NOT 回 5xx（锚已写，客户端重试会写第二遍）'
  - '批量驳回命中 PENDING 子集 → rejected=命中数、skipped 列出其余；MUST NOT 折成一句 ok'
  - '投递口撞上同 (ticker, asof) 的 PENDING 行 → 覆盖该行并回同一个 id，createdAt 不动'
  - '投递口撞上同 (ticker, asof) 但状态已是 CONSUMED/REJECTED → 正常新建（partial unique 只约束 PENDING，驳回后必须能重投修正版）'
  - '冷启动结局十档中的五档（retry_exhausted / backfill_incomplete / calendar_missing / session_unregistered / ticker_unresolved）→ needsAttention=true'
  - '冷启动查不到该 anchorId → **不返回该行**，且这有语义（排队中或正在跑）；MUST NOT 编占位结局'
  - 'markets flag off（公开构建）→ 审批与消息两栏均不渲染；深链被 MarketsRouteGuard 重定向'
  - 'isAdmin=false（含 /me 未落地时的冷启动种子）→ 审批栏不渲染；即便伪造该位，服务端 AdminOnlyGuard 仍 403'
---

# Feature Specification: 锚待审箱审批线上化 + 「我的」三栏改版

**Feature Branch**: `072-anchor-submission-review`
**Created**: 2026-08-31
**Status**: Implementing（server 半程已 ship，PR #312；mobile 半程进行中）
**决策记录**: [ADR-0069](../../docs/adr/0069-anchor-submission-review-surface.md)

## 过程留痕（诚实交代，不要删）

🚨 **本 spec 是实装 server 半程之后补写的，不是先 spec 后码。** 经过：维护者敲 `/plan` 进
harness 的 plan mode → agent 写了 `docs/private/plans/2026-08/08-31-anchor-submission-review-online.md`
→ 直接实装。agent 在 plan 头部与 PR #312 body 里备注了「未走 `/speckit-specify`」，但**从未把
这个岔路显式摆给维护者选**。

补写的目的不是补票，而是：① 恢复模块倒查（frontmatter `modules:`）；② 给 `state_branches`
一个落点，让 ADR-0040 那道 checkbox 不再是 vacuous；③ 把散在对话里的 6 条澄清固化。
**mobile 半程尚未实装 ⇒ 本 spec 对后半程是真正前置的。**

## 背景

`optionsdesk.anchor_submission` 是访客（`friend2`）经 guest 通道投递的估值待审箱。059 把它
设计成**零审阅面**：审阅 = DB 直连看，采纳 = 本人用自己的凭证把同样的值经导入口重放一次。
那个设计的价值全在一句话上 —— FR-012「系统 MUST NOT 存在第二条写锚路径」由「本表根本没有
通向锚表的代码路径」这条**拓扑性质**保证，而不是靠纪律。

代价是这条流程从来没上线过：处置全靠 `ops/bin/anchor-approve.sh` 走 ssh → docker exec → psql，
人不在电脑前就动不了。08-31 直查 prod：168 行里 **47 条 PENDING** 躺着，`REJECTED` 恒为 0
（该状态在仓里没有任何写者），且存在 2 组**逐值全等**的重复投递。

## User Scenarios & Testing

### US1 — 管理员在 App 里看待审箱

作为系统管理员，我打开「我的 → 审批」，看到每条待审的**标的中文名 + 代号 / V / 口径日 / 方法 /
置信度 / 提交方理由**，以及三个判断依据：这条会**新建还是刷新**锚、口径日**可不可信**、
若不可信**建议改到哪天**。少任何一样我就得回去开 psql，那这条线就白搬了。

### US2 — 逐条审核并采纳

我可以修正 V / 口径日 / 方法 / 置信度四个字段（**ticker 不可改**），写一条审核备注，
然后采纳。采纳前必须看到复述：改成 refresh 时逐条列出会被冲掉的人工位。

### US3 — 口径日可疑时被拦住

口径日落在未来 / 非交易日 / 日历没填到的区段时，采纳被拦下，给我三个出口：
改送建议日 / 原样照发 / 取消。日历解不出建议日时，**「改送」那个出口不出现**。

### US4 — 批量驳回

明显不该采纳的条目可以多选一次性驳回并写理由。有条目在我脚下被别处处置掉时，要如实告诉我
有几条没驳成。

### US5 — 看冷启动结局

采纳产生新锚后，我能看到冷启动跑成了什么，且**五档永久缺口要被顶到眼前**。

### US6 — 普通用户看不见

非管理员永远看不到审批入口；公开商店构建里审批与消息两栏都不出现。

## Requirements

### Functional Requirements

- **FR-001**: 系统 MUST 提供待审箱列表读端点，逐条给出 `disposition` / `asofFlag` /
  `asofSuggested` / `instrumentName`。列表 MUST NOT 分页（判据同 `list-anchors`：单人自用、
  防护由限流桶承担；分页会引入「采纳第 3 行使第 2 页平移」的真 bug 类），改用硬上限 + `truncated`。
- **FR-002**: 系统 MUST 提供单条详情端点，额外给出 `fallbackPreview` 与 `willBeNoop`。
  预览 MUST 复用与真实写入路径**同一个纯函数**，MUST NOT 另写一份判据。
- **FR-003**: 采纳 MUST 经 `ImportAnchorFromModelUseCase` 落锚。系统 MUST NOT 存在第二条写锚
  路径（继承 059 FR-012，**原文不变**）。该纪律 MUST 由机器强制
  （`check-server-moat.ts` 的 `WRITE_ALLOWLIST`），MUST NOT 只靠注释与 review。
- **FR-004**: 采纳 MUST 先导入、后翻状态。两者 MUST NOT 置于同一事务
  （callee 在自己 tx 内发 outbox 且含同步 vendor 调用；回滚锚写入无法「取消发布」冷启动事件）。
- **FR-005**: 口径日闸 MUST 判**最终 asof**（含审核方的修正），MUST NOT 判存储值。
- **FR-006**: `ticker` MUST NOT 可编辑。
- **FR-007**: 驳回 MUST 可批量、采纳 MUST NOT 可批量。判据是副作用数量而非对称性。
- **FR-008**: 待审箱 MUST 对 `(ticker, asof)` 唯一，且该唯一性 MUST 只约束 `PENDING`
  （全表唯一会让「驳回后重投修正版」永久不可能）。投递口 MUST 幂等。
- **FR-009**: 系统 MUST 提供冷启动结局读端点。「要不要人管」的分档 MUST 与十档值域**同处一点**，
  MUST NOT 在客户端复制。
- **FR-010**: 审批面 MUST admin-only，且 MUST 由**类级** guard 保证
  （方法级是会被未来某个 PR 漏掉的纪律）。客户端的 `isAdmin` MUST 只用于决定渲染与否。
- **FR-011**: 「我的」三栏 MUST 为 `审批 / 消息 / 知识库`。消息栏 MUST 复用既有预警消息中心，
  且 MUST 删除其「待办」栏。
- **FR-012**: 置已读 MUST 跟随「消息栏是否为当前激活栏」，MUST NOT 跟随路由 focus
  （否则停在审批栏也会把所有预警静默置已读）。
- **FR-013**: 两条采纳路径（App 审批面与 `ops/bin/anchor-approve.sh`）MUST 写出**形状一致**的
  `CONSUMED` 行 —— 即脚本也 MUST 回填 `consumed_anchor_id`。
  🚨 这是本片**新造出来的**风险：`consumed_anchor_id` 是 072 引入的，脚本不回填的话，
  「有锚但没有 submission 指向它」那条孤儿锚检出查询会被**每一条脚本处置过的行**喂出假阳性，
  而那条查询正是 FR-004 半截态可观测性的唯一兑现方式。

## Success Criteria

> 稳定标识 —— tasks / plan 一律按 `SC-00N` 引用（体例同 071 的 `SC-003`）。

- **SC-001**: 47 条积压可以完全在 App 内处置完，**不需要开一次 psql**。
- **SC-002**: 在 approve use case 里写一句 `prisma.anchor.update` ⇒ 探针 `EXIT=1` 并点名行号；
  撤销后回 `EXIT=0`。
- **SC-003**: 冷启动值域加第 11 档而不归类 ⇒ 穷尽性单测当场红。
- **SC-004**: 采纳 / 驳回后列表当场刷新，**不需要重启 App**（验证顺序必须是先访问列表再操作，
  反序是假绿）。
- **SC-005**: 公开构建（`FEATURE_MARKETS_ENABLED=false`）下审批与消息两栏均不可见、深链被重定向。
- **SC-006**: 脚本与 App 两条采纳路径写出的 `CONSUMED` 行形状一致 ⇒ 孤儿锚检出查询零假阳性
  （FR-013 的可验形式）。

## Clarifications

> 以下 6 条来自实装前的对话，补录于此（原本应是 `/speckit-clarify` 的产物）。

- **消息栏装什么** → 复用既有预警消息中心；**删掉「待办」栏**（后续再细化成「审核的审核 /
  做任务的任务」，届时重新设计信息架构，不被今天这个占位绑手脚）。
- **提交方 `note` 怎么处置** → 审核页**只读**展示；另加 `anchor_submission.review_note`
  存审核方批注。**锚表不加 note 列**（`anchor` 本就没有该列，采纳时 note 一直是被丢掉的）。
- **审批粒度** → 单条采纳 + 批量驳回。
- **冷启动观测** → 进 V1，全 10 种 outcome 都显示，五档需人工介入的置顶。
- **唯一键** → `(ticker, asof)`（不含 `submitter`；今天只有一个提交方，接第二个访客那天
  这会变成真实取舍，已挂 ADR-0069 `sunset_trigger`）。
- **公开构建下的三栏** → 审批是 admin 行为、普通用户永不可见，**不为「只剩一栏」写特殊分支**。
