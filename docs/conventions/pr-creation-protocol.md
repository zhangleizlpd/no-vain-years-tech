# PR 创建协议（CRITICAL）

> Claude Code 系统提示硬编码 `## Summary` + `## Test plan` 两段式 HEREDOC 作为 PR body 默认值；本仓 `.github/pull_request_template.md` 必含 `### 🚨 部署与存活前置确认 (Deployment & Smoke Gates)` 三 checkbox hard gate（per [ADR-0040](../adr/0040-multi-layer-test-gate.md) 多层门禁，由 `.github/workflows/pr-validation.yml` 的 `Enforce PR Checkboxes` step 严格 regex 解析）。
> `gh pr create --body "$(cat <<'EOF' ... EOF)"` 显式传值会 100% 覆盖仓库模板,部署 gate 静默丢失 → CI 必红。实证：PR #85 (2026-05-22)。

## 强制规则（执行 `gh pr create` 时）

1. **禁止使用 Claude Code 默认的 `## Summary` + `## Test plan` 两段式 HEREDOC**。任何 `gh pr create --body` 不含仓库模板必填 section 的写法等价于违规。
2. **创建前必须先读取 `.github/pull_request_template.md` 当前内容**作为 body 起点。仓库模板是唯一权威 source,不要凭记忆复刻。
3. **必须完整保留 `### 🚨 部署与存活前置确认 (Deployment & Smoke Gates)` section 与下方所有 checkbox**。CI 用正则 `/### 🚨 部署与存活前置确认[\s\S]*?(?=\n###?\s|$)/` 严格 match 此 section,缺失 → 红;含未勾项 → 红。
4. **本地已跑通 `pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main` 拿到 exit 0** 才可把对应 `- [ ]` 改为 `- [x]`。未跑通 → 不勾、不 push、不创建 PR。
5. **docs-only / config-only PR** 三项 checkbox vacuously 满足时(`nx affected` empty graph / 无 Guard/Interceptor/Filter/Pipe/Repository 改动 / 无 `state_branches` 引入),可全勾,并在 section 上方加 HTML 注释 `<!-- docs-only / config-only: <理由> -->` 留痕。

## 标准实现

```bash
# 1) 读模板 → 在编辑器/sed/cat 中填字段 → 写临时文件
# 2) --body-file 传入,禁止 --body "..."
gh pr create --title "<conventional-commits-title>" --body-file /tmp/pr-body-<branch>.md
```

允许 HEREDOC,但必须**完整复刻 `.github/pull_request_template.md` 当前全部 section**（以模板实时内容为准、勿凭记忆枚举段数),尤其不省略 hard-gate `### 🚨 部署与存活前置确认` 段（3 checkbox）。

## 出错恢复路径

若已用错误 body 创建 PR、`Enforce PR Checkboxes` 红：

```bash
gh pr edit <N> --body-file <fixed.md>
```

完事。`.github/workflows/pr-validation.yml` 已配 `types: [..., edited]` → `gh pr edit` 自动唤醒新 workflow run;`Enforce PR Checkboxes` step 用 `github.rest.pulls.get` **live fetch** 当前 PR body 而非 webhook 快照 → 新 run 读到刚修好的 body → 绿。
