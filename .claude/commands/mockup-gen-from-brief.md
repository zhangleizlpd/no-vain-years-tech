---
description: ideation headless mockup 生成 — 吃一段 ideation 需求 brief markdown(非 spec NNN),按 2-段模板 + NVY design token authoring 本地 HTML preview + 拉 DS 权威 _ds css,落 .ideation-mockups/<session>/(不推云端 catalog)。供 App→Mac OpenClaw 通路(子plan3)headless spawn。
argument-hint: <brief-markdown-path> --session <sessionId>
disable-model-invocation: true
allowed-tools: Read, Write, Glob, Grep, Bash, ToolSearch, DesignSync, mcp__claude-design__get_claude_design_prompt, mcp__claude-design__read_design_skill, mcp__claude-design__list_files, mcp__claude-design__read_file
---

把一段 **ideation 需求 brief**（不是走完 specify+clarify 的 spec）变成 mockup HTML preview。
这是 `/mockup-gen` 的 **ideation / headless 变体**（子plan2 愿景 + 子plan3 通路）：输入是 requirement-only brief，
由「App→本地 Mac OpenClaw 通用事件通路」的 nvy channel `spawn claude -p` 调用。

> 🚨 **CRITICAL — 你在 headless(`claude -p`)无人值守运行，没有任何审批/交互通道。**
> 你 **MUST** 立即自主执行全部步骤（载 steering → authoring → 本地落盘 → 拉 DS `_ds` css → 自检 → 打哨兵）到完成。
> **NEVER** 提议计划后停下等批准、**NEVER** 说「approve and I'll execute」「say the word」之类等待人类的话、**NEVER** 试图调 ExitPlanMode（不可用）。
> 唯一允许的提前结束 = 直接打 `NVY_MOCKUP_RESULT:{"error":"<原因>"}` 哨兵（见 Step 3）。停下等审批 = 任务失败。

<!-- -->

> **机制参考**：Claude Design 的工具面 / steering 加载 / 视觉语言纪律见 🔑 [`ops/runbook/claude-design.md`](../../ops/runbook/claude-design.md)。
> ⚠️ 但本路**只用 runbook 的读侧**（§3.1 载 steering、§3.6 读 `_ds`）—— 写侧（§3.2 备料 / §3.4 推送）与浏览器 verify loop（§5）**headless 全部不可用**，理由见下节。
>
> 与 `/mockup-gen` 的关系：`/mockup-gen NNN` 吃**完整 spec**（dev 侧、人 / agent 触发）；本命令吃 **brief markdown**（ideation 侧、headless 触发）。
> 二者共用 NVY token、dsCard、`_ds` css 拉取约定（[design-system-mapping.md](../../docs/conventions/design-system-mapping.md)）；**但本命令 headless 只产本地 preview、不推云端 catalog**（DS 写是人审门 headless 封死；按 1:1「一个灵感=一个 feature」，catalog 在 feature 毕业时交互态落 — 见 [Phase D 设计](../../docs/private/plans/2026-06/06-27-ideation-mockup-phase-d-delivery-seam.md)）。
> **依据**：PoC-1（`06-25-ideation-mockup-master.md` §子plan2 PoC-1 DONE）实证 T1 brief→mockup 在**承重维（屏清单/主布局/token）近零分歧**，requirement-only 足以产可贯穿的 v1 mockup（判定 A：种子贯穿）。

## 🔻 本路产 plain HTML，不是合法 Design Components —— 这是设计决定

`.dc.html` 是**运行时格式**，需要 `<x-dc>` + `support.js`（runbook §4）。而：

1. `support.js` 只能由 `create_support_js` 取得，那是**写方法**，headless 人审门封死。
2. DC 格式的**唯一收益**是「在 claude.ai 编辑器里可点改」。本路只产本地 preview、永不推 catalog —— **这份收益在这里恒为零**。

→ 所以本路**刻意**产 plain HTML。**文件名仍用 `.dc.html`**（`htmlPath` 是 nvy channel `parseMockupOutput` 的消费契约，改扩展名会破约），毕业时由 `/mockup-gen NNN` 重新按合法 DC 格式生成。

🚨 **NEVER 为了"看起来合规"硬塞一个没有 `support.js` 的 `<x-dc>` 壳** —— 那样既拿不到 DC 能力，又让人误以为它是合法 DC（这正是 031–045 踩过的坑，见 runbook §4）。

## 参数

- `$1` = brief markdown 文件路径（nvy channel 已带委托 token 从 `GET /api/v1/ideation/sessions/{id}/brief/export` 拉好写盘）。
- `--session <id>` = ideation sessionId（= 瘦事件 bizId）；用于 dsCard group + 文件名 + 回程关联。

解析失败（无文件 / 无 --session）→ **打 `NVY_MOCKUP_RESULT:{"error":"<原因>"}` 后退出**（让 channel 收到结构化失败，不静默挂起）。

## 前置

1. `Read` brief 文件。brief 段（per `apps/server/src/ideation/brief.schema.ts`，均自由文本 string）：
   - **T1 必填**：`problem` / `user_stories` / `functional_requirements` / `success_criteria` / `non_goals`
   - **T2/T3 可选**：`affected_surface` / `constraints_guardrails` / `data_model_sketch` / `api_contract_sketch` / `edge_cases` / `nfr` / `ui_notes` / `open_questions` / `phase_boundary`
2. brief 缺 T1 承重段（problem / user_stories / functional_requirements 全空）→ 无法产 mockup → 打 `NVY_MOCKUP_RESULT:{"error":"brief missing T1"}` 退出。

## Step 1 · 载 steering（runbook §3.1）

```text
mcp__claude-design__get_claude_design_prompt { design_system_id: <registry designSystem.projectId> }
mcp__claude-design__read_design_skill { skill: "hifi-design" }
```

🚨 **MUST 用 `hifi-design`，NEVER 用 `frontend-design`** —— 后者按官方定义用于「work outside an existing brand or design system」，本仓恒有 bound DS。（2026-08-01 前本命令写的是 `frontend-design`，选错。）

两个方法都是**读**，headless 可用。载入失败 → 不致命，降级为凭既有视觉语言段 authoring，并在哨兵 `note` 里标注「steering 未载入」。

## Step 2 · 从 brief 组装 2-段 prompt

按 `mobile-impl-playbook.md §3` 两段结构，从 **brief**（非 spec）派生：

- **段 1 · Design context 表**：屏/路由（从 user_stories 推断 journey）· 用户与场景 · 关键状态（空/loading/错误/成功 + edge，从 functional_requirements + edge_cases 枚举）· 范围（呼应 `non_goals`，逐条转 NEGATIVE）。
- **段 2 · Prompt block**：业务+状态机（锚 functional_requirements）· POSITIVE 约束（必现元素/交互）· NEGATIVE DO-NOT（**逐条搬 `non_goals`**）· 页面结构 · 状态变体图示（每关键状态一屏）· 视觉语言（NVY token）· **responsive 双模式布局**（桌面宽网格总览 + 移动单列纵滚，per PoC-3 ⑤：app 友好移动单列，每张 mockup 自带）· DELIVERABLES（HTML preview，每状态一屏）。

> brief 是 requirement-only：状态变体 / edge / 数值护栏可能不全（正常，PoC-1 残余分歧落增量维）。**只画 brief 支撑得起的承重结构**，不臆造 spec 才有的 edge 契约。

### 视觉语言铁律（0 新增）

复用 NVY design token，**0 新增颜色 / 0 新 token**（源 `apps/mobile/src/theme/` + DS `nvy/ideation` 既有 mockup 视觉段）。无既有 token 可表达 → headless 不能停下问 → 用最接近的既有 token + 在 handoff note 标记，**不造新色**。A 股红涨绿跌铁律（`--nvy-quote-*`）若涉行情类屏必守。

## Step 3 · author 本地 preview（DS 仅**读**）

> headless 只产**本地 preview**：DesignSync 写方法（`finalize_plan`/`write_files`/`create_project`）与 MCP 写方法（`copy_files`/`create_support_js`）是**人审门**、headless 全部封死；且按 1:1，catalog 在 **feature 毕业**时交互态落（Phase D）。

1. **authoring**：按段 2 prompt + `hifi-design` 纪律 author 符合 NVY token 的 HTML（移动 390×844，每关键状态一屏，含 responsive 双模式）。plain HTML —— 理由见顶部「本路产 plain HTML」节。
2. **本地落盘（`Write`）**：写 `.ideation-mockups/<session>/ideation-<session>-<screen>.dc.html`，**首行 `<!-- @dsCard group="ideation-<session>" -->`**（毕业后由 `/mockup-gen NNN` 重 group 为 `<NNN>`；headless 期作 inert 本地 metadata）。
3. **拉权威 `_ds` css（唯一 DS 交互，读）**：`read_file` 自 **DS project**（读 `.claude/design-projects.json` 的 `designSystem.projectId`，权威 re-based 源）→ `.ideation-mockups/<session>/_ds/NoVainYearsDesignSystem_019dec/colors_and_type.css`。⚠️ **禁**拷 sibling feature 冻结快照。
4. **自检**：`grep` HTML 内全部 `var(--nvy-*)` 在拉回 css 里有定义（0 undefined）—— 命令见 runbook §5。

### ⚠️ 本路无法做渲染验证 —— 必须在哨兵里如实说

runbook §5 的 verify loop 要求**看渲染图**，靠 `render_preview`（需文件已在 project 里，写方法，封死）+ 浏览器（headless 无人值守，不该弹用户标签页）。**两个前提本路都不成立。**

→ 本路验证只到 **token 自检（第 4 步）**。**MUST 在哨兵 `note` 里写明「未做渲染验证」**，让下游知道这份 preview 的置信度。**NEVER 把 token 自检通过说成「已验证」** —— 实证过一次：token 全绿但 8px 圆上的 dashed 边框渲染成星形（runbook §5 末）。

## Step 4 · 回程哨兵（与 nvy channel 的集成契约）

**最后一行必须**打机器可读哨兵（sibling 仓 `agent-platform` 的 `parseMockupOutput` 按此解析 → 回 `POST /agent-queue/{id}/result`）：

```text
NVY_MOCKUP_RESULT:{"htmlPath":"<repo-rel 主 .dc.html 路径>","designProject":"nvy/ideation","screens":["<file>",...],"note":"<0新token 自检结论 / 未做渲染验证 / 降级说明>"}
```

- 成功：`htmlPath` 指主屏（repo 相对），`screens` 列全部产物文件名。
- 失败（任何步骤）：`NVY_MOCKUP_RESULT:{"error":"<原因>"}`，不抛裸异常让 channel 解析不到。
- 哨兵**单独一行、JSON 紧跟冒号无空格**，前面可有任意 chatter（parseMockupOutput 从尾部找该前缀）。

## 收尾

- 回复正文（给人看，可选）：屏数 + 状态帧 + 落盘列表 + 0 新 token 结论 + **「未做渲染验证」声明** + 浏览器打开指引。
- **不** commit（产物在 gitignored `.ideation-mockups/`）。
- OSS 托管 / 公网 URL / App WebView 渲染 / DS catalog（毕业时）= **[Phase D 设计](../../docs/private/plans/2026-06/06-27-ideation-mockup-phase-d-delivery-seam.md)**。

## 反模式（DO-NOT）

> 机制类反模式见 **[runbook §8](../../ops/runbook/claude-design.md)**，此处只列本命令独有的。

- ❌ 把本命令当 `/mockup-gen` 用吃 spec NNN —— 本命令吃 brief markdown 文件。
- ❌ headless 中途停下问用户（spawn 无人值守）—— 歧义走「最接近既有 token + handoff note」或结构化 `error` 哨兵，不挂起。
- ❌ 调任何 DS / MCP **写**方法（`finalize_plan` / `write_files` / `create_project` / `copy_files` / `create_support_js`）—— 人审门封死，catalog 在毕业时交互态落。
- ❌ 硬塞没有 `support.js` 的 `<x-dc>` 壳假装合法 DC。
- ❌ 把 token 自检说成「已验证」（本路做不了渲染验证，如实标注）。
- ❌ 新增 design token / 配色。
- ❌ 臆造 brief 没有的 spec 级 edge 契约 / 数值护栏（只画承重结构，残余留 SDD 增量）。
- ❌ 写 registry `.claude/design-projects.json`（受保护路径 headless 写不进；且非规范——registry 只 track `features` NNN，不 track session）。
- ❌ 漏打 `NVY_MOCKUP_RESULT` 哨兵 —— channel 会拿不到产物引用、回程降级成 note。
