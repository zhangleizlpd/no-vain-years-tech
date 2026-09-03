---
feature_id: 074-radar-anchor-search
spec_ref: ./spec.md
status: drafted
created_at: '2026-09-03'
updated_at: '2026-09-03'
adr_refs: ['0032', '0043', '0062']
context7_verified: []
---

# Implementation Plan: 雷达页锚搜索 —— 题头搜索入口 + 底部浮层按名称直达锚详情

<!--
This plan is PROSE-ONLY. The data model lives in schema.prisma (SoT); the API
surface lives in @nestjs/swagger decorators → OpenAPI (code-first SoT, per
docs/conventions/api-contract.md). Do NOT mirror either into this file — capture
DESIGN INTENT + decisions in prose under Architecture Notes instead.
-->

## Summary *(mandatory)*

锚已 140 只、L 级筛选无法精准定位单只锚 ⇒ 雷达题头温度计旁加搜索入口，底部浮层内按中文名 / 拼音 / 代码模糊搜索**已建锚标的**（含 excluded，跨市场），点提示行直达标的详情。技术路径：optionsdesk ctx 新增一个只读搜索端点（单条 `$queryRaw`：自有锚表 JOIN `marketdata.instrument`，Q7-B 只读直查 + `CROSS-CONTEXT-READ` 标记，谓词复刻已 ship 的 `local-instrument-search.adapter.ts` 三路模糊匹配）+ mobile 新增浮层组件消费 orval 生成 hook。**零 schema 变更、零新依赖、零新 token**。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None | N/A | N/A |

（pg_trgm `%` / `similarity()` 非新引入：extension 已装、`ix_instrument_pinyin_abbr_trgm` GIN 索引已在线上，`apps/server/src/marketdata/local-instrument-search.adapter.ts` 在用。）

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles, OR every violation is justified in the Complexity Tracking table below.

逐条：§I SDD 全步已走（specify → clarify → Mockup → plan，mockup baseline 见 `design/handoff.md`）；§II 每 task 红→绿闭环（测试映射见 D10）；§III task 拆分留给 /speckit-tasks（30min–2h 粒度）；§IV 扁平 + 贫血 + 护城河 —— 新文件全部平铺 `apps/server/src/optionsdesk/`，直注 `PrismaService`，跨 ctx 读走 Q7-B 只读直查 + 标记（与本 ctx 既有 `instrument-name.ts` 同范式，见 D2）；§V 跨端单 PR：server impl + IT + export-openapi + api-client regen + mobile 消费 + 两层验证同 PR 原子 merge。

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: real-boot smoke (PG + Redis up via Testcontainers or equiv) covers each new endpoint at least once. unit + module tests are NOT sufficient.
- [x] **Mobile / Web**: golden-path flow walked in a real Expo simulator / Web browser session for each new user story (P1).
- [x] **Evidence**: planned —— server IT `apps/server/test/integration/optionsdesk-074.anchor-search.it.spec.ts`（Testcontainers 真 PG，经 HTTP 面打新端点）；mobile 金路径 = Playwright hermetic `apps/mobile/e2e/optionsdesk-anchor-search.spec.ts` + 契约冒烟 `apps/mobile/e2e/contract-smoke/074-anchor-search.contract.ts`（生成客户端打 testcontainers 真 server）。impl 完成后回填 commit 链接。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**Evidence**: N/A —— 零新第三方包 / SDK / 工具（见 Dependencies 表）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] **Evidence**: N/A — feature is mono-native（optionsdesk ctx 2026-08 才诞生于 mono，无 meta-repo 前身；spec / plan 内无 Java / Maven / Spring 引用）。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| ADR-0062 (optionsdesk ctx) | 「Open Questions: 无」—— backlog 三项（盘中实时 spot / P3 许愿单 / 历史序列可视化）本片均不触碰 | accepted-as-is | 搜索只读锚表 + instrument 名录，不引入实时价语义，ADR-0048 绊线（强一致同步读）不命中 |

no impacted Open Questions。验证用 `rg -l "Open Question|开放问题" docs/adr/` 扫全量，逐一核对命中文件与本片交集：仅 ADR-0062 属本 ctx，其 Open Questions 段明写「无」（2026-08-01 复审记录同页）。

**Evidence**: 上表 + `docs/adr/0062-optionsdesk-bounded-context.md` §Open Questions。

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。这些组件依赖 NestJS DI lifecycle 顺序 (Guards→Interceptors→Pipes→Filters)，mock 隔离 = 抹掉 PR-79 类 cascade bug 的唯一信号。（本片不新增 lifecycle 组件；沿用类级 `JwtAuthGuard` + `AccountIdThrottlerGuard`，IT 走真 HTTP 面自然覆盖。）
- **MANDATORY INTEGRATION**: 必须用 `Test.createTestingModule({ imports: [<TheModule>] }).compile()` 装一个微型 DI 容器，让被测组件在真实 lifecycle 中触发。`createTestingModule` 之外的"测试" 视同未测试。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 列出的每条分支，**必须**在 integration test 文件中有对应 `it()` 块。100% 路径覆盖 —— 服务端可判分支落 IT，纯 UI 分支落 Playwright / vitest（映射表见 D10，analyze 期逐条 grep 对账）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
> The implementer LLM MUST strictly follow the "Flat + Anemic + Moat" paradigm:
> - **Flat Module**: ALL files live flatly in `apps/server/src/<module>/`. NEVER generate `domain/`, `application/`, `infrastructure/`, or `web/` subdirectories.
> - **Anemic Data & Zero-Class**: Data equals raw Prisma rows (snake_case handled by `@map` in schema.prisma). NEVER generate Domain Classes or Entity Mappers.
> - **No Repositories**: NEVER create Repository interfaces/adapters for your own tables. Inject `PrismaService` directly into UseCases. Put business invariants in pure functions (`*.rules.ts`).
> - **The Moat**: NEVER write `tx.<otherTable>.*`. Cross-context access MUST go through the target module's UseCase (use the Two-step Inspect+Commit saga only when caller validation must sit between read and write) — 本片的例外形态是 catalog **Q7-B 只读直查**（见 D2），除此之外零跨 ctx 写、零 `@Inject()` 对方 use case。

### 🚨 Impl Guardrails（并发 / 安全 / 前端 — 详版见 mono conventions）

- **并发/事务**：本片全只读，无状态转换、无 tx、无 outbox —— **不要**为搜索发明任何写路径或缓存表。
- **安全**：搜索端点挂类级 `JwtAuthGuard` + `AccountIdThrottlerGuard`（登录 + per-account 限流），无新匿名面、无 PII；`q` 只经参数绑定进 SQL（`Prisma.sql` 模板），**禁**字符串拼接。
- **前端（mobile）**：无表单（单 TextInput 非 RHF 场景，同 `ticker-search-picker.tsx` 体例）；复用 `~/theme` token + `~/ui` 原语（`Spinner` / `ErrorRow`）；Orval 函数式 hook；盖 Tab 栏的浮层必用 RN `<Modal transparent>`（playbook §12.2）。→ `../../docs/conventions/mobile-impl-playbook.md`

### Feature-specific decisions（D 系列，implementer 必须遵守）

- **D1 · 端点形态**：`GET /api/v1/optionsdesk/anchors/search?q=<关键词>`，挂既有 `OptionsdeskController`（类级双 Guard 沿用），`@SkipThrottle(skipExcept(OPTIONSDESK_READ_BUCKET))` + `@Throttle({ 'optionsdesk-read-account': { limit: 120, ttl: 60_000 } })`（与 radar / anchors 同 read 桶）。响应 `AnchorSearchResponse { items: AnchorSearchItem[] }`，item 恰好三字段 `ticker / name / lLevelEffective`（FR-006 的服务端半边；**不**下发行情数值）。DTO 落 `optionsdesk.dto.ts`；`q` trim 后为空 → 直接 `items: []`（**不是** 400 —— 空输入是常态分支非校验错误）。`q` 上限 64 字符（超长截断处理，Edge「超长输入」；用 class-validator `@MaxLength` 会变 400，改为 usecase 内截断，宁静默收窄不报错）。
  🚨 **路由声明顺序**：`@Get('anchors/search')` 必须写在 `@Get('anchors/:id')` **之前** —— Nest 按声明序匹配，放后面 `search` 会被 `:id` 吞掉走 `parseAnchorId` → 404，且 typecheck / 单测全绿只有 IT 能抓。IT 里为此固定一条「search 路由不被 :id 吞」的用例。
- **D2 · UseCase 与跨 ctx 读**：新建 `search-anchors.usecase.ts`（`SearchAnchorsUseCase`，直注 `PrismaService`）。单条 `$queryRaw`：`optionsdesk.anchor a JOIN marketdata.instrument i ON i.market = a.market AND i.code = split_part(a.ticker, ':', 2)`。这是 catalog **Q7-B 跨 ctx 只读直查**——`// CROSS-CONTEXT-READ:` 注释挂在 `$queryRaw` 语句**正上方**（探针只认那一处，体例同 `instrument-name.ts`；raw SQL 不含 `prisma.<model>` 成员访问故探针不点火，标记仍必须写——它是传播面登记，`grep CROSS-CONTEXT-` 派生跨 ctx 读边靠它）。名字 / 拼音唯一真相源 = `marketdata.instrument`，**MUST NOT** 往锚表落任何名字列（`instrument-name.ts` 头注释的既有纪律，本片 explored 阶段已与维护者确认锚表零重设计）。
- **D3 · 匹配谓词（复用不发明）**：逐路复刻 `local-instrument-search.adapter.ts`：① `i.code ILIKE <q>%`（前缀）② `i.name / coalesce(i.pinyin_abbr,'') / coalesce(i.pinyin_full,'') ILIKE %<q>%`（子串）③ `i.name % <q>` + `coalesce(i.pinyin_abbr,'') % <q>`（pg_trgm 相似，容错字）。追加一路 ④ `a.ticker ILIKE <q>%`（用户抄全 canonical ticker `hk:007…` 时代码前缀路够不到冒号形态）。排序同源：`(i.code = <q>) DESC → GREATEST(similarity(i.name,<q>), similarity(coalesce(i.pinyin_abbr,''),<q>)) DESC → i.code ASC`；`LIMIT 20`（FR-011 单页上限，Assumptions 拍的 20）。**无 excluded 过滤**（Clarifications 2026-09-03：域判据严格是「有没有锚」）；**无 market 过滤**（FR-005）。
- **D4 · LIKE 转义（有意偏离参照物）**：spec Edge 钉了「`%` `_` 按字面」，而 `local-instrument-search.adapter.ts` 不转义（用户的 `%` 会当通配符）。本片新建 `anchor-search.rules.ts` 纯函数 `escapeLike(q)`（`\` `%` `_` 前加 `\`，SQL 端 `ESCAPE` 显式声明），**只喂给 ILIKE 三路**；trgm `%` / `similarity()` 参数不受 LIKE 语法影响，传原串。这是对参照 adapter 行为的**有意偏离**，理由 = spec 边界条款，勿在 CR 里「顺手对齐回去」。
- **D5 · 名字占位降级**：`name` = code 的注册表占位行**照实返回**（同 `instrument-name.ts`「不特判」纪律）——屏上退化为代号展示，不拼假名。
- **D6 · mobile 入口**：`radar-screen.tsx` 题头右排追加第三个 40×40 Pressable（`testID="optionsdesk-radar-search-button"`），`SearchGlyph` 屏内一次性 stroke SVG（circle + line，形态抄「我的」页 `IconSearch`，体例同本屏 `GearGlyph` —— **不**抽 `~/ui`）。次序 ⚙ 🌡 🔍（mockup 帧 ①；实装无底色，mockup 淡蓝底仅为标注）。
- **D7 · 浮层组件**：新建 `anchor-search-sheet.tsx`：RN `<Modal transparent animationType="slide">` + 底部对齐 sheet（盖 Tab 栏必用 Modal，playbook §12.2）；`TextInput` 250ms 防抖（`useEffect` + `setTimeout`，同 `ticker-search-picker.tsx`）；取数走 orval 生成 hook（`useOptionsdeskControllerSearchAnchors({ q }, { query: { enabled: debounced.length > 0 } })` —— 确切名以 regen 产物为准，**禁**手写 axios）；行点击 → 关 Modal + `router.push(optionsdeskUnderlyingRoute(item.ticker))`（与雷达行同目的地，冒号转义在路由函数内已处理）；遮罩 / 取消 → 关 Modal，雷达页签与筛选 state 天然不动（浮层不触碰 `useRadar`）。
- **D8 · 五态互斥判定下沉纯函数**：`apps/mobile/src/optionsdesk/anchor-search.rules.ts` 的 `searchSheetState({ debouncedQ, isFetching, isError, itemCount }) → 'idle' | 'loading' | 'hits' | 'empty' | 'error'`，浮层组件只 switch 渲染。spec 的「空输入 MUST NOT 显示空态」「失败不关浮层」等分支全部在这个纯函数的 vitest 里穷举（mobile 测试分层：logic-only vitest，**禁**组件 render 测）。
- **D9 · L 徽标复用**：`L_LEVEL_BADGE`（`Record<AnchorResponseLLevelEffective, string>`）从 `radar-screen.tsx` 抽到 `radar.rules.ts` export，雷达行与提示行同 import（复用 ≥2 抽取；`Record` 穷举保证加 L 档编译红）。提示行三字段布局照 mockup 帧 ④（名主位 / code mono 副位 / 徽标靠右）。
- **D10 · 文案**：`optionsdesk-copy.ts` radar 段新增 `search*` 键：入口 a11y label（搜索锚）/ placeholder（名称 / 代码 / 拼音）/ 空态主行（没有匹配的锚）+ 副行（只能搜到已建锚的标的）/ 失败行 / 重试 / 取消。**空输入 ≠ 零命中**两个空态语义分开（state_branches 第 1、4 条）。
- **D11 · 契约链（Constitution §V 单 PR 原子）**：server impl 后 `nx run server:export-openapi` → `packages/api-client` orval regen → mobile 消费，全部同 PR。本响应无 nullable string 字段（`name` 非空，D5 保证），不触发 `@ApiProperty type:'string'` 显式声明坑；regen 后照例全仓 grep mock 工厂看有无手写 mock 需镜像。
- **D12 · 性能与索引（SC-003 1 秒）**：JOIN 起步集 = 锚表（当前 140 行，spec Assumptions 上限约 1000），谓词与排序作用在该量级集合上，planner 走 `uk_anchor_ticker` / `uk_instrument_market_code`；**不新建**任何索引（尤其不建 `name` 的 trgm GIN —— 域太小，Senior Engineer Test）。SC-002（140/140 三形态命中率）与 SC-003（p95 < 1s）在 impl 验证期用**同一个**一次性脚本对 dev 库全量跑一遍（命中率 + 逐查询计时），证据贴 PR 描述，脚本不入仓（一次性操作，per docs-organization evergreen-only）。

### 测试映射（state_branches 10 条 → 落点；analyze 期逐条 grep 对账）

| # | state_branch（缩写） | 落点 |
|---|---|---|
| 1 | 空输入不发起、不显示空态 | vitest `anchor-search.rules.spec.ts`（idle 态）+ Playwright 帧 ② 断言 |
| 2 | 防抖窗口内只最后一次生效 | Playwright（连续输入后仅现最终结果）；防抖计时器逻辑沿既有体例不独测 |
| 3 | 命中 ≥1 排序呈现 | server IT（排序三键 + LIMIT）+ Playwright 帧 ④ |
| 4 | 零命中显式空态零旁路 | server IT（无命中返空 items）+ Playwright 帧 ⑤（断言无 CTA） |
| 5 | 未建锚标的不出现 | server IT（种未建锚 instrument → 不返回） |
| 6 | excluded 锚照常命中零标记 | server IT（种 excluded 锚 → 返回）+ Playwright 行渲染无额外徽标 |
| 7 | 请求失败浮层内提示可重试 | Playwright 帧 ⑥（mock 500 → 错误行 + 重试点通） |
| 8 | 点行关浮层直达详情 | Playwright（router 断言到 underlying 路由） |
| 9 | 关浮层雷达原状 | Playwright（筛选 chips / 页签选中态不变） |
| 10 | 跨市场不受页签筛选约束 | server IT（hk+us 双命中）+ Playwright（港股页签下搜出美股锚） |

另有非分支项：路由不被 `:id` 吞（IT 专用例，D1）、LIKE 转义字面语义（IT + `escapeLike` vitest）、64 字符截断（IT）、契约冒烟 happy-path（`074-anchor-search.contract.ts`：种 instrument + anchor → 生成客户端搜 → 命中断言）。

### 新增 / 触碰文件清单（tasks 拆分的物料面）

- server：`optionsdesk/search-anchors.usecase.ts`（新）· `optionsdesk/anchor-search.rules.ts` + `.spec.ts`（新，escapeLike 等纯函数）· `optionsdesk.controller.ts`（加路由，**插在 `anchors/:id` 前**）· `optionsdesk.dto.ts`（响应 DTO）· `optionsdesk.module.ts`（provider 注册）· `test/integration/optionsdesk-074.anchor-search.it.spec.ts`（新）
- contract：`apps/server/openapi.json`（export 产物）· `packages/api-client/src/generated/**`（regen 产物）
- mobile：`optionsdesk/anchor-search-sheet.tsx`（新）· `optionsdesk/anchor-search.rules.ts` + `.spec.ts`（新）· `radar-screen.tsx`（入口 + SearchGlyph + 挂浮层）· `radar.rules.ts`（L_LEVEL_BADGE 迁入）· `optionsdesk-copy.ts`（文案）· `e2e/optionsdesk-anchor-search.spec.ts`（新）· `e2e/contract-smoke/074-anchor-search.contract.ts`（新）

## Complexity Tracking

> Fill ONLY if Constitution Check reports violations that need justification.

无违反项。唯一体例级注记：D2 的跨 ctx JOIN 属 Q7-B 只读直查的既有放行形态（同 ctx 内 `instrument-name.ts` / `get-thermometer` / `get-underlying-detail` 先例），非新增边界例外。
