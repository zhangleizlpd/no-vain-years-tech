---
adr_id: ADR-0043
status: Accepted
applies_to: [apps/server]
sunset_trigger: |
  - 单个 bounded context use case 数 > 20（扁平单层开始失焦，需内部再分组）
  - 团队规模 > 1（多人协作下贫血 + 约定护城河风险升高，需重引编译期隔离）
  - 引入第 2 个非 Prisma 持久化（贫血 POJO 类型来源不再单一）
---

# ADR-0043: Server 模块内构范式 — 扁平 + 贫血数据 + 纯函数 Helper + UseCase 跨界

- Status: Accepted
- Deciders: project owner
- Tags: server / architecture / module-internal / llm-ergonomics

## Context

[ADR-0032](0032-backend-bounded-context.md) 退役了 hexagonal **层强制**（ESLint elements 由 layer 切 module）并永久埋葬四层（§ 架构历史决议对齐），但只说了「不要什么」：当前模块物理上仍残留 `domain/application/infrastructure/web` 子目录 + repository port + 充血 aggregate。本 ADR 补上「要什么」—— 定义 post-Hexagonal 的**正向**模块内构范式，目标是对 LLM Agent 的上下文聚焦最优 + 反过度设计。

核心根因（为何不在 TS 里搞重型分层）：

1. TS 结构化类型 + Zod 契约 + Prisma 生成类型 + DI 已在 module 内部提供天然解耦，不需要 Port-Adapter 做「换库」的虚无隔离（换库概率 ≤ 1%，而分层拖慢开发概率 100%）。
2. 极度碎片化的文件树（一个 CRUD 跨 5 层文件夹）是 LLM 产生「依赖幻觉」+ 注水 boilerplate 的孵化器，内耗 token 与 Ralph-loop 算力。
3. 范式从「纵向分层」转「横向切片」：以 Bounded Context 为最高物理红线，模块内部扁平内聚。

## Decision

### 1. 模块内构扁平化

业务 context（`auth` / `account` / ...）内**禁** `domain` / `application` / `infrastructure` / `web` 层子目录。文件平铺于 module 根：`*.controller.ts` / `*.usecase.ts` / `*.dto.ts` / `*.store.ts`（自有非 DB 基建）/ `*.rules.ts`（纯函数不变量）/ 存活的 `*.port.ts` + `*.adapter.ts`。

### 2. 贫血数据 + 纯函数 Helper

数据 = Prisma 原始 POJO（绝对贫血）。不变量校验抽成**无状态纯函数**置于 `<ctx>.rules.ts`。**禁**带状态 Domain Class、**禁** Entity Mapper（Prisma ↔ Class 转换一旦出现即复活 Hexagonal 噩梦）。

```typescript
// account/account.rules.ts —— 纯函数，无状态，不碰 DB
import type { Account } from '../generated/prisma/client';

export const isActive = (a: Account): boolean => a.status === 'ACTIVE';
export const isFrozen = (a: Account): boolean => a.status === 'FROZEN';
export const isAnonymized = (a: Account): boolean => a.status === 'ANONYMIZED';
```

#### 2a. snake_case 体验问题在 `schema.prisma` 层用 `@map` 解决（**不**写 POJO 映射）

贫血层直接消费 generated Prisma row，但 DB 列是 snake_case。**绝不**为改大小写写 `mapToX(row)` —— 那就是 Entity Mapper 特洛伊木马（今天 map 大小写、明天塞状态、后天分层复活；且 `select` 部分字段时 mapper 必崩）。正解在 schema 层：model 用 PascalCase + `@@map("snake_table")`，多词列用 camelCase + `@map("snake_col")`。TS client 字段 camelCase、物理列名保留 snake_case、**零运行时开销 + 零 migration**（`prisma migrate diff --from-schema <old> --to-schema <new> --exit-code` 实测空，因描述同一物理库）。

可空列（如 `phone String?`）→ `phone: string | null` **让它穿透**到 UseCase / Rules，编译器逼显式处理 null = 业务严谨性的物理保护。若业务上绝不可空 → 改 schema 为非空（`String`），**禁**用 POJO / `!` 断言掩耳盗铃。

#### 2b. 输入校验：Value Object 也拍平为纯函数（**零 class**）

输入校验（手机号 / 显示名 / 验证码格式等）原 Value Object class 一并拍平为 `*.rules.ts` 纯函数 —— 保留 VO class 会撕裂心智模型（「既然 Phone 能是 class，为什么 Account 是裸 POJO」），并到处 `phone.value` 装箱/拆箱。北极星：`apps/server/src/` 下**零 class（除 NestJS 必需的 Controller / UseCase / Module / Guard / Filter / Interceptor / @Injectable Service / HttpException 子类 / class-validator DTO）**。

- **有归一语义的**（trim / 大小写折叠）→ `normalizeX(raw): string` 返回规范化值（如 `normalizePhone` / `normalizeDisplayName` trim 后返回）。
- **纯校验无变换的** → `assertValidX(raw): asserts raw is string`（如 `assertValidSmsCode`）。
- 校验在**边界**（controller）调用,内部一律传裸 string。`.equals()` → `===`。

### 3. 三条跨界规则

1. **R1 同 ctx + 自己的表** → 直注 `PrismaService` 读写，无 repository 接口。
2. **R2 跨 ctx 同步**（同 tx 强一致）→ DI 注入对方 **UseCase**（受 [ADR-0032](0032-backend-bounded-context.md) 单向放行），传 `tx`；**禁** `tx.<otherTable>.*`。
3. **R3 跨 ctx 副作用** → Outbox 异步，发布方 `publish(tx, eventType, payload)`，消费方按 event-type 字符串契约响应，双方互不 import。

#### 3a. R2 落地形态：生命周期委托（高内聚），必要时两段式（Two-Step Saga）

被调 context 暴露的不是「贫血 CRUD 微操」（`find` + `create` + `recordLogin` 三个细粒度 use case 会让 caller 变成对方状态机的 micromanager），而是**高内聚的生命周期委托**：把「这个手机号登录成功后，账户体系该如何流转」整个委托给 callee 的 use case。Caller（编排层 `auth`）只表达意图，callee（`account`）独占自己表的读写。

**但当 caller 自身的校验/防御必须夹在「读 callee 状态」与「写 callee」之间时，单个 use case 吞不下，必须拆两段（Inspect 读 + Commit 写）**：

- **第 1 段 `Inspect*UseCase`（只读）** → 返回贫血 discriminated 状态（如 `{ kind: NOT_FOUND | ACTIVE | FROZEN(+freezeUntil) | ANONYMIZED }`），**不改任何数据**。让 caller 在调用方自己的校验**之前**拿到 callee 状态做分支（反枚举要求：FROZEN → 403 披露 / ANONYMIZED → timing-pad 401，状态判定必须先于验码）。
- **第 2 段 `Commit*UseCase`（写）** → caller 校验通过后调用，callee 自持 `$transaction`，find-or-create + 状态写 + R3 事件 publish + race fallback。

**为何不能图省事用单个 upsert-first use case**（血泪教训，保留作 anti-pattern）：

1. **0-day**：upsert 在 caller 校验（如短信码）**之前**就建号 → 任何人无需验证码即可为任意手机号建账户，被黑产瞬间耗尽资源。
2. **失败前置态污染**：`upsert({ update: { lastLoginAt } })` 在 `isFrozen` 检查**之前**就更新了字段。

**安全 + 时序永远凌驾于代码结构洁癖之上。** 实装样本见 `account/inspect-account-status.usecase.ts` + `account/commit-phone-login.usecase.ts`（auth `phone-sms-auth.usecase.ts` 两段委托）。

### 4. Port 三分法（替代「封杀所有 port」）

| 场景                                                             | 处理                                        |
| ---------------------------------------------------------------- | ------------------------------------------- |
| 自己 context 的 DB 表                                            | 直注 PrismaService，无 port                 |
| 自己的非 DB 基建（Redis + HMAC 等）                              | concrete service，无 interface              |
| 外部 3rd-party 厂商 SDK（阿里云 SMS 等）                         | 保留薄 port + adapter（可换厂商 + 可 mock） |
| 跨 ctx 发布契约（[ADR-0033](0033-outbox-cross-context-comm.md)） | 保留 port，落 `security/outbox/`            |

### 5. 强制层级（诚实声明）

- 跨 module **import 方向**（`account ↛ auth`、`security ↛ 业务`）→ ESLint `boundaries` 机器硬卡。
- **「只碰自己 owns 的 Prisma model」**（禁 `tx.account.*` in auth）→ boundaries 看不见 Prisma 调用，**已由 `ts-morph` AST 探针 `scripts/checks/check-server-moat.ts` 机器强制**（Plan 05-24 R-6，与 [ADR-0034](0034-auth-account-operation-catalog.md) Evolutionary Path Stage C 注释扫描器合并；挂 lefthook + pr-validation CI）：跨 ctx 写永远禁、读需 `// CROSS-CONTEXT-READ:` 逃生口。

## Consequences

- **amends [ADR-0019](0019-orm-prisma.md)**：撤销其「DDD repository interface + infra impl」边界，改 PrismaService 直连。
- **amends [ADR-0033](0033-outbox-cross-context-comm.md)**：outbox 三件套物理位置 `auth/` → `security/outbox/`（让 account / security 也能 publish，符合依赖方向）。
- **触发 [ADR-0041](0041-server-common-directory-policy.md) sunset**：outbox 迁入使 security 非 JWT 成员 > 7 → 按其预设「拆 security/ 子目录」应对（`security/outbox/`），仍不引入 `src/common/`。
- 触发一次跨模块重构（见 `docs/private/plans/2026-05/05-24-server-flat-paradigm-refactor.md`）。

## Trade-offs

- 贫血失去编译期不变量封装 → 由纯函数 helper + 单测补偿；不变量集中在 `*.rules.ts` 不散落。
- 数据护城河已由 R-6 AST 探针（`scripts/checks/check-server-moat.ts`）机器强制；R2「调 UseCase 不碰表」从 CR 引导转 CI 硬卡（跨 ctx 写禁、读需 `CROSS-CONTEXT-READ` 逃生口）。
- 扁平在单 context use case 暴增时会失焦 → sunset trigger 兜底。

## References

- [ADR-0032](0032-backend-bounded-context.md) bounded context 拆分 + hexagonal 永久退役
- [ADR-0033](0033-outbox-cross-context-comm.md) Outbox 跨 ctx async
- [ADR-0019](0019-orm-prisma.md) ORM Prisma（repository 边界被本 ADR amend）
- [ADR-0041](0041-server-common-directory-policy.md) `src/common/` 禁用 + security 平台基座
- [ADR-0034](0034-auth-account-operation-catalog.md) 跨 ctx 注释规则 + Stage C 扫描器
