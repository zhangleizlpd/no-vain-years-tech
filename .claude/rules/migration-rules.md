---
paths:
  - 'apps/server/prisma/migrations/**/*.sql'
  - 'apps/server/prisma/schema.prisma'
---

# Migration 治理（path-triggered，触及 prisma schema / migration 时自动加载）

## 单源真理

migration **命名** (`<yyyymmddhhmm>_<verb>_<obj>`) + **prisma generate hard gate** (lefthook `prisma-generate-gate`) + **3 层 seed idempotent UPSERT** + **spec ↔ migration 关联 `migration_refs` frontmatter** 见 [ADR-0035](../../docs/adr/0035-data-layer-governance.md)。本 rule 仅 surface 路径触发的硬 invariant + expand-migrate-contract 三步法。

> 历史 migration `0_init` / `1_add_outbox_event` / `2_drop_legacy_modulith_flyway_tables` 是 ADR-0035 ship 前的 retrofit immutable，per lefthook `migration-naming-check` 仅校验新增。

## 硬性 invariant

### 0. 改完 `schema.prisma` 必须 `prisma generate` —— **包括改完又撤回的情况**

`apps/server/src/generated/prisma/` 是 **gitignored 构建产物**：`git checkout -- schema.prisma` / 删掉 migration 目录 **都撤不掉它**。而 **Prisma 7 把标量 `@default()` 应用在客户端侧** —— 生成物里带着默认值，`create()` 不写该列时由**客户端**发出那个值，与 DB 的 DDL 默认值无关。⇒ **schema 撤回了、生成物还是旧的**，两个真相源就此分叉。

**判据**（2026-08-01 实证，排查耗时 ~40min）：把 `Instrument.needSync` 的 `@default(true)` 临时改成 `false`，期间生成物被重建；撤回 schema 后**全量 gate 151 例失败 / 35 个文件**。表现是 `loadActiveInstruments` 的 `needSync: true` 过滤全落空 ⇒ **所有 marketdata 执行器工作集为空** ⇒ 满屏「expected 1 行 got 0」「vendor calls == []」，**看不出与 schema 有任何关系**。

- 🚨 **大批「无关」测试同时红**，且形态是**查询/工作集为空**（不是断言值不符）→ 先看 `ls -la apps/server/src/generated/prisma/client.ts` 的 mtime 是否落在你改过 schema 的时间窗内。
- 🚨 **DDL 取证证明不了生成物干净**：查 `information_schema.columns.column_default` 只能证明 migration 链是对的，生成物是**另一个独立真相源**，必须单独确认。
- ⚠️ 排查时两个会把人带沟里的推理：① 「隔离重跑还失败 = 真回归」**错** —— 污染在构建产物里，对代码版本免疫，切哪个 commit 都红；② `nx test <proj> --cwd=<worktree>` **未必真切目录**，拿它做 `origin/main` 对照会得到无效结论，有效做法是**在同一工作目录 `git checkout --detach origin/main`**（node_modules / 生成物保持不变，只换源码）。

> lefthook 的 `prisma-generate-gate` 只在 **staged 了 schema/migration 时**兜底；「改了又撤回」恰好绕过它（没有 staged 改动），是本条存在的理由。

### 1. 已合 main 的 migration 不可变

已合 main 的 `apps/server/prisma/migrations/*/migration.sql` **禁止修改**；纠正以新 migration 实现。

强制层：PR review 纪律 + **CI immutability check**（`.github/workflows/pr-validation.yml` 的 `Enforce migration immutability` step：`git diff origin/main --diff-filter=MD` 扫到改 / 删既有 `migration.sql` → 红，per #133）。lefthook `migration-naming-check` 仅校验新增（`--diff-filter=A`），二者互补。

### 2. 破坏性变更走 expand-migrate-contract 三步法

**所有破坏性 schema 变更**（删列 / 改列名 / 改列类型 / 拆表 / 合表）必须拆**三个独立 PR / 部署**，禁止单 PR 一把梭。

| 阶段         | DB 操作                              | 应用代码                                     | DB 状态            |
| ------------ | ------------------------------------ | -------------------------------------------- | ------------------ |
| **Expand**   | 加新结构（列 / 表 / 索引）           | 旧代码继续读旧字段；新代码可双写             | 新旧并存，向前兼容 |
| **Migrate**  | 数据回填                             | 写路径只写新字段（或仍双写）；读路径切新字段 | 新旧并存           |
| **Contract** | 删旧结构（drop column / drop table） | 旧字段已无引用                               | 仅新结构           |

**核心约束**：每一步独立可回滚 + 每一步部署后都能跑生产流量。这也是 prod **image-only 回滚**（`.github/workflows/deploy.yml` healthcheck 失败自动回滚 + 手动 `ops/bin/rollback-prod.sh`）成立的前提——回滚只换镜像 tag、**不回退 DB schema**，故破坏性 migration 必须按本节三步走，否则回滚后旧代码会撞上更新的 schema（脏回滚）。

#### ❌ 反例：单 PR drop + rename column

```prisma
// schema.prisma（错误）
model Account {
  // - phone   String @db.VarChar(32)     // 删
  mobile  String @db.VarChar(32)          // 加 + rename
}
```

应用代码同 PR 把 `phone` 改 `mobile`。

**问题**：滚动部署 / 多实例场景下，旧实例还在读 `phone` 字段就被删 → 报错；rollback 必须同时回退 SQL + 代码。

#### ✅ 正例：拆三个 PR

```prisma
// PR-A: 20260520_1430_add_mobile_column（expand）
model Account {
  phone   String  @db.VarChar(32)
  mobile  String? @db.VarChar(32)         // 新加 nullable
}
// 应用：写路径双写 phone + mobile；读路径仍 phone
```

```sql
-- PR-B: 20260520_1545_backfill_mobile（migrate；prisma migrate dev --create-only 后手工编辑 migration.sql）
UPDATE "account" SET mobile = phone WHERE mobile IS NULL;
-- 应用：读路径切 mobile，写路径仍双写
```

```prisma
// PR-C: 20260521_0900_drop_phone_column（contract）
model Account {
  // phone 已 drop
  mobile  String  @db.VarChar(32)         // not null
}
// 应用：写路径只写 mobile（删双写代码）
```

### 3. 跳步条件

只有**两个条件同时满足**才允许 `expand + contract` 合并到单 PR：

1. **无真实用户数据**：M1.1 ~ M3 内测前的 dev / staging 环境，且确认无回滚需求
2. **PR 描述明示**：「跳过 expand-migrate-contract，理由：< 当前阶段 / 数据状态 >」

M3 内测起，**任何**破坏性变更必须三步走，无例外。

### 4. nullable 列进唯一约束用 sentinel 默认值，非 NULL

新列若要进 `@@unique`（或纳入既有唯一约束），回填**禁用 NULL**：PG 把多个 NULL 视为互异，唯一约束对 NULL 行**不去重**（违背约束意图）；且约束列若 NOT NULL，NULL 回填直接失败。用业务无歧义的 **sentinel 默认值**（数值列 `@default(0)`、字符串列空串 / 哨兵串）让既有行先落确定值，再按需收紧。配合 §2 expand-migrate-contract：加列（带 sentinel default）→ 回填真值 → 收紧约束。
