# Specification Quality Checklist: 意图 Tab 选约表 + 期权链逐日快照管道（M2b）

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-04
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

## Notes

### 三项已于 2026-08-04 收敛（specify 阶段第二轮，全部 [x]）

| 标记 | 位置   | 收敛结果                                                                                 |
| ---- | ------ | ---------------------------------------------------------------------------------------- |
| Q1   | FR-017 | **手选水位档 chip**（按标的持久化 · 未选则停「全腿」+ 提示 · 禁静默假设 · 标为人工输入） |
| Q2   | FR-005 | **虚拟化渲染**（逻辑集合 / 滚动条 / 导出三者全量；只有全腿 Tab 需要）                    |
| Q3   | FR-046 | **当日重试 + 次日盘前兜底一次**，两级都败才 ERROR；第 ② 级前置 = **V-A 真实验证**        |

⚠️ **一个未闭的验证项随之产生**：**V-A —— 盘前窗口能否用于补昨日快照**（登记在 spec § 依赖与排期前提「本片必须先验证」）。它不通过则 FR-046 退回一级补救。**V-A 必须在 plan 阶段之前或之内做完**，因为它决定 FR-046 的形态而非实现细节。

### clarify 阶段再收 4 问（2026-08-04，`status: draft → clarified`）

| Q   | 落点              | 收敛结果                                                                                                                            |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | FR-032            | **到期日不设上限**，全部可得到期日含 LEAPS 一并采（判据同构于「不设行权价带」）                                                     |
| Q2  | FR-045            | 完整性判据由「逐票总行数 `[0.7,1.3]×`」**改判为逐合约覆盖率** —— 原判据在采全到期日后有结构性缺陷（合约集天天变，行数波动是正常态） |
| Q3  | FR-035a / FR-035b | 财报日历**不挂锚闸 + 全市场落库**（市场级接口 + PIT 语义要求连续观察）。**经历 B → C 一次改判**，起因是我给的体量数算错             |
| Q4  | FR-052a           | 快照**全量永久保留 + 磁盘水位告警**，不做抽稀 / 归档 / 分区压缩（不对称性：抽稀不可逆、磁盘可加）                                   |

**连带产生的 plan 阶段硬待办**（都是「拿估算当结论」的债，不清掉会一路带到 impl）：

1. 核实 chain / snapshot 的**真实**限频（现用 10 次/30s 是自设保守值；`history_kline` 因同款最严兜底吃过回填 5/7 失败）
2. 用**含月度到期日次日**的真实样本校准 FR-045 覆盖率阈值（先验起手 100%）
3. **重测 77 剩余磁盘 + 实测单行宽度**，替换 Assumptions 里那张估算表
4. 处置「纵向虚拟化列表嵌在详情页纵向滚动内」的 RN 手势争用（FR-005 明令不得留到 impl 临场发挥）

### 两处 specify 阶段漏写、clarify 时补上（非问答产物）

- **FR-028b 兜底 seed**：p3b §4.5 已定「有锚必有 `Instrument` 行」不变量，起草时漏写；不补则合约表外键会因 universe 枚举缺失而断链。
- **SC-012 去主观化**：原写「滚动不掉帧到肉眼可感的程度」，改为可判的「滚动条长度与逻辑总行数一致」，流畅度显式标为**非验收门**（同 SC-001 与 045 / 046 先例）。

### 三项 checklist 判定的口径说明（避免下次复审误判为不合格）

以下三条按仓内 045 / 046 先例判为**通过**，理由记此以免反复：

1. **「No implementation details」**：本 spec 含少量架构不变量（跨 context 只读直查纪律、工作集闸、市场事实与业务实体的归属）。它们进 spec 是**刻意的** —— 违反即 CI 硬失败（boundaries + moat 探针），属需求级约束而非实现选择，与 045 `FR-020` / 046 `FR-032` 同性质。判为通过。
2. **「Written for non-technical stakeholders」**：本仓为单人自用系统，spec 的唯一读者即开发者本人；045 / 046 同标准。判为通过。
3. **「Success criteria are technology-agnostic」**：SC-007 / SC-008 用「代码中不存在 X 调用」「新依赖数 = 0」的形式表述。这是「与 V10 解耦」「不引入新依赖」两条承诺**唯一可机器验证的形式**，045 / 046 均已用此形态。判为通过。
