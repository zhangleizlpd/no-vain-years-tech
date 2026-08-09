---
adr_id: ADR-0020
status: Superseded
applies_to: [apps/server, packages/api-client, packages/types]
sunset_trigger: |
  - 切非 NestJS 框架
  - hexagonal layer 对 LLM 命中率反向负担实证
---

# ADR-0020: 模块边界 — NestJS Module 框架级 + ESLint `eslint-plugin-boundaries` v6 文件级

- Status: Superseded (2026-05-24，by [ADR-0032](0032-backend-bounded-context.md) + [ADR-0043](0043-server-flat-module-paradigm.md))
- Deciders: project owner
- Tags: backend / architecture / cross-cutting

> **⚠️ Superseded（2026-05-24）**：本 ADR 的 hexagonal 四层 ESLint 强制（`domain` / `application` / `infrastructure` / `web`）已退役 —— 模块边界改由 [ADR-0032](0032-backend-bounded-context.md)（bounded-context 拆分，elements 由 layer 切 module）+ [ADR-0043](0043-server-flat-module-paradigm.md)（扁平范式）定义。本篇保留作历史 rationale，不再 in-place 改决策本身（per [ADR-0031](0031-adr-governance.md) § ADR 修订策略 supersede-not-delete）。

## Context

[ADR-0018](0018-backend-language-pivot.md) 锁定 TS / NestJS 后端 stack root,需替代此前 Java/Spring 栈的边界硬约束机制(旧体系 = Maven 多模块物理隔离 + Spring Modulith 运行时验证 + ArchUnit 4 类 CI 规则 + DDD 五层包结构)。

替代设计约束:

1. **DDD 5 层结构保留** — `domain / application / infrastructure / web` 4 层 + 跨 module 公开 `api` 子集(Plan 1 § C.3);domain 层零外部业务依赖必须可强制
2. **ArchUnit 4 类规则对应**(Plan 1 § V2 验收):
   - (a) domain 层零依赖(禁 import application / infrastructure / web / 跨 module 装配)
   - (b) web 层不直接 import infrastructure(必经 application use case)
   - (c) 跨 module 通信经 module 公开 api,不直接 import 内部 provider
   - (d) shared package 不依赖 business module
3. **强制层级** — Java 体系是 CI ArchUnit 失败拦截 PR;新栈需达到同等"边界违规进不了 main"的硬度
4. **solo dev 节奏不能拖慢** — pre-commit / CI 加 lint rule 不能让单 task 提交 > 30s(memory `feedback_avoid_slow_pre_commit_or_pre_push`)

## Decision

采用**双层边界保险**:

### 层 1 — NestJS Module 框架级 export white-list(主要保险)

- 每个 business module(W2 实装 `apps/server/src/auth/`,W3+ 扩 `pkm/` 等)对应 1 个 `*.module.ts` 装配文件
- `@Module({ providers, exports })` — 只 export 显式列出的 provider(domain interface 或 controller 不 export);跨 module import 必须显式声明 `imports: [OtherModule]`
- 跨 module 通信只能消费 `OtherModule.exports` 的 provider — 这是 NestJS DI 容器**框架级强制**(任何未 export 的 provider 注入会运行时报"can't resolve dependencies"),不依赖 lint / CI 即可拦截

### 层 2 — ESLint `eslint-plugin-boundaries` v6 文件级 lint(兜底保险)

- `apps/server/eslint.config.mjs` 配 `eslint-plugin-boundaries` v6
- 4 类 element type(per `boundaries/elements`):

  ```ts
  { type: 'domain',         pattern: 'src/<module>/domain/**' },
  { type: 'application',    pattern: 'src/<module>/application/**' },
  { type: 'infrastructure', pattern: 'src/<module>/infrastructure/**' },
  { type: 'web',            pattern: 'src/<module>/web/**' },
  { type: 'module',         pattern: 'src/<module>/<module>.module.ts' },
  { type: 'app',            pattern: 'src/{app,main}.ts' },
  ```

- `boundaries/dependencies` rule(default: `allow`,显式 disallow):

  ```ts
  { from: { type: 'domain' }, disallow: { to: { type: ['application', 'infrastructure', 'web', 'module'] } } },
  { from: { type: 'web' },    disallow: { to: { type: 'infrastructure' } } },
  ```

  — 对应 § Context (a)(b) 规则。规则 (c) 跨 module 通信 / (d) shared package 边界在 mono W2 单 auth module / 0 shared package 阶段暂未开启;多 module 后启用 `boundaries/no-private` + `boundaries/external`(W3+ surface)

- **v6 object-selector syntax**(per `eslint-plugin-boundaries` v5 → v6 migration) — v5 legacy `boundaries/element-types` + 字符串 disallow array 在 v6 下 **silent no-op**(详 memory `feedback_lint_plugin_upgrade_must_verify_with_violation`),W2 T040 升级时由 forbidden import 实证拦截 fire

### 层 3 — Nx `@nx/enforce-module-boundaries`(跨 project 边界,沿用 mono root)

- mono root `eslint.config.mjs` 继承 `@nx/eslint-plugin` 的 `@nx/enforce-module-boundaries` 规则,作 **monorepo project 间** 的边界(`apps/server` 不直接 import `apps/mobile` 内部 / `packages/*` 边界)
- 与层 2 互补:层 2 管 `apps/server` 内 hexagonal 层级,Nx rule 管 mono project 边界

### 实际目录布局(per W2 ship + ADR-0018 § Decision)

```text
apps/server/
  src/
    auth/                       # business module
      domain/                   # 纯函数 + interface,零外部业务依赖
        model/                  # Account / Credential / PhoneNumber 等聚合
        policy/                 # 业务规则纯函数
        port/                   # repository.interface.ts / 外部依赖 port
      application/              # @Injectable use case 编排
      infrastructure/           # Prisma repo impl + Aliyun SDK adapter + Throttler 配置
      web/                      # Controllers + DTO
      auth.module.ts            # @Module() 装配 + 显式 export
    app/                        # AppModule(根装配)
    main.ts                     # NestJS bootstrap
  eslint.config.mjs             # 继承 mono root + 加 boundaries
  prisma/schema.prisma
```

**与 Plan 1 § C.3 sketch 的差异**: Plan 1 写 `src/modules/<module>/`,实际 W1.4 落 `src/<module>/`(去掉 `modules/` 包装层) — 单层包装不增加边界硬度,扁平 layout 更短。

## Consequences

### Positive

- **层 1 NestJS Module 框架级强制** — 未 export 的 provider 注入运行时即报错,solo dev / Claude 协作场景几乎不可能写错跨 module 调用并 ship 到 main
- **层 2 ESLint 文件级 lint 兜底** — domain 层 import application / infrastructure / web / module 装配会被 lint 拦截,W2 T040 forbidden-import 实证拦截 fire(memory `feedback_lint_plugin_upgrade_must_verify_with_violation`)
- **ArchUnit 4 类规则(a)(b)在新栈 1:1 覆盖** — V2 验收 rule-by-rule 对照表 PASS;规则 (c)(d) W3+ 多 module 时启用
- **DDD 5 层结构保留** — domain / application / infrastructure / web 4 层 + `*.module.ts` 装配文件 + `port/` 子目录显式标外部依赖接口,Plan 1 § C.3;DDD 思想完全保留
- **测试边界** — `src/**/*.spec.ts` / `src/**/*.test.ts` / `src/__smoke__/**` 在 `eslint.config.mjs` 内显式关 `boundaries/dependencies`(测试代码穿层访问允许),不污染 prod boundary
- **学习曲线** — Spring `@Component` / `@Service` / `@Configuration` 老用户对 NestJS `@Injectable` / `@Module` 概念几乎 0 阵痛

### Negative / Trade-offs

- **模块物理隔离弱于 Maven 多模块** — 单 jar / 单 dist;拆服务时 module 不能直接 `mvn package` 出独立 artifact,需要 Plan 2+ 做 Nx project 拆分(`apps/auth-service/` 等独立 project)。**solo dev 阶段够用**(Plan 1 § C.3 主动承认"软约束版"),多 dev / 拆服务前需评估
- **AI 静默踩坑面**(memory `feedback_audit_must_verify_code_anchors` + `feedback_lint_plugin_upgrade_must_verify_with_violation`) — `eslint-plugin-boundaries` v5 → v6 syntax 不向下兼容且 silent no-op;**任何 lint plugin major bump 必须 forbidden import 验证 rule 真 fire**,不可信 lint pass 假绿
- **Spring Modulith 运行时 outbox 替换** — 此前 Spring Modulith 自带 Event Publication Registry(outbox);新栈手写 outbox(W3 落 `OutboxEventPrismaPublisher` + `OutboxEventCronPublisher.scan()`,详 memory `feedback_transactional_outbox_port_shape`) — ~150 LoC 显式但可控
- **跨 module 通信约束相对宽松** — Plan 1 § C.3 写"跨 module 通信只能经 api/ exported provider";W2 单 module 阶段未启用 `boundaries/no-private` rule,**W3+ 第 2 个 business module 加入时必须启用**作 sweep
- **Nx project boundary** — `@nx/enforce-module-boundaries` 当前依赖 mono root `nx.json` + 各 project `tags`,W2 PoC 阶段 `apps/server` 单 project + `packages/*` 0 业务包,边界硬度未真考验;Plan 2 多 project 后启用 tags 才 surface

## Alternatives Considered

- **仅 NestJS Module(不加 ESLint boundaries)** — 拒绝:NestJS Module 边界只覆盖 DI 注入维度,**文件级 import** 仍可绕过(domain 层文件直接 `import { PrismaService } from '../infrastructure/...'` typecheck 通过 + DI 不需要也能跑);需 lint 兜底
- **dep-cruiser** — 拒绝:`dependency-cruiser` 配置基于 forbidden / allowed rule + 配置文件 YAML / json,声明式但语义重复 ESLint boundaries plugin,且与 ESLint 双工具栈成本 > 单 ESLint;`eslint-plugin-boundaries` v6 object-selector syntax 表达力已够 4 类规则
- **Nx tags + `@nx/enforce-module-boundaries` 单层(不加 boundaries)** — 拒绝:Nx tags 边界是 **project 间** 维度,`apps/server` 内 hexagonal 层级穿透(domain / application 等)Nx 不管;留 Nx rule 作 mono project 边界(详 § Decision 层 3),不替代层 2
- **ArchUnit-TS / ts-arch** — 拒绝:社区维护活跃度低于 `eslint-plugin-boundaries`;Java ArchUnit 概念翻 TS 显得过工程,solo dev 阶段不取
- **Spring Modulith TS port(社区版)** — 拒绝:无成熟社区实现;NestJS 自身 Module 系统已涵盖 Spring Modulith 80% 功能(运行时验证 + DI 注入),outbox 部分单独做(W3 ship)

## References

- [Plan 1 § C.3 DDD 实施 — NestJS Module 范式](../private/plans/2026-05/05-18-plan1-backend-stack-poc.md)
- [V2 验收 — NestJS module 边界对标 ArchUnit](../private/plans/2026-05/05-18-plan1-backend-stack-poc.md)
- [`apps/server/eslint.config.mjs`](../../apps/server/eslint.config.mjs)
- [`eslint-plugin-boundaries` v5 → v6 migration](https://github.com/javierbrea/eslint-plugin-boundaries/releases)
- [ADR-0018: 后端 stack root pivot](0018-backend-language-pivot.md)
- [ADR-0019: ORM = Prisma](0019-orm-prisma.md)
