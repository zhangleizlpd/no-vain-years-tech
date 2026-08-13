# Specification Quality Checklist: 选约检索分层落地 + 三视角逐层判据重梳

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-12
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain —— 8 问在起草前的对焦中已全部定案，逐条记入 § Clarifications
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

### 本片的判据全部来自实测，不是设计偏好

| 判据             | 实测依据                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 收租成色条件     | `us:KBR` spot `37.56`，收租视角前 14 行全是实值，`K=105`（+179.6%）排第 3、年化 384%；13 行准备金同为 `39.60`（经济上同一笔交易） |
| 持仓量条件       | 过权利金门槛的 2572 条里 OI=0 的 **1014 条（39.4%）**；其中 34 条当日有成交 ⇒ 必须带免死条款                                      |
| 精排改分层       | `us:LULU` 按年化排序前 4 名里 3 条 `OI ≤ 34`；分层后 A 档 7 条每条都是 OI 500+、价差 ≤15%                                         |
| 活跃标改同到期日 | 现行口径 3 个标全落 `DTE=38`，而 `DTE=157` 的 OI 合计 `28113` 全场最高却零标                                                      |
| 活跃标要配绝对线 | 同到期日口径下 `DTE=45` 的 top-1 只有 `OI=4`（该到期日 OI 合计 23）—— 相对判据在死到期日误报                                      |
| 不设期限先验     | 年化对短期的偏袒只在 ATM 成立：ATM 段 `29.6%→16.9%`，`−15~−30%` 段 `6.6%→7.4%`（长期反超）                                        |

### 一次被实测否定的怀疑（留痕，别下次又提）

起草期怀疑权利金门槛误伤了活跃腿（未过门槛但 `OI≥100` 的有 247 条）。逐 DTE 段核后：那批平均 `bid` 仅 `0.031–0.060`、平均年化 `0.6%–3.3%` ⇒ **是真垃圾不是便宜好货，门槛判对了**。⇒ `050` 标定值沿用不动。

### 三条判定的说明（自审留痕）

1. **「No implementation details」判 pass 但有边界**：`FR-031`（检索 port）描述的是「接口只暴露业务语义、MUST NOT 出现存储侧概念」这一**约束**，不是接口签名。ADR-0064 决策 4 是它的理由来源，具体形状归 plan。
2. **本片有一处 mobile 改动却仍是「以 server 为主」**：新增两条检索条件必须配可见计数（ADR-0064 不变量 ④），mobile 侧只加计数呈现与控件默认值回填。按 Constitution §V 走单 PR。
3. **`FR-026` 反转了 `053` 起草时的一条 FR**：排名基准随用户检索条件变化。`053` 的 `FR-009` / `SC-005` 已同步改写——两片不能各持一套顺序模型。

### 待标定清单（impl 期做，像 `050` T017）

收租成色的兜底比例 `X` · 流动性档界（相对价差还是绝对价差、OI 分位）· 活跃标的绝对量下限 · 分层降级的候选数阈值 · 年化「打平」的带宽 · 召回层候选上限 `K` · 是否设单笔权利金下限。

🚫 全部 **MUST NOT 拍数**，且标定过程 MUST 写回本 spec（`SC-011`）。
