# GitHub Ruleset 静态配置参考

main 分支保护通过 GitHub Ruleset（**非** classic Branch Protection）+ 仓库 Pull Requests 设置组合启用。本文档列规则 type 与硬约束，**字段值实时 truth 走 `gh api` 单源**（避免文档 drift）。

## 仓库 PR 设置

- `delete_branch_on_merge` 必须为 true — auto-merge 后头分支自动删
- `allow_auto_merge` 必须为 true — `gh pr merge --auto` 生效前提
- 实时 truth：`gh api repos/<owner>/<repo> | jq '{delete_branch_on_merge, allow_auto_merge}'`

## Ruleset `main-protection` 规则

| 规则 type                | 用途                                                              |
| ------------------------ | ----------------------------------------------------------------- |
| `deletion`               | 禁止删除 main（永不放开）                                         |
| `non_fast_forward`       | 禁止 force push 到 main（永不放开）                               |
| `pull_request`           | PR 工作流约束（approve count / review dismissal / merge methods） |
| `required_status_checks` | 必绿 CI checks 名单（改名纪律见 § CI 改名硬约束）                 |

**实时 truth**：

```bash
gh api repos/<owner>/<repo>/rulesets | jq -r '.[] | select(.target=="branch") | .id' | \
  xargs -I {} gh api repos/<owner>/<repo>/rulesets/{}
```

## solo dev 期豁免（引第二人前必收紧）

solo dev 期允许 `pull_request` 的 3 个参数为 false：`require_code_owner_review` / `require_last_push_approval` / `required_review_thread_resolution`（现值查 `gh api`）；引入第二人协作 / 内测前一并置 true + 启用 CODEOWNERS。

**`required_approving_review_count` 不在豁免之列（已 ≥ 1）**，其前提是 agent 侧走 `gh-bot`（见下 § machine account）；收紧或调整它之前先确认这一点。

## machine account

agent 动作走 machine account、人工动作走本人（行为表在 [git-workflow.md § 身份归属](git-workflow.md#身份归属agent-动作走-machine-account人工动作走本人)）。三条理由，按分量排：

1. **爆炸半径** —— 跑自动化的账号若同时是仓 owner，账号一被 flag，仓库连同 PR / Issue 全部 404。machine account 什么都不拥有，代价只是重签一个 token。
2. **可归因** —— 与 GitHub 自家 coding agent 的范式一致：agent 动作署 agent 身份、发起的人挂 co-author。
3. **它解锁了一道 solo dev 本来不可能有的闸** —— 你不能批准自己开的 PR，所以只要 agent 用你的身份开 PR，`required_approving_review_count` 就只能是 0。PR 改由 bot 开之后才能收紧，让「人类批准」成为真实卡点。

ToS 边界：§B.3 规定 machine account _"used exclusively for performing automated tasks"_ —— 不要拿 bot 干人工的事；§H 禁止 _"share API tokens to exceed GitHub's rate limitations"_ —— 「分摊 API 速率」不是理由，是被禁止的框架。

## CI 改名硬约束

CI workflow job 重命名 / 删除时必须**同 PR** 改 ruleset `required_status_checks` contexts（否则 PR 被 ruleset 永久阻塞）。或拆两步走：先加新名同时保留旧名 → 改 ruleset → 删旧名。
