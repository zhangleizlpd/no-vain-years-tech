# 评估 Rubric（业内框架固化）

> **固化日期**：2026-06-22。来源 = 三路联网研究（对话式 AI 评估 / 澄清提问评估 / 需求工程访谈+需求质量），见文末引用。
> **刷新方式**：业内框架演进时走 `optimization-loop` 或 `tech-compare` 重研究后改本文件，**不在单次评判时临时联网**——固定 rubric 才能跨 session 横向比。
> 打分统一 **1-5 Likert**（G-Eval 体例），每维度 1=严重缺陷 … 5=范本级；另有一组**自动信号**（可机械数出来，先填）。

---

## 0. 自动信号（先机械统计，作为后面打分的证据底座）

| 信号                      | 怎么算                                           | 健康参考                       |
| ------------------------- | ------------------------------------------------ | ------------------------------ |
| 总轮次 / user / assistant | 数 `idea_turn`                                   | —                              |
| 提问轮数                  | assistant 轮中属"提问"的                         | —                              |
| chips 利用率              | 带 `suggestion` 且含选项的 assistant 轮 ÷ 提问轮 | 可枚举二元问多却长期 ~0 → 偏低 |
| 重复/近义追问数           | 同一维度被追问 ≥2 次（语义判定）                 | 0 最好                         |
| 末轮悬空数                | 助手问了但用户没答就收敛的问题数                 | 0                              |
| T1 缺段                   | 跑 `isConverged` 逻辑数缺失段                    | 0（已收敛应为 0）              |
| brief 段数                | briefJson 非空段计数                             | —                              |
| 成功标准是否可度量        | success_criteria 是否带阈值（"≤3s""≥95%"）       | 应带                           |

---

## A. 访谈过程质量（引导端）— 6 维度

| #   | 维度                               | 一句定义                                                          | 业内出处                                                                    | 1-5 锚点（5 / 3 / 1）                                                                     |
| --- | ---------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| A1  | **相关性 Relevance**               | 每个澄清问题是否针对真实信息缺口，而非已知或无关                  | G-Eval、RAGAS Answer Relevance；Qulac facet 级                              | 5=每问都打在真缺口；3=多数相关、个别偏题；1=大量问已知/无关                               |
| A2  | **必要性·非冗余 Necessity**        | 该问才问；不重复、不在信息已足时继续追问（over-asking）           | LHAW **Gain/Q**、AskBench **Unq.(冗余追问率)**、ClarQ **AQD**               | 5=零冗余、每问都换来增益；3=1-2 次冗余/近义追问；1=反复原地打转（如同一维度连问≥4 轮）    |
| A3  | **轮次效率·时机 Turn Efficiency**  | 用最少轮次消解最多歧义，关键问题尽早问、不拖到末尾                | TOD Average Turns；ReqElicitGym **TKQR(关键问题时机)**                      | 5=关键维度前置、节奏紧凑；3=有来回但可接受；1=关键问拖到末轮 / 冗长                       |
| A4  | **提问形态 Specificity+中立+开放** | 针对具体歧义面；不诱导（leading）；该开放时开放、该枚举时给 chips | Qulac/AGENT-CQ specificity；Liaskos RE2021 开放性/中立性；本仓 chips 两道闸 | 5=形态全对、chips 用在刀刃；3=形态基本对、个别该给 chips 没给；1=诱导式/泛泛而问/形态错配 |
| A5  | **歧义·隐含假设消解**              | 主动挖用户没说清/隐含的维度，显式化前提                           | ReqElicitGym **IRE(隐含需求覆盖)**；implicit assumption coverage            | 5=隐含假设都被挖出确认；3=挖了主要的、漏次要；1=只接表面、不追问                          |
| A6  | **指令遵从 Instruction-Following** | 是否遵守 ideation 人设铁律（见 grounding.md 7 条访谈铁律）        | MT-Bench、DeepEval Prompt Alignment                                         | 5=铁律零违反；3=1 处轻微偏离；1=违反硬铁律（如把"生成 brief"当待澄清功能去问）            |

---

## B. 产出 Brief 质量（产出端）— 6 维度

> 基准 = ISO/IEC/IEEE 29148:2018 需求质量属性 + INVEST + GWT + 本仓 schema 分层。**只评 T1+已聊到的 T3**；T2 接地段未接通期不扣分（标「待接地校验」）。

| #   | 维度                                 | 一句定义                                                         | 业内出处                                                             | 1-5 锚点（5 / 3 / 1）                                                                           |
| --- | ------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| B1  | **完整性 Completeness**              | 集合级 T1 五段齐（收敛门）；个体级每段充分、无遗漏关键场景       | ISO 29148 Complete；IEEE 830 集合完整性                              | 5=五段齐且充分；3=齐但某段单薄；1=缺段/大面积空泛                                               |
| B2  | **忠实·可溯源 Groundedness**         | brief 每条都能追溯到对话已澄清内容；**未澄清项不得当已澄清写入** | RAGAS Faithfulness；ISO 29148 Correct/Traceable；emit 铁律「不臆造」 | 5=全可溯源；3=个别外推但合理；1=把悬空/未答项当成已确认需求写进 T1                              |
| B3  | **无歧义·单一 Unambiguous+Singular** | 每条需求唯一解释、只说一件事（不混 and/or）                      | ISO 29148 Unambiguous + Singular                                     | 5=条条清晰原子；3=个别一条塞多义；1=大量模糊/复合需求                                           |
| B4  | **可验证 Verifiable**                | 成功标准/AC 可观测、带阈值；GWT 用具体数值非模糊词               | ISO 29148 Verifiable；GWT 可度量                                     | 5=都可测、有阈值；3=多数可测、个别"快/好用"；1=不可验证                                         |
| B5  | **一致性·无冗余 Consistency**        | 段间不冲突、不重复（如 non_goals 与 phase_boundary 别大段重叠）  | IEEE 830 Consistency + Modifiability                                 | 5=无冲突无重复；3=轻度重复；1=自相矛盾                                                          |
| B6  | **分级·故事质量 Ranked+INVEST**      | user stories 过 INVEST 并标 P1/P2/P3；功能需求标 FR-NNN          | INVEST（Wake）；ISO 29148 Ranked                                     | 5=分级清晰、INVEST 全过；3=有分级、个别故事不 Independent/Testable；1=无分级、故事不可估/不可测 |

---

## 综合判读

- **过程 A 与产出 B 分开给均分**，别混成一个数——它们诊断不同环节（A 看引导，B 看落地）。
- **拉清单**：把 A6 人设铁律 7 条逐条 pass/fail 单列（硬合规，违反硬铁律 → A6 直接 ≤2，无论其他维度多好）。
- **严重度排序**：硬铁律违反 > 忠实性问题（悬空当已澄清）> 冗余/效率 > 形态优化。报告 Top 问题按此排。

---

## INVEST / GWT 速查（评 B6/B4 用）

- **INVEST**：Independent（可独立开发测试）/ Negotiable（对话起点非死合同）/ Valuable（对用户有值）/ Estimable（可估）/ Small（一迭代内）/ Testable（有验证条件）。
- **GWT 验收标准质量**：行为导向（描述动作+可见结果非实现）/ 原子（一 scenario 一规则）/ 可度量（具体阈值替"快"）/ 自包含 / 正常+边界都覆盖。

---

## 引用（固化来源，刷新时核对）

对话式 AI 评估：

- MT-Bench / Chatbot Arena（Zheng et al., 2023）<https://arxiv.org/abs/2306.05685>
- G-Eval（Confident AI）<https://www.confident-ai.com/blog/g-eval-the-definitive-guide>
- DeepEval 指标指南 <https://www.confident-ai.com/blog/llm-evaluation-metrics-everything-you-need-for-llm-evaluation>
- Azure AI Groundedness detection <https://learn.microsoft.com/en-us/azure/ai-services/content-safety/concepts/groundedness>

澄清提问评估：

- Qulac（Aliannejadi et al., SIGIR 2019）<https://ar5iv.labs.arxiv.org/html/1907.06554>
- ClariQ / ConvAI3（2020）<https://arxiv.org/abs/2009.11352>
- ClarQ-LLM（2024）<https://arxiv.org/abs/2409.06097>
- LHAW（Gain/Q、过度澄清，2025）<https://arxiv.org/abs/2602.10525>
- AGENT-CQ（ACM TOIS 2024）<https://arxiv.org/abs/2410.19692>

需求工程 / 访谈 / 需求质量：

- ISO/IEC/IEEE 29148:2018（镜像）<https://drkasbokar.com/wp-content/uploads/2024/09/29148-2018-ISOIECIEEE.pdf>
- IEEE 830-1998 八属性 <https://tms-outsource.com/blog/posts/what-is-ieee-830-in-software-development/>
- Lending et al., RE 访谈评估 rubric（JISE 2022）<https://aisel.aisnet.org/jise/vol33/iss4/5/>
- Liaskos et al., RE 访谈问题类型学（RE 2021）<https://www.yorku.ca/liaskos/Papers/RE2021/RE2021.pdf>
- ReqElicitGym（IRE/TKQR/ESR，arXiv 2602.18306）<https://arxiv.org/html/2602.18306>
- SWEBOK Ch.1 Software Requirements <http://swebokwiki.org/Chapter_1:_Software_Requirements>
