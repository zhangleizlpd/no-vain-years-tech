---
feature_id: 070-optionsdesk-offline-ladder
spec_ref: ./spec.md
plan_ref: ./plan.md
status: drafted
created_at: '2026-08-30'
updated_at: '2026-08-30'
---

# Tasks: 070-optionsdesk-offline-ladder（离线档收租阶梯 — 意图视角切 fwd 阶梯呈现、计划/执行同口径）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **架构 canonical**: [`ADR-0068`](../../docs/adr/0068-realtime-narrow-recall-two-stage.md)（本片 = 其 P4 实施载体，序列末片；scope = us 收租离线，hk 排除 per clarify）
**Branch**: `070-optionsdesk-offline-ladder`
**病根一句话**：「同 K 锁多长期限」的判据（净链 + 行军 + 审计）只在实时档——晚上离线做计划看不到推荐、盘中推荐无法与计划对表；本片把 069 管道点亮到 us 收租离线（成员不变、口径诚实），并把「窗不进离线」从文字护栏升为机器双闸。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan §Dx; state_branches n; USn）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环（Constitution §II）；新测试必须证明「能红」（定向变异留档；rebase 后重做）。
- 层级：`[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Contract-Smoke]` / `[Gate]`。
- 🚨 **FR / SC 一律逐条枚举，禁范围记法**（062 实撞纪律沿用）。

## Path Conventions

| 用途 | 路径 |
| --- | --- |
| 报价护栏处置按口径参数化（改） | `apps/server/src/optionsdesk/leg-recall.rules.ts`（+ 同名 spec） |
| march 门控放宽 + 离线口径分派（改） | `apps/server/src/optionsdesk/get-legs.usecase.ts`（+ 同名 spec） |
| DTO：链级 `marchMode` + 描述块改写（改） | `apps/server/src/optionsdesk/optionsdesk.dto.ts` |
| 清链/行军/审计管道（**只读复用，禁改判据**） | `apps/server/src/optionsdesk/leg-fwd-chain.rules.ts` / `leg-march.rules.ts` |
| mobile 行内微标增量 | `apps/mobile/src/optionsdesk/leg-row.rules.ts`（+ `leg-row.tsx` 若需）/ `optionsdesk-copy.ts` |
| mobile 弹层题头口径行 + 模式文案 | `apps/mobile/src/optionsdesk/march-audit-sheet.tsx` + `march-audit.rules.ts` |
| Server IT（**新建**） | `apps/server/test/integration/optionsdesk-070.offline-ladder.it.spec.ts` |
| 契约冒烟（新增用例 + 069 臂语义更新） | `apps/mobile/e2e/contract-smoke/070-offline-ladder.contract.ts` / `069-chain-march.contract.ts` |
| 结构闸（改：新增不变量分支，零新常量） | `scripts/checks/check-optionsdesk-rule-constants.ts` |
| ADR 回写（sunset #6 消费 + 后果收口注记） | `docs/adr/0068-realtime-narrow-recall-two-stage.md` |
| SC-001 回放（local-only 改造复用） | `docs/private/evidence/069-replay-calibration.ts` |

## 🚨 Impl Guardrails（plan §Architecture Notes 摘录，盲写会踩且不会红）

1. **处置按 `priceKind` 分派，🚫 禁由 `realtime` 入参反推档位**（plan §D1；usecase :613-617 既有注释同口径）——回落收盘档随离线口径点亮是 plan 裁决，不是漏判。
2. **剔→标只在收盘口径**（FR-006）——`priceKind==='realtime'` 维持剔出 pool（069 T001 四臂回归禁破）；判据 `isCrossedQuote` 单点不动，动的只是处置。
3. **golden 禁重生成**（FR-012）——全腿/建仓/hk 收租三臂逐字符零 diff（`stable()` 剔新增键 `marchMode`）；us 收租离线**既有字段逐值不变**，新增块单独断言。唯一例外 = 069 冒烟「收盘档恒缺省」臂随本片契约语义演进而更新（PR 描述记录，不是基线造假）。
4. **`marchMode` 链级唯一、nullable**（plan §D2）——🚫 禁挂逐 K；nullable 字段 `@ApiProperty` 显式类型声明（012 纪律，orval objectmap 坑）。
5. **13 类枚举/文案零第二份**（FR-011）——复用 `MarchExclusionCategory` 与 `optionsdesk-copy.ts` 既有 13 类段；🚫 禁为离线新增审计类别或 fork 文案。
6. **窗零渗透**（FR-007）——🚫 禁在离线装配路径 import/调用 `leg-window`；结构闸必须自证能红（临时变异 import → 脚本红 → 移除留档）。
7. **空态核对逐支 grep 禁通读**（FR-010；sdd-authoring 反模式）——051 三支逐支对照「规则内无腿」语义，结论（零改动或微调）落本文件 T006 验收记录。
8. **管道判据零触碰**（FR-005/FR-008）——`leg-fwd-chain` / `leg-march` 判据与 φ/β/γ/`OI_MIN` 参数面**本片只读**；发现管道缺陷 → 停下报 user，🚫 禁顺手改标定值。

## Tasks

- [X] T001 [Server] **召回层剔→标处置参数化**（FR-006; plan §D1; state_branches 4; US2）：`leg-recall.rules.ts` crossed-quote 处置按口径参数化——realtime 口径维持剔出候选（069 原语义），收盘口径下交叉腿**保留在候选输出**（照常派生成行）且**仍进**护栏留痕列表（供 #1 审计与净链除名）；`isCrossedQuote` 判据单点不动。同名 spec **先红后绿**四臂：① 收盘口径交叉腿保留在候选且进留痕列表（剔→标）② realtime 口径交叉腿剔出（069 T001 臂回归护航）③ 两口径留痕列表内容一致（判据单点证据）④ 收盘口径无交叉样本时输出与处置参数无关（恒等护航）→ verify: 四臂先红 → `pnpm exec nx test server` 绿；定向变异（收盘口径也剔）① 臂红留档；`rg -n 'isCrossedQuote' apps/server/src/` 定义恰一处

- [X] T002 [Server-IT] **march 门控放宽 + 离线接线 + 行为闸/回归十臂**（FR-001 server 面, FR-005, FR-006, FR-007 行为闸, FR-008, FR-012, FR-013; plan §D1/§D3; state_branches 1/2/3/4/5/9/10/11; US1）：`get-legs.usecase.ts` 门控 `perspective==='rent' && chain.priceKind==='realtime'` → `perspective==='rent' && market==='us'`，处置口径按 `chain.priceKind` 分派（收盘口径走 T001 剔→标 + 昨结 OI 原值）；回落收盘档随离线口径点亮（plan §D1 裁决）；view 增 `marchMode` 传导（config → view，契约面归 T003）。**新建** `optionsdesk-070.offline-ladder.it.spec.ts`（Testcontainers 真 DI）**先红后绿**十臂：① us 收盘收租 march 非 null、三态判决真落、每个非推荐档**恰一条**审计（SC-004 离线镜像）、行序与门控放宽前逐行相同（FR-013 排序零改动机器判据）② us 收盘收租**既有字段逐值不变 + 行集合恒等**（成员不变 golden 化；新增块单独断言）③ 种 ask≤bid 腿 → 行保留 + 审计 #1 + 净链除名（推荐档计算不含它）；全梯交叉变体 → 判整梯无可成交且全部行仍可见（Edge「净链为空」离线形态）④ hk 收租离线 march 恒 null + 响应 golden 零 diff（`stable()` 剔 `marchMode`）⑤ 全腿/建仓离线 march 恒 null + golden 零 diff ⑥ 离线请求零 vendor 外呼（068 计数臂体例）⑦ 离线响应 `march.audits` 零 #12 + 行级带内外标恒缺省 ⑧ 实时请求整体回落收盘档 → march 点亮且口径 = 收盘（plan §D1 决策臂）⑨ 无收盘链新锚 → 既有空态语义原样（march null、不抛错）⑩ config 切 θ 模式 → view `marchMode` 传导为 θ 值（默认 config → φ 值）→ verify: 十臂先红 → 绿（`pnpm nx test server` 相对 `apps/server` 路径）；🚫 golden 禁重生成

- [ ] T003 [Contract] **链级 `marchMode` 下发 + 描述块改写 + api-client regen**（FR-002, FR-009 契约面; plan §D2; state_branches 7; US3）：`optionsdesk.dto.ts` 增链级 `marchMode`（nullable enum，φ 档界 / θ 年化 argmax 两值；`march===null` 时恒 null；`@ApiProperty` 显式类型 Guardrail 4）；DTO :440-441 一带「只在实时开态 ∧ 收租」描述块随门控放宽同步改写（同源描述两处纪律沿 068 D5，`rg` 扫同源块确认无第三处）；`nx run server:export-openapi` → api-client regen → verify: swagger metadata 单测（controllers-only module 体例）先红后绿；`git diff packages/api-client` 仅本片增量、069 判决/审计枚举零 diff；`pnpm exec nx affected -t typecheck --base=origin/main` 绿

- [ ] T004 [P] [Gate] **结构闸：窗与 fwd 管道互不渗透**（FR-007 结构闸; plan §D3; state_branches 5; US1）：`check-optionsdesk-rule-constants.ts` 新增不变量分支——`leg-fwd-chain.rules.ts` / `leg-march.rules.ts` 的 import 行扫描，命中 `leg-window` 即红（现状零命中，闸钉方向）；守卫表**零新常量**。→ verify: `pnpm exec tsx scripts/checks/check-optionsdesk-rule-constants.ts` exit 0；**自证能红**：临时在 `leg-march.rules.ts` 加 `import {} from './leg-window.rules'` → 脚本红 → 移除（变异留档 Guardrail 6）

- [ ] T005 [Mobile] **报价异常微标 + 弹层口径行 + 模式文案**（FR-003, FR-004, FR-009 呈现, FR-011; plan §D4; state_branches 6/7; US2/US3）：`leg-row.rules.ts` 增「报价异常」微标判定纯函数（该行到期日命中 audits #1 ⇒ 出标；判定不知档位——实时口径交叉腿不在行集合，分支天然离线专属）+ `leg-row.tsx` 微标渲染（若既有劣标槽可复用则零 tsx 改动）；`march-audit.rules.ts` / `march-audit-sheet.tsx` 题头：① 口径行——`blockPriceKind==='eod_close'` 时「基于 {quoteAsOf} 收盘」（FR-003；13 类逐条**不加**尾缀，Guardrail 5 口径一次说清）② φ/闸读数行 mode-aware——`marchMode` 为 θ 时换模式标示文案（默认 φ 态零新元素 = 零噪音）；新文案集中 `optionsdesk-copy.ts`（禁感叹号、中性语气）。vitest **先红后绿**五臂：① #1 命中 ⇒ 微标 / 不命中 ⇒ 无 / `march=null` ⇒ 恒无 ② 口径行文案 = 收盘日期格式化（realtime 口径 ⇒ 无口径行）③ θ 模式 ⇒ 标示文案、φ/null ⇒ 读数行原样 ④ 新 copy 键快照 ⑤ 建仓/全腿行恒无微标（`march=null` 结构护航）→ verify: `pnpm exec nx test mobile` 绿；🚫 `~/ui` 零组件 render 测（分层纪律）

- [ ] T006 [Mobile] **hermetic e2e + 空态三支核对**（FR-001 呈现, FR-010, SC-005; plan §D4; state_branches 1/6/7/8; US1/US3）：Playwright Expo Web hermetic e2e（mockJson 挡网络）**先红后绿**五断言：① mock 离线收租响应（march 有值）→ 收租行推荐章可见 + 劣档微标可见 + 轻点开弹层（离线点亮 golden path）② 弹层题头「基于 …收盘」口径行文本可见 ③ mock `marchMode`=θ → 弹层模式标示出现；默认 mock → 零新元素 ④ mock 含 #1 条目 → 该行报价异常微标可见 ⑤ mock 意图空态 → 051 空态文案原样呈现（非错误红）。**空态三支核对**（FR-010，Guardrail 7）：`optionsdesk-copy.ts:289` 两分支 + :684 第三支逐支 grep 对照「规则内无腿」语义 → 结论（零改动 / 微调 + 理由）落本条验收记录 → verify: e2e 绿（新文件首跑 `--skip-nx-cache`）；核对结论三支逐条列出

- [ ] T007 [P] [Contract-Smoke] **契约冒烟：离线真落 + 069 臂语义更新**（FR-002, FR-012 契约面; plan §D5; US1/US3）：**新建** `070-offline-ladder.contract.ts`——生成的 `@nvy/api-client` 打 testcontainers 真 server（mock provider 档）：① us 收盘收租 `march` 真落（判决 + 至少一条带数值审计条目）+ `marchMode` 有值 ② 建仓/全腿 `march` 恒缺省 ③ 专属 ticker + 末尾自清理；**更新** `069-chain-march.contract.ts` ①臂：「收盘档 march 恒缺省」→「us 收盘收租有值」（契约语义随本片演进，PR 描述记录，Guardrail 3 例外条款）→ verify: `MARKETDATA_PROVIDER=mock RUN_REAL_BACKEND_SMOKE=true pnpm exec nx run mobile:contract-smoke` 绿（红绿时序：新断言先落——T003 regen 前 typecheck 红，regen 后转绿）

- [ ] T008 [Gate] **SC 收口 + 回放 + ADR 回写 + PR 门**（SC-001, SC-002, SC-003, SC-004, SC-005, SC-006; FR-007 ADR 回写; plan §D3/§D5; US1/US2/US3）：① **SC-001**：`069-replay-calibration.ts` 改造为离线管道入口直调（local-only），069 同数据面（2026-08-28 收盘全量，319 梯）逐值对比判决/推荐档/审计类别三面，结论回写 spec 新段「回放实测」；② **SC-002/SC-003/SC-004** = T002 ②③④⑤⑥⑦ 臂 + T004 结构闸，留档引用；③ **SC-005** = T005/T006 臂留档；④ **SC-006**：纯内存旁路结构性论证留档（蓄意不设自动 perf 门——本表登记）；⑤ **ADR-0068 回写**：sunset trigger #6 标注消费（裁决 = 机器双闸，落点 = check 脚本分支 + T002 行为闸臂）+「后果·中性」两档并存句加收口注记 + 决策 1 护栏补机器强制说明；⑥ spec frontmatter `status → implemented` + `updated_at` bump → verify: 回放对比表落 spec；`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache` exit 0 + gate 脚本（server-moat / test-size / optionsdesk-rule-constants / time-semantics / identifier-boundary）全 0

## 依赖与并行

```text
T001 ──→ T002 ──→ T003 ──┬─→ T005 ──→ T006 ──┐
                         └─→ T007 [P] ────────┼─→ T008
T004 [P]（结构闸，独立文件面，T008 前完成即可）┘
```

## state_branches 覆盖预检（analyze 期逐条 grep 的基准）

| branch | 落点 |
| --- | --- |
| 1 离线收租接管道 + 阶梯语义 | T002-①② + T006-① |
| 2 hk 排除 | T002-④ |
| 3 全腿/建仓零改动 | T002-⑤ + T005-⑤ + T007-② |
| 4 成员不变剔→标 | T001 四臂 + T002-②③ |
| 5 窗不进离线双闸 | T004 结构闸 + T002-⑥⑦ 行为闸 |
| 6 口径标/价差降级 | T005-①② + T006-②④ |
| 7 θ 模式被动标示 | T002-⑩ + T003 + T005-③ + T006-③ |
| 8 空态收口 | T006-⑤ + 空态三支核对记录 |
| 9 参数单点/昨结 OI | T002 接线（`resolveMarchParams` 同一入口）+ Guardrail 8 |
| 10 财报零特判（继承） | 结构保证（069 T005 签名 `rg -i earnings` 零命中已锁），不单设臂 |
| 11 无收盘链既有空态 | T002-⑨ |

蓄意零覆盖 / 轻验（防下轮 analyze 误报缺口）：

- **SC-006 响应时间** —— 不设自动 perf 门；管道纯内存 O(n)/K 旁路（069 已论证），T008-④ 结构性论证留档。
- **state_branches 10 财报** —— 069 结构保证继承（行军签名无财报入参 + `rg` 零命中守恒），离线数据面无新分支，不单设 IT 臂。
- **真机盘中过推荐章/弹层** —— 069 挂账事项（Mate50 下个交易时段），非本片验收门；本片真机手动过**离线**推荐章 + 口径行（Gate 0.1）。
- **Edge「单档梯 / 共线段 / 停点回退」** —— 继承 069 结构行为（清链/行军判据本片只读，Guardrail 8），离线零新分支，069 既有性质/IT 臂守恒，不单设臂。

## Implementation Strategy

MVP = T001–T003（server 接线 + 契约——离线判决与模式标示已可由 API 消费）；T004 结构闸独立并行；T005–T007 mobile 呈现与冒烟；T008 回放收口 + ADR 回写。Clear 检查点批次：`T001-T002` / `T003-T004` / `T005-T006-T007` / `T008`（每批次后停顿提醒 /clear，per Constitution §III）。
