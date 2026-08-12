# Specification Quality Checklist: 选约表显示口径跟进

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-11
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## 覆盖交叉核对（逐条 grep，非通读）

> per `sdd-authoring.md` 反模式：自审靠通读是系统性盲区，SC 层尤甚。以下为实时扫描结果。

**扫描时点：clarify 后（2026-08-11）。** 5 轮 clarify 各自派生了 FR / SC / state_branch，下表是定案后的实时读数，非 specify 时的旧值。

| 层                  | 条数                                                     | → FR / US 覆盖                                     | 零覆盖登记 |
| ------------------- | -------------------------------------------------------- | -------------------------------------------------- | ---------- |
| `state_branches`    | 21（+3：clarify Q3 / Q4 / 08-12 定案各派生 1）           | 全部落 FR-001–FR-023                               | 无         |
| Clarifications      | 8（08-11 五轮配额用满 + 08-12 mockup 期三条）            | 每条各自落 FR / SC / Out of Scope                  | 无         |
| Acceptance Scenario | 21（US1 ×4 · US2 ×6 · US3 ×5 · US4 ×4 · US5 ×2）         | 全部落 FR                                          | 无         |
| Edge Case           | 7（+1，clarify Q4 派生）                                 | 6 条落 FR；1 条（月度日非交易日前移）**故意零 FR** | ✅ 见下    |
| FR                  | 30（+7：007a / 010a / 011a / 014a / 014b / 017a / 019a） | 全部落 SC 或 US                                    | 无         |
| SC                  | 11（+1：SC-011 表宽零改动）                              | 全部可机械或 UI 断言                               | 无         |

**故意零覆盖登记**（per `sdd-authoring.md`「预期的零覆盖要写明是故意的」）：

- **Edge Case「月度到期日恰好是非交易日被前移」** —— 该情形对客户端**不构成分支**：客户端只消费服务端下发的标，前移与否已在服务端解析完毕。写进 Edge Case 是为了**记录它不该有客户端分支**，正是禁止客户端按「是不是周五」推断的理由（FR-014）。⇒ 不派生 FR、不派生测试。

## 三条本片特有的验收纪律（写进 checklist 免得 plan 阶段漏掉）

1. **SC-002 / FR-002 的「零命中」判据必须先证明它会红** —— 故意在呈现层加一次排序，扫描器必须报出该行；改回后归零。否则「零命中」可能只是扫描面写错了。
2. **SC-008 的文案复核 MUST 人工逐条过** —— 文案断言是自指的（`expect(text).toBe(COPY.x)`），改成什么都绿，测试对这一层**结构性无效**。
3. **SC-009 的占屏判据 MUST 真机测** —— 049 实测网页端 185 vs 真机 161dp，差 13%；用网页端那组数会误判余量，而余量是后续片的。

4. **FR-011a 的措辞是本片唯一的消歧手段** —— 服务端的推荐标判定不看 Tab 成员，故「带推荐标却进不了任何意图 Tab」的腿真实且常见（约五分之一的期限段合格腿被流动性门槛排除）。定案是**照实显示不做视觉区分**，全部消歧压在标的措辞上。⇒ 那句措辞是需求本身，不是文案润色，MUST 在 review 时被当作 FR 逐字过。

## Notes

- 全部检查项通过，无 [NEEDS CLARIFICATION] 遗留。
- **clarify 已完成**，`status` 已转 `clarified`。08-11 五轮（配额用满）：计数与说明落位 / 两个标落位 / 计数是否可操作 / 带标却不在意图 Tab 的腿 / 腿数变多要不要解释。08-12 mockup 期追加一条定案：钉住列取「两字标 + 撤口径徽标」（四种载体实测宽度对比，见 spec Clarifications 与 `design/handoff.md`）。
- **mockup 已产出并通过渲染验证**（`design/051-leg-display-states.dc.html`，**7 帧**，0 新 token，六项探测 + token 探测全清，版本闸 9 次推送全过）。mockup 阶段反向产出三条 spec 决策：钉住列取两字标 + 撤口径徽标（FR-019a）· 两个标同载体不同权重（FR-014b）· 费率列头即口径（FR-017a）。
- 本片范畴来自主 plan §2.3（已按 `049` / `050` 实际交付重划），非凭 P2 行原表述——原表述只写了四项，实际七块。
- 下一步：`/speckit-plan`（mockup 已完成，前端 mockup-first 流程的 Mockup 步已过）。clarify 阶段最担心的那个决策点（计数与就地说明在不进常驻区的前提下放哪）已定案，且顺带发现既有就地说明本就在常驻区内 ⇒ 本片会让常驻区高度**下降**而非持平。
