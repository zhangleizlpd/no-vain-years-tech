---
adr_id: ADR-0035
status: Accepted
applies_to: [apps/server]
sunset_trigger: |
  - 切 SQL-first migration tool (Atlas / Bytebase / Sqitch) — 整套迁移机制走外部工具
  - prisma 切 Drizzle / Kysely (per [ADR-0019](0019-orm-prisma.md) sunset)
  - LLM agent 演化到能自动 derive 命名 + idempotent seed,无需 lefthook hard gate
---

# ADR-0035: Data Layer Governance — migrate + naming + seed + types regen gate

- Status: Accepted
- Deciders: project owner
- Tags: backend / data / prisma / governance / cross-cutting

## Context

Plan 1 W1.4 起 Prisma db pull / migrate 走通,但实际使用暴露 4 类失控:

1. **migration 命名漫无章法** — `add_field` / `update_table` / `fix` 等模糊命名,半年后无法 grep 找到具体改动
2. **prisma generate 手动易漏** — schema.prisma 改后忘 `prisma generate`,导致 `@prisma/client` types stale,运行时报 unknown field
3. **seed 不 idempotent** — 多次跑 throw PK conflict,本地 dev DB reset 后无脚本能可重复 setup baseline 数据
4. **LLM agent 改 schema 风险高** — 无 hard gate 容易 ship 半成品 migration

## Decision

### 1. migration 命名 — timestamp-hybrid

格式:`<yyyymmddhhmm>_<verb>_<obj>`

```text
20260520_1430_add_phone_to_account
20260520_1545_rename_display_name_column
20260521_0900_drop_legacy_session_table
```

- `prisma migrate dev --name <verb>_<obj>` CLI wrapper (`scripts/prisma-migrate.ts`) 自动 prepend timestamp 前缀,user 只写 `verb_obj`
- lefthook 校验 `prisma/migrations/*/migration.sql` 文件夹名匹配该 regex

### 2. prisma generate hard gate (lefthook)

`lefthook.yml` `pre-commit`:

```yaml
pre-commit:
  commands:
    prisma-generate-gate:
      glob: 'apps/server/prisma/schema.prisma'
      run: pnpm -C apps/server prisma generate # 生成物 gitignored,无需 git add re-stage
```

staged `schema.prisma` → 自动 generate(生成物 `apps/server/.gitignore /src/generated/prisma` 已忽略,无需 re-stage)→ schema 非法 / generate 失败即 abort commit,不让 stale client 漏到 CI / runtime。

### 3. 3 层 seed idempotent UPSERT

```text
apps/server/prisma/seeds/
  dev.ts            ← 跨 dev 全员共享 baseline (e.g. 默认 admin / 默认 SMS 模板)
  staging.ts        ← staging 环境 baseline (灰度数据)
  local-personal.ts ← 个人 dev 数据 (我的测试账号) — .gitignore
```

实现策略:

```ts
// 全部走 prisma.account.upsert({ where: { phone }, create: {...}, update: {...} })
// PK 不重则 throw,不 catch — 设计期发现 seed 与 unique constraint 冲突
// 可重复跑 N 次结果相等
```

`apps/server/.gitignore`:

```text
prisma/seeds/local-personal.ts
```

### 4. spec ↔ migration 关联 (frontmatter)

spec 加 `migration_refs: [20260520_1430_add_phone_to_account]` (可选字段,有 migration 影响时填)— 倒查"为什么加 phone 字段"看 spec context。

## Consequences

- **PR-6** ship lefthook prisma-generate-gate + 3 层 seed 骨架 + CLI wrapper
- **migration 命名 retrofit**:已存在 migrations 不动 (历史 immutable),新 migration 起强制
- **`scripts/prisma-migrate.ts`** wrapper CLI:`pnpm db:migrate "add phone to account"` → 自动 timestamp + 移交 prisma migrate dev

## Trade-offs

- lefthook generate 慢(~3-5s)— 仅 schema.prisma staged 时触发,可接受 (per memory `feedback_avoid_slow_pre_commit_or_pre_push`)
- timestamp 命名增 LOC — Grep / Git history 收益更大

## Open Questions

- `db:migrate` wrapper 在 prisma generate 出错时如何 graceful rollback (避免 half-applied schema)
- `local-personal.ts` 是否每个 dev machine 各写 1 份(分散) vs git-crypt 加密入仓(集中) — 起步分散,M3 团队加人触发集中

## References

- memory obs `prisma migration strategy for LLM agents` (3949)
- memory obs `Lefthook hard gate for schema changes` (3950)
- memory obs `idempotent 3-layer seed architecture` (3951)
- [ADR-0019](0019-orm-prisma.md)
- [AI Friction Catalog · F-004 Interactive-CLI-Block](../conventions/ai-friction-catalog.md#f-004--interactive-cli-block) — `db:migrate` wrapper 强制 `--name` flag 缓解 LLM 撞 interactive prompt
