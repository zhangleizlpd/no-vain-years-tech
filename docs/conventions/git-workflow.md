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

### AI agent 默认接 auto-merge

AI agent (Claude Code 等) 在 `gh pr create` 后**默认立即**调用：

```bash
gh pr merge <pr-num> --auto --squash --delete-branch
```

效果：CI 全绿且满足 ruleset → GitHub 自动 squash merge + 删 head 分支；CI 红 / 不满足 ruleset → PR 停在等修复。

**例外信号**（AI 不接 auto-merge 的情况）：

- user 明示"这个 PR 我自己 review / merge"
- PR 标记为 draft
- 改动涉及不可逆 / 高风险（DB 不可逆变更 / secrets / 删除大量代码）— AI 在 PR 描述里 flag "建议人工合并"
- 本对话内 user 早前说过"先停一下让我看看"
- **release-please Release PR**（标签 `autorelease: pending: <component>`，如 `autorelease: pending: server` / `: mobile`，per [ADR-0042](../adr/0042-monorepo-release-strategy.md) §4 双 manifest 拆分）— 发版时机由维护者控制，永远手动 merge（组件化 tag / 里程碑 tag 策略见 [versioning.md](versioning.md) + [ADR-0042](../adr/0042-monorepo-release-strategy.md)）
