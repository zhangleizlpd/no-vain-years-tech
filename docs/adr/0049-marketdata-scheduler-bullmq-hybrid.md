---
adr_id: ADR-0049
status: Accepted
applies_to: [apps/server, infrastructure]
sunset_trigger: |
  - 盘中实时 tick 摄取 feature（master plan §B.4 seam）实装时：复审单 queue / concurrency=1 / 裸 bullmq 手动 provider 三决策是否仍成立（实时场景可能需独立 queue + 更高并发 + 独立 Redis 逻辑库）
  - DBOS 类「PG 内 durable execution」2027 年若成熟（生产案例 + 社区收敛），复审是否用其替换「PG 真相层 + BullMQ 执行层」两层为一层
  - 出现多节点部署需求（vendor 限频解除 / 多 vendor 并行）→ 「单节点 + 进程内令牌桶 + concurrency=1」前提失效，重审分片与限频器外置
  - 理杏仁配额实测完成后：misfire≠backfill 的保守切分（防自动 backfill 烧配额）可复审是否放宽为有界自动补
---

# ADR-0049: Marketdata 调度体系 — PG 调度真相层 + 裸 BullMQ 执行层（类 Quartz 混合架构）

- Status: Accepted (2026-06-04)
- Deciders: @zhangleizlpd
- Tags: server / infrastructure / scheduling / market-data / bullmq / reliability
- Relates: follows [ADR-0047](0047-marketdata-pluggable-data-access.md)（vendor 限频 F4 = 单例无分片前提）；演进 016-marketdata-sync 的调度形态（静态 @Cron 22:00 + 管线内 due 过滤）；设计全文 = [06-04-marketdata-scheduler-redesign](../private/plans/2026-06/06-04-marketdata-scheduler-redesign.md)
- Supersedes（部分）: [06-03-sync-window-config-reconciliation-seam](../private/plans/2026-06/06-03-sync-window-config-reconciliation-seam.md) 中「SchedulerRegistry 动态注册 per-dimension cron」的升级 seam 设想 — 改走本 ADR 的 tick + nextFireAt 形态

## Context

016 ship 的调度形态有四个结构性缺陷（代码实证见设计文档 §A）：

1. **失败连坐**：6 维度在 `eod-sync-pipeline.ts` 同一 try 块串行，任一维度顶层异常 → 下游维度全不跑（#318 只修了 universe 源返空不抛，结构未变）。
2. **单一静态时间点**：`@Cron` 22:00 触发整管线，`SyncDimension.cronExpr` 只是管线内「今日 due」过滤器，非独立调度。
3. **无 misfire/catch-up**：进程错过 22:00 永不补跑；`retryMax` 字段无消费者。
4. **无依赖编排 / 手动级联**：上游（周级 universe）修复后无法拉起下游（日级 bar）；手动面仅 backfill CLI。

诉求：类 Quartz 的基于存储可恢复调度（单节点即可）+ 任务依赖编排能力（软依赖现在、硬依赖留能力）+ 延迟/手动触发 + 修复后级联拉起。

**关键调研结论**（2026-06 联网，全文设计文档 §B-G）：Node 生态没有 1:1 的 Quartz（JobStore + 调度线程 + MisfireHandler + ThreadPool 四件套没人给齐）→ 「调度真相层」必然自建落 PG，选型分叉只在执行层。

## Decision

### 1. 分层：PG 调度真相层 + 裸 BullMQ 执行层

| 层             | Quartz 类比               | 实现                                                                                                                                                                                                                                                                                                                        |
| -------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PG 调度真相层  | JDBC JobStore             | `SyncDimension` 扩 `nextFireAt`（物化下次触发时刻，`cronExpr` 仍是真相）+ `misfirePolicy`；新表 `sync_dependency`（upstream/downstream/mode `hard\|soft`）                                                                                                                                                                  |
| SyncTickDriver | 调度线程 + MisfireHandler | 分钟级无状态 `@Cron` tick；**条件 UPDATE 抢占推进 nextFireAt**（affected-count won/lost，防双 tick 重复入队，正确性不依赖 Redis 锁）；启动后首个 tick 扫到过期 `nextFireAt` = 天然 misfire catch-up；交易日 gate 在此层（组 flow 前短路）                                                                                   |
| BullMQ 执行层  | ThreadPool                | **裸 bullmq + 手动 provider**（不用 `@nestjs/bullmq` 装饰器 wrapper，贴 ADR-0043 扁平手控风格）；单 queue `marketdata-sync`，concurrency=1；6 个 per-dimension named job；`retryMax`→BullMQ `attempts`；依赖 = FlowProducer 按 `sync_dependency` 现场组 flow，hard=`failParentOnFailure` / soft=`ignoreDependencyOnFailure` |

**Redis 角色铁律**：Redis 只是执行队列，**不是调度真相** —— job 丢失（驱逐/宕机）由 PG 真相层下轮 tick 发现未跑、重新入队，可自愈。为此 prod compose 改 `maxmemory-policy allkeys-lru → noeviction` + 加 `appendfsync everysec`（AOF 已开）。

### 2. misfire ≠ backfill（语义切分）

`fire-now` 只拉起「本该跑的那一次」（delta 模式拉当天）；宕机多天的历史缺口是**数据问题不是调度问题**，走 backfill CLI 手动补。理由：理杏仁真实配额未实测（短窗 ~15 调用即 429 有观察记录），自动多天 backfill 有烧爆配额风险。`skip-to-next` 策略仅推进不补跑。

### 3. 跨周期依赖语义

依赖边**只约束同一 tick 内共同触发的维度**：universe（周一）不 due 的日子，`universe→eod_bar` 边自动失效，eod_bar 当 flow 根照跑；共同触发日边生效（bar 等 universe）。种子边：`universe→*` 全 **soft**（误配 hard = universe 缺席日下游全不跑，最高风险项，专项 IT 拦）；`profile→fundamental` **hard**（fsType 路由依赖）。

### 4. 锁与互斥的退役路径

调度正确性 = 条件 UPDATE（主防线）+ queue concurrency=1；CLI 改「入队 + `waitUntilFinished`」（保退出码语义）与自动 job 同 queue 天然互斥。Redis 调度锁（`EOD_SYNC_LOCK_KEY`）仅过渡期保留，随旧 22:00 调度器在最后清退片下线。

### 5. 明确拒绝项（留痕防回潮）

| 拒绝项                            | 理由                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Temporal                          | 自托管 Server +3~5 容器，2c2g 单人项目运维过重；为多团队长事务设计                                                                |
| pg-boss                           | 难点（依赖编排）没买到照样自研，NestJS 集成社区拼盘（主流 wrapper 2025-08 停维）                                                  |
| 自研 Quartz-lite 执行层           | ~500 行重复造 BullMQ 验证多年的轮子；与生态收敛方向相反；盘中实时来时两套执行机制并存                                             |
| graphile-worker                   | 无依赖编排，诉求直接不满足                                                                                                        |
| per-instrument job（5400 job/天） | 限频器（进程内双窗令牌桶）封顶吞吐，细粒度 job 零收益徒增 Redis 压力；per-instrument try/catch + failedTargets + 幂等已给单标隔离 |
| `@nestjs/bullmq` 装饰器 wrapper   | 多一层魔法，与仓库手控 provider 风格（RedisSyncLock 先例）异质                                                                    |
| BullMQ rate limiter               | 单窗表达不了「36/s 且 1000/min」双窗约束（也表达不了富途 shim 的滚动窗），保留传输层 `VendorRateLimiter`                          |
| Inngest / trigger.dev 等 SaaS     | API 端点海外，国内生产不可靠                                                                                                      |

## Consequences

- ✅ 调度状态可恢复（PG）、维度失败隔离（per-job）、依赖编排（软/硬边）、延迟/手动/级联触发（BullMQ + trigger CLI `--cascade`）、`retryMax` 终获消费者。
- ✅ 渐进迁移：7 片 PR（设计文档 §H4），旧 22:00 管线过渡期不下线，灰度 flag `MARKETDATA_TICK_ENABLED` 控切换；唯一不可逆片（清退旧调度器）放最后且建议人工合并。
- ⚠️ 新依赖 `bullmq`；Redis `noeviction` 下内存满拒写 → 须 `removeOnComplete/removeOnFail` 限 job 留存 + 确认 quote 缓存 TTL + 监控内存。
- ⚠️ SyncRun 改 per-dimension 粒度（`syncType='sync:<dim>'`），与旧 `'eod-sync'` 聚合行过渡期并存；审计真相 = SyncRun（PG），执行/重试真相 = BullMQ job（Redis）。
- 实施走 SDD feature 017，以本 ADR + 设计文档 §H 为输入。
