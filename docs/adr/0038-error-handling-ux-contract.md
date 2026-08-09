---
adr_id: ADR-0038
status: Accepted
applies_to: [apps/server, apps/mobile, packages/api-client]
sunset_trigger: |
  - 切 gRPC / GraphQL 错误模型 (RFC 9457 不适用)
  - 引入富 error context (e.g. Sentry Performance + Issues 自动 group)
  - 业务 < 5 error code (overhead > benefit)
---

# ADR-0038: Full-Stack Error Handling and UX Contract — RFC 9457 ProblemDetail + 业务扩展 + trace 串联

- Status: Accepted (2026-05-21) — server contract + ProblemDetail filter shipped via PR-5a; client consumer (Orval typed error codes + form.setError + Error Boundary trace_id) shipped via PR-5b/c
- Deciders: project owner
- Tags: backend / mobile / error / ux / cross-cutting

> **PR-5a 实装注**: ProblemDetailResponse 加 5 业务扩展字段 (code/traceId/freezeUntil/retryAfterSeconds/invalidAttributes)。FormValidationException 新建 (status 400, code FORM_VALIDATION, invalidAttributes 直通)。ProblemDetailFilter 重写为通用 HttpException dispatch (无 domain instanceof 反向 import) + 从 ClsService 注 traceId + log level 分流 (4xx warn / 5xx error+stack)。AccountInFreezePeriodException 重构 extends HttpException (原 extends Error) 让 filter 通用 dispatch 工作。ProblemDetailFilter 物理位置 auth/infrastructure → security/ (cross-context 概念归 platform infra 层)。

## Context

A-002 ship 后错误流状态:

- server `ProblemDetailFilter` 已存在 (per memory obs 3958, 3961),输出 RFC 9457 顶层 5 字段
- 客户端 `core/api/client.ts` 无 ProblemDetail 消费 — fallback 全 throw 通用 Error
- 业务扩展字段散乱:`/auth/freeze` 用 `freezeUntil`,`/auth/sms` 用 `retryAfterSeconds`,无 union 类型
- trace_id 不串到前端 — 用户看到错误无法关联后端 log

## Decision

### 1. RFC 9457 ProblemDetail 顶层 5 + 业务扩展 6

```ts
type ProblemDetailResponse = {
  // RFC 9457 mandatory
  type: string; // URI ref e.g. "https://nvy.app/errors/auth-locked"
  title: string; // human-readable summary
  status: number; // HTTP status mirror
  detail?: string; // human-readable explanation
  instance?: string; // URI ref to this error instance (request id)

  // 业务扩展 (this ADR)
  code: string; // machine code e.g. "AUTH_ATTEMPT_LOCKED"
  traceId: string; // 联 [ADR-0036](0036-observability-logging-governance.md) CLS trace_id
  freezeUntil?: string; // ISO 8601 — for ACCOUNT_IN_FREEZE_PERIOD
  retryAfterSeconds?: number; // for RATE_LIMIT_EXCEEDED
  invalidAttributes?: Array<{ field: string; messages: string[] }>; // for FORM_VALIDATION
  // 可继续扩 (e.g. requiredCaptcha for FORM_NEEDS_CAPTCHA)
};
```

### 2. OpenAPI `allOf` per-endpoint code union

每个 endpoint 在 swagger schema 明确响应 4xx/5xx 时 `code` 取值域 union,Orval codegen (per [ADR-0027](0027-frontend-data-test-layer.md)) 产 typed:

```ts
// generated/api-client/auth.ts
export type PhoneSmsAuthErrorCode =
  | 'FORM_VALIDATION'
  | 'AUTH_ATTEMPT_LOCKED'
  | 'ACCOUNT_IN_FREEZE_PERIOD'
  | 'RATE_LIMIT_EXCEEDED'
  | 'SMS_CODE_INVALID';
```

客户端 switch `error.code` 时穷举枚举 + ESLint exhaustive-check 拒漏分支。

### 3. 客户端 fallback chain

`apps/mobile/src/core/api/errors.ts`(problem-detail 提取与守卫):

```ts
function extractProblemDetail(err: unknown): ProblemDetailResponse | null {
  if (axios.isAxiosError(err) && isProblemDetail(err.response?.data)) return err.response.data;
  if (isProblemDetail(err)) return err;
  return null;
}

// fallback chain:
// 1) ProblemDetail.detail || ProblemDetail.title
// 2) generic axios error.message
// 3) "未知错误,请稍后再试"
```

### 4. trace_id 串联到 UI

- server `ProblemDetailFilter` amend:`traceId: clsGet().trace_id` 注入 response (per [ADR-0036](0036-observability-logging-governance.md))
- mobile `app/_layout.tsx` Error Boundary:catch 后展示 `trace_id` 灰字底部 (用户截图反馈时附带)

### 5. FormValidationException 新建

server domain 抛 `FormValidationException(invalidAttributes)` → `ProblemDetailFilter` pass-through 到 response `invalidAttributes` 字段。

客户端 `useMutation` onError:

```ts
if (problem.code === 'FORM_VALIDATION') {
  problem.invalidAttributes?.forEach(({ field, messages }) =>
    form.setError(field as any, { message: messages.join('; ') }),
  );
}
```

### 6. ERROR_DISPLAY_MAP — 中文 inline map

`apps/mobile/src/core/api/errors.ts`(同文件 `ERROR_DISPLAY_MAP`):

```ts
export const ERROR_DISPLAY_MAP: Record<string, string> = {
  ACCOUNT_IN_FREEZE_PERIOD: '账号处于注销冻结期内,暂不可登录',
  AUTH_ATTEMPT_LOCKED: '验证失败次数过多,账号已暂时锁定,请稍后再试',
  RATE_LIMIT_EXCEEDED: '操作过于频繁,请稍后再试',
  SMS_CODE_INVALID: '验证码错误或已过期',
  FORM_VALIDATION: '表单信息有误',
  // ...
};
```

不走 i18next 装(Plan 4 多语言时再装)— 起步中文 inline。

### 7. log level 按异常类型分流 (server-side amend)

`ProblemDetailFilter`:

- `BadRequestException` / `UnauthorizedException` / `ForbiddenException` / `NotFoundException` / `ConflictException` / `TooManyRequestsException`(业务 4xx) → `logger.warn`
- `InternalServerErrorException` / 未 caught 异常 → `logger.error` + 全 stack trace
- `HttpException` 边界 4xx → `logger.warn`

(联 [ADR-0036](0036-observability-logging-governance.md) log level 治理)

## Consequences

- PR-5 ship:client interceptor + problem-detail 守卫(errors.ts) + form.setError + Error Boundary trace_id 显示
- PR-5 server amend:ProblemDetailResponse 加 6 业务扩展字段 + Filter 注入 traceId + FormValidationException 新建
- 联 ADR-0027 Orval codegen 自动产 typed error code

## Trade-offs

- 6 业务扩展字段非 RFC 9457 标准 — 但通过 RFC 9457 § 3.2 "extension members" 显式 allow,合规
- `code` 全大写 SNAKE_CASE 字符串(非 enum 数字)— 调试 + grep log 友好

## References

- memory obs (3958-3961 ProblemDetail filter inspection)
- RFC 9457 (Problem Details for HTTP APIs)
- [ADR-0027](0027-frontend-data-test-layer.md)
- [ADR-0036](0036-observability-logging-governance.md)
- [AI Friction Catalog · F-005 Untyped-Error-Code-Hallucination](../conventions/ai-friction-catalog.md#f-005--untyped-error-code-hallucination) — OpenAPI `allOf` per-endpoint code union + Orval typed enum 缓解 LLM 编造 code
