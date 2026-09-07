---
feature_id: 077-optionsdesk-rent-window-budget
spec_ref: ./spec.md
status: drafted
created_at: '2026-09-07'
updated_at: '2026-09-07'
adr_refs: ['0068', '0064', '0043', '0067']
context7_verified: []
---

# Implementation Plan: 收租候选窗由「码数预算」决定

## Summary _(mandatory)_

零 Δ 面（新锚首日）的收租候选窗从「市价固定比例矩形」换成「语义过滤 → 按行权价档预算裁剪」，消掉 US 159 + HK 30 条静默缺腿与 5 只美股锚的假空态。落点是 `leg-window.rules.ts` 新增一个纯函数 + `leg-retrieval.adapter.ts` 的 bootstrap 分支按 intent 分叉；建仓支与正常日 Δ 带支**一字不动**。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| --- | --- | --- |
| None | N/A | N/A |

本片零新依赖：预算裁剪是纯排序 + 累加，用不到任何库；`Prisma.Decimal` 比较沿用既有用法。

## Constitution Check _(mandatory gate)_

- [x] **Passed** —— 逐条核对：**I SDD** 走完 specify → clarify（3 问已裁决）→ 本 plan；**II TDD** 每个 task 先红后绿 + 定向变异证红（见 Testing Invariants）；**III 原子 task** 拆分见 tasks 阶段，判据是「30min-2h 且可单独 commit」；**IV 模块边界** 全部改动落在 `apps/server/src/optionsdesk/` 内，判据进 `*.rules.ts` 纯函数（ADR-0043），零跨 context 访问；**V 类型同步链** 契约有变（`LegTableResponse` 加**顶层**计数字段，见 §契约与前端）⇒ 走 `api-contract.md` 的 regen 链，不手写镜像。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 本片**不新增 endpoint**，改的是 `/optionsdesk/underlyings/{symbol}/legs` 的内部候选面派生。既有 IT（`optionsdesk-071.hk-realtime.it.spec.ts` 等）已覆盖该端点的真启动路径；本片新增的臂挂进同一批。
- [x] **Mobile / Web**: P1 无 UI 改动（腿多了几条，表照常渲染）；**P2 有** —— 新增的那条裁剪计数行需在真机 / 模拟器走一次。
- [x] **Evidence**: ⚠️ **两类结构上验不到，只能真时段真机验**：① 零 Δ 面本身只在**新锚首日**触发（近 30 天 prod 1447 个「标的×session」整面零 Δ **0 次**）⇒ 无法按需构造，只能等下一次建锚；② 预算裁剪在今日数据上恒不触发（收租窗最大 293 < 上限 399）⇒ 屏上那条计数**没有自然触发场景**。⇒ 两者的自动化断言只能落在夹具层，spec `web_compat_notes` 已写明。真机证据挂到下一次建锚。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** —— 本片零新第三方包 / SDK / 工具（见 Dependencies 表）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] **N/A —— feature is mono-native**：本片触及的文件（`leg-window.rules.ts` / `leg-delta-surface.rules.ts` / `leg-retrieval.adapter.ts` / `optionsdesk.dto.ts` / `leg-picker.rules.ts`）全部是 mono 原生、无 Java/Spring 前身。
- [x] **Evidence**: `rg -l 'org\.springframework|org\.mapstruct|mbw-[a-z]+/src/main/java|@RequestMapping' apps/server/src/optionsdesk/` → **0 命中**。⚠️ 注意 `specs/077-*/plan.md` 会被该 rg 命中 —— 那是**本模板自身的 Gate 0.3 清单文本**，不是真引用。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
| --- | --- | --- | --- |
| **ADR-0068** | Context 段列的 064 范式**四个结构缺口**之一：「`window_over_cap` 余量仅 4.5%」。068 的两段式只在**正常日**那一支替换了 064 的矩形窗，**零 Δ 面那一支至今仍跑 064 的 `0.7–1.05 × spot` 矩形窗** ⇒ 该缺口在 bootstrap 支上从未关闭 | **mitigated** | 本片把预算约束做进窗口定义本身（`FR-005`），该支的余量问题由构造消除。⚠️ 本片**不动** 068 §决策 1 的「窗永不进离线档」护栏（机器闸：`check-optionsdesk-rule-constants.ts` 不变量 #11，钉 `leg-fwd-chain.rules.ts` 不得引用 `leg-window`）—— 本片不碰 fwd 管道 |
| ADR-0068 sunset triggers（fillMode / 建仓实盘反馈 / laddering / φ-exit / vendor 财报）| 逐条核对 | **accepted-as-is** | 五条均未被本片触发：本片不改 bid 口径、不动建仓、不引入 laddering / φ-exit、不碰财报三态 |
| ADR-0067 | 缺失语义（vendor absence）| **accepted-as-is** | 本片不改「取不到」的语义，只改「问谁」 |

**Evidence**: `rg -l 'axis\|bootstrap\|候选窗\|单批上限' docs/adr/*.md` → 0068 为唯一实质相关；其 `sunset_trigger` 逐条读过（`docs/adr/0068-*.md:5-12`）。

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。这些组件依赖 NestJS DI lifecycle 顺序 (Guards→Interceptors→Pipes→Filters)，mock 隔离 = 抹掉 PR-79 类 cascade bug 的唯一信号。
- **MANDATORY INTEGRATION**: 必须用 `Test.createTestingModule({ imports: [<TheModule>] }).compile()` 装一个微型 DI 容器，让被测组件在真实 lifecycle 中触发。`createTestingModule` 之外的"测试" 视同未测试。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 列出的每条分支，**必须**在 integration test 文件中有对应 `it()` 块。100% 路径覆盖 — 不允许漏 cold-boot / 路由根 `/` 等非 happy-path 状态（PR #79 实证 4 层 cascade 始于一个未列状态分支）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
> The implementer LLM MUST strictly follow the "Flat + Anemic + Moat" paradigm:
>
> - **Flat Module**: ALL files live flatly in `apps/server/src/<module>/`. NEVER generate `domain/`, `application/`, `infrastructure/`, or `web/` subdirectories.
> - **Anemic Data & Zero-Class**: Data equals raw Prisma rows (snake_case handled by `@map` in schema.prisma). NEVER generate Domain Classes or Entity Mappers.
> - **No Repositories**: NEVER create Repository interfaces/adapters for your own tables. Inject `PrismaService` directly into UseCases. Put business invariants in pure functions (`*.rules.ts`).
> - **The Moat**: NEVER write `tx.<otherTable>.*`. Cross-context access MUST go through the target module's UseCase.

#### 本片的定位：068 未完成的那一半

ADR-0068 的 Context 把 064 范式的**四个结构缺口**逐条列了出来，其中一条是「`window_over_cap` 余量仅 4.5%」。068 用两段式替换了 064 的矩形窗 —— **但只替换了正常日那一支**。零 Δ 面的 `bootstrapWindowFor` 至今返回的仍是 064 那个 `[0.7×spot, 1.05×spot]` 矩形。⇒ **本片不是新设计，是把 068 的替换做完。** 实现时按「补完既有范式」而非「引入新机制」来读。

#### 落点与分叉

- 判据落 **`leg-window.rules.ts` 的新纯函数**（ADR-0043：判据落 `*.rules.ts`）。签名要点：吃「已按收租召回段过滤的合约集 + `axis` + 预算上限」，吐「被选中的合约集 + 被裁掉的条数」。**两个返回值缺一不可** —— 被裁条数是 `FR-007` 屏上计数的唯一数据源。
- `leg-retrieval.adapter.ts` 的 `surface.kind === 'bootstrap'` 分支**按 intent 分叉**：收租走新函数；**建仓原样调 `bootstrapWindowFor`，一字不动**（`FR-009` / `SC-004`）。
- 🚫 **MUST NOT 顺手把建仓也改了** —— 建仓无行权价上界（`leg-recall.rules.ts:636` `strikeMax: null`），其定义域由有效成本硬门槛在**取价之后**承接，没有可用于 ① 的语义上界。实测建仓窗最大 324 < 399，无需处置。

#### 语义过滤 ① 的上界取「比例项」，不取「结构项」

成色上界的完整定义是 `min( min{K ≥ axis}, axis × 1.03 )`（结构项 ∧ 比例项取严）。**窗口只用比例项 `axis × 1.03`**：

- 它是完整上界的**超集**（`min(a,b) ≤ b`）⇒ 窗不会漏掉判据可能接受的腿，方向安全
- 结构项需要先知道链上有哪些档，而窗口的作用正是**决定去问哪些档**，用它会引入一次多余的往返
- 📌 正常日那一支（`leg-delta-surface.rules.ts` 的 `cap`）**已经是这么做的** —— 本片与它同构，不是新口径

#### 🚨 两个「全仓唯一落点」必须复用，禁止内联重写

- **`resolveCeilingAxis(spot, w)`** —— `axis = min(spot, W)` 的 `min` **全仓恰好出现在这一处**，是 067 SC-003 的机器判据。新函数 MUST 调它，**MUST NOT** 写 `Decimal.min(spot, w)`。
- **`QUALITY_CEILING_SPOT_RATIO`** —— `1.03` 的唯一落点。MUST 引用常量，MUST NOT 写字面量。

#### 预算裁剪：以行权价档为原子单位

Clarifications Q3 裁决。实现要点：

1. 按行权价分组（同档的多个到期日归一组）
2. 档按 `|K − axis|` 升序（同一标的内 axis 是常量 ⇒ 绝对差与相对比排序等价，随便哪个，但**只写一种**）
   - 🚨 **同距并列必须有确定性次级键**：`FR-008` 说「确定性由裁剪单位保证」，那消的是**同档内**的并列；**跨档等距**（axis 两侧对称，如 axis=100 时 K=98 与 K=102）是档为原子之后的**残余并列**，仍会出现。上游 `findMany` 无 `orderBy` ⇒ 输入顺序由 DB 决定、不保证稳定 ⇒ 不定次级键则 `FR-008` 不成立。**裁决：同距取行权价较小者优先**（更深虚 = 收租更保守，与「宁少不多」的裁剪方向一致），配一条断言
3. 逐档累加该档的合约数，**下一档会超预算就停**；跨在边界上的那一档整档不纳入
4. 🚫 **MUST NOT 以合约码为单位裁** —— 同档不同到期日的档距**完全相同**，那是常态；以码为单位会让裁剪线落在档内部，屏上出现同一行权价「10 月有行、12 月整行没有」而无任何解释（窄召回骨架只由入窗合约装配，`leg-retrieval.adapter.ts:531-535`；未入窗的腿**整行不出现**，且 bootstrap 场景库内无收盘档可落 —— 这比 spec Q3 原稿写的「保留收盘档价」更糟，结论因此更成立）

#### 契约与前端

🚨 **本节 2026-09-07 tasks 期改写** —— 原稿把计数落在 `gateCounts` 上，与代码里一条明写裁决相撞（判据见 spec Clarifications Q2 📌 ②）。现落法：

- 计数走 **`LegTableResponse` 顶层字段**（`candidateCapDropped` 的同族兄弟），🚫 **MUST NOT 进 `gateCounts`**：`get-legs.usecase.ts:428-433` 已裁定「保险丝熔断了」这一族蓄意不进 `LegGateCounts`（那两个数答「判据挡下了什么」），本片的预算裁剪是供应方容量上限、不是判据。`optionsdesk-051.gate-counts.it.spec.ts:363` 的 `toEqual` 是这条的机器判据 —— 塞进去当场红。
- mobile 侧仿 `legCandidateCapLine`（`leg-picker.rules.ts:408-412`）新增一个返回 `LegGateCountLine | null` 的函数：**计数为 0 ⇒ 返 null、整条不渲染**。🚫 MUST NOT 塞进 `legGateCountLines()` 的返回数组 —— 那两条恒渲染（0 时出「移出 0 条」），而预算裁剪实测恒不触发，塞进去等于屏上常驻一行恒为 0 的噪声。文案挂 `optionsdesk-copy.ts`（与 `candidateCap` 同族），**无 note 后缀**（「· 仍在全腿视角」已由 spec Q2 📌 ① 撤掉，理由：bootstrap 场景下全腿视角结构上「未就绪」）。
- 屏上「与两道门槛的计数并列」（`FR-007` ②）由**同一版面区块 + 同一行形态**（`LegGateCountLine`）兑现 —— 与 `legTruncationLine` / `legCandidateCapLine` 既有落法一致，`underlying-detail-screen.tsx` 多接一个 prop、不改版面。
- 走 `docs/conventions/api-contract.md` 的 regen 链（openapi → `@nvy/api-client`），**MUST NOT 手写镜像**。
- 🚨 **新增 public 字段必 grep 三类手写镜像**（#379 实撞；本片已逐个查实，落点见 tasks Path Conventions）：contract-smoke **顶层闭合键集**（`optionsdesk-chain-leg-picker.contract.ts:441-487`，按字典序插在 `basis` 与 `candidateCapDropped` 之间）· **golden JSON 基线**（`optionsdesk-064.baseline.json` 3 处 / `optionsdesk-070.baseline.json` 4 处，与 `candidateCapDropped` 同位补 `0`）· mobile e2e **mock 工厂** 7 处（typecheck 逼得出，但**基线与键集逼不出** —— 那两类是 affected 门绿也不绿的一面）。

#### 守卫与既有护栏

- `STRIKE_ENVELOPE_FLOOR_SPOT_RATIO_BY_MARKET` **保留**（建仓仍在用）。收租不再读它 —— impl 后须确认 `check-optionsdesk-rule-constants.ts` **不变量 #9**（钉该文件两个比例的内联形状）仍绿。
- `window_over_cap` fail-closed 守卫（`leg-retrieval.adapter.ts:489`）**保留不动**：建仓仍需要它；收租侧它变成构造上不可达的兜底。🚫 **MUST NOT 因为「收租用不到了」把它删掉**。
- ADR-0068「窗永不进离线档」（不变量 #11）：本片不碰 `leg-fwd-chain.rules.ts`，不受影响。

### 🚨 Impl Guardrails（并发 / 安全 / 前端 — 详版见 mono conventions）

- **并发/事务**：本片是**纯读路径**，零写库、零事务、零 outbox ⇒ 并发条目整体 N/A。
- **安全**：本片不碰凭证 / PII / 比较逻辑 ⇒ N/A。
- **前端（mobile）**：改动仅一处计数行渲染，无表单、无新 port ⇒ RHF / Strangler-Fig 条目 N/A；文案 MUST 进 `optionsdesk-copy.ts`（与既有两条计数同族），**MUST NOT** 内联字符串。

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| 与 071 `SC-004`（美股锚响应逐值相同，零例外）冲突 | 美股收租候选集**必然**变（159 条被挡的腿要放进来），那正是本片要修的 | 「只改港股」被否：实测病灶分布相反 —— 静默缺腿美股 159 条是港股 30 条的 5 倍，且 5 只假空态锚全在美股。只改港股等于放着大头不修。本片 MUST 在 impl 时显式 supersede 071 SC-004 并写明理由（`FR-012`） |
