# PR 创建协议（CRITICAL）

> Claude Code 系统提示硬编码 `## Summary` + `## Test plan` 两段式 HEREDOC 作为 PR body 默认值；本仓 `.github/pull_request_template.md` 必含 `### 🚨 部署与存活前置确认 (Deployment & Smoke Gates)` 三 checkbox hard gate（per [ADR-0040](../adr/0040-multi-layer-test-gate.md) 多层门禁，由 `.github/workflows/pr-validation.yml` 的 `Enforce PR Checkboxes` step 严格 regex 解析）。
> `gh pr create --body "$(cat <<'EOF' ... EOF)"` 显式传值会 100% 覆盖仓库模板,部署 gate 静默丢失 → CI 必红。实证：旧私有仓 PR #85（2026-05-22）。

## 强制规则（执行 `gh pr create` 时）

1. **禁止使用 Claude Code 默认的 `## Summary` + `## Test plan` 两段式 HEREDOC**。任何 `gh pr create --body` 不含仓库模板必填 section 的写法等价于违规。
2. **创建前必须先读取 `.github/pull_request_template.md` 当前内容**作为 body 起点。仓库模板是唯一权威 source,不要凭记忆复刻。
3. **必须完整保留 `### 🚨 部署与存活前置确认 (Deployment & Smoke Gates)` section 与下方所有 checkbox**。CI 用正则 `/### 🚨 部署与存活前置确认[\s\S]*?(?=\n###?\s|$)/` 严格 match 此 section,缺失 → 红;含未勾项 → 红。
4. **本地已按 [local-verification.md § 2 命令矩阵](local-verification.md#2-命令矩阵) 的「PR 门」行跑通全量门（含 `--skip-nx-cache`，那里是命令串的唯一权威）拿到 exit 0** 才可把对应 `- [ ]` 改为 `- [x]`。未跑通 → 不勾、不 push、不创建 PR。
5. **docs-only / config-only PR** 三项 checkbox vacuously 满足时(`nx affected` empty graph / 无 Guard/Interceptor/Filter/Pipe/Repository 改动 / 无 `state_branches` 引入),可全勾,并在 section 上方加 HTML 注释 `<!-- docs-only / config-only: <理由> -->` 留痕。
6. **纯 SDD 文档 PR**（本 PR 引入了 `state_branches`,但**不含其实现**——spec / plan / tasks 先合、implement 另起 PR）:第 5 条的 vacuous 前提**不成立**。第三项「状态机闭环」字面为假,勾上等于在 hard gate 上声明一件尚未发生的事。**改写该条,不要勾它**——把它从 `- [ ]` 形态改成引用块说明行,写明「本 PR 不含实现 / 各分支的测试落点已在 `tasks.md` 覆盖预检表逐条映射 / 覆盖本身随 implement PR 落地并在那里勾选」。第 ① ② 项仍按第 5 条照常勾（对零代码改动是真 vacuous）。
   - **为什么这样可行**:CI 的判据是「`### 🚨 部署与存活前置确认` 段内不存在字面 `- [ ]`」(`.github/workflows/pr-validation.yml` 的 `Enforce PR Checkboxes`,live fetch 当前 body)。改成说明行同样绿,且**不声明任何虚假事实**——比「勾上再写注释辩解」诚实。
   - 🚫 **反向不成立**:**MUST NOT** 用同一手法改写第 ① ② 项。它们对含代码的 PR 是真判据,改写即绕过物理验证与 mock 门;本条豁免**只**针对「测试尚不存在是由 PR 边界决定、而非未做」这一种情形。
   - **形态先例**:该 gate 本就有按 PR 类型豁免的设计——release-please 的 Release PR 靠 `autorelease: pending*` label 整段跳过(同文件 `Enforce PR Checkboxes` 内)。本条是第二种类型豁免,不是新开逃生门。
   - 历史锚:2026-09-16 084 首次撞上此形态(SDD 产物先合、implement 另起 PR)。在那之前,仓内出现过的 docs-only PR 都是「impl 完成后的文档收口 / 状态订正」——其 `state_branches` 在当时早已有测试覆盖,第 5 条够用,故本条无需存在。

## 标准实现

```bash
# 1) 读模板 → 在编辑器/sed/cat 中填字段 → 写临时文件
# 2) --body-file 传入,禁止 --body "..."
gh-bot pr create --title "<conventional-commits-title>" --body-file /tmp/pr-body-<branch>.md   # agent 一律 gh-bot（git-workflow §身份归属）；人工才裸 gh
```

允许 HEREDOC,但必须**完整复刻 `.github/pull_request_template.md` 当前全部 section**（以模板实时内容为准、勿凭记忆枚举段数),尤其不省略 hard-gate `### 🚨 部署与存活前置确认` 段（3 checkbox）。

## 出错恢复路径

若已用错误 body 创建 PR、`Enforce PR Checkboxes` 红：

```bash
gh pr edit <N> --body-file <fixed.md>
```

完事。

> 🚨 **agent 身份（`gh-bot`）走不了上面这条** —— `gh pr edit` 的 GraphQL mutation 会连带查 reviewer / assignee 的 `login` / `name` / `slug`，那几个字段要 `read:org`，而 machine account 的 token 按最小权限只给了 `repo` + `workflow`，必然报 `Your token has not been granted the required scopes`。而 [git-workflow](git-workflow.md) 又规定 `gh pr edit` 必须走 bot ⇒ **这是 agent 路径上的默认形态，不是意外**。
>
> 改走 REST（同样触发 `pull_request.edited`，`Enforce PR Checkboxes` 的 live fetch 照常重跑，与上面等效）：
>
> ```bash
> gh-bot api -X PATCH repos/<owner>/<repo>/pulls/<N> \
>   -f "title=<新标题>" -F "body=@<fixed.md>" --jq '.title'
> ```
>
> `-F body=@<file>` 读文件内容（`-f` 只吃字面量）。
>
> ⚠️ **改 body 会让上一轮 `PR Validation` 被并发组取消**，而 `gh pr checks` 把 `cancelled` 显示成 `fail`。别据此判失败 —— 按 head sha + workflow 名锚定**最新那轮**再看。`.github/workflows/pr-validation.yml` 已配 `types: [..., edited]` → `gh pr edit` 自动唤醒新 workflow run;`Enforce PR Checkboxes` step 用 `github.rest.pulls.get` **live fetch** 当前 PR body 而非 webhook 快照 → 新 run 读到刚修好的 body → 绿。
