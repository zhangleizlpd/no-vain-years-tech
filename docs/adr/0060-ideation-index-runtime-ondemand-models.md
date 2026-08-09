---
adr_id: ADR-0060
status: Accepted
applies_to: [apps/server, infrastructure]
sunset_trigger: |
  - 用量上台阶（多用户 / 并发会话 / 高频索引 / 延迟 SLO 不容忍冷启动）→ 按需加载撑不住 → 重设计（升配 / 专用模型服务 / GPU / 托管 embedding）
  - 索引宿主升到能同时常驻 embedder + reranker（更大内存 / GPU）→ rerank 可改自托管，废除"rerank 走托管"与本 ADR 的按需 sidecar 复杂度
  - vector-only 召回实测不足、且 rerank 提升显著 → 启用 rerank（默认走托管 rerank API；除非宿主已升配）
  - Claude Code 交接桥（plan S4）进入实施 → 触发 agent-platform 集成 ADR（本 ADR scope 外，per ADR-0057 sunset）
---

# ADR-0060: Ideation 索引服务运行时进程模型 — 单机按需自托管单模型（bge-m3）+ vector-only

- Status: Accepted (2026-06-22)
- Deciders: @zhangleizlpd
- Tags: server / infrastructure / ideation / code-index / runtime
- Relates: [ADR-0059](0059-ideation-repo-grounding-code-index.md)（索引架构母决策：双路 + pgvector RAG + tree-sitter；本 ADR 定其**运行时进程模型**）/ [ADR-0057](0057-ideation-bounded-context.md)（ideation ctx = 消费者）/ [ADR-0055](0055-chat-ctx-sse-streaming-llm-provider.md)（SSE `reply.hijack()`；reranker/embedder 预热钩子复用其会话生命周期）；实施载体 = [ideation 接地 plan S2](../private/plans/2026-06/06-21-ideation-grounding-and-cc-handoff.md)

## Context

[ADR-0059](0059-ideation-repo-grounding-code-index.md) 定了索引架构（bge-m3 自托管 embed + 推荐 bge-reranker 精排），S1 spike 验证了选型（bge-m3 hybrid 4/4；**纯向量 α≈1.0 已是全量最优点**，rerank 仅修"规模一大真值沉底"）。

落地约束：索引服务跑在**一台小机（~2c4g，无 swap）**。无 swap = 内存打满直接 OUT-OF-MEMORY 硬杀（非变慢），可用内存是不可逾越的天花板。两个候选模型（bge-m3 embedder、bge-reranker）q8 运行时各 ~1.0–1.3G（XLM-RoBERTa-large 同族）。

两个事实决定了运行时形态：

1. **用量极低**（个人工具：单用户、~4 灵感会话/天、每个 ≤10min、增量同步低频）→ 模型一天 99% 时间闲，**没理由常驻**。
2. **查询链路本身需要 embedder**：用户的自然语言 query 必须先用 **bge-m3** 转成向量（与文档同一向量空间），才能 HNSW 检索。所以"查询时"需要的是 **embedder 常温**，不是（不止是）reranker。

## Decision

### 1. 零常驻：按需加载，靠进程退出回收 RAM

模型只在用到时加载、用完即放。**关键：node/onnxruntime 的"卸载"不保证把内存还给 OS（ORT arena 滞留）——只有进程退出 OS 才干净回收。** 故模型绑定到"会退出的进程"，而非常驻 API 进程内 load/unload。

### 2. 本机只自托管**一个**模型：bge-m3（embedder）

服务索引侧 + 查询侧的 embedding，**同一个 bge-m3**：

- **索引（builder）= 一次性进程**：触发时 `spawn` → load bge-m3 → embed 变更 chunk（秒级）→ upsert → **`exit`**。（S1 spike 的 `build.ts` 即此形态。）触发 = **cron 轮询 git-diff-by-SHA**（git 本身即 Merkle，`git diff --name-status` 白给变更集）。
- **查询 embed = 懒启温热 sidecar**：查询 API 常驻但本身**无模型**；首个检索请求 → spawn bge-m3 worker（冷 ~5–15s）→ 会话内温热复用（毫秒级）→ 空闲超时 `process.exit(0)` 释放。
- 二者用同一模型，靠 §4 mutex 保证**任意时刻只一份 bge-m3 在内存**。

### 3. 检索 baseline = vector-only；rerank 延迟，需要时走**托管 rerank API**

- S1 实证纯向量 α≈1.0 已是最优点 → baseline **不上 rerank**，本机查询期只需 bge-m3 一个模型。
- 若将来 vector-only 召回不足要加 rerank：查询期会**同时**需要 embedder（转 query）+ reranker → **两个自托管模型在 ~2c4g/no-swap 上装不下**（即便按需，查询瞬间两者并存）。故 rerank **走托管 rerank API**（本机零模型增量），保持"本机永远单模型"。仅当宿主升配到能容两模型时才考虑自托管 rerank（见 sunset）。

### 4. 两个强制优化

| 优化                       | 做法                                                                                                                              | 解决                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **SSE 预热**               | 灵感会话一开（SSE connect）就 spawn+load bge-m3 worker，趁用户打字那几秒 load 好；空闲超时只作卸载安全网                          | 消除会话首查的 5–15s 冷启动                                          |
| **builder 会话感知 mutex** | 查询 worker 活着时写 heartbeat/pidfile；cron builder spawn 前检查"有活跃会话?"→ 有则本 tick 跳过（下 tick 补，查询优先级 > 索引） | 保证**任意时刻 ≤1 份 bge-m3 在 RAM**，杜绝同一模型被双进程各加载一次 |

### 5. Swap 保险 + PG 调小

- 加 ~4G **swapfile**：把极小概率的撞车（builder × 查询同瞬）从 OOM 硬杀降级成"偶尔慢几十秒"，化解 no-swap 脆弱性。
- 专用 pgvector PG `shared_buffers` 调小（索引才几百 MB）。

## Consequences

- 索引服务（PG + builder + 查询 API + 按需 bge-m3）跑一台 ~2c4g 小机，单模型按需。RAM 形态（抽象规格，model q8 ~1.3G）：

  | 状态       | 本机模型                               |
  | ---------- | -------------------------------------- |
  | 平时       | 0（PG + 查询 API ~0.5G + 基础）        |
  | 会话中     | 1（bge-m3 温热，查询 embed）           |
  | 索引中     | 1（bge-m3，builder；会话活跃时不跑）   |
  | 两模型并存 | **mutex 杜绝**（同一 bge-m3 也只一份） |

- 每会话首查 ~5–15s 冷加载 bge-m3（SSE 预热可藏掉）。
- 进程管理复杂度：builder 触发器 + 查询 worker 生命周期 + mutex/heartbeat。
- 索引滞后 ≤cron 周期（~2min），对低频用量无感。
- rerank 不在 baseline；启用即引入一个托管 API 依赖（仅 rerank 阶段、量极小）。

## Trade-offs

| 短板                                       | 接受理由                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| 精巧但脆——依赖串行化 + 空闲计时 + 进程隔离 | ~2c4g/no-swap 下要单机自托管 embedding，按需 + 进程回收是唯一稳法；用量极低使其足够稳 |
| 会话首查冷启动                             | SSE 预热藏掉绝大部分；10min 会话只付一次                                              |
| rerank 不能自托管（本机）                  | 两自托管模型超 2c4g；vector-only 已是最优点，rerank 走托管换"本机永远单模型"          |
| sidecar/触发器额外代码                     | 换"零额外机 + 零 embedding API 成本 + 零外网依赖（baseline）"                         |

## Open Questions

- `bge-reranker-v2-m3` 若改自托管的 ONNX/transformers.js 可用性（仅在宿主升配后才相关）。
- 空闲超时 N（~5min 起调）、swapfile 大小、PG `shared_buffers` 精确值 → S2 实施期定。
- rerank 启用时的托管 provider 选型（域内 DashScope `gte-rerank` 等）→ 需要时再定。

## References

- [ADR-0059](0059-ideation-repo-grounding-code-index.md)（索引架构母决策）/ [ADR-0057](0057-ideation-bounded-context.md) / [ADR-0055](0055-chat-ctx-sse-streaming-llm-provider.md)
- [ideation 接地 plan S1-S4](../private/plans/2026-06/06-21-ideation-grounding-and-cc-handoff.md)
- S1 spike 实测（throughput / RAM / recall）：local `.spikes/s1-code-index/REPORT.md`（gitignored throwaway）
