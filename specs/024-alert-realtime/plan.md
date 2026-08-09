---
feature_id: 024-alert-realtime
spec_ref: ./spec.md
status: drafted
created_at: '2026-06-08'
updated_at: '2026-06-08'
adr_refs: ['0024', '0032', '0043', '0047', '0052']
context7_verified: []
---

# Implementation Plan: 024-alert-realtime（实时盘中预警 — 5min tick 双模求值 + 双源热备实时源）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `024-alert-realtime` | **设计源**: [p2 子 plan](../../docs/private/plans/2026-06/06-07-alert-indicator-p2-realtime.md) + [master](../../docs/private/plans/2026-06/06-07-alert-indicator-master.md)（数据源 PoC 复验定稿 2026-06-08）

> 手动模式（不用 orchestrator）→ 本 plan 无 `orchestrator_config` 块（对齐 011-023）。
> 标准 SDD 流程：spec ✅ → clarify ✅（2026-06-08 4Q）→ **plan（本）** → tasks → implement。
> **⚠ 头号架构事实**：024 是 021 alert ctx 的**增量**，但引入 alert ctx 第一个**外部 IO adapter**（实时行情源）。三个新面：① alert 自持实时行情 port + 双源 adapter（腾讯主/新浪备，复用 `VendorHttpClient` + `FallbackChainAdapter` 范式 ADR-0047，但**物理落 alert ctx**——镜像 021 alert 自持 queue 的先例，避免 alert→marketdata 越界）② intraday repeatable tick（5min，交易时段 gate）挂 021 既有 `alert-eval` queue ③ 双模求值（021/023 已在 `evaluate-alerts.usecase.ts` docstring 预留「盘中模式换实时 tick 喂同形 inputs，求值零改」seam）。

## Summary _(mandatory)_

024 = 021/023 EOD 引擎之上加**盘中实时口径**：**① 词表 +2**（`PRICE_RISE_5MIN_OVER` / `PRICE_FALL_5MIN_OVER`，复用既有 `{type, threshold, param}` shape——**零 migration**）→ **② 实时行情源**（alert ctx 内 `RealtimeQuotePort` + 腾讯/新浪双源热备 adapter，GBK 解码 + Referer 注入 + 涨跌幅口径差异收敛）→ **③ intraday tick 调度**（`alert-eval` queue 加 5min repeatable + 交易时段 gate，复用 021 调度自治 ADR-0052）→ **④ 双模求值扩展**（`conditionDataNeed` 加 `'realtime'` 分支 + 到价类喂实时价即时判定 + 5min 涨跌幅相邻 tick 差分 + 熔断降级 EOD-only）→ **⑤ mobile 条件库 +2 类**（复用 023 的 4 分类选择器 + 参数 sheet）。

- **server 段（主体）**：`apps/server/src/alert/` 内新增 `realtime-quote.port.ts` + `tencent-realtime.adapter.ts` + `sina-realtime.adapter.ts`（双源 FallbackChain）+ `realtime-quote.rules.ts`（GBK 解析/字段对齐纯函数）+ `intraday-eval.processor.ts`（5min tick + 交易时段 gate + 熔断）+ `evaluate-intraday-alerts.usecase.ts`（盘中求值入口，复用 `evaluateAlertConditions` 纯函数）；扩展 `alert-condition-meta.ts`（+2 词表）/ `alert-validation.rules.ts` / `alert-evaluation.rules.ts`（`'realtime'` need + 5min 求值）。**端点路径/方法零变化**，仅 conditions DTO 词表扩展。
- **mobile 段**：`apps/mobile/src/alert/` 改 `alert-condition-meta` 镜像 +2 词表 + `add-condition-screen`（2 新条目入价格分类）+ `value-input-sheet`（复用纯阈值变体）+ `alert-copy`（文案/摘要/盘中价正文标注）。

**新基础设施**：零新表（复用 `AlertTrigger` / `AlertCondition`）/ 零新 queue（挂 021 `alert-eval`）/ 零新 token（jpush 沿用 022）；**新增** = alert ctx 第一个 vendor HTTP adapter + 1 个 Redis 结构（上一 tick 快照 + 熔断计数）。

## API Contracts _(mandatory)_

**8 个端点（EP1-EP8）路径 / 方法 / Auth / 限流桶全部沿用 021/023 不变**。本 feature 仅扩展 conditions 词表（向后兼容）：

| 契约面 | 023 现状 | 024 扩展 | trace FR |
| --- | --- | --- | --- |
| `type` 词表 | 32 值 | **34 值**（+`PRICE_RISE_5MIN_OVER` / `PRICE_FALL_5MIN_OVER`） | FR-003, FR-008 |
| `conditions[]` item | `{type, threshold?, param?}` | 同 shape（5min 类：threshold=百分比 ∈ (0,100]、param=0、无新字段） | FR-003 |
| Message `conditions[]` snapshot | `{type, param?, threshold?, actual, dataDate?}` | +`priceContext?: 'intraday' \| 'eod'`（盘中触发标「盘中价」，FR-007；旧消息缺字段 → mobile 按 EOD 路径兜底） | FR-007 |

- **校验扩展（`alert-validation.rules.ts`）**：2 新 type ∈ 34 词表；threshold ∈ (0,100]；param 必须 0（无参类型）；重复键沿用 `(type, param)`；1..4 条件数与其余 021 规则不变。违规 → 400 ProblemDetail。
- **同步链**：PR-1 swagger 扩展 → `export-openapi` → api-client regen（词表枚举扩展，无 nullable 新增）。
- **perf SoT** = spec frontmatter `perf_budgets`（CRUD 不变；tick 求值非端点，SC-005 表达）。

## 词表 SoT（34 type，`alert-condition-meta.ts` 单源——server 校验/求值 / mobile 文案三处共享）

| 组 | type |
| --- | --- |
| 021/023 既有 ×32 | 见 [023 plan § 词表 SoT](../023-alert-eod-indicators/plan.md)（023 实际 32 type，plan 标题「26」为算术笔误，以 `alert-condition-meta.ts` 枚举为准） |
| **024 盘中实时 ×2** | `PRICE_RISE_5MIN_OVER`（5 分钟涨超 threshold%，param=0）`PRICE_FALL_5MIN_OVER`（5 分钟跌超 threshold%，param=0） |

> **盘中可判定标记**：`alert-condition-meta` 为每 type 加 `intradayEligible: boolean` 元数据——`true` 仅 `PRICE_RISE_TO` / `PRICE_FALL_TO`（到价类盘中升级）+ 上述 2 新 type；其余 24 类 `false`（维持 EOD-only，Clarify Q1）。该标记驱动 D5 拉取集派生 + D3 双模分流。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则 | 状态 | 备注 |
| --- | --- | --- |
| I. SDD（NON-NEGOTIABLE） | ✅ | spec ✅ → clarify ✅ → plan（本）→ tasks → analyze → implement |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ | 实时解析纯函数 vitest 红绿（GBK/字段对齐固定样本，PoC 留痕真实响应）；双模求值/5min 差分/熔断走 rules + UC spec；IT 覆盖 spec `state_branches` 全 8 条（交易时段 gate / 盘中→EOD 判重 / 熔断降级回升 / 首 tick 跳过 / 缺数据不命中） |
| III. Atomic 30min-2h + 独立 commit | ✅ | 三段式 PR（见 § Phase 2），tasks 按 30min-2h 拆 |
| IV. Module Boundary（扁平 + 贫血 + 护城河 + 单向） | ✅ | 零新 ctx；alert 仍叶子；实时 adapter **物理落 alert ctx**（不 import marketdata，规避越界——D2）；vendor HTTP 复用 `VendorHttpClient` 共享 infra（ADR-0047 范式） |
| V. 类型同步链 Nx-driven | ✅ | PR-1 ship 词表扩展 + api-client regen 先 merge；PR-3 mobile 消费 typed client |

## Architecture Notes _(mandatory)_

### D1：intraday tick 调度 = `alert-eval` queue 加 5min repeatable + 交易时段 in-job gate（沿用 ADR-0052 调度自治）

021 已建 alert 自持 `alert-eval` queue + `upsertJobScheduler` 两 tick（`0 23` 主 + `0 8` catch-up）。024 加**第三个 repeatable**：`*/5 * * * *`（每 5min，全天注册）payload `triggeredBy: 'intraday-cron'`，**交易时段 gate 在 job 内**（非 cron 表达式）——`intraday-eval.processor.ts` 起手判 `TradingDay`（cn 市场）+ 盘中窗口（09:30-11:30 / 13:00-15:00 Asia/Shanghai）：非交易时段直接 return（FR-002，SC-003 源调用 0）。job opts `attempts: 1`（幂等键兜重试）。

- **为何 in-job gate 而非 cron 限时**：午休/节假日无法用单条 cron 表达式干净表达；in-job 判定与 021 EOD tick 的市场日历逻辑同源，且便于 SC-003 断言（非交易时段 0 外部请求）。
- **worker 拓扑**：沿用 021 `ALERT_WORKER_DISABLED` sentinel——全局唯一 worker 在 server 进程，CLI 不消费。

### D2：实时行情 adapter 落点 = **alert ctx 自持**（不 import marketdata）

> **决策路径（catalog 7Q 复评）**：实时行情拉取是 IO adapter（非纯函数），无法走 023 D1 的「alert→marketdata `*.rules.ts` 纯函数 import」逃生口。三选——(a) 落 marketdata ctx 出 port，alert DI 注入 = 破坏 alert 叶子 ctx（ADR-0052），且 marketdata 现状纯 EOD 同步、无实时面，为单一消费者引入实时面是反向扩底座；(b) 新建 realtime bounded context = 单 feature 单消费者，过度（ADR-0032 sunset trigger 不满足）；(c) **alert ctx 自持实时行情 port + adapter**——镜像 021「alert 自持 queue/Redis 连接而不 import marketdata」的既定先例，复用 `VendorHttpClient` + `FallbackChainAdapter` 共享 infra 范式（ADR-0047，与 marketdata 的东财 adapter 同范式不同实例）。**取 (c)**。
> **物理落点**：`apps/server/src/alert/realtime-quote.port.ts`（接口）+ `tencent-realtime.adapter.ts`（主）+ `sina-realtime.adapter.ts`（备）+ `realtime-quote.rules.ts`（GBK 解析 / `~`、逗号分隔字段对齐 / 涨跌幅口径收敛——腾讯直给 vs 新浪 `(现价-昨收)/昨收` 自算，纯函数）。双源经 `FallbackChainAdapter` 编排：腾讯 200 即返，失败/schema 校验不过 → 新浪（注入 `Referer`），均失败 → 抛供熔断计数。
> **future seam**：若日后 marketdata 需实时面（如盘中行情展示），再抽 port 上提 marketdata + alert 反向 DI；本期单消费者不预先抽象。

### D3：双模求值 = `conditionDataNeed` 加 `'realtime'` 分支 + 求值纯函数零改（到价类）/ 小增（5min）

021/023 `evaluate-alerts.usecase.ts` docstring 已预留双模 seam。024 落地：

1. `conditionDataNeed(type)` 现 `'noneBar'|'forwardBars'|'fundamental'` → 加 **`'realtime'`**（到价类盘中 + 2 新 type）。EOD UC 不变（盘中 type 在 EOD 轮按 `intradayEligible` 仍可 EOD 兜底求值——到价类 EOD 用收盘价、5min 类 EOD 无意义跳过）。
2. 新 `evaluate-intraday-alerts.usecase.ts`：load 启用预警 → **按 `intradayEligible` 过滤拉取集**（D5）→ 调实时源批量取价 → 组 `EvaluationInputs`（到价类：实时价喂 `EodBarSnapshot.close` 位 → `evaluateAlertConditions` **零改**即即时语义；5min 类：实时价 + 上一 tick 价 → 新差分求值分支）→ 命中走 021 同款触发 tx（`AlertTrigger` 快照 + 022 push fan-out）。
3. **5min 差分求值**（`alert-evaluation.rules.ts` 加分支）：`(price_now - price_prevTick) / price_prevTick`；涨超/跌超按方向（FR-003）；上一 tick 价缺失（首 tick / 重启）→ 不命中（FR-003 防御，与 021「数据缺失不命中」一致）。

### D4：上一 tick 快照 + 熔断计数 = Redis（盘中态，日终自然失效）

- **上一 tick 快照**（5min 差分依赖）：Redis hash `alert:intraday:lasttick:{tradeDate}` = `{instrumentId: price}`，每 tick 求值后覆写；首 tick 无键 → 差分类跳过（D3.3）。TTL 设当日收盘后过期（或 key 带 tradeDate 自然换日作废）。
- **熔断计数**（FR-006）：Redis counter `alert:intraday:failstreak`——连续失败 +1、成功 reset 0；≥**3**（Clarify）→ 置熔断态 `alert:intraday:circuit=open`，intraday tick 起手见 open 直接 return（降级 EOD-only，预警延迟不丢）；下一 tick 仍探测一次实时源，成功 → reset + close（自动回升，FR-006）。降级/回升 `logger.warn` 留痕（SC-004 可检出）。

### D5：实时拉取集 = `intradayEligible` 条件派生（FR-001a）

拉取集 = `alert.findMany({where:{enabled:true}, include:{conditions:true}})` → filter 「∃ condition.type 的 `intradayEligible===true`」→ 取其 (market, code) 去重。纯 EOD 条件预警标的不进 tick（最小请求集，SC-003/容量）。腾讯单请求 ≤600 只（PoC 实测）一发装下自用规模几十~几百只（容量论证见 p2 §2）。

### D6：判重 = 复用 `AlertTrigger @@unique([alertId, tradeDate])`，**零 schema 改动**（spec 假设验证 = 真）

代码核实：`AlertTrigger` 现有 `@@unique([alertId, tradeDate], map: "uk_alert_trigger_alert_tradedate")` + `evaluate-alerts.usecase.ts` P2002 catch-skip。盘中触发先 create `AlertTrigger`（同 alertId/tradeDate），当日 EOD 轮再触发撞唯一键 → P2002 catch-skip 幂等。**spec「预期无需 schema 改动」经代码确认成立**——盘中/EOD 共用同一 trigger 行，priceContext 标注盘中价（D7）。

### D7：推送口径标注（FR-007）

`AlertTrigger.conditionsSnapshot` Json 扩 `priceContext: 'intraday'`（盘中）；022 push copy（`alert-push-copy.rules.ts`）+ mobile 正文渲染加「盘中价」前缀。旧 EOD 触发无该字段 → 默认 'eod' 路径（向后兼容）。

### Mobile side（`apps/mobile/src/alert/` 增量，复用 023 选择器）

- `alert-condition-meta`（mobile 镜像）：+2 词表 + `intradayEligible` 标记 + 文案。
- `add-condition-screen.tsx`：2 新条目入「价格」分类（023 已有 4 分类 rail，零结构改）；纯阈值条件复用既有 `value-input-sheet` 纯阈值变体（百分比输入）。
- `alert-copy.ts`：「5 分钟涨超 3%」「5 分钟跌超 5%」摘要 + 消息正文「盘中价」标注（`priceContext==='intraday'`）。
- `use-alert-draft.ts`：词表枚举扩展（键仍 `(type, param)`，param=0）。
- 既有 021/023 e2e 不改（FR：021/023 零回归）。

### Cross-cutting

- **021/023 零回归**：EOD 引擎 / rules / IT 断言全保留；新增 intraday UC 与 EOD UC 共用 `evaluateAlertConditions` 纯函数但独立入口；mobile 既有 e2e 不改。
- **数据源 PoC 已复验**（p2 §5.1，2026-06-08）：腾讯/新浪字段·批量·延迟·封禁特性实测定稿；本 plan 不重跑，PR-2 落 env-gated IT（`RUN_PERF_IT`）做真实请求 + 连续稳定性观察。
- **boundaries / moat**：零新 ctx；alert 仍叶子（实时 adapter 自持不越界）；vendor HTTP 复用 `VendorHttpClient`（如其在 security/common 共享 infra 则直用，否则镜像范式落 alert——T0 确认其导出位置）。

## Open Decisions Resolved（⚠️ 标注项请 plan→tasks gate review）

| # | 决策 | 结论 | gate? |
| --- | --- | --- | --- |
| **D1** | intraday tick 调度落点 | `alert-eval` queue 加 `*/5` repeatable + 交易时段 in-job gate（ADR-0052 自治沿用） | ✅ 默认接受 |
| **D2** | 实时 adapter 落点 | **alert ctx 自持** port + 腾讯/新浪双源 adapter（复用 `VendorHttpClient`+FallbackChain ADR-0047），不 import marketdata | ⚠️ 请 review（alert ctx 首个外部 IO adapter） |
| **D3** | 双模求值 | `conditionDataNeed` 加 `'realtime'`；到价类喂实时价零改、5min 类加差分分支 | ⚠️ 请 review |
| **D4** | tick 快照 + 熔断态 | Redis（`lasttick:{tradeDate}` hash + `failstreak`/`circuit` counter）；连续 3 失败降级、自动回升 | ✅ 默认接受 |
| **D5** | 实时拉取集 | `intradayEligible` 条件派生，纯 EOD 标的不进 tick | ✅ 默认接受 |
| **D6** | 判重 schema | **零 schema 改动**——复用 `AlertTrigger @@unique([alertId,tradeDate])` + P2002 catch-skip（代码核实） | ✅ 默认接受 |
| **D7** | 盘中价标注 | `conditionsSnapshot.priceContext` 扩展，向后兼容 | ✅ 默认接受 |
| **D8** | 是否需新 ADR | D2「alert 自持外部 IO adapter」边界新形态——建议**随 PR-2 落一条短 ADR**（alert ctx 外部源自持策略，判据：单消费者 + 底座无该面 + 复用 VendorHttpClient 范式才放行） | ⚠️ 请 review |

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| — | — | — |

**Note**：(1) 唯一新边界形态 = alert ctx 自持外部 IO adapter（D2）——比落 marketdata（破叶子 ctx）/ 新建 realtime ctx（过度）都简单，ADR（D8）钉判据防滥用。(2) 双模求值复用既有纯函数 seam，求值核心零改（到价类）。(3) 零 migration / 零新表 / 零新 queue。(4) mobile 纯词表 +2 增量。

## Performance Budget

| 面 | 目标 |
| --- | --- |
| CRUD 端点 | 021/023 预算不变 |
| intraday tick 单轮 | SC-005：百级标的 ≤30s（实测：1 次腾讯批量请求秒级 + O(n) 纯函数微秒级，余量 ≥1 数量级） |

_SoT = spec frontmatter `perf_budgets`。tick 求值非端点，时延以 SC-005 表达。_

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略建议（plan→tasks gate review）

**三段式 PR**（021/023 同构）：

- **PR-1（server 契约面，feat(alert)）**：`alert-condition-meta` +2 词表 + `intradayEligible` 元数据 + `alert-validation.rules` 扩展（2 新 type × threshold/param 白名单红绿）+ DTO/swagger 扩展 + CRUD IT（新词表建/改/重复键拒）+ **api-client regen**（cite §V）。**无 migration**（复用既有 shape）。
- **PR-2（server 实时引擎，feat(alert)）**：`realtime-quote.port` + 腾讯/新浪双源 adapter + `realtime-quote.rules`（GBK/字段对齐纯函数红绿，锚 PoC 真实响应样本）+ FallbackChain 编排 + `intraday-eval.processor`（5min repeatable + 交易时段 gate + 熔断）+ `evaluate-intraday-alerts.usecase`（拉取集派生 + 双模求值 + 5min 差分 + 判重复用）+ Redis 快照/熔断态 + push 盘中价标注 + IT（8 state_branches 全条）+ **env-gated 真实请求 IT**（`RUN_PERF_IT`，腾讯/新浪实测，默认 skip）+ ADR（D8）。
- **PR-3（mobile，feat(alert)）**：`alert-copy` +2 词表/摘要/盘中价正文 + `alert-condition-meta` 镜像 + `add-condition-screen` 2 新条目 + vitest（draft 键/摘要/盘中价渲染）+ `[Mobile-E2E]` hermetic（建「5 分钟涨超」预警全流程，mock 端点）+ `[Contract-Smoke]`（登录 → 建「5min 涨超 3%」预警 → 列表/编辑回显 → 删除，落 `apps/mobile/e2e/contract-smoke/alert-realtime.contract.ts`）。

> 依赖：021/022/023 全 ship ✅；数据源 PoC 复验 ✅（p2 §5.1）。无外部代码前置（vendor 真实稳定性走 PR-2 env-gated IT + 上线后观察）。

### 建议 tasks.md 层级（每 task 30min-2h，预估 **~13-15 task**）

- **PR-1 ~4**：`[Server]` meta +2 词表 + intradayEligible → `[Server]` validation 扩展红绿 → `[Server]` DTO/swagger+CRUD 接线 + `[Server-IT]` 校验面 → `[Contract]` export-openapi+regen+`[Verify]`
- **PR-2 ~6-7**：`[Server]` T0 确认 `VendorHttpClient` 导出位置 → `[Server]` realtime-quote.rules 解析纯函数红绿（腾讯/新浪 PoC 样本）→ `[Server]` 双源 adapter + FallbackChain → `[Server]` intraday processor（tick + 交易时段 gate + 熔断）→ `[Server]` evaluate-intraday UC（拉取集 + 双模 + 5min 差分 + 判重）→ `[Server-IT]` 8 state_branches + 021/023 零回归 → `[Server-IT]` env-gated 真实源（RUN_PERF_IT）+ ADR
- **PR-3 ~3-4**：`[Mobile]` copy/meta +2 + draft → `[Mobile]` add-condition 2 条目 + 盘中价正文 → `[Mobile-E2E]` → `[Contract-Smoke]`

---

**Plan Version**: 1.0.0 | **Created**: 2026-06-08 | **ID-namespace**: US1-3 / FR-001..008 + FR-001a / SC-001..006 | **ADR**: 0047（vendor FallbackChain 范式，复用）/ 0052（alert ctx + 调度自治，沿用）/ 0043（扁平贫血纯函数范式）/ D8 新 ADR 候选（alert 自持外部 IO adapter 边界，随 PR-2 落）
