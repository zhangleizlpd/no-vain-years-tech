---
feature_id: 023-alert-eod-indicators
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-07'
---

# Tasks: 023-alert-eod-indicators（预警 EOD 指标扩展 — 估值/价格扩展/成交量/技术指标四类条件）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `023-alert-eod-indicators` | **Mockup**: [`design/`](./design/)（`添加条件改造.html` + `AddCondKit.jsx`，已验收）

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）；`[USx]` = user-story 阶段 task 带；层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Verify]`
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；纯函数（meta/validation/indicator/evaluation rules）= vitest 无 DB；UC 读写 DB 单测走 **Testcontainers PG**（`nx test server <file>`，cwd=apps/server）；mobile 纯逻辑 = vitest，UI·render·a11y = Playwright Expo Web e2e
- 无 task-meta JSON（**manual 模式**，per 004-022）
- 🚨 **023 = 021 alert ctx 纯增量（零新 ctx/零新表/零新端点路径）**：migration 仅加列+唯一约束改造（plan D3，无不可逆操作）；**新跨 ctx 面**＝① alert→marketdata **纯函数 import**（仅 `adjusted-bars.rules.ts`，boundaries 细分 `marketdata-rules` 放行，**ADR-0053 随 T008 落**）② Q7-B 直查扩 3 表（`adjustment_factor`/`fundamental_snapshot`/`trading_day`），每处 `prisma.<表>.find*` 上方**必须** `// CROSS-CONTEXT-READ:` 注释（moat 探针拒）；**跨 ctx 写永远禁**
- 🚨 **021 零回归（FR-S09/SC-005）**：021 既有 rules spec / IT / e2e 断言**全保留不改**；求值/校验扩展只增不动旧分支
- 🚨 **前复权契约（master 跨契约 2）**：窗口/指标计算一律 `deriveAdjustedBars(bars, factors, 'forward')` 后的序列；估值/量类/021 既有条件用 none 口径
- **三段式 PR（per plan §Phase 2）**：**PR-1 = Server 契约面**（T001–T006，ships 词表+校验+regen，描述 cite §V 例外 + D9 间隔期 flag）→ **PR-2 = Server 指标+引擎**（T007–T013）→ **PR-3 = Mobile**（T014–T019）
- mockup 验收提醒（brief 验收记录）：KDJ 超卖文案 = **`J < 10`**（mockup 误写 J<0 不带入）；sheet 预填除 RSI 70/30 外不带入（新建空、编辑回显现值）

## Path Conventions

- server：`apps/server/src/alert/`（021 既有 module 扩展）；schema `apps/server/prisma/schema.prisma`（`AlertCondition` 加列）+ migration `yyyymmddhhmm_alert_condition_param`；IT `apps/server/test/integration/*.it.spec.ts`
- contract：`apps/server/openapi.json`（`nx run server:export-openapi`，canonical `node dist/main.js`）→ `packages/api-client/`（Orval `nx affected -t generate`）；**threshold 转 nullable 的 DTO 显式 `@ApiProperty({type:'string', nullable:true})`**（per memory orval 陷阱）
- mobile：`apps/mobile/src/alert/`（021 既有 feature dir 改造）；routes 不变（`app/(app)/alert/`）；`~/theme`/`~/ui` 0 重设零新库（mockup 验收锁定）
- e2e：`apps/mobile/e2e/`（mock alert 8 端点 + 015 EP2 + 003 refresh per memory）；contract-smoke `apps/mobile/e2e/contract-smoke/alert-indicators.contract.ts`
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait` + `prisma migrate deploy`（:5433/:6380）；**本地 server IT/smoke 前 `env -u OSS_*`**；migration 落库后 `prisma generate` 先行

---

## Phase 1: Server 契约面 — 词表 + 带参条件模型（PR-1）

**Goal**：26 词表可建可改可校验，api-client regen 落地（引擎未扩前新条件不触发 = D9 已接受，PR 描述 flag）。

- [X] T001 [Server] **migration + 词表单源**：`apps/server/prisma/schema.prisma` `AlertCondition` 改造（`threshold` → `Decimal?` + 加 `param Int @default(0)` + `@@unique([alertId,type])` → `@@unique([alertId,type,param])`，plan D3）+ migration `alert_condition_param` + `prisma generate` + 新建 `apps/server/src/alert/alert-condition-meta.ts`（26 type 词表 SoT：每 type 的 kind（threshold/ma/window/daysPct/pctile/rsi/none）/ param 白名单 / threshold 值域 / 单位 / 通达信公式常量注释，plan §词表 SoT + D5）+ meta 自洽 vitest（词表完整性/白名单互斥/021 既有 4 type 形态不变）。**验**：migrate deploy 绿 + 021 存量行为零影响（param 默认 0）
- [X] T002 [US1] [Server] **校验纯函数扩展**：`apps/server/src/alert/alert-validation.rules.ts` 红绿扩展（type ∈ 26 词表 / param 白名单 per type（无参类型必须 0）/ threshold 值域 per type（价格>0、百分比∈(0,100]、PE·PB·量比>0、分位∈[0,100]、RSI∈(0,100)、无参类型禁带）/ 重复键 `type` → `(type,param)`：同 type 不同 param 放行 / conditions 1..4 与 021 规则全保留）——错误码扩展喂 400 ProblemDetail 映射，021 既有 spec 断言不改
- [X] T003 [US1] [Server] **DTO/swagger + CRUD 接线**：condition request/response DTO 加 `param?: number` + `threshold` 转 optional（**显式 `@ApiProperty({type:'string', nullable:true})`**）+ message snapshot DTO 扩 `{type,param?,threshold?,actual,dataDate?}`（plan D7）+ create/update UC 接 T002 校验 + **Testcontainers 单测**：新词表各 kind 建档回显 / 同 type 不同 param 共存（MA5+MA20）/ 同 type 同 param 400 / 无参带 threshold 400 / param 出白名单 400 / 021 旧 shape 请求向后兼容
- [X] T004 [US1] [Server-IT] `apps/server/test/integration/alert-indicators-crud.it.spec.ts`（全 boot）：spec `state_branches` 创建校验条 + 混类 AND 预警（PE_BELOW + NEW_LOW）建档→EP1/EP2 回显 param / RSI 阈值出域 400 / 021 既有 `alert-crud.it.spec.ts` **零改动跑绿**（FR-S09）
- [X] T005 [Contract] `nx run server:export-openapi`（canonical `node dist/main.js`）→ `nx affected -t generate`（Orval regen：ConditionItem 带 param?/threshold nullable + 26 type 枚举）→ mobile typecheck 绿。**regen 产物随 PR-1 commit**（cite §V 例外 + D9 间隔期 flag）
- [X] T006 [Verify] PR-1 gate：`nx affected -t lint typecheck test build runtime-smoke --base=origin/main` 全绿（**首跑 `--skip-nx-cache`**）+ moat/boundaries 0 violation + spec frontmatter `status: implementing` 翻

**Checkpoint**：PR-1 merge → 26 词表契约落地，新条件可建（不触发），api-client 就绪。

---

## Phase 2: Server 指标计算 + 求值引擎（PR-2）

**Goal**：新 22 metric 求值闭环——前复权窗口 → 指标纯函数 → 触发流水含实际值。

- [X] T007 [Server] **T0 数据 gate：prod backfill 深度实测**（2026-06-07 实测+补档：≥520 档 0%→95.6%（max 486→726），eod 水位 06-05 fresh，snapshot 5604 全覆盖；补档 `--history-depth 1095 --as-of 2026-06-05` 11,322 请求 75min 5604/5604/0 + `--factors` 补锚 13,902 行/4581 标的 failed 0；残差 4.4%=上市<3 年新票走 warm-up 防御）：psql 抽查 per-instrument none bar 数分布（≥520 / ≥251 / ≥60 三档占比）+ eod 水位（prod 操作 user 以 `!` 前缀跑，psql user=mbw）；不足 → `marketdata-backfill.cli --history-depth` 补档（019 既有能力）；**结论（分布数字 + 是否补档）记入 PR-2 描述**。不阻塞 T008-T011 开发（warm-up 防御语义兜底），gate PR-2 验收
- [X] T008 [Server] **boundaries 细分 + ADR-0053**：`apps/server/eslint.config.mjs` 加元素 `{type:'marketdata-rules', pattern:'src/marketdata/*.rules.ts'}` + alert 放行边 alert→marketdata-rules（adapter/usecase/module import 仍禁）+ `docs/adr/0053-cross-context-pure-rules-import.md`（判据：纯函数+无 IO+算法单源诉求；防逃逸：禁带状态/IO 文件混入 `*.rules.ts`；过 `check-adr-frontmatters`+`check-adr-index`）。**验**：lint 绿 + 反例（alert import marketdata adapter）lint 红
- [X] T009 [P] [US2] [Server] **指标纯函数（1/2 窗口统计）**：`apps/server/src/alert/alert-indicator.rules.ts` 红绿——MA(N) 今昨双值 / N 日新高低极值（今高 vs 前 N 日 max，不含今日）/ N 日累计涨跌幅（今收 vs N 交易日前收）/ 量比（今量/前 5 日均量）；vitest 已知序列断言（含窗口恰好等于/小于需求的边界）
- [X] T010 [P] [US2] [Server] **指标纯函数（2/2 递推指标）**：同文件扩 MACD（EMA12/26→DIF，EMA9→DEA，今昨双值）/ KDJ（RSV→SMA(,3,1) K/D 初值 50→J）/ RSI(14)（Wilder 1/N 递推）/ BOLL（MA20±2×样本 STD 今昨双值）——**通达信口径**（plan D5 公式）；vitest 锚定手算已知序列（小周期干净数列锚定 EMA/SMA 种子 + 样本标准差 + Wilder 递推机制，11 测绿）。**SC-002 对照样本降级为 T013 PR-2 手动 gate**（用户 2026-06-08 决策：硬编码同花顺易变展示值进单测脆性高 → 改 T013 真 prod 数据跑一轮人工比对 ≤1%，含 1 只年内除权股，结论记 PR-2 描述；手算锚定为自动回归守卫）
- [X] T011 [US2] [Server] **求值引擎扩展**（2026-06-08：`alert-evaluation.rules.ts` 扩 32 type 查表比较——按 meta 分类预派发 价格扩展/成交量/技术指标(MACD/KDJ/RSI/BOLL 各内聚子求值器)/估值 子求值器 + `conditionDataNeed` 取数分类器 + snapshot `{type,threshold,actual}` 基线零回归(param≠0/估值 dataDate 才附键)；`evaluate-alerts.usecase.ts` `assembleContexts` per-标的按需取数(最新 none bar / 520 前复权 `deriveAdjustedBars('forward')` / fundamental + `count(trading_day)` staleness)，5 处 `// CROSS-CONTEXT-READ:`；rules 39 测 + UC Testcontainers 18 测(含除权回归/staleness 边界/字段防御) + 021 全 boot IT 5 测零回归 全绿）：`evaluate-alerts.usecase.ts` 取数分层（plan D2：窗口/指标类标的 → `// CROSS-CONTEXT-READ:` 读 520 根 none `daily_bar` + 全量 `adjustment_factor` → `deriveAdjustedBars(…,'forward')`；估值类 → `fundamental_snapshot` 最新行 + staleness gate（`// CROSS-CONTEXT-READ:` count `trading_day` ≤3，plan D4）；量类 → none bar 多取前 5 根；021 路径不动）+ `alert-evaluation.rules.ts` 扩 22 metric 查表比较（穿越=今昨双值事件 D6 / 状态=当日值 / warm-up·字段缺失·staleness 超限→不命中）+ snapshot 含 `param/actual/dataDate` + **Testcontainers 单测**：每 kind 触发/不触发/防御各一
- [X] T012 [US2] [Server-IT] `apps/server/test/integration/alert-indicators-eval.it.spec.ts`（全 boot，造 instrument+bar 序列+factor+snapshot+trading_day 种子）：spec `state_branches` 求值条全覆盖——估值直比+字段 null / staleness 边界（落后 3=求值、4=不命中，含 `dataDate` 进快照）/ MA 上穿事件日触发+次日持续不触发 / 创 N 日新高 / **除权假信号回归**（分红事件日 forward 口径不假穿越/不假新低）/ warm-up 不足不命中且混合预警可算部分照算 / KDJ 超买状态型连两日各触发（DAILY）/ BOLL 穿越事件 / 混合新旧条件 AND / **021 既有 `alert-eval.it.spec.ts` 零改动跑绿**（FR-S09 + SC-005）。**（2026-06-08：9 测全绿——经 HTTP 建带参条件 → 真 marketdata 种子 → moduleRef 直调 `evaluate.execute()` → 流水+消息端点回显 param/dataDate；NEW_HIGH/NEW_LOW window 白名单 {60,120,250} 故除权回归/新高用 61 根 bar；KDJ J>100 / BOLL break-upper 先手算锚定；021 sibling IT 5 测零回归同跑确认）**
- [X] T013 [Verify] PR-2 gate：`nx affected` 全绿（首跑 `--skip-nx-cache`）+ moat 探针验 **CROSS-CONTEXT-READ 注释齐**（5 张表面）+ 零跨 ctx 写 + boundaries 反例红 + dev dogfood：**四类各 ≥1 条**新条件预警 CLI 评估一轮 → 消息端点出含 param/actual 数据（SC-001），**顺手记录单轮耗时**进 PR-2 描述（SC-004 佐证）+ T007 数据 gate 结论已记 + **SC-002 同花顺对照**（T010 降级项：≥2 只真股含 1 只年内除权，真 prod forward 序列喂指标纯函数 → 人工比对同花顺展示 ≤1%，结论记 PR-2 描述）。**（2026-06-08 收口）**：① 全 server gate（lint/typecheck/test/build/runtime-smoke，真实 affected=server，git 实证 11 文件全 alert）绿；② moat 探针 0 违规（5 张 marketdata 只读表面 + 零跨 ctx 写）；③ boundaries 双向反例探针：`marketdata.module` 导入 rule#6 拒红、`marketdata-rules` 正例绿；④ **SC-002 自动化扩样 12 支**（7 除权 + 5 无，沪深主板/创业板/科创/ST）—— 没走人工肉眼，改用同花顺公开日K前复权接口（`d.10jqka.com.cn`，无需登录）程序化拉真前复权序列 vs prod-forward 按日 diff + 两侧各算指标交叉核对：近端价格偏差 ≤0.82%（8/12=0.0000%）、最新日指标全 ≤1%（数据逐字节一致处指标亦逐字节同；唯一名义 >1% = 迈为 DEA 1.26% 实为近零分母 Δ0.009 放大）→ **复权口径 + 指标公式正确**；附带发现理杏仁 vs 同花顺老除权历史因子 ≤2.6% 微差（不进 alert 求值有效域，记数据源对账 backlog）；⑤ SC-001 全路径由 T012 全 boot IT 真 PG 覆盖；SC-004 单轮秒级由 usecase doc 容量论证（标的级 520 行索引扫 <10ms + O(n) 微秒级，2 数量级余量），dev 合成 dogfood 因与 T012 重复 + 真负载只在 prod 而免

**Checkpoint**：PR-2 merge → server 闭环（26 词表建 → 评估 → 触发流水/消息含实际值）。

---

## Phase 3: Mobile — 条件库 4 分类 + 参数 sheet（PR-3）

**Goal**：mockup `AddCondKit` 翻 RN，消费 PR-1 typed client，两层验证。

- [X] T014 [US1] [Mobile] **copy/meta + 草稿键扩展**：`apps/mobile/src/alert/alert-copy.ts` 扩 26 词表文案/4 分类分组/无参语义副标题（**KDJ 超卖 = `J < 10`**）/卡片摘要渲染（「上穿 MA20」「PE 低于 10倍」「RSI 超卖(30)」「创250日新高」，mockup 卡片 C）/消息正文渲染（`actual`+`dataDate` 估值日标注，mockup 卡片 D；旧消息缺新字段走 021 路径兜底）+ `use-alert-draft.ts` upsert/重复键 `type` → `(type,param)` + condition shape 加 `param?` + vitest（摘要渲染矩阵 / draft 键共存与覆盖 / 正文新旧兜底）
- [X] T015 [US1] [Mobile] **添加条件页 4 分类**：`add-condition-screen.tsx` 改造——左 rail 4 分类（mockup `CatRail` 翻 RN，选中态沿 021 样式）+ 条件行副标题 + 「已添加」按 `(type,param)` 判定 + 无参条件点添加**直接入草稿返回**（不弹 sheet）+ 搜索跨分类命中（FR-M04）+ 条件满 4 时未加项 disabled（021 逻辑沿用）+ `alert-edit-screen.tsx`/`alert-card.tsx` 条件行摘要含参（接 T014 渲染，结构不动）
- [X] T016 [US1] [Mobile] **参数 sheet 变体族**：`value-input-sheet.tsx` 扩为按 `kind` 分发（mockup B1-B6e）——纯阈值（021 现状）/ MA 周期 chips / 窗口 chips / 天数 chips+阈值 / 分位年限 chips+百分位 / RSI 预填 70|30+出域红字拒；chip 组 = `Pressable` 组 + 既有 token（**零新库**）；编辑回显现值（chips 选中 + 输入框预填）、新建空（RSI 例外预填默认）
- [X] T017 [US1] [Mobile-E2E] `apps/mobile/e2e/alert-indicators.spec.ts`（Playwright hermetic，mock 端点）：**逐分类全行渲染断言**（4 分类各自条件行齐全 + 无参副标题文案，覆盖 SC-006「逐条可达」）/ 建带参预警全流（**每 kind 至少配置成功一条**：纯阈值 PE 低于→B1、MA20→B2、窗口 250日→B3、天数+阈值→B4、分位→B5、RSI→B6、无参 MACD 金叉直加）/ RSI 出域红字拒 / 同 type 同 param 拦 + 不同 param 共存（MA5+MA20）/ 搜索跨分类命中 / 卡片摘要含参回显
- [X] T018 [US1] [Contract-Smoke] `apps/mobile/e2e/contract-smoke/alert-indicators.contract.ts`（node 层 `@nvy/api-client` 打 testcontainers 真 server）：登录 → 建混类预警（MA_CROSS_UP param=20 + PE_BELOW threshold=10）→ EP1/EP2 回显 param/threshold → EP4 改 RSI 阈值条件 → 同 type 同 param 400 → EP5 删除（`nx run mobile:contract-smoke`）
- [X] T019 [Verify] PR-3 gate：`nx affected -t lint typecheck test build --base=origin/main` 全绿（首跑 `--skip-nx-cache`）+ e2e/contract-smoke 绿 + 视觉 0 硬编码（grep 无 token 外 hex）+ spec frontmatter `status: implemented` 翻 + 021 既有 alert e2e 零回归（SC-005/SC-006）

**Checkpoint**：PR-3 merge → 全闭环 dogfood（4 分类建带参预警 → 晚间 cron → 消息含实际值/估值日）。

---

## Dependencies & Execution Order

```text
T001 ──→ T002 ──→ T003 ──→ T004 ──→ T005 ──→ T006              (PR-1)
PR-1 merge ──→ T008 ──→ T009 [P] ──→ T011 ──→ T012 ──→ T013     (PR-2)
               │        └ T010 [P] ──┘                ↑
               └ T007 数据 gate（并行随时跑，结论 gate T013）──┘
PR-1 merge ──→ T014 ──→ T015 ──→ T016 ──→ T017 ──→ T018 ──→ T019 (PR-3)
（T018 contract-smoke 仅需 PR-1 契约；T017 纯 UI 仅依赖 PR-1；PR-3 可与 PR-2 并行开发）
```

- **MVP 切片** = PR-1 + PR-2（US1 契约 + US2 求值闭环：CLI dogfood 新条件触发）；PR-3 是体验层。
- **Clear 检查点批次**（Constitution §III）：T001-T003 / T004-T006 / T007-T008 / T009-T010 / T011-T013 / T014-T016 / T017-T019。
