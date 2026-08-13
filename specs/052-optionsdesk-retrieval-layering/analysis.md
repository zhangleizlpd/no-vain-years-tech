# Analysis: 052-optionsdesk-retrieval-layering

**Date**: 2026-08-12 ｜ **Artifacts**: [`spec.md`](./spec.md) · [`plan.md`](./plan.md) · [`tasks.md`](./tasks.md) · [`ADR-0064`](../../docs/adr/0064-optionsdesk-retrieval-layering.md)
**Mode**: READ-ONLY（不改被分析文件；本报告写盘）

## 0. 起手：spec 有哪几层 / 扫了哪几层

> per `sdd-authoring.md` 反模式 ④ ——「矩阵的值域本身可能够不到需求所在的层」。046 那次 `US1-AS1` 被两轮 analyze 全漏，就是因为三张矩阵扫不到 Acceptance Scenario。**先列层，差集要么补扫、要么写明故意不扫。**

| # | 承载层 | 条数 | tasks 有专属矩阵？ | 本次是否扫 |
| --- | --- | --- | --- | --- |
| 1 | `state_branches`（frontmatter） | 24 | ✅ | ✅ |
| 2 | Acceptance Scenarios（US1–US4） | 19 | ✅ | ✅ |
| 3 | Edge Cases | 8 | ✅ | ✅ |
| 4 | Functional Requirements | 34 | ❌（靠 grep 扫） | ✅ |
| 5 | Success Criteria | 11 | ✅ | ✅ |
| 6 | 🆕 **视图 × 五层（判据全表）** | ~15 行 | ❌ **无** | ✅ **本次补扫** |
| 7 | Clarifications 定案 | 8 | ❌ | ✅ **本次补扫** |
| 8 | 依赖与前提 / Assumptions / Out of Scope | — | — | 仅作越界检查（不产生实现义务） |

🚨 **层 6 是本 spec 独有的**（049/050/051 都没有这一层）。三张标准矩阵结构上够不到它 —— **本次的两条主要发现都出自这一层**，与 046 那次是同一形状的问题。

## 1. Findings

| ID | Category | Severity | Location | Summary | Recommendation |
| --- | --- | --- | --- | --- | --- |
| **C1** | Underspecification | **HIGH** | spec `FR-002` + 判据全表 ⟷ tasks T010/T011/T012 | spec 把**六个维度**列为检索条件（行权价上界 / 行权价下界 / DTE 段 / 权利金下限 / 持仓量下限 / 相对价差上界，另加待定的单笔权利金下限），但 T010「解出**每视角每条件**的系统默认值」、T011「加三组字段」、T012「控件用默认值填充」**全部是泛指，未枚举维度**。⇒ 工作量差一个量级（1 个维度 vs 6 个），且验收不可判（「每条件」到底几条？） | 在 T010/T011/T012 的描述里**显式枚举六个维度**，并逐维度写清「默认值怎么解」（有的依赖 spot、有的是常量、有的三视角不同）。或拆成「先做行权价一维、其余维度另片」并写明 |
| **C2** | Inconsistency | **MEDIUM** | plan `D-LAYER-1` 载体表 | 五层载体表只列了 `leg-recall.rules.ts` / `leg-coarse.rules.ts` / `leg-rank.rules.ts` **三个文件**。**特征加工层的活跃标实际住在 `leg-derive.rules.ts`**（`markActivity`），表里没有；`leg-retrieval.port.ts`（本片新建的核心）、`get-legs.usecase.ts`（编排入口）、`optionsdesk.dto.ts`（契约）在 plan 全文**零次出现** | 补全 `D-LAYER-1` 的载体表。⚠️ 尤其 `leg-derive.rules.ts` —— 读表的人会以为特征加工 = `leg-rank.rules.ts`，进而不知道 `markActivity` 属于该层，可能把它挪错位置（而「打标在精排前」正是本片 Guardrail 11 要守的） |
| **C3** | Coverage Gap | **MEDIUM** | 判据全表「特征加工」行 ⟷ tasks | 判据全表写明「`rate` 按视角取口径（建仓周化 / 收租与全腿年化）」，但该措辞在 tasks.md **零命中**，且**未登记进故意零覆盖表**。它是 `050` 已有、本片不改的东西 | 二选一：① 加进 `FR-033` 那类「零改动面」并配断言；② 加进 tasks 的故意零覆盖登记表。**不处理的话下次 analyze 又会把它当缺口补 task**（`sdd-authoring.md` 明写的第二条配套） |
| **C4** | Terminology Drift | **LOW** | tasks T004 verify | 本片刚把「门槛」拆成「**检索条件**（可调）」与「**硬门槛**（不可调）」（`FR-002`），而 T004 的验收写「权利金**门槛**的两个常量」—— 权利金已是可调检索条件 | 可接受（它指代的是既有代码常量名），但建议改成「权利金**条件**的两个常量（代码内仍名 `PREMIUM_FLOOR`）」，避免新读者以为它不可调 |
| **C5** | Process | **MEDIUM** | tasks 覆盖矩阵段 | tasks 有 AS / state_branch / Edge Case / SC **四张**矩阵，但**判据全表没有专属矩阵**。C1 与 C3 正是从这个缺口漏出来的 | 给判据全表补一张矩阵（每行 → task），或在 tasks 显式写明「判据全表的行由 FR 矩阵间接覆盖」并逐行核过一次 |

**未发现的问题**（明确报告为零）：

- **Constitution 冲突**：0。§I（SDD 全流程 + mockup 卡点的豁免理由已在 plan Gate 0.1 写明并附绊线）· §II（每 task 红绿闭环）· §III（16 task 均为 30min–2h 粒度、各自 atomic commit）· §IV（不新增 ctx、跨 ctx 只读 + 注释；检索 port 属 ADR-0064 追加的第四类，非违反 ADR-0043）· §V（单 PR + regen + 两层验证齐）
- **Out of Scope 越界**：0。「列改版 / 截断 N」在 tasks 仅出现于故意零覆盖登记表
- **重复需求**：0
- **未映射 task**：0（16/16 均引 FR 或 plan 锚）
- **任务顺序矛盾**：0（依赖图与 Phase 顺序一致；`[P]` 仅 T009，确为不同文件无依赖）
- **占位符残留**：0（`TODO` / `???` / `TKTK` 零命中）

## 2. Coverage Summary

| 层 | 覆盖 | 备注 |
| --- | --- | --- |
| Functional Requirements | **34 / 34 (100%)** | tasks 生成期逐条 grep 抓到 6 条零覆盖并已补（3 条漏编号 + 3 条否定式约束缺断言） |
| Success Criteria | **11 / 11 (100%)** | — |
| Acceptance Scenarios | **19 / 19 (100%)** | — |
| `state_branches` | **24 / 24 (100%)** | — |
| Edge Cases | **8 / 8 (100%)** | — |
| **视图 × 五层判据全表** | **~13 / 15** | ⚠️ 缺口 = C1（六维度未枚举）+ C3（`rate` 口径未登记） |
| Clarifications 定案 | **8 / 8 (100%)** | 补扫结果：合并机制→T010 · 显式提交与复位→T012 · 不持久化→T013 · 水位不联动→T010 · 排名基准→T010 · 死腿条件→T004 · 精排主键→T007 · 活跃标分组→T009 |

## 3. Metrics

| 指标 | 值 |
| --- | --- |
| Total Requirements (FR) | 34 |
| Total Success Criteria | 11 |
| Total Tasks | 16 |
| FR 覆盖率 | 100% |
| 判据全表覆盖率 | ~87%（13/15） |
| CRITICAL | **0** |
| HIGH | **1**（C1） |
| MEDIUM | **3**（C2 / C3 / C5） |
| LOW | **1**（C4） |
| Ambiguity | 1（C1 的「每视角每条件」） |
| Duplication | 0 |
| Constitution 冲突 | **0** |

## 4. Next Actions

**零 CRITICAL ⇒ 不阻塞 `/speckit-implement`。** 但 **C1 建议先修**：它不是措辞问题，是**范围不可判** —— 实现者读 T010 无法知道要解几组默认值，而 1 个维度与 6 个维度的工作量、契约字段数、控件数量全都不同。带着它进 implement，第一个 task 就会停下来问。

建议处置顺序：

1. **C1（HIGH）** —— 手工编辑 `tasks.md`，在 T010 / T011 / T012 描述里枚举六个维度并注明各自默认值的来源（依赖 spot / 常量 / 三视角不同）
2. **C2（MEDIUM）** —— 手工编辑 `plan.md` 的 `D-LAYER-1` 载体表，补 `leg-derive.rules.ts` 等四个文件
3. **C3（MEDIUM）** —— 二选一登记（零改动面 FR 或故意零覆盖表）
4. **C5（MEDIUM）** —— 给判据全表补矩阵（做完 C1/C3 后它基本自动闭合）
5. **C4（LOW）** —— 可随手改，也可留

📌 四条都是**文档层修正，不涉及重跑 `/speckit-specify` 或 `/speckit-plan`** —— spec 的判据本身没有问题，问题在 plan/tasks 对它的转写不完整。

## 4b. 修复留痕（2026-08-12，同日处置）

五条**全部已修**，均为文档层修正，未重跑 `/speckit-specify` 或 `/speckit-plan`：

| ID | 处置 | 落点 |
| --- | --- | --- |
| C1 | T010 补**六维度表**（逐维度标明默认值来源：2 个依赖 spot、4 个常量、其中 2 个三视角取值不同）；T011 注明三组字段**每组覆盖六维度**；T012 注明**六个控件**并附「放不下就停下补 mockup」绊线 | `tasks.md` |
| C2 | `D-LAYER-1` 载体表补 `leg-derive.rules.ts`（活跃标属特征加工层），另列**层外三文件**（编排 / port / 契约）；加 🚨「`markActivity` 属特征加工层不是独立一层，误置于精排之后精排就没该特征可用」 | `plan.md` |
| C3 | `rate` 按视角取口径登记进**故意零覆盖表**（`050` 已 ship 零改动） | `tasks.md` |
| C4 | 「权利金**门槛**」→「权利金**条件**」（注明代码内仍名 `PREMIUM_FLOOR`） | `tasks.md` |
| C5 | 新增**判据全表覆盖矩阵**（召回层 9 行 + 其余四层 9 行），并在表头写明它是补 C5 的、以及为什么其余四张矩阵够不到这一层 | `tasks.md` |

**修复后回归**：FR 34/34 · task 格式违规 0 · 其余四张矩阵未被打破。

## 5. 本次 analyze 自身的方法论留痕

- **起手列层**（§0）是这次抓到 C1/C3 的**唯一原因** —— 两条都出自「判据全表」这个前几片没有的层，四张标准矩阵结构上够不到它。若照旧只跑三张矩阵 + FR 扫描，会得到「100% 覆盖、零发现」的假绿。
- **探针假阳性排除了三次**：① 路径一致性探针把「plan 不枚举文件路径」误报为不一致（plan 是 prose-only，路径表在 tasks，**但顺带暴露了 C2 这个真问题**）② Out of Scope 越界探针命中「列改版 / 截断 N」，查上下文发现只在故意零覆盖登记表里 ③「精排降级」零命中是措辞差异，tasks 实际写「不分档」（命中 3 次）。**修复复验时又踩两次**：④ 六维度表因表格行有 2 空格缩进而零命中 ⑤ mockup 绊线因句中夹 markdown 粗体而零命中 —— 两处内容其实都在。⇒ 教训：**grep 探针对缩进与行内标记敏感，零命中先看原文再下结论**。
