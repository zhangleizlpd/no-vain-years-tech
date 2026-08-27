---
paths:
  - 'apps/server/src/**/*.controller.ts'
  - 'apps/server/src/**/*.dto.ts'
  - 'apps/server/src/**/*.request.ts'
  - 'apps/server/src/**/*.response.ts'
  - 'apps/server/openapi.json'
  - 'packages/api-client/src/**'
---

# API contract path-trigger（改 server endpoint / DTO / api-client 时自动加载）

## 硬性 invariant

1. **mobile 禁手写 `fetch` / `axios` 直调业务 API** — 走 `@nvy/api-client`（per [docs/conventions/fe-directory-structure.md § API client 单源](../../docs/conventions/fe-directory-structure.md#api-client-单源)）
2. **server endpoint / DTO 改后必跑两步** —— 🚨 **没有「一行覆盖」**：`api-client:generate` 无 `dependsOn`，单跑它是拿 **stale** `openapi.json` regen，而且 `git status` 干净、CI 全绿、**无一处会红**

   ```bash
   nx run server:export-openapi   # ① 重写 apps/server/openapi.json ← 只有这步靠人记住
   nx affected -t generate        # ② orval regen（PR 门的 -t build 会自动带上）
   ```

   成因 + 「为什么不把 ① 接成 `dependsOn`」的实测否决理由，见 [docs/conventions/api-contract.md § OpenAPI 同步链](../../docs/conventions/api-contract.md#openapi-同步链)

## 单源真理

详细 wire format（URL / method / 字段体例 / 鉴权）见 [`docs/conventions/api-contract.md`](../../docs/conventions/api-contract.md)；错误响应 contract（RFC 9457 ProblemDetail + 6 业务扩展 + trace_id 串联）见 [ADR-0038](../../docs/adr/0038-error-handling-ux-contract.md)。本 rule 仅 surface 路径触发的硬 invariant，不重复 wire format / error schema 细节。

## Nx target 依赖链（server → api-client → mobile）

mono 内 server → api-client → mobile 走 **Nx target 依赖链**（不装 `api-types-sync` preset，per W2.0 决策）：

1. `apps/server` `@nestjs/swagger` 装饰器 → `nx run server:export-openapi` 启临时实例 curl `/docs-json` → 写 `apps/server/openapi.json`
2. `packages/api-client` `nx run api-client:generate` 跑 `orval` 读 **① 产出的** `apps/server/openapi.json` 生成 typed client（types + React Query hooks + axios，per `orval.config.ts`）。⚠️ **1 → 2 之间没有 Nx 边** —— `generate` 无 `dependsOn`，① 必须人工先跑（2026-08-03 实证）
3. `apps/mobile` 依赖 `packages/api-client`，`nx affected` 改 server endpoint 自动传导触发 api-client regen + mobile rebuild

**PR 边界**（per [Constitution §V](../../.specify/memory/constitution.md)）：server impl + api-client regen + mobile 消费**同一 PR**（跨端 feature 单 PR —— regen 在 PR 内、mobile 同 PR import，零类型 drift）。纯 server / 纯 types-sync（无 mobile 消费改动）→ 单 PR。commit message `chore(api-client): sync types — <feature-slug>` 或并入 server PR 备注 types 已 regen。
