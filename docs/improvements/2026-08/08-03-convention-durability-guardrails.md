# Convention 耐久性守卫落地 —— 「状态数字进 convention」根因分析与三层防线

> 缘起：`testing.md`（#823）/ `test-environment-matrix.md`（#803）第一版都写满了状态数字
> （T-x 台账「已修复 / 自 06-09 全红」等），#839 清洗时人肉抓的。本轮回答三个问题：
> 为什么规约写了三遍还是没挡住 / audit skill 和 hook 为什么看不见 / 怎么让它结构性不复发。

## 根因（六条，全部有探针背书）

| #   | 根因                                                                                                                                        | 证据                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| R1  | 18 条 `.claude/rules` 的 `paths:` 无一命中 `docs/conventions/**`（`docs-naming.md` 覆盖 plans/improvements/experience，唯独漏 conventions） | rules frontmatter 逐条核 |
| R1b | CLAUDE.md 按需 read 表 14 行路由里没有「写 convention」行                                                                                   | 表逐行核                 |
| R2  | InstructionsLoaded 日志 362 条 trigger 记录中 `docs/conventions/**` 触发 **0** 条；同管道抓到 `docs/plans` 51 条 ⇒ 零不是探针盲区           | 裸文本 + JSON 双解析     |
| R3  | 项目级 PreToolUse 全是 `Bash` matcher —— 写文档不走 Bash，永远不经过任何 hook                                                               | settings.json            |
| R4  | lefthook `docs-organization-drift` 的 glob 不含 conventions，且只判文件名格式不读内容                                                       | lefthook.yml             |
| R5  | `claude-md-audit` skill 21KB 里「时点数字」只有 1 行擦边；且手动触发                                                                        | SKILL.md grep            |
| R6  | **出生语境污染**（最本质）：两份文件都诞生在重构 session，手边素材全是「修了几个/还剩几秒」——同 session 既产状态记录又产耐久规则，必然互渗  | #839 删除行              |

## 被实证否决的方案：按文本模式扫「时点数字」

两轮 precision 探针：naive 正则（日期/PR#/耗时/百分比/计数）63 命中，抽样几乎全合法
（`## 4 条规则`、`实证锚：PR #555`）；状态时态词（已修复/目前/当前）14 命中仍几乎全假阳
（git-workflow 的「现在时」说的是英文时态）。**真判据 =「会不会随时间失效」，是语义不是模式**
——正则够不着，硬拦只会训练出 `--no-verify`。warning-only lefthook 同样否决（不 gate 的警告
= 装饰，同 coverage 阈值被删的理由）。

## 平台机制判定（本轮关键增量，SoT 后续以 memory 平台事实条为准）

对 462KB InstructionsLoaded 日志做判别分析：

1. **path rule 在同 session 内会因新 trigger 文件重新装载**（去重按 (rule, trigger 文件)）——
   `mobile-e2e-hermetic` 被 3 个不同 spec 各触发一次。
2. **Write 新文件不触发 path rule**：本 session Write 命中 `docs/improvements/**` 的新文件，
   docs-naming 零再装载（而上一条已证明「新 trigger 会重发」，零不是去重假象）。n=1 + 机制自洽。
3. **settings.json 新增 hook matcher 中途即生效**：本轮加完 Write|Edit matcher，同 session
   内编辑 convention 立刻收到 rubric 注入（原以为要等下 session）。

⇒ 推论：**Edit 存量有 Read 前置兜底（rule 会装载），Write 新建是唯一裸奔路径**——而两次事故
恰恰都是 Write 新建。hook 是新建时刻的唯一覆盖通道，rule 与 hook 互补不冗余。

## 落地的防线

| 层             | 实体                                                                                      | 覆盖                                  |
| -------------- | ----------------------------------------------------------------------------------------- | ------------------------------------- |
| 写入时刻       | `scripts/pretooluse-convention-rubric.sh`（+9 臂 `.test.sh`，接进 CI Tooling self-tests） | Write 新建 + Edit（唯一全覆盖通道）   |
| read/edit 触发 | `.claude/rules/convention-authoring.md`（paths: `docs/conventions/**`）                   | 碰到 convention 即注入判据            |
| 路由           | CLAUDE.md 按需表加行                                                                      | 人/模型主动查表                       |
| 机器硬闸       | `scripts/checks/check-convention-orphan.ts`（lefthook + pr-validation 双接线）            | 孤儿 convention（零引用=红）          |
| 流程           | docs-organization.md「产出顺序」段                                                        | 直击 R6：先 improvements 后提炼       |
| 顺带           | sdd.md 抽 3 段 → `.claude/rules/sdd-authoring.md`（paths: `specs/**`）                    | always-load 19,848 → 16,042 B（−19%） |

maestro-testid.md（改造前唯一真孤儿）→ mobile-impl-playbook §10 加指针转绿（保留，Plan 4 醒来用）。

## 验证证据

- rubric 测试 9 臂全绿（含 3 个 fail-open 逆境臂）；hook 本 session **live-fire 实证**
  （编辑 docs-organization.md 时收到自己注入的 rubric）
- 孤儿 checker：现状绿（20 convention × 136 referrer）→ stash 藏指针红臂恰报 maestro-testid
  → pop 恢复绿；纯函数 6 用例入 `@nvy/checks`（112 tests 全绿）
- 悬空引用零：全仓 `sdd.md#` 锚点均指向仍留在 sdd.md 的段
- **待下 session 验**：L2 rule 的 Read 触发（`grep convention-authoring /tmp/claude-instructions-loaded.log`）

## 方法论

同一天批7 的教训换了个皮：**「规则写了」≠「规则在决策时刻在场」**。文档规约对「写文档的那一刻」
的作用，取决于装载机制是否覆盖那个动作——覆盖矩阵要按 (动作 × 通道) 逐格核，不能默认
「写在 canonical 里就生效」。
