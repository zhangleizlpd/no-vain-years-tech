---
description: 把一个走完 specify+clarify 的 feature spec 变成 mockup preview baseline —— 按 2-段模板 + NVY design token authoring 合法 Design Components(.dc.html)，推 claude.ai/design 并跑渲染验证，落 specs/NNN/design/。SDD mockup-first 流程里 clarify→plan 之间的 Mockup 步；只对 UI feature 适用，纯 server use case 无需 mockup。
argument-hint: <NNN | NNN-slug>（feature 编号或目录名）
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, ToolSearch, DesignSync, mcp__claude-design__get_claude_design_prompt, mcp__claude-design__read_design_skill, mcp__claude-design__list_projects, mcp__claude-design__create_project, mcp__claude-design__list_files, mcp__claude-design__read_file, mcp__claude-design__copy_files, mcp__claude-design__create_support_js, mcp__claude-design__render_preview, mcp__claude-in-chrome__tabs_context_mcp, mcp__claude-in-chrome__navigate, mcp__claude-in-chrome__computer, mcp__claude-in-chrome__read_console_messages
---

参数 `$ARGUMENTS` = feature 编号（`028`）或目录名（`028-chat-history-drawer`）。

> **本命令只负责「spec → 2 段 prompt → authoring」这一段。**
> Claude Design 的全部操作机制（工具面 / 调用序 / `.dc.html` 格式规格 / verify loop / 故障恢复 / 安全边界）在
> 🔑 **[`ops/runbook/claude-design.md`](../../ops/runbook/claude-design.md)** —— **开工前必读，本文不复述。**
>
> 其余权威：2-段模板 = `docs/conventions/mobile-impl-playbook.md §3`；流程位置 = `docs/conventions/sdd.md` § 前端 UI 工作流（Constitution v1.4.0 强制）；三层映射 + registry 契约 = [`design-system-mapping.md`](../../docs/conventions/design-system-mapping.md)。
> 范围：吃**完整 spec**。requirement-only brief / headless 触发 → [`/mockup-gen-from-brief`](./mockup-gen-from-brief.md)。
> **代码是真相源，mockup drift 不算 bug。**

## 触达外部的授权

本命令会在用户 claude.ai/design 账户下 create/update design project。

🚨 **`create_project`（新建）是无条件闸 —— 任何情况下都先取得用户确认，不区分是人敲的还是 agent 派的。**
复用 registry **已注册**的 `nvy/<context>` project 可直接进行，但**必须在回复里说明写了哪个 project**。详见 [runbook §7](../../ops/runbook/claude-design.md)。

> 旧版写的是「用户显式敲 = 授权，agent 自主调用才停下问」。2026-08-01 实测证伪：**这个区分从被调用方内部观测不到**（收到的都是一条 user turn），结果 agent 按"已授权"自主建了 project。不可观测的条件写进护栏 = 没有护栏。

## 前置

1. 解析 `$ARGUMENTS` → Glob 定位 `specs/$ARGUMENTS*/` 唯一目录；多于一个或零个 → 停下报候选，**不猜**。
2. 读该目录 `spec.md`（必读 `## Functional Requirements` / `## Success Criteria` / `## User Scenarios` / Out-of-Scope / `## Clarifications`）。
   **非 UI feature**（纯 server use case，无屏）→ 停下说明「无需 mockup」并退出。
3. `design/` 已有 `.dc.html` → 这是**重生成**：读旧 `claude-design-prompt.md` 作 diff 基线，覆盖前先在回复里列将变更点。

## Step 1 · 组装 2-段 prompt

按 `mobile-impl-playbook.md §3` 两段结构从 spec 派生，写 `specs/<dir>/design/claude-design-prompt.md`：

- **段 1 · Design context 表**：屏/路由（Expo route）· 用户与场景（journey 节点）· 关键状态（空/loading/错误/成功 + 各 edge 变体，**从 spec FR/SC + Clarifications + state_branches 枚举**）· 数据来源（消费哪个已 ship server 端点）· 范围（一句话圈定，呼应 Out-of-Scope）。
- **段 2 · Prompt block**：业务+状态机（锚 spec FR/SC 编号）· POSITIVE 约束（必现元素/交互/状态指示）· NEGATIVE 约束 DO-NOT（**逐条搬 spec Out-of-Scope**）· 页面结构（区块布局非像素）· 状态变体图示（每个关键状态画一屏）· 视觉语言 · DELIVERABLES。

### 视觉语言铁律（0 新增）

- **必须复用 NVY design token，0 新增颜色 / 0 新 token**。token 源：`apps/mobile/src/theme/` + 最近一个 feature 的 `design/claude-design-prompt.md` 视觉语言段直接继承。
- 已稳定调色板（勿改）：brand `#2456E5` / brand-soft `#E8EEFD` · ink `#1A1A1A`/`#666666`/`#999999` · line `#E5E7EB` · surface 白 / surface-sunken / surface-alt · danger `#EF4444` + danger-soft · warning-soft · 系统无衬线 + mono（计时/数字）· 圆角统一、阴影克制、无花哨渐变。
- A 股**红涨绿跌**（`--nvy-quote-*`）若涉行情类屏必守，且**永不复用** success/danger 表达涨跌。
- 若 spec 引入确实无既有 token 可表达的视觉 → **停下问用户**，不擅自造色。

## Step 2 · 生成 + 推送 + 验证

**全部按 runbook 执行**，逐节对应：

| 动作                                                               | runbook 节                                                                         |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| **先**解析 project（含新建的无条件闸）                             | §3.0 + [design-system-mapping.md](../../docs/conventions/design-system-mapping.md) |
| 载 steering（`get_claude_design_prompt` + `hifi-design`）          | §3.1                                                                               |
| 备料（`create_support_js` + `copy_files` 拷 DS 资产）              | §3.2                                                                               |
| authoring 合法 `.dc.html`（`<x-dc>` / `sc-for` / `sc-if` / 铁律）  | §4                                                                                 |
| 推送（`DesignSync` + `localPath`）**+ 推送后版本闸**               | §3.4（`list_files` 尺寸对本地 + etag 须前进，不一致即重推）                        |
| **渲染 verify loop（不许跳）** —— agent 场景走仓内 Playwright 无头 | §5（浏览器选择 §5.1 · 六项探测 §5.2 + §5.2a）                                      |
| 拉回本地 `_ds` css                                                 | §3.6                                                                               |

本命令独有的约束：

- 移动端 **390×844** 视口，**每关键状态一屏**。
- 文件名 `<NNN>-<screen>.dc.html`，首行 `<!-- @dsCard group="<NNN>" -->`。
- 状态帧多且结构相异时，**按性质拆文件**（如雷达四态一份、表单/抽屉一份），别硬凑单文件也别一帧一文件。

## Step 3 · 留痕 handoff.md

写 `specs/<dir>/design/handoff.md`：来源（Claude Design, projectId, 日期）· 真相源文件表（哪份是合法 DC、哪份是 plain HTML 及**为什么**）· 状态帧清单（锚 spec 编号）· 已锁视觉/尺寸（复用哪套 token，声明 0 新增）· ⚠️ mockup↔实现现实（哪些是占位、plan 期定 HOW）· 显式未画（呼应 spec NEGATIVE）。

## 收尾

- 回复给出：生成屏数 + 状态帧清单 + 落盘文件列表 + 「0 新 token」自检结论 + **渲染验证结论（六项探测各自计数）** + **版本闸结论（每个文件本地 vs project 尺寸 + etag 是否前进）** + `open_url`。
- 🚨 **版本闸不过就不许说「已更新」** —— user 唯一会看的是面板那一份，本地改好了不算数（runbook §3.4）。
- **不**自动 commit（留给用户 / `/commit`）。
- markdownlint 友好（`claude-design-prompt.md` / `handoff.md` 是 docs）。**仓里确实装了** —— `lefthook.yml` 的 pre-commit 挂 `markdownlint-cli2`，规则在 `.markdownlint-cli2.jsonc`。常踩的是 MD040（代码块必须标语言）。
- 成本提醒：单 feature 全量状态帧实测 **~300K token / ~50 分钟**（2026-08-01，12 帧）。被 agent 派单调用前先掂量。

## 反模式（DO-NOT）

> 机制类反模式（格式冒充 / 跳 steering / 只 grep 不看图 / 盲目重发 / `serve_url` 外泄 …）见 **runbook §8**，此处只列本命令独有的。

- ❌ 用 requirement-only brief 跑本命令 —— 那是 [`/mockup-gen-from-brief`](./mockup-gen-from-brief.md)。
- ❌ 新增任何 design token / 配色（视觉资产已冻结）。
- ❌ 输出 `.tsx` / RN 代码（产物是 preview baseline，RN 落 impl 期）。
- ❌ 把 spec Out-of-Scope 的元素画进 mockup（NEGATIVE 约束逐条搬）。
- ❌ 对非 UI feature 硬产 mockup。
