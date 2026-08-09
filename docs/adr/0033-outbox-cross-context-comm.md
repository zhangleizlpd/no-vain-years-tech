---
adr_id: ADR-0033
status: Accepted
applies_to: [apps/server]
sunset_trigger: |
  - 切真分布式 (Kafka / NATS / Pulsar) — Outbox 仍是入口但 publisher 切外部 broker
  - 业务 < 5 use case 跨 context (Outbox overhead > benefit)
  - bounded context 合并回单 context (per [ADR-0032](0032-backend-bounded-context.md) sunset)
  - envelope schema 演进到 trace_id 多源 (e.g. distributed tracing span_id 取代 cls-managed id)
---

# ADR-0033: Cross-Context Communication via Outbox (event metadata.trace_id 强制)

- Status: Accepted (2026-05-22) — shipped via [05-22 bounded context governance plan](../private/plans/2026-05/05-22-server-bounded-context-governance.md) O1 work unit
- Deciders: project owner
- Tags: backend / architecture / messaging / cross-cutting

## Context

[ADR-0032](0032-backend-bounded-context.md) 拆 security / account / auth 3 bounded context 后,跨 context 通信选项:

| 选                   | 优                | 劣                                                               |
| -------------------- | ----------------- | ---------------------------------------------------------------- |
| (a) 同步 DI 调用     | 简单              | 强耦合;auth context 直接调 account 内部 → 跨 context boundary 漏 |
| (b) HTTP 内部调用    | 边界清            | 同进程内 HTTP overhead 不合理                                    |
| (c) **Outbox event** | 异步解耦,事务保证 | 复杂度 ↑;需 schema 治理                                          |

Plan 1 W2.4 已实装 `outbox_event` 表 + `OutboxPublisher` (per memory `feedback_transactional_outbox_port_shape` + `reference_mono_db_pull_modulith_event_publication`),复用之。

## Decision

### 跨 context 调用规则(演进层，详见 ADR-0034)

| 场景                                 | 路径                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same context                         | DI 调用 use case (直 import 同 module application service)                                                                                                                                                                                                                                                                    |
| Cross-context **sync**(同 tx 强需求) | 编排型 use case **委托 callee 的 UseCase**(per [ADR-0043](0043-server-flat-module-paradigm.md) §3a 生命周期委托;e.g. `phone-sms-auth.usecase` 调 `account` 的 `commit-phone-login`,**不**内联 `tx.account.create` —— 护城河);**强烈建议**显式写 `// CROSS-CONTEXT-SYNC: <reason>` 注释以利影响面分析,当前阶段不做 CI 刚性卡点 |
| Cross-context **async** (default)    | **Outbox event**;publisher 一边写 outbox_event 一边业务写同 tx,后台 worker 消费                                                                                                                                                                                                                                               |

### Event payload envelope schema 强制 `metadata.trace_id`

Envelope shape (Zod schema 实装: `apps/server/src/security/outbox/outbox-event-envelope.schema.ts` —— 物理位置 per [ADR-0043](0043-server-flat-module-paradigm.md) 从 `auth/` 迁入平台基座 `security/outbox/`):

```ts
type OutboxEventEnvelope = {
  metadata: {
    trace_id: string; // ← 强制,联 [ADR-0036](0036-observability-logging-governance.md) trace 串联
    occurred_at: string; // ISO 8601 (publisher 写入瞬间 timestamp)
    event_version: number; // 当前 1
    producer_context: string; // 'auth' / 'account' / 'security' / ...
  };
  data: Record<string, unknown>;
};
```

envelope 在 publisher.publish() 入口被 `OutboxEventEnvelopeSchema.parse()` 拦截,任一字段缺失 / 类型错都 fail-fast 拒写表。

### 实装关键决策 (post-PR Accepted 时点的最终选择)

| #   | 决策点                    | 选择                                                                                                                                                      | 理由                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | envelope 落 DB 怎么放     | **payload jsonb 内含 metadata** (`outbox_event.payload` 单列), 不加 `metadata` 单列                                                                       | 0 migration; 现 1 caller 1 event type; 列拆分等 Plan 2 真 trace 查询需求 surface 再 amend                                                                                                                                                                                                                                          |
| 2   | 现有 row backfill         | **不 backfill**                                                                                                                                           | prod 0 用户 0 row; 老 row 仅 test/dev fixtures, truncate test DB 即可                                                                                                                                                                                                                                                              |
| 3   | publisher 怎么拿 trace_id | **publisher 内 `@Optional()` inject ClsService**, caller 透明 (port shape 不变, 仍 3 参数); fallback `out-of-request-<uuid>` 当 CLS 未注入或 `getId()` 空 | caller 不动 = 改动最小; out-of-request publishers (cron / worker) 不阻塞; 与 memory `feedback_transactional_outbox_port_shape` 一致                                                                                                                                                                                                |
| 4   | `producer_context` 怎么定 | **publisher 写死 `'auth'` 起步**（已知 stale）                                                                                                            | publisher 现 bind 进 `SecurityModule`（per ADR-0043 outbox 迁 `security/outbox/`）,且实际 publish 已移入 **account ctx**（`CommitPhoneLoginUseCase` 发 `auth.account.created`）—— `producer_context` 仍硬编码 `'auth'` 已与发布方 ctx 不符,待 Plan 2 跨 context publisher 增多时切 event_type prefix 自推 或 caller 显式传一并修正 |
| 5   | `event_version` 默认      | **publisher 默认 1**, caller 当前不传 (envelope schema break 时引入 override 参数)                                                                        | 起步 schema 稳定; 真有 evolution 需求再加 caller 参数                                                                                                                                                                                                                                                                              |
| 6   | ADR-0033 状态翻转时点     | **impl + 测试同 PR ship 时翻 Accepted**                                                                                                                   | 与 ADR-0032 PR-4 实装翻 Accepted 模式一致, 减少 ADR-impl drift                                                                                                                                                                                                                                                                     |

### trace_id 来源(决策点 3 详细)

1. HTTP req header `x-trace-id` → `nestjs-cls` middleware (per [ADR-0036](0036-observability-logging-governance.md) + `security.module.ts` `idGenerator` 钩 inbound header) → `AsyncLocalStorage`
2. publisher 内 `this.cls?.getId()` 取
3. fallback: `out-of-request-<uuid>` 当 cls 未注入或 getId() 返回 undefined / 空串

### consumer 端 (留 W3+ 真消费者引入时实装)

- worker process (apps/server 内独立 NestJS module `OutboxWorkerModule`) tail `outbox_event` 表
- 处理时 hydrate `envelope.metadata.trace_id` 进 CLS → consumer 内业务调用 / log 全部继承同 trace_id (per ADR-0036)
- idempotent by event_id (PK 在 outbox 表)
- **当前未实装** — `outbox-event-cron.publisher.ts` 仍是 T041 placeholder, scan + mark published, 不 dispatch

### outbox publisher port shape (per memory `feedback_transactional_outbox_port_shape`)

```ts
interface OutboxPublisher {
  publish(
    client: unknown, // Prisma client 或 $transaction TransactionClient
    eventType: string,
    data: Record<string, unknown>, // flat data, publisher 内部封 envelope
  ): Promise<void>;
}
```

caller 显式传 tx client → publish 与业务写共享 tx,无 CLS / new-in-tx 复杂度。data 经 publisher 封 envelope 后写 outbox_event.payload。

## Consequences

- security / account / auth 之间 default async,强解耦 + 自动 trace 串联(已实装)
- `phone-sms-auth.usecase` 编排型保留同 tx 直 import (合规),其余跨 context 全走 outbox
- `outbox_event` table schema **不**改 — envelope 写入现有 `payload` jsonb 列 (per 决策点 1);现有 row 不 backfill (per 决策点 2)
- Worker module 跑独立 process / 同进程?— 起步同进程 (低成本),性能瓶颈触发再拆
- `OutboxEventPrismaPublisher` 实装注入 `ClsService` (`@Optional()` 让 race spec 等无 DI 上下文测试可 0-arg 构造); spec 双路径覆盖 (CLS provides trace_id / fallback `out-of-request-<uuid>`)
- US2 e2e (`apps/server/test/integration/accounts.us2.e2e.spec.ts`) 验 inbound `x-trace-id` header → outbox row `payload.metadata.trace_id` 串通 + response header echo

## Open Questions

- Worker 失败重试策略(指数退避 / dead-letter)— 起步 N=3 简单重试,DLQ 留 Plan 3 ship
- `event_version` evolution (schema break 后旧 consumer)— Plan 3 真用户量起再设
- 跨 context publisher 出现时 `producer_context` 切 event_type prefix 自推 vs caller 显式传 — Plan 2 第一个 account / 其他 context 发 event 的 feature surface 时决定

## References

- memory `feedback_transactional_outbox_port_shape`
- memory `reference_mono_db_pull_modulith_event_publication`
- [ADR-0032](0032-backend-bounded-context.md)
- [ADR-0036](0036-observability-logging-governance.md) (trace 串联消费端)
- [05-22 bounded context governance plan](../private/plans/2026-05/05-22-server-bounded-context-governance.md) — O1 work unit (本 ADR ship 即该 unit 产出)
- PR #79 — `nestjs-cls` middleware mode 让 trace_id 覆盖 Guards/Filters (本 ADR trace_id 来源基础设施)
