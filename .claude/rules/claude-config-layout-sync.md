---
paths:
  - '.claude/**'
---

# Claude 配置布局纪律（path-triggered，触及 `.claude/**` 自动加载）

## 硬性 invariant

### 1. `.claude/` 默认 git 团队共享，唯一例外 `settings.local.json`

新增 / 改 `.claude/` 下任何文件（`settings.json` / `commands/` / `skills/` / `rules/` / 项目级 prompt 资料）**默认进 git 团队共享** —— clone 本仓即完整生效。唯一不进 git 的是个人覆盖 `settings.local.json`（单一真相源在 `.gitignore`）。

→ 个人 / 机密配置放 `settings.local.json`，不要塞进团队共享文件。

### 2. 归属：项目特定落本仓 `.claude/`，跨项目个人偏好落全局 `~/.claude/`

内容只在本仓 working session 用到 → 本仓 `.claude/` + `CLAUDE.md`；跨项目个人偏好（keybindings / 通用 skill / agent）→ 全局 `~/.claude/`。放错层 = 规则要么泄漏到无关项目，要么 clone 本仓时丢失。

### 3. 护栏条件必须对执行方可观测

往 `.claude/` 写护栏（commands / skills / rules）时，每个条件先过一问：**执行它的那一方，从自己上下文里能观测到吗？** 观测不到 → 改成无条件规则。

不可观测的典型：调用方身份（人 / 上游 agent / headless —— 收到的都只是一条 user turn）、上游是否已获授权、上游意图。后果不可逆的动作（外部写入 / 删除 / 发送）→ 直接写成无条件闸，不留身份或授权例外。

→ 依赖不可观测状态的护栏 = 没有护栏。实证见 `ops/runbook/claude-design.md` § 7（`create_project`）。

## 单源真理

完整配置项分布（路径锚点 Hooks 嵌 `settings.json` / Plans 落 `docs/private/plans/` / 全局 `~/.claude/` 边界细节）见 [`docs/conventions/claude-config-layout.md`](../../docs/conventions/claude-config-layout.md)。本 rule 仅 surface 路径触发的硬 invariant，不重复 canonical 分布表。
