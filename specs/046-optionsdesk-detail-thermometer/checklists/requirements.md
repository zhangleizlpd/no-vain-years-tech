# Specification Quality Checklist: optionsdesk M2a — 标的详情上半 + 波动温度计

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-02
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

> ⚠️ 一处**有意的偏离**（与 045 同款，非缺陷）：本 spec 保留了 vendor 端点名、维度名、`need_sync` / A′ 等词。理由 = 单人自用项目、user 同时是唯一 stakeholder，且这些名词是**数据供给的硬前置**（写抽象会丢掉「本片必须自建两个维度」这个排期要害）。045 已按同口径通过。

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — **3 项已于 2026-08-02 同日收敛**（Q1 客户端两端点合成 / Q2 CBOE CSV 由 77 直连（已实测）/ Q3 默认 1Y + 服务端 OHLC 时间桶聚合）；其余不确定项在 § Assumptions 内取默认值
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded — § 范围边界 逐条列出 M2b / M3 / M4 归属
- [x] Dependencies and assumptions identified — § 依赖与排期前提 拆成「已就绪」与「本片必须自建」两表，逐条挂 commit / PR 号

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification（同上「有意偏离」注）

## FR ↔ SC ↔ state_branches 交叉覆盖（逐条 grep，非通读）

> per `docs/conventions/sdd.md` 反模式：SC 层是系统性盲区，条数一律实时 grep，预期的零覆盖要写明「故意的」。

| 维度           | 条数                              | 覆盖情况                                                                                               |
| -------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| FR             | 35（FR-001..035，编号连续无缺号） | 全部有对应 acceptance scenario 或 state_branch                                                         |
| SC             | 8（SC-001..008）                  | SC-001/002/003 → US1+US2；SC-004/005/006 → US3；SC-007/008 → 全局约束（impl 期以扫描判定，非交互验收） |
| state_branches | 31                                | 覆盖 IVP 四态 / 指数四态 / 区间时序七态 / 锚卡四态 / 导航二态 / 采集八态                               |
| Clarifications | 15 个 Q 条目 + 1 条 drift 订正    | 与 § Status 声明的「三轮共 15 问」一致（8 + 3 + 4）                                                    |

> 条数为 **2026-08-02 clarify 阶段收敛后实时 grep 值**（历次 stale：起草 29/25 → 第二轮 32/28 → 本轮 34/30）。本轮新增 FR-033（IVP 双算对表，采集侧告警）/ FR-034（IV 显示口径单源 + 禁「IV30d」标注）与 2 条采集分支。**2026-08-02 plan 阶段（D1）再增 FR-027**（指数维度不挂锚闸）+ 1 条分支，原 027–034 顺延为 028–035 ⇒ 35 / 31。

**有意的零覆盖（不是缺口，别在 analyze 时又当缺口补 task）**：

- **SC-001（15 秒读完三件事）** 与 045 的 SC-001 同性质 —— 依赖真 vendor 数据到位后的主观计时，**不作本片验收门**。
- **SC-007（零新依赖）/ SC-008（零盘中实时路径）** 是**代码扫描判据**而非交互验收，不产生 UI 测试用例；对应 task 形态 = lint / grep 断言。

## Notes

- ✅ **2026-08-02 `/speckit-clarify` 已跑完**（4 问：IVP 双算对表 / 窗口→粒度映射 / IV 历史回填深度 / `perf_budgets` 定档），`status` 已由 `draft` 转 `clarified`。
- ✅ `perf_budgets` **已定档** —— 直接套 045 已用真实测数校准的同类档位（40/80 与 50/100），不再走一遍「先验 → 校准」；理由 = Q1 把序列读划走后本片端点退化为点查。端点路径仍为暂定值，impl 后对 `openapi.json` 核实（045 同款处置）。
- 🔧 **clarify 期扫出并订正 1 处 drift**：spec 早期草稿沿用 p1 的「IV 30d」措辞，与 **p3 §9-1 已拍板的口径采纳声明**冲突（数据源是富途标的聚合 IV、**非严格 30d-ATM 锁定**，且明写标注一律写「富途标的聚合 IV」）。全文已订正 + 落 FR-034 作硬约束；对 p3b / p1 原文的**引用**保留其字面措辞并加注，避免错引。
- **下一步：本片是 UI feature** ⇒ MUST 先走 `/mockup-gen` 出 `design/` baseline，再进 `/speckit-plan`（per `docs/conventions/sdd.md` mockup-first）。VIX 半圆表盘与 IVP 分段水平条是新视觉范式，mockup 阶段一并锁渲染方式（能否零新依赖）。
