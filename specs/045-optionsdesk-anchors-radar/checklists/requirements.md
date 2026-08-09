# Specification Quality Checklist: optionsdesk M1 — 锚管理 + 击球区雷达

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-07-31
**Last run**: 2026-07-31（第 3 轮，`/speckit-clarify` 5 问收敛后）
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

> 保留的工程性内容与理由：「背景」「依赖与排期前提」两段引用了 bounded context / ESLint boundaries / 既有读端锚点。它们是本片的**交付前置条件与依赖事实**（漏了撞 CI 闸、或对不上另一 worktree 的产出），不是实现方案选择。派生公式、数据源选型、表结构、组件设计均未写入。同类保留在 mono 既有 spec（如 044）中已有先例。

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain（3 项已于 2026-07-31 全部收敛，连同另 7 项一并记入 § Clarifications）
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

**第 2 轮变更摘要**（相对第 1 轮）：

1. 3 个 `[NEEDS CLARIFICATION]` 全部消解为具体条款（FR-027 行情契约 / FR-019+FR-020 温度计与 seg 边界 / FR-021 导航入口）。
2. 新增 **US3 期权台入口与全局抽屉**（P1）—— 导航改造从「一句话入口决定」升级为独立可测的交付项，因其牵动 tab 集合、markets 门控、FAB 槽心、灵感入口迁移四处。
3. FR 从 23 条扩到 30 条，新增「App 导航与入口」一组（FR-021…FR-026）。
4. SC 从 7 条扩到 10 条，新增公开版门控（SC-008）、抽屉可达性与零新依赖（SC-009）、灵感零回归（SC-010）；SC-001 标注为「行情接线后生效」，不作本片验收门。
5. 撤回第 1 轮的一处越界默认：原写「excluded → 移出采集工作集」超出 p3b §4.4 原文（判据是「有没有锚」），改为 **excluded 不参与采集闸**（FR-028），决定性理由 = 期权 EOD 无跨日补救、停采造成不可补的历史断层。
6. `modules` 增补 `ideation`（其 tab 入口被迁移，模块倒查应能命中）。
7. `status` 由 `draft` 翻 `clarified`。

**第 3 轮变更摘要**（`/speckit-clarify`，5 问全部作答）：

1. **门控层次**（FR-022 / SC-008）：markets 门控保持纯客户端，server 端点不加第二套 —— 与既有 markets surfaces 同构，实证 `feature-flags.ts:19` 无 server 侧对应开关。
2. **锚修订留痕**（新增 FR-031 / SC-011 / 3 条 state_branch）：字段级变更痕迹，支持按时间点还原当时的 V / W / L 层。不可逆性论证同 Q10。
3. **性能预算**（frontmatter `perf_budgets` 5 条 + 依据注释）：雷达 250/500、锚读 100/200、锚写 150/300、锚删 120/250。业内锚点已联网核实（NN/g 三阈值 · Google RAIL · 移动端端点 p95≤200ms 的 hop 拆分）；明标「回归探测器非 SLA」+ 「impl 后须以实测数校准」。
4. **单票上限的真源矛盾**（改写 FR-001 / FR-003 / FR-006，新增 FR-032 + 2 条 US1 场景 + 5 条 state_branch + 2 条 edge case + 调整 SC-005）：解掉了 p1 §5 P6（`position_cap` 是表单字段）与 §5 P2（单票上限 L 层派生）的冲突 —— 定为两级链 `confidence → L 层 → 单票上限`，任一层可显式人工覆盖，覆盖后停止跟随上游并截断下游自动派生。
5. **复核锚的确认状态**（改写 FR-013 + 5 条 state_branch + 2 条 edge case）：复用定期复审，不新增确认动作；判据 = `spot < W ∧ 最近复审 < 本轮跌破首次观测日`。
6. 连带清理：两处「L 层唯一真源」措辞与新的覆盖机制会读成矛盾，改为「生效 L 层的唯一归属处」。

累计规模（**第 3 轮时点**）：FR 32 条 / SC 11 条 / US 4 条 / state_branches 35 条。FR 编号无重复；`check-spec-frontmatters.ts` 通过。

> ⚠️ **上面这行是时点快照，不是当前值** —— #775/#776/#777 之后已增至 **FR 37 / SC 11 / US 4 / state_branches 47**（2026-08-01 实测）。**引用条数一律以 `spec.md` 实时 grep 为准**，别抄这里的历史数字：045 的 plan 与 tasks 初稿就是抄了「35 条」而与实际 47 条脱节，自查时才发现（覆盖本身是全的，错的只是那个数字）。

**进入 `/speckit-plan` 前需与另一 worktree 对齐的一项**（已写进 spec § 依赖与排期前提，非本 checklist 的失败项）：us 日线是写进既有日线表还是另建新表 —— 前者本片读端零改动，后者需加一条路由。<br>✅ **已落定**（2026-08-01 / #752）：`us_equity_bar` 纯 seed 无 DDL、写进现有 `DailyBar` ⇒ 读端零改动成立，plan 阶段无需加路由。

**第 4 轮：spec ↔ mockup 对齐审计**（2026-08-01，进 `/speckit-plan` 前）

起因：`spec.md` 在 #775 → #776 → #777 三次改了**表单侧语义**（人工值转临时 / 恢复 `position_cap` 人工位 / `confidence_source` 门控），而 `045-anchors-forms.dc.html` 停在 #771 —— 只有 `045-radar.dc.html` 在 #775 跟进了一半（chips + 下拉加载）。审计逐帧核对 10 帧 vs FR/SC，命中 2 条直接矛盾 + 4 条无覆盖。

| #   | 症状                                                                            | 处置                                                                                               |
| --- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | 帧 ⑧ 说明文字讲「覆盖后停止跟随上游、截断下游派生」= 被 FR-006 明令翻转的旧语义 | 改写为 FR-035 三条回落路径                                                                         |
| 2   | 覆盖徽标「已人工覆盖 · 映射档 L2」缺 FR-032 ② 要求的**临时**语义                | 改「人工调整 · 将回落」+ `.dnote` 注脚给回落目标值                                                 |
| 3   | `confidence_source` 门控（FR-001 / US1 场景 3）mockup 零覆盖                    | 帧 ⑦⑧ 落 `model` 只读态、帧 ⑥ 落 `manual` 可改态                                                   |
| 4   | `V` 的人工临时态（FR-035 三处人工位之一）无演示                                 | 帧 ⑧ 补 V 人工位 + 回落目标                                                                        |
| 5   | markets OFF 态（FR-022 / FR-026 / SC-008 / US3 场景 2·6）无帧                   | **新增帧 ⑪**                                                                                       |
| 6   | 模型 import 差异报告（FR-035 路径①）无帧                                        | user 2026-08-01 定 = **脚本产出报告文件、App 内不做** ⇒ spec 措辞收窄 + 登记进 handoff「显式未画」 |

连带 spec 改动 3 处：FR-035 路径① 明确报告形态、对应 state_branch 收窄、FR-025 收窄为「抽屉**菜单区**只承载灵感一项」（user 定：品牌头与用户脚是结构性组成，不计入菜单入口）。

> 📌 **本轮的通用教训**：`sdd.md`「代码是真相源，mockup drift 不算 bug」豁免的是 **mockup vs 最终 RN 代码**（实现之后）。**实现之前 mockup 是 plan 阶段唯一的视觉输入** —— 此时的 spec↔mockup drift 会被 plan 原样继承。故 **`/speckit-plan` 前应过一遍 spec↔mockup 对齐**，尤其当 spec 在 mockup 定稿后又改过语义时（`git log -- <mockup>` 与 `git log -- spec.md` 的最后 commit 一比即知）。
