---
feature_id: 074-radar-anchor-search
spec_ref: ./spec.md
plan_ref: ./plan.md
status: not-started
created_at: '2026-09-03'
updated_at: '2026-09-03'
---

# Tasks: 雷达页锚搜索 —— 题头搜索入口 + 底部浮层按名称直达锚详情

<!--
A task is a 30min–2h single-commit unit of work. Status semantics:
`- [ ]` = pending · `- [X]` = completed (flipped by /speckit-implement).
测试映射总表在 plan.md §测试映射（state_branches 10 条 → 落点）；analyze 期逐条 grep 对账。
-->

## Server

- [X] T001 [Server] **搜索入参纯函数**（FR-009; plan §D1/§D4; Edge「元字符字面」「超长输入」; US1/US2）：新建 `apps/server/src/optionsdesk/anchor-search.rules.ts` —— `normalizeSearchQuery(raw)`（trim + 64 字符截断 + 空 → `null`）与 `escapeLike(q)`（`\` `%` `_` 前加 `\`，配 SQL 端显式 `ESCAPE`）。🚨 `escapeLike` 是对 `local-instrument-search.adapter.ts` 不转义行为的**有意偏离**（spec Edge 钉了字面语义），文件头注释写明出处，CR 勿「对齐回去」→ verify: `anchor-search.rules.spec.ts` 先红后绿（trim / 截断恰在 64 / 空白串 → null / 三个元字符逐个转义 / 已带反斜杠的串不双重转义）；变异留档：`escapeLike` 改恒等函数 ⇒ 转义臂红

- [X] T002 [Server] **SearchAnchorsUseCase + DTO + controller 路由 + module 注册**（FR-001, FR-004, FR-005, FR-006, FR-011, FR-012; plan §D1/§D2/§D3/§D5; US1）：新建 `search-anchors.usecase.ts`（直注 `PrismaService`；`normalizeSearchQuery` 判空短路返 `[]`；单条 `$queryRaw`：`optionsdesk.anchor JOIN marketdata.instrument`，谓词四路 + 排序三键 + `LIMIT 20` 照 plan §D3，`// CROSS-CONTEXT-READ:` 标记挂 `$queryRaw` 语句**正上方**）；`optionsdesk.dto.ts` 加 `AnchorSearchItem { ticker, name, lLevelEffective }` / `AnchorSearchResponse { items }`；`optionsdesk.controller.ts` 加 `@Get('anchors/search')` —— 🚨 **声明必须在 `@Get('anchors/:id')` 之前**（Nest 声明序匹配，plan §D1），read 桶 `@SkipThrottle(skipExcept(OPTIONSDESK_READ_BUCKET))` + `@Throttle(120/60s)`；`optionsdesk.module.ts` 注册 provider → verify: 新增 controller spec 臂（controllers-only module，禁 full boot）先红后绿 —— ① search 方法带 read 桶 throttle 元数据 ② swagger 元数据含 `q` query 参数与响应型；`pnpm nx test server optionsdesk.controller` 绿 + typecheck/lint 绿（路由防吞与行为面归 T003/T004 的 IT）

- [X] T003 [Server-IT] **搜索域与匹配行为真库验证**（FR-003, FR-004, FR-005; plan §D2/§D3/§D5; state_branches 3/5/6/10; US1/US2）：新建 `apps/server/test/integration/optionsdesk-074.anchor-search.it.spec.ts`（Testcontainers 真 PG，种 instrument（含拼音列）+ anchor 双市场夹具，夹具 MUST 含一只**带点代码**标的（`us:BRK.B` 形态，US1-AS3），经 HTTP 面打新端点）六臂 —— ① 中文名 / **单个汉字**（Edge「单汉字」）/ 简拼 / 全拼 / 代码前缀（含带点代码）/ 全 ticker 前缀（`hk:007`）各路命中 ② 同名跨市场双命中（hk+us 两行都在，无 market 过滤）③ 已注册 instrument 但未建锚 ⇒ 不出现 ④ `excluded=true` 的锚 ⇒ 照常命中（响应无任何额外标记字段）⑤ 零命中 ⇒ `items: []`（200 非 404）⑥ name=code 的注册表占位行 ⇒ 照实返回代号 → verify: 六臂先红后绿；🚨 MUST 走 `pnpm nx test server <file>`（禁 `vitest --root`）；变异留档：JOIN 改 LEFT JOIN ⇒ 臂 ③ 红

- [X] T004 [Server-IT] **协议与边界臂**（FR-011; plan §D1/§D4; state_branches 1(server 半边)/3; Edge; US1/US2）：T003 同文件续六臂 —— ① 🚨 **路由防吞**：`GET /v1/optionsdesk/anchors/search?q=x` 返 200 搜索响应而非被 `anchors/:id` 吞成 404（plan §D1 唯一能抓这坑的层）② 排序三键：代码精确命中排第一 → 相似度 → 代码序 ③ 命中数 > 20 ⇒ 截断到 20 ④ `q` 含 `%` / `_` ⇒ 字面匹配（种「A%B」名字的夹具验证）⑤ 超长 `q` ⇒ 按 64 截断后正常匹配、不 500 ⑥ `q` 空 / 纯空白 ⇒ `items: []` 且零 SQL（spy 不可用则以响应为准）→ verify: 六臂先红后绿；变异留档：把 search 路由挪到 `:id` 之后 ⇒ 臂 ① 红（这就是它存在的理由）

## API Client

- [X] T005 [Contract] **契约同步**（plan §D11; Constitution §V）：`nx run server:export-openapi` **然后** `nx affected -t generate` → verify: `git diff --stat packages/api-client/src/generated` 非空且含 anchorSearch 相关产物；全仓 grep mock 工厂确认无手写 mock 需镜像新类型（`rg -l "AnchorSearchResponse|searchAnchors" apps/ packages/ --glob '!**/generated/**'` 结果逐条过目）

## Mobile

- [X] T006 [P] [Mobile] **浮层五态纯函数 + L 徽标迁移**（FR-009, FR-010; plan §D8/§D9; state_branches 1/4/7; US1/US2）：新建 `apps/mobile/src/optionsdesk/anchor-search.rules.ts` —— `searchSheetState({ debouncedQ, isFetching, isError, itemCount }) → 'idle' | 'loading' | 'hits' | 'empty' | 'error'`；`L_LEVEL_BADGE` 从 `radar-screen.tsx` 迁到 `radar.rules.ts` export（`Record` 穷举保持），radar-screen 改 import → verify: `anchor-search.rules.spec.ts` 先红后绿（空输入恒 idle **即使 isError/零命中** / 在途 loading / 命中 hits / 零命中 empty / 失败 error 的互斥全排列）；变异留档：空输入判成 empty ⇒ 「没搜过 ≠ 搜不到」臂红；`pnpm nx test mobile` radar.rules 既有 spec 全绿零修改

- [X] T007 [Mobile] **题头入口 + 浮层骨架**（FR-001, FR-002; plan §D6/§D7/§D10; state_branches 9; US1）：`radar-screen.tsx` 题头右排加第三个 40×40 Pressable（`testID="optionsdesk-radar-search-button"`，`SearchGlyph` 屏内 stroke SVG 抄「我的」页 IconSearch 形态，**无底色** —— mockup 帧 ① 淡蓝底仅为标注）+ `useState` 控浮层；新建 `anchor-search-sheet.tsx` 骨架：`<Modal transparent animationType="slide">` + 遮罩 + 底部 sheet（把手 / 「搜索锚」+ 取消 / 搜索框 TextInput autoFocus + 清空叉），遮罩与取消关浮层；`optionsdesk-copy.ts` radar 段加 `search*` 全部键（plan §D10）→ verify: 新建 `apps/mobile/e2e/optionsdesk-anchor-search.spec.ts` 三条先红后绿 —— ① 点 🔍 开浮层，且未输入时结果区**真空白**：无空态文案、无 spinner（state_branch 1 的 e2e 半边，plan §测试映射行 1）② 取消关闭 ③ 关闭后雷达页签与已选 chips 原状（state_branch 9）；全量 hermetic e2e 绿

- [X] T008 [Mobile] **结果区五态 + 取数 + 行点击直达**（FR-003, FR-005, FR-006, FR-007, FR-008, FR-009, FR-010; plan §D7/§D8/§D9; state_branches 1/2/4/7/8/10; US1/US2）：`anchor-search-sheet.tsx` 接 250ms 防抖（`useEffect`+`setTimeout`，同 `ticker-search-picker.tsx` 体例）+ orval 生成 hook（`enabled: debounced.length > 0`）+ `searchSheetState` switch 渲染五态（idle 真空白 / loading `~/ui` Spinner + 「搜索中…」 / hits 行列表（名 + mono code + `L_LEVEL_BADGE` 徽标，mockup 帧 ④）/ empty 主副两行零 CTA / error 行 + 重试）；行 `onPress` → 关 Modal + `router.push(optionsdeskUnderlyingRoute(item.ticker))` → verify: e2e 续六条先红后绿 —— ① 输入「阿里」mock 双市场两行且**行内无行情数值** ② 空态帧断言**无任何按钮**（sb 4）③ mock 500 ⇒ 错误行 + 重试点通重取（sb 7）④ 点行 ⇒ Modal 关 + 落 underlying 路由（sb 8）⑤ 连续输入防抖 ⇒ route mock 计数只 1 次、旧词结果不闪回（sb 2）⑥ 港股页签 + 已选 L1 筛选下搜出美股 L3 锚（sb 10 UI 半边）；变异留档：`enabled` 去掉 ⇒ 帧 ② 空输入即发请求，臂 ⑤ 计数红

- [X] T009 [Contract-Smoke] **契约冒烟**（plan §D10 表末行; SC-001 机制面; US1）：新建 `apps/mobile/e2e/contract-smoke/074-anchor-search.contract.ts` —— 种 instrument（含 pinyin_abbr）+ 建锚（走既有 API / seed 体例照 072 契约套件），生成客户端 `q=中文名` 搜索 ⇒ 断言命中行三字段逐字对拍（ticker / name / lLevelEffective）+ `q=不存在` ⇒ 空 items；注册进 `run.ts`（`optionsdeskController` 前缀已在 `PREFIX_TO_MODULE`，无需新映射——若冒烟 drift 检查告警则按提示补）→ verify: `RUN_REAL_BACKEND_SMOKE=true nx run mobile:contract-smoke` 全绿（真 server + testcontainers PG）

## E2E / Gate

- [X] T010 [Gate] **SC-002 全量命中率核对 + SC-003 时延采样**（SC-002, SC-003; plan §D12）：一次性脚本（scratchpad，不入仓）对 dev 库全量锚（当前 140）逐只跑中文名 / 交易所代码 / 拼音简拼三形态搜索，断言每形态命中率 100%；**同一趟逐查询计时**，全量（~420 次）时延 p95 < 1s（SC-003 的验证手段——analyze C1 补），超线即归因（谓词 / planner）；任一 miss 即列名单归因（拼音列缺失 / 名字占位 / 转义）并修复后重跑 → verify: 三个 100% 数字 + p95 时延 + 采样明细贴 PR body；spec `## Assumptions` 若与实测口径有出入同步订正

- [ ] T011 [Gate] **PR 门 + 覆盖对账 + frontmatter 收口**（SC-001–SC-004）：`pnpm nx affected -t lint,typecheck,test,build,runtime-smoke --base=origin/main` 全绿（按终态串判定，不只看 exit code）+ `scripts/checks/*.ts` 治理脚本全扫绿（含 `check-server-moat.ts` / `check-test-size.ts` / `check-spec-frontmatters.ts`）；spec `state_branches` 10 条对照 plan §测试映射逐条 grep 到具体 `it()`，覆盖表落 PR body —— 表中 Edge「并发增删快照」一行标注**故意不测**（spec 已定快照语义为规格、无 buildable 面，analyze I1），免得下轮 analyze 再当缺口补 task；spec frontmatter `status: implementing → implemented`、`updated_at` 刷新；PR body 按模板全段复刻，hard-gate 三 checkbox 落实 → verify: 全绿证据串贴 PR body
