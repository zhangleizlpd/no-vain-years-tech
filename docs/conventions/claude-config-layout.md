# Claude Code 配置布局

`.claude/` 随仓 tracked，clone 即生效；仓外唯一依赖是副 worktree 的 plan 落点 symlink（机制与换机重建见 [local-dev.md § Claude Code plan 落点](../../ops/runbook/local-dev.md)）。

## 配置项分布

- `.claude/` 下**所有内容默认进 git 团队共享**（`settings.json` / `commands/` / `skills/` / `rules/` / 项目级 prompt 资料等）
- 个人覆盖 `settings.local.json` 不进 git；运行时产物（`worktrees/` / `*.lock` 等）由 `.gitignore` / `info/exclude` 兜（单一真相源在那里）
- **路径锚点**：Hooks 嵌在 `settings.json` 内；Plans 落本仓 `docs/private/plans/`（主 worktree 由 `plansDirectory` 指向；副 worktree 回退 `~/.claude/plans`，dev 机把它 symlink 到同一目录 —— 两条路一个 inode，无同步问题；`plansDirectory` 只在 realpath 落在本 worktree 内时生效，机制与换机重建见上面那份 runbook）

## 全局 `~/.claude/` 的边界

全局 `~/.claude/` 只放跨项目个人偏好（keybindings / 通用 skill / agent）；内容只在本仓 working session 用到 → 本仓 `.claude/` + `CLAUDE.md`。**例外**：`~/.claude/plans` symlink —— 形式上在全局，实质是本仓的 plan 落点重定向（见 runbook）。

## 护栏措辞：条件必须对执行方可观测

往 `.claude/`（commands / skills / rules / 项目级 prompt 资料）写护栏时，每个条件落笔前先过一问：**执行它的那一方，从自己的上下文里能观测到这个条件吗？** 观测不到 → 换成无条件规则。

典型**不可观测**条件（被调用方一律看不见，别写进护栏）：

- 调用方身份 —— 人敲的 / 上游 agent 派的 / headless 跑的（收到的都只是一条 user turn）
- 上游是否已就此取得用户授权
- 上游意图 / 是不是「用户显式要求的」

后果不可逆的动作（外部写入 / 删除 / 发送）→ 直接做成**无条件闸**，不留身份或授权例外。

> 实证：`ops/runbook/claude-design.md` § 7 —— `create_project` 旧护栏写的是「用户显式敲命令 = 授权，agent 自主调用才停下问」。2026-08-01 证伪：这个区分从被调用方内部观测不到，于是它按「已授权」处理、自主建了 project。护栏不是被违反，是被写成了**不可实现的条件**。
