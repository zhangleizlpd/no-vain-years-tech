---
adr_id: ADR-0069
status: Accepted
applies_to: [apps/server, apps/mobile]
sunset_trigger: |
  - **第二个账号拿到 `account.is_admin = true`** → 立刻重审两件事：① `anchor_submission` 是否要补 `reviewed_by`（一个 admin 时它是 YAGNI，两个时它是必需）；② 去重唯一键 `(ticker, asof)` **不含 submitter** 的取舍（两个访客对同一「标的 × 口径日」的分歧，届时要决定是「一个待裁决的冲突」还是「两条独立待办」）
  - **`WRITE_ALLOWLIST` 的锚写者超过 ~12 个** → 说明「单写路径」已名存实亡，重审是把粒度收窄到估值事实那几列（AST 解析 `data:` 键集），还是承认锚表本就多写者、改用别的不变量表达 FR-012
  - **接入第二个提交方（非 friend2）** → 重审 upsert 语义：今天「同键覆盖」建立在「只有一个提交方且重复都是误投」的实测之上，多提交方下覆盖就是在替人裁决
  - **待审箱稳态 > 每天十几条** → 重审「不分页 + 硬上限 500」与「除 partial unique 外不建查询索引」两条
---

# ADR-0069：锚待审箱的审阅面 —— 用探针换回 FR-012 的结构性保证

## Context

059 建 `optionsdesk.anchor_submission` 时做了一个**刻意**的决定：**零审阅面**。不做审核 UI、
不做审批端点、不做转正 CLI。审阅 = DB 直连看，采纳 = 本人用自己的凭证把同样的值经导入口
**重放一次**。

这个决定的价值全在一句话上：spec FR-012「系统 MUST NOT 存在第二条写锚路径」由
**「本表根本没有通向锚表的代码路径」在结构上保证，而不是靠纪律**。拓扑性质不会因为某个 PR
的疏忽而失效 —— 这是它比注释和 code review 强的地方。

代价是这条流程从来没上线过。处置全靠 `ops/bin/anchor-approve.sh` 走 ssh → docker exec →
psql，人不在电脑前就动不了。08-31 直查 prod：168 行里 **47 条 PENDING** 躺着；
`REJECTED` 恒为 0 —— 那个状态在仓里**没有任何写者**。

同时暴露出第二个问题：待审箱有重复行。样例 155/156 是 `us:CFG @ 2026-08-30` 的两条，
五个值字段**逐字节相同**，只差 28 分钟的 `created_at`。而 059 同样刻意地写着
「一行 = 一次提交…故**无唯一键** —— 幂等在这里是错的语义」。

## Decision

### 1. 建审批面，把 FR-012 的保证方式从「拓扑」换成「探针」

审批面搬进 App（admin-only）。`ApproveAnchorSubmissionUseCase` **MUST** 委托
`ImportAnchorFromModelUseCase`，**MUST NOT** 自己碰 `prisma.anchor.*`。

**FR-012 本身一字不改。** 变的是它靠什么成立：

|          | 059                    | 072                                                    |
| -------- | ---------------------- | ------------------------------------------------------ |
| 保证方式 | 拓扑：本表到锚表没有边 | 委托纪律：只有一条边，且指向同一个 use case            |
| 强制层   | 结构（无需强制）       | `check-server-moat.ts` 的 `WRITE_ALLOWLIST`（Check 3） |

🚨 **一条纪律不是一个保证。** 只有机器强制的版本才诚实。既有的 Check 1 管**跨 ctx** 归属，
而 `anchor` 与 `anchor_submission` 同属 optionsdesk ⇒ 采纳 use case 直写锚表属**同 ctx R1，
Check 1 看不见**。Check 3 就是为补这个洞而加的：登记在册的 model，其**写操作**只允许出现在
白名单文件里。

**验收判据**（已实测）：在 approve use case 里写一句 `prisma.anchor.update`
⇒ 探针 `EXIT=1` 并点名文件与行号；撤销后回 `EXIT=0`。

落地时探针立刻发现手工清单漏了一个真实写者：`get-radar.usecase.ts` 在读路径里推进
`breach_started_on` 状态机。它是正当写者（只写那一列，不碰估值事实），已登记。
⇒ **名单的真值用 AST 复算，别手工 grep 维护。**

### 2. 唯一键 `(ticker, asof)`，partial `WHERE status = 'PENDING'`

059 那句「无唯一键、幂等是错的语义」防的是**把两份不同的估值折成一份**；它防不住、也不该防
**同一份估值被误投两次**。实测把这件事定死了：PENDING 里 distinct `(submitter,ticker,asof)`
= 45，而 distinct 完整五元组**也是 45**，「同 `(ticker,asof)` 但估值不同」的组数 = **0**。
⇒ 存量每一组重复都是逐值全等的误投，加唯一键**零信息损失**。

🚨 **必须 partial。** 全表唯一会让「驳回之后重投一份修正版」永久不可能，而那恰是驳回之后
最该发生的事。partial 的语义是「同一个 (标的, 口径日) **同时**最多一条待审」。
实测：同键再插 PENDING 被拒；同键插 REJECTED 放行。

### 3. 存量重复标 `REJECTED`，不 DELETE

删 prod 行不可逆，而这些行虽无信息增量却是真实发生过的投递。标记非破坏、可审计、可回滚。

## Consequences

### 好的

- 审批不再依赖「人坐在装了 ssh key 与隧道的那台机器前」。
- `REJECTED` 第一次有了真实写者。
- Check 3 是**通用机制**：以后任何需要「单写路径」的表都可登记。
- 待审箱不再堆重复行，投递口真正幂等。

### 要付的代价（诚实列出）

- **FR-012 的保证弱了一档。** 拓扑保证是「不可能」，探针保证是「会被发现」。二者不等价：
  探针只在 CI 与 lefthook 跑，绕过它的路径（改白名单、加 `eslint-disable` 式的旁路）存在。
  接受它的理由是**审批面的价值 > 这一档强度差**，而不是「它们其实一样」。
- **Prisma 类型层与 DB 层就此不一致。** 生成的客户端把 partial unique 建模成**全表**复合唯一
  （`"id" | "ticker_asof"`），谓词在类型系统里消失 ⇒ 读写必须自己写出 `status: 'PENDING'`，
  且 **MUST NOT 用 `upsert`**。已实测：`upsert` 类型全绿、运行时报
  `there is no unique or exclusion constraint matching the ON CONFLICT specification`。
  这类「类型绿、运行时炸」只有真 PG 的 IT 抓得到。
- **唯一键不含 `submitter`** 是一个今天无成本、将来有成本的取舍（见 sunset_trigger）。
- 白名单需要维护；忘了登记正当新写者会红一次（可接受：红在 CI，不是红在 prod）。

## Alternatives considered

| 方案                                                   | 否掉的理由                                                                                                                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 维持零审阅面，只改进 shell 脚本                        | 不解决「人必须在那台机器前」；47 条积压正是这个约束的产物                                                                                                                              |
| 把 Check 3 的粒度收窄到估值事实那几列                  | 要 AST 解析 `data:` 键集，为边际精度换一堆复杂度。代价是 `get-radar` 这类只写派生列的正当写者也要登记 —— 可接受，且它反而让每个写者都成为一次显式决定                                  |
| 全表唯一键                                             | 断掉「驳回后重投修正版」这条正当路径                                                                                                                                                   |
| `DELETE` 存量重复                                      | 不可逆，且删的是真实发生过的投递记录                                                                                                                                                   |
| 审批端点挂既有 `OptionsdeskController`（方法级 guard） | 机制可行，但类级 guard 是**保证**、方法级是**纪律**：共享 controller 上一个忘写 `@UseGuards` 的新路由会对每个登录账号静默敞开且不报红。同 `optionsdesk-guest.controller.ts` 自己的立论 |
| `role` 表 / RBAC                                       | 仓内零 RBAC，第二个角色还不存在。一个 `is_admin` 布尔够用                                                                                                                              |

## References

- [ADR-0043](0043-server-flat-module-paradigm.md) §5 护城河 / 扁平贫血范式
- [ADR-0034](0034-auth-account-operation-catalog.md) 探针化演进 Stage C
- [ADR-0062](0062-optionsdesk-bounded-context.md) optionsdesk 边界（本 ADR 补充其 Consequences，不 supersede）
- `specs/059-anchor-model-import/plan.md` §6（原「零审核面」判据，已标 superseded）
- `scripts/checks/check-server-moat.ts` `WRITE_ALLOWLIST`（Check 3 实装）
