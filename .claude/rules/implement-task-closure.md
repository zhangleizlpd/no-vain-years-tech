---
paths:
  - 'specs/*/tasks.md'
  - 'apps/server/src/**/*.usecase.ts'
  - 'apps/server/src/**/*.controller.ts'
  - 'apps/mobile/src/**/*.tsx'
  - 'apps/mobile/src/**/*.ts'
---

# /implement 每 task 闭环 6 步（path-triggered，改 tasks.md / impl 文件时自动加载）

`/speckit-implement` 执行每个 task 时，**最后一步必须改 tasks.md**，与业务代码 + 测试同 commit：

1. 红：写测试 → typecheck pass + 测试 RED
   —— 先按 [`test-taxonomy-trigger`](test-taxonomy-trigger.md) 定 **size**（默认跑要不要容器 / 浏览器 / 本机 server）选后缀，照 [golden sample 注册表](../../docs/conventions/golden-sample-registry.md) §测试样板抄结构。**后缀选错 PR 门 `check-test-size` 直接红。**
2. 绿：写实现 → 测试 GREEN
3. typecheck + lint pass
4. **改 tasks.md**：把 task 行的 `- [ ] T<N> ...` 翻成 `- [X] T<N> ...`（spec-kit 原生 checkbox 体例）。**状态语义**：`- [ ]` = pending，`- [X]` = done
5. `git add` impl + 测试 + tasks.md 同 stage
6. 进 commit 流程

**Per-task 节奏**：每 task 走完 6 步**直接 commit**，无需用户审批；phase 之间 `Review gate`（clarify → plan / plan → tasks / analyze → implement）是 phase-level 人工卡点，不在 implement 内 per-task 触发。

> 🆕 **新文件首跑带 `--skip-nx-cache`**：本 task 新建的 `.ts` / `.spec.ts` / config 第一次跑 `nx test|build|lint` 必加 `--skip-nx-cache`（步 1 / 3），否则 nx cache 可能假绿（新文件 / `import.meta` 被 cache hit 漏报，#7 实证）。

## 强制层（双层兜底）

- prompt-time 软提醒：`task-closure` preset 通过 `after_implement` hook 触发 `/speckit-tasks-verify` slash command，扫近 2h commit 报告 `[X]` 状态与 impl 是否 drift（per `michael-speckit-presets` —— 本地已装的 spec-kit preset 库；上游仓已不可达，权威副本是本机 install 出来的模板）。**注**：preset 的 `tasks-template` 注入的「4 步」是上文 6 步的精简版（本 6 步把 typecheck/lint 显式拆出）——**同一协议、不同表述**，勿因步数差困惑。
- commit-time 硬拦：mono 仓 lefthook `tasks-md-drift` 拒「commit 含 impl 代码但 tasks.md 未 staged」；`--no-verify` 仅限格式化 / typo / 紧急 hotfix 出口

**常见反模式**：写完 impl 喊 /commit、事后再开 PR 改 tasks.md → 应 impl PR 内**同 commit** stage tasks.md `[X]`。

**`✅` 标记兼容**：早期部分 tasks.md 用 `✅` emoji 标完成；新 use case 一律走 `[X]`。lefthook `tasks-md-drift` 两种 marker 都识别。

## Clear 检查点批次（context 防膨胀）

每 task 仍各自走上文 6 步闭环 + **atomic commit**（Constitution §III 不变）。在此之上叠一层**跨 task 的 /clear 节奏**：

- 每 **2-3 个强关联 task**（同 use case / 同文件簇 / 前 task 产出是后 task 直接输入）为一个「clear 检查点批次」，**硬上限 5**。
- 批次内 task 全绿 + 各自 commit 后 → **硬停**，一句话提醒 user「建议 /clear 再继续」，等确认。**不闷头往下冲**。
- 安全：SDD 状态层 `git log > tasks.md` 是 durable 真相，/clear 后下个 session 靠 `tasks.md [X]` + `git log -5` 重建（4 步 bootstrap 协议）—— 中途切 clear **不丢进度**。本批次与全局 `claude-quota-discipline`「use case 粒度 /clear」对齐（更细，一个 UC 可含 1-2 批次）。

> 🚨 **CRITICAL — clear 批次 ≠ commit 批次。** **NEVER** 把 2-3 个 task 合并成**一个** commit（直接违反 §III「每 task 各自 atomic commit」）。批次只是一个 **/clear 停顿点**，不改变 per-task 逐个 commit 的铁律。

## Stop signals（impl 期停下问 user，别自作主张往下冲）

per-task 默认直接 commit（上文），但撞到下列任一**停下**、不闷头继续：

1. **spec 歧义**：实现中发现 spec 有多种合理解释 / 关键行为未定 → 停，回 `/speckit-clarify` 或问 user，**不默认挑一个**。
2. **新依赖**：需引入未锁定的 runtime 依赖（npm 包 / 二进制资产）→ 停 + flag（与已锁定项去重，列选型理由）；尤其二进制入仓 / 跨仓改动。
3. **不可逆 / 高风险 op**：DB 不可逆变更 / 删大量代码 / secrets / 生产资源命名 → 停，PR 描述 flag「建议人工合并」，不接 auto-merge。
4. **改动溢出本 feature**：发现改动超出本 feature task 范围（牵动他 feature / 平台层大改）→ 停，确认是否拆**独立改动**，别把无关改动夹进本 PR。

详版工程机制见 [`docs/conventions/server-impl-playbook.md`](../../docs/conventions/server-impl-playbook.md) / [`mobile-impl-playbook.md`](../../docs/conventions/mobile-impl-playbook.md)。
