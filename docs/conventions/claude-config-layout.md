# Claude Code 配置布局

仓库**独立**维护 `.claude/` 目录。clone 本仓时配置完整生效。

## 配置项分布

- `.claude/` 下**所有内容默认进 git 团队共享**（`settings.json` / `commands/` / `skills/` / `rules/` / 项目级 prompt 资料等）
- **唯一例外**：`settings.local.json`（个人覆盖）→ `.gitignore`（单一真相源在 `.gitignore`）
- **路径锚点**：Hooks 嵌在 `settings.json` 内；Plans 落本仓 `docs/private/plans/`（主 worktree 由 `plansDirectory` 指向，副 worktree 走另一条路汇到同一处，见下节）
- **归属判断**：内容只在本仓 working session 用到 → 放本仓 `.claude/`

## plan 落点：主副 worktree 如何汇到同一个目录

**判据 —— `plansDirectory` 只在「plans 目录的 realpath 落在本 worktree 内」时才生效。** 它校验时会先 `realpath` 解析再比对（2026-08-09 于 Claude Code 2.1.222 二进制内实证），所以任何指向 worktree 之外的 symlink 都会让它失败、静默回退到默认的 `~/.claude/plans`，只在日志里留一条 `plansDirectory must be within project root`。

由此本仓的落点是**两条路、一个目录**：

|             | 走哪条                | 落点                                                                              |
| ----------- | --------------------- | --------------------------------------------------------------------------------- |
| 主 worktree | `plansDirectory` 生效 | `docs/private/plans/`                                                             |
| 副 worktree | 校验失败 → 回退默认   | `~/.claude/plans` → **dev 机把它 symlink 到主 worktree 的 `docs/private/plans/`** |

两条路最终写同一个 inode，因此**不存在同步、冲突或归档延迟**。副 worktree 的 `docs/private` 由 `feat-open` 建成指向主 worktree 的 symlink，读改已有 plan 也是同一个文件。

⚠️ `~/.claude/plans` 那条 symlink 在**仓外**，clone 本仓不会带上它；换机重装必须手工重建，否则副 worktree 的 plan 会散落在 `~/.claude/plans` 真目录里。它同时意味着**其他项目**的 plan 也会落进本仓的 `docs/private/plans/` 根目录 —— 结构上可辨：根目录是 plan mode 自动落的草稿（随机 slug），`YYYY-MM/` 子目录才是归档的成品。

## 全局 `~/.claude/` 的边界

全局 `~/.claude/` 只放跨项目个人偏好（keybindings / 通用 skill / agent）；项目特定规则一律落项目 `.claude/` + `CLAUDE.md`。**例外**：上节那条 `~/.claude/plans` symlink —— 它形式上在全局，实质是本仓的落点重定向。

## 护栏措辞：条件必须对执行方可观测

往 `.claude/`（commands / skills / rules / 项目级 prompt 资料）写护栏时，每个条件落笔前先过一问：**执行它的那一方，从自己的上下文里能观测到这个条件吗？** 观测不到 → 换成无条件规则。

典型**不可观测**条件（被调用方一律看不见，别写进护栏）：

- 调用方身份 —— 人敲的 / 上游 agent 派的 / headless 跑的（收到的都只是一条 user turn）
- 上游是否已就此取得用户授权
- 上游意图 / 是不是「用户显式要求的」

后果不可逆的动作（外部写入 / 删除 / 发送）→ 直接做成**无条件闸**，不留身份或授权例外。

> 实证：`ops/runbook/claude-design.md` § 7 —— `create_project` 旧护栏写的是「用户显式敲命令 = 授权，agent 自主调用才停下问」。2026-08-01 证伪：这个区分从被调用方内部观测不到，于是它按「已授权」处理、自主建了 project。护栏不是被违反，是被写成了**不可实现的条件**。
