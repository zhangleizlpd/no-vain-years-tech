---
paths:
  - '.specify/presets/**'
  - '.specify/templates/**'
  - '.specify/schemas/**'
  - '.specify/extensions.yml'
---

# Preset / 模板修改纪律（path-triggered，触及 `.specify/presets/` 或 `.specify/templates/` 自动加载）

## 硬性规则

**不准在 mono 内直接改任何 spec-kit 模板 / preset 制品** —— 两处都不行：

- `.specify/presets/<id>/`（preset vendored 快照：`preset.yml` / `templates/*` / `schemas/*` / `lefthook.yml.fragment` ...）—— install.sh 从 preset 库 (`~/Documents/projects/michael-speckit-presets`) 复制来的。
- `.specify/templates/`（spec-kit **P4 core / vanilla** 裸模板）—— spec-kit upgrade 会覆盖，且改它**不跨项目复用**。

任何「想让 `/speckit-specify·plan·tasks` 产出变化」的需求，**一律回 preset 库改 + install 回来**（下方流程），多项目共享同一份定制。

**必须走的流程**：

1. `cd ~/Documents/projects/michael-speckit-presets`
2. 在 `presets/<id>/` 下改对应文件 + bump version in `preset.yml`
3. 开 PR + auto-merge（参考 [git-workflow](../../docs/conventions/git-workflow.md) AI agent 默认接 auto-merge）
4. 回 mono 跑 `~/Documents/projects/michael-speckit-presets/scripts/install.sh --repo . --preset <id>` re-install
5. mono 这边 commit 是"install `<id>` X.Y.Z"性质的同步 commit，**不**包含 ad-hoc 内容编辑

## 机制速记（为什么 mono 内改哪层都不对）

运行期 4 层 resolver 选模板，命中即停：P1 `templates/overrides/` > P2 `presets/<id>/templates/` > P3 `extensions/<id>/templates/` > P4 `templates/`(core)。**`strategy: replace` 是这个优先级语义、不物理替换文件** —— P4 core 永远是 vanilla。

**命令接 resolver 不对称（2026-05-26 实证）**：

- `/speckit-plan`·`/speckit-tasks`：SKILL 跑 `setup-{plan,tasks}.sh` → `resolve_template` → 命中 **P2 preset**。改 P4 对它们无效。
- `/speckit-specify`：SKILL **硬编码 `cp .specify/templates/spec-template.md`、不经 resolver** → 永远拿 **P4 vanilla**（无 frontmatter / 无 us-meta）。改 P2 对它无效；要改 specify 产出得覆盖命令本身（参上游 `scaffold` preset / `git` extension）。

→ 模板定制唯一正确落点 = preset 库，install 回 mono。P2 vendored 与 P4 core 都不要碰。

## 为什么

- vendored 副本是 install 复制来的。在 mono 直接改 → preset 库 git 史不知道
- 下次 install（升级 / 重装 / CI 重建）会按 preset 库 main 内容**静默覆盖**，把直接改的内容擦掉
- mono CI / typecheck / lint 全绿不暴露（mono 自己用的就是 vendored 副本），只在 "去 preset 库找代码" 时才暴露 drift
- 实证：mono PR #80 (PR-T1) / #82 (PR-T3) / #84 (P5) 连撞 3 次此模式，要 PR #14 in `michael-speckit-presets` 把 5 文件 +109/-5 行回流补救

## 例外

- `.specify/presets/.registry` / `.specify/presets/.install.log` / `.specify/presets/.cache/` — install.sh 维护的状态文件，由 install 自己管，**不属于** vendored content。`install.sh` 跑时自动更新
- mono 自己的 `scripts/ci/server-boot-smoke.ts` 等不在 `.specify/presets/<id>/` 下的脚本可以直接改

## 修改前必读

- preset 机制权威说明（spec-kit 4 层 resolver + `strategy: replace` 真正语义）：`michael-speckit-presets/PRESET-MECHANISM.md`（上游仓已不可达；查本机已 install 的 preset 目录）
- 不理解 4 层 resolver 之前不要碰 `strategy:` / 不要乱 install
