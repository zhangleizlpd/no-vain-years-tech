---
adr_id: ADR-0036
status: Accepted
applies_to: [apps/server, apps/mobile]
sunset_trigger: |
  - 切 OTLP / OpenTelemetry 真分布式 trace (jaeger / tempo / Datadog APM)
  - scale > 100 服务实例 (AsyncLocalStorage 伪 trace 单进程边界)
  - 个保法 / 等保 升级要求加密 log (本 ADR 仅 redact,不加密)
---

# ADR-0036: Observability and Logging Governance — stdout JSON + CLS trace + PII redact

- Status: Accepted (2026-05-21) — server side shipped via PR-5a; mobile telemetry deferred to Plan 3 (Sentry / Bugsnag 接入时)
- Deciders: project owner
- Tags: backend / mobile / observability / cross-cutting

> **PR-5a 实装注**: server 端 stdout JSON + nestjs-pino redact (15 paths: authorization/cookie/password/token/refreshToken/accessToken/jwt/smsCode/phone/...) + nestjs-cls AsyncLocalStorage trace_id (idGenerator honors inbound x-trace-id 头便于上游传播 / 否则 randomUUID) + customProps 注 trace_id 到每条 log + ProblemDetailFilter 注 traceId 到 RFC 9457 response body + x-trace-id header。Mobile 端 console wrap + remote log shipping 留 Plan 3。

## Context

A-002 ship 后 log 状态:

- `nestjs-pino` 装了但用默认配 — 无 redact / 无 trace_id / log level 用得乱
- mobile 端 `console.log` 散落 — 无统一收口
- 跨 context (security ↔ account ↔ auth) 调用追不到一条 request 的全链 log
- memory `reference_pino_pretty_webpack_worker_bundle` 已记 pino-pretty transport 与 webpack bundle 冲突 → 起步只 stdout raw JSON

## Decision

### 1. Server — stdout raw JSON (nestjs-pino, 无 transport)

```ts
LoggerModule.forRoot({
  pinoHttp: {
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.token',
        '*.refreshToken',
        '*.smsCode',
        '*.phone',
      ],
      censor: '[REDACTED]',
    },
    customProps: (req) => ({ trace_id: req.headers['x-trace-id'] ?? generateTraceId() }),
    serializers: { req, res, err },
    level: process.env.LOG_LEVEL ?? 'info',
  },
});
```

- 输出 stdout 一行 JSON,容器层 (docker compose / 生产 deploy per [ADR-0026](0026-backend-deployment-topology.md)) 自接收
- `pino-pretty` defer to M3 (per memory) — 用 `pnpm db:log | pino-pretty` 本地手 pipe

### 2. nestjs-cls trace_id（middleware mode，底层 AsyncLocalStorage）

第三方 `nestjs-cls`(**非手写 middleware**),`SecurityModule` 内 `ClsModule.forRoot` 注册为 global:

```ts
// src/security/security.module.ts
ClsModule.forRoot({
  global: true,
  middleware: {
    mount: true,
    generateId: true,
    useEnterWith: true, // Fastify 必需:否则 ALS context 跨 hook 丢失，Guards/Filters 读不到
    idGenerator: (req) => (req.headers?.['x-trace-id'] as string) || randomUUID(),
  },
});

// 任意 service / Guard / Filter 注入 ClsService:
constructor(private readonly cls: ClsService) {}
const trace_id = this.cls.getId() ?? 'no-trace';
```

middleware mode(非 interceptor mode)覆盖完整 request 生命周期 — Guards / Interceptors / Pipes / Controller / Filters 同见一个 CLS context(per memory `reference_nestjs_cls_fastify_middleware_mode`)。

### 3. Cross-context trace 串联 (Outbox)

Outbox event payload `metadata.trace_id` (per [ADR-0033](0033-outbox-cross-context-comm.md)):

- publisher 写 outbox 时取 cls trace_id
- consumer worker 处理时 hydrate 回 cls → consumer 内的 log / 调用 / 嵌套 Outbox 全部继承同 trace_id

### 4. PII redact 白名单字段

| 字段                                   | redact       | 理由     |
| -------------------------------------- | ------------ | -------- |
| `phone` / `mobile`                     | `[REDACTED]` | 个人信息 |
| `smsCode` / `code`                     | `[REDACTED]` | 安全     |
| `password` / `pwd`                     | `[REDACTED]` | 安全     |
| `token` / `refreshToken` / `jwt`       | `[REDACTED]` | 安全     |
| `req.headers.authorization` / `cookie` | `[REDACTED]` | 安全     |

redact paths 已随 nestjs-pino `redact:` 配置 ship;专门的流出 verify test(log 后 grep `+861[0-9]{10}` 应 0 命中)**尚未实装**,留待补。

### 5. Log level 治理

| Level   | 用途                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------ |
| `error` | 5xx + 系统级 (DB conn lost / Redis down) + 未 expected 异常 (ProblemDetailFilter unknown branch) |
| `warn`  | 4xx 业务拒 (auth lock / freeze period / rate limit) + retryable 第三方调用失败                   |
| `info`  | HTTP req/res (默认) + 业务里程碑 (account auto-create / token issued)                            |
| `debug` | 仅本地 + 详细变量 trace,prod 关闭                                                                |
| `trace` | 不用                                                                                             |

`ProblemDetailFilter` (per [ADR-0038](0038-error-handling-ux-contract.md)) 按异常类型分流到 error/warn。

### 6. Mobile — console wrap + remote log defer

- 起步 mobile 端 `core/telemetry/logger.ts` wrap `console`,加 `trace_id` (从 axios interceptor 拿 response header `x-trace-id`,联 ADR-0038 / ADR-0027)
- 远程 log shipping defer to Plan 3 (Sentry / Bugsnag 接入)

## Consequences

- `app.module.ts` LoggerModule.forRoot + redact paths(已 ship)
- redact verify test (grep PII regex) — **尚未实装**(留待补)
- mobile core/api/client.ts axios interceptor 加 x-trace-id req header → 联 server CLS

## Trade-offs

- AsyncLocalStorage 伪 trace 单进程边界 — Worker 跨进程要传 trace_id (已通过 Outbox metadata)
- JSON log 人读不便 — 本地 `pino-pretty` pipe / 生产用 log 查询工具(per ADR-0026 Phase 1 决)

## References

- memory `reference_pino_pretty_webpack_worker_bundle`
- memory obs (3958-3961 ProblemDetail filter inspection)
- [ADR-0033](0033-outbox-cross-context-comm.md)
- [ADR-0038](0038-error-handling-ux-contract.md)
