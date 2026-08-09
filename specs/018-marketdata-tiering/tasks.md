---
feature_id: 018-marketdata-tiering
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-04'
---

# Tasks: 018-marketdata-tiering（T0/T2 二级分级 — executor 前置重算 + tier 序消费 + Q7-B 直查）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `018-marketdata-tiering`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 映射 spec user story（US1 syncTier 重算 / US2 tier 序消费+T0 保底 / US3 跨 ctx 治理与回归门）；终局 Verify（T008）不带，治理 Verify（T003）带 US3
- 层 = `[Server]` / `[Server-IT]` / `[Verify]`（纯 server 同步行为升级，无新端点 → 无 [Contract]/[Mobile]，FR-S07）
- **Phase = PR 交付单元**（plan §Phase 2 两片；各自独立绿）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；重算簇 = **Testcontainers PG-only**（新 spec 文件 `marketdata.tier-recalc.it.spec.ts`）；消费序/顺延/端到端 = **Testcontainers PG+Redis + mock vendor**（蓝本 `marketdata.dimension-worker.it.spec.ts`，afterAll close；run via `nx test server <file>`，cwd=apps/server）
- 无 task-meta JSON（manual 模式，per 004-017）
- **架构已定稿不重开**（ADR-0048 复审记录）：Q7-B 直查终态——**禁** Outbox/投影表/计数器/portfolio use case 直 DI；本 tasks 只落 plan D1-D6 工程决策
- **clarify 三裁决**（2026-06-04，实现承重点）：① 重算 = executor 前置（`runDimension` fact 分支起手单点，D1）；② 生效 = 下一次同步运行快照（无实时升级机制）；③ T0 失败优先重试不实装（failedTargets 照记审计）
- **零新依赖 / 零 schema 迁移 / 零 moat 脚本改动**（机制 + `watchlistItem: 'portfolio'` ownership L79 全现成）
- **幂等零行变更承重点**：双 `updateMany` 必须带 `syncTier: {not: X}` 过滤（FR-S01 专项断言：重复 recalc 返回 0 行影响）
- **2 段 PR（均纯 server）**：**PR-1**（T001–T003 重算+治理）→ **PR-2**（T004–T008 tier 序消费+回归门）。无端点 → 无 api-client regen

## Path Conventions

- server：`apps/server/src/marketdata/`（ADR-0043 扁平平铺）；新文件唯一 = `sync-tier-recalc.ts`；IT `apps/server/test/integration/marketdata.*.it.spec.ts`
- **spec drift 锚点（impl 前 grep 验真）**：① `loadActiveInstruments` 在 `dimension-executor.ts` L244-248（**不在** eod-sync-pipeline.ts，017 已迁）；② `runDimension` fact 分支 = universe/profile 早退（L199-204）之后、`loadDimension` L206 之前；③ `MARKET='cn'` 常量 L33；④ `alertIfDegraded` L525（降级 log 风格）；⑤ moat Check 1 `contiguousCommentAbove`（L266-273）——注释必须紧贴语句上方连续注释块；⑥ PR-2 起手 grep 既有 IT 是否有依赖 `id asc` 消费序的断言
- 模板：手控 `@Injectable` 单一职责类 = `redis-sync-lock.ts` 同型
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait` + migrate deploy（mbw-poc-postgres:5433 / redis:6380）；本地 IT 前 `env -u OSS_*` + 显式 dev `DATABASE_URL`/`REDIS_URL`
- ⚠️ 新 ts/spec 首跑带 `--skip-nx-cache`

---

## Phase 1: PR-1 — syncTier 重算 + Q7-B 治理（US1, US3）

- [X] T001 [US1] [Server] **`SyncTierRecalc` 重算类（查询+落库+降级全包）**：新文件 `apps/server/src/marketdata/sync-tier-recalc.ts` —— `@Injectable() SyncTierRecalc`（构造器注入 `PrismaService`），单方法 `recalcSafely(): Promise<{promoted: number; demoted: number} | null>`：① Q7-B 直查——`// CROSS-CONTEXT-READ: 只读 portfolio watchlist_item 全账号 distinct(market,code) 并集，算 marketdata 自有 syncTier（ADR-0048 Q7-B 终态 2026-06-04）` 紧贴语句上方 + `prisma.watchlistItem.findMany({where: {market: MARKET}, distinct: ['code'], select: {code: true}})`；② 落库——`$transaction([updateMany({where: {market: MARKET, code: {in: codes}, syncTier: {not: 0}}, data: {syncTier: 0}}), updateMany({where: {market: MARKET, code: {notIn: codes}, syncTier: {not: 2}}, data: {syncTier: 2}})])`（D3，`{not}` 过滤 = 幂等零行变更；codes 空 → 第一条 no-op + 第二条全量回 T2）；③ 降级——方法内 try/catch 全包，失败 `logger.warn`（参照 `alertIfDegraded` L525 风格，不新增告警通道）返回 `null`，caller 无感知（D4，**不上抛**——防 executor 顶层 catch 误记 SyncRun=failed）；`marketdata.module.ts` providers 注册 → verify（TDD 红绿，Testcontainers PG-only 新 spec `apps/server/test/integration/marketdata.tier-recalc.it.spec.ts`）: 命中→0 / 未命中→2 / 多用户多组同标的去重仍 0 / 连跑两次第二次 `{promoted: 0, demoted: 0}`（幂等零行变更专项）/ 清空 watchlist 全回 T2 / `findMany` 注入抛错 → 返回 null 不抛 + warn log 断言。run via `nx test server <file>` `--skip-nx-cache`
- [X] T002 [US1] [Server] **`runDimension` fact 分支接线（D1 单点）**：`apps/server/src/marketdata/dimension-executor.ts` —— fact 维度分支起手（universe/profile 早退之后、`loadDimension` 之前）插入 `await this.tierRecalc.recalcSafely()`；构造器注入 `SyncTierRecalc`（同 ctx 注入，无注释要求）；universe/profile 分支**不**触发重算 → verify（扩展 `marketdata.dimension-worker.it.spec.ts`）: seed watchlist + 入队 `sync:eod_bar` job → 处理后断言命中标的 syncTier=0 且 DailyBar 落库（全路径自带重算证据）；universe job 处理 → spy 断言 `recalcSafely` 未被调用
- [X] T003 [US3] [Verify] **PR-1 治理门**：`pnpm tsx scripts/checks/check-server-moat.ts` 0 violation（注释机制 + ownership 全现成，跑通即验）+ `rg 'CROSS-CONTEXT-READ' apps/server/src/marketdata/` 恰好命中 `sync-tier-recalc.ts` + `nx lint server`（ESLint boundaries 零新 module 边——直查经 PrismaService 无 portfolio import）+ `nx run server:typecheck` + PR-1 全部 IT 绿（首跑 `--skip-nx-cache`）→ 通过后 PR-1 走 commit-push-pr + auto-merge

---

## Phase 2: PR-2 — tier 序消费 + T0 保底 + 回归门（US2, US3）

- [X] T004 [US2] [Server] **tier 序消费（一行改 + 既有断言适配）**：起手先 grep 既有 IT 依赖 `id asc` 消费序的断言（drift 锚点⑥，`rg -l 'orderBy|id.*asc' apps/server/test/integration/marketdata.*` 逐个核），有则改为 tier 序口径；`dimension-executor.ts` L248 `orderBy: {id: 'asc'}` → `orderBy: [{syncTier: 'asc'}, {id: 'asc'}]`（同 tier 内 id 稳定序，FR-S03；select 不加列、无新索引）→ verify（TDD：消费序 IT 先红）: mock vendor adapter 记录 per-instrument 调用序 → seed T0/T2 混合 universe → 任一 fact 维度同步后断言 **T0 符号集整体先于任何 T2 符号**（D6 断言方式，SC-S02）
- [X] T005 [US2] [Server-IT] **截断保底 + 顺延续跑 IT**：`maxEodInstruments` 注入（> T0 数且 < T0+T2 总数）→ 断言 T0 全部落库、T2 部分截断、`budgetExhausted=true`（017 顺延信号语义不变）；模拟续跑（再次执行同维度，`pendingEodInstruments` 进度锚生效）→ 断言已同步标的跳过、剩余 T2 按 tier 序继续、零重复行（SC-S03）。run via `nx test server <file>` `--skip-nx-cache`
- [X] T006 [P] [US3] [Server-IT] **回归断言簇（护值 + 黑名单优先）**：① universe upsert 护值——seed 标的 syncTier=0 → 跑 universe 同步 upsert 既有标的 → 断言 syncTier 仍 0（016 行为回归，FR-S05）；② 黑名单优先级——T0 标的入 `SyncBlacklist` → 维度同步 → 断言完全跳过（FR-S09，黑名单 > tier）
- [X] T007 [US2] [Server-IT] **端到端一夜模拟（SC-S06）**：Testcontainers PG+Redis 控时（蓝本 `marketdata.flow-orchestration.it.spec.ts`）——seed watchlist + T0/T2 universe → tick due 入队 → flow 执行（重算 executor 前置自动发生）→ tier 序消费 → 预算截断 → 顺延续跑 → 断言：T0 全保鲜（全部维度落库）、T2 截断后续跑补齐、per-dim SyncRun 行如实、syncTier 终态正确。run via `nx test server <file>` `--skip-nx-cache`
- [X] T008 [Verify] **全绿门 + 收尾**：`pnpm exec nx affected -t lint typecheck test build --base=origin/main` 全绿（首跑 `--skip-nx-cache`）+ 016/017 既有 marketdata IT 全量回归（`nx test server` marketdata.* 套件）+ `check-server-moat` 关 + `server-bounded-context-catalog.md` 跨 ctx 传播段更新（marketdata→portfolio Q7-B 只读边登记，叶子 ctx 表述移除）+ spec frontmatter `status: implemented` 翻转 + tasks.md 全 `[X]` 复核 → 通过后 PR-2 走 commit-push-pr + auto-merge

---

## Dependencies & 执行顺序

```text
PR-1: T001 → T002 → T003（串行：T002 注入 T001 的类；T003 验整片）
PR-2: T004 → T005 → T007（消费序是截断/端到端的前提）
      T006 [P]（与 T004/T005 并行，不同断言面）
      T008（最后，全绿门）
跨片: PR-2 基于 PR-1 合入后的 main（重算先在、消费序后动）
```

- **MVP** = PR-1 + PR-2 前半（T004）：重算落 tier 事实 + 消费序生效即兑现「保用户可见集最鲜」
- 並行机会：T006 与 T004/T005 并行；其余串行（同文件 `dimension-executor.ts` 是 conflict 磁铁，per memory 串行处理）

## 对齐 plan §Phase 2 落地序

| PR | tasks | spec 验收 |
| --- | --- | --- |
| PR-1 | T001–T003 | SC-S01（重算簇）+ SC-S04（治理门） |
| PR-2 | T004–T008 | SC-S02（消费序）+ SC-S03（截断保底）+ SC-S05（回归门）+ SC-S06（端到端） |
