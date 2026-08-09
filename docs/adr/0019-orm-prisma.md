---
adr_id: ADR-0019
status: Accepted
applies_to: [apps/server, packages/types]
sunset_trigger: |
  - Prisma v8+ break change 难以接受
  - 复杂 query 占 backend > 30% (Prisma 表达力不够)
  - Drizzle / Kysely 等在 LLM 命中率显著超越
---

# ADR-0019: ORM — Prisma v7+

- Status: Accepted (2026-05-18)
- Deciders: project owner
- Tags: backend / persistence / cross-cutting

## Context

[ADR-0018](0018-backend-language-pivot.md) 锁定 TS / NestJS 后端 stack root,需选 ORM。约束:

- **PG schema 零变更**(Plan 1 § G "C11" + § G.1 ADR cross-ref):必须能从现 Java Flyway V1-V14 已迁的 PG schema 反向生成,不允许重新设计 schema 或写 Drizzle/TypeORM 的"靠人脑读 SQL 写 entity"路径
- **类型安全**:Java Spring Data JPA + MapStruct 双向映射 boilerplate 是新栈想去掉的痛点之一(详 [ADR-0018 § Context](0018-backend-language-pivot.md#context)),新栈 ORM 必须做到"schema 改 → 类型派生 → IDE 立刻报错"
- **migration 工具**:能从 PoC 阶段直接接管 Flyway 之后的迁移,**Plan 1 PoC 不动旧 Flyway V1-V14**,后续 schema 演进走新工具
- **NestJS 集成**:DI 容器 + 模块化集成有官方/事实标准库,不需自写 DataSource boilerplate

## Decision

采用 **Prisma**(Plan 1 § C.1):

- **ORM**: `prisma ^7.8.0` + `@prisma/client ^7.8.0`(Plan 1 § C.1 写 v6+,PoC 实装 v7.8 — Prisma 7 系列稳定且 `db pull` 行为与 v6 兼容)
- **PG driver adapter**: `@prisma/adapter-pg ^7.8.0`(Prisma 7 driver adapter API,替代旧 `prisma-pg` 模式)
- **NestJS 集成**: `PrismaService extends PrismaClient` 模式 + `OnModuleInit` 钩子 + DI 注入(不强依赖 `nestjs-prisma` 第三方包,避免 v7 driver adapter API 与 wrapper 包升级时差)
- **Migration 工具**: `prisma migrate dev` / `prisma migrate deploy` 接管 PoC 之后所有 schema 演进;Plan 1 PoC 阶段 **不写新 migration**,只用 `db pull` 同步 baseline(Plan 2 起已正常落 `apps/server/prisma/migrations/`)
- **Schema source of truth**: `apps/server/prisma/schema.prisma`(`db pull` 反推后 commit + 手工维护)
- **数据访问边界**: per [ADR-0043](0043-server-flat-module-paradigm.md) 扁平范式 — UseCase 直注 `PrismaService` 读写本 context 表,**不引入** repository port 抽象;数据用 Prisma 原始 POJO(贫血),不变量校验走纯函数 `*.rules.ts`,**不做** Prisma row → domain class 映射(避免 Entity Mapper 复活 Hexagonal);仍不用 Java MapStruct 双向映射

## Consequences

### Positive

- **`db pull` 反推 V1-V14 Flyway PG schema 1:1 等价**(V3 验收 PASS,无 schema drift)— Plan 1 § H R1 风险未触发,不需 fallback Drizzle Kit
- **类型派生编译期校验** — `prisma.account.findUnique({ where: { phone } })` 返回值 / 字段名 / 关联 include 全 IDE-strong-typed;改 schema → `prisma generate` → 调用点立刻 typecheck 红
- **Prisma Studio + migrate UX** — `prisma studio` 即时 DB GUI;`prisma migrate dev` 自动检测 schema drift 并生成 migration SQL;solo dev 体感优秀
- **MapStruct boilerplate 消除** — 此前 Java 服务每个聚合 1 组 MapStruct mapper class(`@Mapper`/`@Mapping`);TS 侧 Prisma 原始 row 直接消费,无对象映射层,LoC 贡献 ~30%
- **Vitest 单测启动 ms 级**(对比 Spring Boot Test 5-10s) — Prisma Client 不需要 Spring Context,Testcontainers PG 启动 + Prisma migrate 是 IT 主要耗时(~3-5s),单元测试 mock PrismaService 即可

### Negative / Trade-offs

- **Raw SQL 弱** — Prisma 复杂 query(window function / CTE / 多表 join with select 投影)需 `$queryRaw` 落地,失去类型安全;约定走 prepared statement template + 手工类型断言。M2 业务复杂 query 出现时再评估混用 Kysely(query builder)
- **Build performance** — `prisma generate` 在 monorepo 内每次 `pnpm install` / schema 改后跑一遍,~3-5s;CI 内集中跑可接受
- **Prisma 7 driver adapter API 较新** — `@prisma/adapter-pg` 是 Prisma 7 引入的 adapter pattern,replacing `prisma-pg`;社区第三方 NestJS wrapper(`nestjs-prisma`)对 v7 driver adapter 支持滞后,所以决策 § Decision 不用 wrapper
- **Migration governance 边界** — PoC 不动 Flyway V1-V14;Plan 2/3 阶段第一次写新 `prisma/migrations/` 时需明确 baseline 截断点 + Flyway → Prisma migration 历史治理(Plan 3 G.2 红黄绿分类下 Flyway 标 ⚪️ 废弃)

## Alternatives Considered

- **Drizzle ORM + Drizzle Kit `introspect`** — 拒绝:`introspect` 对 PG enum / partial index / generated column / array 类型反推质量低于 Prisma `db pull`(Plan 1 § H R1 fallback 候选);Drizzle 类型派生采用 schema 直定义模式(类似 TypeORM Active Record),从现有 PG schema 反向起步路径不顺
- **TypeORM** — 拒绝:Active Record / Data Mapper 双模式增加心智负担;`@Entity` annotation 污染 domain model(与 [ADR-0020](0020-module-boundary-nestjs.md) `domain/` 零外部依赖原则冲突);类型派生比 Prisma 弱
- **MikroORM** — 拒绝:DI 与 NestJS 集成有官方包(`@mikro-orm/nestjs`),但 schema 反推体验 + 社区规模 < Prisma;v7 引入 schema diff CLI 已对齐 Prisma 但生态体量差距明显
- **Kysely(query builder,不是 ORM)** — 拒绝作主 ORM:Kysely 是显式 SQL 类型化 query builder,不提供 schema 单一来源 / migrate / Studio;**保留作 future 复杂 query 混用候选**(详 § Consequences "Raw SQL 弱")
- **JOOQ 风 TS 等价(`zapatos` / `pg-typed`)** — 拒绝:成熟度 + 维护活跃度低;不解决 schema 单一来源问题

## References

- [Plan 1 § C.1 框架栈 + § C.2 SDK 替换矩阵](../private/plans/2026-05/05-18-plan1-backend-stack-poc.md)
- [V3 验收(`db pull` 反推 V1-V14)— V10 retro § 3.1](../experience/2026-05/05-18-v10-claude-agent-loop.md#31-一击中目标0-round-trip)
- [Prisma 7 driver adapters](https://www.prisma.io/docs/orm/overview/databases/database-drivers)
- [ADR-0018: 后端 stack root pivot](0018-backend-language-pivot.md)
- [ADR-0043: Server 扁平范式](0043-server-flat-module-paradigm.md) — amend 本 ADR 的 repository 边界为 PrismaService 直连
