# Architecture Decision Records (ADRs)

记录架构 / 工具 / 流程层的关键决策。

**修订策略（分层不可变，per [ADR-0031](0031-adr-governance.md) § ADR 修订策略）**：

- `Proposed` — 尚未冻结，自由 in-place 改 / 删，无需 supersede 仪式。
- `Accepted` — 原则上 supersede-not-delete（**决策本身**变更时立新 ADR、旧标 `Superseded` 留史链接覆盖）；但「不改变决策」的修订（anchor typo / 版本号更新 / 路径名更正 / 笔误纠正）**豁免**，允许 in-place 改。
- `Deprecated` / `Superseded` — 终态留史，不再 in-place 改。

**内容约定（记 durable 决策，不记过程/状态）**：ADR 只记**时间无关的决策 + 理由**。过程/过渡/状态数据——迁移时序、当前资源占用、机器身份（"62 / 账号 A"）、"X 迁走后专用"、具体 `free -h` 数字——是噪音，会很快 stale，**放 runbook / plan**（它们本就时态性）。决策理由**抽象到资源规格**（如"单机 2c4g / no-swap"）而非具体机器。

## 新立 ADR 模板

走 `adr-governance` preset（来自 `michael-speckit-presets`，上游仓已不可达） 装的 template:

- 模板路径: `.specify/presets/adr-governance/templates/adr-template.md`
- 校验脚本: `scripts/check-adr-frontmatters.ts` (lefthook pre-commit 自动跑;手动 `pnpm tsx scripts/check-adr-frontmatters.ts`)
- schema: `.specify/schemas/adr-governance/adr.zod.ts`

新 ADR 流程:

1. 决定 NNNN 编号: `ls docs/adr/ | tail -1` 看现有 max 数,+1。
2. 复制 template: `cp .specify/presets/adr-governance/templates/adr-template.md docs/adr/NNNN-<kebab-slug>.md`
3. 填 frontmatter 4 必填字段 (adr_id / status / applies_to / sunset_trigger)
4. 填正文 (Context / Decision / Consequences / Trade-offs / Open Questions / References)
5. `git add docs/adr/NNNN-*.md` → 触发 lefthook adr-frontmatter-check 验证
6. 通过则可 commit;失败按错误信息回填

## Frontmatter 4 必填字段 (per [ADR-0031](0031-adr-governance.md))

| 字段             | 值域                                                                            | 用途                                                                          |
| ---------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `adr_id`         | `ADR-NNNN`                                                                      | 与文件名 NNNN 严格一致 (e.g. `0042-foo.md` ↔ `ADR-0042`),lefthook cross-check |
| `status`         | `Proposed` / `Accepted` / `Deprecated` / `Superseded` / `Reserved`              | 生命周期                                                                      |
| `applies_to`     | list of `{ apps/<name>, packages/<name>, infrastructure, security, mono-wide }` | LLM agent programmatic filter,按 task scope 决定加载哪些 ADR                  |
| `sunset_trigger` | 多行字符串 ≥ 10 字符                                                            | 强制显式记录"何时本 ADR 应被重审/退役"                                        |

## ADR 现状索引

> status 列由各文件 frontmatter 反推，机械防护见下「索引一致性校验」。

| ADR  | 主题                                                                                    | applies_to                                       | status     |
| ---- | --------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------- |
| 0018 | Backend Language Pivot — TypeScript on NestJS+Fastify+Prisma+Nx                         | apps/server                                      | Accepted   |
| 0019 | ORM — Prisma v7+                                                                        | apps/server, packages/types                      | Accepted   |
| 0020 | 模块边界 — NestJS Module + ESLint boundaries v6                                         | apps/server, packages/api-client, packages/types | Superseded |
| 0022 | 限流 — @nestjs/throttler v6 + Redis storage                                             | apps/server                                      | Accepted   |
| 0023 | SMS code 存储 — HMAC-SHA256 + constant-time                                             | apps/server                                      | Accepted   |
| 0024 | Specs feature-first 布局 + frontmatter modules 反查                                     | mono-wide                                        | Accepted   |
| 0025 | 前端部署 — Expo Web → Cloudflare Pages                                                  | apps/mobile                                      | Accepted   |
| 0026 | Backend Deployment Topology                                                             | apps/server, infrastructure                      | Accepted   |
| 0027 | Frontend Data + Test Layer (Orval + RQ + Maestro)                                       | apps/mobile, packages/api-client                 | Accepted   |
| 0028 | Monorepo pnpm Policy (shamefully-hoist)                                                 | mono-wide                                        | Accepted   |
| 0029 | TS Module Resolution Policy (bundler base)                                              | mono-wide                                        | Accepted   |
| 0030 | Package Decomposition (5→2)                                                             | mono-wide                                        | Accepted   |
| 0031 | ADR Governance & Programmatic Filtering                                                 | mono-wide                                        | Accepted   |
| 0032 | Backend Bounded Context Split (security + account + auth)                               | apps/server                                      | Accepted   |
| 0033 | Cross-Context Communication via Outbox                                                  | apps/server                                      | Accepted   |
| 0034 | Auth/Account Operation Catalog (3 传播规则 + LLM decision tree)                         | apps/server                                      | Accepted   |
| 0035 | Data Layer Governance (migrate + naming + seed + types regen)                           | apps/server                                      | Accepted   |
| 0036 | Observability and Logging Governance                                                    | apps/server, apps/mobile                         | Accepted   |
| 0037 | Security and Credentials Governance                                                     | apps/server, apps/mobile, security               | Proposed   |
| 0038 | Full-Stack Error Handling and UX Contract                                               | apps/server, apps/mobile, packages/api-client    | Accepted   |
| 0039 | Performance and Latency Governance                                                      | mono-wide                                        | Accepted   |
| 0040 | Multi-layer Test Gate (机制 / 策略 / 门禁 三段渐进)                                     | mono-wide                                        | Accepted   |
| 0041 | Server `src/common/` Policy — 不引入,平台 infra 进 security/                            | apps/server                                      | Accepted   |
| 0042 | Monorepo Release Strategy — release-please 双线 + 内部包零版本                          | mono-wide                                        | Accepted   |
| 0043 | Server 模块内构范式 — 扁平 + 贫血数据 + 纯函数 Helper + 跨界                            | apps/server                                      | Accepted   |
| 0044 | Mobile Binary 部署 — EAS 云构建 + Android APK + iOS 两阶段                              | apps/mobile                                      | Accepted   |
| 0045 | 对象存储 + 图片上传 — Aliyun OSS + client 直传 + public-read                            | apps/server, apps/mobile                         | Accepted   |
| 0046 | 跨行聚合不变性并发 — 单行塌缩+conditional UPDATE / FOR UPDATE                           | apps/server                                      | Proposed   |
| 0047 | Marketdata 可插拔数据访问层 — schema+port 先行 / 多 vendor / 约束档 / fallback          | apps/server                                      | Accepted   |
| 0048 | Marketdata↔Portfolio 跨层依赖方向 — 单向无环 + 反向走 Q7                                | apps/server, apps/mobile                         | Accepted   |
| 0049 | Marketdata 调度体系 — PG 调度真相层 + 裸 BullMQ 执行层（类 Quartz 混合）                | apps/server, infrastructure                      | Accepted   |
| 0050 | Marketdata 复权序列物化策略 — 三口径全物化，否决读时换算与中间态                        | apps/server                                      | Superseded |
| 0051 | Marketdata 复权序列读时换算 — 只存 none + 累积 backward 因子（策略 C）                  | apps/server                                      | Accepted   |
| 0052 | Alert 第 6 Bounded Context — 调度自治 EOD 预警引擎 + Q7-B 只读 ×2                       | apps/server                                      | Accepted   |
| 0053 | 跨 Context 纯函数 rules import — boundaries 细分仅放行 alert→marketdata-rules           | apps/server                                      | Accepted   |
| 0054 | Alert 自持外部 IO Adapter — 实时行情双源热备落 alert ctx 不 import marketdata           | apps/server                                      | Accepted   |
| 0055 | Chat 第 7 Bounded Context + SSE 流式端点 reply.hijack 范式 + LlmProvider port           | apps/server, apps/mobile                         | Accepted   |
| 0056 | Chat AI 回复 Markdown 渲染 — react-native-enriched-markdown (web+native)                | apps/mobile                                      | Accepted   |
| 0057 | Ideation 第 8 Bounded Context — 移动端需求澄清助手(任务态)+ 叶子 ctx + LLM 端口复用     | apps/server, apps/mobile                         | Accepted   |
| 0058 | Server integrations/ 层 — 跨 ctx 共享外部 vendor I/O 适配器家(LLM 首位)refine ADR-0041  | apps/server                                      | Accepted   |
| 0059 | Ideation 仓库接地 — 双路(本地 agentic grep / 云端中心化 pgvector RAG)+ tree-sitter 索引 | apps/server, apps/mobile, infrastructure         | Accepted   |
| 0060 | Ideation 索引服务运行时 — 单机按需自托管单模型(bge-m3 embedder)+ vector-only            | apps/server, infrastructure                      | Accepted   |
| 0061 | Ideation 语音输入 — 听写式 + DashScope Qwen3-ASR(可换 port)+ server WS 代理实时流式     | apps/server, apps/mobile                         | Accepted   |
| 0062 | Optionsdesk 第 10 Bounded Context — 期权台锚管理 + 击球区雷达 + 跨 ctx 双向仅 Q7-B 只读 | apps/server                                      | Accepted   |
| 0063 | Mobile 冻结列表格横向同步 — 单 Pan 驱动共享值,弃 `scrollTo` 广播                        | apps/mobile                                      | Accepted   |
| 0064 | Optionsdesk 选约检索五层架构 — 召回/粗排/特征加工/精排/表达,可插拔精排,不设重排层       | apps/server, apps/mobile                         | Accepted   |
| 0065 | 研报库第 11 Bounded Context — 私有桶 + server 代理上传,amend ADR-0045 两条被否决项      | apps/server                                      | Accepted   |
| 0066 | 时间语义统一语言 — 四条时间轴 + session 词表 + 逐维度 asOf 口径,纯时钟层不碰日历        | apps/server                                      | Accepted   |
| 0067 | Vendor 缺失语义 — 带内哨兵在 adapter 边界归一为 null,成对判据 + 不可判定列显式登记      | apps/server                                      | Accepted   |
| 0068 | 实时窄召回两段式与选档理论 — 窗即召回,凸包清链,φ+形状行军,精排扩为排序+选档             | apps/server, apps/mobile                         | Accepted   |

(0021 历史空缺,跳过编号 — 详 commit 历史)

### 索引一致性校验

`scripts/checks/check-adr-index.ts`（lefthook `adr-index-check` 自动跑;手动 `pnpm tsx scripts/checks/check-adr-index.ts`）机械校验上表与各文件 frontmatter 一致：每篇 ADR ↔ 恰一行（无漏 / 无幻影），且 status 列 == frontmatter `status`。改 status 或新增 ADR 后须同步本表，否则 commit 被拒。

## 反查与过滤

按 module 找相关 ADR:

```bash
# 哪些 ADR 影响 apps/mobile?
grep -lE '^\s*-\s+apps/mobile\b' docs/adr/*.md

# 哪些 ADR 是 mono-wide?
grep -lE '^\s*-\s+mono-wide\b' docs/adr/*.md
```

按 status 过滤:

```bash
# 哪些 ADR 仍是 Proposed?
grep -lE '^status:\s+Proposed' docs/adr/*.md
```
