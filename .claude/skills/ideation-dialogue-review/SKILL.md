---
name: ideation-dialogue-review
description: 复盘评估 ideation（032 需求灵感澄清）模块里「用户 ↔ 澄清助手(DS)」的整段对话质量——访谈引导是否合理 + 产出 brief 质量是否过关，对照 ideation 人设铁律/schema/收敛门做「有据评判」，并按业内对话/澄清/需求质量框架（ISO 29148、INVEST、G-Eval、LHAW/AskBench、Qulac/ClariQ）打分。激活时机：用户提"复盘这轮澄清/灵感对话""评估 DS（澄清助手）问得好不好""分析灵感需求对话过程""brief 产出质量怎么样""访谈引导合理性""这次对话有没有优化空间""review ideation session"，或丢一段导出的对话/给一个 session_id 让我评估。输入支持两种：本地 DB session_id（连 mbw_poc 拉 idea_turn + requirements_draft）或粘贴的对话 markdown。
model: inherit
---

# ideation-dialogue-review — 灵感澄清对话质量复盘

把「用户 ↔ ideation 澄清助手(DS)」的一整段对话，做成标准化质量复盘：**过程（访谈引导）+ 产出（brief）** 两端，对照本仓 ideation 的人设铁律/schema/收敛门做**有据评判**，并用业内框架打分。

## 1. 何时用

- 用户丢一个 ideation `session_id` 或一段导出的对话 markdown，要复盘质量。
- 关键词：复盘澄清对话 / 评估 DS 问得好不好 / 访谈引导合理性 / brief 产出质量 / 这轮有没有优化空间 / review ideation session。
- 想横向对比多轮 session 的对话质量（同一套 rubric 才可比）。

**不用的场景**：单纯想看一条 session 的原文 → 直接连 DB 查就行，不必跑完整复盘。

## 2. 工作流（step → verify）

1. **取数** → 读 `references/extract.md`。两种输入自动识别：
   - 给了 `session_id`（或"第 N 个 session""灵感需求 v2"这类指代）→ 连本地 `mbw_poc` 拉 `idea_session` + `idea_turn`（含 suggestion chips）+ `requirements_draft.briefJson`。
   - 给了对话 markdown → 直接解析；无 briefJson 时只评过程 + 用户能贴的 brief。
   - **verify**：轮次数、role 配平（user≈assistant）、是否拿到 briefJson 全段——先回报这三项再往下。
2. **有据锚点装载** → 读 `references/grounding.md`，按它读 ideation 人设/schema/门规则的当前源码（**不要凭本 skill 里的摘要，源码会变**）。
   - **verify**：能引出人设铁律原文 + T1/T2/T3 当前 key 清单 + 收敛门判据，再开始评判。
3. **评分** → 读 `references/rubric.md`，逐维度打分（1-5 Likert）+ 自动信号统计 + 人设铁律逐条 pass/fail。
   - **verify**：每个评分/扣分都挂**具体轮次号或 brief 段名**做证据；无证据的判断不写（见 §3 铁律）。
4. **产出报告** → 套 `references/report-template.md` 的结构输出。
5. **（可选）对比重写** → 若用户要"和 DS 产出对比"，我据对话**独立重写一份 requirement**（忠实 + 修正），逐段 diff DS 的 brief，标优化点。

## 3. 本 skill 的铁律

- **有据，不凭感觉**：每条扣分/优点必须挂证据（轮次号 / brief 段名 / 人设原文行）。这是本 skill 的核心价值——区别于"读完凭印象点评"。
- **源码是真相**：人设/schema/门规则**每次都重读源码**（`references/grounding.md` 给路径），因为它们可被 `prompt_config` 表覆盖、也会随版本改。skill 内的摘要只是导航，不作评判依据。
- **接地段(T2)不算缺陷**：代码库索引服务（S2/S3）未接通期，brief 的 T2 接地段（`data_model_sketch`/`api_contract_sketch`/`affected_surface`/`constraints_guardrails`）被模型推测填上是**预期行为**，不扣分，只标注「待接地校验」。收敛门本来就不查 T2。
- **区分"未澄清"与"已澄清"**：对话末轮悬空（助手问了、用户没答就点生成）的问题，若被 brief 当成已确认需求写进 T1，要 flag——它应进 `open_questions`。
- **rubric 可刷新**：`references/rubric.md` 顶部标了固化日期 + 来源；业内框架演进时用 `optimization-loop` 或 `tech-compare` 重研究后更新该文件，不在评判时临时联网（保证跨 session 可比）。
