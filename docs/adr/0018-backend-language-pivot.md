---
adr_id: ADR-0018
status: Accepted
applies_to: [apps/server]
sunset_trigger: |
  - Anthropic Agent SDK Java/Kotlin 出一等公民
  - NestJS 生态新框架显著超越 & LLM 命中率 90%+ 等价
  - Bun M3 业务稳态 PoC 通过
---

# ADR-0018: Backend Language Pivot — TypeScript on NestJS + Fastify + Prisma + Nx

- Status: Accepted (2026-05-18)
- Deciders: project owner
- Tags: backend / architecture / cross-cutting / pivot

## Context

「不虚此生」M1 阶段后端原 stack = Java 21 + Spring Boot 3 + Spring Modulith + Spring Data JPA + Flyway + MapStruct + Bucket4j + Resilience4j + Maven 多模块,已实现部分 account / pkm use case。

驱动 pivot 的 3 个力:

1. **Claude AI coding loop 体感新维度** — solo dev 节奏下 AI 协作命中率 / 速度成为后端选型可量化维度,权重应大于"既有 Java 经验沉淀"
2. **Java/Spring solo dev 摩擦** — Spring Boot Test 启动 5-10s 反馈慢、MapStruct + JpaEntity ↔ Domain Model 双向映射 boilerplate 重、Maven 多模块部署单 jar 但开发期心智负担与拆服务收益不匹配
3. **零用户阶段** — 兼容 token / 双写 / 灰度均不需,推倒重来代价低(Plan 1 § G "C5 零用户"约束)

Plan 1 § B 8 候选 × 10 维度加权评分,**TS / NestJS+Fastify+Prisma+Nx** 排名 #1;Python/FastAPI 第 #3 但备选(§ D 触发条件);raw Fastify 第 #2 但 NestJS+Fastify 性能损失可接受换 DDD 范式契合度。

Plan 1 4-5 周 PoC(`phone-sms-auth` use case full port,V1-V10 验收门)实际 ~2 天 wall time 全过,V10 主观体感 ≥ Java baseline(详 [`../experience/2026-05/05-18-v10-claude-agent-loop.md`](../experience/2026-05/05-18-v10-claude-agent-loop.md))。

## Decision

后端 stack root 决策 — 整体 pivot 到 TypeScript 生态,锁定下表(Plan 1 § C.1 + 实际 PoC ship 版本):

| 角色           | 选型                                                                                 | 实际版本(2026-05-18)                                                    |
| -------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Runtime        | **Node 22 LTS**                                                                      | `^22.0.0`(LTS 到 2027-04)                                               |
| HTTP 框架      | **NestJS + Fastify adapter**                                                         | `@nestjs/core ^11.0.0` + `@nestjs/platform-fastify ^11.0.0`             |
| ORM            | **Prisma**(详 [ADR-0019](0019-orm-prisma.md))                                        | `prisma ^7.8.0` + `@prisma/client ^7.8.0`                               |
| 模块边界       | **NestJS Module + ESLint boundaries**(详 [ADR-0020](0020-module-boundary-nestjs.md)) | `eslint-plugin-boundaries ^6.0.2`(v6 object-selector syntax)            |
| Validation     | **class-validator + class-transformer**                                              | `class-validator ^0.15.1` + `class-transformer ^0.5.1`                  |
| Auth           | **Passport.js + @nestjs/passport** + JWT via `@nestjs/jwt`                           | `@nestjs/jwt ^11.0.2`                                                   |
| Hash           | **bcrypt**(PoC 阶段;Argon2id 迁移延后到 Plan 2/3)                                    | `bcrypt ^6.0.0`                                                         |
| Rate limit     | **@nestjs/throttler + Redis storage**                                                | `@nestjs/throttler ^6.5.0` + `@nest-lab/throttler-storage-redis ^1.2.0` |
| Resilience     | **cockatiel**(retry + circuit breaker)                                               | `^3.2.1`                                                                |
| Logger         | **pino via `nestjs-pino`**                                                           | `nestjs-pino ^4.6.1` + `pino ^10.3.1`                                   |
| OpenAPI        | **@nestjs/swagger** → `orval` codegen                                                | `@nestjs/swagger ^11.4.3`                                               |
| Aliyun SMS     | `@alicloud/dysmsapi20170525`(官方 npm)                                               | `^4.5.1`                                                                |
| Test           | **Vitest + Testcontainers Node + `@nestjs/testing`**                                 | Vitest 4 + Testcontainers Node 11                                       |
| Monorepo       | **Nx** + pnpm workspaces                                                             | `nx 22.7.2`                                                             |
| Package mgr    | **pnpm 10**(2026-05-17 Plan 1 amend,原 pnpm 9)                                       | `pnpm@10.33.2`                                                          |
| TS dev runtime | **@nx/js:swc + .swcrc**(2026-05-17 W2.0 amend,原 NestJS 内置 SWC)                    | `@swc/core ~1.15.5`                                                     |

**仓库布局** — Nx mono-repo `no-vain-years-mono`(C9 user lock,Plan 1 § E.2):

```text
apps/server/                # NestJS + Fastify + Prisma
  src/<module>/             # 业务 module(实际 layout,Plan 1 § C.3 sketch 中 `modules/` 包装层未落地)
    domain/
    application/
    infrastructure/
    web/
    <module>.module.ts
packages/                   # 共享包(api-client / types / ...)
```

子决策:限流见 [ADR-0022](0022-throttler-nestjs-redis.md);模块边界见 [ADR-0020](0020-module-boundary-nestjs.md)。

## Consequences

### Positive

- **Claude+NestJS loop 实测命中率 ~90% / 1-2 round-trip ~25% / 大返工 ~5%**(详 V10 retro § 3.4)— Plan 1 § H R4 风险未触发
- **LoC 紧凑度 1/8.4**(详 [`v1-loc-report.md`](../../specs/001-phone-sms-auth/v1-loc-report.md)) — TS structural type + Prisma generic 派生 + Vitest ms 级启动是主要贡献因素
- **NestJS module 范式 ≈ Spring DI / AOP 概念 0 阵痛** — Plan 1 § H R6 验证为真,solo dev 转栈学习曲线 ≤ 1 个 PR/坑
- **Plan 2/3 接口契约可立**(Plan 1 § F) — monorepo / Docker / CI / OpenAPI / 共享包 6 项硬产物 ship,Plan 2 直接消费
- **零用户阶段** API contract / token / migration / device id 全不要求兼容,推倒重来成本最低 — pivot 时间窗准确

### Negative / Trade-offs

- **模块物理隔离弱**(单 jar / 单 dist vs Java Maven 多模块)— 详 ADR-0020 § Consequences;solo dev 阶段 NestJS Module + ESLint boundaries 双保险够用,多 dev 阶段拆服务前需评估
- **资产迁移成本** — 此前 Java/Spring 服务的既有 use case 需完整重写,涉及事件发件箱 / 模块边界校验 / 对象映射 / OpenAPI 生成 / JWT / 限流 / 弹性 7 个子系统全部换 TS 等价实现
- **复杂外部 SDK 迁移延后**(memory `feedback_complex_external_dep_migration_last`) — Aliyun cloudauth(实名认证)/ ip2region(地理位置)排在 Plan 3 后期,迁移期需 reuse 已成熟 adapter 模式
- **AI 静默踩坑非零**(memory `feedback_audit_must_verify_code_anchors`) — `pnpm -C` 不传 cwd / `nx cache` 假绿 / `eslint-plugin-boundaries` v6 silent no-op / vitest full AppModule boot 撞外部依赖等各踩 1 次;**memory pool 沉淀 + 后续按记忆规避**是必要安全网
- **Bun runtime 推迟到 M3 复评** — reflect-metadata + Fastify on Bun 1.2 兼容性 PoC W5 buffer 未单独验,M3 业务稳态后独立 spike

## Alternatives Considered

- **Stay-with-Java (Spring Boot 3)** — 拒绝:Claude+Java loop 体感 < Claude+TS;Java/Spring solo dev 摩擦(MapStruct boilerplate / Spring Boot Test 启动慢 / Maven 多模块部署/开发期成本不匹配)未改善;V1-V10 反向假设(若 PoC fail 则切回 Java)未触发,选 #1 路径
- **Python 3.13 + FastAPI**(Plan 1 § D 备选,排名 #3)— 拒绝:类型系统弱于 TS(Pydantic 运行时校验 vs class-validator + Prisma 类型派生编译期校验) + Python 3.13 + uv + Nx `@nxlv/python` 生态成熟度低于 TS;触发条件未达成(Prisma db pull 反推成功、Aliyun SDK npm 一等齐)
- **Raw Fastify(不用 NestJS)**(Plan 1 § B 排名 #2)— 拒绝:NestJS+Fastify adapter 性能损失 vs raw Fastify ~10-15%,换 DDD 范式契合度(@Module + @Injectable + 装饰器即 OpenAPI annotation) + Spring 老用户 0 概念阵痛,**性价比新栈更优**;raw Fastify 在多 dev 场景边界靠人自觉,solo dev 阶段同样不香
- **Go + Gin / Rust + Axum** — 早期 § A 评估即排除:类型生态 vs Python + TS 弱;solo dev 转 statically-typed system language 学习曲线超出 Plan 1 timebox

## References

- [Plan 1 — 后端选型(Java vs TS 推倒重来评分)](../private/plans/2026-05/05-18-plan1-backend-stack-poc.md)
- [V10 验收 — Claude Code agent loop 体感](../experience/2026-05/05-18-v10-claude-agent-loop.md)
- [V1 LoC 验收 — TS 实装紧凑度对照](../../specs/001-phone-sms-auth/v1-loc-report.md)
- [ADR-0019: ORM = Prisma](0019-orm-prisma.md)
- [ADR-0020: 模块边界 = NestJS Module + ESLint boundaries](0020-module-boundary-nestjs.md)
