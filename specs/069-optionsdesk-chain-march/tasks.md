---
feature_id: 069-optionsdesk-chain-march
spec_ref: ./spec.md
plan_ref: ./plan.md
status: drafted
created_at: '2026-08-30'
updated_at: '2026-08-30'
---

# Tasks: 069-optionsdesk-chain-march（清链与行军选档 — 凸包净链、φ+形状行军、逐档可解释）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **架构 canonical**: [`ADR-0068`](../../docs/adr/0068-realtime-narrow-recall-two-stage.md)（本片 = 其 P3 实施载体；决策 5 勘误后 scope = 收租视角）
**Branch**: `069-optionsdesk-chain-march`
**病根一句话**：「同 K 不同到期日选哪条腿」无显式判据（`layeredRanker` 只答腿间怎么排）——净链（护栏/凸包/共线）之上跑 φ+形状行军产出每 K 三态判决，并把排除原因升级为逐档可解释。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan §Dx; state_branches n; USn）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环（Constitution §II）；新测试必须证明「能红」（定向变异留档）。
- 层级：`[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Contract-Smoke]` / `[Gate]`。
- 🚨 **FR / SC 一律逐条枚举，禁范围记法**（062 实撞纪律沿用）。

## Path Conventions

| 用途 | 路径 |
| --- | --- |
| 报价护栏（改：前置于点差闸，全视角） | `apps/server/src/optionsdesk/leg-recall.rules.ts`（+ 同名 spec） |
| fwd 链 + 凸包 + 共线 + 劣标 + 13 类枚举（**新建**） | `apps/server/src/optionsdesk/leg-fwd-chain.rules.ts`（+ 同名 spec） |
| 行军 + 停点闸 + 三态判决 + θ 模式（**新建**） | `apps/server/src/optionsdesk/leg-march.rules.ts`（+ 同名 spec） |
| 接线（改：收租实时旁路挂判决/审计） | `apps/server/src/optionsdesk/get-legs.usecase.ts`（+ 同名 spec） |
| φ 档界引用源（只读，禁改值） | `apps/server/src/optionsdesk/leg-tier.rules.ts` `TIER_FLOORS_BY_BASIS` |
| DTO（改：per-K 判决 + 审计条目下发） | `apps/server/src/optionsdesk/optionsdesk.dto.ts` |
| mobile 行内增量 | `apps/mobile/src/optionsdesk/leg-row.{tsx,rules.ts}` / `optionsdesk-copy.ts` |
| mobile 审计弹层（**新建**） | `apps/mobile/src/optionsdesk/march-audit-sheet.tsx` + `march-audit.rules.ts` |
| Server IT（**新建**） | `apps/server/test/integration/optionsdesk-069.chain-march.it.spec.ts` |
| 契约冒烟（新增用例） | `apps/mobile/e2e/contract-smoke/069-chain-march.contract.ts` |
| 常量守卫（改：β/γ/`OI_MIN` 入表） | `scripts/checks/check-optionsdesk-rule-constants.ts` |

## 🚨 Impl Guardrails（plan §Architecture Notes 摘录，盲写会踩且不会红）

1. **排序零改动**（plan §D2；FR-018）—— 判决是行上叠加标注，🚫 禁改 `layeredRanker` / 禁按推荐重排行序；离线 golden 与建仓 IT **逐字符/逐值不变**，🚫 禁重新生成基线充数。
2. **φ 禁新造数值**（plan §D4；FR-010）—— 只引用 `TIER_FLOORS_BY_BASIS.annualized` 档界（默认 `good`）；β/γ/`OI_MIN` 落 `leg-march.rules.ts` 顶部具名常量入守卫表，🚨 取值避开既有档界值撞车（守门脚本认值不认名）。
3. **形状停 = 截链尾**（FR-007）—— 🚫 禁中段剔除后重连（伪装混合）；停点之后的档保留在审计输出里带原因。
4. **行军起点不设可成交闸**（FR-008）—— OI 闸只作用停点与回退路径；起点设闸 = 短端 thin 误杀，测试会构造该输入。
5. **13 类枚举单点**（plan §D1）—— `MarchExclusionCategory` 只在 `leg-fwd-chain.rules.ts` 定义一处；🚫 禁 DTO / mobile 各抄一份字面量（契约经 regen 传导）。
6. **server 禁拼展示文案**（plan §D3）—— 审计证据 = 结构化数值字段；文案全部落 `optionsdesk-copy.ts`；nullable string 的 `@ApiProperty` **必须显式 `type: 'string'`**（orval objectmap 坑）。
7. **行军签名无财报入参**（FR-012）—— 财报零特判是结构保证：`leg-march.rules.ts` 全文件 `rg -i earnings` 零命中。
8. **建仓零改动**（FR-019；clarify Q4）—— 建仓/全腿响应新字段恒缺省；mobile 建仓行无推荐章无弹层入口；🚫 禁把清链（护栏除外）作用到建仓候选。

## Tasks

- [X] T001 [P] [Server] **报价护栏全域前置**（FR-001; plan §D2; state_branches 1; US1）：`leg-recall.rules.ts` 在流动性闸（`relativeSpread` :284 消费处）之前加 crossed-quote 护栏：`ask ≤ bid ⇒ 剔出候选` 并以结构化留痕返回（`{code, bid, ask}` 列表，供上游拼审计 #1）；三个视角一律生效。同名 spec **先红后绿**四臂：① 交叉报价剔出（bid > ask）② 锁定报价剔出（bid = ask）③ 负 `relativeSpread` 放行路径回归——构造 bid>ask 腿断言其**到不了**点差闸 ④ 建仓视角同样剔除（全域证据）→ verify: 四臂先红 → `pnpm exec nx test server` 绿；定向变异（护栏条件反写 `<`）四臂红留档

- [X] T002 [Server] **fwd 链构造 + 13 类枚举地基**（FR-005 部分, FR-015 枚举; plan §D1; US1）：**新建** `leg-fwd-chain.rules.ts`——`MarchExclusionCategory` 13 类四家族枚举（spec FR-015 表逐条，单点）+ 审计条目结构化类型（类目 + 数值证据字段，nullable per 类目）+ 收租段每 K 到期日梯 → fwd 链构造（相邻档边际费率 = 权利金差/(K−P 准备金口径)/时间差折年；`K−P ≤ 0` / 权利金缺失 ⇒ #13 报价缺失条目非伪造 0）。同名 spec **先红后绿**四臂：① 恒等式性质 `年化₂ = [T₁·年化₁ + (T₂−T₁)·fwd]/T₂` 随机三组逐值 ② 单档梯 fwd 链退化（无相邻档 ⇒ 空链非异常）③ 权利金缺失档 ⇒ #13 条目 + 不进链 ④ 枚举恰 13 成员四家族（编译期 + 运行时双证）→ verify: 四臂先红 → 绿；`rg -n 'MarchExclusionCategory' apps/server/src/` 定义恰一处

- [X] T003 [Server] **凸包剔劣 + 劣档三类标**（FR-002, FR-004; plan §D1; state_branches 2/4; US1）：`leg-fwd-chain.rules.ts` 追加凸包栈扫描（`fwd(进X) < fwd(出X)` ⇒ 弹 X 级联再比，摊还 O(n) 注 Big O）+ 劣档标输出（凹陷支配 #2 / 绝对支配 #3 附疑似陈旧 + 总权利金对比值 / 共线 #4 由 T004 产）——**只标不删**：弹出档带类目与数值证据留在审计输出。同名 spec **先红后绿**四臂：① 深级联构造输入（弹 X 后前档仍劣 ≥ 3 层）终态 fwd 单调递减 ② `while` 误写 `if` 的**定向变异在深级联输入必红**（核心机器不变量留档）③ 绝对支配（总权利金 ≤ 更短档）标 #3 且不从输出消失 ④ 全档合格输入零弹出（护航臂）→ verify: 四臂先红 → 绿

- [X] T004 [Server] **tick 推断 + 共线合并**（FR-003; plan §D1 tick 决策; state_branches 3; US1; Edge 单档/≥3 共线/tick 未知）：`leg-fwd-chain.rules.ts` 追加 tick 推断（梯内全部 bid/ask 的最小正增量公约粒度；无法推断 ⇒ 美股标准档 <$3→0.05 / ≥$3→0.10 兜底）+ 共线判据（节点对弦垂距 `d < tick/(K−bid)` ⇒ 除名并段，合并 fwd = 子段时间加权平均）；非共线段 **MUST NOT** 合并。同名 spec **先红后绿**五臂：① 垂距恰低于阈值 ⇒ 合并且合并值 = 手算时间加权 ② 垂距高于阈值 ⇒ 禁合并（伪装混合否决：30d@20%+150d@8% 构造输入不得并出 180d@10%）③ 连续 ≥ 3 节点共线 ⇒ 合并次序无关（两种扫描序终值相同）④ tick 推断：混合 0.05/0.10 报价梯推出 0.05 ⑤ tick 不可推断 ⇒ 标准档兜底且方向保守（tick 高估 ⇒ 少合并断言）→ verify: 五臂先红 → 绿；合并无损性（并段前后行军停点不变）留 T005 联测臂

- [X] T005 [Server] **行军 + 停点闸 + 三态判决 + θ 模式**（FR-006, FR-007, FR-008, FR-009, FR-010, FR-011, FR-012; plan §D1/§D4; state_branches 5/6/7/8/9/10/11/12/14/15; US2; Edge 回退穿合并段）：**新建** `leg-march.rules.ts`——φ 取 `TIER_FLOORS_BY_BASIS.annualized` 档界引用（默认 `good`，可配置选档界）；β/γ/`OI_MIN` 占位具名常量（标定 T011，值避开既有档界）+ 注册 `check-optionsdesk-rule-constants.ts` 守卫表；行军：延伸 = fwd ≥ φ ∧ 衰减 ≤ β×前段（前段 ≤ 0 ⇒ γ 绝对帽）→ 停截链尾 → 停点 OI 闸（不过闸沿凸包回退；起点无闸）→ 档界终检 → 三态判决（净链空 ⇒ 整梯无可成交）；θ=自身年化 argmax 模式共骨架第二实现；签名无财报入参（Guardrail 7）。同名 spec **先红后绿**十臂：① 主路推荐档 = 前向每天 ≥ φ 的最长档 ② 形状违规停（衰减回升超 β）③ γ 退化分支不因负基准中断 ④ 停点 OI < `OI_MIN` 回退最近过闸档 ⑤ 回退穿已合并段（合并段作单节点）⑥ 整梯无过闸 ⇒ 整梯无可成交 ⑦ 链头 fwd < φ ⇒ 无合格档且起点无 OI 闸（短端 thin 构造输入不误杀）⑧ 全程合格 ⇒ 推荐链尾档 ⑨ 净链空 ⇒ 整梯无可成交 ⑩ 两模式预言机各三行（φ 模式三例逐值 + θ 模式 ≡ 年化 argmax 三例逐值）⑪ 单档净链 ⇒ 行军退化为对该档直接判 φ + 停点闸（Edge 1 后半）→ verify: 十一臂先红 → 绿；`rg -i earnings apps/server/src/optionsdesk/leg-march.rules.ts` 零命中；`pnpm exec tsx scripts/checks/check-optionsdesk-rule-constants.ts` exit 0；T004 合并无损联测臂（并段开/关两跑停点不变）绿

- [ ] T006 [Server-IT] **usecase 接线 + config 面 + 离线/建仓零回归收口**（FR-005, FR-009, FR-010 配置面, FR-011 配置面, FR-013, FR-014 server 侧, FR-017, FR-018, FR-019; plan §D2/§D4; state_branches 12/13/14/16/17/19; US1/US2-AS6/US3-AS 数据面; Edge 财报段/周度混链）：`get-legs.usecase.ts` 在成员判定后、排序旁路插入：`实时开态（含 bootstrap）∧ 收租视角` ⇒ 按 K 分组（成员 + 带外横档 #12 + 护栏留痕 #1）→ T002-T004 清链 → T005 行军 → per-K 判决与审计条目挂响应；离线/建仓/全腿路径零触碰。**config 接线**（clarify Q3 承接）：φ 档界选择与 θ 模式开关走 server 配置读取（默认 φ=`good` 档界、模式=φ；按 config-add 流程落全部位置，UI 不暴露），usecase 读配置传 rules。**新建** `optionsdesk-069.chain-march.it.spec.ts`（Testcontainers 真 DI）**先红后绿**九臂：① 主路：收租实时响应含 per-K 判决 + 逐档审计，每个被剔/被标/未推荐档**恰一条**原因（零无原因排除）② 排序零改动：同请求行序与判决关闭态逐行相同（FR-018 机器判据）③ 建仓视角响应新字段恒缺省 + 既有建仓 IT 断言零 diff ④ 离线（收盘档）响应零 diff（既有 golden 逐字符不变）⑤ bootstrap 宽窗候选照常清链行军 ⑥ 全梯报价剔空 ⇒ 判整梯无可成交 + 审计逐档 #1（clarify Q2 形态）⑦ 带外横档 #12 进审计不进净链 ⑧ 财报段档照常进链无特判分支（审计类目里无财报类）⑨ config 切 θ 模式 ⇒ 响应判决 ≡ 年化 argmax（US2-AS6 config 面；默认配置 ⇒ φ 模式）→ verify: 九臂先红 → 绿（`pnpm nx test server` 相对 `apps/server` 路径）；🚫 golden 禁重生成

- [ ] T007 [Contract] **DTO 判决/审计下发 + api-client regen**（FR-014 契约面, FR-015 前后端一致, FR-016 数据面; plan §D3; state_branches 17/18; US3）：`optionsdesk.dto.ts` 增 per-K 判决数组（strike · 三态枚举 · 推荐档到期日 nullable · 净链小结计数）+ per-K 审计条目数组（到期日/合并段标识 · 13 类枚举 · 结构化数值证据字段 nullable）；全部 nullable/缺省向后兼容；nullable string 显式 `type: 'string'`（Guardrail 6）；`nx run server:export-openapi` → api-client regen → verify: swagger metadata 单测（controllers-only module 体例）先红后绿；`git diff packages/api-client` 仅本片增量、既有枚举零 diff；13 类枚举值与 `MarchExclusionCategory` 逐字一致（生成链传导，`rg` 抽查）；`pnpm exec nx affected -t typecheck --base=origin/main` 绿

- [ ] T008 [Mobile] **行内增量：推荐章 + 劣档灰显 + 文案**（FR-016 行内, FR-019 建仓行零改动; plan §D5; state_branches 4/13; US1）：`leg-row.rules.ts` 增判定纯函数（推荐章/劣标三类从契约字段来，🚫 客户端反推）+ `leg-row.tsx` 收租行推荐章（primary 章 + primary-soft 行底）与劣档灰显微标（凹/陈/并，只标不删不重排）+ `optionsdesk-copy.ts` 新段：13 类原因文案（结构化证据 → 「fwd 6.0% < φ 15%」式格式化）+ 三判决 + 两空态（中性、禁感叹号、禁错误红语气）。vitest **先红后绿**：判定纯函数四臂（推荐/凹/陈/并）+ 建仓行恒无章臂 + 文案映射 13 类逐条快照 → verify: `pnpm exec nx test mobile` 绿；🚫 `~/ui` 零组件 render 测（分层纪律）

- [ ] T009 [Mobile] **审计弹层 + 入口接线 + hermetic e2e**（FR-014 呈现, FR-016 空态, FR-019 无入口; plan §D5; state_branches 9/17/18; US3; mockup 帧③④⑤ baseline）：**新建** `march-audit-sheet.tsx` + `march-audit.rules.ts`（弹层内容组装纯函数：题头判决 chip / 净链小结 / 家族色条逐档行 / φ+闸只读读数行 / 两空态文案）；入口 = 轻点收租视角腿行（实现期先确认腿行无既有 onPress/手势冲突，冲突则行尾 affordance 并在 PR 描述记录）；建仓/全腿行无入口。vitest：组装纯函数五臂（推荐态/无合格档/整梯无可成交双成因/建仓 null）；Playwright hermetic e2e（mockJson 挡网络）**先红后绿**六断言：① 轻点收租行开弹层且逐档行数 = mock 审计条目数 ② 推荐态弹层含推荐 chip + 数值证据文本 ③ 无合格档呈现诚实空态（非错误组件）④ 整梯无可成交双成因判别（OI 文案 vs 报价异常文案）⑤ 建仓行轻点不开弹层 ⑥ 表内可见性：收租行推荐章可见 + 劣档行灰显微标（凹/陈/并）可见（US3-AS3）→ verify: vitest + e2e 绿（新文件首跑 `--skip-nx-cache`）

- [ ] T010 [P] [Contract-Smoke] **契约冒烟**（FR-014 契约对齐, FR-017 离线缺省; plan §D6; US3）：`apps/mobile/e2e/contract-smoke/069-chain-march.contract.ts`——生成的 `@nvy/api-client` 打 testcontainers 真 server（mock provider 档）：① 收盘档请求 per-K 判决/审计字段**恒缺省**（离线零改动的契约证据）② 响应形状含新字段且 13 类枚举类型可判别（编译期证据）③ 专属 ticker + 末尾自清理 → verify: `MARKETDATA_PROVIDER=mock RUN_REAL_BACKEND_SMOKE=true pnpm exec nx run mobile:contract-smoke` 绿（红绿时序：断言先落——旧契约无新字段 ⇒ typecheck 红，T007 regen 后转绿）

- [ ] T011 [Gate] **标定定稿 + SC 收口 + PR 门**（SC-001, SC-002, SC-003, SC-004, SC-005, SC-006, SC-007; plan §D4/§D6; US1/US2/US3）：scratchpad tsx 标定回放（067/068 体例不入仓）：收盘全量真实链构造收租段 K 梯 → 清链 → 行军——① **SC-001**：owner 已留痕真实裁决样本零反序（🚨 **停点：先向 user 取 2026-08-29 对焦裁决原始清单**，样本对逐条回放）② **SC-002**：凸包终态单调零违例 + 共线合并前后判决不变（全量仿真两跑对比）③ β/γ/`OI_MIN` 定稿（带分布依据注释，避开档界撞值）+ φ 默认档界确认，占位常量替换 + 守卫表同步；**SC-003**：IT ① 臂 + 真实链抽样零「无原因排除」留档；**SC-004**：交叉报价放行数为零（T001 臂 + 真实链扫描）；**SC-005**：清链/行军同请求内纯内存完成的结构性论证留档（蓄意不设自动 perf 门）；**SC-006** = T006 ④ 臂 golden；**SC-007**：四参数锚点 + 标定数据面落 spec 新段「标定实测」；ADR-0064 不变量 ②③ 核对留档（`rg` 特征单点输出：fwd/凸包/共线各恰一处定义、精排只读特征集）随标定段落 spec；spec frontmatter `status → implemented` + `updated_at` bump → verify: 对比表落盘；`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache` exit 0 + gate 脚本（server-moat / test-size / optionsdesk-rule-constants / time-semantics / identifier-boundary）全 0

## 依赖与并行

```text
T001 [P]（护栏，独立文件面）
T002 ──→ T003 ──→ T004（leg-fwd-chain 同文件簇，串行）──→ T005（march 吃净链类型）
T001 + T005 ──→ T006 ──→ T007 ──┬─→ T008 ──→ T009 ──┐
                                └─→ T010 [P] ────────┴─→ T011
```

## state_branches 覆盖预检（analyze 期逐条 grep 的基准）

| branch | 落点 |
| --- | --- |
| 1 报价护栏全域 | T001 四臂 + T006-①⑥ |
| 2 凸包级联单调 | T003-①② |
| 3 tick-共线合并/禁并 | T004-①②③④⑤ |
| 4 劣档三类只标不删 | T003-③ + T008 灰显 + T009-⑥ 可见性 |
| 5 行军延伸 | T005-① |
| 6 γ 退化 | T005-③ |
| 7 停截链尾 | T005-② |
| 8 停点回退/整梯无过闸 | T005-④⑤⑥ |
| 9 全梯剔空 ⇒ 整梯无可成交 | T005-⑨ + T006-⑥ + T009-④ |
| 10 链头即违规/起点无闸 | T005-⑦ |
| 11 全程合格 ⇒ 链尾档 | T005-⑧（US2-AS5）|
| 12 φ = 收租档界单旋钮 | T005 φ 引用 + T006 收租 only 接线 |
| 13 建仓零改动 | T006-③ + T008 恒无章 + T009-⑤ |
| 14 θ=年化模式预言机 | T005-⑩ + T006-⑨（config 面）|
| 15 财报零特判 | T005 签名 rg + T006-⑧ |
| 16 bootstrap 照常 | T006-⑤ |
| 17 审计零无原因排除 | T006-① + T007 + T011 SC-003 |
| 18 三判决/诚实空态呈现 | T008 文案 + T009-②③④ |
| 19 离线零改动 | T006-④ golden + T010-① |

蓄意零覆盖 / 轻验（防下轮 analyze 误报缺口）：

- **SC-005 响应时间** —— 不设自动 perf 门；清链 O(n)/K + 行军 O(n)/K 纯内存，T011 结构性论证留档。
- **Edge「周度与月度混链」** —— 清链按报价质量处置无周期血统分支（结构性：`leg-fwd-chain.rules.ts` 无 expiry-cycle 入参），T011 标定回放的真实链天然含混链样本，不单设 IT 臂。
- **弹层入口手势冲突** —— 呈现自由度（plan §D5），T009 实现期评估记录，不进 spec 断言。

## Implementation Strategy

MVP = T001–T007（server 判据 + 接线 + 契约——判决与审计已可由 API 消费）；T008–T010 mobile 呈现与冒烟；T011 标定收口。Clear 检查点批次：`T001-T002-T003` / `T004-T005` / `T006-T007` / `T008-T009-T010` / `T011`（每批次后停顿提醒 /clear，per Constitution §III）。
