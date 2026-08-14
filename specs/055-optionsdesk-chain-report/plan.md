---
feature_id: 055-optionsdesk-chain-report
spec_ref: ./spec.md
status: approved
created_at: '2026-08-14'
updated_at: '2026-08-14'
adr_refs: ['0032', '0043', '0053', '0062', '0063', '0064']
context7_verified: []
---

# Implementation Plan: 标的链分析报表

## Summary _(mandatory)_

在期权台二级页栈新增一个**独立只读屏**，把整条期权链按「价外幅度档 × 到期日」聚合成一屏可读的网格 + IV 期限结构曲线，回答「该挂哪段期限 / 价外让到多深 / 哪儿有人接 / 这条链整体贵不贵」。技术路径：**服务端新增一个聚合读端点**，复用 050/052 召回层判据与 047 派生函数零新算法，把 8 × N 个格（而非数百条腿）下发给客户端。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| ---------------------------------------- | ---- | --------------- |
| None                                     | N/A  | N/A             |

`FR-042` / `SC-007` 把「新增第三方运行时依赖数 = 0」写成了验收面。四项本来最容易引依赖的地方各自的复用来源：

| 本来会引什么        | 实际复用                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| 热力图 / 图表库     | 手写 `View` 网格 + `react-native-svg`（**已装**，`reference_gradient_bg_via_rn_svg` 同源）        |
| 冻结列 + 横滑表格库 | ADR-0063 已定的自建范式（单 Pan 手势驱动 shared value），选约表实装即样板                         |
| 统计 / 分位库       | 档界是**常量**不是运行时分位（`FR-019a` 全局固定）⇒ 运行时零统计计算                              |
| 插值库              | ATM IV 是**两点线性插值**（`FR-022`），一个初等表达式 —— 同 `leg-derive.rules.ts` 手写 Φ⁻¹ 的判据 |

## Constitution Check _(mandatory gate)_

- [x] **Passed** — plan honors all constitution principles, OR every violation is justified in the Complexity Tracking table below.

逐条对照：

| 原则                       | 判定                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I · SDD + **Mockup 卡点**  | ✅ specify → clarify（2 轮）→ **Mockup（`design/`，8 帧，已渲染验证）** → 本 plan。UI feature 的 mockup 前置卡点已过。                                             |
| II · Test-First TDD        | ✅ 每 task 红→绿→typecheck/lint→`[X]`→stage→commit 六步闭环。纯函数层先写 `*.rules.spec.ts`。                                                                      |
| III · Atomic Task 30min-2h | ✅ 见下方任务切分意图；网格聚合、曲线、十字线、下钻各自独立可 commit。                                                                                             |
| IV · Module Boundary       | ✅ **单 ctx（`optionsdesk`）**，无跨 ctx 写。唯一跨 ctx 读 = 标的 IV 快照，**复用 046 已有读点**不新开（见 D-CTX-1）。零 repository / 零 Domain Class / 文件平铺。 |
| V · 类型同步链 + 单 PR     | ✅ 跨端 feature ⇒ **单 PR**：server impl + IT + `nx run server:export-openapi` + `packages/api-client` regen + mobile 消费 + 两层验证全部同 PR 原子 merge。        |

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 新端点 `GET v1/optionsdesk/underlyings/:symbol/chain-report` 由 **Testcontainers 真 PG real-boot IT** 覆盖至少一次（`*.it.spec.ts`，size × scope 分类见 `testing.md`）。unit + module 测试不算数。
- [x] **Mobile / Web**: US1（一屏看出机会分布）走 Expo 真实会话 golden path；US3 的三类（真机几何 / 手势归属 / 色阶可分辨）按 spec `web_compat_notes` **MUST 真机验**，web e2e 验不到。
- [x] **Evidence**: 本 plan 阶段为**安排**而非既成事实 —— 证据链接（IT commit / 真机截图）在 impl 期回填到 tasks.md 对应行。锚点已定：server 侧 `get-chain-report.usecase` 的 IT + mobile 侧 `optionsdesk-chain-report.spec.ts`（hermetic）+ `contract-smoke/chain-report.contract.ts`。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** —— 本片零新第三方包（`FR-042` / `SC-007`，逐项复用来源见上方 Dependencies 表）。6Q 卡片的触发条件（引入新 package / SDK / tool）不成立。

**Evidence**: N/A

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A —— feature is mono-native.** 055 无任何前 meta-repo（Java/Spring）血统：它建立在 045–053 这一串**本仓原生**的 optionsdesk feature 之上。

- [x] 无 stale Java class 名 / Maven coords / Maven 目录布局 / Spring `@RequestMapping`
- [x] ADR id 已对照 `docs/adr/` 实存文件核过（本 plan `adr_refs` 六个逐个 `ls` 验证，含订正：`ADR-0064` 起初疑为 plan 内决策号，实为 `docs/adr/0064-optionsdesk-retrieval-layering.md`）
- [x] **Evidence**: `ls docs/adr/ | tail -6` + `rg -c "ADR-0064" docs/adr/*.md`

### Gate 0.4 — ADR-deferred-mitigation Scan Step

🚨 **本 feature 命中两条 sunset_trigger**（不是走过场的 N/A）：

| ADR                                     | Open Question / sunset_trigger 影响                                                                                   | 分类               | Mitigation / next step                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ADR-0063**（冻结列表格横向同步范式）  | trigger #5「出现**第二个**消费该表格范式的 feature（除选约表 / 聚合视图外）→ 把组件从 `optionsdesk/` 上提到 `~/ui/`」 | **accepted-as-is** | 命中，但**上提理由不成立**：上提的判据是 ADR-0030 的包分解 —— 要求**跨 module 真共享**。三个消费方（047/049 选约表、048 聚合视图、055 报表）全在 `apps/mobile/src/optionsdesk/` 内，不跨 module ⇒ 上提到 `~/ui/` 会制造一个零外部 consumer 的公共组件，正是 ADR-0030「单 consumer 候选内联」否掉的形状。<br>**再触发线**：出现 optionsdesk **之外**的 module 要用冻结列横滑表 → 立刻上提，回本行。 |
| **ADR-0064**（选约检索五层架构）        | trigger #4「出现**第二个**消费本分层的 feature → 重审是否把分层上提为通用检索框架」                                   | **accepted-as-is** | 命中，但 055 是**部分消费**：只用第一层（召回判据）+ 047 的派生纯函数，**不走**粗排 / 特征 / 精排 / 表达四层（报表不排序、不截断、不打分）。trigger 的意图是「整条分层被第二个 feature 完整消费」⇒ 上提为通用框架的理由不成立。<br>**再触发线**：某 feature 完整走完五层（含精排 port 的第二个实现）→ 回本行重审。                                                                                 |
| ADR-0062（optionsdesk bounded context） | `## Open Questions` = 「无」                                                                                          | 不适用             | 无待处置项。                                                                                                                                                                                                                                                                                                                                                                                       |

**Evidence**: `rg -n "Open Question" -A 14 docs/adr/0062-*.md`（返回「无」）+ `sed -n '5,18p' docs/adr/0063-*.md` / `docs/adr/0064-*.md`（两份 sunset_trigger 原文已逐条读过）。

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。这些组件依赖 NestJS DI lifecycle 顺序（Guards→Interceptors→Pipes→Filters），mock 隔离 = 抹掉 PR-79 类 cascade bug 的唯一信号。
- **MANDATORY INTEGRATION**: 必须用 `Test.createTestingModule({ imports: [<TheModule>] }).compile()` 装一个微型 DI 容器，让被测组件在真实 lifecycle 中触发。`createTestingModule` 之外的"测试"视同未测试。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 列出的每条分支，**必须**在 integration test 文件中有对应 `it()` 块。100% 路径覆盖 —— 本片 `state_branches` 共 **24 条**（原 19 + 档界标定实测后新增 5：格态随格值重算 / 段外列淡出 / 某格值零非空格 / 全腿年化价内行不着色 / 三计数互斥求和）。⚠️ 这个数**实时 `grep` 得来，别抄**（clarify / 标定后还会改，抄必 stale）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
>
> - **Flat Module**: 全部文件平铺在 `apps/server/src/optionsdesk/`。NEVER 生成 `domain/` / `application/` / `infrastructure/` / `web/` 子目录。
> - **Anemic Data & Zero-Class**: 数据 = 裸 Prisma row。NEVER 生成 Domain Class / Entity Mapper。
> - **No Repositories**: 不为自己的表造 Repository。UseCase 直注 `PrismaService`；业务不变量进 `*.rules.ts` 纯函数。
> - **The Moat**: NEVER 写 `tx.<otherTable>.*`。跨 ctx 访问走对方 UseCase。

---

#### D-API-1 · 新增聚合读端点，**不**复用 legs 端点

`GET v1/optionsdesk/underlyings/:symbol/chain-report`。

三条理由，按分量排：

1. **口径不同且不可调和** —— `FR-005` 要的总体是「过权利金门槛后的**整条链**」，而 053 把 legs 端点定成「**每视角独立请求** + 精排 + **表达层截断**」。要在同一个端点上同时满足两者，只能加一个「不截断、不排序、不分视角」的开关 —— 那等于在一个端点里塞两个契约。
2. **方向相反** —— 053 刚把查询下沉到服务端（`b17b4d6d`）。把 825 条腿甩给客户端自己分箱聚合，是把刚下沉的东西又提回去。
3. **量级** —— 聚合结果是 8 行 × N 列（实测 N = 5–16）个格 + N 个列头 + 一组链级读数，比腿集小**两个数量级**。

📌 **蓄意不做成 legs 端点的 `?mode=report`**：查询参数分叉的两个响应形状，在 OpenAPI 上只能表达成一个联合类型，客户端拿到手还要 narrow —— 而两条路径本来就没有共用的消费者。

#### D-API-2 · 一次请求返**四种格值**，不拆四次

与 053「每视角独立请求」的方向相反，这是**刻意的**，两条理由：

- `FR-010` / `SC-002` 要求切换格值时**行列位置逐格不变**。四次请求 ⇒ 切换时先空后填，且四发的 `spot` / `asOf` 可能落在不同批报价上 ⇒ **骨架会跳**，而那正是本片唯一不能出错的东西。
- 053 拆请求的理由（每视角要各自精排、各自截断、各自的条件三态）在报表上**一条都不成立**：报表不排序、不截断、无可调条件。

⇒ 一次求值产四份格值，**同一个骨架**。

#### D-RECALL-1 · 判据零新增（复用导出函数），但**请求路径与召回排序管线独立**

`FR-045`「选约表的召回判据 MUST 零改动」与「报表的服务端实现独立于业务级召回排序」两条同时成立 —— 它们各管一层：**判据共用，管线不共用**。

落法：

- **骨架**（`FR-005`）= `recallCandidates(context, ['all'], legs, legs.length, { perspective: 'all', criteria: { livenessMin: null } })` —— **全腿视角 + 活性维度显式覆盖为「不限」**。全腿视角的系统默认值只有权利金与活性两维非空（`defaultCriteria`），把活性放开之后，候选集**恰好等于**「过权利金门槛之后的整条链」。<br>🚨 **2026-08-14 T001 实装期订正**：本行原写「= `resolvePremiumFloor(spot)` + `passesPremiumMin(bid, floor)`，两个都是既有导出」—— 那条**实装不出来**。`check-optionsdesk-rule-constants.ts` 不变量 #7（052 FR-003「全仓只有一个 filter 概念」）禁止 `passesPremiumMin(` 出现在 `leg-recall.rules.ts` 之外，`chain-report.rules.ts` 在其扫描面内 ⇒ 照原文写，CI `gate-checks` 必红。两条备选各自出局：改 `leg-recall.rules.ts` 加导出破 `FR-045` 的零改动（与 T005 的 `git diff` 零行断言直接冲突）；放宽守门脚本把一条真守门降级成装饰。<br>📌 换成覆盖法后**约束反而更紧**：骨架与三视角候选集成了**两次口径不同的召回调用**，下方那条「骨架 ≠ 候选集」从一条要靠人记住的纪律变成结构性的事实。
- **四种格值各自的成员集** = `recallCandidates(context, ['all','build','rent'], legs, cap, null)` 拿三视角归属。<br>⇒ 报表侧共 **两次** `recallCandidates` 调用（骨架一次、三视角归属一次），各 `O(n)`。判据仍单点，管线仍独立。
- **到此为止** —— 🚫 报表**不进**粗排 / 特征加工 / 精排 / 表达四层（ADR-0064 决策 1）。它不排序、不打分、不截断，那四层对它没有一层是有意义的。

🚨 **`candidateCap` MUST 传 `legs.length`（= 本次不设上限），🚫 MUST NOT 沿用 `RECALL_CANDIDATE_CAP`**：

`recallCandidates` 内部的 `capCandidates` 在触及上限时会 `slice`。那道保险丝是给**下游排序 / 表达**限流的，而报表的下游是一张 8 × N 的网格 —— **格数由行列数决定，与腿数无关**，天然有界，不需要保险丝。沿用 `3000` 等于给报表塞进一个 `FR-005` 明令不能有的截断。<br>⚠️ **今天碰不到不等于没问题**：实测最大链 825 条，离 3000 还远 ⇒ 这条真出问题时**不会红**（网格照常渲染、数字照常有，只是少了一批腿）。参数本身被刻意设计成必填（「给个默认值就等于忘传时静默无上限」），本片是**显式声明不需要它**，不是忘传。

🚨 **骨架 MUST NOT 从 `recallCandidates` 的 `candidates` 取** —— 那个集合的成员判据是「至少进一个视角」，而过了权利金门槛却被**活性门槛**挡下的腿 `tabs` 为空、不在其中（实测 `us:ACN` 38 条）。拿它当骨架会让那 38 条腿在网格上消失，而 `FR-005` 明确要求它们留在骨架里呈「被门槛挡下」态。**两个集合差 38 条，而两种取法都渲染得出一张完整的网格。**

🚨 **MUST NOT 为此去改 `RecallOutcome` 的形状** —— 那是 050/052/053 三片共用的契约，为本片加字段会让三片一起承担回归风险。调用两个已导出的纯函数零成本。<br>📌 `recallCandidates` 顺带产出的六维边际计数与 `criteriaByTab` 报表**用不上，原样丢弃** —— 这是「复用单一判定处」的合理代价，🚫 不要为了"省"它们去另写一份成员判定。

#### D-AGG-1 · 新纯函数文件 `chain-report.rules.ts`

装六件事，全部无 I/O、无 DI（ADR-0043 §4）：

0. **骨架与列轴** —— 骨架走 `D-RECALL-1` 那次覆盖调用（`chainReportSkeleton`）；列 = 链上实际到期日去重升序，不分箱（`FR-003`）。📌 骨架落在本文件而非 use case，是因为它是纯函数且与行列轴同属「网格总体怎么定」这一层；use case 只编排。
1. **价外档分箱** —— 等距 10%、下界价内 10%（`FR-002`）。`档 = floor((spot − K) / spot × 10)`，下界外单独计数。
2. **格聚合** —— 每格取最优（年化 / 活跃度取 `max`，建仓成色取 `min`，`FR-006`）+ 腿数 + 次优（`FR-027`，格内 < 2 条时显式为 `null` 而非复述最优，`FR-028`）。
3. **三互斥计数**（`FR-034`）—— 顺序即语义：全量 → 权利金挡下 → 骨架 → 行下界外 → 行内 → 活性挡下 → 有值。⚠️ **顺序不可换**：在骨架全域上数「被活性挡下」会与「行下界外」重复计 865 条（实测全池），三个数照样都出得来、只是加不回全量。**求和恒等式 MUST 有单测**（`SC-006`）。
4. **ATM IV 线性插值**（`FR-022`）—— 跨 spot 两侧相邻 strike 插值；缺任一侧 ⇒ 返 `null` ⇒ 曲线该点断开（`FR-023`），🚫 MUST NOT 回落最近档。
5. **格态判定**（`FR-016` / `FR-016a`）—— 有值 / 被门槛挡下 / 无合约；列级的「段外」由列上的 `inBand` 标表达，🚫 不在格上重复。

🚫 **本文件不含色阶判档** —— 那住 client（D-BAND-1）。

#### D-BAND-1 · 色阶档界住 **client**（2026-08-14 定），服务端只下发裸值

档界是**纯呈现**：它把一个数映射到一个颜色，**不参与任何腿的判定**——没有一条腿因为落在哪一档而进出候选集。⇒ 它与 `leg-tier.rules.ts` 的 `tier` 不同类（那个是**判定量**，随视角口径判档、参与呈现之外的语义），不适用同一条「判定住服务端」的先例。

落点：`apps/mobile/src/optionsdesk/chain-report-scale.rules.ts`（纯函数 + 常量）。服务端 DTO **不含 `band` 字段**。

- ✅ **不违反 ADR-0064 不变量 ③**（同一判据两处各算一份必 drift）：档界只有 client 一处算，服务端根本不算 ⇒ 不存在两份。
- ✅ **DTO 更窄**，且改配色 / 改档界不需要 server 发版。

🚨 **三条硬约束，写给 impl**：

- **形态按每种格值各自定**（`FR-019b`）—— 🚫 MUST NOT 四种格值套同一种切法。实测线性等距下最淡档吞掉：建仓成色 7.0% ✅ / 收租年化 52.4% ⚠️ / 全腿年化 96.8% 🚫 / 活跃度 99.2% 🚫。可验判据 = **任一档不得吞掉过半的非空格**（`SC-012`），落成 client 侧纯函数单测。
- **取值 MUST 走跨多业务日的标定**（spec `§Assumptions`）—— 🚫 不得先拍一个数。mockup 里那组是**单日全池分位的占位**，不是标定结果。标定归一个**独立 task**，产出物是 client 侧常量。
- ⚠️ **别踩守门脚本的 mobile 那一臂**：`check-optionsdesk-rule-constants.ts` 对 `apps/mobile/src/optionsdesk/` 扫的是「**客户端是否在自算检索条件默认值**」（052 FR-011）。色阶档界不是检索条件，**不在其扫描面内** —— 但新文件里 🚫 MUST NOT 出现形似「用 spot 推 premiumMin / strikeMax」的表达式，否则会被那一臂命中。<br>📌 档界值**不受**服务端那条「阈值单点子串扫描」约束（它只扫 `apps/server/src/optionsdesk/`）⇒ 与召回层四个阈值撞值无所谓。

#### D-STATE-1 · 格态是**当前格值的函数**，服务端判、随格下发

`FR-016a`。四种成因两级编码：

- **列级**（`FR-009a`）—— 列上带「本列是否落在当前格值对应视角的召回段内」；段外整列淡出。🚫 淡出**不是**裁剪：列仍在、仍参与列数与曲线点数（`FR-020` 的恒等关系不受影响）。
- **格级** —— 段内其余成因（流动性门槛 / 成色上界 / 有效成本硬门槛 / 活性门槛）**归并**进已有的「被门槛挡下」态。代价（段内不再分辨是哪道门槛）是显式接受的：那属于选约表那一层的问题，那里有六维检索条件与逐维边际计数。

🚨 **格态 MUST 随格值重算，MUST NOT 缓存成格的静态属性**（实测全网格填充率：建仓 6.3% / 收租 13.6% / 全腿 41.6%）。

📌 **服务端 / 客户端的分界线在「判定 vs 呈现」，不在「跟不跟格值变」** —— 两者都随格值变，但归属相反，别读成漏改：

| 量         | 归属       | 判据                                                                       |
| ---------- | ---------- | -------------------------------------------------------------------------- |
| **格态**   | **server** | 它是**判定**：哪条腿进哪个视角的候选集，答案由召回判据决定，客户端无从复算 |
| **色阶档** | **client** | 它是**呈现**：把一个数映射到一个颜色，不参与任何腿的判定（D-BAND-1）       |

#### D-SCALE-1 · 「口径不适用」随色阶一起住 client，但判据 MUST **语义化**

`FR-019c`（全腿年化 × 价内 0-10 行不参与色阶）。档界既已移到 client（D-BAND-1），这条**是色阶的一部分**（「不参与色阶」），跟着走 client 才是一致的 —— 服务端仍照常下发该行的读数与腿数。

🚨 **判据 MUST 是语义的，🚫 MUST NOT 按行下标写死**：

- ✅ 正确：`当前格值 === 全腿年化 ∧ 该行的价外档下界 < 0`（= 这是价内那一行）。
- 🚫 错误：`rowIndex === 0`。将来行下界一改（`FR-002` 现为价内 10%），下标写死的版本会**静默错位** —— 而它**照样渲染得出一张表**，只是不着色的换成了别的行。

⇒ 服务端每行 MUST 下发**价外档区间**（下界 / 上界百分数）与对应行权价区间 —— 后者本来就是十字线读数面板要的（`FR-027`），🚫 不是为本条新加的字段。

#### D-CTX-1 · 跨 ctx 读只有一处，且**复用 046 不新开**

页头的链级 IV 分位（`FR-031`）走 046 `get-underlying-detail.usecase.ts` 已有的 `UnderlyingIvReadout` 派生（四态 `available` / `percentile_unavailable` / `missing` / `read_failed` 与 spec 的四态逐字对应）。

🚨 **MUST NOT 在本片新开一条读 marketdata 的路径** —— 那会让同一个读数有两个来源（catalog Q7-B 只读直查的重复），而两边都读得出值。🚨 跨 ctx 读点必须带 `// CROSS-CONTEXT-READ:` 注释（`check-server-moat` 探针硬拦）。🚫 ADR-0053：不跨 ctx import 对方的纯函数。

链数据本身走 **`leg-retrieval.port.ts`**（ADR-0064 决策 4 的检索 port），🚫 不开第二条读链路。

#### D-UI-1 · 独立屏 + 路由 + 合规门控

新路由 `apps/mobile/app/(app)/optionsdesk/chain-report/[symbol].tsx`，与既有 `underlying/[symbol].tsx` 同级，继承 `optionsdesk/_layout.tsx` 的合规 guard ⇒ `SC-009`（开关关闭时深链不可达）自动成立，🚫 不在本屏另写一份判定。

`FR-040` 独立屏而非详情屏内嵌折叠块的理由（详情屏横滑手势覆盖其列表头部，同一手势树两个横滑消费者会相争）已写在 spec，impl 不得回退。

#### D-UI-2 · 手势：横滑复用 ADR-0063，长按判据不看坐标

- 横滑复用选约表那一套（单 Pan 驱动 shared value + counter-translate 冻结列 + clamp + `withDecay` + 指示条），`FR-004` 明写 🚫 不另立第二套。
- 十字线：长按进入 / 拖动移动 / 松手退出（`FR-025`）。🚨 **与横滑靠「是否先长按」区分**（`FR-030`），🚫 MUST NOT 依据触点坐标分流 —— 那是脆逻辑，与选约表横滑那条同一纪律。
- ⚠️ **手势竞争的真实手感只有真机能判**（Expo Web 下 `LongPress` 可驱、`Pan` 需走原始指针事件）⇒ 归真机验收，web e2e 只验状态面。

#### D-UI-3 · 零纵向滚动的高度预算

`FR-041`：越线时**先压曲线、再压页头**，🚫 网格 MUST NOT 纵向滚。mockup 实测 390×844 下已落在一屏内（页头 ~72 + 切换 36 + 曲线 62 + 网格 8×32 + 列头/范围框 ~46 + 页脚 ~72）。⚠️ 真机 vs web 有约 13% 几何差（049 实测 185 vs 161dp）⇒ **余量判定 MUST 用真机那组**。

#### D-DRILL-1 · 下钻

`FR-038` / `FR-039`（全腿 / 活跃度格值下落**全腿视角**）/ `FR-039a`（业务日不一致时显式告知两个时点，复用选约侧已有比对，零新增契约字段）。

✅ **前置依赖已解除**：spec `§Dependencies` 写的「实现 MUST 在选约表请求形状改造合入之后开始」—— 那一片是 `b17b4d6d`（PR #41，053 查询下沉），**已在 main 且已在本分支树内**。

### 任务切分意图（供 `/speckit-tasks`）

按「先纯函数、后编排、再上屏」分层，每条 30min–2h 可独立 commit：

1. `[Server]` `chain-report.rules.ts` 五件事 —— 分箱 / 聚合 / 三计数 / ATM IV 插值 / 格态判定，各自 `*.rules.spec.ts` 先红。三计数的**求和恒等式**是独立断言。
2. `[Server]` `get-chain-report.usecase.ts` —— 编排 port + 召回（`candidateCap = legs.length`）+ 聚合 + 046 IV 读数；假 port 驱动的 usecase spec。**必须有一条断言钉住「不设上限」**，否则 D-RECALL-1 那条纪律没有机器兜底。
3. `[Server]` controller + DTO + swagger 装饰器 —— DTO **四段齐全**：每格 / 每列 / 每行 / **链级读数**（IV 分位与其状态、**现价**、三个业务日时点、三个互斥计数 —— 对应 spec `Key Entities` 第四项，🚫 别只写前三段）。nullable 字段的 `@ApiProperty` **必须显式 `type: 'string'`**（否则 orval 误生 objectmap，012 实证）。DTO **不含 `band`**。
4. `[Server]` Testcontainers 真 PG IT（Gate 0.1）。
5. `[Contract]` `export-openapi` → `packages/api-client` regen（Nx target 依赖链自动传导）。
6. `[Mobile]` `chain-report-scale.rules.ts` —— 四种格值各自的档界形态 + 判档 + 「口径不适用」语义判据（D-BAND-1 / D-SCALE-1）。纯函数先红；`SC-012`「任一档不吞过半」落成断言。
7. `[Mobile]` 网格 + 列头 + 冻结列（复用 ADR-0063 范式）+ 段外列淡出。
8. `[Mobile]` IV 曲线（`react-native-svg`）+ 与列对齐的恒等关系。
9. `[Mobile]` 十字线手势 + 读数面板。
10. `[Mobile]` 页头 / 页脚三计数 / 五种降级态 / 入口行。
11. `[Mobile]` 下钻预填 + 业务日不一致提示（`D-DRILL-1`）。
12. `[Mobile-E2E]` hermetic e2e + `[Contract-Smoke]` 契约冒烟。
13. **`[Mobile]` 色阶档界跨多业务日标定**（独立 task，产出物 = 第 6 步那个文件里的常量取值；D-BAND-1 三条硬约束）。
14. `[Verify]` **真机验收** —— Gate 0.1 里那三类 web 结构上验不到的（真机几何 / 手势归属 / 色阶可分辨），**是开 PR 前的最后一道闸**。

## Complexity Tracking

> Constitution Check 未报违规，本表为空。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --------- | ---------- | ------------------------------------ |
| （无）    | —          | —                                    |
