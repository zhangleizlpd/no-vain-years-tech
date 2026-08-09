---
adr_id: ADR-0052
status: Accepted
applies_to: [apps/server]
sunset_trigger: |
  - 出现第二类消息源（非预警触发的系统通知/公告等）→ 重审消息中心归属，评估拆独立 notification ctx + Outbox consumer（演进路径 (b)）
  - marketdata outbox 出现 ≥2 个真实 consumer（relay 基础设施摊销成立）→ 重审「自治 cron」是否切换为事件驱动评估
  - 接入盘中实时数据源（预警升级盘中口径）→ 重审 EOD cron 调度形态与求值数据通路
---

# ADR-0052: Alert 第 6 Bounded Context — 调度自治 EOD 预警引擎 + 跨 ctx 仅 Q7-B 只读 ×2

- Status: Accepted (2026-06-06)
- Deciders: @zhangleizlpd
- Tags: server / bounded-context / alert / scheduling
- Relates: [ADR-0032](0032-backend-bounded-context.md)（bounded context 拆分框架）/ [ADR-0043](0043-server-flat-module-paradigm.md)（扁平贫血范式）/ [ADR-0048](0048-marketdata-portfolio-cross-layer-dependency.md)（Q7-B 直查先例）/ [ADR-0049](0049-marketdata-scheduler-bullmq-hybrid.md)（017 调度体系，明确**不挂**）/ [ADR-0033](0033-outbox-cross-context-comm.md)（outbox 演进 seam）；实施载体 = [021-alert-management](../../specs/021-alert-management/spec.md)（spec/plan/tasks）

## Context

021 预警管理 = 预警 CRUD + EOD 评估引擎 + 应用内消息中心三件套（[需求对焦](../private/plans/2026-06/06-06-alert-management-v1-scope.md)）。两个架构问题需要定稿：

1. **归属**：预警域落既有 5 ctx（security/account/auth/portfolio/marketdata）哪一个，还是新立 bounded context？
2. **评估调度**：spec FR-S04「每交易日 EOD 同步完成后评估一轮」——「完成信号」从哪来？017 调度链（ADR-0049）与 outbox（ADR-0033）都是候选挂载点。

## Decision

### 1. 新立第 6 bounded context `alert`（catalog Q4 命中）

[catalog](../conventions/server-bounded-context-catalog.md) 7Q 逐条：Q1 否（4 表全新无既有 owner）/ Q2 否（CRUD·评估·消息全在域内闭环）/ Q3 否（业务领域非 platform infra）/ **Q4 是**——预警监控引擎是全新业务领域，5 现 ctx 都不沾；落 portfolio 会让其吃进「调度 + 引擎 + 消息」三类异质职责。Q5/Q6 否（无跨 ctx 写、无同步编排、无 side-effect 通知）/ Q7 是 ×2（见 §3）。

- 物理面：`apps/server/src/alert/`（ADR-0043 扁平贫血）+ Prisma schema `alert` 4 表（`alert` / `alert_condition` / `alert_trigger` / `alert_read_cursor`，moat owner=alert）+ `apps/mobile/src/alert/`（business-naming 三处同名）。
- 依赖面：**叶子 ctx**——单向 `alert → account`（JwtAuthGuard/AccountIdThrottlerGuard 鉴权 artefact 经 export 复用，非业务调用）+ `alert → security`（platform infra）；无人依赖 alert。ESLint boundaries + moat 探针双层强制。
- **消息中心 V1 暂归 alert**：当前唯一消息源 = 预警触发（AlertTrigger 兼任消息源 + per-account 已读水位线）。多消息源出现时再评估拆 `notification` ctx（sunset trigger #1）。

### 2. 评估调度自治（不挂 017 / 不建 outbox consumer）

FR-S04「同步完成后评估」三条实现路径：

| 路径                             | 形态                                                                                                                                               | 判定                                                                                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) 挂 017 调度链                | alert 注册成 SyncDimension 维度 / executor 钩子                                                                                                    | ❌ marketdata 反向知道 alert——底座依赖业务，方向错；DIMENSION_KEYS/registry 是 marketdata 私有面                                                                                                |
| (b) outbox 事件                  | marketdata 发 `eod-sync-completed` → alert consumer                                                                                                | ❌ 消费端基础设施尚不存在（outbox publisher 是 placeholder、零真实 consumer），为单消费者建 relay 不摊销                                                                                        |
| (c) **自治 cron + 幂等**（取此） | alert 自持 BullMQ queue `alert-eval`（repeatable `0 23 * * *` 主跑 + `0 8 * * *` 翌晨 catch-up，Asia/Shanghai）+ `(alertId, tradeDate)` 唯一键判重 | ✅ 时间解耦——把「完成信号」弱化为「幂等轮询」：重复评估撞唯一键 P2002 catch-skip 天然 no-op；同步晚到由翌晨 catch-up 兜；非交易日/停牌 = 最新 bar 的 tradeDate 已评估过 → no-op（无需交易日历） |

- Redis 连接镜像 `marketdata-queue-connection.ts` provider 模式，alert 自持 `ALERT_QUEUE_REDIS` token 不共用连接对象。
- (b) 是演进路径：多 outbox consumer 出现时切事件驱动（sunset trigger #2）。

### 3. 跨 ctx 面 = 仅 2 条 Q7-B 只读直查（018/ADR-0048 先例，同摊销判据：每晚一读 + 一句话重建 + 无投影对象）

1. 评估引擎读 `marketdata.daily_bar`（**none 口径**最新 bar 的 high/low/close/prevClose/tradeDate——用户阈值是对真实成交价设的）。
2. 触发时读 `marketdata.instrument.name` 快照进流水（消息渲染走快照，不 join 活数据）。

两处 `prisma.<表>.find*` 上方 **必须** `// CROSS-CONTEXT-READ:` 注释（`check-server-moat` 探针强制）；**跨 ctx 写永远禁**。

## Consequences

- 021 PR-1 实装本 ADR 全部注册面（schema/migration + boundaries + moat + module 空壳）；PR-2 实装评估引擎与调度；PR-3 mobile。
- 新表接线必须在 `MODEL_OWNERSHIP` 声明 owner=alert，否则 moat 探针 `moat-unmapped` 硬拒。
- 评估时效 = cron 节奏而非「同步完成即评」：主跑 23:00（prod 三维度 22:00 同步后），最坏迟到一晚由翌晨 08:00 catch-up 兜底（SC-002 在两个 tick 内均满足）。

## Trade-offs

- **轮询 vs 事件驱动**——接受最多两 tick 的评估延迟，换零跨 ctx 调度耦合 + 零新基础设施；EOD 预警的业务时效本就是「日」级。
- **消息中心暂归 alert**——下期多消息源时要迁移；接受理由：V1 仅一种消息，提前抽 notification ctx 是无消费者的投机抽象。
- **alert 自持 Redis 连接 token**——多一份连接对象；换 queue 生命周期与 marketdata 完全解耦（互不影响重启/清队）。

## Open Questions

- 无（V1 范围内全部决策已定；盘中模式/外部推送/技术指标条件均为下期 backlog，见 spec Assumptions）。

## 复审记录

### 2026-06-07 — 022 预警推送送达：push 出口归 alert，sunset trigger #1 未触发

[022-alert-push-delivery](../../specs/022-alert-push-delivery/plan.md)（plan D1/D2）对本 ADR 两处复审：

1. **push 出口 ctx 归属（D1）**：catalog Q4 重审——sunset trigger #1 以**第二类消息源**为成立要件；022 消息源仍唯一（预警触发），新增的是**送达通道**（极光推送），非新消息源 → trigger 未命中，**不立 notification ctx**。push_binding / push_delivery 2 表自持 owner=alert（moat 注册），alert 仍叶子 ctx（外呼极光 = gateway port vendor I/O，非跨 ctx 边）。第二类消息源出现时连消息中心一起拆 notification，届时迁移成本 = 2 表 + 2 端点改前缀，已计入接受。
2. **触发→推送解耦载体（D2）**：不走 security/outbox 通用事件表（单消费者不摊销 + same-ctx 非 ADR-0033 设定的跨 ctx 通信，与本 ADR §2 路径 (b) 否决同判据）；取 **push_delivery 专表 transactional outbox**——trigger tx 内 fan-out PENDING 行 + BullMQ `push-dispatch` 异步消费，ADR-0033 pattern 语义完整保留、仅载体换业务专表。outbox 通用消费 infra 仍是 sunset trigger #2 的演进路径。

## References

- [021 spec](../../specs/021-alert-management/spec.md) / [plan](../../specs/021-alert-management/plan.md)（D1-D11 决策表）
- [server-bounded-context-catalog](../conventions/server-bounded-context-catalog.md)（7Q 决策树）
- 018 Q7-B 直查先例：tiering 直查 holdings（[ADR-0048](0048-marketdata-portfolio-cross-layer-dependency.md) § Q7）
