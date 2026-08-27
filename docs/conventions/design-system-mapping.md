# Design System ↔ mono 映射约定

> Claude Design 资产与 mono 代码的三层映射 SoT。`/mockup-gen` 命令按本约定解析目标 project。
> 本文只定**耐久映射规则 + registry 契约**；操作细节（工具面 / 调用序 / `.dc.html` 格式 / verify loop / 故障恢复）在 [`ops/runbook/claude-design.md`](../../ops/runbook/claude-design.md)。

## 三层 taxonomy

Claude Design 不提供 project 分组 / 命名空间，故三层 taxonomy 由**命名约定 + 轻量 git registry** 自建：

```text
账户 ── 1 DS「no-vain-years Design System」(← DesignSync 工具 ← apps/mobile/src/theme + ~/ui，单向只读)
            │ 账户级虚拟继承（引用非拷贝）
 context(=module名) ── N project「nvy/<context>」 ← registry 按名解析（非硬编 UUID）
            │
   feature(NNN) ── mockup「<NNN>-<screen>.dc.html」首行 @dsCard group=<NNN>
```

## 4 条规则

1. **context 名 SoT** = [`business-naming.md`](business-naming.md)（前端 feature 目录 = module 名；业务 ctx 清单靠 `ls apps/server/src/` + eslint `boundaries/elements` 派生，不另造词表）。**禁造平行 context 词表**。多 module → 主 module；`cross-cutting` → 共享 `nvy/_cross-cutting`。
2. **registry 按名解析**：projectId 是**缓存**，运行时必按 `nvy/<context>` 名重解析刷新；**列表里查不到 ≠ 已删除**（两个 `list_projects` 口径不同），裁决用 `get_project`，确认缺失才 `create_project` 后回写 —— 细节与历史教训见 [runbook §1](../../ops/runbook/claude-design.md)。
3. **DS 单向只读**：DS 只由 repo 经 `DesignSync` 工具推送（代码是真相源），claude.ai 里只读；theme / ui 实质变更 → 人工在 Claude Code 用 `DesignSync` 重推（无仓内 slash command，步骤 runbook §1）。每个 feature 折叠的本地 `_ds/` 是**创建时点冻结快照**，会 drift；`_ds/` 资产须自 DS project 取，**不**拷 sibling feature。

## registry 文件契约

`.claude/design-projects.json`（git 共享、team-shared）。结构见文件 `_meta`。要点：

- `designSystem.projectId` = 账户级 DS = `_ds/` 资产权威源。DS 是**虚拟继承**（fresh project `list_files("_ds")` 为空），预览沙箱按相对路径取 `_ds/…` ⇒ 资产（css **和 `_ds_bundle.js`**）必须显式 `copy_files` 落进消费方 project —— **继承 ≠ 可用**；备料步骤见 [runbook §3.2](../../ops/runbook/claude-design.md)。
- `contexts.<context>` = 缓存的 `projectName` + `projectId` + 已种 feature 列表；projectId 仅缓存，按名重解析为准。

## 适用与边界

- 适用：dev 侧 `/mockup-gen`（吃**完整 spec**；含 project 解析 + registry 回写）。
- headless brief 路（`/mockup-gen-from-brief`，ideation 侧）只消费 token / dsCard / `_ds` 拉取三条，不做 project 解析、不推云端 catalog（见 [ideation-mockup master](../private/plans/2026-06/06-25-ideation-mockup-master.md)，本机私有未公开）。

> 三层映射的设计推导与 DS re-base 决策留痕在 [ideation-mockup master §0](../private/plans/2026-06/06-25-ideation-mockup-master.md)（本机私有未公开；冻结记录，不回改）；本文是抽出的常驻约定。
