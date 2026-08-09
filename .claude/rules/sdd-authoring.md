---
paths:
  - 'specs/**'
---

# SDD 产出物撰写细则（path-triggered，触及 `specs/**` 自动加载）

> canonical 内容自 `docs/conventions/sdd.md` 移驻（always-load 瘦身，2026-08-03）：mockup-first 前端流程 + design/ 留迹 + 反模式清单只在写 spec / plan / tasks / design 时相关，path-trigger 按需装载。SDD 标准流程 / frontmatter / review gate 仍在 sdd.md（always-load）。

## 前端 UI 工作流（统一 mockup-first）

前端 UI 业务模块统一走 **mockup-first** 单一流程（不再按 UI 类别分支）：

```text
spec → clarify → Mockup（design/，库选型 + paradigm 决策先做；走 `/mockup-gen NNN` 自动生成 HTML preview baseline 落 design/）
     → plan（含完整 UI 段）→ tasks（[Server] / [Mobile]）→ impl 业务 + UI
```

- **库 / paradigm 选型**：自由画布（PKM 知识图谱）/ 数据可视化（投资板块图表 / dashboard）等需先锁库与渲染范式的场景，在 **Mockup 阶段**一并决策（图表库 + 数据建模与 mockup 互锁）——这是 mockup 阶段的通用注意事项，不再单列类别。
- **后端业务模块**（account / pkm / 其他 server use case）：不涉及 UI，走完整 SDD 标准流程，无 mockup 步骤。
- **跨端 feature**：impl 走**单 PR**（server impl + 真后端 IT + api-client regen + mobile 消费同 PR，per [Constitution §V](../../.specify/memory/constitution.md)）。mobile 侧落**正交两层验证**：① `[Mobile-E2E]` hermetic UI e2e（Playwright，验交互/点通）+ ② `[Contract-Smoke]` 契约冒烟（node 层，生成 `@nvy/api-client` 打 testcontainers 真 server，验契约对齐+真落库，补 hermetic mock 与 server IT 都覆盖不到的缝；落 `apps/mobile/e2e/contract-smoke/<feature>.contract.ts` 共享套件，`nx run mobile:contract-smoke`）。业务流验证由 **server IT + mobile 两层**承担，**无需占位 UI 预验**。（⚠️ 旧「真后端冒烟」措辞混指 ①，已拆）

### Mockup 留迹路径（per [ADR-0024](../../docs/adr/0024-spec-feature-first-layout.md)）

Mockup 与 spec / plan / tasks 同位于 feature 目录 `design/` 子目录（适用所有 UI feature）：

```text
specs/NNN-<feature-slug>/
├── spec.md
├── plan.md
├── tasks.md
└── design/          # PNG / handoff bundle / 设计 notes —— **local-only（gitignored）**
```

**代码是真相源**：mockup drift 不算 bug — `design/` 是历史决策留痕，不要求与最终 RN 代码逐 pixel 同步。

🚨 **`design/` 不入库**（`.gitignore` `specs/*/design/`，2026-08-08 决定）：本仓面向公开，而 design bundle 装的是真机截图，截图里可能有真实账户 / 持仓 / 手机号 —— 「像素里的 PII」没有任何扫描器能抓（per [`information-boundary.md`](../../docs/conventions/information-boundary.md)）。留迹价值不变，`/mockup-gen` 照常写这里，只是留在本机。**历史 spec / plan 里对 `design/` 的引用是冻结决策记录，不回改**（同本节下方 retire 注记的处理方式）。

> **历史概念已 retire**：旧版「类 1 / 2 / 3 UI 类别 + 占位 UI 4 边界 + `// PHASE 1 PLACEHOLDER` banner」已于 Constitution v1.2.0（2026-06-02）统一为本 mockup-first 流程。历史 spec / plan 中对其的引用为**冻结决策记录**，不回改。

## 反模式

- ❌ implement 阶段跳过 TDD — SDD 不替代 TDD
- ❌ tasks 拆得过细（每个 method 一个 task）— 一个 task 应是 30min-2h 的可单独 commit 工作单元
- ❌ spec drift（代码改了 spec 没改）— PR review 时 spec / code 必须一起 review；超过 1 周脱节就删 spec 转向代码注释
- ❌ `/speckit-analyze` 或交付前自审**靠通读**（尤其自己就是文档作者时）— 覆盖完整性必须**逐条 grep 交叉核对**（FR / SC / Edge Case / `state_branches` → tasks 的零命中扫描 + 编号连续性 + 矩阵条数 vs spec 实际条数）。**SC 层是系统性盲区**：写 tasks 时人对着 FR 展开，SC 不产出代码行、没有牵引力（2026-08-01 045 实证：同一份 tasks 里 FR 37/37 而 SC 仅 6/11，漏掉的恰是「只有口号、没有验证手段」的那两条；6 项发现里 5 项靠 grep 抓、仅 1 项靠人工判断）。三条配套：① **条数一律实时 grep**，别抄 `checklists/` 的历史数字（clarify 后还会改，必 stale）② **预期的零覆盖要写明「故意的」**（如非验收门的 SC），否则下次 analyze 又当缺口补 task ③ **探针自己会误报**，先排除自己管道的假阳性再下结论 ④ 🚨 **矩阵的值域本身可能够不到需求所在的层** —— 三张矩阵扫的是 `state_branches` / Edge Case / SC，**不含 `## User Scenarios` 里的 Acceptance Scenario**；写在 AS 里的需求会因此零覆盖**且零告警**（2026-08-04 046 实证：US1-AS1「从雷达点该行进入详情」被**两轮 analyze 全漏**，impl 完才发现详情屏只有深链可达，补为 T028）。⇒ analyze 起手先列「spec 有哪几层 / 我扫了哪几层」，**差集要么补扫、要么写明故意不扫** —— 这一问在「逐条 grep」之前，grep 得再勤也照不到值域外
- ❌ md 正文里**裸写带下划线的标识符**（DB 列名 / vendor 字段 / env var）— lefthook `format`（prettier）把 `_…_` 当强调语法改写，**静默改坏字段名**：`iv_rank / iv_percentile / hv_*` → `iv*rank / iv_percentile / hv*\*`。危害不是难看，是下游照着 spec 写 impl 就是错字段，而 markdownlint 不报、CI 全绿、hook 输出只显示文件名和耗时。**修法 = 一律包 backtick**（包了 prettier 不碰）。自查：`npx prettier --write <file>` 后 `grep -nE '[a-z]\*[a-z_]+ / |\*\\\*' <file>`，有命中即被改坏（2026-08-02 046 spec 实撞两处，靠逐字段复查才发现）
- ❌ plan 阶段多造 `research.md` / `data-model.md` / `quickstart.md` / `contracts/` — mono plan 阶段产物 = **仅 `plan.md`**（prose-only，data model SoT=`schema.prisma` / API SoT=swagger 装饰器，plan 模板首行「Do NOT mirror」）。⚠️ `.claude/skills/speckit-plan/SKILL.md` 是 **vanilla 上游**、Phase 0/1 会明写「Generate research.md/data-model.md/quickstart.md」——**抵住 SKILL 字面步骤，以本约定为准**（镜像 SoT 的 doc 必 drift = SDD 反模式；2026-07-11 038 实证跟 SKILL 字面多造 3 文件被抓，此前 37 spec 全 0）
