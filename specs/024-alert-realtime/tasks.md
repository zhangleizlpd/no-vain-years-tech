---
feature_id: 024-alert-realtime
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-08'
---

# Tasks: 024-alert-realtime（实时盘中预警 — 5min tick 双模求值 + 双源热备实时源）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `024-alert-realtime` | **设计源**: [p2 子 plan](../../docs/private/plans/2026-06/06-07-alert-indicator-p2-realtime.md)（数据源 PoC 复验 2026-06-08）

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）；`[USx]` = user-story 阶段 task 带；层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Verify]`
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；纯函数（meta/validation/realtime-quote/evaluation rules）= vitest 无 DB；UC 读写 DB 单测走 **Testcontainers PG**（`nx test server <file>`，cwd=apps/server）；mobile 纯逻辑 = vitest，UI·render·a11y = Playwright Expo Web e2e
- 无 task-meta JSON（**manual 模式**，per 004-023）
- 🚨 **024 = 021 alert ctx 增量但引入首个外部 IO adapter**（plan D2）：实时行情 port + adapter **物理落 alert ctx**（不 import marketdata，规避叶子 ctx 越界）；复用 `VendorHttpClient` + `FallbackChainAdapter` 范式（ADR-0047）。**零新表 / 零新 queue（挂 021 `alert-eval`）/ 零 migration**（5min 条件复用 `{type,threshold,param}` shape；判重复用 `AlertTrigger @@unique([alertId,tradeDate])`，plan D6 代码核实）
- 🚨 **跨 ctx 读交易日历**：intraday 交易时段 gate 读 `trading_day`（marketdata 表）= Q7-B 直查，`prisma.tradingDay.find*` 上方**必须** `// CROSS-CONTEXT-READ:` 注释（moat 探针拒）；跨 ctx 写永远禁
- 🚨 **021/023 零回归（FR：021/023 既有断言全保留）**：EOD 引擎 / rules / IT / e2e 不改；intraday UC 与 EOD UC 共用 `evaluateAlertConditions` 纯函数但独立入口
- 🚨 **双源口径一致前提（master 跨契约 / ADR-0047 §6）**：腾讯/新浪均为现价同口径（PoC 对拍一致），故双源热备可静默切换；新浪涨跌幅自算 `(现价-昨收)/昨收`、腾讯直给——口径收敛在 `realtime-quote.rules.ts` 纯函数
- **三段式 PR（per plan §Phase 2）**：**PR-1 = Server 契约面**（T001–T005）→ **PR-2 = Server 实时引擎**（T006–T013）→ **PR-3 = Mobile**（T014–T018）

## Path Conventions

- server：`apps/server/src/alert/`（021 既有 module 扩展）；**无 schema/migration 改动**；IT `apps/server/test/integration/*.it.spec.ts`
- contract：`apps/server/openapi.json`（`nx run server:export-openapi`，canonical `node dist/main.js`）→ `packages/api-client/`（Orval `nx affected -t generate`）
- mobile：`apps/mobile/src/alert/`（021/023 既有 feature dir 增量）；routes 不变；`~/theme`/`~/ui` 零新库
- e2e：`apps/mobile/e2e/`（mock alert 8 端点 + 015 EP2 + 003 refresh per memory）；contract-smoke `apps/mobile/e2e/contract-smoke/alert-realtime.contract.ts`
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait`（:5433/:6380）；**本地 server IT/smoke 前 `env -u OSS_*`**
- vendor 实测：env-gated IT 沿用 `RUN_PERF_IT` 范式，默认 skip（CI 不打外网）

---

## Phase 1: Server 契约面 — 词表 +2 + intradayEligible 元数据（PR-1）

**Goal**：34 词表（+2 盘中 5min 类）可建可改可校验，api-client regen 落地（实时引擎未上前新条件 EOD 轮不命中 = 防御语义天然覆盖，PR 描述 flag）。

- [X] T001 [Server] **词表 +2 + intradayEligible**：`apps/server/src/alert/alert-condition-meta.ts` 加 `PRICE_RISE_5MIN_OVER` / `PRICE_FALL_5MIN_OVER`（kind=threshold、param 白名单={0}、threshold 值域=(0,100]、单位=%）+ 给全 34 type 加 `intradayEligible: boolean` 字段（`true` 仅 `PRICE_RISE_TO`/`PRICE_FALL_TO`/2 新 type，其余 30 为 `false`，plan §词表标记）+ meta 自洽 vitest 扩展（34 完整性 / intradayEligible 集合断言 / 2 新 type 白名单）。**验**：021/023 既有 32 type 形态零变化
- [X] T002 [P] [US2] [Server] **校验纯函数扩展**：`apps/server/src/alert/alert-validation.rules.ts` 红绿扩展（2 新 type ∈ 34 词表 / threshold ∈ (0,100] / param 必须 0 / 重复键 `(type,param)` 沿用 / 1..4 与 021 规则全保留）→ 400 ProblemDetail；021/023 既有 spec 断言不改
- [X] T003 [US2] [Server] **DTO/swagger + CRUD 接线**：condition request/response DTO type 枚举 +2 + message snapshot DTO 扩 `priceContext?: 'intraday'|'eod'`（plan D7）+ create/update UC 接 T002 校验 + **Testcontainers 单测**：建「5min 涨超 3%」/「5min 跌超 5%」回显 / 与到价类同 alert 共存 / threshold 出域(>100) 400 / param 带非 0 400 / 021 旧 shape 向后兼容
- [X] T004 [US2] [Server-IT] `apps/server/test/integration/alert-realtime-crud.it.spec.ts`（全 boot）：建含 5min 类 + 到价类混合预警 → EP1/EP2 回显 → 编辑改 threshold → 删除；021/023 既有 CRUD IT **零改动跑绿**
- [X] T005 [Contract] [Verify] `nx run server:export-openapi`（canonical `node dist/main.js`）→ `nx affected -t generate`（Orval regen：type 枚举 +2 + snapshot priceContext）→ mobile typecheck 绿 → **PR-1 gate**：`nx affected -t lint typecheck test build runtime-smoke --base=origin/main`（首跑 `--skip-nx-cache`）全绿 + moat/boundaries 0 violation + spec `status: implementing` 翻

---

## Phase 2: Server 实时引擎 — 双源 adapter + tick 调度 + 双模求值（PR-2）

**Goal**：盘中 5min tick 在交易时段拉实时价、到价类即时判定 + 5min 差分判定、命中即推送，源熔断降级 EOD-only 自动回升。spec 8 条 state_branches 全覆盖。

- [X] T006 [US1] [Server] **实时行情解析纯函数**：T0 确认 `VendorHttpClient` 导出位置（`apps/server/src/marketdata/` or 共享 infra；若非共享则镜像范式落 alert）→ 新建 `apps/server/src/alert/realtime-quote.rules.ts`（GBK 解码 + 腾讯 `~` 分隔字段对齐（现价 idx3）/ 新浪逗号分隔（现价 idx3、昨收 idx2、需 Referer）+ 涨跌幅口径收敛（腾讯直给 / 新浪自算）+ 无效码静默省略对齐）+ vitest 红绿（**锚 PoC §5.1 真实响应样本**：腾讯/新浪固定字节串解析 + GBK 中文名 + 缺标的略过）
- [X] T007 [US1] [Server] **双源 adapter + FallbackChain**：`realtime-quote.port.ts`（`fetchQuotes(codes): Promise<Map<code, {price, prevClose, changePct}>>`）+ `tencent-realtime.adapter.ts`（主，批量 q=）+ `sina-realtime.adapter.ts`（备，注入 `Referer: https://finance.sina.com.cn`）+ `RealtimeQuoteFallbackChainAdapter` 编排（腾讯 200+schema 校验过即返，否则新浪，均败抛）+ vitest（主成功不触备 / 主败切备 / 双败抛 / schema 不过当失败）。**D2 轻量决策（user 定）**：不镜像 marketdata `VendorHttpClient` 的 cockatiel client，改 `realtime-fetch.ts` 轻量 `fetch`+timeout（取 GBK arraybuffer）；重试/熔断单层下沉 T008 Redis failstreak，避免双层熔断（理由进 T012 D8 ADR）
- [X] T008 [US1] [Server] **intraday tick 调度 + 交易时段 gate + 熔断**：`intraday-eval.processor.ts` 挂 021 `alert-eval` queue 加 `*/5 * * * *` repeatable（payload `triggeredBy:'intraday-cron'`，plan D1）+ 起手交易时段 gate（`// CROSS-CONTEXT-READ:` 读 `trading_day` cn 当日 + 盘中窗口 09:30-11:30/13:00-15:00 Asia/Shanghai，非交易时段 return）+ 熔断（Redis `failstreak`/`circuit`：连续 3 失败 open→降级 EOD-only，成功 reset+close 回升，warn 留痕，plan D4）+ Testcontainers/Redis 单测（非交易时段 0 源调用 / 连续 3 失败置 open / 恢复回升）
- [X] T009 [US1] [Server] **盘中求值 UC**：`evaluate-intraday-alerts.usecase.ts`——load 启用预警 → 按 `intradayEligible` 派生拉取集去重（plan D5）→ 调 port 批量取价 → 到价类喂实时价到 `EvaluationInputs`（`evaluateAlertConditions` **零改**即即时语义）→ 命中走 021 同款触发 tx（create `AlertTrigger` + `priceContext:'intraday'` 快照 + 022 push fan-out PENDING）→ 判重撞 `@@unique([alertId,tradeDate])` P2002 catch-skip（plan D6）+ Testcontainers 单测（到价命中触发+推送入队 / 盘中触发后同日再 tick 幂等 skip / 拉取集排除纯 EOD 预警标的）
- [X] T010 [US2] [Server] **5min 差分求值 + conditionDataNeed 'realtime'**：`alert-evaluation.rules.ts` 加 5min 涨超/跌超差分分支（`(now-prevTick)/prevTick` 按方向）+ `conditionDataNeed` 加 `'realtime'` 分支（**仅 2 新 5min 类**——到价类仍归 `noneBar`，盘中由 UC 把实时价喂入 noneBar 单点，T009 零改+绿；conditionDataNeed 保数据源 1:1 映射 + 021 零回归）+ Redis 上一 tick 快照 `alert:intraday:lasttick:{tradeDate}` hash（field=vendor 符号，非 instrumentId——保 UC 零 marketdata 读）读写接入 T009（首 tick 无键 → 差分类跳过不误触发，plan D3/D4）+ vitest（涨超命中/跌超命中/未达不命中/首 tick 跳过/方向区分 + UC 两 tick 链路）
- [X] T011 [US1] [US2] [US3] [Server-IT] `apps/server/test/integration/alert-realtime-eval.it.spec.ts`（全 boot + mock port）：spec **8 条 state_branches 全覆盖**（交易时段命中触发+推送 / 未命中记快照 / 非交易时段空转 / 盘中→EOD 判重 skip / 连续 3 失败熔断降级 / 恢复回升 / 首 tick 差分跳过 / 缺标的不命中）+ **SC-005 perf 断言**（mock port 喂 ~百级（200）启用预警标的 → 单 tick 端到端求值（取数 mock + 派生拉取集 + 纯函数求值 + 触发派发）计时 **< 30s**，env-gated `RUN_PERF_IT` + `PERF_IT_REPS` 默认 skip，per memory perf-IT 范式）+ **021/023 零回归**（EOD `alert-*-eval.it.spec.ts` 全保留跑绿）
- [X] T012 [Server-IT] **env-gated 真实源 IT + ADR**：`apps/server/test/integration/realtime-quote-vendor.it.spec.ts`（`RUN_PERF_IT` gate 默认 skip）真实请求腾讯/新浪验字段·批量·延迟·双源切换；+ 落短 ADR `docs/adr/0054-alert-self-hosted-external-io-adapter.md`（plan D8：alert 自持外部 IO adapter 边界策略 + 判据）+ adr-index/frontmatter 过
- [X] T013 [Verify] PR-2 gate：`nx affected -t lint typecheck test build runtime-smoke --base=origin/main`（首跑 `--skip-nx-cache`）全绿 + moat（`CROSS-CONTEXT-READ` 注释齐）/boundaries 0 violation + 021/023 IT 零回归确认

---

## Phase 3: Mobile — 条件库 +2 类 + 盘中价正文（PR-3）

**Goal**：用户能在添加条件页加「5 分钟涨超/跌超」，消息正文区分「盘中价」口径。

- [X] T014 [US2] [Mobile] **copy/meta + draft**：⚠️ **meta 镜像子部分已于 PR-1（T005 decision-A）落地**——`alert-copy.ts` `ALERT_CONDITION_META` +2 词表（percent/无参/价格分类）+ 摘要（meta 驱动 `formatConditionLine` 自动出「5分钟涨超 3.00%」）已绿；本 task **剩余** = 消息正文 `priceContext==='intraday'` 加「盘中价」前缀（旧消息缺字段走 EOD 兜底）+ `use-alert-draft.ts`（枚举扩展，键仍 `(type,param)` param=0）+ vitest（draft 键 / 盘中价正文 / 旧消息兜底）。**原因**：alert-copy.ts 自 023 PR-3 起对 api-client 枚举做穷举 `Record`，PR-1 regen +2 即逼 mobile typecheck，故 meta 镜像必须随 regen 同 PR（023 PR-1 时该穷举表尚不存在故未撞）
- [X] T015 [US1] [US2] [Mobile] **add-condition 2 条目**：`add-condition-screen.tsx` 2 新条目入「价格」分类（023 4 分类 rail 零结构改）+ 复用 `value-input-sheet` 纯阈值变体（百分比输入）+ 跨类搜索命中；既有 023 选择器/参数 sheet 不改
- [X] T016 [US2] [Mobile-E2E] `apps/mobile/e2e/` hermetic：建「5 分钟涨超 3%」预警全流程（添加条件页选条目→输阈值→保存→列表回显），mock alert 8 端点 + 003 refresh；021/023 既有 e2e 零改
- [X] T017 [Contract-Smoke] `apps/mobile/e2e/contract-smoke/alert-realtime.contract.ts`（`nx run mobile:contract-smoke`，testcontainers 真 server，**`env -u OSS_*`**）：登录 → 建「5min 涨超 3%」+ 到价类混合预警 → 列表/编辑回显 → 改 threshold → 删除（验契约对齐 + 真落库）
- [X] T018 [Verify] PR-3 gate：`nx affected -t lint typecheck test build --base=origin/main`（首跑 `--skip-nx-cache`）+ mobile e2e/contract-smoke 绿 + 021/023 零回归 + spec `status: implemented` 翻

---

## Dependencies & 顺序

```text
PR-1（T001-T005，契约面）──► PR-2（T006-T013，实时引擎）──► PR-3（T014-T018，mobile）
  词表+校验+regen 先 merge      依赖 PR-1 词表/contract       依赖 PR-2 真后端 + PR-1 typed client
```

- **PR 内并行**：T002（validation）与 T001（meta）弱依赖（T002 用 T001 词表，串行）；PR-2 内 T006（解析纯函数）→ T007（adapter）→ T008/T009/T010（调度/UC/求值，部分并行）→ T011（IT 收口）；PR-3 T014（逻辑）∥ 可先于 T015（UI）
- **跨 PR 严格串行**：契约未 ship 不开实时引擎；实时引擎未 ship（真后端）不开 contract-smoke

## Independent Test 标准

- **US1（盘中即时到价）**：mock port 喂实时价 ≥ 阈值 → 一 tick 内触发 + 推送入队；非交易时段 0 源调用（T009/T011）
- **US2（5min 涨跌幅）**：相邻 tick 差分达阈值触发、首 tick 不误触发、方向区分（T010/T011/T016）
- **US3（熔断降级）**：连续 3 失败降级 EOD-only、恢复回升、预警不丢（T008/T011）

## MVP

PR-1 + PR-2 的 US1（盘中到价 + tick 调度 + 双源 + 熔断）= 最小可用盘中预警；US2（5min）/PR-3（mobile UI）为增量。

## 估计

**18 task**（PR-1 ×5 / PR-2 ×8 / PR-3 ×5），每 task 30min-2h 可单独 commit。零 migration / 零新表 / 零新 queue。
