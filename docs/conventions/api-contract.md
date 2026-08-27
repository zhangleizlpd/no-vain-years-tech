# API Contract（HTTP wire format）

> 服务端 `apps/server/` HTTP API wire format 单一来源。错误响应 contract 见 [ADR-0038](../adr/0038-error-handling-ux-contract.md)（端到端 ProblemDetail + 业务扩展 + trace_id 串联，**本文件不重复**）；本文件聚焦 URL / method / 字段 / 鉴权 + OpenAPI 同步链 cross-link。

按需 read 触发：新增 / 改动 server endpoint（controller / DTO / OpenAPI 装饰器）/ `packages/api-client` 重新 gen。

## URL 体例

- 全局前缀 `/api`（`apps/server/src/main.ts` `setGlobalPrefix('api')`）
- Controller 根段 = `v{n}/<module>`（module 名 = [business-naming.md](business-naming.md) 的业务模块，**单数**：`v1/chat` / `v1/alert` / `v1/ideation` / `v1/optionsdesk`；`v1/accounts` 是 auth / account 早期遗留）→ 实际 URL `/api/v{n}/<module>/...`
- `n` = major version；向后兼容必新 `v2` 不动 `v1`；deprecate 走 OpenAPI `deprecated: true`
- 资源集合放子段或方法级路径，**复数 kebab-case**：`v1/portfolio/broker-accounts` / `v1/portfolio/watchlist-items`
- 嵌套 sub-resource：`conversations/:id/messages`（`v1/chat`）/ `anchors/:id/at`（`v1/optionsdesk`）

## HTTP 方法语义

| 方法   | 语义                                                 | 幂等   |
| ------ | ---------------------------------------------------- | ------ |
| GET    | 查询，无副作用                                       | ✓      |
| POST   | 创建 / 不可幂等的操作触发（e.g. `request-sms-code`） | ✗      |
| PUT    | 整体替换 resource（全 field 必填）                   | ✓      |
| PATCH  | 部分更新 resource（半 field 体）                     | ✓ 语义 |
| DELETE | 删除                                                 | ✓      |

**`PUT vs PATCH` 易混**：默认走 PATCH（部分 update）；PUT 仅用于 idempotent 全量替换（资源 state 完整覆盖）。

## 字段体例

- **时间**：ISO 8601 UTC（`2026-05-23T07:00:00Z`）；DB `TIMESTAMP WITH TIME ZONE` UTC 落库
- **枚举**：大写 `SNAKE_CASE` 字符串（`AccountStatus: "ACTIVE" | "FROZEN"`）；wire 值与 TS enum 字面值一致（如 `account/account.rules.ts` `AccountStatus`），DB 以 varchar 落、**不建** Prisma / DB ENUM；mobile 客户端通过 Orval typed codegen 穷举（per [ADR-0027](../adr/0027-frontend-data-test-layer.md)）
- **nullable 标量字段**的 `@ApiProperty` 必显式 `type:`（否则 orval 生成 `{ [k]: unknown } | null`；`scripts/checks/check-api-property-nullable.ts` 机器强制）
- **错误码 `code` 字段**：大写 `SNAKE_CASE`（per [ADR-0038](../adr/0038-error-handling-ux-contract.md) Trade-offs）

## 鉴权

- `Authorization: Bearer <access_token>`（JWT，`apps/server/src/account/jwt-auth.guard.ts` 解析）
- Swagger 装饰：受保护 controller 加 `@ApiBearerAuth()`
- token 由 `security` context issue / verify（per [ADR-0032](../adr/0032-backend-bounded-context.md)）

## 错误响应

→ [ADR-0038 RFC 9457 ProblemDetail + 业务扩展 + trace_id 串联](../adr/0038-error-handling-ux-contract.md)

本文件不重复 ProblemDetail schema / Orval typed code union / 客户端 fallback chain / log level 分流 / `ERROR_DISPLAY_MAP` 等内容。

## OpenAPI 同步链

mono 内 server → api-client → mobile 走 Nx target 依赖链（本节是 canonical；`.claude/rules/api-contract-trigger.md` 改 controller / DTO / api-client 时自动注入其 invariant）：

1. `apps/server` `@nestjs/swagger` 装饰器 → `nx run server:export-openapi` 起临时实例 curl `/docs-json` → 写 `apps/server/openapi.json`
2. `packages/api-client` `nx run api-client:generate` 跑 `orval` 读 ① 产出的 `openapi.json` 生成 typed client（types + React Query hooks + axios，per `orval.config.ts`）
3. `apps/mobile` 依赖 `packages/api-client`，`nx affected` 改 server endpoint 自动传导 api-client regen + mobile rebuild

**PR 边界**（per [Constitution §V](../../.specify/memory/constitution.md)）：server impl + api-client regen + mobile 消费**同一 PR**（跨端 feature 单 PR，零类型 drift）；纯 server / 纯 types-sync → 单 PR，commit `chore(api-client): sync types — <feature-slug>` 或并入 server PR 备注。

🚨 **① → ② 之间没有 Nx 边，改 endpoint / DTO 后必须跑两步，没有「一行覆盖」**（2026-08-03 实证）：

```bash
nx run server:export-openapi   # ① 起临时实例 curl /docs-json → 重写 apps/server/openapi.json
nx affected -t generate        # ② orval 读该 json → regen packages/api-client/src/generated
```

**漏掉 ① 的后果是静默的**：`api-client:generate` **没有任何 `dependsOn`**（`nx show project api-client --json` 可查）。单跑它只有它自己一个 task，orval 会拿**上一版** `openapi.json` regen —— 产物与已入库的 generated 文件逐字节相同 ⇒ `git status` 干净、lint / typecheck / test / build 全绿、CI 无一处会红。**陈旧 client 就这样合进 main。**

**为什么不能把 ① 接成 `generate` 的 `dependsOn`**（2026-08-03 真接上去跑过一次、量完爆炸半径才否决的）：`api-client:build` 是 `dependsOn: ["generate"]` 的 noop，而 api-client 又 `implicitDependencies: ["server"]` ⇒ 改**任何**一个 server 文件都会把 api-client + mobile 拖进 affected 集（`nx show projects --affected --files=apps/server/src/app/app.controller.ts` → `["server","api-client","mobile"]`）。接线后同一条 `mobile-checks` job 命令的任务图会多出 `server:build` + `server:export-openapi` —— 而该 job **蓄意不带** Postgres / Redis service 容器，也没有 boot secrets（`PrismaService.onModuleInit` 里是 `$connect()`，boot 必须要活的 DB）。失败形态更糟：`export-openapi` 的 boot 失败会**无限空转**而非报错（见 [local-verification.md § `export-openapi` 的静默失败](local-verification.md)），CI 会挂到 job 超时。要接线就得给 `mobile-checks` + `nightly-sweep` 补 service 容器与 secrets —— 代价远超省下的那一行。

⚠️ 反过来，② **本身不用手动记**：`nx affected -t build`（PR 全量门就含 `build`）会经 `api-client:build → generate` 自动带上。**真正只能靠人记住的是 ①。**

## 翻页

**offset+limit 体例**（per `list-devices` 005 先例，已落地）：query `page`（0-based）+ `size`（clamp `[1, 100]`）；响应 envelope `{ page, size, totalElements, totalPages, items }`。实证 `apps/server/src/security/refresh-token.service.ts`（`MAX_DEVICE_PAGE_SIZE = 100`）+ `apps/server/src/auth/list-devices.usecase.ts`。

新增 list 端点默认沿用此 offset+limit 体例。仅当无界增长资源确需游标分页时，才另起 spec 决策 cursor-based + 起 ADR（**勿与既有 offset+limit 混用**）。

## 与其他约定的分工

| 关心点                                  | 单源                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------- |
| HTTP wire format（URL / method / 字段） | 本文件                                                                      |
| 错误响应 schema + UX 串联               | [ADR-0038](../adr/0038-error-handling-ux-contract.md)                       |
| 业务 Operation 跨 context 传播规则      | [server-bounded-context-catalog.md](server-bounded-context-catalog.md)      |
| 模块命名（业务概念字符串）              | [business-naming.md](business-naming.md)                                    |
| OpenAPI codegen + Orval typed           | 本文 § OpenAPI 同步链 + [ADR-0027](../adr/0027-frontend-data-test-layer.md) |
