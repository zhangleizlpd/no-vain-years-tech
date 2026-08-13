# Specification Quality Checklist: 选约表查询下沉 —— 每视角独立请求 + 响应收窄 + 表达层截断

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-12
**Updated**: 2026-08-13（依 `052` 交付重写 spec 后重跑）
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
      📌 **按仓内体例判过**：本仓 spec 刻意携带代码锚点（`文件:行号`、契约字段名、守门脚本不变量编号）作为**实证**而非实现指令 —— 它们是「这条判据今天长什么样」的可验证引用，缺了就没法在 review 时逐条 grep 核对（per `sdd-authoring.md` 反模式「自审靠通读」）。vanilla 判据在此让位于仓内约定。
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
      📌 同上：本 feature 的「用户」是 owner 本人（solo dev 的自用决策工具），技术锚点对该读者是可读的。
- [x] All mandatory sections completed

## Requirement Completeness

- [x] **No [NEEDS CLARIFICATION] markers remain** —— ✅ **3 项已于 2026-08-13 clarify 闭合**：① `memberCount` **下发**，同一批已取回行上再判定一次（零额外 DB 往返，`FR-009`）· ② `K` 触及数**下发且按异常呈现**，与截断计数不同款（`FR-019c`）· ③ `052` 遗留三项真机判据**本片一并补验**（`FR-036` / `SC-017`）。`status` 已翻 `clarified`。
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
      📌 `SC-002` / `SC-007` 含 `rg` 扫描判据 —— 它们是**可执行的验收手段**而非实现约束（同 `050` `SC-004` / `052` `SC-007` 的先例）。
- [x] All acceptance scenarios are defined（4 个 US 共 **16** 条）
- [x] Edge cases are identified（**8** 条）
- [x] Scope is clearly bounded（§ Out of Scope 逐条列明去向）
- [x] Dependencies and assumptions identified（§ 依赖与前提 7 行 + § Assumptions 7 条）

> 📌 **条数一律实时 grep 得出，不抄历史数字**（per `sdd-authoring.md` 反模式）：`state_branches` **25** · FR **41**（编号有意留组间空档）· SC **17** · AS **16** · Edge **8** · Clarifications **10** 问。

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification（同 Content Quality 首项的仓内体例说明）

## 本次重写的一致性自检（`052` ship 后）

- [x] **`state_branches` 与正文逐条对得上** —— 25 条，其中纯客户端分支（预热时序 / 错误态切换 / 迟到响应）已标明落 e2e 层，沿 `052` T015 对「plan 要求每条落 IT」这一冲突的裁法：**每条有一个 `it()`，落在够得到它的那一层**。
- [x] **零残留已被 `052` 推翻的内容** —— 首版的「行权价筛选」US、「实时 + 防抖」clarify 定案、筛选行 sticky 栈 40dp、「筛后 0 行」空态、四段顺序里的独立「筛选」段、`200`/`800` 两个阈值，均已整条删除而非标注保留。
- [x] **阈值零硬编码** —— 三个视角的截断阈值在 spec 与 plan 内均为「MUST 实测标定」，plan 的常量带 `⏳` 占位标记，收尾由标定 task 扫零命中（`SC-014`）。
- [x] **两条 supersede 已显式登记** —— 047 的「no pagination, no top-N」（`FR-019a`）与「切 Tab 不重新请求」（`FR-019b`），且 `SC-011` 要求 PR body 同步登记。
- [x] **主 plan 的一处订正已回写**（2026-08-13）—— §3 不变量 #4 的前半句已划掉并写明「P4 MUST NOT 照旧字面恢复一个筛选段」，否则下一片会照旧字面去补一条撞守门的路径。

## Notes

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`
- **2026-08-13 全项通过**：原先两条 ❌（3 项待澄清 / 主 plan 订正待回写）均已闭合 —— clarify 三问三答已写回 spec `### Session 2026-08-13`，主 plan §3 不变量 #4 的订正已回写。
- 下一步：`/speckit-plan` 已随 spec 同步更新（`D-API-1` 的 `memberCount` 算法、`D-UI-1` 的 `K` 异常位、`D-TEST-4` 的三项真机）⇒ 可直接进 `/speckit-tasks`。
