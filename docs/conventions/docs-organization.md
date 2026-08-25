# Docs 文件组织约定

**约束范围**：`docs/private/plans/`、`docs/improvements/` 与 `docs/experience/`。

> **两个 local-only 区**（gitignored，不入库；命名与目录约定仍适用于本地文件）：
>
> - `docs/experience/` —— 一次性操作手记（2026-06-05 决定）
> - `docs/private/` —— plans + 拓扑/凭据相邻的运维散文（2026-08-08 决定）。判据见 [`information-boundary.md`](information-boundary.md)：plan 天然记录主机、账号、部署拓扑与「还没修的洞」，属该文「私有散文」一层 —— 这类内容不进面向公开的仓。

**不受此约束**：`docs/conventions/` / `docs/adr/`（ADR 走 `NNNN-<slug>.md` 编号体例）/ `docs/spec/`。

## 命名

新建文件按 `MM-DD-<kebab-slug>.md`：

- `MM-DD`：创建当日（本地时区，零填充），如 `05-21`
- `<kebab-slug>`：从主题提取 kebab-case 3-5 词；含关键名词 + 动作/状态。**避免泛词**（`notes` / `misc` / `tmp` / `update`）
- 文件名总长 ≤ 60 字符
- 同日同 slug 撞名 → 末尾加 `-2` / `-3` 递增

## 目录结构

按 `YYYY-MM/` 月度子目录归档：

```text
docs/private/plans/              # local-only（gitignored），结构同下
  <YYYY-MM>/
    <MM-DD-kebab-slug>.md        # 如 05-21-archive-memory-bridge.md
docs/private/runbook/            # local-only：拓扑/凭据相邻的 runbook（公开侧留 stub）
docs/private/evidence/           # local-only：一次性取证的原始数据与采集脚本（带主机/容器名/IP/持仓快照，
  <NNN-feature-slug>/            #   永远不入公开仓）。按 feature 归档而非月度 —— 它跟着被验的 feature 走

docs/improvements/               # 调优 / 优化 / 改造记录（**入仓**），结构同上
  <YYYY-MM>/
    <MM-DD-kebab-slug>.md
docs/experience/                 # local-only（gitignored），结构同上
  <YYYY-MM>/
    <MM-DD-kebab-slug>.md
```

新建文件时，若当月目录不存在则创建。

## 三类记录怎么选

| 目录                  | 放什么                                                               | 入仓          |
| --------------------- | -------------------------------------------------------------------- | ------------- |
| `docs/private/plans/` | **要做什么、怎么做**：多阶段工程的计划、决策、验收目标               | ❌ local-only |
| `docs/improvements/`  | **做完测到了什么**：调优 / 优化 / 改造的实测数据、前后对比、实验记录 | ✅            |
| `docs/experience/`    | 一次性操作手记、个人踩坑流水                                         | ❌ local-only |

> `docs/improvements/` 是三者里唯一入仓的 —— 因为「测到了什么」通常是可公开的技术事实（前后对比、复跑命令），而「要做什么」几乎必然牵出主机与账号。写 improvements 时若某条实测**离不开**真实标识符，那条按 [`information-boundary.md`](information-boundary.md) 判：用代号改写，或整条挪进 `docs/private/`。

🚨 **会随代码增长而失效的数（文件计数 / 比例 / 耗时 / 某次改了几个文件）一律不进 `docs/conventions/`** —— convention 只放「一年后仍成立」的常驻规则，时点事实归 `docs/improvements/`。规范里需要引用证据时，链接过去，不要把数抄进来。判据不是「有没有数字」，是「会不会随时间失效」：PR # / 日期作历史证据锚、外部常数（如 Google 测试配比）都是耐久的。

**产出顺序（重构 / 优化 session）**：先落 `docs/improvements/` 实测记录，convention 事后从记录**提炼**——同一 session 手边全是「修了几个 / 还剩几秒」的素材时同步写 convention，时点数字必然互渗（2026-08-03 根因分析实证，两次事故均此形态）。

**守卫三层**（防「规约在写作时刻不在场」）：`scripts/pretooluse-convention-rubric.sh`（Write|Edit 时刻注入自检——新建文件唯一覆盖通道）+ `.claude/rules/convention-authoring.md`（read/edit 触发摘要）+ `scripts/checks/check-convention-orphan.ts`（全仓零引用的 convention = 红，路由不到等于不存在）。
