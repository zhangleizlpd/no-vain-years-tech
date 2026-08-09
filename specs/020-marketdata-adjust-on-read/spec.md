---
feature_id: 020-marketdata-adjust-on-read
modules: [marketdata]
owners: ['@zhangleizlpd']
depends_on: ['016-marketdata-sync', '019-marketdata-sync-strategy']
status: implemented
created_at: '2026-06-05'
updated_at: '2026-06-05'
migration_refs:
  [
    '20260605_1850_relax_factor_forward_nullable',
    '20260605_1955_drop_factor_forward_and_narrow_adjust_types',
  ]
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: na
web_compat_notes: '纯 server 存储模型 + 读路径内部变更。API contract 零变更（同端点/同参数/同响应形态），mobile 三复权 tab 无感。无 OpenAPI 契约变更、无 mobile 段。'
agent_friction_observed: false
state_branches:
  - 'adjust=none 读: 直读物化行，行为与现状逐字节一致'
  - 'adjust=forward|backward 读: none 行 × 因子读时换算（forward 额外除以最新因子 = 永远全量 rebase）'
  - '零除权史标的读: 无因子版本 → 因子=1，三口径相等'
  - 'exDate 当日读: prevClose 属前一段 → 用前段因子换算（跨段边界显式处理）'
  - '平淡日写: 仅落 none 1 行，零本地推导零复权行'
  - '除权日写: none 1 行落库 + 1 次 transient vendor backward 拉取锚定新因子版本（不写复权行）'
  - '锚定失败: 告警不阻塞，corp 扫描 / eod 命中双触发点下次幂等补锚'
  - 'backfill: none 落库 + backward transient 全段锚定 = 2 次/标的'
  - '存量清退: 因子链回填 + 对拍验证后人工 DELETE 物化复权行（运维步骤非自动迁移）'
---

# Feature Specification: Marketdata 复权存储模型切换（只存 none + 累积因子，读时换算）

> ⚠️ **[ARCHITECTURE PARADIGM (2026-06-05)]**
> 本 feature 的方向与核心决策已由设计沉淀定稿不重开：设计全文 = [06-05-eod-none-plus-factor-design](../../docs/private/plans/2026-06/06-05-eod-none-plus-factor-design.md)（三决策已锁定：**B 累积 backward 因子单真相** / **存量 fwd-bwd 行回填因子后 DELETE** / **本 SDD 流程落地**）；架构决策定格 = [ADR-0051](../../docs/adr/0051-marketdata-adjust-on-read.md)（**supersede ADR-0050 三口径全物化**——同日翻转，权衡史与业界调研留 0050 不删）。这是 019「存因子 + 本地算复权」的终局形态——019 算在**写时**（仍物化三口径行），本 feature 推进到业内主流（Tushare/JoinQuant adj_factor 模式）的**读时**换算，DailyBar 收敛为单口径事实表。**不动 019 的 freshness 画像 / tick gate / SLA 机制**——只改 eod 维度的存储模型与除权锚定方式。落地按 [ADR-0032](../../docs/adr/0032-backend-bounded-context.md) bounded context 边界 + [ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md) Flat + Anemic + Moat 范式。
>
> 🎯 **[流程 — 纯 server 存储模型升级，无 mockup]**
> 本 feature **无 UI**，走 sdd.md 后端业务模块标准流程：`spec → /speckit-clarify → plan → tasks → impl`。**零新读端点、零 OpenAPI 契约变更**（K线端点同参数同响应形态，换算对调用方透明）。验证全走 Testcontainers IT（真 PG，016/019 既有 IT 蓝本）+ mock vendor adapter + env-gated 真 vendor 对拍门。

**Feature Branch**: `020-marketdata-adjust-on-read`
**Created**: 2026-06-05
**Status**: Implemented（clarify 2026-06-05 4Q：① 对拍判据 = 相对误差阈值；② factor_forward 直接 drop；③ adjustTypes/reAdjustLookbackDays 列保留语义收窄；④ 锚定延迟窗口期 forward 最终一致照常服务。**+ implement 期 T001 STOP 裁决 3Q**：自洽比值模型 / per-event 跃变存储 / SC-A02 双判据——见 Clarifications 第二节）
**Module**: `marketdata`（存储模型 + 读路径内部变更；portfolio/其他 context 零代码改动）
**设计源**: [设计沉淀文档](../../docs/private/plans/2026-06/06-05-eod-none-plus-factor-design.md)（目标模型公式 / 改动面 / 预算账 / 清退顺序）
**前置依赖**: [016-marketdata-sync](../016-marketdata-sync/spec.md)（eod 同步语义基线）+ [019-marketdata-sync-strategy](../019-marketdata-sync-strategy/spec.md)（AdjustmentFactor 表 + 比值锚定哲学 + 平淡日 none-only 拉取，本 feature 在其上收敛存储形态）
**Input**:

- 019 已把平淡日 vendor 请求砍到 none-only（16,800 → 5,600），但 forward/backward 仍**物化写库**（3 行/标的/日）——存储 2/3 是确定性变换的冗余。
- 现状 forward 维护有结构性缺陷：每来新除权，vendor 前复权全序列 rebase，`reAdjustBars` 只能 lookback 窗口内重拉重锚，**窗口外历史段 forward 永久停留旧纪元**（混纪元数据）。
- 业内主流（Tushare adj_factor / JoinQuant 因子）= 只存原始价 + 累积后复权因子：后复权因子锚定上市日**永不 rebase**，前复权读时除以最新因子**自动全量 rebase**——比物化形态更正确且零维护。
- 时机与实证（2026-06-05 修正，#346 prod 首跑实测）：prod daily_bar 已有 **4.97M 行 / 1.1GB，其中 forward/backward 占 99.7%**（06-04 深夜 cascade 首跑的重取副产品）——派生冗余实证即本 feature 的直接论据；**none 仅单日深度**（口径深度不对称）→ prod 落地前置 = 先 backfill 补齐 none 历史（读时换算的唯一基底），清退动作 dev + prod 都要做。决策定格 [ADR-0051](../../docs/adr/0051-marketdata-adjust-on-read.md)（supersede ADR-0050 三口径全物化）。

## Context

- **为什么现在做**：019 已 ship 因子表与比值锚定机制（AdjustmentFactor + anchorFactors），「存因子」的地基就位；读时换算只差读路径一跳。prod 灰度未开 eod = 切换窗口最便宜的时点。
- **单一真相消歧**：双因子（forward + backward）per 段存储本质是双真相——forward 因子随每次除权过期，backward 因子永不过期。收敛到累积 backward 单真相后，forward 是纯派生量（`B(t) / B_latest`），首段（上市 ~ 首个除权日）因子隐含 = 1 无需补行。
- **正确性提升而非等价迁移**：读时换算的 forward 永远以「当前最新因子」为基准全量 rebase；现状物化行在 lookback 窗口外停留旧纪元。切换后 forward 语义比现状**更正确**（与 vendor 当前直拉值更接近，差异仅舍入）。
- **019 决策延续**：比值锚定哲学不变但公式修正为 per-event 跃变（2026-06-05 T001 裁决：因子值 = 跨除权日相邻两日双口径比值之比，禁 dividend 公式派生进因子值，对配股/未追踪事件鲁棒）；corp 扫描 / eod 除权命中双触发点幂等不变（019 plan D3/analyze M1）。
- **清退是终局动作**：存量物化 fwd/bwd 行的最后消费者是因子链冷启动回填（读存量行锚因子）——回填改为 transient vendor backward 锚定后，存量行成为纯死数据，验证后清退。

## Clarifications

### Session 2026-06-05

- Q: SC-A02 对拍门判据形态？ → A: **相对误差阈值**——`|derived − vendor| / vendor ≤ ε`，对高低价股一视同仁，吸收 vendor 黑盒舍入；ε 具体数值由 plan 阶段 env-gated probe 实测 vendor 舍入幅度后回填（预期 1e-3~1e-4 量级）。逐字节相等（vendor 舍入规则未公开、逆向脆弱）与绝对误差（对低价股过松/高价股过紧）均否决。
- Q: `factor_forward` 列处置？ → A: **直接 drop**（contract migration）——prod 表为空零风险；forward 是纯派生量，留列必然双真相漂移，且 forward 因子随每次除权过期、「审计」价值为负。
- Q: `adjustTypes` / `reAdjustLookbackDays` 退役形态？ → A: **列保留语义收窄**（surgical）——adjustTypes seed UPDATE 为 `['none']` + 代码不再消费多值；reAdjustLookbackDays 收窄为 transient 锚定拉取窗口上限（仍有真实用途）；schema 注释标 deprecated/新语义。列 drop 收益不抵 contract migration + 016 IT/seed 触点面扩大，未来真要清列走独立 chore。
- Q: 除权已发生但锚定延迟（拉取失败 → 补锚前）窗口期的 forward 服务语义？ → A: **最终一致照常服务**——窗口期 forward 以旧 B_latest 为基准换算照常返回（K线形态不变，仅基准缩放差一比例）；告警 + corp/eod 双触发点幂等补锚后自愈。读时检测降级标记（重复信号 + 热路径开销）与拒绝服务（过度）均否决。

### Session 2026-06-05（implement 期 T001 STOP 裁决 — 模型改判）

T001 probe 实证理杏仁 `fc_rights`/`bc_rights` 为**减法精确复权**（段内 `none − forward` ≡ 每股股息分毫不差；601088 历史 forward 负价格；乘法恒等全 12 样本不成立）且 `bc_rights` 绝对水位锚查询窗口起点——spec 原 Assumptions 两条破坏，触发 STOP。裁决（详 [ADR-0051 修订段](../../docs/adr/0051-marketdata-adjust-on-read.md)）：

- Q: 因子模型走向？ → A: **自洽比值模型（选项 A）**——跨市场统一组合底座摒弃 vendor 减法口径，采用标准乘法比值（Tushare adj_factor 构造法）；核心读时换算公式结构不变，恒等关系由构造自洽成立；API 返回的 fwd/bwd 数值与理杏仁 app 显示为不同口径（比值 vs 减法，业界两口径并存）。
- Q: 因子存储粒度？ → A: **per-event 跃变 `f_i`**（非累积 B_i，非打宽 daily_bar）——`f_i = [bwd(ex)/bwd(ex−1)] ÷ [none(ex)/none(ex−1)]`；跨事件比值是 vendor 数据唯一不变量（窗口平移免疫），乱序补锚局部幂等零级联。读时累积 `B(t) = ∏ f_i (exDate_i ≤ t)`，首个已存事件前 B=1 约定。
- Q: SC-A02 对拍判据？ → A: **双判据**——① per-event `f_i`（candlestick 锚定）vs dividend 端点公式推算 `f̂_i = prevClose×(1+送转股比)/(prevClose−每股股息)` 独立源交叉验证，`|f−f̂|/f̂ ≤ ε = 2e-2`（T001 round-2 实测 139 事件：主体 ≤5e-3，max 1.65e-2 为 vendor 再投资 convention gap；同日多行须聚合后比），>5e-3 离群进 WARN 复核名单；② 自洽恒等 IT 门（fwd = bwd ÷ B_latest 构造性）+ none 逐字节等价（SC-A04）。vs 存量物化行对拍改为**口径差异留档**（减法 vs 比值预期不一致，非通过门）。

## User Scenarios & Testing _(mandatory)_

### User Story 1 — [Server] 读时复权换算（Priority: P1）

K线查询端点对 `forward` / `backward` 口径请求不再读物化行，改为：读 none 行 + 该标的全部因子版本，按「交易日所属因子段」内存换算后返回。`backward(t) = none(t) × B(t)`；`forward(t) = none(t) × B(t) / B_latest`（B_latest = 该标的当前最新版本因子）。无任何因子版本的标的三口径相等。对 API 调用方完全透明——同端点、同参数、同响应形态。

**Why this priority**: 读路径是切换的正确性核心——写路径收窄（US2）前必须先有读时换算承接，否则 forward/backward 请求无数据可服务。

**Independent Test**: Testcontainers PG：seed none 行 + 多版本因子 → 断言 forward/backward 响应值 = 公式换算值（含跨段、exDate 当日 prevClose 边界、首段隐含 1、零因子标的）；`adjust=none` 响应与现状逐字节一致。

**Acceptance Scenarios**:

1. **Given** 标的有多个因子版本且查询窗口跨段，**When** 请求 `adjust=backward`，**Then** 每根 bar 价格字段 = none × B(t)（B(t) = `∏ 跃变 f_i (exDate_i ≤ tradeDate)`；首段无版本 → 1）
2. **Given** 同上，**When** 请求 `adjust=forward`，**Then** 每根 bar 价格字段 = none × B(t) ÷ B_latest（B_latest = 全版本跃变乘积；最新段 forward = none）
3. **Given** 查询窗口内某根 bar 的 tradeDate 恰为除权日，**When** 请求复权口径，**Then** 该根 prevClose 按**前一段**因子换算（与前一根换算后 close 一致）
4. **Given** 零除权史标的（无因子版本），**When** 请求任意复权口径，**Then** 返回值与 none 口径一致，不报错
5. **Given** `adjust=none` 请求，**When** 本 feature 合入，**Then** 行为与现状逐字节一致（直读物化行，零换算开销）
6. **Given** volume/amount/turnoverRate 字段，**When** 复权口径换算，**Then** 不随复权变化直拷（与 019 写时推导语义一致）
7. **Given** 周/月等聚合 period 请求复权口径，**When** 换算执行，**Then** 先日线换算后聚合（聚合语义不变）

---

### User Story 2 — [Server] 写路径收窄：单口径落库 + transient 因子锚定（Priority: P1）

eod 同步所有路径只落 none 口径行：平淡日拉 none 落 1 行（不再本地推导写复权行）；除权命中日拉 none 落 1 行 + **1 次 transient vendor backward 拉取**（不落库）比值锚定新因子版本；backfill 模式 = none 全历史落库 + backward 全历史 transient 拉取锚定全部因子段（2 次/标的）。corp 扫描捕获新 exDate 的触发点同改 transient 锚定。历史因子版本永不改动（累积因子无 rebase）。

**Why this priority**: 与 US1 同为 P1 配对——存储减 2/3 的兑现点；除权日请求 5 → 2、回填 16,800 → 11,200 的预算账载体。

**Independent Test**: Testcontainers PG + mock vendor：平淡日同步断言 DailyBar 仅新增 none 行（零 forward/backward 行）且 vendor 仅收 none 请求；注入新除权事件断言恰 1 次 backward transient 请求 + 因子版本 upsert + 零复权行写入；backfill 断言 2 次/标的 + 全段因子在场。

**Acceptance Scenarios**:

1. **Given** 平淡日（无除权命中），**When** eod 同步执行，**Then** vendor 仅收 none 请求（1 次/标的），DailyBar 仅新增 none 行
2. **Given** 标的除权命中（corp 物化的 exDate 落入窗口），**When** eod 同步执行，**Then** none 行落库 + 恰 1 次 vendor backward 拉取（transient）→ 新因子版本 upsert，既有版本零改动，DailyBar 零复权行
3. **Given** corp 扫描捕获新 exDate，**When** 扫描路径触发锚定，**Then** 与 eod 命中路径同语义（双触发点幂等——同标的同 exDate 重复锚定结果一致）
4. **Given** 锚定的 transient backward 拉取失败（vendor 超时/异常），**When** 同步执行，**Then** none 落库不受影响 + 告警，下次触发（corp/eod 任一）幂等补锚
5. **Given** backfill 模式全量回填，**When** 执行完成，**Then** 每标的 ≤2 次 vendor 请求（none 落库 1 次 + 有除权史标的 backward transient 1 次；零除权史 1 次，analyze L2），有除权史标的全部事件跃变锚定在场
6. **Given** 因子锚定窗口内无双口径同日在场数据（如长期停牌），**When** 锚定执行，**Then** 该版本跳过不产出（不 throw），下次数据补齐幂等补锚（019 FR-S04 可重建性延续）

---

### User Story 3 — [Server] 因子链冷启动重建 + 存量物化行清退（Priority: P2）

因子链冷启动回填改为不依赖存量物化复权行：per 有除权史标的，1 次 transient vendor backward 全历史拉取 + DB none 行 → 全段比值锚定（幂等可重跑）。存量 DailyBar forward/backward 物化行在「因子链回填完成 + 读时换算 vs 存量行对拍验证通过」后分批 DELETE 清退（运维 runbook 人工执行，不进自动迁移）。

**Why this priority**: 终局收尾——清退前系统已双轨可用（读路径不再消费物化行），清退本身只回收存储，不阻塞 US1/US2 价值兑现。

**Independent Test**: Testcontainers PG + mock vendor：seed none 行 + 除权事件（无复权物化行）→ 跑冷启动回填断言全段因子锚定；对拍脚本断言换算值 vs seed 的物化行样本一致。

**Acceptance Scenarios**:

1. **Given** 库内只有 none 行 + 除权事件（无物化复权行），**When** 冷启动回填执行，**Then** 有除权史标的全部因子段锚定在场，零除权史标的零因子行
2. **Given** 回填已跑过一遍，**When** 重跑，**Then** 因子值零变更（幂等）
3. **Given** dev 库存量物化行 + 已回填因子链，**When** 抽样对拍（读时换算 vs 存量物化行），**Then** 数值在容差内一致
4. **Given** 对拍通过，**When** 人工执行分批 DELETE，**Then** 仅 `adjust ≠ none` 行被删，none 行与因子表零触碰，K线三口径请求全部正常服务

---

### Edge Cases

- exDate 当日 bar 的 prevClose 跨段（US1 AS-3 显式覆盖——现状写时推导整根同因子乘存在同款瑕疵，被 vendor 直拉路径掩盖；读时换算必须显式处理）
- 未来 exDate 已物化（corp 周扫提前写入）但尚未到期：读时段查找用 `exDate ≤ tradeDate` 自然排除；锚定在到期命中时才触发
- 查询窗口早于首个因子版本（首段）：因子隐含 = 1，backward = none；forward = none ÷ B_latest
- 同日多除权事件：019 既有语义延续——exDate 去重单版本
- 锚定所需 exDate / 前一交易日数据缺失（停牌 / none 行未落库）：per-event 锚定需两日双口径在场（vendor transient 拉取自带 backward，none 取 DB 行），缺则该版本跳过不 throw，数据补齐后双触发点幂等补锚
- DELETE 清退误删保护：清退脚本 WHERE 条件仅 `adjust ≠ 'none'`，且执行前置条件 = 对拍门通过（runbook 顺序硬约束）

## Requirements _(mandatory)_

### Functional Requirements

- **FR-A01**: eod 同步所有写路径（平淡日 delta / 除权命中 / backfill）MUST 仅持久化 `none` 口径 DailyBar 行；forward/backward MUST NOT 再物化写库。
- **FR-A02**: 复权因子 MUST 以 per-event 跃变 `f_i` 为唯一持久化真相（存跃变非累积值——跨事件比值是 vendor 数据唯一不变量 + 乱序补锚局部幂等，T001 裁决），版本边界 = 除权日；首个已存事件前 B MUST 隐含为 1（无需持久化行）；历史版本 MUST 永不因新除权事件改动。前复权因子列 MUST 直接 drop（clarify ②：可由跃变链派生，保留即双真相；prod 表空 contract 零风险）。
- **FR-A03**: K线读路径 MUST 按 `backward(t) = none(t) × B(t)`、`forward(t) = none(t) × B(t) / B_latest` 读时换算（B(t) = `∏ f_i (exDate_i ≤ t)`，无版本 → 1；B_latest = 全版本跃变乘积，无任何版本 → 1）；`adjust=none` 路径 MUST 与现状行为完全一致。
- **FR-A04**: exDate 当日 bar 的 prevClose MUST 按前一段因子换算；volume/amount/turnoverRate MUST 不随复权变化。
- **FR-A05**: 新除权事件 MUST 触发恰 1 次 transient vendor backward 拉取（不落 DailyBar）完成比值锚定；corp 扫描与 eod 除权命中双触发点 MUST 幂等（同标的同除权日锚定结果一致）；锚定失败 MUST 告警不阻塞 none 落库，后续触发幂等补锚；补锚前窗口期 forward MUST 以旧 B_latest 为基准照常服务（最终一致，clarify ④——不做读时降级检测、不拒绝服务）。
- **FR-A06**: 跃变值 MUST 由跨除权日相邻两日双口径比值之比锚定——`f_i = [bwd(ex)/bwd(ex−1)] ÷ [none(ex)/none(ex−1)]`（ex−1 = 前一交易日；禁 dividend 公式派生进因子值——019 D1 决策延续，对配股/未追踪事件鲁棒，公式仅作 SC-A02 交叉验证）；两日任一缺双口径在场 MUST 跳过不 throw，数据补齐后幂等补锚；同日多事件 MUST 合并单版本（exDate 去重）。
- **FR-A07**: 全量回填 MUST 为 2 次 vendor 请求/标的（none 全历史落库 + backward 全历史 transient 锚定全部因子段）；因子链 MUST 可在仅有 none 行 + 除权事件的库上幂等重建（冷启动，不依赖存量物化复权行）。
- **FR-A08**: API contract MUST 零变更——K线端点同路径/同参数（`adjust=none|forward|backward`）/同响应形态；报价与详情端点（仅消费 none）MUST 零回归。
- **FR-A09**: 存量物化 forward/backward 行清退 MUST 为运维步骤（因子回填 → 对拍验证 → 分批 DELETE 人工执行），MUST NOT 进自动 schema migration；DELETE MUST 仅触碰 `adjust ≠ none` 行。

### Key Entities

- **DailyBar（既有，本 feature 收窄）**：日线事实表收敛为单口径——仅 `none` 行；唯一键含 adjust 列保留（兼容存量与清退过渡期），新写入恒为 none。
- **AdjustmentFactor（019 既有，本 feature 收窄）**：标的 × 除权日 → per-event 复权跃变 `f_i`（单列真相；列名 `factorBackward` 保留、schema 注释标新语义）；前复权因子列退役。版本 append-only（新除权只追加，历史零改动）。
- **SyncDimension（既有，配置语义收窄）**：两字段列保留语义收窄（clarify ③）——多口径拉取配置 seed 收为仅 none + 代码不再消费多值；除权锚定回看窗口字段语义收窄为「transient 锚定拉取窗口上限」；注释标 deprecated/新语义，列 drop 留待未来独立 chore。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-A01**: **存储收敛门**：切换后 DailyBar 新增行数 = 1 行/标的/日（现状 3 行，-66%）；清退完成后库内 `adjust ≠ none` 行数 = 0。
- **SC-A02**: **对拍正确性门**（2026-06-05 模型改判后双判据，详 Clarifications）：① **独立源交叉验证**——抽样标的（含多次除权史）全部 per-event 跃变 `f_i`（candlestick 锚定）vs dividend 端点公式推算 `f̂_i`，`|f − f̂| / f̂ ≤ ε = 2e-2`（T001 round-2 实测回填；同日多行聚合后比；>5e-3 离群进 WARN 复核名单）；② **自洽恒等门**——`forward = backward ÷ B_latest` 与段内收益保真由 IT 断言。vs 存量物化行离线对拍改为**口径差异留档**（减法 vs 比值预期不一致，非通过门）。
- **SC-A03**: **请求预算门**：除权命中标的请求数 5 → 2 次；全量回填 eod 请求 16,800 → **≤11,200**（5,600 none + 有除权史标的数上界，零除权史标的 1 次）；平淡日 5,600 不变（019 SC-S01 口径 ≤ 6,000 维持）。
- **SC-A04**: **零回归门**：`adjust=none` K线响应、报价端点、详情端点与现状逐字节一致；016/019 marketdata IT 全量回归绿。
- **SC-A05**: **读时换算性能门**：K线复权口径请求 P95 延迟相对现状直读物化行无可感知回归（换算为内存乘法，量级 ≤ 数千行 × O(log 版本数)）。

## Assumptions

- ~~vendor 后复权口径锚定上市日、永不 rebase~~ **已修正（T001 实测）**：永不 rebase ✓（5/5 样本截断窗口比对零差异）；但绝对水位**锚查询窗口起点**（非上市日）——跨事件比值才是不变量，per-event 跃变锚定对此免疫。
- ~~vendor 前复权 = 后复权 ÷ 最新累积因子的标准恒等关系成立~~ **已证伪（T001 实测，STOP 触发后改判）**：理杏仁 fc/bc_rights 为减法精确复权，乘法恒等不成立 → 改自洽比值模型（Clarifications 2026-06-05 裁决），恒等关系由构造成立，SC-A02 判据随之重定义。
- ~~prod 基本无存量~~ **已修正（#346 实测）**：prod daily_bar 4.97M 行 / 1.1GB（forward/backward 99.7%）+ none 仅单日深度——清退动作 **dev + prod 都需要**（prod ~4.95M 行分批 DELETE + VACUUM ANALYZE）；prod 落地序 = none 历史 backfill 前置 → `--factors` → 对拍 → 清退（runbook 顺序硬约束，US3）。
- 前复权因子列直接 drop 已定案（clarify ②）。
- 019 灰度 runbook 的「因子回填」步骤由本 feature 的新版冷启动语义替代（runbook 同步更新属本 feature 范围）。
- DELETE 清退分批大小、执行时点由 plan/tasks 阶段定（运维 runbook 细节，不影响行为契约）。

## Out of Scope

- 019 的 freshness 画像 / tick gate / SLA 监控机制——零改动（本 feature 只动 eod 存储模型与除权锚定方式）。
- 分钟线/实时行情、新增复权口径（如等比前复权）。
- K线端点缓存层（读时换算性能足够，SC-A05 失守再议）。
- 跨 context 通用化（ADR-0032 sunset trigger 维持）。
