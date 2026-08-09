---
adr_id: ADR-0024
status: Accepted
applies_to: [mono-wide]
sunset_trigger: |
  - spec-kit EOL / 切其他 SDD 工具
  - 多产品线需 layer 命名 (specs/<product>/<feature>/)
  - frontmatter modules 反查在 specs > 500 个时性能瓶颈
---

# ADR-0024: Specs 目录采用 feature-first 扁平布局（`specs/NNN-<slug>/`）+ frontmatter `modules:` 反查

- Status: Accepted (2026-05-19)
- Deciders: project owner
- Tags: repo / sdd / convention

## Context

mono 仓 W1.4 起引入 GitHub Spec-Kit 0.8.7 做 SDD（参 `.specify/integrations/speckit.manifest.json`）。`docs/conventions/sdd.md` 初版规定 spec 单一来源在 `specs/<module>/<usecase>/spec.md`（如 `specs/auth/phone-sms-auth/`），与 NestJS module / `apps/mobile/src/features/<module>/` / Prisma schema "业务模块字符串四处一致"（[`business-naming.md`](../conventions/business-naming.md)）的代码层强约束保持视觉同构。

W2 唯一 use case `phone-sms-auth` 全 ship 后，准备开第二个 use case（Plan 2 起）时识别出两条结构性问题：

### 问题 1：spec-kit 自动化与 module-first 物理路径对抗

`.specify/scripts/bash/create-new-feature.sh` 默认产物：

- 目录 = `specs/$BRANCH_NAME/`，其中 `BRANCH_NAME = NNN-<kebab-slug>`（sequential 编号 max(本地 `specs/*` 前缀 + 本地/远端 branch `^\d{3,}-` 前缀) + 1）
- git branch = 同名 `NNN-<kebab-slug>`
- 三位一体：branch ↔ feature dir ↔ PR

module-first 布局下：

- `/speckit-specify` 永远产 `specs/001-foo/`，手动 `git mv specs/001-foo specs/<module>/foo/` 是每次必跑
- `setup-plan.sh` / `setup-tasks.sh` 通过 `common.sh::get_feature_dir` 解析 `SPECIFY_FEATURE` env / 当前 branch 名定位 feature dir，与重命名后的物理路径会断裂（未实测，但语义上不可兼容）
- vendored `.specify/scripts/bash/*` 的 hash 写在 `speckit.manifest.json`，fork 后升级 spec-kit 会 hash mismatch；user feedback `feedback_speckit_native_extension_over_skill_fork.md` 明示「定制走 templates / hooks / slash commands 三种原生扩展点，不 fork」— 改脚本不在那三类扩展点

### 问题 2：跨模块 feature 在 module-first 下无处安放

W2 phone-sms-auth 还是纯 auth 模块 use case，但 Plan 2 起预期出现：

| 例子                                     | 涉及模块                                |
| ---------------------------------------- | --------------------------------------- |
| 用户在 PKM 笔记里 `@某账号` 触发推送通知 | pkm + account + notification            |
| 账号注销级联清理用户 PKM 内容            | account + pkm                           |
| 投资板块图表订阅企业事件流               | portfolio + notification + integrations |

module-first 强迫此类 spec 选一个"主模块"目录，与 spec 多模块本质冲突；OpenSpec [Issue #662](https://github.com/Fission-AI/OpenSpec/issues/662)（2026-02-04 提，状态 OPEN）相邻 SDD 工具识别到完全相同的张力，提案用 `_global/` 命名空间补救但未合入。

### Fact-check 业内做法（2026-05-19）

- **spec-kit 官方**（[Quick Start](https://github.github.com/spec-kit/quickstart.html) + [spec-driven.md](https://github.com/github/spec-kit/blob/main/spec-driven.md)）：仅文档化扁平 `specs/NNN-<slug>/`，无模块二级目录扩展点
- **spec-kit Issue [#1026](https://github.com/github/spec-kit/issues/1026)**（2025-10-24，state OPEN + `stale` label + 0 maintainer 回复）：monorepo subfolder install 支持悬空 — 官方对 monorepo 场景缺乏关注的弱信号（注意：此 issue 实际诉求是"IDE 从子目录调起 `/speckit.*`"，非 spec 组织，但反映 maintainer attention deficit）
- **OpenSpec [#662](https://github.com/Fission-AI/OpenSpec/issues/662)**：相邻 SDD 工具的 hierarchical 提案 + `_global/` 跨模块约定 — 业内识别张力但**未合入**，证明无标准化方案
- **Nx 官方** [Folder Structure 文档](https://nx.dev/docs/concepts/decisions/folder-structure)：仅规范 `apps/` `libs/` 代码分层，**完全不规范 specs 位置** — monorepo 工具链层不强制 spec 同构于代码
- **结论**：**B (feature-first) 是 spec-kit 唯一官方支持的布局；A (module-first) 在 spec-kit 生态内无公开践行案例**

## Decision

mono 仓 specs 目录采用 **feature-first 扁平布局**，与 spec-kit 默认对齐：

```text
specs/
  001-phone-sms-auth/
    spec.md
    plan.md
    tasks.md
    analysis.md
    v1-loc-report.md      # use case 内部附件随意命名,与 SDD 6 步产物同目录
    v2-boundary-report.md
  002-<next-feature>/
    spec.md
    ...
```

### 命名规则

| 字段          | 规则                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 编号          | `NNN`（3 位 zero-padded sequential，由 spec-kit `create-new-feature.sh` 自动取 max(本地 + 本地/远端 branch) + 1；首个 = `001`）                           |
| slug          | kebab-case feature 描述 2-4 词（spec-kit 自动 stop-word 过滤 + 长度过滤；可 `--short-name` 覆盖）                                                         |
| git branch 名 | 与 feature dir 同名 `NNN-<slug>`（spec-kit 内置三位一体；不再走 `<type>/<slug>` Conventional Branch 命名 — see § Consequences "对 git-workflow.md 影响"） |
| 时间戳模式    | `--timestamp` flag 切到 `YYYYMMDD-HHMMSS-<slug>`；mono 默认不用，保留作 hotfix 场景 escape hatch                                                          |

### spec.md frontmatter（强制）

每个 `spec.md` 顶部 YAML frontmatter 必填三字段，作为模块倒查 + ownership + lifecycle 单一来源：

```yaml
---
modules:
  [auth] # 影响的代码模块,值域 = business-naming.md 列出的业务模块名
  # 单模块: [auth]   多模块: [pkm, account, notification]
  # 完全跨模块平台改造: [cross-cutting]
owners: ['@zhangleizlpd'] # GitHub handle,与 CODEOWNERS 兼容
status: implemented # draft | planned | implementing | implemented | superseded | archived
---
# Feature Specification: <Feature Name>
...
```

### 模块倒查命令

不靠目录结构，靠 ripgrep + frontmatter：

```bash
# 直接 grep
rg -l '^modules:.*\bauth\b' specs/

# 包装成 Nx target (Plan 2 起按需加,不阻塞本 ADR)
pnpm nx run repo:spec-by-module auth
```

### `specs/<module>/<usecase>/` 旧布局处理

- mono 当前唯一已存在的 `specs/auth/phone-sms-auth/` 在本 ADR 同 PR 内 `git mv` → `specs/001-phone-sms-auth/`，history 保留
- 旧目录 `specs/auth/` 同 PR 删除
- Changelog 追加 2026-05-19 entry 记录本次重命名

## Consequences

### Positive

- **与 spec-kit 自动化无摩擦** — `/speckit-specify` → `/speckit-plan` → `/speckit-tasks` → `/speckit-implement` 全链路 0 手动 `mv`，0 vendored 脚本 fork，spec-kit 升级风险 = 0
- **跨模块 feature 自然表达** — `modules: [pkm, account, notification]` 比 module-first 强迫选"主模块目录"诚实得多
- **倒查仍然廉价** — 一行 `rg` 解决，无需维护双层目录索引
- **与代码层"四处一致"约束解耦** — spec 是设计产物，代码层 ESLint boundaries + Prisma schema 由 CI 拦截（[ADR-0020](0020-module-boundary-nestjs.md)），不依赖 spec 目录同构作冗余防御
- **三位一体（branch / dir / PR）保留** — Plan 1 期间已实证（PR #7 / #8 / #9 / #13 / #14 / #15 等 7+ feature branch 全部走 `feature/phone-sms-auth-<usX>` 命名风格）；本 ADR 后切到 spec-kit 默认 `NNN-<slug>` 进一步对齐

### Negative / Trade-offs

- **`docs/conventions/git-workflow.md` 分支命名规则需 amend** — 现规则 `<type>/<kebab-desc>`（`feature` / `fix` / `chore` / ...）；spec-kit 自动 branch 走 `NNN-<slug>` 与之冲突。**调和**：feature spec 走 `NNN-<slug>`（spec-kit 三位一体），非 spec 改动（hotfix / chore / docs / refactor / repo-level）仍走 `<type>/<kebab-desc>`。本 ADR 同 PR 落地 `git-workflow.md` 对应段。
- **历史 PR/分支命名风格不一致** — Plan 1 期间已合的 `feature/phone-sms-auth-<usX>` 系列 PR 与新规则不同，不追溯，仅 forward 适用
- **frontmatter 是 free-form YAML，无 schema 强制** — 短期接受；Plan 2 若发现 typo / drift，再加 markdownlint 自定义规则或 spec-kit hook 校验
- **`modules:` 值域与代码模块字符串需手工保持一致** — 与 NestJS module / Prisma schema 同步靠 PR review；若 drift 严重，未来可加 CI 校验脚本（low priority，spec 数量在 < 50 区间不必上工具链）
- **跨模块 feature 的 owner 单一性问题** — 单 owner 项目当前不暴露；多 owner 后需补 `owners:` 多值 + CODEOWNERS path glob 映射（Plan 2+ 决策，超本 ADR scope）

### 中性

- **历史 spec 完成 use case 也走 `NNN-` 重命名** — 仅 phone-sms-auth 一例，sunk cost 极低；未来已 implemented 的 spec 不再倒查 dir name，所以重命名后即便有 stale 链接（如果有）只影响 documentation aesthetics，不影响 spec-kit 运行

## Alternatives Considered

### A — Module-first 二级目录 `specs/<module>/<usecase>/`（旧 sdd.md 规约）

- **拒绝原因**：
  - 与 spec-kit `create-new-feature.sh` 默认产物冲突 → 每次手 mv + branch rename
  - `setup-plan.sh` / `setup-tasks.sh` 通过 branch 名定位 feature dir，重命名后行为未验证 → 沉默 bug 风险
  - 跨模块 feature 无处安放（Plan 2 必然撞）
  - 业内无 spec-kit 生态公开实证
  - fork 脚本与 `feedback_speckit_native_extension_over_skill_fork.md` 冲突

### B — Feature-first 但走 timestamp 前缀 `specs/YYYYMMDD-HHMMSS-<slug>/`

- **拒绝原因**：
  - 时间戳前缀不便对话引用（"001 feature" 比 "20260519-110000 feature" 短得多）
  - `NNN-` sequential 是 spec-kit 默认 + Linux kernel KEP / Rust RFC / Python PEP 等业内成熟做法的惯例延续
  - timestamp 模式保留作 hotfix / 临时实验 escape hatch（`--timestamp` flag），不作主路径

### C — Hybrid:扁平 + 按状态二级（`specs/active/NNN-<slug>/` + `specs/archived/NNN-<slug>/`）

- **拒绝原因**：
  - 状态信息已在 frontmatter `status:` 字段，目录二级冗余
  - spec-kit 不识别 active/archived 概念，搬移时手工成本高
  - Plan 2 起 spec 数预估 < 30，flat 目录不需要状态归档；> 100 后再议

### D — OpenSpec-style 完全 hierarchical（`specs/<bounded-context>/<feature>/spec.md` + `specs/_global/` 跨模块）

- **拒绝原因**：
  - 是 OpenSpec 而非 spec-kit 的方案；mono 已 commit spec-kit（0.8.7 manifest 锁定）
  - `_global/` 仍是"目录硬编码 cross-cutting"的次优解，frontmatter `modules: [cross-cutting]` 表达力等价且更通用
  - 在 spec-kit 生态外没法依赖该方案

## Validation

- `git mv` 后 `git log --follow specs/001-phone-sms-auth/spec.md` 仍能追溯到 W1.4 起源 commit（preserve history）
- `pnpm nx graph` / `pnpm nx run server:lint` / `pnpm nx run server:test` 不依赖 specs 路径，0 回归
- 模块倒查烟测：`rg -l '^modules:.*\bauth\b' specs/` 命中 `specs/001-phone-sms-auth/spec.md`
- 跨文档 ref 全量更新（sdd.md / ADR-0023 / ADR-0018 / experience/2026-05/05-18-v10-claude-agent-loop.md / specs/001-phone-sms-auth/{tasks,plan,spec}.md），PR diff 内 review

## References

- [GitHub Spec-Kit Quick Start](https://github.github.com/spec-kit/quickstart.html)
- [spec-kit/spec-driven.md](https://github.com/github/spec-kit/blob/main/spec-driven.md)
- [spec-kit Issue #1026 — monorepo subfolder support](https://github.com/github/spec-kit/issues/1026)
- [OpenSpec Issue #662 — hierarchical spec structure proposal](https://github.com/Fission-AI/OpenSpec/issues/662)
- [Nx Folder Structure docs](https://nx.dev/docs/concepts/decisions/folder-structure)
- [`docs/conventions/sdd.md`](../conventions/sdd.md)（本 ADR 同 PR 内 amend）
- [`docs/conventions/git-workflow.md`](../conventions/git-workflow.md)（本 ADR 同 PR 内 amend 分支命名段）
- [`docs/conventions/business-naming.md`](../conventions/business-naming.md)（modules 值域来源）
- [`.specify/integrations/speckit.manifest.json`](../../.specify/integrations/speckit.manifest.json) — spec-kit 0.8.7 vendored hash
- [`.specify/scripts/bash/create-new-feature.sh`](../../.specify/scripts/bash/create-new-feature.sh) — 自动编号 + branch 创建脚本
- [AI Friction Catalog · F-006 Indirect-Spec-Module-Mapping](../conventions/ai-friction-catalog.md#f-006--indirect-spec-module-mapping) — frontmatter `modules:` SSOT 是缓解此 friction 的核心机制
