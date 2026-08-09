# 有据锚点 — 评判前必读的源码

评判「DS 是否违反铁律 / brief 是否合规」**不能凭本文件的摘要**——它们随版本改、且可被 `ideation.prompt_config` 表运行期覆盖。每次复盘**重读下列源码取当前真相**，本文件只给路径 + 关注点。

## 必读源码（按需 Read）

| 文件                                                | 取什么                                                                                                                                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/ideation/interview-persona.ts`     | `DEFAULT_INTERVIEW_PERSONA`（访谈铁律）+ `DEFAULT_BRIEF_EMIT_PERSONA`（产出铁律）。**人设可被 DB 覆盖**：查 `prompt_config` 表 key=`interview_persona` / `brief_emit_persona` 有没有覆盖行；有则以表内为准 |
| `apps/server/src/ideation/brief.schema.ts`          | `T1_SEGMENT_KEYS` / `T2_SEGMENT_KEYS` / `T3_SEGMENT_KEYS` 当前清单 + 各段必填/optional                                                                                                                     |
| `apps/server/src/ideation/brief-gate.rules.ts`      | `isConverged` 收敛判据（当前：只查 T1 五段齐，T2/T3 不参与）                                                                                                                                               |
| `apps/server/src/ideation/suggestion-gate.rules.ts` | `shouldOfferChips` 两道闸 + `normalizeSuggestion`（chips 数量/逃生/推荐规则）                                                                                                                              |

查 prompt_config 覆盖：

```bash
docker exec mbw-poc-postgres psql -U mbw -d mbw_poc -c \
  "SELECT key, left(content,80) AS preview, updated_at FROM ideation.prompt_config;"
```

## 人设铁律 checklist（评「指令遵从」维度的硬清单）

> 以下为**当前默认人设**提炼，评判前用源码核对是否仍成立 / 是否被表覆盖。逐条对每轮 assistant 判 pass/fail + 挂证据轮次。

访谈相（`DEFAULT_INTERVIEW_PERSONA`）：

1. **一轮一问**：绝不一次抛多个问题。
2. **澄清问题走工具，不混进普通文本**：要问的一律 `ask_clarifying_question`（DB 里表现为该 assistant 轮带 `suggestion`，或纯文本但确属提问）。
3. **「生成 brief」不是待澄清功能**：用户提"生成 brief / 参考 brief 要求"指的是界面按钮动作；助手**绝不**反问"是什么功能/要什么格式/描述输出结构"——五段格式系统固定。〔这是高频踩雷点，重点查〕
4. **绝不替用户臆断需求或直接给方案**：职责是问清，不是替决定。
5. **第一问不给 chips**（反锚定）；chips 仅在「答案可枚举(≤4) + 有可辩护推荐」两闸同过时给。
6. **成功标准三段式**：开放问 → 给系统基线(标来源、只升不降) → 一个「采纳」chip 让用户一键定稿。
7. **形态二选一**：用户只寒暄/没方向 → 纯文本欢迎引导；一有具体方向 → 走工具提问。

产出相（`DEFAULT_BRIEF_EMIT_PERSONA`，承接上表，编号续记 8-10）：

1. **(铁律 8) T1 五段如实归纳**，依据对话已澄清内容。
2. **(铁律 9) 不臆造对话未出现的需求**；某 T1 段没聊到宁可留空（系统据此提示补充），不编。
3. **(铁律 10) T2/T3**：聊到才填、没聊到省略——但**接地段(T2)在索引服务未接通期被推测填上不算违规**（见 SKILL.md §3）。

## schema 分层（评 brief 合规性的结构基准）

- **T1 核心必填（收敛硬门）**：`problem` / `user_stories` / `functional_requirements` / `success_criteria` / `non_goals`。收敛门只查这 5 段齐（trim 后非空 string）。
- **T2 接地段（非阻塞，stub 期可空/推测填）**：`affected_surface` / `constraints_guardrails` / `data_model_sketch` / `api_contract_sketch`。
- **T3 可选段（随规模自适应）**：`edge_cases` / `nfr` / `ui_notes` / `open_questions` / `phase_boundary`。

> 若源码里的 key 清单与此处不一致，**以源码为准**并在报告里记一笔「skill grounding 摘要已 drift，需更新」。
