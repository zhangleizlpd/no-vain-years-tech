---
adr_id: ADR-0041
status: Accepted
applies_to: [apps/server]
sunset_trigger: |
  - security/ 内非 JWT 平台 infra class 成员数 > 7 (signal: security 偏离 "platform base layer" 纯粹性,变 grab-bag → 应抽 src/common/ 或拆 security/ 子目录)
  - 跨 bounded context 复用且无清晰单一归属的 business-domain class 出现 (signal: 既不该塞 security/,也不属任何业务 context → 需要 src/common-business/ 或共享 packages)
  - 第 4 个 bounded context 引入 (current: security / account / auth) 时强制 re-review (signal: scale threshold,3 个 context 时不引入 common 还能撑,4+ 个时跨 context 复用面积自然变大)
  - 3 个月内出现 ≥ 3 次 TypeScript circular dependency error 且根因在 cross-bounded-context shared type 缺失 (signal: 拒绝 common 已造成实际工程摩擦)
---

# ADR-0041: Server `src/common/` Directory Policy — 不引入,平台 infra 进 security/

- Status: Accepted (2026-05-22)
- Deciders: project owner
- Tags: backend / architecture / directory-policy
- Supersedes: —

## Context

PR-4 (#72, Server bounded context split) 实装时 [ADR-0032](0032-backend-bounded-context.md) 设计的 `src/security/` 范围被现实需求**扩展**:不仅 JWT,还容纳了 `PrismaService` / `REDIS_CLIENT` / `ProblemDetailFilter` / `ProblemDetailResponse` DTO / `FormValidationException` 等**平台层基础设施**(per [ADR-0032 实装注](0032-backend-bounded-context.md#L17))。

设计依据 — `account` ctx（PR-4 时为 `AccountPrismaRepository`;[ADR-0043](0043-server-flat-module-paradigm.md) R-2+3 后该 repository 删除,改 use case 直注）需注入 `PrismaService`,但**不能反向 import auth/**(违反单向 `auth → account → security` 边界);若放 `src/common/` 又需新建一个完全独立的目录 + module + ESLint element + tsconfig path,增加心智负担。**取消 src/common/**,security/ 充当 platform base 是最少额外结构的解。

但这个选择当时是 **PR-4 scope 边界 round 的 implicit 决策**(user 在多轮 scope 收口时明示 "PR-4 不引入 src/common"),**未文档化为 baseline**。隐患:

1. **后续 LLM agent 加 logger / cache abstraction / generic event bus 类 cross-cutting 工具时**会反复问 "放 security/ 还是新建 src/common/?"—— 同一决策被 re-litigate
2. **新人(包括未来的 Claude session)看 security/ 内有 Prisma + Redis 会疑惑**,因为字面"security"暗示访问控制 / 加密,实际是 platform base
3. **Sunset 条件无形** — 什么时候 security/ 已经"太杂"该拆?没有触发阈值,decision drift 不可见

本 ADR 把 PR-4 期间的 implicit decision 显式化,并写死 sunset trigger 让未来的"该不该拆"判断有 baseline。

## Decision

### 1. **不引入** `apps/server/src/common/` 目录

理由:`src/security/` 已承担 platform base layer 角色;再加 `src/common/` 制造**两个相似职责的"杂物间"**,LLM 选址纠结放大。

### 2. 分类规则 — 新增 cross-cutting 类落点

| 类的性质                                                                                                                                                         | 落点                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Platform infra**(无业务知识) — DB client / Redis client / 通用 error filter / generic exception class / request validation 工具 / logger setup / tracing infra | `src/security/`                                                            |
| **Business-domain shared type**(被 ≥ 2 个 bounded context 复用的领域对象)                                                                                        | 不属于任何现有 context → 触发新 bounded context 评估;不要塞 security/      |
| **Single-context 内部使用**                                                                                                                                      | 当前 context 的对应 layer (`domain/` / `application/` / `infrastructure/`) |
| **DTO** — `Problem Detail` / 跨 endpoint 复用的 response shape                                                                                                   | `src/security/dto/`(沿 PR-4 当前布局)                                      |

### 3. `security/` 别名理解

- 内部认知: **security/ = platform base layer**(平台基础设施),不只是"安全"
- 外部不改名(避免大规模 rename + import 重写),通过 `security.module.ts` 顶部 doc-comment 已说明(per PR-4 落地代码 L25-L48)
- 新加 platform infra 时 PR 描述必须 cite ADR-0041,reviewer 可一眼判断"该不该进 security/"

### 4. Sunset trigger 阈值 — 触发 ≥ 1 项 即重审本 ADR

(详见 frontmatter `sunset_trigger`,4 项)

- security/ 非 JWT 类成员 > 7 (current: 5,headroom 2)
- 跨 context 共享 business-domain class 出现且无归属
- 4-th bounded context 引入
- 3 个月内 ≥ 3 次 cross-context TS circular dep

## Consequences

### 当前状态(无新增改动,仅 baseline 文档化)

`apps/server/src/security/` 现有非 JWT 平台 infra members (5 个):

| 成员                             | 性质                                         |
| -------------------------------- | -------------------------------------------- |
| `prisma.service.ts`              | platform infra (DB)                          |
| `redis.token.ts`                 | platform infra (Redis client DI token)       |
| `problem-detail.filter.ts`       | platform infra (RFC 9457 全局异常 filter)    |
| `dto/problem-detail.response.ts` | platform infra (跨 endpoint DTO)             |
| `form-validation.exception.ts`   | platform infra (validation 错通用 exception) |

JWT 相关 (`jwt-token.service.ts` + `security.module.ts` 本体) 不计入 sunset 阈值。

### 联动 ADR amend

- [ADR-0032](0032-backend-bounded-context.md) References 段补 ADR-0041 cross-link(后续 PR 一并改;本 ADR ship 时**不**改 ADR-0032 以保 PR 边界 clean)
- 后续 [ADR-0036](0036-observability-logging-governance.md) 落地 LoggerModule / [ADR-0037](0037-security-credentials-governance.md) 落地 token-revocation / refresh-token rotation 时,新增类落 `security/` 即可,不需要再评估 src/common/ 与否

### 下游 PR / 工作流影响

- PR-6 (data + security + perf infra,在 [05-21 review plan](../private/plans/2026-05/05-21-review-tech-stack-post-a002.md)) 起手即可按本 ADR 路径加 platform infra
- Plan 2 每个 feature 起手 `/speckit-specify` 后,governance checklist 中 "新 SecurityModule export → ADR-0041 sunset trigger 阈值 review" 步骤可直接 grep `apps/server/src/security/*.ts | wc -l` 对照阈值

## Trade-offs

| 短板                                                                 | 接受理由                                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `security/` 字面意义(safety/auth)与实际容纳的内容(platform base)不符 | rename 成本(大量 import 重写 + ESLint elements + tsconfig)> "字面准确" 收益;内部 doc-comment + 本 ADR 已说明 |
| 新人需先读 ADR-0041 / security.module.ts doc 才能理解 security/ 范围 | 改用 src/common/ 路径会引入两个"杂物间"互相竞争,LLM 选址成本更高                                             |
| sunset trigger 中"非 JWT 成员数 > 7"是经验拍脑袋阈值                 | 5 → 7 是 +40% 增长空间,触发时回头看具体内容判断是否拆;阈值不必精确,显式 trigger 比无 trigger 强              |
| 4-th bounded context 引入时强制 re-review 可能阻塞 Plan 2 某 feature | re-review 不等于"必须拆" — 触发条件不等于自动结论,需 ADR-0041 amend 或 supersede                             |

## Open Questions

- **是否给 `security/` 改名为 `platform/` 或 `infra/`**?defer。当前 5 个成员未到混乱阈值;rename 成本高,且 ADR-0032 + 本 ADR 已把"security 是 platform base"写死,LLM 命中率上不会因字面纠结
- **Business-domain shared type 出现时是 "新 bounded context" 还是 "packages/" workspace 包**?当前 mono 已有 `packages/api-client` / `packages/types`(Plan 2 阶段充实),后者天然适合跨 server / mobile 的纯类型共享。Plan 2 第一个该类需求 surface 时再细化(per [05-22 bounded context governance plan](../private/plans/2026-05/05-22-server-bounded-context-governance.md) O2 Operation Catalog 工作单元)

## 复审记录

### 2026-06-21 — vendor I/O 子类碶出至 `integrations/` 层（[ADR-0058](0058-server-integrations-layer.md)），核心决策不变

[ADR-0057](0057-ideation-bounded-context.md) §2 出现首个「被 ≥2 bounded context 复用的外部 vendor 适配器」（LLM provider，chat + ideation）。本 ADR 分类表把 platform infra 一律落 `security/`，但 vendor I/O 适配器落 `security/` 语义错配（security = 平台基座/auth）。

[ADR-0058](0058-server-integrations-layer.md) 新建**目的受限**的 `apps/server/src/integrations/` 层专收此类（准入：≥2 消费 ctx 的 3rd-party vendor I/O 适配器，port+adapter）。**本 ADR 核心「不引入泛化 `src/common/` 杂物间」仍立**——`integrations/` 有硬准入规则、非泛化 common；DB/cache/filter/JWT 等真平台基座仍归 `security/`，分类表 row 1 仅 vendor I/O 子类改走 integrations。状态保持 Accepted。

## References

- [ADR-0031](0031-adr-governance.md) — ADR frontmatter 4 必填字段规则
- [ADR-0032](0032-backend-bounded-context.md) — Server bounded context split 决策本体(PR-4 实装注已含 security 范围扩展)
- [05-22 bounded context governance plan](../private/plans/2026-05/05-22-server-bounded-context-governance.md) — O4 carry-over 工作单元(本 ADR 即该工作单元的产出)
- PR #72 — Server bounded context split 实装
- PR #79 — PR-5 tail cascade fix(cross-module wiring 实证)
