# Design System ↔ mono 映射约定

> Claude Design 资产与 mono 代码的三层映射 SoT。`/mockup-gen` 命令按本约定解析目标 project。
> 本文只定**耐久映射规则 + registry 契约**；操作细节（工具面 / 调用序 / `.dc.html` 格式 / verify loop / 故障恢复）在 [`ops/runbook/claude-design.md`](../../ops/runbook/claude-design.md)。

## 三层 taxonomy

Claude Design 不提供 project 分组 / 命名空间，故三层 taxonomy 由**命名约定 + 轻量 git registry** 自建：

```text
账户 ── 1 DS「no-vain-years Design System」(←/design-sync← apps/mobile/src/theme + ~/ui，单向只读)
            │ 账户级虚拟继承（引用非拷贝）
 context(=module名) ── N project「nvy/<context>」 ← registry 按名解析（非硬编 UUID）
            │
   feature(NNN) ── mockup「<NNN>-<screen>.dc.html」首行 @dsCard group=<NNN>
```

## 4 条规则

1. **context 名 SoT** = [`server-bounded-context-catalog.md`](server-bounded-context-catalog.md) + [`business-naming.md`](business-naming.md)（前端 feature 目录 = module 名）。**禁造平行 context 词表**。多 module → 主 module；`cross-cutting` → 共享 `nvy/_cross-cutting`。
2. **registry 按名解析**：projectId 是**缓存**，运行时必按 `nvy/<context>` 名 `list_projects` 重解析刷新。⚠️ **两个 `list_projects` 过滤口径不同**——`DesignSync` 版只列 writable，`mcp__claude-design__` 版列全部。**一次查不到 ≠ 已删除**，据此 `create_project` 会造重复项；先用后者 + `get_project` 交叉验证再决定。确认缺失才 `create_project` 后回写。

   > 2026-08-01 实证：此处原断言「035 旧 project `824f360e…` 已不存在」是**错的** —— 它一直在，且 `get_project` 报 `canEdit: true`。**所以 writable 过滤并不能解释当初那次观察，真实成因未知。** 「列表里没有」两个方向都不足以下结论，用 `get_project` 定夺。

3. **DS 单向只读**：DS 只 repo→`/design-sync` 同步（代码是真相源），claude.ai 里只读。theme/ui 实质变更 → 重 sync（drift 治理）。每个 feature 折叠的本地 `_ds/` 是**创建时点冻结快照**，会 drift；`_ds/colors_and_type.css` 须自 DS project 取，**不**拷 sibling feature。
4. **可复用**：其他 mono = 自建账户级 DS + 同格式 registry + 同一 `/mockup-gen` 命令（读 registry 零硬编码）。

## registry 文件契约

`.claude/design-projects.json`（git 共享、team-shared）。结构见文件 `_meta`。要点：

- `designSystem.projectId` = 账户级 DS，是 `_ds/` 资产的**权威源**。fresh feature project `list_files("_ds")` 为**空**（DS 是虚拟继承，不是物理文件）——但 claude.ai 预览沙箱按**相对路径**取 `_ds/…`，故资产必须显式落进消费方 project（`copy_files`，server-side）。**继承 ≠ 可用**，两件事别混。详见 [runbook §3.2](../../ops/runbook/claude-design.md)。
- `contexts.<context>` = 缓存的 `projectName` + `projectId` + 已种 feature 列表；projectId 仅缓存，按名重解析为准。

## 适用与边界

- 适用：dev 侧、Claude Code 内 `/mockup-gen` 触发，吃**完整 spec**。
- 不含：App / headless `claude -p` / requirement-only 输入 = ideation↔mockup 子plan2（见 [ideation-mockup master](../private/plans/2026-06/06-25-ideation-mockup-master.md)）。

> 三层映射的设计推导与 DS re-base 决策留痕在 [ideation-mockup master §0](../private/plans/2026-06/06-25-ideation-mockup-master.md)（冻结记录，不回改）；本文是抽出的常驻约定。
