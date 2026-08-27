---
paths:
  - '.github/workflows/*.yml'
  - '.github/workflows/*.yaml'
  - '.github/CODEOWNERS'
---

# GitHub Ruleset 同步纪律（path-triggered，触及 `.github/workflows/` 或 `CODEOWNERS` 自动加载）

## 硬性规则

### 1. CI workflow job 改名 / 删除必须同 PR 改 ruleset

CI workflow job 重命名或删除时，**必须同 PR** 改 GitHub Ruleset `required_status_checks` 的 contexts 列表。否则 main 分支保护规则永久 block 后续 PR（旧 check 名等不到完成）。

**实操**：

```bash
# 1. 拿 ruleset id
gh api repos/<owner>/<repo>/rulesets | jq -r '.[] | select(.target=="branch") | .id'

# 2. 编辑 ruleset 中 required_status_checks.required_status_checks[].context
gh api -X PUT repos/<owner>/<repo>/rulesets/<id> --input <patched.json>
```

「拆两步走」fallback（先加新名保留旧名 → 改 ruleset → 删旧名）见 canonical [`docs/conventions/github-ruleset.md` § CI 改名硬约束](../../docs/conventions/github-ruleset.md#ci-改名硬约束)。

### 2. 改 `.github/CODEOWNERS` 通常 implies 引第二人协作

引入第二人 / 内测前必须**收紧 3 个豁免参数 + 启用 CODEOWNERS**（`required_approving_review_count` 已 ≥ 1，勿动）— 清单见 canonical [`docs/conventions/github-ruleset.md` § solo dev 期豁免](../../docs/conventions/github-ruleset.md#solo-dev-期豁免引第二人前必收紧)。

canonical：[`docs/conventions/github-ruleset.md`](../../docs/conventions/github-ruleset.md)（字段值实时 truth 走 `gh api`，本 rule 不复述）。
