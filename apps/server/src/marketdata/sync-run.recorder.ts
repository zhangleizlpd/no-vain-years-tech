import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../security/prisma.service.js';
import type { DimensionTriggeredBy } from './marketdata-sync.queue.js';

/**
 * 一条 **finding** —— 本轮执行里「计数表达不了、但人需要看到」的一件事 (#209)。
 *
 * ## 为什么它有 `kind` 而不是随手 push 一个字面量
 *
 * 这条通道 #209 前叫 `failedTargets`, 而它装的东西里**非失败的形态比失败的还多样**: 跳过原因、
 * 打断判据、硬门拒绝、财报改期……读侧于是只能 `dump` 原文 400 字, 分不出「本轮拒了几条」
 * 和「本轮失败了几个标的」。加上判别字段后, 读侧才有可能按 kind 聚合 —— 那正是 #198 / #199
 * 的判据要的输入。
 *
 * 🚨 **值域的单一来源就是本类型**, DB 侧无 enum / CHECK (同 `SyncRunStatus` 的取舍: 加一个
 * kind 零 migration)。新增 kind 时**先在这里加**, 再去改写入点 —— 反过来会得到一个读侧
 * 不认识的字符串, 而 JSON 列不会为此报错。
 */
export type SyncRunFinding =
  /**
   * 一个目标在某一步失败了 (续跑 / 重试的来源)。
   *
   * 🚨 **本 kind 不蕴含「计入 `stats.failed`」** —— 计不计数是写入点自己的决定, 两者刻意解耦。
   * 反例已在仓里: `appendIvHistoryIncrement` (#215) 是监控侧原料, 失败留痕但**不改判**本轮,
   * 否则日更会因为一条辅助数据变 `partial`。把计数绑进 kind 的定义, 下一个这样的写入点就只能
   * 去挑一个语义不对的 kind。
   */
  | { kind: 'failure'; symbol: string; step: string; error: string }
  /**
   * 落库前硬门拒了若干行, 行**不入库**。🚫 **不计 `failed`** —— 那个计数的粒度是「标的」,
   * 用它记行级拒绝会把一票里的一条脏行说成整票失败并触发降级告警。
   */
  | {
      kind: 'reject';
      symbol: string;
      step: string;
      rejected: number;
      contracts: string[];
      /**
       * 撞了哪几条门 (#198 / #212) —— **去重聚合而非逐合约**, 故与 `contracts` 不等长、
       * 不同序, 两者 MUST NOT 按下标配对。批量拒绝时分不出「哪张合约撞哪条门」是知情的代价;
       * 单行拒绝 (us:CPB 那种) 两者等价。
       */
      violations: string[];
      /**
       * 每条门一条**带数字**的样本 (`<contractCode>: <reason>`, #261) —— 与 `violations`
       * 同序等长, **可**按下标配对 (与上面 `contracts` 的不可配对刻意相反)。
       *
       * 🚨 码解决「撞的是哪条门」, 样本解决「差多少」。两个假设修法方向相反时判据就是那个数:
       * 2026-08-27 夜 hk:00700 四张深实值 PUT 撞 `ask_below_intrinsic`, 要判的是「容差 0.05
       * 是绝对值、对港股价格尺度太紧」还是「该市场 ask 侧本就机械占位」—— 前者收紧、后者放行。
       * 而 ask 离内在价值差多少此前只在 ERROR 文案里, 日志只进容器 stdout (30MB 环, 无投递)
       * ⇒ 事后不可判, 只剩一个 code。
       *
       * 📌 逐 code 一条而非逐合约: 行数封顶 = 门的条数, 不随批量拒绝规模增长。
       */
      violationSamples: string[];
    }
  /** 本轮被 freshness gate 跳过 (审计痕, 非失败语义)。 */
  | { kind: 'skip'; reason: string }
  /** 上一 attempt 未收尾, 被收敛成 `interrupted` (#137)。 */
  | { kind: 'interrupt'; reason: string }
  /**
   * 非失败但值得人看的观察 —— 载荷各异故统一收进 `detail`, 不给联合开索引签名的口子
   * (开了就等于没有类型)。今天的两个实例都在 `sync-earnings-event.usecase.ts`:
   * 标的未匹配 (「持续升高 = universe 枚举漏了一类标的」) 与财报改期 (「不是失败, 是本维度
   * 存在的理由」)。
   */
  | { kind: 'notice'; step: string; detail: Record<string, unknown> };

/** 单次同步执行的派发统计 + 本轮 findings (SyncRun 收尾写入)。 */
export interface SyncRunStats {
  scanned: number;
  ok: number;
  skipped: number;
  failed: number;
  /**
   * 本次执行**实际发生了写操作的行数** (063 Phase 3.3); `null` = 本次**没有任何写路径上报**。
   * 三态语义 + 口径 + 「为什么不是 `@default(0)`」的判据见 `schema.prisma` 的 `SyncRun.written` 注释。
   *
   * 🚨 累加必须走 {@link addWritten}, **别直接 `+=`** —— `null + 1` 在 TS 里过不了、在 JS 里
   * 是 1 看着还对, 而 `stats.written! += n` 会把 null 起点变成 NaN 且一路不报错。
   */
  written: number | null;
  /**
   * 本轮**值得人看的明细** —— 落 `sync_run.findings` (#209 前叫 `failedTargets` / `failed_targets`,
   * 旧列已于 contract 步 drop; 改名理由见 {@link SyncRunFinding} 与 schema 上的列注释)。
   *
   * 🚨 **不是「失败清单」**: `failure` 只是五种 kind 之一, 其余四种所在的行往往恒为 `success`。
   */
  findings: SyncRunFinding[];
}

/**
 * SyncRun 终态值域。`interrupted` (#137) 是**基建打断**, 与 `failed` (业务/vendor 失败)
 * 刻意分开 —— 被换容器打断的那一轮由 BullMQ stalled 接管重跑, 把它记成失败会污染失败率。
 * 业内同一取舍: Nomad 的 `lost` 与 `failed` 并列, Oracle Scheduler 把被打断的作业记
 * `STOPPED` 而非 `FAILED`; K8s 的 `podFailurePolicy` 更进一步, 让基建打断**不计入**重试预算。
 *
 * 🚨 `interrupted` **只由收敛路径产出** ({@link SyncRunRecorder.convergeInterrupted}),
 * {@link deriveStatus} 永远不会返它 —— 它不是由计数派生的结论, 是「上一次没能自己收尾」的事后判定。
 */
export type SyncRunStatus = 'success' | 'partial' | 'failed' | 'skipped' | 'interrupted';

/**
 * `interrupted` 行落进 `findings` 的判据文本 —— **两个触发点各有各的一句**, 因为它们
 * 回答的是不同的问题:「这一轮还会不会被重跑」。查表的人只看这一列就能分辨, 不必回溯队列。
 * (以 `{kind:'interrupt'}` 落 findings, 非失败语义 —— 同 {@link SyncRunRecorder.recordSkippedWithReason}。)
 */
export const INTERRUPT_REASON = {
  /** 同 job 的下一个 attempt 开工前扫地 ⇒ **已有接管者**, 本轮的活不会丢。 */
  SUPERSEDED_BY_RETRY:
    'interrupted: 上一 attempt 未收尾 (进程被替换 / 崩溃), 同 job 已由新 attempt 接管重跑',
  /** job 重试耗尽 (含 stalled 次数超限) ⇒ **不会再有接管者**, 这一轮的活是真的没做。 */
  RETRIES_EXHAUSTED: 'interrupted: attempt 未收尾且 job 重试已耗尽 — 不会再重跑',
} as const;

/**
 * 累加**实际发生了写操作的行数** (063 Phase 3.3)。第一次上报把 `null` 抬成数, 之后累加 ——
 * 「上报了 0 行」与「一次都没上报」因此在终值上可分辨, 而这正是本列存在的理由。
 *
 * ## 口径只有一条, 全维度统一 (#138 定): **「这一行发生了写吗」**
 *
 *   · `createMany(skipDuplicates)` 段传它报的 `count` —— 撞唯一键被跳过的行**没发生写**, 不计;
 *   · 逐行 `upsert` 段**按行传** —— insert 与 update 都是真的写了库。
 *
 * 🚨 盲区写在明处: upsert 段分辨不出「覆盖了但内容没变」⇒ 逐行 upsert 的维度 (hot_snapshot /
 * fundamental delta 等) 稳态恒等于当轮拿到的行数。它抓得到的是「vendor 整轮返空」= 0。要连
 * 「写了但没变」都分辨, 得走 PG `ON CONFLICT … RETURNING (xmax = 0)`, 代价是这些写路径全改
 * `$queryRaw` —— 2026-08-22 权衡后**明确不做**, 别当遗漏。
 *
 * 🚨 有写路径的维度**必须起手 `addWritten(stats, 0)` 声明一次** —— 否则「工作集为空 / vendor
 * 零行」的一轮会停在 `null`, 与「这个维度压根没接线」不可分辨, 而那正是 #138 的病根。
 */
export function addWritten(stats: SyncRunStats, rows: number): void {
  stats.written = (stats.written ?? 0) + rows;
}

/** 空统计起点 (调用方累加)。 */
export function emptyStats(): SyncRunStats {
  return { scanned: 0, ok: 0, skipped: 0, failed: 0, written: null, findings: [] };
}

/**
 * 一行 `SyncRun` 的**来历** —— 谁触发的 / 采的哪一天 / 回链哪个 BullMQ job (#202 + 017)。
 *
 * 🚨 三个字段**全可缺省, 且缺省即 NULL, 不替调用方猜**。`triggered_by` 若给个 `'tick'` 兜底,
 * 漏传的路径就会冒充成「这个维度按计划跑过的一轮」被 #146 Phase 2 / #199 的计数器吃进去 ——
 * 判据的输入被污染了还全绿。判据侧的对偶约定: NULL 行**既不计一轮、也不打断 streak**。
 */
export interface SyncRunOrigin {
  /** per-dim worker 路径回链 (017)。 */
  bullJobId?: string;
  /** 触发源。**只有 `'tick'` 算「按计划跑的一轮」**, 其余都是按需执行 (#202)。 */
  triggeredBy?: DimensionTriggeredBy;
  /** 本轮的业务日 `YYYY-MM-DD` —— 该维度自己的 `asOf` (交易所口径), 不是执行时刻的日期。 */
  asOf?: string;
}

/**
 * 业务日 `YYYY-MM-DD` → `@db.Date` 列要的 `Date`。
 *
 * 🚨 **显式补 `T00:00:00Z`**: 裸 `new Date('2026-08-26T00:00:00')` 按**本机**时区解析, 宿主
 * 时区一换整列就漂一天; 而 `@db.Date` 读出来本就是 UTC 午夜 (跨时区日期语义 §3)。
 */
function businessDayToDate(asOf: string): Date {
  return new Date(`${asOf}T00:00:00Z`);
}

/**
 * SyncRunRecorder (016 T004, FR-S17): SyncRun 行生命周期 — 开 (running) / 收
 * (success|partial|failed|skipped + 计数 + findings + finishedAt)。贫血 prisma row
 * 写 marketdata.sync_run (R1 自有表)。每次同步执行落一行, 是审计 + DLQ-lite + 水位载体。
 *
 * `finalStatus` 由计数派生 (FR-S17 log-based alerting 入口): failed>0 但 ok>0 → partial;
 * 全 failed → failed; 否则 success。skipped (非交易日) 由调用方显式传, 不经派生。
 */
@Injectable()
export class SyncRunRecorder {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 开一行 running SyncRun, 返 id (后续 finish 引用)。`origin` 见 {@link SyncRunOrigin} ——
   * 缺省的字段一律留 NULL (**不猜**), 判据侧据此把这一行当「不知道来历」而非「按计划的一轮」。
   */
  async start(syncType: string, origin: SyncRunOrigin = {}): Promise<bigint> {
    const run = await this.prisma.syncRun.create({
      data: {
        syncType,
        status: 'running',
        ...(origin.bullJobId ? { bullJobId: origin.bullJobId } : {}),
        ...(origin.triggeredBy ? { triggeredBy: origin.triggeredBy } : {}),
        ...(origin.asOf ? { asOf: businessDayToDate(origin.asOf) } : {}),
      },
      select: { id: true },
    });
    return run.id;
  }

  /**
   * 把同一 BullMQ job 上**没能自己收尾的 attempt** 收成 `interrupted` 终态 (#137), 返收敛行数。
   *
   * ## 判据是确定性的, 不靠任何时间阈值
   *
   * BullMQ 的 job lock 保证同一 `jobId` 任一时刻只被一个 worker 处理 ⇒「同 `bull_job_id` 还
   * 挂着 `running`」只可能是**被打断的上一次 attempt**, 不可能是活着的并发者。业内那些通用
   * 调度器 (Airflow 心跳超时 / Temporal Heartbeat Timeout) 只能用「多久没心跳就算死」这类概率
   * 判据, 是因为它们的执行体可能并发多实例; 本仓有 lock 互斥 + `bull_job_id` 恒非空 (见
   * `DimensionExecutorRegistry.execute` 注释), 故可以做到零阈值、零心跳。
   *
   * 🚨 **调用点必须在新行 INSERT 之前** —— 那是「绝不误伤自己」的全部依据, 顺序反了就会把刚
   * 开的那一行当僵尸收掉。两个调用点都在 `marketdata-sync.worker.ts`（BullMQ attempt 是它的
   * 领域知识, 不是 executor 的), 判据见那里。
   *
   * 🚨 `finishedAt` 记的是**收敛时刻, 不是被打断的时刻** —— 真正断在哪一秒没有任何人记得下来
   * (进程当时已经没了)。⇒ `interrupted` 行的 `finished_at - started_at` **不是耗时**: app 停机
   * 几天再起, 它就是几天。任何耗时统计必须把本终态排除掉 —— 而「能被排除」正是它独立成一个
   * 终态、而不是复用 `failed` 的收益所在。
   */
  async convergeInterrupted(
    bullJobId: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<number> {
    const { count } = await this.prisma.syncRun.updateMany({
      where: { bullJobId, status: 'running' },
      data: {
        status: 'interrupted',
        finishedAt: now,
        // 未收尾的行两列恒为 NULL ⇒ 这里是首写, 不会盖掉任何既有明细。
        findings: [{ kind: 'interrupt', reason }] as Prisma.InputJsonValue,
      },
    });
    return count;
  }

  /**
   * 收尾: 写终态 + 计数 + findings(Json) + finishedAt。
   *
   * 🚨 **只写 `findings`** —— #209 三步法已走完, 旧列 `failed_targets` 已 drop
   * (contract, migration 20260827_1333)。读侧是 `ops/jobs/marketdata-sync-report.sql`。
   *
   * 🚨 **`finishedAt` 默认取真实收尾时刻, 不吃调用方的「逻辑 now」** —— 那正是这个参数
   * 曾经的塌法: `DimensionExecutorRegistry` 一直传 `ExecutorInput.now` (job **起点**),
   * 于是 `finished_at ≈ started_at`、甚至更早 (`started_at` 走 PG `now()`, 落在 JS
   * `new Date()` 之后) ⇒ **任何一轮的耗时都读不出来**。2026-08-09 在 prod 验证限频修复时
   * 撞到: 一轮实耗 241 秒的链发现, 表里两个时间戳只差 44 毫秒, 只能改从 CLI 日志掐时间。
   *
   * 仍保留可传形态是给**零工作量收尾**用的 —— {@link recordSkipped} 那条路上, 调用方的
   * `now` 就是收尾时刻 (中间没有任何工作), 传进来比再取一次时钟更诚实。
   */
  async finish(
    id: bigint,
    status: SyncRunStatus,
    stats: SyncRunStats,
    finishedAt: Date = new Date(),
  ): Promise<void> {
    // 空数组落 JsonNull 而非 `[]`: 同 `written` 的三态判据 —— 「确实没有」与「没上报过」
    // 别长成一个样。
    //
    // 🚨 注意它落的是 **JSON 标量 `null`** 而非 SQL NULL ⇒ 消费方**不能**用 `findings IS NOT NULL`
    // 判「有没有明细」(prod 实测 749 行如此, 会被全数误判为有)。正确谓词是
    // `jsonb_typeof(findings) = 'array'`, 见 `ops/jobs/marketdata-sync-report.sql` 的 MUST ②。
    const payload: Prisma.InputJsonValue | typeof Prisma.JsonNull =
      stats.findings.length > 0
        ? (stats.findings as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull;
    await this.prisma.syncRun.update({
      where: { id },
      data: {
        status,
        scanned: stats.scanned,
        ok: stats.ok,
        skipped: stats.skipped,
        failed: stats.failed,
        written: stats.written,
        findings: payload,
        finishedAt,
      },
    });
  }

  /** 非交易日短路: 开一行 running 立即收为 skipped (零 vendor 调用, FR-S02)。 */
  async recordSkipped(syncType: string, now: Date, origin: SyncRunOrigin = {}): Promise<bigint> {
    const id = await this.start(syncType, origin);
    await this.finish(id, 'skipped', emptyStats(), now);
    return id;
  }

  /**
   * freshness gate 跳过 (019 T014, FR-S03 审计痕): skipped 行 + 跳过原因
   * (`findings` 列承载 `[{kind:'skip', reason}]` — 非失败语义, 见 {@link SyncRunFinding})。
   */
  async recordSkippedWithReason(
    syncType: string,
    reason: string,
    now: Date,
    origin: SyncRunOrigin = {},
  ): Promise<bigint> {
    const id = await this.start(syncType, origin);
    await this.finish(
      id,
      'skipped',
      { ...emptyStats(), findings: [{ kind: 'skip', reason }] },
      now,
    );
    return id;
  }
}

/** 计数 → 终态派生 (skipped 由调用方显式, 不入此)。 */
export function deriveStatus(stats: SyncRunStats): SyncRunStatus {
  if (stats.failed === 0) return 'success';
  if (stats.ok > 0 || stats.skipped > 0) return 'partial';
  return 'failed';
}
