---
adr_id: ADR-0059
status: Accepted
applies_to: [apps/server, apps/mobile, infrastructure]
sunset_trigger: |
  - agentic-grep（无索引）实测在远程也达标召回且 token 不再是瓶颈 → 重审是否还需中心化向量索引（向本地式 grep 收敛）
  - 向量规模超 pgvector 舒适区（> ~100 万 / 需复杂 payload 过滤 / GPU ANN）→ 评估迁 Qdrant / Milvus
  - 远程索引退回单一消费者（仅 ideation chat、无多机 / 多 repo）→ 评估去中心化 / 进程内 tool，不再独立服务
  - 本地消费者（CC / agent-platform）出现「拿不到活仓」场景需要远程索引 → 重审「按消费者位置拆分」原则
  - Claude Code 交接桥（plan S4）进入实施 → 触发 agent-platform 集成 ADR（本 ADR scope 外，per ADR-0057 sunset）
---

# ADR-0059: Ideation 仓库接地架构 — 双路接地 + 远程中心化代码索引（tree-sitter + embedding + pgvector RAG）

- Status: Accepted (2026-06-21)
- Deciders: @zhangleizlpd
- Tags: server / mobile / architecture / ideation / code-index / rag
- Relates: [ADR-0057](0057-ideation-bounded-context.md)（ideation ctx；本接地为其 sunset trigger #4「自动交接电脑端」之外补的「移动端 repo-aware 澄清」能力）/ [ADR-0058](0058-server-integrations-layer.md)（`integrations/llm` port；chat 复用的 LLM 调用面）/ [ADR-0055](0055-chat-ctx-sse-streaming-llm-provider.md)（chat SSE `reply.hijack()` + tool-calling 范式，被复用）/ [ADR-0045](0045-object-storage-image-upload.md)（附件直传，B2）；实施载体 = [ideation 接地 plan](../private/plans/2026-06/06-21-ideation-grounding-and-cc-handoff.md)（子 plan S1-S4）

## Context

[ADR-0057](0057-ideation-bounded-context.md) 把 ideation 定为「移动端模糊初衷 → AI 多轮澄清 → requirements brief」,但其 LLM 是**纯云端、repo-blind**。实证表明 repo-blind 不可行:扒最近 027-031 五个 feature,**~75-80% 的需求关键决策点需「现场查代码」才能定**(028 不知道「027 建了 conversation/message 两表」就写不出需求;031 离不开「030 的 system-prompt 接缝在哪」),且依赖在 **spec(WHAT)阶段就爆发**,不是延到 plan/SDD。业内棕地共识同此:greenfield 纯 PRD 够,brownfield 必须**检索接地**。

两个问题需定稿:

1. **接地能力放哪、怎么给不同消费者**(本地 Claude Code / agent-platform / 云端 ideation chat 三类,且未来多 repo)。
2. **看不到代码的云端 chat 怎么接地**。

业内两条路线对照:Claude Code 早期用 RAG+向量库,后**主动弃用改纯 agentic grep**(首因 **staleness** —— 预建索引随编辑漂移,外加 simplicity/privacy/precision);Cursor 反向走**向量索引**(省 token)。2026 收敛共识 = 「agentic 为骨干,语义索引只在需要处加」。

## Decision

### 1. 接地按消费者位置拆分（双路），不建单一共享索引

- **本地消费者(CC / agent-platform,握活仓 dev 状态)= agentic grep 活仓,零远程依赖。** 依据:本地握最新代码,让其「改完 → push → 远程索引 → 反向查」是把一手最新数据绕成陈旧二手,方向反了 —— 即 Anthropic 给 Claude Code 弃 RAG 的同一 staleness 论证。
- **云端 chat(prod,无仓库)= 远程索引。** 这是索引唯一成立的场景(消费者真看不到代码)。
- **否决**「单一共享 MCP 索引服务供三方复用」:会强迫本地消费者依赖陈旧远程,违背 freshness 需求。

### 2. 远程索引 = 中心化代码 RAG（tree-sitter + embedding + pgvector）

云端侧选型:

| 方案                                         | 省 token                                    | 多机部署                   | 决断   |
| -------------------------------------------- | ------------------------------------------- | -------------------------- | ------ |
| grep-over-checkout(每机 git checkout + grep) | 否(agentic 多轮工具调用)                    | ✗ 每机一份全 repo checkout | 否决   |
| **中心化向量索引(Cursor 路线)**              | 是(实测省 97% 输入 token / 58-70% 工具调用) | ✓ 一处建、各机只查         | **选** |

技术栈:**tree-sitter AST 分块 + 代码 embedding + pgvector**,`pgvector` 向量检索 + PG 原生全文检索做**同库 hybrid**。向量库选型:

| 规模                             | 选择                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| **< 100 万向量 + 已用 Postgres** | **pgvector**(复用 PG/Prisma 栈;本仓 3 repo × tree-sitter 分块 ≈ 十几万 chunk,远低于阈值) |
| 1–50M / 复杂过滤                 | Qdrant(sunset 再迁)                                                                      |
| 50M+ 水平扩展                    | Milvus/Zilliz(够不着)                                                                    |

- **专用 PG 实例**承载 pgvector,**不压 2c4g prod PG**(资源隔离)。
- **否决知识图谱型索引**(语义 call graph;graphify 在本仓已实测语义查询不可用,仅 get_pr_impact 可用)。

### 3. 中心化服务化 + 多 repo + 会话级 repo 锁定

- 中心化服务:索引 builder + 查询 API(HTTP 起步,MCP 可选)+ **GitHub push webhook 增量**(按文件 hash/Merkle,仅变更文件 re-embed+upsert)+ **多 repo 命名空间** + **repo catalog/meta 端点**(列已索引 repo + 状态)。各云端机器**只查不 checkout**。
- ideation 侧:`idea_session` 加 `repo` 字段(扩展 ADR-0057 四表),**锁定该会话的 pgvector 命名空间**;mobile 用 meta 端点填 **repo 选择器("+")**,每会话单 repo。
- chat 把「向量检索」暴露为 DeepSeek/M3 的 tool(复用 [ADR-0055](0055-chat-ctx-sse-streaming-llm-provider.md) 的 SSE + 030 tool-calling 范式;**范式复用 ≠ import chat ctx**)。

### 4. 范围 + 与 Claude Code 交接桥的关系

- 本 ADR 覆盖**接地 / 索引**(plan S1-S3)。chat 模型复用 DeepSeek V4(主)/ M3(备)经 `integrations/llm` port —— 二者均完整支持 tool calling,**chat 不需要 Claude Code**(后者是 agent harness 非模型)。
- **Claude Code 交接桥(plan S4)= agent-platform 集成**,per [ADR-0057](0057-ideation-bounded-context.md) sunset trigger,**本 ADR scope 外**(仅 related);该桥在本地用活仓 agentic grep(决策 1),**不依赖**本远程索引。

## Consequences

- 新增独立**索引服务**(infrastructure)+ **专用 PG(pgvector)** 实例;部署机器(account A internal-dev vs 专设第三台)= Open Q。
- ideation ctx([ADR-0057](0057-ideation-bounded-context.md))数据模型新增 `idea_session.repo`。
- 本地 CC / agent-platform **零新增**(用现有 agentic grep)。
- mobile 新增 repo 选择器(拉 meta 端点)。
- chat 接地走「向量检索 tool」,复用既有 SSE/tool-calling 范式,无新模型依赖。

## Trade-offs

| 短板                                             | 接受理由                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| 两套接地路径(本地 grep / 远程向量)而非单一统一面 | 各自匹配消费者 freshness:本地要 WIP→活仓;云端推理已提交架构→快照足够。强行统一会逼本地依赖陈旧远程 |
| 中心化向量索引引入新服务 + 专用 PG               | 换省 token + 多机不各自 checkout;grep-over-checkout 每机一份 checkout 与多机部署直接冲突           |
| pgvector 非专用向量库                            | 规模 < 100 万 pgvector 足够且零新 DB 技术;超规模走 sunset 迁 Qdrant/Milvus                         |
| 快照陈旧(current-as-of-last-push)                | ideation 推理**已提交架构**(ADR/已合 ctx),陈旧无碍;要 WIP 本地 CC 直接读活仓                       |

## Open Questions

- embedding 模型:本地 BGE-code(@xenova/transformers,省成本)vs 托管 code-embedding(质量)→ S1 spike 定。
- 索引服务物理落点(独立 repo / 目录)与其相对 apps/server 的进程边界 → S2 实施期定。
- ~~查询接口是否需 MCP~~ → **Resolved (2026-06-22)**:HTTP 起步,按需加 MCP(第二类消费者出现再加)。
- ~~索引服务部署机器:account A internal-dev vs 专设第三台 ECS~~ → **Resolved (2026-06-22)**:复用 **SWAS(.62,account A)**——prod 迁 ECS(.77)后 SWAS 空出,即 [ADR-0060](0060-ideation-index-runtime-ondemand-models.md) 假设的 ~2c4g/no-swap 宿主,零新增机器。
- hybrid 召回的 vector / FTS 权重与 rerank 策略 → S1 spike 调。

## References

- [ideation 接地 plan(S1-S4)](../private/plans/2026-06/06-21-ideation-grounding-and-cc-handoff.md)
- [ADR-0057](0057-ideation-bounded-context.md) / [ADR-0058](0058-server-integrations-layer.md) / [ADR-0055](0055-chat-ctx-sse-streaming-llm-provider.md)
- 外部:Claude Code 弃 RAG 改 agentic grep（[vadim.blog](https://vadim.blog/claude-code-no-indexing/) / [smartscope](https://smartscope.blog/en/ai-development/practices/rag-debate-agentic-search-code-exploration/)）;[pgvector vs Qdrant vs Milvus 选型](https://dev.to/linou518/choosing-the-foundation-for-your-rag-system-pgvector-vs-qdrant-vs-milvus-2026-4i5o);[scip-typescript(monorepo 模式)](https://github.com/sourcegraph/scip-typescript) / [tree-sitter AST 分块](https://supermemory.ai/blog/building-code-chunk-ast-aware-code-chunking/)
