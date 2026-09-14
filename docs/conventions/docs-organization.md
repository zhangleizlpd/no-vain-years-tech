# Docs 文件组织约定

**约束范围**：`docs/private/plans/`、`docs/improvements/` 与 `docs/experience/`；另管 SDD 文档（`specs/NNN-*/`）正文里的数字（见 § SDD 文档里的数字）。

> **两个 local-only 区**（gitignored，不入库；命名与目录约定仍适用于本地文件）：
>
> - `docs/experience/` —— 一次性操作手记（2026-06-05 决定）
> - `docs/private/` —— plans + 拓扑/凭据相邻的运维散文（2026-08-08 决定）。判据见 [`information-boundary.md`](information-boundary.md)：plan 天然记录主机、账号、部署拓扑与「还没修的洞」，属该文「私有散文」一层 —— 这类内容不进面向公开的仓。

**不受此约束**：`docs/conventions/`（它的 evergreen 约束见下节）/ `docs/adr/`（ADR 走 `NNNN-<slug>.md` 编号体例）。

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

## `docs/conventions/` 只放 evergreen

🚨 **会随代码增长而失效的数（文件计数 / 比例 / 耗时 / 某次改了几个文件）一律不进 `docs/conventions/`** —— convention 只放「一年后仍成立」的常驻规则，时点事实归 `docs/improvements/`。规范里需要引用证据时，链接过去，不要把数抄进来。判据不是「有没有数字」，是「会不会随时间失效」：PR # / 日期作历史证据锚、外部常数（如 Google 测试配比）都是耐久的。

**产出顺序（重构 / 优化 session）**：先落 `docs/improvements/` 实测记录，convention 事后从记录**提炼**——同一 session 手边全是「修了几个 / 还剩几秒」的素材时同步写 convention，时点数字必然互渗（2026-08-03 根因分析实证，两次事故均此形态）。

**守卫三层**（防「规约在写作时刻不在场」）：`scripts/hooks/pretooluse-convention-rubric.sh`（Write|Edit 时刻注入自检——新建文件唯一覆盖通道；对 plans / improvements / experience 同一 hook 注入命名规则）+ `.claude/rules/convention-authoring.md`（read/edit 触发摘要）+ `scripts/checks/check-convention-orphan.ts`（全仓零引用的 convention = 红，路由不到等于不存在）。lefthook `docs-organization-drift` 只能拦入仓的 `docs/improvements/` 新文件命名 —— plans / experience 是 gitignored，进不了 staged。

## SDD 文档里的数字

`specs/NNN-*/` 下的 spec / plan / tasks / analysis / checklists 入仓公开，但不是 evergreen 区 —— 一个数能不能写，判据是**它属于哪一类**：

| 类                          | 例                                                        | 怎么写                                                                                                                                      |
| --------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) schema 管的生命周期字段 | frontmatter `status` / `updated_at`、tasks `[X]`          | 照写 —— 它们本就是时点状态，由 schema 与 impl 闭环维护                                                                                      |
| (b) 易变的系统 / 数据状态   | 某 context 当前 use case 数、库里多少行                   | 不写值，写**查法 + 判据**（命令或查询 + 多少算过）；确需快照支撑决策时带日期                                                                |
| (c) 源自私有数据的观测值    | 账户 / 持仓 / 成交 / 订单相关的数量、条数、代码、起始时间 | 公开文本里**一律不写，带日期也不行**：写定性表述 + 出处（谁、哪天、哪份私有证据），原始数字只放 `docs/private/evidence/<NNN-feature-slug>/` |

- `analysis.md` / `checklists/` 里关于 **spec 自身**的计数（FR 条数、覆盖率）是时点审计产物，不在 (b) 的禁止范围；(c) 仍然适用。
- **(c) 按来源判，不按形状判**：同样是「几条」，出自公开行情 / vendor 行为时可按 [`comment-provenance.md`](comment-provenance.md) 当出处写；出自自己账户的成交、持仓就是 (c)。私有数据的范围见 [`information-boundary.md`](information-boundary.md) § 个人 / 金融业务数据。
- **(c) 为什么带日期也不救**：日期能让 (b) 的快照变成永真的历史事实，但 (c) 的问题不在过期，在**发布本身**。
- 实证锚：2026-09-14 082 实证 —— POC 取到的真实合约 / 股数 / 条数一路流进 tasks、fixture 与 PR。
