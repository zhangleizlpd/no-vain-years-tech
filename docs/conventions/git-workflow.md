# Git 工作流

## 分支命名

两套并行，根据改动类型选其一：

**A. SDD feature 分支** — spec-kit 自动产出（per [ADR-0024](../adr/0024-spec-feature-first-layout.md)）

`NNN-<feature-slug>`（3 位 sequential + kebab-case slug），由 `/speckit-specify` 自动创建，与 `specs/NNN-<feature-slug>/` 同名（branch ↔ dir ↔ PR 三位一体）。

示例：`001-phone-sms-auth` / `002-account-profile`

**B. 非 SDD 改动分支** — 走传统 `<type>/<kebab-desc>`

| type       | 用途                                                        |
| ---------- | ----------------------------------------------------------- |
| `fix`      | bug 修复（非 spec scope，如 infra / build / 紧急 patch）    |
| `hotfix`   | 紧急修复（已上线缺陷）                                      |
| `chore`    | 杂项（依赖更新、配置等无业务逻辑改动）                      |
| `refactor` | 重构（不改外部行为）                                        |
| `docs`     | 仅文档变更（含 ADR / convention amend / experience report） |

示例：`fix/prisma-migrate-drift` / `docs/adr-0024-spec-layout` / `chore/repo-init-skeleton`

## Commit 消息

遵循 Conventional Commits：`<type>(<scope>): <subject>`

| 字段      | 说明                                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `type`    | `feat / fix / docs / chore / refactor / style / test / perf / build / ci / revert`；`feat!` 或加 `BREAKING CHANGE:` 表示 breaking      |
| `scope`   | 业务模块名（`account / portfolio / ...`），跨模块用 `core`，整仓配置/工具用 `repo`，packages 共享包用 `api-client` / `shared-types` 等 |
| `subject` | 一句话描述本次改动；现在时；首字母小写；不加句号                                                                                       |

示例：

- `feat(account): add phone-sms-auth NestJS use case`
- `fix(account): handle Aliyun SMS retry timeout`
- `chore(repo): init mono-repo skeleton`

## PR 合入

- Squash merge，commit 消息使用 PR title（保持符合 Conventional Commits）
- 合并后 feature 分支自动删除

## 身份归属：agent 动作走 machine account，人工动作走本人

仓已公开。**自动化动作与人工动作必须落在不同的 GitHub 账号上。**

| 动作                                                  | 身份             | 本地怎么执行             |
| ----------------------------------------------------- | ---------------- | ------------------------ |
| agent 写的 commit（author = bot，发起人挂 co-author） | machine account  | `git-bot commit …`       |
| `push` feature 分支                                   | machine account  | `git-bot push …`         |
| `gh pr create` / `edit` / `merge`                     | machine account  | `gh-bot pr …`            |
| CI 状态轮询等只读调用（量最大的一类）                 | machine account  | `gh-bot run/pr checks …` |
| **批准 PR**                                           | **本人（人工）** | 裸 `gh` / 网页           |
| 改 ruleset / repo 设置 / 加 secret / 建删仓           | **本人（人工）** | 裸 `gh` / 网页           |
| 你自己手写的 commit                                   | 本人             | 裸 `git`                 |

三条行为句（理由与 ToS 边界见 [github-ruleset.md § machine account](github-ruleset.md#machine-account)）：

- 🚨 **不要拿 bot 干人工的事**（批准 PR / 改 ruleset / 加 secret）—— machine account 只许做自动化任务，否则账号本身不合规。
- **自强制**：ruleset `required_approving_review_count ≥ 1` 且 GitHub 不允许自批 → 用本人身份开的 PR 永久卡住。撞上了就关掉、用 `gh-bot` 重开。
- `gh-bot` / `git-bot` 在 dev 机 `~/.nvy/bin/`（装机见私有 runbook），每次调用显式注入凭据、不改全局状态 —— **禁 `gh auth switch`**：切换是全局的，忘切回就静默走错账号。

### AI agent 默认接 auto-merge

AI agent (Claude Code 等) 在 `gh-bot pr create` 后**默认立即**调用：

```bash
gh-bot pr merge <pr-num> --auto --squash --delete-branch
```

效果：CI 全绿 **且**满足 ruleset 的 approval 要求（由你人工批）→ GitHub 自动 squash merge + 删 head 分支；任一条件不满足 → PR 停在那里等。

⚠️ auto-merge **armed 之后禁止再往该 PR push 新 commit** —— 会导致 PR 孤儿化。要改内容就先撤掉 auto-merge。

**例外信号**（AI 不接 auto-merge 的情况）：

- user 明示"这个 PR 我自己 review / merge"
- PR 标记为 draft
- 改动涉及不可逆 / 高风险（DB 不可逆变更 / secrets / 删除大量代码）— AI 在 PR 描述里 flag "建议人工合并"
- 本对话内 user 早前说过"先停一下让我看看"
- **release-please Release PR**（标签 `autorelease: pending: <component>`）— 发版时机由维护者控制，永远手动 merge。版本号 / 发版链 / `release-as` / 改 release-please 配置 → [versioning.md](versioning.md)
