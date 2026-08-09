# Claude Code 配置布局

仓库**独立**维护 `.claude/` 目录。clone 本仓时配置完整生效。

## 配置项分布

- `.claude/` 下**所有内容默认进 git 团队共享**（`settings.json` / `commands/` / `skills/` / `rules/` / 项目级 prompt 资料等）
- **唯一例外**：`settings.local.json`（个人覆盖）→ `.gitignore`（单一真相源在 `.gitignore`）
- **路径锚点**：Hooks 嵌在 `settings.json` 内；Plans 落本仓 `docs/private/plans/`（由 `plansDirectory` 配置项指向）
- **归属判断**：内容只在本仓 working session 用到 → 放本仓 `.claude/`

## 全局 `~/.claude/` 的边界

全局 `~/.claude/` 只放跨项目个人偏好（keybindings / 通用 skill / agent）；项目特定规则一律落项目 `.claude/` + `CLAUDE.md`。

## 护栏措辞：条件必须对执行方可观测

往 `.claude/`（commands / skills / rules / 项目级 prompt 资料）写护栏时，每个条件落笔前先过一问：**执行它的那一方，从自己的上下文里能观测到这个条件吗？** 观测不到 → 换成无条件规则。

典型**不可观测**条件（被调用方一律看不见，别写进护栏）：

- 调用方身份 —— 人敲的 / 上游 agent 派的 / headless 跑的（收到的都只是一条 user turn）
- 上游是否已就此取得用户授权
- 上游意图 / 是不是「用户显式要求的」

后果不可逆的动作（外部写入 / 删除 / 发送）→ 直接做成**无条件闸**，不留身份或授权例外。

> 实证：`ops/runbook/claude-design.md` § 7 —— `create_project` 旧护栏写的是「用户显式敲命令 = 授权，agent 自主调用才停下问」。2026-08-01 证伪：这个区分从被调用方内部观测不到，于是它按「已授权」处理、自主建了 project。护栏不是被违反，是被写成了**不可实现的条件**。
