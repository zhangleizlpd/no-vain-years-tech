---
adr_id: ADR-0046
status: Proposed
applies_to: [apps/server]
sunset_trigger: |
  - 出现「跨行聚合不变性」无法塌缩成单行的场景(聚合跨多 owner / 跨 ctx,单行反规范化破护城河) → § Decision 优先级重审
  - Prisma / PG 升级使 SERIALIZABLE 的 P2034 检测漏洞修复且 retry 成本可接受 → SERIALIZABLE 否决理由(§ Decision 3)重审
  - 单行塌缩的热组写锁成为实测瓶颈(高频同组并发写) → 引入分片 / 乐观版本 / 队列化,§ Trade-offs 重审
  - EvalPlanQual 语义在未来 PG 版本变化 → 「单行谓词不得碰他行」铁律(§ Decision 1)重审
---

# ADR-0046: 跨行聚合不变性的并发强制 — 单行塌缩 + conditional UPDATE(优先) / FOR UPDATE 锁组(fallback)

- Status: Proposed (2026-06-02) — 翻 Accepted 待 011 单行重构 ship
- Deciders: @zhangleizlpd
- Tags: concurrency / data-layer / portfolio

## Context

[011 stock-market-access](../../specs/011-stock-market-access/spec.md) 的 portfolio market-preference 有一条 **min-1 不变性**:每账号 ≥1 个核心市场(A 股/港股/美股)必须保持 `active`。这是一条**跨行聚合不变性**(约束横跨同组 ≤3 行的 `active` 计数),而非单行状态转换。

它是教科书级的 **write skew 异常**(Kleppmann《DDIA》"医生值班"例;PG SSI 作者 Kevin Grittner 在 pgsql 列表对同型问题的标准答复):READ COMMITTED 下,两事务并发关**不同**市场,各自的守卫读到的快照里对方仍 `active` → 都通过 → 都写 → 归 **0 激活**。

现有并发指引([server-impl-playbook.md](../conventions/server-impl-playbook.md) § 并发/事务)只覆盖**单行**状态转换(`conditional UPDATE + affected-count`;**NEVER** 单行 `FOR UPDATE` — 偏索引 SSI 假冲突,004 实证),**未覆盖跨行聚合不变性** → ADR 真空。011 PR1 用 `SELECT … FOR UPDATE` 锁组 + materialize-3-行解决,**正确但偏重**(4 语句/toggle + 裸 raw lock + materialize),触发本次重评估(见 [Plan B](../private/plans/2026-06/06-02-golden-sample-showroom.md) § FOR UPDATE 重评估)。

## Decision

**跨行聚合不变性**(min/max cardinality、"至少一个"、组内计数约束等)的并发强制,按优先级:

1. **优先「单行塌缩」**:把聚合状态反规范化到**每组单行**(`text[]` / `jsonb` / `int count`),使不变性变成**单行谓词** → `conditional UPDATE … WHERE <单行谓词>` + 检 `affected-count`(== playbook **默认**范式)。靠 PG 行写锁 + READ COMMITTED **EvalPlanQual**(第二个 UPDATE 阻塞 → tx1 commit 后在持锁态**重检谓词 against 最新行版本**)天然串行,**无显式锁、无 materialize、无 retry**。
   - 🔒 **铁律**:谓词必须**纯落在被锁的那一行**(禁子查询 / JOIN 他行)。EvalPlanQual **只重检已锁定的行**,不重检子查询里未锁的他行 —— 跨行谓词会漏掉 race(CockroachDB 工程博客明确)。
2. **fallback「FOR UPDATE 锁组」**:当 schema **不可改**(聚合跨多 owner / 反规范化破数据护城河)时,`SELECT … WHERE group=? FOR UPDATE` 锁**全组**行再 check+write。**正确且业界标准**(PG 官方文档对"应用层一致性检查"的两个 blessed 解之一),代价 = 多行 + 偏重。
3. **否决 SERIALIZABLE**:虽 PG 官方推荐,但需全员 SERIALIZABLE + 外层 retry 循环,且 Prisma 7 + adapter-pg 下 P2034 检测有漏洞(memory `prisma_serializable_p2002_and_p2034`)。
4. **否决裸 `conditional UPDATE + EXISTS 子查询`**:EvalPlanQual 不重检子查询他行 → **不防 race**(与铁律同因)。
5. **DB 约束表达不了**:`CHECK` 不能用子查询/聚合;`EXCLUSION`/partial-UNIQUE 只能约束"至多一个"(反向 cardinality)。

### 方案对比(研究锚:PG 官方文档 + Grittner + CockroachDB + Kleppmann)

| 方案                                           | 如何止 race                                  | 争用/规模                   | 正确性 caveat                                  | 选用时机                      |
| ---------------------------------------------- | -------------------------------------------- | --------------------------- | ---------------------------------------------- | ----------------------------- |
| **单行塌缩 + conditional UPDATE**(本 ADR 首选) | 谓词与写落同一行,EvalPlanQual 重检最新行版本 | 单行写锁(同组串行),无 retry | **仅当谓词纯单行**;反规范化字段须race-free维护 | schema 可改;聚合在单 owner 内 |
| FOR UPDATE 锁组(fallback)                      | 阻塞序列化全组 toggle                        | 组级阻塞,无 abort           | 必锁**全组**(只锁目标行无效)                   | schema 固定                   |
| SERIALIZABLE + retry                           | SSI 预测锁读集,commit 时 40001 abort         | 非阻塞但高争用 abort 率高   | 需全员 SERIALIZABLE                            | 低争用、想一刀切              |
| advisory xact lock                             | 按 key 串行,不锁行                           | 同 FOR UPDATE 但省行锁      | 靠纪律,无 DB 兜底                              | 跨表/行不存在时               |
| 裸 UPDATE+EXISTS 子查询                        | ❌ 不止                                      | —                           | EvalPlanQual 不重检他行                        | 不可用                        |

## Consequences

- **011 market-preference 重构为单行模型**(本 PR `refactor/market-preference-single-row` 实装):表 `portfolio.market_preference`(行/市场)→ `portfolio.portfolio_preference(account_id PK, active_markets text[])`;min-1 = 单行非空谓词;**去 FOR UPDATE + 去 materialize**。GET 投影读单行 array。API response shape 不变(经 `MARKET_CATALOG` 投影)。无 prod 数据 → 纯 schema swap(无行→array 数据迁移)。
- **server-impl-playbook § 并发** 加「跨行聚合不变性」小节,引用本 ADR(单行塌缩优先 / FOR UPDATE fallback / EvalPlanQual 单行铁律)。
- 后续 portfolio feature(012 券商额度 / 013 自选排序 / 014 计数类不变性)与其他 ctx 复用本范式。
- **EvalPlanQual 单行谓词铁律** 成为 server CR 检查点(conditional UPDATE 的 WHERE 不得碰他行)。

## Trade-offs

- **反规范化维护成本** — 一般 case 聚合字段须与底层多行 race-free 同步(同语句/触发器);**本 case 无底层多行**(直接以单行为真相源),无此负担。
- **热组单行写锁争用** — 与 FOR UPDATE 同争用面;**本 case 是冷路径**(客户端 in-flight guard 串行 + min-1 预判,服务端并发仅多设备/直接 API 兜底,per Plan B § 业务场景),可忽略。
- **保留 FOR UPDATE fallback** — 不贬其为反模式;schema 固定时它是标准正解。011 改单行是因 schema **可改且无数据**,非因 FOR UPDATE 错。

## Open Questions

- 是否把「单行 conditional UPDATE 谓词不得碰他行」做成机械 check(扫 raw SQL / lint)? 暂留 CR 人工把关,若复发再升机械层。

## References

- [011 spec](../../specs/011-stock-market-access/spec.md) / [Plan B § FOR UPDATE 重评估](../private/plans/2026-06/06-02-golden-sample-showroom.md)
- [server-impl-playbook.md § 并发/事务](../conventions/server-impl-playbook.md);[ADR-0043 扁平+贫血范式](0043-server-flat-module-paradigm.md)
- memory `prisma_serializable_p2002_and_p2034`(P2034 检测漏洞)
- PG 官方:[Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html) / [Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html) / [Application-level Consistency](https://www.postgresql.org/docs/current/applevel-consistency.html)
- Kevin Grittner(SSI 作者)pgsql 列表对同型 write-skew 的标准答复;[CockroachDB — Why we don't use EvalPlanQual](https://www.cockroachlabs.com/blog/why-cockroachdb-doesnt-use-evalplanqual/);Kleppmann《DDIA》write skew / materializing conflicts
