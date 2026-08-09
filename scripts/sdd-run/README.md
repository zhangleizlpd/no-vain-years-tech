# `scripts/sdd-run/` — SDD auto-impl run helpers

支撑 `/sdd-auto-impl` 的运行期工具。两条路径，per [Phase 2 计划](../../docs/private/plans/2026-06/06-13-sdd-phase2-outer-safety-burst.md)。

## Track 1 · 交互式（免费，日常）

主 agent 在交互 session 内驱动子 agent，吃订阅交互额度。

| 脚本                          | 作用                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `append-run.mjs <runs.jsonl>` | 把一个 task 的 §3 结构化结果（经 **stdin**）追加一行；脚本自盖 `ts`。stdin 而非 shell 拼串 = 规避 bash3.2/CJK 折断。                                   |
| `run-report.mjs <runs.jsonl>` | 渲染 markdown 表（Task/Status/Commit/Files/Tests/Notes-or-blocked）。**无 cost/turn 列**——交互式子 agent 不回传遥测（issue #10164/#22625），诚实留空。 |

## Track 2 · Headless burst（付费，紧急）

`burst.mjs <NNN-slug>` 把**整个 feature** 当一次 `claude -p` 进程跑（process-per-feature），外层薄壳只管确定性护栏 + 抓 result + 出报告，**不碰推理**（与退役的 `scripts/orchestrator` 的命门区别）。

```bash
node scripts/sdd-run/burst.mjs 026-alert-condition-ux --cap 20 --max-turns 300 --wall 5400
```

外层安全栈（全确定性，不靠模型自限）：`--max-budget-usd`（per-run $ 闸）+ `--max-turns`（迭代闸）+ **node SIGKILL wall-clock**（`realRunner` 里 `setTimeout`→`child.kill`，**macOS 无 GNU `timeout`/`gtimeout`**，故不用外部 timeout 包；超时归一 exit 124）+ `--permission-mode dontAsk --allowedTools`（工具锁）+ **PreToolUse destructive-guard**（`scripts/pretooluse-burst-destructive-guard.sh`，env `SDD_BURST=1` 时拦 `rm -rf`/force-push/`reset --hard`/DB-drop 的 Bash 内容——`dontAsk` 只锁工具不锁 Bash 参数；交互式无此 env 故 no-op）。runaway 分类见 `classifyOutcome`（每 subtype 单测）。

### 🚨 Money gate（务必）

- **默认靠月度 SDK credit 池硬停当 $ 断路器**（Max5x $100 / Max20x $200/月，per [billing memo](../../docs/private/plans/2026-06/06-13-sdd-phase2-outer-safety-burst.md#11-运营预算模型用户定2026-06-13)）。
- **计费 console 里 usage credits 保持 disabled** → 池干自动硬停到下月。要跑特殊大单才**手动开溢出**（= 真按量花钱），跑完关掉。这是你的「我现在要花真钱了」人肉闸。
- 池中途干 → `burst.mjs` 分类 `pool_drained`，partial commits 已在分支可续。

### 确认进度（T2-1 探针 2026-06-13）

- ✅ **`result` 字段名**：实测确认带 `total_cost_usd` / `num_turns` / `duration_ms` / `usage{input_tokens,output_tokens,cache_*}` / `modelUsage` / `subtype` / `is_error` / `session_id` —— `burst.mjs` 解析全对。
- ✅ **wall-clock**：探针刨出 macOS 无 GNU `timeout`/`gtimeout` → 已改 node SIGKILL 定时器。

### 确认进度（T2-9 校准 2026-06-13，015 T016 真跑 success → [基线档](../../docs/private/plans/2026-06/06-13-burst-calibration-baseline.md)）

1. ✅ **`--allowedTools` 空格分隔被接受**（L2 模型成功调 Bash/Edit/Write/Agent）。
2. ✅ **`claude -p "/sdd-auto-impl …"` 能解析 slash 命令**（未 `--bare`，命令发现开着）。
3. ⚠️ **池干（`pool_drained`）错误形状仍未确认**——6.15 前无独立 SDK 池可干，须 6.15 后或手动开溢出才能测。
4. 🟡 **`DEFAULTS`（cap $20 / 300 turns / 90min）有单-task 锚点缺多-task 样本**：稳态 ≈ **$0.331/turn**（$7.62/23）。$20 是绑定约束（≈60 turn ≈ 2-3 task），maxTurns 300 是死循环兜底（非绑定，设计如此）。$20 撑零头 feature 够，整 feature 须上调 cap 或预期半路 `max_budget` abort（可续）。数值暂不动，待多-task 实测。

## 观察 / 调试（stream-json）

burst 用 `--output-format stream-json --verbose`（**不是 `json`**——`json` 把输出缓冲到结尾，被 SIGKILL/超时的 run 就**零遥测零可见性**，2026-06-13 smoke 实证）。`realRunner` 把事件流**实时 tee** 到 `specs/<feat>/.sdd-run/stream-<ts>.jsonl`，并经 `burst-view.mjs` reducer **实时打 stderr 进度行**（`◆ init` / `▶ T<n> Tool(...)` / `✓ result` / `■ outcome·$·turns·s`）。

被 kill 的 run 留了完整 trace，事后回放：

```bash
node scripts/sdd-run/burst-view.mjs specs/<feat>/.sdd-run/stream-<ts>.jsonl   # 格式化回放
# 手动 escape hatch（看 thinking/text 原文）：
jq -rj 'select(.type=="stream_event" and .event.delta.type?=="text_delta") | .event.delta.text' specs/<feat>/.sdd-run/stream-*.jsonl
```

> 选型（2026-06-13 调研）：业内无现成工具吃 `claude -p` stream-json **stdout**（transcript 查看器读 `~/.claude/projects/*.jsonl` 异格式；claude-trace 拦 HTTP 层；ccusage 读 statusline）。故自写 ~30 行 NDJSON reducer（live + 事后同一码路）。退役 orchestrator 的 **Listr2 task-tree 过度设计**（task-tree 配不上无界的 tool-call 流），改纯 append-only 行。

## 测试

```bash
node --test scripts/sdd-run/burst.test.mjs        # 21 用例（含真 SIGKILL wall-clock），fake-runner，零真实 -p 花费
node --test scripts/sdd-run/burst-view.test.mjs   # 9 用例，stream-json reducer 各 event 渲染
```

Track 1 脚本走 smoke（见 PR #422）。本目录为 dev 工具，非 nx 项目，不入 CI affected 图。
