# GitHub Ruleset 静态配置参考

main 分支保护通过 GitHub Ruleset（**非** classic Branch Protection）+ 仓库 Pull Requests 设置组合启用。本文档列规则 type 与硬约束，**字段值实时 truth 走 `gh api` 单源**（避免文档 drift）。

## 仓库 PR 设置

- `delete_branch_on_merge=true` — auto-merge 后头分支自动删
- `allow_auto_merge=true` — `gh pr merge --auto` 生效前提
- 实时 truth：`gh api repos/<owner>/<repo> | jq '{delete_branch_on_merge, allow_auto_merge}'`

## Ruleset `main-protection` 规则

| 规则 type                | 用途                                                              |
| ------------------------ | ----------------------------------------------------------------- |
| `deletion`               | 禁止删除 main（永不放开）                                         |
| `non_fast_forward`       | 禁止 force push 到 main（永不放开）                               |
| `pull_request`           | PR 工作流约束（approve count / review dismissal / merge methods） |
| `required_status_checks` | 必绿 CI checks 名单 — CI job 改名 / 删除时**必须同 PR 同步改**    |

**实时 truth**：

```bash
gh api repos/<owner>/<repo>/rulesets | jq -r '.[] | select(.target=="branch") | .id' | \
  xargs -I {} gh api repos/<owner>/<repo>/rulesets/{}
```

## solo dev 期豁免（引第二人前必收紧）

solo dev 期 `pull_request.required_approving_review_count=0` + `require_code_owner_review=false` + `require_last_push_approval=false` + `required_review_thread_resolution=false`；引入第二人协作 / 内测前一并收紧 + 启用 CODEOWNERS。

## CI 改名硬约束

CI workflow job 重命名 / 删除时必须**同 PR** 改 ruleset `required_status_checks` contexts（否则 PR 被 ruleset 永久阻塞）。或拆两步走：先加新名同时保留旧名 → 改 ruleset → 删旧名。
