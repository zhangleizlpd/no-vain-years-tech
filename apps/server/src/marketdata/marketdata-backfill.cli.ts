import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { QueueEvents, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { AppModule } from '../app/app.module.js';
import { marketdataSyncConfig, type MarketdataSyncConfig } from '../config/marketdata.config.js';
import { PrismaService } from '../security/prisma.service.js';
import { anchorFactorsForInstrument } from './anchor-factors.js';
import { DIMENSION_KEYS, subtractDays, type DimensionKey } from './dimension-executor.js';
import { splitBackfillWindows } from './underlying-iv.rules.js';
import { VOLATILITY_WINDOWS } from './lixinger-volatility.adapter.js';
import { MARKETDATA_QUEUE_REDIS } from './marketdata-queue-connection.js';
import {
  MARKETDATA_SYNC_QUEUE,
  MARKETDATA_WORKER_DISABLED,
  MarketdataSyncQueue,
} from './marketdata-sync.worker.js';
import { waitJobExitCode } from './marketdata-trigger.cli.js';
import {
  assembleSyncFlow,
  deriveExecutionOrder,
  type SyncDependencyEdge,
} from './sync-flow-assembler.js';
import { shanghaiToday } from './trading-day-gate.js';

/**
 * Backfill CLI (016 T017 → 017 T018 迁入队, FR-S15): 一次性历史回填运维命令。
 *
 * **017 迁入队形态**: 非 dry-run 段不抢分布式锁 (016 旧锁互斥已随 PR-7 清退) — 改入队 +
 * `waitUntilFinished`, 与自动 job 同 queue concurrency=1 **天然互斥** (取代锁互斥语义)。
 * **CLI 永不起 worker** (clarify Q2, plan D6): entry 前置 sentinel, server 不在线 →
 * 等待超时退出码 2 + 可操作错误信息。
 *
 * `--dimension` 转 functional (017 T018 裁决, 016 时仅进日志): 给定 → 单维度 job
 * (配额分批回填场景不烧全维度); 缺省 → 全 6 维度组 flow (贴旧全管线行为)。
 *
 * 退出码: 0 成功 / 1 job 失败或 partial / **2 = 等待超时** (旧 2=锁未抢到 → 锁退出
 * CLI 路径, 重映射 per analyze I1, release note 须提)。
 *
 * `--dry-run` 仅打印将拉取的 vendor 请求数估算 (D5 防一条命令打爆配额, **无声截断禁止**),
 * 不入队不写库。深度回填 (10yr) 须显式 `--history-depth` opt-in (默认浅回填)。
 */

export interface BackfillArgs {
  dimension?: DimensionKey;
  historyDepth?: number;
  dryRun: boolean;
  markets: string[];
  /** 以此 `YYYY-MM-DD` 为「今天」(backfill 区间终点; D9: gate 归 tick 层, 运维指向已结算交易日)。 */
  asOf?: string;
  /** 等待 job 终态上限 ms (默认 config `cliWaitTimeoutMs`)。 */
  timeoutMs?: number;
  /** 020 T009: 因子链冷启动回填 — DB none 行 + vendor backward transient 锚全部事件, 不入队。 */
  factors?: boolean;
  /**
   * force-refetch: 绕过 backfill skip-complete 游标 (fundamental) — 老端已覆盖股也重拉重写。
   * 补中段缺口场景 (如 044 日历停摆致某日缺行), skipDuplicates 兜已存只写缺日。
   */
  noSkipComplete?: boolean;
}

/** 解析 argv: `--dimension eod_bar --history-depth 3650 --dry-run --markets cn,hk --as-of 2026-06-02 --timeout 5000 --no-skip-complete | --factors`。 */
export function parseBackfillArgs(argv: string[]): BackfillArgs {
  const args: BackfillArgs = { dryRun: false, markets: ['cn'] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--factors') args.factors = true;
    else if (a === '--no-skip-complete') args.noSkipComplete = true;
    else if (a === '--dimension') args.dimension = argv[++i] as DimensionKey;
    else if (a === '--history-depth') args.historyDepth = Number(argv[++i]);
    else if (a === '--markets') args.markets = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--as-of') args.asOf = argv[++i];
    else if (a === '--timeout') args.timeoutMs = Number(argv[++i]);
  }
  // 维度键校验源 = 注册表 keys (019 T004; 执行序与值域解耦, 全序常量 T005 退役)。
  if (args.dimension !== undefined && !DIMENSION_KEYS.includes(args.dimension)) {
    throw new Error(`未知维度键 "${args.dimension}" (值域: ${DIMENSION_KEYS.join(',')})`);
  }
  // --factors 是因子链回填模式 (不组维度 job) — 与 --dimension 互斥防误用。
  if (args.factors && args.dimension !== undefined) {
    throw new Error('--factors 与 --dimension 互斥 (因子回填不组维度 job)');
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error('--timeout 须为正整数 ms');
  }
  return args;
}

export interface BackfillDeps {
  prisma: PrismaService;
  /** `--factors` transient 锚定的 vendor backward 源 (020 T009)。 */
  syncQueue: MarketdataSyncQueue;
  queueEvents: QueueEvents;
  cliWaitTimeoutMs: number;
  backfillDefaultHistoryDays: number;
}

/** backfill 编排: dry-run 估算 / 入队 (单维度 job 或全维度 flow) → 等终态退出码 0/1/2。 */
export async function executeBackfill(
  deps: BackfillDeps,
  args: BackfillArgs,
  now: Date,
  logger: Logger = new Logger('marketdata-backfill'),
): Promise<number> {
  // 020 T009 因子链冷启动回填: DB none 行 + vendor backward transient 锚全部事件,
  // 不入队 — 与维度 job 路径完全分离。
  // 🚨 `args.dryRun` **必须一路传下去**: 本分支 return 在下面通用 dry-run 闸 (`:128`) 之前,
  // 漏传 = `--factors --dry-run` 静默变成真跑全量回填。运维敲 `--dry-run` 恰恰是为了求稳,
  // 却触发真操作 —— 且 factors 路径本就不打 `backfill plan` 日志, 表面看不出来。
  if (args.factors) return rebuildFactorChains(deps.prisma, logger, args.dryRun);

  const historyDepth = args.historyDepth ?? deps.backfillDefaultHistoryDays;
  // `--as-of` 指定结算日为「今天」(backfill 区间终点; 当天 EOD 未就绪时运维须指向已结算
  // 交易日 — CLI 路径无交易日 gate, D9 运维显式意图)。默认上海时区当天。
  const asOf = args.asOf ?? shanghaiToday(now);
  // 046 T009: `underlying_iv_daily` 的页数由回填区间决定 ⇒ 估算必须拿到区间, 不能只看维度键。
  const estimate = await estimateRequests(deps.prisma, args.markets, args.dimension, {
    from: subtractDays(asOf, historyDepth),
    to: asOf,
  });
  logger.log(
    `backfill plan: ${JSON.stringify({
      dimension: args.dimension ?? 'all',
      markets: args.markets,
      historyDepthDays: historyDepth,
      asOf,
      estVendorRequests: estimate,
      dryRun: args.dryRun,
    })}`,
  );

  // dry-run: 仅打印计划 (无声截断禁止), 不入队不写库。
  if (args.dryRun) return 0;

  // won 集: --dimension 单维度 / 缺省全 6 维度 (贴旧全管线行为; 键全集源 = 注册表 keys,
  // 执行序由 flow 装配器按依赖边排, 此处只定集合)。retryMax 从真相层载。
  const keys = args.dimension ? [args.dimension] : [...DIMENSION_KEYS];
  const rows = await deps.prisma.syncDimension.findMany({
    where: { dimensionKey: { in: keys } },
    select: { dimensionKey: true, retryMax: true },
  });
  const retryByKey = new Map(rows.map((r) => [r.dimensionKey, r.retryMax]));
  const missing = keys.filter((k) => !retryByKey.has(k));
  if (missing.length > 0) {
    throw new Error(`sync_dimension 缺行: ${missing.join(',')} (seed 残缺或维度未登记)`);
  }

  const payload = (key: DimensionKey) => ({
    dimensionKey: key,
    mode: 'backfill' as const,
    asOf,
    backfillHistoryDays: historyDepth,
    markets: args.markets, // 038 seam#3: --markets 透传 → executor 工作集与 marketScope 取交集。
    noSkipComplete: args.noSkipComplete, // force-refetch: 绕过 fundamental skip-complete 游标。
    triggeredBy: 'cli' as const,
  });
  let job: Job;
  if (keys.length > 1) {
    // 全维度组 flow (D3 装配器, seed 边语义与 tick 同源), 等待树根 = 整链终态。
    const edges = (await deps.prisma.syncDependency.findMany({
      select: { upstream: true, downstream: true, mode: true },
    })) as SyncDependencyEdge[];
    // 全序派生与 tick 同源 (019 T005): 全维度行 priority + 边 → Kahn。
    const priorities = await deps.prisma.syncDimension.findMany({
      select: { dimensionKey: true, priority: true },
    });
    const executionOrder = deriveExecutionOrder(
      edges,
      new Map(priorities.map((p) => [p.dimensionKey, p.priority])),
    );
    const tree = assembleSyncFlow(
      keys.map((k) => ({
        payload: payload(k as DimensionKey),
        opts: deps.syncQueue.jobOpts({ retryMax: retryByKey.get(k) as number }),
      })),
      edges,
      executionOrder,
    );
    job = (await deps.syncQueue.enqueueFlow(tree)).job;
  } else {
    job = await deps.syncQueue.enqueueDimensionJob(payload(keys[0] as DimensionKey), {
      retryMax: retryByKey.get(keys[0] as string) as number,
    });
  }
  return waitJobExitCode(job, deps.queueEvents, args.timeoutMs ?? deps.cliWaitTimeoutMs, logger);
}

/**
 * 因子链全量重算 (020 T009 起; 2026-08-01 换口径): per 有除权史标的 — 四张本地表
 * (none 日线 / 公司行动 / 股本变动 / 配股) → 事件条款法 + 涨跌幅复权法 2-of-2 判定 →
 * upsert (幂等, 写 factorBackward + source + status)。零除权史 / 无 none 基底 → 跳过
 * (后者先跑 eod backfill 补齐再重跑)。单标的失败 WARN 续跑, 有失败退出码 1 (partial)。
 * 复杂度 O(标的数 × (bar 数 + 事件数·log))。
 *
 * 🚨 **本命令已零 vendor 外呼** —— 旧口径必须拉 vendor backward 序列反推跃变, 因而受
 * 「拉多长窗口」摆布 (理杏仁 `bc_rights` 是仿射 `bc = K·ex − C`, C≠0 且随窗内事件数
 * 累积 ⇒ 全史窗下比值口径彻底失真, 00206 算出 2.0373 vs 真值 1.0444; 见 PR #764)。
 * 换成事件条款法后输入全在本地库, 故本命令改回**全史重锚**: 不再有正确性代价, 且正是
 * 把存量 `legacy_vendor_anchor` 行洗干净的手段。附带效果: 不受 vendor 限频/熔断约束。
 *
 * `dryRun` = 只按**与真跑同口径**的三道过滤算规模并打印, 零写库。
 */
export async function rebuildFactorChains(
  prisma: PrismaService,
  logger: Logger = new Logger('marketdata-backfill'),
  dryRun = false,
): Promise<number> {
  // 采集闸 (`Instrument.needSync`) 与 loadActiveInstruments 同口径: 不采的标的不需要因子链。
  // 无 market 过滤是刻意的 (因子链与市场无关), 故这里靠 needSync 收窄 —— 否则 us universe
  // 全量在库后, 本循环会对上万只不采的标的空转。
  const scanScope = { status: 'active', needSync: true } as const;

  if (dryRun) {
    // 🚨 估算口径 = 下面真跑循环的**三道过滤逐条对应**, 顺序与语义都一一映射:
    //   `scanScope`                        ←→ findMany 的 where (扫描面)
    //   `corporateActions: { some: {} }`   ←→ `exRows.length === 0 → skipped` (无除权史零外呼)
    //   `dailyBars: { some: adjust none }` ←→ `noneRows.length === 0 → skipped` (无 none 基底零外呼)
    // 任何一条漂移都会让「预演数字」骗人。#754 已经栽过一次 (估算未按 needSync 收窄 →
    // `--dimension us_equity_bar` 报 350,760 而实跑 7)，同一根神经不再踩第二遍。
    const scanned = await prisma.instrument.count({ where: scanScope });
    const estInstruments = await prisma.instrument.count({
      where: {
        ...scanScope,
        corporateActions: { some: {} },
        dailyBars: { some: { adjust: 'none' } },
      },
    });
    // 🚨 字段名是 `estInstruments` 而**不是** `estVendorRequests`: 换事件条款法后本命令
    // 零 vendor 外呼, 再报「vendor 请求数」就是骗执行方 —— 运维看到 0 会以为命令没生效,
    // 看到 8000 会以为要烧配额, 两种误读都会让人做错决定。数字换了含义就必须换名字。
    logger.log(
      `factors dry-run (不入队不写库, 零 vendor 外呼 — 纯本地重算): ${JSON.stringify({
        scanned,
        estInstruments,
        skipped: scanned - estInstruments,
      })}`,
    );
    return 0;
  }

  const instruments = await prisma.instrument.findMany({
    where: scanScope,
    select: { id: true, market: true, code: true },
    orderBy: { id: 'asc' },
  });
  let anchored = 0;
  let needsReview = 0;
  let skipped = 0;
  let failed = 0;
  for (const inst of instruments) {
    const [exCount, noneCount] = await Promise.all([
      prisma.corporateAction.count({ where: { instrumentId: inst.id } }),
      prisma.dailyBar.count({ where: { instrumentId: inst.id, adjust: 'none' } }),
    ]);
    // 无除权史 → 无事件可锚 (读时换算按 1, spec edge case 新上市);
    // 无 none 基底 (冷启动顺序倒置) → 无价格基准, 补齐后重跑幂等补锚。
    if (exCount === 0 || noneCount === 0) {
      skipped++;
      continue;
    }
    const symbol = `${inst.market}:${inst.code}`;
    try {
      // fromExDate=null = 全史重锚。旧口径下「全史」正是灾难源 (vendor 仿射复权序列的
      // 截距随窗内事件数累积 → 比值失真, PR #764); 换成事件条款法后输入全在本地库,
      // 全史重锚不再有正确性代价, 反而是把存量 legacy_vendor_anchor 行洗干净的手段。
      const r = await anchorFactorsForInstrument(prisma, {
        instrumentId: inst.id,
        fromExDate: null,
      });
      anchored += r.anchored;
      needsReview += r.needsReview;
    } catch (err) {
      failed++; // 单标的失败不阻塞全量 (重跑幂等补锚)。
      logger.warn(`factors 锚定失败 (重跑补锚): ${JSON.stringify({ symbol, error: String(err) })}`);
    }
  }
  logger.log(
    `factors 回填完成: ${JSON.stringify({
      instruments: instruments.length,
      anchored,
      needsReview,
      skipped,
      failed,
    })}`,
  );
  return failed > 0 ? 1 : 0;
}

/**
 * 039 港股量化 5 维度: 均**每标的单次** vendor 调用 (short_selling/connect_holding 日频区间、
 * fund_holding/fund_company_holding 报告期区间一次覆盖整深度、index_membership 快照一次) →
 * 各 active × 1。列此显式子集 (非从 DIMENSION_KEYS 派生), 因前 6 维估算模型不同 (区间×复权 /
 * 批量 / per-instrument), 只有这 5 个是「per-stock 单次」类。
 */
const QUANT_SIGNAL_DIMENSIONS: readonly DimensionKey[] = [
  'short_selling',
  'connect_holding',
  'fund_holding',
  'fund_company_holding',
  'index_membership',
];

/**
 * 041 港股事件流 4 维度: 均**每标的单次**区间 vendor 调用 (buyback/equity_change/
 * shareholder_change/allotment 各按 [asOf−historyDepth, asOf] 一次覆盖整深度) → 各 active × 1。
 * 与 QUANT_SIGNAL_DIMENSIONS 同「per-stock 单次区间」类, 列此显式子集 (非从 DIMENSION_KEYS 派生,
 * 因前 6 维估算模型不同)。4 维 history_depth=3650 均可回填历史。
 */
const CORPORATE_EVENT_DIMENSIONS: readonly DimensionKey[] = [
  'buyback',
  'equity_change',
  'shareholder_change',
  'allotment',
];

/**
 * 042 港股报告期 3 维度: 均**每标的单次**区间 vendor 调用 (revenue_segment/
 * shareholder_snapshot/employee 各按 [asOf−historyDepth, asOf] 一次覆盖整深度) → 各 active × 1。
 * 与 QUANT_SIGNAL_DIMENSIONS / CORPORATE_EVENT_DIMENSIONS 同「per-stock 单次区间」类, 列此显式
 * 子集 (非从 DIMENSION_KEYS 派生, 因前 6 维估算模型不同)。3 维 history_depth=3650 均可回填历史。
 */
const REPORTING_PERIOD_DIMENSIONS: readonly DimensionKey[] = [
  'revenue_segment',
  'shareholder_snapshot',
  'employee',
];

/**
 * 043 港股分类文本: **announcement 仅此一维计入回填估算** —— per-instrument 单次区间调用
 * (按 [asOf−historyDepth, asOf] 一次覆盖整深度, history_depth=3650 可回填历史) → active × 1。
 * **industry_classification 恒不计入**: 覆盖式快照 (history_depth=NULL), 无历史回填区间 —— 同
 * hot_snapshot 处理, 靠夜频/delta 每日拉当前快照整体覆盖, 不经 backfill 历史区间估算。列此显式
 * 子集 (非从 DIMENSION_KEYS 派生, 因前维估算模型不同)。
 */
const CLASSIFICATION_TEXT_DIMENSIONS: readonly DimensionKey[] = ['announcement'];

/**
 * 「per-instrument 单次区间调用」类维度的合集 —— 估算时每标的记 1 次请求。
 * 与上面四个显式子集同源, 只是把它们摊平供 `estimateRequests` 逐维度查表。
 */
const PER_INSTRUMENT_RANGE_DIMENSIONS: readonly DimensionKey[] = [
  'corporate_action',
  ...QUANT_SIGNAL_DIMENSIONS,
  ...CORPORATE_EVENT_DIMENSIONS,
  ...REPORTING_PERIOD_DIMENSIONS,
  ...CLASSIFICATION_TEXT_DIMENSIONS,
];

/**
 * 估算 vendor 请求数 (D5)。candlestick 是**区间**调用 (一次覆盖整 historyDepth) → eod 请求数
 * = 标的数 × 复权口径数 (不随回填深度膨胀); fundamental/financial 批量; corp per-instrument;
 * 039 5 量化维度各 per-instrument 单次 (见 QUANT_SIGNAL_DIMENSIONS)。
 *
 * **040 volatility** (per-instrument × VOLATILITY_WINDOWS 多窗口, 每窗口一次区间调用) →
 * active × 窗口数 (回填 3× 请求数, plan Decision 4)。**hot_snapshot 不计入**: 快照非历史回填
 * (history_depth=NULL), 新鲜度靠 delta/tick 每日拉当前快照累积, 不经 backfill 历史区间估算。
 *
 * **041 事件流 4 维度** (buyback/equity_change/shareholder_change/allotment, 各 per-instrument
 * 单次区间覆盖整深度, 见 CORPORATE_EVENT_DIMENSIONS) → active × 4。
 *
 * **042 报告期 3 维度** (revenue_segment/shareholder_snapshot/employee, 各 per-instrument
 * 单次区间覆盖整深度, 见 REPORTING_PERIOD_DIMENSIONS) → active × 3。
 *
 * **043 分类文本** (announcement per-instrument 单次区间覆盖整深度, 见
 * CLASSIFICATION_TEXT_DIMENSIONS) → active × 1。**industry_classification 不计入**: 覆盖式快照
 * (history_depth=NULL), 无历史回填区间 (同 hot_snapshot 处理)。
 *
 * **046 underlying_iv_daily** —— 全表**唯一一个 per-instrument × 多页**的维度: `his_volatility`
 * 单次跨度 ≤364 天, 拉满 3 年要 4 页 ⇒ active × **页数**。套「active × 1」会低报 4 倍。
 * 🚨 页数走 {@link splitBackfillWindows} 派生, 与 executor 回填路径**同一个函数** —— 估算与执行
 * 各写一遍正是 #754 (`--dimension us_equity_bar` 报 350,760 实跑 7) 的病根。
 * **us_index_daily 不计入**: 源是覆盖式全量历史文件, 无「回填区间」概念 (同 hot_snapshot /
 * industry_classification 处理)。
 */
async function estimateRequests(
  prisma: PrismaService,
  markets: string[],
  dimension: DimensionKey | undefined,
  /** 回填闭区间 (与真跑 payload 同源: `[asOf − historyDepth, asOf]`)。 */
  range: { from: string; to: string },
): Promise<number> {
  // 🚨 **必须与执行路径同口径**: 工作集是 `loadActiveInstruments` 的
  // `{market ∈ scope, status:'active', needSync:true}` —— 漏掉 needSync 会把「入库但不采」
  // 的标的算进来 (2026-08-01 实测: us 19,465 只入库、仅 7 只开闸)。
  const active = await prisma.instrument.count({
    where: { market: { in: markets }, status: 'active', needSync: true },
  });
  const eodDim = await prisma.syncDimension.findUnique({ where: { dimensionKey: 'eod_bar' } });
  const fundDim = await prisma.syncDimension.findUnique({ where: { dimensionKey: 'fundamental' } });
  const adjustCount = eodDim && eodDim.adjustTypes.length > 0 ? eodDim.adjustTypes.length : 1;
  const batch = fundDim && fundDim.batchSize > 0 ? fundDim.batchSize : 50;

  const cost = (key: DimensionKey): number => {
    if (key === 'eod_bar') return active * adjustCount;
    if (key === 'us_equity_bar') return active; // per-instrument 单次 kline 区间调用
    if (key === 'fundamental' || key === 'financial') return Math.ceil(active / batch); // 批量
    if (key === 'volatility') return active * VOLATILITY_WINDOWS.length; // 每标的 × 窗口数
    // 046: his_volatility ≤364 天/页 ⇒ 每标的 × 页数 (页数与 executor 同源派生, 见上文注释)。
    if (key === 'underlying_iv_daily') {
      return active * splitBackfillWindows(range.from, range.to).length;
    }
    if (PER_INSTRUMENT_RANGE_DIMENSIONS.includes(key)) return active; // per-instrument 单次区间
    // universe / profile (meta, 少量枚举调用) + hot_snapshot / industry_classification /
    // us_index_daily (覆盖式快照或全量文件, 无历史回填区间) → 不计入回填估算。
    return 0;
  };

  // `--dimension` 限定单维度时**只算它** —— 否则一条安全命令会被报成整管线的量级
  // (2026-08-01 实测: `--dimension us_equity_bar` 实跑 7 次, 旧估算报 350,760)。
  if (dimension) return cost(dimension);
  return DIMENSION_KEYS.reduce((sum, key) => sum + cost(key), 0);
}

/** NestFactory 接线 entry: sentinel 前置 → 起 DI → executeBackfill → close。 */
export async function runBackfill(argv: string[]): Promise<number> {
  // D6 (clarify Q2): createApplicationContext 前置 sentinel → worker OnModuleInit no-op。
  process.env[MARKETDATA_WORKER_DISABLED] = '1';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const connection = app.get<Redis>(MARKETDATA_QUEUE_REDIS);
  const queueEvents = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection });
  try {
    const cfg = app.get<MarketdataSyncConfig>(marketdataSyncConfig.KEY);
    return await executeBackfill(
      {
        prisma: app.get(PrismaService),
        syncQueue: app.get(MarketdataSyncQueue),
        queueEvents,
        cliWaitTimeoutMs: cfg.cliWaitTimeoutMs,
        backfillDefaultHistoryDays: cfg.backfillDefaultHistoryDays,
      },
      parseBackfillArgs(argv),
      new Date(),
    );
  } finally {
    await queueEvents.close();
    await app.close();
  }
}

// entry guard: 仅 `node .../marketdata-backfill.cli.js` 直跑时执行 (import.meta 免依赖, 用
// argv[1] 文件名判定 → vitest 导入本模块测 parse/execute 时不触发 NestFactory 全量 boot)。
// 解析错误 (未知维度等) → stderr + 退出码 1。
if (process.argv[1]?.includes('marketdata-backfill')) {
  void runBackfill(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(String(err));
      process.exit(1);
    },
  );
}
