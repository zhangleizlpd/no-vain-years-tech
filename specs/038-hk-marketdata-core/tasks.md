---
feature_id: 038-hk-marketdata-core
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: 2026-07-11
---

# Tasks: 038-hk-marketdata-core（港股核心数据同步 + 平台市场缝隙激活）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `038-hk-marketdata-core`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 映射 spec user story（US1 价量历史可回测 / US2 基本面·财报·公司行动 / US3 保守多夜回填+A股无回归）；Foundational / Verify 不带
- 层 = `[Server]` / `[Server-IT]` / `[Verify]`（per sdd.md；**本 feature 纯 server 数据摄取，无新读端点（015 market-agnostic 天然覆盖 hk）→ 无 [Contract]/[Mobile]/[Mobile-E2E]**，plan §Constitution V）
- **单 PR**（一个 feature = 一个分支 = 一个 PR，Constitution §V 纯 server 单 PR）；Phase = **逻辑 task 组**（非 PR 拆分）。Phase 1（平台缝隙）= 首个 task 组，**mock+cn 先测绿、不依赖订阅**。⚠️ 若你偏好增量交付以隔离回归风险：Phase 1（seam 重构）可单独先 ship 一个 PR、Phase 2-5（扩 HK）第二个 PR —— 二者 task 边界已对齐（见文末）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；同步管线落库/marketScope 过滤/幂等 = **Testcontainers PG(+Redis)**（run via `nx test server <file>`，cwd=apps/server，per memory `testcontainers_spec_run_via_nx_cwd`）；纯函数（symbol 路由/自限速/tier 判定）= vitest 无 DB；**每 Phase 末单列 `[Server-IT]` 集成 task**；vendor 契约 = mock 单测 + **env-gated 真 vendor IT**（`RUN_MARKETDATA_IT` + `LIXINGER_TOKEN`，默认 skip，沿 015/016 `describe.skipIf`）
- **19 条 `state_branches`（spec frontmatter）逐条须在 IT 有 `it()`**（ADR-0040 / plan Testing Invariants）—— 各 Phase IT task 标注覆盖哪些分支
- 无 task-meta JSON（**manual 模式**，per 004-037）

## Path Conventions

- server：`apps/server/src/marketdata/`（015/016 已建 module，ADR-0043 扁平文件平铺，**改动全在此单一 bounded context 内**）；migration `apps/server/prisma/migrations/{YYYYMMDD}_{HHMM}_hk_marketdata_marketscope/`（**data-only** UPDATE + `migration_refs` frontmatter，ADR-0035，**零 DDL**）；IT `apps/server/test/integration/marketdata.hk-038.*.it.spec.ts`（run via `nx test server <file>`）
- **复用（改造而非新建）**：`lixinger-symbol.rules.ts`（`LixingerMarket='cn'|'hk'` + `SUPPORTED_MARKETS={cn,hk}` **已就绪不改**）、`lixinger-adapter.base.ts`、6 个 `lixinger-*.adapter.ts`、`dimension-executor.ts`、`marketdata-backfill.cli.ts`、`sync-tier-recalc.ts`、`lixinger-trading-calendar.adapter.ts`、`sync-universe.usecase.ts`、`DualWindowRateLimiter`/`VendorHttpClient`（限速不改）；7 张 marketdata 表 market-agnostic 直接承载 hk 行（**禁新表/禁 `hk_*` 前缀**，INV-1）
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait` + `prisma migrate deploy`（mbw-poc-postgres:5433 / redis:6380）；本地起服/IT 前 **`env -u OSS_*`** + 显式 dev `DATABASE_URL`/`REDIS_URL`（per memory `local_it_smoke_needs_env_unset_oss`）
- ⚠️ 新 ts/spec 首跑带 **`--skip-nx-cache`**（per memory / implement-task-closure）
- **前置就绪**：HK 付费包已订阅（有效期至 2027-05-12）；`LIXINGER_TOKEN` 经 SOPS 注入（p0 已确认）

---

## Phase 1: 平台市场缝隙激活（Foundational — mock+cn 先测绿，不依赖订阅）🎯 地基

**Independent Test**: Testcontainers PG + mock adapters；① mock+cn 全绿（A 股同步/adapter 路径/工作集**逐字节无回归**）；② mock hk 符号 → adapter 命中 `/hk/` 路径 + `marketScope={cn,hk}` 工作集含 hk；③ 非 cn/hk 前缀 → `UnsupportedLixingerMarketError`；④ `backfill --markets hk` 估算按 hk。**seam 全绿即平台就绪**（扩 HK 在后续 Phase 接）。

- [X] T001 [Server] **`marketScope` 过滤取代 `MARKET` 常量**（seam#2）：`apps/server/src/marketdata/dimension-executor.ts` `loadActiveInstruments` 从 `where:{market:MARKET,status:'active'}` 改 `where:{market:{in: dim.marketScope},status:'active'}`（`dim` = 当前维度 `SyncDimension` 行）；清理 `MARKET='cn'` 常量 orphan（`marketdata.types.ts:13` 定义 + `:43` re-export + `dimension-executor.ts:9,43`）；`marketdata-backfill.cli.ts` `estimateRequests` 去 `market:'cn'` 硬编码（按传入 markets 统计）→ verify（vitest + Testcontainers）: `marketScope={cn}` 工作集只 cn / `={cn,hk}` 含 hk；**现有 016/018/019 IT 无回归**（run `nx test server marketdata --skip-nx-cache`）（state_branch「marketScope 过滤 cn-only / 含 hk」）
- [X] T002 [P] [Server] **adapter 路径按 market 段插值**（seam#1）：6 个 Lixinger adapter（`lixinger-eod-bar.adapter.ts:57,65`、`lixinger-fundamental.adapter.ts`、`lixinger-financials.adapter.ts`、`lixinger-corporate-action.adapter.ts`、`lixinger-universe.adapter.ts`、`lixinger-adapter.base.ts:89 resolveFsTypes`）解构 `{market,stockCode}=toLixinger(sym)` + 路径 `` `/${market}/company/...` ``；**删** fundamental/financials adapter 的 `.filter(e=>e.lix.market==='cn')` 静默丢弃（A 股硬编码残留）→ verify（vitest）: `cn:600519`→`/cn/...`、`hk:00700`→`/hk/...` 路径断言 + 非 cn/hk 前缀 → `UnsupportedLixingerMarketError`（state_branch「市场路由 cn 无回归 / hk / 未知市场前缀」）
- [X] T003 [Server] **`marketScope` data migration（零 DDL）**：`apps/server/prisma/migrations/{YYYYMMDD}_{HHMM}_hk_marketdata_marketscope/migration.sql`：`UPDATE marketdata.sync_dimension SET market_scope=ARRAY['cn','hk'] WHERE dimension_key IN ('universe','profile','eod_bar','fundamental','financial','corporate_action')`（幂等 WHERE，expand/data-only，`migration_refs` frontmatter ADR-0035）+ `prisma migrate deploy` dev DB → verify（Testcontainers migrate deploy）: 6 维 `market_scope` 含 `hk`
- [X] T004 [P] [Server] **currency 按 market**：`sync-universe.usecase.ts` 现 hardcode `currency:'CNY'` → 按 market 取（`cn→CNY` / `hk→HKD`）→ verify（vitest）: hk 标的 upsert `currency='HKD'`、cn 仍 `'CNY'`
- [X] T005 [Server] **backfill `--markets` 真透传**（seam#3）：`marketdata-backfill.cli.ts` `executeBackfill` 把 `args.markets` 织入 job payload → executor 工作集过滤；`estimateRequests` 按 markets 累加 → verify（vitest）: `--markets hk` → payload/估算含 hk、不含 cn（state_branch「回填 --markets 透传」）
- [X] T006 [Server-IT] **Phase 1 集成 IT**（Testcontainers PG，mock adapters）：cn 无回归（`/cn/` 路径 + 工作集含 cn）+ marketScope 过滤 + 未知前缀抛错 + backfill --markets 透传。`apps/server/test/integration/marketdata.hk-038.seam.it.spec.ts`，run via `nx test server <file> --skip-nx-cache`。**覆盖 state_branch**：市场路由 cn 无回归 / hk 路由 / 未知市场前缀 / marketScope 过滤 cn-only / 含 hk / 回填 --markets 透传

---

## Phase 2: US1 港股价量历史底座（universe / profile / eod_bar 扩 HK + HSI 日历 + tiering）

**US1 Independent Test**: Testcontainers PG（mock hk adapters）；① universe hk → `instrument` `market=hk`/`currency=HKD`/pinyin 落库；② profile 富化 `lixingerCompanyType`（含 `reit`）；③ eod_bar hk 区间 → `daily_bar` `market=hk` append skipDuplicates 幂等；④ HSI 交易日 gate；⑤ HSI 成分 → syncTier 提级 tier-0。**hk 价量可回测即达 A 股同等**。

- [X] T007 [US1] [Server] **HSI 交易日历派生**（Clarification Q2）：`lixinger-trading-calendar.adapter.ts` 扩 `market='hk'` 从**恒生指数 HSI via `hk/index/candlestick`** 派生（与 A 股 `000001` 同构）；`trading-day-gate.ts` 已 market-参数化 → hk 门控 → verify（vitest + env-gated 真 Lixinger IT）: hk 日历派生 + 非交易日 skip（**⚠️ impl 首个真实调用确认 HSI 的理杏仁 index code**，research P... 记录）（state_branch「港股交易日历派生」）
- [X] T008 [US1] [Server] **universe 扩 HK**：`sync-universe.usecase.ts` 经 marketScope 处理 hk（Lixinger `hk/company` 全量枚举为主 + 现有 fallback）；HK `listingStatus→active/inactive` 映射（**⚠️ impl 首调确认 HK listingStatus 值域**，plan §Deferred-probes P1；未知值保守 + 原值存档 `listingStatus`）→ verify（Testcontainers PG）: hk 新标的 insert `market=hk`/`HKD`/pinyin/tier 默认 / 既有 upsert 不覆盖 syncTier/lixingerCompanyType / active-only 过滤（state_branch「universe hk 新标的 / 既有 / active-only 边界」）
- [X] T009 [US1] [Server] **profile fsType 富化含 `reit`**：`lixinger-adapter.base.ts resolveFsTypes` + profile 维度接受 HK fsType 值域 `bank/insurance/non/other/reit/security`（比 A 股多 `reit` 房托），路由 hk fundamental/fs 到 `/hk/company/{fundamental,fs}/{fsType}` → verify（vitest + Testcontainers）: reit 标的 `lixingerCompanyType='reit'` + 路由到 `/hk/.../reit`；常规 fsType 同构（state_branch「fsType 路由 hk-reit / hk 常规」）
- [X] T010 [US1] [Server] **eod_bar 扩 HK**：`lixinger-eod-bar.adapter.ts` 经 T002 market 插值拉 hk candlestick（区间 ≤10yr，字段 date/open/close/high/low/volume/amount/change/to_r 与 A 股**完全相同**）；`dimension-executor.ts syncEodBars` 经 marketScope 纳 hk → verify（Testcontainers PG）: hk `daily_bar` `market=hk`/`adjust='none'` append `createMany({skipDuplicates})` + **连跑两次无重复行**（state_branch「eod_bar hk 区间回填」）
- [X] T011 [US1] [Server] **syncTier 分层（HSI/港股通成分提级）**（Clarification Q1）：`sync-tier-recalc.ts` 扩 hk —— HSI/港股通成分标的提级 tier-0 优先、长尾 tier-2 后置；成分来源 = `hk/index/constituents`（p0 catalog 有）或初期 curated 种子（**impl 定**，research D4）→ verify（vitest + Testcontainers）: 成分标的 `syncTier=0`、长尾 `=2`，**全量在市股均纳入**（不缩范围）（state_branch「回填分层排序」）
- [X] T012 [US1] [Server-IT] **US1 集成 IT**（Testcontainers PG，mock hk adapters）：universe→profile→eod_bar hk 贯通落库 + HSI gate + fsType-reit 路由 + tiering。`apps/server/test/integration/marketdata.hk-038.price-base.it.spec.ts`，run via `nx test server <file> --skip-nx-cache`。**覆盖 state_branch**：universe hk 新/既有/active-only / fsType hk-reit/常规 / eod_bar hk 区间 / 分层排序 / 港股交易日历派生

---

## Phase 3: US2 港股基本面/财报/公司行动（per-stock 区间抓取 + 3 维扩 HK）

**US2 Independent Test**: Testcontainers PG（mock hk）；① fundamental per-stock 区间 → `fundamental_snapshot` 多行日频；② financial → `financial_metric` 多期；③ corporate_action → 事件行 + `adjustment_factor` 重锚；④ vendor 字段缺失 → 存 null 不崩。

- [X] T013 [US2] [Server] **fundamental/fs per-stock 区间抓取模式**（seam#4，gap#4 已 p0 验支持）：`lixinger-fundamental.adapter.ts` + `lixinger-financials.adapter.ts` 增区间方法（`{stockCode,startDate,endDate,metricsList}`，**形态照抄 `lixinger-eod-bar.adapter.ts getBars(from,to)`**）；端口层加区间方法或扩现有 query DTO `from/to` → verify（vitest）: 区间请求体正确 + 解析多行（**⚠️ impl 首调确认 hk/ 路径生效**，plan §Deferred-probes P4：文档示例 URL 显 cn/）
- [X] T014 [US2] [Server] **fundamental / financial 扩 HK**：`dimension-executor.ts syncFundamentals`/`syncFinancials` 经 marketScope 纳 hk，用 T013 区间模式回填历史（含 reit fsType 路由）→ verify（Testcontainers PG）: hk `fundamental_snapshot`（`(instrumentId,date)` 多行）+ `financial_metric`（`(instrumentId,reportPeriod)` 多期）upsert；**字段缺失存 null 不崩**（state_branch「fundamental/fs hk 区间回填」「vendor 字段缺失」；plan §Deferred-probes P2：分位字段 hk 可用性首调记录，SC-006 依赖）
- [X] T015 [US2] [Server] **corporate_action 扩 HK + 复权重锚**：`dimension-executor.ts syncCorporateActions` 经 marketScope 纳 hk 分红/拆分/配股 → `upsertCorporateActions` 返最小新 exDate → 触发该 hk 标的 `adjustment_factor` 重锚（沿 020 机制，本地不重算）→ verify（Testcontainers PG）: hk corp-action 落 `(instrumentId,exDate,type)` + 新增触发 factor 重锚（state_branch「corporate_action hk 触发复权」）
- [X] T016 [US2] [Server-IT] **US2 集成 IT**（Testcontainers PG，mock hk）：fundamental/financial/corporate_action hk 区间回填 + factor 重锚 + 字段缺失 null。`apps/server/test/integration/marketdata.hk-038.fundamentals.it.spec.ts`，run via `nx test server <file> --skip-nx-cache`。**覆盖 state_branch**：fundamental/fs hk 区间回填 / corporate_action hk 触发复权 / vendor 字段缺失存 null

---

## Phase 4: US3 保守多夜回填 pacing（自限速 + jitter + 续跑 + dry-run + 串行）

**US3 Independent Test**: Testcontainers PG+Redis；① `backfill --markets hk --dry-run` 估算量级吻合；② 回填期自限速 ~600/min + jitter，不触 429；③ hk 回填 job 与 cn 夜间同步 job 共享 `concurrency=1` 队列 → 天然串行；④ 中断/限额 → 从进度续跑幂等。

- [X] T017 [US3] [Server] **回填自限速 + jitter**（INV-3，不改共享 profile）：backfill 路径叠加自限速目标 ~10/s（~600/min，≈共享 900/min 桶 2/3）+ 调用间随机 jitter（落点：backfill-mode per-call sleep/jitter 或 backfill 专用 limiter 参数，最小侵入，**不改 `lixinger.constraint-profile.ts`**）→ verify（vitest 纯函数）: 自限速节流到目标速率 + jitter 打散（state_branch「回填自限速」）
- [X] T018 [US3] [Server] **分夜续跑 cursor / 幂等**：eod_bar 靠现有 `pendingEodInstruments`（已同步跳过）天然续跑；区间维度（fundamental/fs 历史）加轻量 backfill cursor（记 last-done instrumentId/date）或靠自然键 upsert 幂等续跑 → verify（Testcontainers PG）: 中断后续跑不重复拉取、已同步跳过（state_branch「幂等重跑」「分夜收敛」）
- [X] T019 [US3] [Server-IT] **US3 集成 IT**（Testcontainers PG+Redis）：backfill `--markets hk --dry-run` 估算 + 自限速在目标内无 429 + **共享限流器串行**（hk 回填 job 与 cn 夜同步 job `concurrency=1` 不并发打爆共享桶）+ 续跑幂等。`apps/server/test/integration/marketdata.hk-038.backfill-pacing.it.spec.ts`，run via `nx test server <file> --skip-nx-cache`。**覆盖 state_branch**：回填自限速 / 共享限流器串行 / 幂等重跑

---

## Phase 5: Verify 全绿门 + 端到端真数据

- [X] T020 [Verify] **全绿门 + 端到端 hk 真数据**：`nx affected -t lint typecheck test build --base=origin/main` 全绿（`--skip-nx-cache` 首跑）+ `check-server-moat.ts` 关（无新表/新 owner，确认）+ **SC-001/003 端到端**：本地 `MARKETDATA_PROVIDER=live` + `LIXINGER_TOKEN` 跑**缩减集**（3-5 只 hk 含 REIT 如 `hk:00823` 领展 backfill）→ 验 015 读端点（quote/detail/bars）返 hk **真数据**（非 fixtures）+ 抽样核对理杏仁网站一致；回写 plan §Deferred-probes（P1 listingStatus / P2 分位 / P4 hk 路径）+ 必要时修 spec SC。**⚠️ 全 10yr×全量回填 = 后续 ops（master INV-3 保守多夜 ~2-3 周），非本 PR 范围**
  - **本 PR 完成度**：**全绿门 PASS ✓**（lint/typecheck/build/moat 全绿；server 2313 tests 绿含全部 marketdata Testcontainers IT；T003 migration 干净无 drift）。**live hk 真数据 smoke + 4 个 deferred-probe（HSI index code / P1 listingStatus / P2 分位 / P4 hk 路径）的真实确认 → 委托 ops 回填首夜 supervised 完成**（per 用户 2026-07-12 决策 + master INV-3「保守多夜回填」本就 supervised）；impl 侧已用具名常量默认值 + `// DEFERRED-PROBE` 代码标注就位，首夜真调如有偏差走跟进小 PR。

---

## Dependencies & 执行顺序

```
Phase 1 平台缝隙（T001 marketScope → T002 路径插值[P] / T003 migration / T004 currency[P] / T005 backfill markets → T006 IT）
  ↓（seam 是所有维度扩 HK 的前置；mock+cn 先绿=A股无回归）
Phase 2 US1 价量（T007 HSI 日历 / T008 universe → T009 profile-reit → T010 eod_bar → T011 tiering → T012 IT）
  ↓（universe/profile 是 fundamental/fs 的前置：fsType 路由源）
Phase 3 US2 基本面财报（T013 区间抓取模式 → T014 fund/fin → T015 corp-action → T016 IT）
  ↓
Phase 4 US3 回填 pacing（T017 自限速 / T018 续跑 → T019 IT）
  ↓
Phase 5（T020 全绿门 + 端到端）
```

- **Phase 1 是硬前置**（seam 未激活则 hk 无从进入工作集/adapter）；Phase 2 hard-依赖 Phase 1；Phase 3 依赖 Phase 2（profile fsType 路由源）；Phase 4/5 依赖前序。
- **Phase 内 `[P]`** 可并行（如 T002 路径插值与 T004 currency 不同文件）。
- **MVP scope** = Phase 1 + Phase 2（平台激活 + hk 价量落库即「港股价格可回测」，可手动触发验证）；Phase 3 加因子数据、Phase 4 让回填安全温和。

## 单 PR vs 增量拆分（可选）

**默认单 PR**（Constitution §V）。若偏好增量隔离回归风险，task 边界已对齐 2 PR：
| PR | Task | 说明 |
| --- | --- | --- |
| PR-A（可选先行）| T001–T006 | 纯平台 seam 重构，mock+cn 全绿=A股无回归，不依赖订阅 → 先 merge 验稳 |
| PR-B | T007–T020 | 扩 HK 6 维 + 回填 pacing + 端到端 |
