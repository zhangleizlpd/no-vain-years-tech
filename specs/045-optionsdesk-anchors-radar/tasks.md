---
feature_id: 045-optionsdesk-anchors-radar
spec_ref: ./spec.md
plan_ref: ./plan.md
status: completed
created_at: 2026-08-01
updated_at: 2026-08-02
---

# Tasks: 045-optionsdesk-anchors-radar（optionsdesk M1 — 锚管理 + 击球区雷达）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Mockup**: [`design/handoff.md`](./design/handoff.md) | **Branch**: `045-optionsdesk-anchors-radar`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径 → verify: …`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 映射 spec user story（US1 锚管理 / US2 雷达 / US3 导航与抽屉 / US4 采集闸）；地基 / 契约 / 收口不带
- 层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Verify]`
- **单 PR**（一 feature = 一分支 = 一 PR，Constitution §V 跨端原子 merge）；Phase = 逻辑 task 组，**非 PR 拆**
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task **内联绑测试**（红→绿→typecheck/lint→`[X]`→stage→commit），**不设独立测试 task**；纯函数（派生链 / 色带几何 / 回落语义 / 游标编解码）= vitest 无 DB；落库 / 分页 / 跨 ctx 读 / 采集闸 = Testcontainers PG（`nx test server <file>`，cwd=apps/server，memory `testcontainers_spec_run_via_nx_cwd`）；**每 Phase 末单列 `[Server-IT]`**
- **每个 task ≤ 2h 单 commit 工作单元**（Constitution §III）—— T001/T002 与 T006/T007 与 T019/T020 是按此拆开的，**别再合回去**
- **47 条 `state_branches`（spec frontmatter）逐条须在测试有 `it()`**（覆盖矩阵见文末，47/47 全覆盖）。⚠️ 计数以 `spec.md` frontmatter **实时 grep 为准** —— `checklists/requirements.md` 记的「35 条」是第 3 轮数字，#775/#776/#777 之后已增至 47
- **17 条 Edge Cases** 分散绑在对应 task 的 verify 里（标 `EC-N`，矩阵见文末）
- ⚠️ **SC-001 故意零 task —— 不是漏了**：spec 明写「本条在行情采集接线完成后生效，**不作本片验收门**」（30 秒确认今日无事的全流程含盘中实时 spot，而实时已推迟到下一阶段）。**别在 analyze / review 时把它当覆盖缺口补 task。** 其余 10 条 SC 均有 task 锚
- ⚠️ 新 ts/spec 首跑带 `--skip-nx-cache`（nx cache 对新文件可能假绿）
- ⚠️ mobile 测试分层：**vitest = logic-only**（RHF 错误映射 / 提交态 / 校验 / 派生显示），**UI·render·a11y 走 Playwright E2E**（memory `mono_mobile_test_layering`，`~/ui` 无单测）

## Path Conventions

- server 新 ctx：`apps/server/src/optionsdesk/`（**扁平文件平铺**，ADR-0043，无 domain/application/infrastructure 子目录）
- server 改动（采集闸）：`apps/server/src/marketdata/`
- migration：`apps/server/prisma/migrations/20260801_XXXX_create_optionsdesk/`（**expand-only**）
- IT：`apps/server/test/integration/optionsdesk-045.*.it.spec.ts`
- mobile feature：`apps/mobile/src/optionsdesk/`；路由 `apps/mobile/app/(app)/(tabs)/optionsdesk.tsx` + `apps/mobile/app/(app)/optionsdesk/`
- mobile 通用容器：`apps/mobile/src/ui/app-drawer.tsx`
- e2e：`apps/mobile/e2e/`（hermetic）+ `apps/mobile/e2e/contract-smoke/optionsdesk.contract.ts`
- 本地起服 / IT 前 `env -u OSS_*` + 显式 dev `DATABASE_URL`/`REDIS_URL`（memory `local_it_smoke_needs_env_unset_oss`）；dev DB `docker compose -f docker-compose.dev.yml up -d --wait`（mbw-poc-postgres:5433 / redis:6380）

---

## 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红的坑）

1. **boundaries 第 3 条漏项 = 静默开边**（plan D1-3）：`boundaries/dependencies` 是 `default: allow`。除了给 `optionsdesk` 加自己的 from 规则，**必须把 `optionsdesk` 追加进现有 11 条 from 规则的每个 `disallow.to.type` 数组**（已实证 `grep -c "from: { type:" apps/server/eslint.config.mjs` = **11**）。漏一处不会红，只会静默给对方开一条到我们这里的边。
2. **`href:null` 必须留在静态 options 对象里**（plan D10-3）：expo-router 在布局期读**静态** `href` 决定 tab 是否渲染；options 用**函数形式**时 `href` 不被采纳 → **门控失效、期权台 tab 在公开版漏出（合规问题）**。而 ideation 恰是当前唯一用函数形式 options 的 tab（为动态隐藏 tab 栏），本次要给它加 `href:null` —— **两者会撞**，必须在 impl 期解开并以公开版构建真验。
3. **ideation 不许移出 `(tabs)/`**（plan D10-2）：中央 FAB 与 `IDEATION_FULLSCREEN_ROUTES` 的 tab 栏隐藏逻辑**都活在 tabs layout 层**，移出去 = 同时打掉这两样 = 直接违反 FR-025 零回归。做法 = 留在原地、单独渲染一个 `href:null` 的 `Tabs.Screen`（照 `create` 占位路由写法），且**不进 `TABS` 数组**（否则参与 FAB 槽心计算）。
4. **FAB 公式不要改**（plan D10）：`fabLeftPct` 一直在按可见 tab 集合动态算。mockup 帧 ⑪ frame-note 写的「固定 50% ⇒ 无需重算」**是 CSS 层观察、对实装是误导**。045 后 ON/OFF 两态恰好都是 50%，那是 tab 集合变更的连带结果，**不是**可以删公式的理由。
5. **`chat-drawer` 抽取必须保住 testID 契约**（plan D11）：`chat-drawer` / `-panel` / `-backdrop` / `-search-input` / `-search-clear` / `-new-conversation` / `-user-name` / `-settings-button` 逐个保留落点，否则 chat 既有 e2e 整片红。且保留该文件两条硬约束：**`Animated.View` 上不能挂 NativeWind className**（reanimated#8329 整串被吞，视觉 token 下沉到内层 plain View）+ 面板宽用百分比要**包一层 View 约束 frame**。
6. **`needSync` 是受保护列**（plan D7）：与 `syncTier` / `lixingerCompanyType` 同属 schema 注释点名的「universe 同步 update 路径不得覆盖」列。我们的重算是**唯一另一个合法写入点**，**只碰这一列**。
7. **采集闸读锚表失败只 warn 不上抛**（FR-029）：整方法 try/catch 全包 + `logger.warn` + 返 `null`，逐字照抄 `sync-tier-recalc.ts:38-41`。上抛会污染 marketdata 的 `SyncRun` 状态。
8. **`excluded` 不参与采集闸**（FR-028）：判据严格是「有没有锚」。锚 = 采集意愿，excluded = 交易意愿。要彻底停采只能删锚（期权 EOD 无跨日补救，停采造成永久断层）。
9. **小尺寸圆禁 dashed 边框**（plan D12）：mockup 渲染实证 8px 圆加 `1.5px dashed` 退化成齿轮/星形。钳制态用**空心点**（`background: surface` + `2px solid text`）。
10. **人工值等于派生值时仍须标记人工态**（plan D9）：不得因值相等而静默视为未调整，否则痕迹丢失「这个值是谁设的」，PIT 还原分不清 `source`。
11. **模型 import 不重置 `next_review`、不解除逾期红标**（FR-035）：复审是人的确认，模型出新值不构成确认。否则模型一跑红标全清、复审机制失效。
12. **雷达默认排除 `excluded`，锚列表则必须显示它**（FR-005，plan D14a）：两个面对 excluded 的态度**相反**，别写成一个共用查询。

---

## Phase 1: 地基（ctx 物理落地 + 注册面 + schema + 派生纯函数）🎯

**Independent Test**: 新 ctx 目录 + schema 落地后全仓编译绿；`prisma migrate deploy` 无 drift；`check-server-moat` 0 违规；boundaries 双向反例各撞一次（我们越界被拒 / 别人越界进来被拒）；派生纯函数全绿。**纯结构 + 纯函数，不接任何业务流 ⇒ 立即可验。**

- [X] T001 [Server] **`optionsdesk` ctx 骨架 + 5 条机器强制注册面**（FR-001, plan D1）：新建 `apps/server/src/optionsdesk/optionsdesk.module.ts`（空壳 module，注册进 `app.module.ts`）+ 注册面逐条：① `apps/server/eslint.config.mjs` `boundaries/elements` 加 `{ type:'optionsdesk', pattern:'src/optionsdesk/**' }`（**声明序放在 `marketdata` 之后**，避免被通配抢匹配）② 新增 `from:{type:'optionsdesk'}` disallow 规则（禁 `auth`/`portfolio`/`alert`/`chat`/`ideation`/`agent-bridge`，**放行 `marketdata`** = 唯一合法读边）③ 🚨 **`optionsdesk` 追加进现有 11 条 from 规则的每个 disallow 数组**（Guardrail 1）④ `scripts/checks/check-server-moat.ts` 的 `BUSINESS_CTX` 加 `optionsdesk`（⚠️ 该 Set 现为 7 项、**缺 `agent-bridge`** 是既有不一致，**mention 不改**，别顺手补）⑤ `docs/conventions/business-naming.md` 模块行加 `optionsdesk` → verify: `nx lint server` 绿 + **boundaries 双向反例各写一次临时文件撞红再删**（`optionsdesk` import `portfolio` 应红 / `alert` import `optionsdesk` 应红，memory `eslint_boundaries_file_pattern_mode_full` 要求加细分必跑双向反例）+ `grep -c "'optionsdesk'" apps/server/eslint.config.mjs` **≥ 12**（11 条既有 + 自身规则）

- [X] T002 [Server] **ADR-0062 新 bounded context 决策记录**（Constitution §IV, plan D1-6 + Gate 0.4）：`docs/adr/0062-optionsdesk-bounded-context.md` —— 含 **7Q 决策树逐条判定**（Q4 = Yes 新业务领域）+ **跨 ctx 面清单**（每条标 Q7-B：我们读 marketdata 行情 / marketdata 反向读我们的锚表）+ **两条显式复审记录**（**ADR-0048 sunset_trigger #2** = 强一致同步读，判 `accepted-as-is` 未命中，命中条件 = P3 许愿单需实时价或盘中实时 spot 上线；**ADR-0053 sunset_trigger #2** = 第二个 ctx import 他 ctx 的 `*.rules.ts`，判 `accepted-as-is` 未命中，命中条件 = 将来需读时复权序列）+ 自身 `sunset_trigger`。编号已核（现最大 ADR-0061）→ verify: `scripts/checks/check-adr-index.ts` 绿（lefthook `adr-index-check` + `adr-frontmatter-check` 会拦）+ `docs/adr/README.md` 索引含新条目

- [X] T003 [Server] **schema `optionsdesk` + 2 表 + migration**（FR-001/FR-003a/FR-031/FR-033/FR-036, plan D2）：`apps/server/prisma/schema.prisma` `schemas` 数组 7 → 8 项加 `"optionsdesk"`；新增 **锚主表**（`ticker` canonical `market:code` **唯一约束** / `V` / `asof` / `method` / `confidence` + `confidenceSource` / `excluded` + `excludeReason` / `nextReview` / **人工位三列**（`vManual` / `lLevelManual` / `positionCapManual`）/ **`lLevelEffective`**（参与 SQL 筛选的普通列，D3）/ `lastClose` + `lastCloseDate`（投影，D4）/ **`breachStartedOn`**（本轮跌破首次观测日，FR-013 状态机载体））+ **变更痕迹表**（锚 id **不级联删** / `changedAt` / `changedFields` / `beforeValues` / `source`）；两表 `@@schema("optionsdesk")` + `@@map` snake_case + migration（`prisma migrate diff --from-config-datasource --to-schema` 生成零 drift，样板 044 `20260716_XXXX_create_calendar_sync_health`；顶部 `-- migration_refs: specs/045-optionsdesk-anchors-radar`）+ **`check-server-moat.ts` `MODEL_OWNERSHIP` 声明两表 → `optionsdesk`**（漏则别人一读就 `moat-unmapped` 硬拒）→ verify: `prisma validate` + `generate` + dev DB `migrate deploy` 无 drift + **幂等重 deploy** + `nx typecheck server` 绿 + `check-server-moat.ts` exit 0

- [X] T004 [P] [Server] **`anchor.rules.ts` 派生纯函数 + 档位常量**（FR-003/FR-030/**SC-005**, plan D2）：`apps/server/src/optionsdesk/anchor.rules.ts` —— `W = 0.8V`、四区间边界（`0.6V / W / V / 1.2V` 五段）、**L 层映射**（≥9 → L1 / 7–9 → L2 / 3–7 → L3 / <3 → L4）、**单票上限派生**（L1≤25% / L2~5% / L3~2%）、**愿卖锚两个独立系数**（长持 1.2 / 收租 1.0，🚨 **禁把收租写死为「等于 V」**——当前相等是取值巧合非定义，FR-003）、距 W% = `(lastClose − W) / W`；全部档位落**文件顶部具名常量**（FR-030 配置化，单点可改）→ verify: `anchor.rules.spec.ts` 纯函数验：**EC-4 档位边界恰好 3 / 7 / 9 的归属确定**（不得两档都亮或都不亮）+ 四区间五段边界值 + 愿卖锚两系数独立可调（改长持系数不影响收租）+ **EC-3 V ≤ 0 时拒绝**（四区间与 W 在 V≤0 无意义）+ 距 W% 符号与量级 + **FR-008 后半：某档位（一期是 L1）无任何锚落入 MUST NOT 被当作校验错误** —— 映射函数对空档位不报错、不特判，档位为空是估值管道现状而非异常（**禁**加「L1 必须有票」这类看似合理的校验）；**外加 SC-005「代码内零自造参数」机械断言**：`grep -rE '0\.8|0\.6|1\.2' apps/server/src/optionsdesk/ --include='*.ts' | grep -v anchor.rules.ts` **须为空**（档位数值只许出现在 rules 文件，其余文件 import 常量）

- [X] T005 [Server-IT] **Phase 1 schema IT**（FR-001/FR-031）（Testcontainers PG）：`migrate deploy` → `optionsdesk` schema 两表存在 + **锚表 `ticker` 唯一约束生效**（重复插入撞 P2002，FR-001「同一 ticker MUST NOT 存在两条有效锚」）+ 痕迹表可插入且**删锚后痕迹行仍在**（不级联，FR-031）+ `check-server-moat.ts` 0 违规。`apps/server/test/integration/optionsdesk-045.schema.it.spec.ts`

---

## Phase 2: US1 锚管理 server（P1）🏁 MVP 前半

**US1 Independent Test**（不依赖行情数据）：建锚 → 同屏返回全部派生值且三处不带人工标记；改 `confidence` → L 层与单票上限沿链联动；置人工位 → 生效值切换 + 标记 + 派生值可见；撤销 → 立即回落；`next_review` 设昨天 → 逾期可筛出；`excluded=true` → 列表可见带 reason。

- [X] T006 [US1] [Server] **锚写侧骨架：create / update + 生效 L 层写入求值**（FR-001/FR-003a/FR-033, plan D3）：`create-anchor.usecase.ts` + `update-anchor.usecase.ts` —— 直注 `PrismaService`（无 repository，ADR-0043）；**所有影响生效 L 层的路径写入时求值**（建锚 / 改 confidence / 改 L 层人工位 / 撤销 / import）；`confidenceSource` 门控（`model` 来源改 confidence **写侧拒**，`manual` 可改）；**EC-7 同一 ticker 重复建锚 → 拒绝并引导去编辑既有锚**（返 409 + 既有锚 id；spec 给了「拒绝或改为更新」二选一，**取拒绝** —— 静默 upsert 会覆盖你已录的估值结论，而估值是本系统最贵的人工输入）；**EC-10 `next_review` 早于 `asof` → 允许保存但标「建锚即逾期」**（不静默当有效）→ verify: `create-anchor.usecase.spec.ts` / `update-anchor.usecase.spec.ts`（mock prisma）：生效 L 层随 confidence 正确求值 + `model` 来源改 confidence 被拒 + **EC-7 重复 ticker 返 409 且不改既有行** + **EC-10 建锚即逾期可识别** + **任一时刻只有一个生效值**（不出现第二份生效 L 层）

- [X] T007 [US1] [Server] **两级链回落：三条触发路径**（FR-006/FR-032/FR-035, plan D9）：在 T006 的写侧上实现 `confidence → L 层 → 单票上限` 的回落语义 —— **① 模型批量 import 刷 V/confidence → 冲掉三处人工值**（并产出差异报告数据结构供脚本消费，禁静默回落）；**② 人工改 L 层 → 冲掉单票上限人工值**；**③ 手工锚改 confidence（仅 `manual`）→ 沿两级链冲掉 L 层与单票上限**；撤销任一层 → 立即回落 + 下游随之；🚨 Guardrail 10（人工值等于派生值仍标人工态）+ Guardrail 11（import 不重置 `nextReview`、不解除逾期红标）→ verify: `anchor-cascade.spec.ts` 纯函数验三条路径各一组 + **EC-5 人工值等于派生值仍标记** + **EC-6 单票上限人工态时上游 L 层被改 → 上限回落（临时语义下上游赢）** + **EC-9 手工锚改 confidence ∧ L 层人工态 → 两处一并回落** + **两处同时人工态时一并回落、无「只回落其中一处」的中间态**

- [X] T008 [US1] [Server] **变更痕迹落库（含 `source`）+ 删锚保留痕迹 + PIT 还原**（FR-031/FR-035/**SC-011**, plan D2/D15）：痕迹写入嵌进 T006/T007 写侧**同 tx**（一行 = 一次变更，含 `changedFields` + `beforeValues` + `source`）；`delete-anchor.usecase.ts`（删锚**本身也落一条痕迹**，痕迹不随主行级联清除）；PIT 还原查询（给定时点回放 `V` / W / L 层 / 单票上限 / 愿卖锚）→ verify: `anchor-history.spec.ts` 纯函数验 PIT 回放算法（按时点倒放 `beforeValues` 得当时值，SC-011）+ 写侧 spec 补断言「每次变更恰好一条痕迹、`source` 正确（`model`/`manual` 可分辨）」

- [X] T009 [US1] [Server] **复审动作 + 逾期语义**（FR-004/FR-007/FR-013, plan D14a-3）：`review-anchor.usecase.ts` —— 复审推进 `nextReview`、解除逾期红标，**同时**解除复核锚红标（FR-013：解除方式**只有**完成一次定期复审，**MUST NOT** 引入第二个确认动作/状态）→ verify: `review-anchor.usecase.spec.ts`：复审推进日期 + 逾期解除 + **EC-12 复核锚红标随之解除但买区/深买区徽标照常**（两者语义不同不得一起消失）+ 复审后 spot 仍在 W 下时红标不再亮（`最近复审 ≥ 本轮跌破起点`）

- [X] T010 [US1] [Server] **锚读侧 + controller + DTO + swagger**（FR-001/FR-004/FR-005/FR-009, plan D6）：`list-anchors.usecase.ts`（含待复审 / 已排除筛选，**excluded 在锚列表可见并带 `excludeReason`** —— Guardrail 12）+ `get-anchor.usecase.ts` + `optionsdesk.controller.ts` + `optionsdesk.dto.ts`（`@nestjs/swagger` 装饰器 = API SoT；⚠️ nullable string 字段的 `@ApiProperty` **必须显式 `type:'string'`**，否则 orval 误生 objectmap，memory `nullable_apiproperty_needs_type_string`）；**沿用现有鉴权**，不新增对外服务化面（FR-009）→ verify: controller spec 用 `Test.createTestingModule({ imports:[OptionsdeskModule] })` 装 DI 容器（🚨 **NO LIFECYCLE MOCKING**，plan Testing Invariants）+ `nx run server:export-openapi` 产出含新端点且 DTO 形状正确

- [X] T011 [US1] [Server-IT] **US1 集成 IT**（**SC-011**）（Testcontainers PG）：建锚落库 + 派生值正确 + **EC-7 重复 ticker 被拒**；改 confidence → 生效 L 层与单票上限联动落库；三条回落路径端到端；撤销立即回落；痕迹逐条落库 + **删锚后痕迹保留**；**PIT 还原与当时显示逐项一致（SC-011）**；逾期筛出；excluded 在列表可见。`apps/server/test/integration/optionsdesk-045.anchor.it.spec.ts`。**覆盖 state_branch**: confidence 改动两级链联动 / L 层人工态 / 单票上限人工态 / 两处同时人工态无中间态 / `confidence_source` 门控三条 / import 批量回落 / 撤销 / 痕迹与 PIT 三条

---

## Phase 3: US2 雷达 server（P1）🏁 MVP 后半

**US2 Independent Test**: 两层 —— ① fixture 驱动纯函数（色带比例 / 端帽钳制 / 排序 / 复核锚状态机）零外部依赖；② Testcontainers IT 内**塞真行 us `Instrument` + `DailyBar`**，断言雷达读端返真值（验真落库端到端，**不碰任何 vendor、不等另一 worktree**）。

- [X] T012 [US2] [Server] **`lastClose` 单向投影（跨 ctx 只读直查）**（FR-016/FR-017/FR-027/FR-036, plan D4/D5）：`apps/server/src/optionsdesk/sync-anchor-quote.ts` —— 从 `marketdata.daily_bar` 拉每个锚标的最新 bar（`Instrument(market_code)` → `DailyBar(instrumentId, adjust:'none', 最新 tradeDate)`，路径已实证 market-agnostic）回填锚表 `lastClose` + `lastCloseDate`；🚨 **单向**：`daily_bar` 是唯一真相源，**读端 MUST NOT 反写**；`// CROSS-CONTEXT-READ:` 注释挂 **prisma 调用上方**（挂 import 上方**不被探针采信**）；`priceKind` 值域扩一档表示「回落到 EOD 快照」；**EC-14 `asOf` 必须取数据自身的 session 日期（`tradeDate`），不是本地日期** —— 美股 session 跨本地交易日边界，取本地日期会在盘后时段谎报新鲜度 → verify: `sync-anchor-quote.spec.ts`（有 bar → 回填 / **无 bar → `hasData=false` 且不写 0**（禁 0 值伪造，FR-017）/ 未注册 instrument → 显式 no-data / **EC-14 asOf 恒等于 bar 的 `tradeDate`，与运行时本地日期无关**（构造本地日期 ≠ tradeDate 的用例））+ `check-server-moat.ts` exit 0（**故意删注释撞红再补回**，验探针真的在拦）

- [X] T013 [US2] [Server] **雷达读端：游标分页 + SQL 端筛选 + 复核锚状态机**（FR-010/FR-013/FR-015/FR-033/FR-034, plan D8/D14a）：`get-radar.usecase.ts` —— **基础 `WHERE` 排除 `excluded=true`**（Guardrail 12）；排序 `距 W% ASC, id ASC`（**tiebreaker 必须有**：浮点会并列、SQL 不保证并列顺序稳定，无 tiebreaker 则游标跳行）；**keyset 游标**（`(距W%, id)` 二元组编解码，**禁 `OFFSET`** —— 翻页期间行情刷新会漏行/重复，漏看一只即功能失效）；筛选在 SQL 端求值（生效 L 层多选 / `nextReview` 逾期 / 跌破 W = `lastClose < 0.8*V`）；**复核锚状态机**（`spot < W ∧ 最近复审 < breachStartedOn`；回到 W 上方**清空** `breachStartedOn`；建锚时已在 W 下 → 起点=建锚日；**行情不可用期间既不推进也不清空**）；三空态区分（全体不动区 / 零锚 / 筛选无结果，**禁复用文案**）→ verify: `get-radar.usecase.spec.ts` + `radar-cursor.spec.ts` 纯函数：游标编解码往返 + **并列距 W% 时按 id 稳定分页不跳行/不重复** + 复核锚状态机四条转移 + **EC-13 spot 在 W 上下反复穿越（含同一交易日内）→ 每次由上穿下都算新一轮、红标可重新亮起**（不得因「本轮已复审过」对新一轮失效）+ **EC-11 spot 恰好等于 W 的边界与区间归属取同一侧**（可复现）+ 三空态各自文案不同

- [X] T014 [US2] [Server-IT] **US2 集成 IT**（**SC-006**）（Testcontainers PG）：🚨 **塞真行 us `Instrument` + `DailyBar`**（spec 明定的验收方式）→ 雷达读端返真值 + `asOf` = `lastCloseDate`；游标分页**翻页期间改动 `lastClose` 不漏行不重复**；SQL 端筛选与游标同时生效；**EC-15 锚已建但该标的从未被采集 → 行仍在列表且显式「行情不可用」**（禁 0 值 / 禁隐藏行 / 禁整页失败）；excluded 不出现在雷达但在锚列表可见；**SC-006 四种降级态（单票缺失 / 锚逾期 / 锚库为空 / 全体不动区）各自可见且互不混淆**。`apps/server/test/integration/optionsdesk-045.radar.it.spec.ts`。**覆盖 state_branch**: 正常进雷达 / 逾期红标行不隐藏 / excluded 不进雷达 / 复核锚四条 / 色带区间三条 / 行情三档（当日 / 陈旧 / 不可得）/ 空态两条 / 游标分页 / 并列 tiebreaker / 筛选 SQL 端 / 筛选空 / `lastClose` 单向

---

## Phase 4: US4 采集闸（P2）

**US4 Independent Test**: 建一个此前不在工作集的锚 → 触发重算 → 该标的 `needSync` 开闸；删锚 → 移出且已落库历史数据不删；`excluded=true` 仍在工作集；锚表读取失败只 warn 不上抛。全程不需要真实 vendor 调用。

- [X] T015 [US4] [Server] **marketdata 侧按锚表重算 `needSync`**（FR-028/FR-029, plan D7）：`apps/server/src/marketdata/anchor-driven-sync-gate.ts` —— **逐字照抄 `sync-tier-recalc.ts` 形态**：`prisma.<锚表>.findMany` + `// CROSS-CONTEXT-READ:` 注释；🚨 **整方法 try/catch 全包，失败只 `logger.warn` + 返 `null`、不上抛**（Guardrail 7，照抄 `:38-41`）；**只碰 `needSync` 一列**（Guardrail 6 受保护列）；**`excluded` 不参与闸判定**（Guardrail 8）；挂进 `dimension-executor.ts` 作**前置步骤**，与 `SyncTierRecalc` 并列；🚨 **禁**把 optionsdesk 注册进 `SyncDimension` / executor 钩子（方向铁律：底座不依赖业务）→ verify: `anchor-driven-sync-gate.spec.ts`（有锚 → 开闸集合正确 / 无锚 → 关闸 / **excluded 仍在开闸集合** / **读锚表 throw → 返 null 且不上抛**）

- [X] T016 [US4] [Server-IT] **采集闸 IT**（**SC-003/SC-007**）（Testcontainers PG）：建锚 → 重算 → `Instrument.needSync=true`（**SC-003 零代码改动、零人工 SQL**）；删锚 → 重算 → `needSync=false` 且**已落库 `daily_bar` 历史行一条不少**；`excluded=true` 的锚其标的**仍在**工作集；**锚表读取失败（drop 表或权限模拟）→ 只 warn、`SyncRun` 不被置 failed**；**SC-007 cn/hk 既有标的同步范围与既有 22 维度运行状态零变化**。`apps/server/test/integration/optionsdesk-045.sync-gate.it.spec.ts`。**覆盖 state_branch**: 新建锚开闸 / 删锚移出且不删历史 / excluded 不参与闸 / 锚表读失败只 warn

---

## Phase 5: 契约同步（Constitution §V 类型同步链）

- [X] T017 [Contract] **OpenAPI export + `@nvy/api-client` regen**（Constitution §V）：`nx run server:export-openapi`（🚨 **必走 canonical `node dist/main.js` 路径，非 `dump.mjs`**，memory `openapi_export_must_use_canonical_mainjs`）→ `apps/server/openapi.json` → `packages/api-client` 跑 codegen → mobile 可 import。**同 PR 原子 merge，无「PR1 先合」序**（Constitution §V v1.3.0）→ verify: `nx affected` 传导链跑通 + 生成的 client 含全部新端点且类型非 `objectmap`（nullable string 的 `@ApiProperty` 已在 T010 显式 `type:'string'`）

---

## Phase 6: US3 导航与全局抽屉（P1）

**US3 Independent Test**（不需要任何锚或行情数据）：底部 tab 集合变更；markets 开关两态下期权台可见性与可达性；一级页汉堡开抽屉且遮罩盖住底部 Tab 栏；二级页显示返回箭头；抽屉内灵感入口可进且灵感列表 / 详情 / 图片标注 / 中央 FAB 新建全部照旧。

- [X] T018 [US3] [Mobile] **抽屉容器抽取 `chat-drawer` → `~/ui/app-drawer`**（FR-023/**SC-009**/**SC-010**, plan D11）：新建 `apps/mobile/src/ui/app-drawer.tsx` 承载**骨架**（RN `Modal` transparent + `statusBarTranslucent` + `navigationBarTranslucent` → root 层挂载盖住 Tab 栏与状态栏 / backdrop 淡入 + tap 关 / 面板 `translateX` 滑入 82% / swipe-left 关手势 / 安全区内缩 / `onRequestClose` 接 Android 硬件返回 / 关态 unmount）；`apps/mobile/src/chat/chat-drawer.tsx` 改为消费它，**chat 业务内容（搜索框 / 会话列表 / 新建对话 / CHAT_COPY）留在本地**；🚨 Guardrail 5（**逐个保住 8 个 testID** + `Animated.View` 不挂 className + 面板包 View 约束 frame）；**SC-009 新第三方依赖数 = 0**（不引 `@react-navigation/drawer`）→ verify: `nx run mobile:runtime-smoke` **跑全套非单 spec**（blast radius = 整套 e2e，per mobile-impl-playbook）—— chat 抽屉既有 e2e 全绿 = 零回归（SC-010 前半）+ `git diff package.json pnpm-lock.yaml` **无新增依赖**（SC-009 机械断言）

- [X] T019 [US3] [Mobile] **tab 集合变更 + `href:null` 解冲突**（FR-021/FR-025/FR-026/**SC-008**, plan D10）：`apps/mobile/app/(app)/(tabs)/_layout.tsx` —— `TABS` 的 `ideation` 项换成 `{ name:'optionsdesk', label:'期权台', icon:<新>, gated:true }`；🚨 Guardrail 3（ideation **留在 `(tabs)/` 下**、单独渲染 `href:null` 的 `Tabs.Screen`、**不进 `TABS` 数组**）；🚨 Guardrail 2（`href:null` 走**静态** options 对象，解开与函数形式 options 的冲突 —— 这是本 task 的**核心难点**，也是本片最可能静默失败处）；🚨 Guardrail 4（**不改** `fabLeftPct` 公式）→ verify: 🚨 **公开版构建真验**（`EXPO_PUBLIC_FEATURE_MARKETS=false` 跑 mobile）—— 期权台 tab **不渲染**；ON 态 tab 可见；**两态 FAB 均居空槽正中**（ON 50% / OFF 50%，OFF 从改前 62.5% 变来是预期连带）；**灵感路由仍可达且中央 FAB 在灵感屏照常**（FR-025 零回归）

- [X] T020 [US3] [Mobile] **期权台路由 + icon + 门控登记**（FR-022/**SC-008**, plan D14）：新建 `apps/mobile/app/(app)/(tabs)/optionsdesk.tsx`（tab 落地屏 + `MarketsRouteGuard`）+ `apps/mobile/app/(app)/optionsdesk/_layout.tsx`（二级页 stack + guard）；`apps/mobile/src/ui/` 新增期权台 `TabIconName`（线性描边 24×24，与既有 `TabBarIcon` 同族）；`apps/mobile/src/core/markets-gate.tsx` 的 **`MARKETS_SURFACES` 登记三条**（`tab-button` / `tab-screen` / `route-stack` —— 该文件自带 🔧 注释要求新增受控面必须登记，它是「门控盖住了哪些面」的唯一清单）→ verify: **深链直达被 guard 拦**（公开版构建下 `/(app)/(tabs)/optionsdesk` 与 `/(app)/optionsdesk/anchors` 均重定向）+ `MARKETS_SURFACES` 三条齐（SC-008 合规回归照此清单走）

- [X] T021 [US3] [Mobile] **全局抽屉挂载 + 一级页汉堡 / 二级页返回箭头**（FR-023/FR-024/FR-025, plan D11）：抽屉挂在 tabs layout 层，内容 = 品牌头 + **菜单区仅「灵感」一项** + 用户脚（头像 / 昵称 / 齿轮→设置）；全部一级 tab 页题头左上渲染汉堡，二级页渲染返回箭头；**EC-17 灵感的全屏子屏**（`[id]` / `image-viewer` / `image-annotate`）**不得出现悬空汉堡或双返回按钮**；**EC-16 抽屉打开时切后台再回前台 → 状态可预期**（保持或关闭二选一，**不得残留半开或遮罩不可点**）→ verify: vitest logic-only（题头 leading 选择：一级 → 汉堡 / 二级 → 返回 / 全屏子屏 → 都不渲染；**EC-16 AppState 变化后抽屉 open 态是确定值**）；render / 手势 / 遮罩层级走 T025 E2E

---

## Phase 7: US1 / US2 mobile 消费（P1）

- [X] T022 [US1] [Mobile] **锚管理列表屏 + 锚表单屏（RHF）**（FR-001/FR-002/FR-004/FR-005/FR-032, plan D9/D15）：`apps/mobile/src/optionsdesk/` —— 列表屏（正常 / 逾期红标 / 已排除三态同屏，chips 单选筛选）；表单屏走 **RHF + zodResolver 4 铁律**（Controller≠register / 表单态≠副作用态 / isSubmitting 单源 / 错误+a11y）；**搜票选择器**消费已 ship 的 `GET /marketdata/search`（**EC-2 不接受自由文本**，搜不到即不能提交、不提供绕过，FR-002）；**`confidence` 按 `confidenceSource` 门控**（`model` 只读无编辑入口 / `manual` 可改）；三处人工位的**临时语义标记**（「人工调整 · 下次上游刷新将回落」+ 同屏显示派生值 + 一键撤销，FR-032 四条）；变更痕迹段（plan D15，表单内）；🚨 **mutation 必失效 list query key**（建锚/删锚/改 list-visible 字段 → 失效雷达与锚列表 key，否则列表陈旧到重启）→ verify: vitest logic-only（RHF 错误映射 / 提交态 / **EC-3 V≤0 校验** / **EC-7 重复 ticker 的 409 映射为「该票已有锚，去编辑」** / `model` 来源下 confidence 无编辑入口 / 人工态标记文案含「将回落」）；UI 走 T025

- [X] T023 [P] [US2] [Mobile] **四区间色带组件（纯 View）**（FR-011/FR-012, plan D12）：`apps/mobile/src/optionsdesk/zone-band.tsx` —— **5 段矩形 + spot 黑点 + W 红圈 + 2 条界线 + 刻度文字**，全部 `View`（flex 百分比宽 + absolute 定位 + `borderRadius`），**不引 SVG**；几何契约：内段 `[0.6V, 1.2V]` 严格等比例 ⇒ **W 恒 35.67% / V 恒 64.33%**、两端各 7% 端帽；**端帽内 spot 钳制**（不越出色带、不当真实比例位）；🚨 Guardrail 9（钳制态用**空心点**，禁 dashed 边框）；**轴区内零文字**；W 界线标值且红色加粗、V 标真实位置、两端不标 → verify: `zone-band.spec.ts` 纯函数验几何映射（值 → 百分比位置：`0.6V→7%` / `W→35.67%` / `V→64.33%` / `1.2V→93%`；越界 → 钳制到端帽内且返回 `clamped=true`）

- [X] T024 [US2] [Mobile] **雷达屏（五态 + 筛选 chips + 下拉加载）**（FR-010/FR-014/FR-015/FR-016/FR-017/FR-018/FR-019/FR-020/**SC-002**/**SC-004**, plan D13/D14a）：`apps/mobile/src/optionsdesk/radar-screen.tsx` —— **每行 5 字段**（标的标识〔ticker + 中文名〕/ 距 W% / 色带 / spot / 徽标，plan D13；🚨 **删掉 spot 串里重复的「· 距 W xx%」**）；徽标顺序 **L 层 → 区间/锚逾期 → 复核锚/提醒类**，**禁**衍生徽标；五态（常态 / 全体不动区 / 行情降级 / 零锚 / 筛选无结果，**三空态文案互不复用**）；筛选 chips **多选**（L1–L4 + 待复审 + 跌破 W）；**SC-002 下拉增量加载、全程无页码控件**；新鲜度条**复用既有 `formatAsOf` 体例**（plan D14a，不重写）；**两处「即将可用」占位**（行点击进详情 FR-018 / 题头 🌡 FR-019）—— **题头 ⚙ 是真入口**（进锚管理），别一起做成占位；**不渲染顶部四视图 seg**（FR-020）→ verify: vitest logic-only（五态判定 / 徽标排序 / 每行字段数 = 5（SC-002）/ asOf 新鲜度档文案 / `hasData=false` 行仍在列表且显式不可用）+ **SC-004「不存在无标注的数值」机械断言**：渲染层断言 **`lastClose` 无 `lastCloseDate` 时不渲染数值**（数值与 asOf 同生共死，杜绝「裸数值」）；UI 走 T025

---

## Phase 8: 收口（两层验证 + 无回归 + 全绿门）

- [X] T025 [Mobile-E2E] **hermetic UI e2e**（**SC-006/SC-008/SC-010**）（Playwright Expo Web，mock 后端）：雷达五态渲染（SC-006 四降级态互不混淆）；抽屉开合 + **遮罩盖住底部 Tab 栏** + Android 硬件返回关；一级页汉堡 / 二级页返回箭头 / 全屏子屏无悬空汉堡（EC-17）；**markets ON/OFF 两态 tab 集合与 FAB 位置（SC-008）**；锚表单三处人工位标记与撤销；**灵感四项能力零回归（SC-010）**（列表 / 详情 / 图片标注 / 中央 FAB 新建）→ ⚠️ hermetic mock 写**依赖方契约**、持单一 canonical 状态，**禁**按测试编排标志分支（per mobile-impl-playbook）；⚠️ Expo web e2e 六坑先过一遍（memory `expo_web_e2e_and_router_footguns`）

- [X] T026 [Contract-Smoke] **契约冒烟**（Constitution §V 两层验证之二）：`apps/mobile/e2e/contract-smoke/optionsdesk.contract.ts` —— 用生成的 `@nvy/api-client` 打 **testcontainers 真 server**，一条 happy-path：建锚 → 读雷达 → 改 L 层 → 撤销，验**契约对齐**（URL/method/序列化/响应解封/错误码）+ **真落库**。加进共享套件 → verify: `nx run mobile:contract-smoke` 绿（⚠️ 本地跑须显式 `MARKETDATA_PROVIDER=mock`，shell env 会被继承，memory `marketdata_provider_env_gotchas`）

- [X] T027 [Server-IT] **无回归 IT**（**SC-007**）：🚨 **必跑全 `NX_DAEMON=false nx test server --skip-nx-cache`（非代表性子集）**。新增 2 表使 schema 表数变化 ⇒ 断言**表数 / 表清单**的全景 IT（`schema-015` / `schema-016` 等）**必破**，照 039-044 先例逐个更新期望值，**仅改既有 IT 期望、不动 045 impl**。⚠️ 本 feature **不增同步维度** ⇒「维度数 23」类断言**理论零改**（与 039-043 增维场景不同，**别惯性改**）→ verify: 全量绿 + `check-server-moat.ts` 0 违规 + env-gated 真 vendor IT 默认 skip 零真 vendor 触达（**SC-007 既有 23 维度运行状态零变化**）
  - 📌 **实测结论（2026-08-02）**：全量 `nx test server --skip-nx-cache` **NX_EXIT=0，359 文件通过 / 10 跳过，3176 测试通过 / 67 跳过，244.90s** —— **既有 IT 零改动**。预期「全景 IT 必破」**未发生**，原因：045 两张新表落在**新 schema `optionsdesk`**，而既有全景 IT（`schema-015`/`schema-016`/`schema-017`/`sync-schema-gate`）的表清单查询全部 `WHERE table_schema = 'marketdata'` ⇒ 结构上不受跨 schema 加表影响；新表的表清单断言由 `optionsdesk-045.schema.it.spec.ts` 自行承担。
  - ⚠️ **口径修正**：spec `SC-007` 字面写「既有 **22** 个同步维度」为 **stale** —— 实测 seed 维度 = **23**（多的一个是 sellput-viz `us_equity_bar`），既有 IT（`marketdata.schema-016.it.spec.ts:230` / `marketdata.sync-schema-gate.it.spec.ts:63` / `marketdata.schema-017.it.spec.ts:121`）**早已断言 23**。本 feature 不增维度 ⇒ 三处断言零改，SC-007 语义（既有维度运行状态零变化）成立。

- [X] T028 [Verify] **全绿门 + 三项一次性核对**（**FR-008**）：`NX_DAEMON=false nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache` 全绿（NX_EXIT=0）；外加三项**只有这次能做**的核对：① 🚨 **boundaries 11 条逐条 grep 核**（Guardrail 1，`grep -c "'optionsdesk'"` ≥ 12 且人工确认每条 disallow 数组都含）② 🚨 **锚表接管后与 prod 人工开闸的 7 票对账**（AOS / CPB / LULU / PEP / PSKY / TAP / VICI —— 这 7 票的 `needSync` 是人工 SQL 开的，重算结果必须与之一致，否则闸逻辑与人工判断有偏差，plan 风险 6）⚠️ **前置**：这 7 条锚由 **user 手工在 App 内建**（2026-08-01 定，plan Out of Scope），对账前须先建好，否则无从对起 ③ **`perf_budgets` 用真实测数校准一次**（spec frontmatter 5 条为先验值，MUST 校准否则退化成没人回看的拍脑袋数字）
  - ✅ **全绿门（2026-08-02）**：`nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache` → **NX_EXIT=0**，`Successfully ran targets lint, typecheck, test, build, runtime-smoke for 4 projects and 1 task they depend on`。
  - ✅ **① boundaries 11 条**：`grep -c "'optionsdesk'" apps/server/eslint.config.mjs` = **13**（≥ 12：1 条 element zone + 11 条入边 disallow + 1 条 `from: optionsdesk` 自身出边）。逐条脚本核（非肉眼）：解析 flat config 取 `boundaries/dependencies` 的 12 条规则，对 `from.type !== 'optionsdesk'` 的 **11 条**逐条断言 `disallow.to.type` 含 `'optionsdesk'` → **11/11 命中，missing = 0**（security / integrations / account / auth / portfolio / marketdata / marketdata-rules / alert / chat / ideation / agent-bridge）。
  - ✅ **③ `perf_budgets` 已校准** → 见 `spec.md` frontmatter（含两路实测来源 + 定档规则 + 日期）。收紧 3-6 倍：radar 250/500→**50/100**、GET anchors 100/200→**40/80**、POST 150/300→**50/100**、PATCH 150/300→**50/100**、DELETE 120/250→**40/80**。
  - ✅ **② 7 票对账 —— 已完成（2026-08-02，prod 实测双向闭合）**。以下小节保留当初「未完成」时的记录不改写（决策留痕），执行结果见本组末尾「执行结果」条。
    - **前置（user 手工做，AI 做不了也不得代做）**：在 App 内手工建好 **AOS / CPB / LULU / PEP / PSKY / TAP / VICI** 这 7 条锚（2026-08-01 定，plan § Out of Scope 末条：为一次性 7 条数据写 seed / migration 不划算，且手工建锚顺带走一遍建锚流程）。🚨 **禁**伪造锚数据或补 seed 脚本来「完成」本项。<br>🔄 **2026-08-02 改判建锚方式**：「在 App 内手工建」→ **user 执行事先备好的 API POST**（user 选择跳过 App 排练，直接给真 V 值）。「AI 不得代做」不变 —— V 是 user 的估值判断，AI 只做搬运与校验；prod 写操作仍由 user 执行。详见下方 2026-08-02 补记。
    - **对账内容（plan 风险 6）**：这 7 票在 prod 的 `Instrument.needSync` 是**人工 SQL** 开的；锚表接管后由 `apps/server/src/marketdata/anchor-driven-sync-gate.ts` 反向读锚表**重算**。重算结果 MUST 与人工开闸结果**逐票一致** —— 不一致即说明闸逻辑与人工判断有偏差，须先查清再上线。
    - **执行方式**：7 条锚建好后，对同一批标的比对「锚表重算得到的 `needSync` 集合」vs「prod 现存人工开闸的 `needSync=true` 集合」，逐票列差异（预期差集为空）。
    - **为何本次做不了**：前置条件未满足（锚表刚落地、prod 无锚数据），非遗漏。
    - 🆕 **2026-08-02 补：锚数据有了真实来源 + 建锚方案已定（分两批）**。以下为待执行方案的留痕，**本条仍未完成**。
      - **数据来源**：user 的估值报告 `~/Downloads/valuation_us_20260712-19/`（13 份 `valuation.md`，2026-07-12~19，R1.3 v3 固定系数体系）。⚠️ **此前 sellput POC mockup（`~/futu-screener/sellput-poc/`）里那 7 个 V 是 MOCK**（每条 `method` 字段自带「（MOCK 锚）」标记），**不得使用** —— 用它们正是上面 🚨 禁令指的伪造。
      - **口径互证**：报告的区间体系 `0.6 / 0.8 / 1.2 / 1.6 × V` 与本 feature 的三点定标 `0.6V / W / 1.2V` **同源** —— 逐条反算，6 份报告印的 `0.6V` / `0.8V` 边界与其 V 分毫不差 ⇒ **`W = 0.8V` = 报告的「加仓区上沿」**。
      - **12 条最终值**（`method` 统一 `multi-anchor-weighted`，`confidenceSource` = `manual`；asof 均 2026 年）：

        | 批 | ticker | V | asof | conf | L | 上限 | W | excluded | next_review |
        | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
        | 1 | `us:CPB` | 22 | 07-12 | 6.0 | L3 | 2% | 17.6000 | — | 2026-09-09 |
        | 1 | `us:LULU` | 149 | 07-12 | 5.5 | L3 | 2% | 119.2000 | — | 2026-08-27 ⚠️预估 |
        | 1 | `us:PEP` | 129 | 07-13 | 5.5 | L3 | 2% | 103.2000 | — | 2026-10-13 |
        | 1 | `us:TAP` | 47 | 07-15 | 5.0 | L3 | 2% | 37.6000 | — | 2026-08-06 |
        | 1 | `us:AOS` | 70 | 07-16 | 5.0 | L3 | 2% | 56.0000 | **true** | 2026-10-15 ⚠️预估 |
        | 1 | `us:PSKY` | **9.65** | 07-17 | 4.0 | L3 | 2% | 7.7200 | — | 2026-08-04 |
        | 1 | `us:VICI` | 29 | 07-19 | 5.5 | L3 | 2% | 23.2000 | — | 2026-10-15 ⚠️预估 |
        | 2 | `us:LKQ` | 33 | 07-12 | 6.0 | L3 | 2% | 26.4000 | — | 2026-10-29 |
        | 2 | `us:KBR` | 53 | 07-13 | **8.0** ⬆️ | **L2** | 5% | 42.4000 | — | 2026-10-15 ⚠️预估 |
        | 2 | `us:ACN` | 175 | 07-16 | **9.0** ⬆️ | **L1** | 25% | 140.0000 | — | 2026-10-01 |
        | 2 | `us:ARE` | 84 | 07-17 | 4.0 | L3 | 2% | 67.2000 | **true** | 2026-08-03 |
        | 2 | `us:EXE` | 81 | 07-17 | 4.0 | L3 | 2% | 64.8000 | **true** | 2026-11-03 |

      - **分两批（方案 A，user 2026-08-02 定）**：**批 1 = 原 7 票**（= 本条对账的那 7 票）→ 对账通过 → **批 2 = 新增 5 只**。⚠️ **不可一次建 12 条** —— 那样闸重算会 `opened=5`，与 prod 人工开的 7 票对不上，本条「逐票一致」判据当场失效。
      - **★ 对账判据（批 1 之后）**：下一轮 cron 的前置重算 MUST 为 **`opened=0 / closed=0`**（幂等零行变更）—— 这就是「闸逻辑 == 人工判断」的证据。任一非零 ⇒ 有偏差，**停下查清，不得继续批 2**。批 2 之后预期 `opened=5`，us 采集工作集 7 → 12 票。
      - 🚨 **必须走 API，不能走 SQL**：`create-anchor.usecase.ts` 在写入事务内派生三样 —— `lLevelEffective`（`:156` / `:182`，由 confidence 映射）、`lastReviewedOn = 建锚当日`（`:181`）、同 tx 的 `AnchorChange` 痕迹（`:188`）。裸 INSERT 三样全漏：`l_level_effective` 是雷达 WHERE 的过滤列（空值直接筛错）· `last_reviewed_on` 空会让 W 下方的新锚**立刻误亮红标** · 无 `AnchorChange` 则 PIT 不可还原、M4 接货折扣归因**永久缺口**。
      - **两处人工上修（user 2026-08-02 拍板，非报告原值）**：`ACN` confidence **5.0 → 9.0** ⇒ **L1**、上限 25%，**本仓第一条 L1 锚**（p1 §5 P6 原写「L1 档一期为空」，至此不再成立）；⚠️ 报告正文判 ACN「无单一股东 ≥30% → 排除，不进选股池」，user 明示**不标** `excluded`。`KBR` confidence **5.5 → 8.0** ⇒ **L2**、上限 5%。其余 10 条沿用报告的综合置信度（4.0–6.0，全落 L3）。
      - **V 取整规则**：四舍五入取整，**个位数标的除外** —— `PSKY` 保留 `9.65`（取整到 10 会把 W 从 7.72 推到 8.00 = **+3.63%**，是 12 条里唯一显著偏移，其余全在 ±1.7% 内）。顺带解掉 TAP 报告内部的「正文 $47 vs 表格反算 $46.89」矛盾（两者都落 47）。
      - **`excluded=true` 三条**：`AOS`（报告判仓位上限 0%）· `ARE`（5 条否决）· `EXE`（高估 8.6% + 排除线）。⚠️ `excluded` 是**交易意愿**、不参与采集闸（FR-028）⇒ 这 3 只照常进采集工作集。
      - **4 条 `next_review` 是预估态**：`LULU 08-27`（三源给 08-27 / 09-03 / 09-04，**取最早** —— 偏早 = 提前变红 = 保守方向，偏晚才危险）· `AOS / VICI / KBR 10-15`（Q3 确定落 10 月下旬~11 月初但均未公布确切日 ⇒ 统一保守日，**不编伪精度**）。其余 8 条为确认 / 较可靠级。这 4 条等 M2b 的 `earnings_event` 维度（富途 `get_earnings_calendar` 直给日期 + 盘前/盘后）落地后由真数据取代，批量 `PATCH` 一次 —— 即 p3b §1「财报日历三态（确认/预估/无）」里的「预估」态。
      - ⚠️ **`us:TAP` / `us:PSKY` / `us:ARE` 建好后数日内即逾期**（next_review = 08-06 / 08-04 / 08-03）。这是**有意的**（user 2026-08-02：「正常就行」）—— 财报出来了就该先复审估值再谈交易，符合 FR-013 语义，不是配置错误。
      - **`FISV` 已剔除 ⇒ 12 条而非 13 条**：库内 canonical 是 `FISV`（`marketdata.instrument` 实测 19,465 行 us，`FI` **不存在**），但其代码变更史本身有歧义（FISV → FI 2023-06 转 NYSE → 疑似转回 Nasdaq），user 定不为一条锚背这个不确定性。
    - ✅ **执行结果（2026-08-02，prod）—— 双向闭合，本条到此关闭**
      - **前置**：`server-v0.21.0` 上 prod（`a4d7f36b` / #790）。上线核验用的是**路由存在性判别式**而非 workflow 结论：`/api/v1/optionsdesk/anchors` 由 **404 → 401**，同时阴性对照 `/api/v1/optionsdesk/__nope__` **保持 404**、阳性对照 `/api/v1/portfolio/trades` **保持 401** ⇒ 401 是真「路由存在被 guard 挡」，不是全局兜底。`/docs-json` 里 5 条 optionsdesk 路径齐全为第三方佐证。
      - **建锚**：批 1 = 原 7 票（id 1-7）、批 2 = 新增 5 只（id 8-12），全部 **HTTP 201**。派生值逐条核过：`W = 0.8V` / 区间 `0.6V~1.2V` / 愿卖锚 `1.2V·1.0V` / `positionCap` 与 L 层一致；`lastReviewedOn` 建锚当日回填；**ACN conf 9.0 → L1 / cap 0.25**（本仓首条 L1）、**KBR conf 8.0 → L2 / cap 0.05**，两处人工上修在 prod 落成预期档位。
      - **① 一致性**：批 1 后触发 `us_equity_bar`（fact 维度 ⇒ 必走 `factExecutor` 的闸前置），`scanned=7 / ok=7`；`Instrument.need_sync=true` (us) 恰为 AOS·CPB·LULU·PEP·PSKY·TAP·VICI，与锚表 7 条**差集为空**、零行变更。
      - **② 阳性对照（这一步才排除了「闸静默 no-op」）**：零行变更本身无痕迹，故行集相等**不足以**证明闸跑过。批 2 建 5 条新锚后再触发 → `scanned` **7 → 12**、`need_sync` 行集 7 → 12。哑的闸会停在 7。
      - **③ 「闸没被 DI 掉」的独立证明**：`anchorGate?: AnchorDrivenSyncGate` 是可选参数 + `?.` 调用，未接上会静默 no-op。判据 = 该参数**无 `@Optional()`**（`grep -c "@Optional()" dimension-executor.ts` = 0）⇒ Nest 按类型**强制解析**，解析不到是 **boot 直接失败**而非传 `undefined`；而 provider 已注册（`marketdata.module.ts:393`）且容器 healthy 在服务 ⇒ 实例确实注入。
      - **④ `excluded` 不参与闸**（FR-028 现场生效）：`ARE` / `EXE` 标了 `excluded=true`，**照样在 `need_sync` 集合里**。
      - **连带闭合**：[p3b §10 Phase 2 #7](../../docs/private/plans/2026-07/07-30-sellput-viz-p3b-data-architecture.md) 的「仍欠一次性对账」随本条关闭。
      - ⚠️ **顺带查出、已在本 PR 一并处理**：`SyncAnchorQuoteUseCase`（T012 的投影）**在 prod 从未被执行** —— 全仓无调用方（无 `@Cron` / 无端点 / 不在 `exports`），`last_close` 恒 `null`，雷达距 W% / `zone` / 跌破 W 筛选 / 复核锚红标全部出不了真值。补 `sync-anchor-quote.scheduler.ts`（`0 30 6 * * *` Asia/Shanghai，排在 `us_equity_bar` 之后）。**根因是 T012 与 plan D4 都只定义了「怎么算」没定义「谁来调」**，而 T014 的 IT 里是测试自己 `new` 出来调的 ⇒ 测试全绿也照不出这个洞。

---

## Dependencies & 执行顺序

```text
Phase 1 地基（T001 注册面 → T002 ADR ∥ T003 schema → T004[P] rules → T005 IT）
  ↓（T001 是全部 server task 的硬前置；T002 与 T003/T004 无依赖可并行）
Phase 2 US1 锚管理 server（T006 写侧骨架 → T007 回落链 → T008 痕迹 → T009 复审 → T010 读侧+controller → T011 IT）
  ↓
Phase 3 US2 雷达 server（T012 lastClose 投影 → T013 雷达读端 → T014 IT）
  ↓
Phase 4 US4 采集闸（T015 → T016 IT）
  ↓
Phase 5 契约（T017 OpenAPI + api-client regen）
  ↓
Phase 6 US3 导航（T018 抽屉抽取 → T019 tab 集合 → T020 路由+门控 → T021 挂载）  ← 与 Phase 2-5 无依赖，可整段提前
  ↓
Phase 7 US1/US2 mobile（T022 锚屏 / T023[P] 色带 → T024 雷达屏）
  ↓
Phase 8 收口（T025 E2E → T026 契约冒烟 → T027 无回归 → T028 全绿门）
```

- **硬前置**：T001（注册面）→ 全部 server；T003（schema）→ T006 起全部落库 task；T017（regen）→ T022/T024（mobile 消费生成的 client）。
- **可并行 `[P]`**：T004 ∥ T003（rules 纯函数与 schema 不同文件）；T023 ∥ T022（色带组件与锚屏不同文件）；T002（ADR）与 T003/T004 亦无依赖。
- **可提前整段**：**Phase 6（US3 导航）与 server 无依赖** —— 想早点在真机上看到期权台 tab 就把它插到 Phase 2 之前。排在此处只为线性执行顺手。
- **必串行**：T006 → T007（同写侧、回落建在骨架上）→ T008（痕迹嵌同 tx）；T012 → T013（雷达读端依赖 `lastClose` 列有值）；T018 → T021（先有容器才能挂）；T019 → T020（路由文件依赖 tab 注册形态定案）。
- **关键路径** = T001→T003→T006→T007→T010→T012→T013→T017→T022→T024→T025→T028。
- **MVP** = Phase 1 + 2 + 3（锚可维护 + 雷达能出真值），但**服务端 MVP 无 UI 不可用** ⇒ 实际可用 MVP 需含 Phase 5-7。⚠️ 本 feature 单 PR，此处仅标逻辑增量顺序，**不拆 PR**。

## state_branch 覆盖矩阵（47 条 → task，逐条 1:1）

| state_branch | task |
| --- | --- |
| 锚存在 ∧ 未逾期 ∧ 未 excluded → 正常进雷达 | T013 / T014 |
| 逾期 → 雷达行显示红标、行不隐藏 | T013 / T014 |
| excluded → 不进雷达默认视图、锚列表仍可见 | **T010**（列表）/ **T013**（雷达排除）/ T014 |
| spot < W ∧ 最近复审 < 本轮跌破起点 → 复核锚红标亮 | **T013** / T014 |
| spot < W ∧ 本轮已复审 → 红标解除、区间徽标照常 | **T009** / T013 |
| spot 回到 W 上方 → 清空本轮起点 | **T013** |
| 建锚时 spot 已在 W 下 → 起点 = 建锚当日 | **T013** / T006 |
| 行情不可用期间 → 既不推进也不清空 | **T013** |
| spot ∈ [0.6V, 1.2V] → 等比例定位 | **T023** / T004 |
| spot 越界 → 端帽内钳制、端帽不标界线值 | **T023** |
| spot 恰好 = W → 区间归属与红标边界同侧、可复现 | **T004 / T013** |
| 行情可得（当日）→ 距 W% + asOf 新鲜度档 | T012 / T024 |
| 行情陈旧 → 显式「数据截至 X · 收盘」 | **T024** / T014 |
| hasData=false → 显式「行情不可用」、行仍可见 | **T012**（禁 0 值）/ T024 / T014 |
| 全部不动区 → 「今日无解，空仓是常态」 | T013 / T024 |
| 零锚 → 引导去建锚 | T013 / T024 |
| 雷达翻页 → 游标分页、不漏行不重复 | **T013** / T014 |
| 距 W% 并列 → 锚 id 升序 tiebreaker | **T013** / T014 |
| 筛选生效 → SQL 端求值 + 与游标同时生效 | **T013** / T014 |
| 筛选后为空 → 「当前筛选无结果」+ 清除入口 | T013 / T024 |
| 行情同步 → `lastClose` 单向更新、读端不反写 | **T012** / T014 |
| 建锚搜票命中 / 未命中不允许自由文本 | **T022** / T025 |
| 新建锚 → 采集工作集自动纳入 | **T015** / T016 |
| 删除锚 → 移出工作集、历史数据不删 | **T015** / T016 |
| confidence 改动 ∧ 两覆盖位空 → 三处沿链刷新 | **T006 / T007** / T011 |
| L 层人工调整 → 标记 + 单票上限改从人工 L 层派生 | **T007** / T011 |
| 单票上限人工调整 → 标记 + 派生值可见 | **T007** / T011 |
| `confidence_source = model` → 界面只读无编辑路径 | **T006**（写侧拒改）/ **T022**（无编辑入口）|
| `confidence_source = manual` → 可改且沿链冲两处 | **T007** / T011 |
| 模型首次覆盖手工锚 → 来源翻 model、自动只读 | **T007** / T011 |
| import 刷 confidence ∧ L 层人工态 → 回落 + 记痕迹 | **T007 / T008** / T011 |
| import 批量刷 → 全部人工值回落 + 差异报告逐条列 | **T007** / T011 |
| 人工改 L 层 ∧ 上限人工态 → 上限回落、同屏可见 | **T007** / T022 |
| L 层与上限同时人工态 → 一并回落无中间态 | **T007** / T011 |
| 在报告里看到回落 → 回 App 重新人工调整 | T022（入口）/ T007（记 source=manual）|
| import 刷 V → `next_review` 不重置、红标不解除 | **T007**（Guardrail 11）/ T011 |
| 撤销任一层 → 立即回落 + 下游随之 + 记痕迹 | **T007 / T008** / T011 |
| 锚表读取失败 → 采集侧只 warn 不上抛 | **T015** / T016 |
| 锚被修改 → 落字段级痕迹、当前值与历史并存 | **T008** / T011 |
| 按历史时点查询 → 逐项还原一致 | **T008** / T011 |
| 锚被删除 → 痕迹保留不级联 | **T008** / T005 / T011 |
| markets ON → 期权台 tab 可见可达 | **T019 / T020** / T025 |
| markets OFF → tab 隐藏 + 路由 guard + 仅剩 2 tab | **T019**（公开版构建真验）/ **T020**（guard）/ T025 |
| 一级 tab 页 → 题头汉堡开抽屉 | **T021** / T025 |
| 二级页 → 题头返回箭头，不渲染汉堡 | **T021** / T025 |
| 抽屉打开 → 遮罩覆盖整屏含 Tab 栏、tap / 硬件返回可关 | **T018 / T021** / T025 |
| 灵感 → tab 移除但路由 / stack / FAB 全保留 | **T019**（Guardrail 3）/ T025（SC-010）|

## Edge Case 覆盖（17 条 → task）

| EC | task | EC | task |
| --- | --- | --- | --- |
| 1 锚库为空 → 空态引导 | T013 / T024 | 10 `next_review` 早于 `asof` | **T006** |
| 2 标的库未收录 → 不提供绕过 | **T022** | 11 spot 恰好 = W | T004 / T013 |
| 3 V ≤ 0 拒绝保存 | **T004** / T022 | 12 复审后区间徽标照常 | **T009** |
| 4 confidence 档位边界 3/7/9 | **T004** | 13 W 上下反复穿越 | **T013** |
| 5 人工值 = 派生值仍标记 | **T007** | 14 asOf 跨 session 边界 | **T012** |
| 6 上限人工态 ∧ L 层被改 | **T007** | 15 锚已建但从未采集 | T012 / **T014** |
| 7 同 ticker 重复建锚 | **T006**（拒绝+409）/ T011 / T022 | 16 抽屉切后台再回前台 | **T021** |
| 8 手工建锚 confidence 可改 | T006 / T022 | 17 全屏子屏无悬空汉堡 | **T021** / T025 |
| 9 手工锚改 confidence ∧ L 层人工态 | **T007** | | |

## 单 PR（Constitution §V）

**跨端 feature ⇒ 单 PR 原子 merge**：server impl + IT + `api-client` regen + mobile 消费 + 两层验证（`[Mobile-E2E]` hermetic + `[Contract-Smoke]` 契约冒烟）**全部同 PR**。代价（已接受，2026-06-13 决策）：出 prod bug 整体 revert，不保留 server 独立回滚。
