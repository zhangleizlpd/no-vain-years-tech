---
description: 主 agent 自动驱动整个 feature 的 SDD impl（单 feature = 单分支 = 单 PR；子 agent 干净上下文执行，零机械停顿，只在真决策停下问 user）
argument-hint: <feature-dir 或 NNN-slug> [--dry-run]
allowed-tools: Agent, Bash, Read, Edit, Write, Monitor, Glob, Grep
---

# /sdd-auto-impl —— 全 feature 自动 impl 驱动器（单 PR 模型）

**用途**：把 `/speckit-implement` 从「你守着、每 2-3 task 手动 /clear + 继续」升级成「主 agent 当调度器自动跑完整个 feature，只在**真决策点**停下问你」。

**路线 = 主 agent 驱动子 agent（route B）**，不是 `/loop`、不是 Workflow：

- **主 agent（你正在用的这个 session）= 驱动循环 + 决策守门 + PR/CI 收尾**。
- **子 agent（Agent 工具）= 每 task 一份全新上下文**，只拿 brief、只负责红绿实现 + atomic commit，跑完即弃。
- 主 agent **只收结构化摘要**，impl 细节全关在子 agent 里 → 主 agent 上下文不膨胀 → **「/clear 检查点批次」这个机械停顿从根上消失**（取代 `.claude/rules/implement-task-closure.md` § Clear 检查点批次）。

**PR 模型 = 一个 feature 一个分支一个 PR**（含 server + contract + mobile 全部 task，原子 merge）。

> 🚨 为什么单 PR：monorepo 单 PR 里 api-client regen 的 client 就在同一棵树，mobile 直接 import，**原子 merge 零类型 drift 窗口**。代价 = feature 整体 revert（已接受）。**本命令不实现跨 PR 接力 / Monitor 等 merge 重建分支**——那段已随单 PR 决策删除。
>
> ⚠️ 与 Constitution §V「cross-end 两段式」冲突——adopt 本命令需同步 amend §V 为「cross-end 默认单 PR」。
>
> 🚨 **CRITICAL — 整个机制的命门**：**NEVER** 让主 agent 自己读 impl 文件、跑测试、写实现。impl 的一切（读码 / 写测试 / 调试 / typecheck）**必须**派给子 agent。主 agent 一旦自己下场，上下文就膨胀，机制失效。主 agent 只做：解析 → 派单 → 收摘要 → 判 stop signal → 收尾。

---

## 0. 前置校验（动任何东西前）

1. **解析参数**：`$ARGUMENTS` 第一个 token = feature（`specs/NNN-slug/` 或裸 `NNN-slug`）；含 `--dry-run` → 走 § 自测模式；含 `--unattended` → 行为覆盖见 § 无人值守模式（Track 2 headless burst 专用，通常由 `scripts/sdd-run/burst.mjs` 经 `claude -p` 注入，**不手动加**）。
2. **rev-parse 实证当前分支**（`git rev-parse --abbrev-ref HEAD`）——🚨 **禁信 session-start snapshot**，本仓 worktree HEAD 会被别的 session 挪动（实测漂移过）。
3. **读三件套**：`spec.md` / `plan.md` / `tasks.md`。tasks.md 不存在 → 停，提示先跑 `/speckit-tasks`。
4. **解析 task 列表**：tasks.md 里所有 `- [ ] T<N>`（pending）按出现顺序 = 依赖序；`- [X]` 跳过（已完成）。读 tasks.md 头部的**铁律段**（配色/回归/路径约定）——这些指针要原样塞进子 agent brief。
5. **echo 执行计划给 user**（一次性，不等审批）：分支名 `NNN-slug` / 待跑 task 数 / task 清单。然后直接进 § 1，**不停下等确认**（除非 user 本就喊过停）。

---

## 1. 主循环（单 PR）

### a. 分支就位

```bash
git rev-parse --abbrev-ref HEAD          # 实证
# 不在 NNN-slug 上 → 从 main 切：
git switch main && git pull --ff-only && git switch -c NNN-slug   # 已存在则 git switch NNN-slug
```

🚨 切分支前**每次** rev-parse 实证，禁照抄变量 / snapshot。base 必须是最新 main。

### b. Per-GROUP 子 agent 循环（上下文分组，按依赖序）

> 🚨 **不再 1-task-1-agent**（实测教训，见 `docs/experience/optimizations/`）：每子 agent 约 **28K 固定预载**（系统 + CLAUDE.md + @import 约定 + MEMORY.md + 工具 + brief），**每轮重读一遍**；N 个子 agent = N 份预载重复税，且关联 task 各自重读同一批文件。某次 16-task 实跑 **cache_read 占总成本 54%**（写入仅 33%），单个失控的 166-轮子 agent 独吞 15%。改为**按上下文关联度分组**：一个子 agent 干一组关联 task，组内**复用已读文件 + 只付一份预载**。

**Step 0 — 任务分组（派单前主 agent 做一次，echo 给 user）**：把所有 pending（`- [ ]`）task 切成若干**组**，每组同时满足：

- **上下文关联**：同 layer / 同文件簇 / 前 task 产出是后 task 直接输入（如 server `provider+UC+controller+IT` 一组；mobile `client+hook+screen+e2e` 一组；多个纯函数/微 task 合一组）。
- **≤ 5 task/组** 且 **≤ ~90 子 agent 轮次预算**（两者先到先切）。
- **合并微 task**：纯函数 / <30min 的小 task 同簇塞一组（省多份预载）。
- **拆失控大 task**：若**单个** task 自己就可能 >90 轮（牵涉文件极多 / 探索重，如「建 module + 扫改 N 个既有文件」），它**独占一组**或先拆更小 task。
- 组间按 tasks.md 依赖链排；组内按依赖逐个做。echo「task→组」映射给 user，直接进循环不等审批。

**对每个 task 组**：

0. **组装该组 anchor**（主 agent 轻量提取，🚨 **不读 impl 文件本体**）：对组内每个 task 摘 ① **继承决策**（plan `## Architecture Notes` / `D#` / Open Decisions 的叶子边界 / 派生规则如恒走 `deriveAdjustedBars(...,'forward')` / append-only / 跨 ctx 仅 import `*.rules.ts`——干净上下文盲区，代码看不出）② **golden 参考**（查 `docs/conventions/golden-sample-registry.md`）③ **相关现有代码**路径（2-4 个）。
1. **派一个子 agent 干整组**（Agent 工具，brief 见 § 2，列出组内全部 task 按序 + 各自 anchor + 组轮次预算）。
2. **收子 agent 结构化结果**：组内**每个 task 一个** fenced ```json 块（契约 § 3），主 agent 逐个解析。
3. **逐 task 校验 + dispatch 计数 `attempts`**（per task，首派 = 1）。按各 task `status`：
   - `done` → 校验该 task 确 commit（`git log` 见该 task）+ tasks.md 该行 `[X]`。**过** → 记审计（step 6）→ 下个 task。**不过**（commit 缺 / 未翻）→ 该 task 走 🔁 重派（`attempts++`，单独补派该 task 给新子 agent）。
   - `blocked` → **暂停主循环**，把该 task `stop_signal`（类型 + 详情 + 候选方案）抛 user 等决策；答复后塞进重派 brief，`attempts++`。
   - 解析不到 json → 当 `blocked` 停。
   - 🔁 **max-retry 断路器（CRITICAL，per task）**：任一 task `attempts` 达 **3** 仍未拿到「校验过的 `done`」→ **硬停整个主循环**升级 user，不再自动重派。**NEVER 无限重派**（计数型，主 agent 自己数）。
4. ⏱ **轮次预算护栏**：子 agent 在 brief 里被告知组预算 ~90 轮。若它**未做完整组就到预算**（cache_read 随轮次近似**二次**膨胀，长组尾段退化成失控），它应**提交已完成 task + 返回剩余 task 清单**（结果契约 `remaining`）；主 agent 给**剩余 task 派新子 agent 续跑**（fresh 预载 ≪ 继续让上下文膨胀）。
5. 🚨 **每 task 各自 atomic commit**——组内多 task **绝不**合一 commit（Constitution §III）。分组省的是预载 / 重读，**不是** commit 粒度。
6. **记审计（薄 JSONL，每 task 一行，无论 done / blocked）**：该 task § 3 json 经 **stdin** 喂 `node scripts/sdd-run/append-run.mjs specs/NNN-slug/.sdd-run/runs.jsonl`（脚本自盖 `ts`）。
   - 🚨 走 stdin **不**shell 拼串（`notes` 含中文，规避 macOS bash 3.2 brace/CJK 折断）。
   - 交互式**无** cost/token 列（子 agent 不回传遥测，issue #10164/#22625）——诚实留空。

### c. 全 task 绿 → 开 PR + auto-merge

1. `git push -u origin NNN-slug`。
2. `gh pr create --repo zhangleizlpd/no-vain-years`：
   - 🚨 body **必走仓库模板** `.github/pull_request_template.md`（CI 严格 regex 扫部署 gate 3-checkbox，缺/未勾全红——见 `docs/conventions/pr-creation-protocol.md`）。
   - title 走 Conventional Commits（`feat(<scope>): NNN <feature 一句话>`）。
3. **接 auto-merge**（per git-workflow 默认）：`gh pr merge <num> --repo ... --auto --squash --delete-branch`。
   - 🚨 **auto-merge 启用后 NEVER 再 push 新 commit**（race window 孤儿化新 commit）。要补改 → 等终态后新分支。
   - **例外不接 auto-merge**（per git-workflow）：跑中撞过不可逆/高风险 op、user 明示自己 review、PR draft → 停下 flag，不接 auto-merge。

### d. Monitor CI 到终态 → 报告

1. **Monitor 工具**轮询 `gh pr checks <num> --repo ...`（regex：`skipping` 不算 fail，per memory `feedback_monitor_skipping_not_failure`）直到终态。
2. 分流：
   - **merged**（auto-merge 落地）→ § 3 终报告。
   - **CI 失败** → **停**，报告失败 job + 日志摘要，问 user 怎么修（可能要派子 agent 修，但先等 user 定向；🚨 auto-merge 已启用，修法走新分支，别在原 PR 再 push）。

---

## 2. 子 agent brief 模板

每次派子 agent，brief 必含（**只给指针，不灌内容**——子 agent 自己 path-trigger 加载 CLAUDE.md / 闭环规则 / 约定）：

```text
你是一个干净上下文的 SDD impl 子 agent，负责按依赖序实现**下面这一组关联 task**，不继承任何对话历史。
每个 task 各走完整闭环、**各自 atomic commit**（绝不合一 commit）；做完一个再做下一个。

## 轮次预算
本组预算 ~90 轮（tool use）。**若未做完整组就接近预算**：把已完成的 task 各自 commit 好，
**停下**，在结果里 `remaining` 列出未做的 task（主 agent 会派新子 agent 续跑）。别硬撑——长上下文尾段会显著变慢变贵。

## 目标 task 组（按此顺序逐个做）
<逐个列：tasks.md 整行（T 号/层 tag/描述/文件路径）+ 紧跟该 task 的三段 anchor↓>
### T<N> <描述>
- 继承决策：<1-3 条该 task 必守的强约束；无则「无特殊继承决策」>
- golden 参考：<golden-sample-registry.md 样板路径 + 一句「学什么」>
- 相关现有代码：<2-4 个文件路径>
### T<N+1> ...（同上结构；组内后续 task 可复用前 task 已读文件，别重读）

## 上下文指针（自己读）
- spec:  specs/NNN-slug/spec.md（验收口径）
- plan:  specs/NNN-slug/plan.md（技术决策全文）
- tasks: specs/NNN-slug/tasks.md（依赖 / 铁律段——配色/回归/路径约定全在头部）

## 每个 task 的必守闭环（强制，详见 .claude/rules/implement-task-closure.md 6 步）
红：写测试→typecheck pass + RED → 绿：写实现→GREEN → typecheck+lint pass
→ 把 tasks.md 该行 `- [ ] T<N>` 翻成 `- [X] T<N>`
→ git add impl+测试+tasks.md 同 stage → **该 task 单独** atomic commit（Conventional Commits，scope=业务模块）
- 新文件首跑测试带 `--skip-nx-cache`（防假绿）
- server testcontainers spec 走 `nx test server <file>`（cwd=apps/server），非 `vitest --root`
- 改 server controller/DTO/openapi 后按 api-contract-trigger 同步 mobile types（同 PR 内 regen）
- mobile 测试分层：纯逻辑=vitest；UI/render/a11y/交互=Playwright Expo Web e2e（~/ui 不写 vitest）

## 撞到下列任一 → 不自作主张，该 task 标 status=blocked 上报（见结果契约），组内其余可继续
1. spec 歧义（多种合理实现，关键行为未定）
2. 需引入未锁定新依赖（npm 包 / 二进制资产）
3. 不可逆 / 高风险 op（DB 不可逆 / 删大量代码 / secrets / 生产资源命名）
4. 改动溢出本 feature（牵动他 feature / 平台层大改）

## 返回（每完成一个 task 输出一个 § 3 fenced json 块；全组做完把所有 json 块放最后，主 agent 逐个解析）
```

> Brief 里「继承决策」+「golden 参考」+「相关现有代码」三段由主 agent 在 § 1.b step 0 提取——子 agent 没对话上下文，给错就瞎读 / 违范式。来源：继承决策 = plan.md 决策段（`D#` / Open Decisions / Architecture Notes）；golden = `docs/conventions/golden-sample-registry.md`；相关代码 = plan 文件映射 + tasks.md 路径。范式护栏 / 隐性坑**不进 brief**——子 agent 碰路径自动加载 `.claude/rules/*`（server/mobile playbook、migration、e2e-hermetic、bounded-context 等 Tier 2 规则）。

---

## 3. 子 agent 结果契约

子 agent 最终消息**末尾**放 fenced json 块——**组内每完成（或 blocked）一个 task 一个块**，主 agent 逐个解析：

```json
{
  "task_id": "T007",
  "status": "done",
  "commit_sha": "<短 sha>",
  "files_changed": ["apps/server/src/alert/..."],
  "test_summary": "3 vitest 绿 / 1 IT 绿",
  "stop_signal": null,
  "notes": "一句话：做了什么 / 有无需知会下个 task 的产出"
}
```

- `blocked` 时 `status:"blocked"`、`commit_sha:null`、`stop_signal:{type:1-4, title, detail, options:[...]}`（该 task blocked，组内其余仍可继续，各自照常返回）。
- **到轮次预算未做完整组**：已完成的正常返回 done 块；末尾再加一个 `{"task_id":"<group>","status":"budget_exhausted","remaining":["T0NN","T0NN+1"],"notes":"已完成 X，剩 Y"}` 块——主 agent 据此给 `remaining` 派新子 agent 续跑。

---

## 4. Stop signals（唯一允许的「停下问 user」）

除这 4 类 + § d 的 CI 失败 + auto-merge 例外，**NEVER 自作主张停**：

1. **spec 歧义** → 回 `/speckit-clarify` 或直接问 user，**不默认挑一个**（CLAUDE.md Ambiguity Handling）。
2. **新依赖** → flag + 列选型理由，等 user 锁。
3. **不可逆 / 高风险 op** → PR 描述 flag「建议人工合并」，不接 auto-merge。
4. **改动溢出本 feature** → 确认是否拆独立改动，别把无关改动夹进本 PR。

---

## 5. 终报告

PR ship（或撞 stop 终止）后给 user：

- **PR**：分支 / PR# / 链接 / CI 状态（merged / 卡住原因）。
- **tasks 表**：跑 `node scripts/sdd-run/run-report.mjs specs/NNN-slug/.sdd-run/runs.jsonl` 出 markdown 表（Task/Status/Commit/Files/Tests/Notes-or-blocked）贴进报告——这是 tasks 完成情况 + 待决策项的**单一数据源**（取代主 agent 凭记忆临时拼）。无 cost/turn 列（交互式无遥测）。
- **耗时** + 下一步建议。

---

## 无人值守模式（`--unattended`，Track 2 headless burst 专用）

跑在 `claude -p` 里、**无人可问**。以下行为**覆盖**默认（其余照旧；预算/超时/工具锁由外层 `burst.mjs` 经 `--max-budget-usd` / `--max-turns` / `timeout` / `--permission-mode dontAsk` 确定性兜底，命令内不管）：

1. **4 类硬 stop-signal（§ 4）→ 不死等，abort 整个 feature**：把 stop_signal 写进 `specs/NNN-slug/.sdd-run/runs.jsonl`（status=blocked）+ **终止主循环**。已完成 task 的 atomic commit 留在分支（**可续**：人审后续跑或转交互式）。**NEVER** 在 headless 里就地猜不可逆/高风险决策。
2. **低风险歧义（非 4 类）→ 不 stop、不瞎选**：用 `[ASSUMPTION: <你的决定 + 一句依据>]` 标记，写进**该 task commit message** + 累积到 **PR body 的 `## Assumptions` 段**，继续跑。人早上逐条审。判定基线：可逆 + 不碰 schema/auth/public-API/跨 ctx 边界 → 算低风险。
3. **PR 开了 NEVER 接 auto-merge**：headless 一律**停在 review**（morning gate 是 burst 的全部意义）。PR body 必含 `## Assumptions`（第 2 条累积，空则写「无」）+ 完成/blocked task 清单。
4. **max-retry 断路器（§ 1.b）触发 → 同第 1 条**：abort + 写 blocked + 终止，不回头问（无人可问）。
5. **池中途干**（API insufficient-credit 报错）：按第 1 条 abort + 报告，由外层 `burst.mjs` 分类成 `pool_drained`（partial 可续）。

> 交互式默认（问 user + 等 + 接 auto-merge）与本模式互斥，仅由 `--unattended` 切换。**不要**两种行为混用。

---

## 铁律汇总（CRITICAL）

1. 🚨 主 agent **永不**自己下场 impl——只解析/分组/派单/收摘要/守门/收尾。违反 = 机制失效。
2. 🚨 **按上下文关联度分组派单**（≤5 task/组 且 ≤~90 轮预算，先到先切；合并微 task、拆失控大 task），**不 1-task-1-agent**——省固定预载重复税 + 组内复用已读文件（cache_read 是主成本，见 § 1.b）。
3. 🚨 子 agent 上下文**全新**，只拿 brief，不继承本对话。
4. 🚨 分支操作前**每次** rev-parse 实证，禁信 snapshot；base 必须最新 main。
5. 🚨 `gh` 命令**必带** `--repo zhangleizlpd/no-vain-years`。
6. 🚨 auto-merge 启用后**禁止**再 push 新 commit。
7. 🚨 每 task **各自** atomic commit，**禁** 多 task 合一（组内多 task 也各自 commit——分组省预载，不改 commit 粒度）。
8. 🚨 单 feature = 单分支 = 单 PR，**不做**跨 PR 接力。
9. 🚨 **max-retry 断路器**：单 task `attempts` 满 3 次仍未过 → 硬停升级，**禁无限重派**；每 task 必记一行薄 JSONL 审计（§ 1.b step 6）。
10. ⏱ **轮次预算护栏**：子 agent 到 ~90 轮未做完组 → 提交已完成 + 返回 `remaining`，主 agent 派新子 agent 续跑（fresh 预载 ≪ 长上下文二次膨胀）。
11. 🚨 **`--unattended` 下**：4 类 stop-signal / 断路器 / 池干 → **abort + 写 blocked + 终止**（不死等）；低风险歧义 → `[ASSUMPTION:]` 标记续跑；PR **永不** auto-merge（见 § 无人值守模式）。
12. 🚨 派会**创建 / 切换 git 分支**的子 agent（临时 chore PR / rebase / cutover 等旁路任务）→ Agent 工具**必带** `isolation: 'worktree'`。否则子 agent 的 `git switch -c` 改的是**共享 worktree 当前分支**、跑完留在那，污染主 agent 后续所有 `git diff` / `git log`（实测吃过：在错分支上误判 schema migration 冗余 + 跨表混淆字段）。本 skill 核心流的子 agent 只在主 agent 建好的 feature 分支上 commit（不切分支，无需隔离）——本条专防**派出会自建分支的旁路子 agent**。万一未隔离就派了 → 子 agent 返回后第一件事 `git rev-parse --abbrev-ref HEAD` 实证 HEAD 再分析；任何「分支级反常结论」（commit 数骤减 / delta 为空 / 文件凭空消失）下结论前先核 HEAD 在哪。

---

## 自测模式（`--dry-run`）

验证编排控制流，**不碰真实模块、不开真 PR、不等 CI**：

1. **fixture** = `specs/000-autoimpl-selftest/`（throwaway feature，所有 task 只写 `specs/000-autoimpl-selftest/sandbox/` 下文件，零碰真实 app 代码）。
2. **隔离**：临时 git worktree 跑（`git worktree add /tmp/autoimpl-selftest-wt -b autoimpl-selftest-throwaway`），结束 `git worktree remove --force` 丢弃——junk 永不进真实树 / main。
3. **真跑**（验证机制）：tasks 解析 → 子 agent brief → 子 agent 干净上下文实现 sandbox task → 结构化结果解析 → stop-signal 协议 → **薄 JSONL 审计 append（§ 1.b step 5）+ max-retry 断路器计数**（写到 `specs/000-autoimpl-selftest/.sdd-run/`，随 sandbox 一并丢弃）。
4. **模拟**（不触 GitHub）：`git push` / `gh pr create` / `gh pr merge` / Monitor → 打印「WOULD run: ...」+ 直接当 merged 收尾。
5. **产出**：一份 § 5 报告，标注哪些真跑、哪些模拟。真实 GitHub/Monitor 腿在**第一个真 feature**（你在旁看着那次）验收。

> 自测只证明「调度 / 隔离 / 契约 / 守门逻辑」对。真实 impl 质量、CI、auto-merge 由第一次真跑 supervised 验收。
