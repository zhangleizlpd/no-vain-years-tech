# 强调标记普查与降噪（2026-09-17）

> SDD 产物里 🚫 / 🚨 / ⚠️ 与 MUST / NEVER / CRITICAL 一族的用量普查、根因、处置。数字是当日快照（含 085 worktree），判据与机制落在 `.claude/rules/sdd-authoring.md` § 反模式与 `scripts/hooks/posttooluse-steering-density.sh`，本文只留证据。

## 结论

- **密度从 044 起翻了 3–5 倍**：plan.md 每百行标记 001–016 在 1–6，027–037 在 10–14，044 起 18–37。
- **源头是模板定的音区，不是某个作者**：plan 面的 `NEVER` 100 / `CRITICAL` 43 / `MANDATORY` 48 / `ENFORCED` 44 几乎全由模板逐份带入；模板注释里写着「do not soften the language」「保持 fierce」，作者顺着这个音区写完整份文档。
- **Anthropic 的现行指引与之相反**：对 Claude 4.5+，「dial back any aggressive language. Where you might have said "CRITICAL: You MUST use this tool when...", you can use more normal prompting like "Use this tool when..."」（[Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)）。模型对强调语会 overtrigger；密度一高，真红线跟墙纸没有区别。
- **处置分三层**：模板源（preset 0.7.2）改陈述句 + 机器闸指针；rule 定三问判据与每份 ≤ 10 的预算；PostToolUse hook 写完即数、超线提醒。冻结的 SDD 历史文档不回改。

## 1. 措辞清单

| 类别     | 措辞                                                                          | 本来的语义                                                      | 常见虚胖形态                                                             |
| -------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| emoji    | 🚫                                                                            | 针对某次具体事故的禁令（`server-impl-playbook.md` 的定义）      | 当「不」字用：`🚫 不删、🚫 不撤销确认`，一行四个                         |
| emoji    | 🚨                                                                            | 不写就永远不会红的反例臂 / 不显式禁就会踩的坑                   | 当小节标题用（「🚨 impl 期修订」）；「反例臂」清单段头已说明性质仍逐条挂 |
| emoji    | ⚠️                                                                            | 已知弱点 / 未验证 / 绊线                                        | 与 `**绊线**` `**未验证**` 加粗叠用                                      |
| 英文大写 | MUST / MUST NOT                                                               | RFC 2119 规范句式（spec 的 `- **FR-` / `- **SC-` 行是本来用途） | 散文里无编号的 MUST；同句 🚫 + MUST NOT                                  |
| 英文大写 | NEVER / ALWAYS / CRITICAL / IMPORTANT / NON-NEGOTIABLE / MANDATORY / ENFORCED | 模板 banner 的 fierce 音区                                      | 每份 plan 原样继承，不承载本 feature 的信息                              |
| 中文     | 严禁 / 绝对禁止                                                               | 同 🚨                                                           | 模板段头「AI 绝对禁令 — 严禁违背」                                       |
| 中文     | 必须 / 一律 / 不得 / 铁律                                                     | 普通汉语，多数是正常用法                                        | 只在与 emoji 叠用时算虚胖；`绝对时刻` `绝对值` 是术语，不计              |

## 2. 频次（表面 × 类别，2026-09-17）

| surface                   | files | lines | emoji | EN caps | 中文强令 | total | 密度/百行 |
| ------------------------- | ----- | ----- | ----- | ------- | -------- | ----- | --------- |
| specs/\*\*/spec.md        | 83    | 19958 | 542   | 3381    | 479      | 4402  | 22.1      |
| specs/\*\*/plan.md        | 83    | 16592 | 968   | 776     | 670      | 2414  | 14.5      |
| specs/\*\*/tasks.md       | 82    | 13489 | 1587  | 518     | 598      | 2703  | 20.0      |
| docs/conventions          | 23    | 1991  | 103   | 16      | 132      | 251   | 12.6      |
| .claude/rules             | 24    | 1092  | 56    | 31      | 61       | 148   | 13.6      |
| .claude/skills+commands   | 29    | 4487  | 162   | 81      | 103      | 346   | 7.7       |
| .specify templates+preset | 21    | 1613  | 15    | 50      | 13       | 78    | 4.8       |

读法：

- spec.md 的 EN caps 3381 里 MUST 2181 + MUST NOT 1174 是 FR / SC 规范句式，不是噪音；085 spec 按 `sdd-authoring.md` 配方自查，散文里无编号 MUST 为零。
- plan.md 的 EN caps 776 里，`NEVER` 100 / `CRITICAL` 43 / `MANDATORY` 48 / `ENFORCED` 44 / `NON-NEGOTIABLE` 67 都是模板段落逐份带入（每份 plan 各一套），作者自己写的大写词不到 1/10。
- tasks.md 是 🚨 最密的表面（822），🚫 430；模板只带 1 个，全是作者顺着 plan 的音区写出来的。
- 中文「绝对」一列含 `绝对时刻` / `绝对值` 假阳性，hook 只计「严禁 / 绝对禁止」。

## 3. 趋势（plan.md 按 feature 序号，每百行全类标记）

| 时期             | feature               | 密度                      | 备注                                           |
| ---------------- | --------------------- | ------------------------- | ---------------------------------------------- |
| 起步             | 001 / 010 / 018       | 1.4 / 1.9 / 0.9           | 模板尚无 🚨 段                                 |
| 模板加 🚨 段头后 | 013 起每份 +2         | —                         | `🚨 Testing Invariants` / `🚨 Impl Guardrails` |
| chat / ideation  | 027–037               | 9.6–13.9                  | ⚠️ 与 中文强令 上升                            |
| 拐点             | 044 / 045 / 046       | 18.2 / 20.6 / 22.0        | 🚨 ×18 / ×10 / ×7，反例臂逐条挂 🚨 成型        |
| 🚫 登场          | 047                   | 24.4                      | 首次出现 🚫（6）                               |
| 高位             | 055 / 077 / 079       | 32.9 / 36.6 / 26.1        | 079 一份 🚫 35                                 |
| 最近             | 082 / 083 / 084 / 085 | 17.4 / 19.9 / 23.7 / 27.8 | 085 🚫 9 / 🚨 15 / ⚠️ 11                       |

## 4. 079 标定（🚫 35 / 🚨 19，按三问逐条过）

三问：① 实施者默认会做错吗 ② 有没有机器闸当场拦 ③ 有实证吗。三条都满足才配一个标记。人工分类基于 `rg -n '🚫|🚨'` 输出（长行被截断，计数为下限）：

| 形态                     | 例                                                                                                                                              | 数量（下限） | 三问结论                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------- |
| 🚫 当「不」字用          | `🚫 不删、🚫 不撤销确认`；`🚫 无档案时按 12 月代入；🚫 来源矛盾时择一写入；🚫 …；🚫 …`；表格单元格里 `🚫 计失败`                                | ≥ 15         | 陈述句：「不删、不撤销确认」 |
| 🚫 + MUST NOT 叠加       | `🚫 MUST NOT 复用 earnings_event`；一行 `🚫 MUST NOT` ×3                                                                                        | ≥ 6          | 同一条约束说了两遍，留一个   |
| 已有机器闸               | `🚫 新增跨 ctx 写`（`check-server-moat.ts`）；`🚨 不把 hk 加进 scope`（`session-clock.ts` 直接抛）；`🚫 不用 FOR UPDATE`（模板 guardrail 已写） | ≥ 4          | 写「由 X 拦」                |
| 🚨 当小节标题 / 修订标记 | `🚨 impl 期修订`、`🚨 fs 族标签 + 标题 v3`、`🚨 判定顺序`、`🚨 标红口径`                                                                        | ≥ 6          | 用小标题，不用 🚨            |
| 真·陷阱且有实证          | 按标题认 `all` 类（PoC 实撞）；`new Date('10/09/2026')` 月日反解；跟随重定向被静默吞；捕获后返回空数组                                          | ≈ 4          | 保留                         |
| 模板段头                 | `### 🚨 Testing Invariants` / `### 🚨 Impl Guardrails`                                                                                          | 2            | 0.7.2 模板已去               |

按三问，079 的 54 个标记留 5 个左右；其余改成陈述句后信息量不变。

## 5. 根因

1. **模板定音区**：0.7.1 的 plan 模板 181 行带 27 个标记（14.9/百行），三段注释明写「do not soften the language」「保持 fierce」。作者（Claude）把这个音区泛化到整份文档，而不是只在那三段用。
2. **标记没有定义**：`MUST` / `MUST NOT` 自 2026-09-05 起有反模式条与 grep 自查配方，但只管规范性动词、只管 spec；🚫 的定义只在 `server-impl-playbook.md` 有一句（针对具体事故的禁令），plan / tasks 层没有判据，于是 🚫 退化成「不」字。本次把两者并成一条、配方机械化进 hook。
3. **旧的 steering 经验过时**：2026-05 曾主动要求 fierce callout + NEVER / MUST（当时模型需要）；Anthropic 对 Claude 4.5+ 的指引已反转，但仓内没有随之调整。
4. **写作时刻无反馈**：只有事后的人读感受，没有数。

## 6. 处置

| 层             | 改动                                                                                                                                                                                                                                     | 位置                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 模板源         | preset 0.7.2：三段去 emoji 段头与 NEVER / MUST / 绝对禁止，改陈述句 + 机器闸指针（lefthook `no-bad-mocks` / eslint-plugin-boundaries / `check-server-moat.ts`）；注释换成标记预算 + 三问；顺手回流 mono 内直改 vendored 副本的两处 drift | `michael-speckit-presets/presets/mono-orchestrator-ready/`（install 回 mono）         |
| 判据           | 与既有「规范性动词（`MUST` / `MUST NOT`）当强调号用」一条合并为「规范性动词 / 强调标记当强调号用」：判据统一成三问 + 每份 ≤ 10 + 典型虚胖；不另立第二条                                                                                  | `.claude/rules/sdd-authoring.md`                                                      |
| 写作时刻       | PostToolUse(Write\|Edit) 数 `specs/*/{spec,plan,tasks}.md`，超线注入提醒；(session, 文件) 按计数去重；spec 的 FR / SC 行 MUST 不计                                                                                                       | `scripts/hooks/posttooluse-steering-density.sh` + `.test.sh`（CI Tooling self-tests） |
| 新建时刻       | SDD 产物闸多一条预算提示（path rule 在 Write 新文件时不触发）                                                                                                                                                                            | `scripts/hooks/pretooluse-convention-rubric.sh`                                       |
| 在写的 feature | 085 plan / spec 按三问降噪：标记 77 → 49（🚫 9 → 4、🚨 15 → 2、⚠️ 11 → 2）；等该 feature 的 session 收尾后落盘                                                                                                                           | `specs/085-*/`                                                                        |
| 冻结文档       | 079 等已合并 SDD 文档不回改（`sdd-authoring.md`「冻结决策记录」）                                                                                                                                                                        | —                                                                                     |

新模板基线：hook 对 0.7.2 plan 模板本身静默（模板自带只剩 `MANDATORY INTEGRATION` 这个段名 1 个）。

## 7. 复现

```bash
# 全仓某个标记的总数
rg -o '🚫' specs/ | wc -l
# 单文件走 hook 的口径（与写作时刻看到的数一致）
jq -n --arg fp "$PWD/specs/079-hk-earnings-date-sources/plan.md" '{tool_input:{file_path:$fp}}' \
  | bash scripts/hooks/posttooluse-steering-density.sh | jq -r '.hookSpecificOutput.additionalContext'
```

## 8. 依据

- Anthropic, Prompting best practices（Claude 4.5+ overtrigger 与 dial back 原文）：<https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices>
- Claude Code hooks（PostToolUse `additionalContext` 回到模型上下文；exit 0 放行）：<https://code.claude.com/docs/en/hooks>
- 业界现状（2025–2026）：主流 coding agent 的 system prompt 仍大量用 ALL-CAPS 与「CRITICAL INSTRUCTION」（arXiv:2512.14012 对 Cursor / Kimi / Gemini 的对照），与 Anthropic 指引相反；未见公开的 steering 文案密度 lint 工具，本仓 hook 是自建。
