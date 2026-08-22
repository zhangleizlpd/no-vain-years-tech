import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../security/prisma.service.js';
import { anchorFactorsForInstrument } from './anchor-factors.js';
import { BackfillPacer } from './backfill-pacer.js';
import { CORPORATE_ACTION_PORT, type CorporateActionPort } from './corporate-action.port.js';
import { EOD_BAR_PORT, type EodBarPort } from './eod-bar.port.js';
import { FINANCIALS_PORT, type FinancialsPort } from './financials.port.js';
import { FUNDAMENTAL_PORT, type FundamentalPort } from './fundamental.port.js';
import { SHORT_SELLING_PORT, type ShortSellingPort } from './short-selling.port.js';
import { CONNECT_HOLDING_PORT, type ConnectHoldingPort } from './connect-holding.port.js';
import { FUND_HOLDING_PORT, type FundHoldingPort } from './fund-holding.port.js';
import {
  FUND_COMPANY_HOLDING_PORT,
  type FundCompanyHoldingPort,
} from './fund-company-holding.port.js';
import { INDEX_MEMBERSHIP_PORT, type IndexMembershipPort } from './index-membership.port.js';
import { VOLATILITY_PORT, type VolatilityPort } from './volatility.port.js';
import { VOLATILITY_WINDOWS } from './lixinger-volatility.adapter.js';
import { HOT_SNAPSHOT_PORT, type HotSnapshotPort } from './hot-snapshot.port.js';
import { HOT_TYPES } from './lixinger-hot.adapter.js';
import { BUYBACK_PORT, type BuybackPort } from './buyback.port.js';
import { EQUITY_CHANGE_PORT, type EquityChangePort } from './equity-change.port.js';
import { SHAREHOLDER_CHANGE_PORT, type ShareholderChangePort } from './shareholder-change.port.js';
import { ALLOTMENT_PORT, type AllotmentPort } from './allotment.port.js';
import { REVENUE_SEGMENT_PORT, type RevenueSegmentPort } from './revenue-segment.port.js';
import {
  SHAREHOLDER_SNAPSHOT_PORT,
  type ShareholderSnapshotPort,
} from './shareholder-snapshot.port.js';
import { EMPLOYEE_PORT, type EmployeePort } from './employee.port.js';
import {
  INDUSTRY_CLASSIFICATION_PORT,
  type IndustryClassificationPort,
} from './industry-classification.port.js';
import { ANNOUNCEMENT_PORT, type AnnouncementPort } from './announcement.port.js';
import {
  UNDERLYING_IV_PORT,
  type UnderlyingIvHistoryPoint,
  type UnderlyingIvPort,
  type UnderlyingIvSnapshot,
} from './underlying-iv.port.js';
import {
  US_INDEX_CODES,
  US_INDEX_PORT,
  type UsIndexCode,
  type UsIndexDailyPoint,
  type UsIndexPort,
} from './us-index.port.js';
import { exchangeCalendarDateForScope } from './session-clock.js';
import {
  classifyIvpDivergence,
  computeIvPercentile,
  HIS_VOLATILITY_MAX_SPAN_DAYS,
  IVP_MIN_WINDOW_TRADING_DAYS,
  splitBackfillWindows,
} from './underlying-iv.rules.js';
import type { EodBarPoint, FundamentalSnapshotDto } from './marketdata.types.js';
import {
  addWritten,
  deriveStatus,
  emptyStats,
  SyncRunRecorder,
  type SyncRunStats,
} from './sync-run.recorder.js';
import { SyncProfileUseCase } from './sync-profile.usecase.js';
import { SyncTierRecalc } from './sync-tier-recalc.js';
import { AnchorDrivenSyncGate } from './anchor-driven-sync-gate.js';
import { SyncUniverseUseCase } from './sync-universe.usecase.js';
import { SyncOptionContractUseCase } from './sync-option-contract.usecase.js';
import type { OptionChainPort } from './option-chain.port.js';
import { SyncOptionSnapshotUseCase } from './sync-option-snapshot.usecase.js';
import type { OptionSnapshotPort } from './option-snapshot.port.js';
import { SyncEarningsEventUseCase } from './sync-earnings-event.usecase.js';
import type { EarningsCalendarPort } from './earnings-calendar.port.js';

/** 本维度 failed 达此阈值 → ERROR log 结构化告警 (016 FAILURE_ALERT_THRESHOLD 同值)。 */
const FAILURE_ALERT_THRESHOLD = 3;

/**
 * 维度键全集**值层** (019 T004): 注册表 key source + CLI 维度键校验同源。union type 由此
 * 派生 — 加新维度 = 此处加一值 + 注册 executor (Record 形态编译器强制 exhaustive) + 一行
 * seed, 零 switch/常量改动 (FR-S07)。
 */
export const DIMENSION_KEYS = [
  'universe',
  'profile',
  'eod_bar',
  // sellput-viz: us 正股日线。**独立维度而非给 eod_bar 扩 scope** —— 两条理由都是硬的:
  // ① 调度时点不同 (美股收盘落北京次日凌晨 ⇒ 只能排清晨, 一个维度只有一个 cron_expr);
  // ② tick payload 无 `markets` 字段 ⇒ 工作集恒为全 marketScope, 掺进 cn/hk 维度会在
  //    「只有 us 开市」的日子对全部 cn+hk 标的发请求 (p3b §3.3)。
  //    ⚠️ p3b §4.4 原写的理由「eod_bar 的 port 是理杏仁、对 us 硬编码拒绝」已随
  //    EOD_BAR_PORT 改为按市场路由而失效 —— 结论不变, 但别再引用那条理由。
  'us_equity_bar',
  'fundamental',
  'financial',
  'corporate_action',
  // 039 港股量化高信号 5 维度 (US1 日频高信号先落 short_selling/connect_holding; US2 机构持仓加 fund_holding/fund_company_holding; US3 加 index_membership)。
  'short_selling',
  'connect_holding',
  'fund_holding',
  'fund_company_holding',
  'index_membership',
  // 040 港股波动率日频 (US1): 单只港股按回看窗口 (VOLATILITY_WINDOWS) 的每日年化 HV 序列, 多窗口循环。
  'volatility',
  // 040 港股热度精选快照 (US2): 每精选 hot_type (HOT_TYPES) 按 vendor 数据日期累积的快照, type 循环。
  'hot_snapshot',
  // 041 港股事件流 US1 回购: 单只港股按 [asOf−historyDepth, asOf] 的历次回购事件 (丰富 typed 列)。
  'buyback',
  // 041 港股事件流 US2 股本变动: 单只港股按 [asOf−historyDepth, asOf] 的历次 issued capital 变动 (扁平列)。
  'equity_change',
  // 041 港股事件流 US3 股东权益变动: 单只港股按 [asOf−historyDepth, asOf] 的历次大股东持股变动 (嵌套 L/S payload)。
  'shareholder_change',
  // 041 港股事件流 US4 配股: 单只港股按 [asOf−historyDepth, asOf] 的历次配股事件 (港股极罕见零样本, payload 整存)。
  'allotment',
  // 042 港股报告期 US1 营收构成: 单只港股按 [asOf−historyDepth, asOf] 的各报告期分部级营收 (dataList 展开 typed 子行)。
  'revenue_segment',
  // 042 港股报告期 US2 最新股东: 单只港股按 [asOf−historyDepth, asOf] 的各报告期股东名册 (嵌套 L/S/P payload, SERIES 多 date)。
  'shareholder_snapshot',
  // 042 港股报告期 US3 员工: 单只港股按 [asOf−historyDepth, asOf] 的各报告期员工数据 (dataList 展开 typed 子行, displayType 进 NK)。
  'employee',
  // 043 港股分类文本 US1 所属行业: 单只港股当前所属行业快照 (无 date, hsi 3 级层级, 覆盖式替换)。
  'industry_classification',
  // 043 港股分类文本 US2 公告: 单只港股按 [asOf−historyDepth, asOf] 的历次公告流元数据 (linkUrl 天然唯一 NK, 超大表只存元数据)。
  'announcement',
  // 046 M2a 标的级 IV 日快照 (US3): 富途 overview 批量直读当日 IV 结论 + his_volatility 序列增量。
  // 工作集**挂锚闸** (走 factExecutor 的 loadActiveInstruments, 已含 needSync) —— 无锚不采,
  // 否则从 12 只炸到 19,465 只 us 标的 (FR-026)。
  'underlying_iv_daily',
  // 046 M2a 美股波动率指数日线 (US3): VIX / VVIX, 源 = CBOE 官方历史 CSV 全量文件 upsert。
  // 🚨 **不挂锚闸、不复用 factExecutor** —— 工作集 = 两个固定代码常量, 不查 Instrument
  // (vendor 根本不收录这两个代码, 库里无对应行), 零锚时照常跑 (FR-027 / plan D1)。挂了闸
  // 零锚时会静默不跑, 与「指数表盘不依赖锚」的空态分支直接矛盾。
  'us_index_daily',
  // 047 M2b 链合约发现 (US1): per-code 接口 (单 code + 到期日窗 ≤30 天) ⇒ 工作集**挂锚闸**
  // (锚白名单继承 need_sync), 零锚时跑绿且 vendor 请求数 = 0 (FR-035)。
  'option_contract',
  // 047 M2b 全链逐日快照 (US1): 同为 per-code ⇒ 同样**挂锚闸**; 且 **hard 依赖链发现**
  // (无合约表即无从取快照, FR-031) —— 该 hard 边的相邻性由 priority 取值保证, 见
  // dimension-executor.spec.ts 的「047 T003 依赖拓扑守卫」。
  'option_daily_snapshot',
  // 047 M2b 财报日历 (US1): 🚨 **不挂锚闸** —— get_earnings_calendar(US) 是**市场级**接口
  // (单次 ≤7 天窗返全市场), 调用数只跟前向视野有关、与锚数量无关 ⇒ 锚闸零收窄作用, 挂了只会
  // 复刻「零锚时静默不采」那个坑 (FR-035a)。**判据是「接口是不是 per-code」, 不是「维度归属
  // 哪一片」** —— 046 已在指数维度上订正过一次同形状问题 (FR-026 → FR-027), 本片是第三次。
  // ⇒ 它的 executor **MUST NOT 复用 factExecutor**(那条路径先 loadActiveInstruments);
  // market_scope={us} 对它**只是元数据** (供 tick 的 per-market 交易日闸用)。
  'earnings_event',
] as const;

/** 维度键全集 (016 起; 017 executor 注册表/worker named job/tick won 集共用)。 */
export type DimensionKey = (typeof DIMENSION_KEYS)[number];

export type SyncMode = 'delta' | 'backfill';

/**
 * 复权重取回溯上限 (天) 的**兜底默认** (016 注释全文见 git 史): 真值取
 * `SyncDimension(corporate_action).reAdjustLookbackDays` (FR-S16 策略字段), 此常量仅
 * 该列为 null 时兜底 — 防老票首跑全量回溯爆炸 (SC-S08 实测一只票 8676 行)。
 */
export const DEFAULT_RE_ADJUST_LOOKBACK_DAYS = 730;

/**
 * 补洞道回看窗 (天)。见 `fillRecentEodGaps` 的完整病灶说明。
 *
 * 刻意**不复用** `SyncDimension.deltaLookbackDays` —— 那个字段一旦非 NULL 会让
 * `deltaCursorUsable()` 返 false, 从而关掉 `pendingEodInstruments` 这个**预算截断顺延续跑的
 * 进度锚** (2026-08-12 实测: 那样改会打红 7 个 IT, 其中「① 分夜收敛」「② 下窗续跑」
 * 「T005 截断保底 + 顺延续跑」直接锁的就是这条不变量)。补洞道是**旁路**, 主跑的游标语义
 * 一个字不动 —— 这正是它相对「给 eod_bar 配回看窗」那条路的全部价值。
 */
const EOD_GAP_FILL_LOOKBACK_DAYS = 7;

/**
 * 单次补洞的标的数上限。正常量级约 500–650 (2026-08-12 prod 实测 hk 每交易日缺口), 取
 * 1500 留 2–3× 余量。**超出必须 log 出来**: 静默截断会让「补洞跑过了」与「补洞只补了一半」
 * 长得一模一样, 那等于把本次修的病换个地方复发。
 */
const EOD_GAP_FILL_MAX_INSTRUMENTS = 1500;

/**
 * 🚨 delta 区间左界 —— **所有 `[from, asOf]` 区间型维度的唯一取值处**。
 *
 * `deltaLookbackDays` 为 NULL ⇒ 精确当日 `from = to = asOf` (历史默认行为)；非 NULL ⇒ 回看
 * `[asOf−N, asOf]`。定值规则与逐维度取值见 `schema.prisma` 该列注释 + 20260801_2248 migration。
 *
 * **为什么精确当日是个陷阱** (2026-08-01 prod 取证, 四个维度已静默丢数、SyncRun 全绿):
 * 夜间 tick 以 asOf=当日 D 触发, 但 vendor 对 D 的数据**当晚往往尚未披露** (港股回购 / 南向持股 /
 * 大股东权益变动均 T+1) → 当晚返 0 行; 次晚窗口移到 D+1, **D 的数据再没有任何一次请求会问起**,
 * 缺口永久且完全静默。周更维度更糟: 一周只问 1 天 ⇒ 结构性丢 6/7。
 *
 * ⚠️ 加宽窗口是安全的: 各维度落库一律 `createMany(skipDuplicates)`, 重叠日零翻倍
 * (connect_holding 自 2026-06 起以 N=3 在 prod 验证, 本次随统一规则提到 7)。
 *
 * ⚠️ 本函数只管 delta；backfill 的左界另由 `historyDepth` 决定, 两者互不影响。
 */
function deltaFrom(dim: ExecutorSyncDimensionRow, asOf: string): string {
  return dim.deltaLookbackDays == null ? asOf : subtractDays(asOf, dim.deltaLookbackDays);
}

/**
 * delta 的「本目标日已落行则跳过」游标是否可用。
 *
 * 该游标的前提是「工作集里某标的**已有 asOf 行** ⇒ 它本窗已完成」——**只在精确当日窗下成立**。
 * 一旦开了回看窗, 窗内还有 asOf−N…asOf−1 这些天要补, 拿 asOf 单日的落库情况判「已完成」会
 * 把恰好有当日行的标的整只跳掉, 反而在窗口内留洞。⇒ 有回看窗时**不走游标**, 全工作集重取
 * (skipDuplicates 兜幂等)。代价可忽略: 这些恰恰是 T+1 披露维度, asOf 当日行本就基本不存在,
 * 游标在它们身上几乎从不命中。
 */
function deltaCursorUsable(dim: ExecutorSyncDimensionRow): boolean {
  return dim.deltaLookbackDays == null;
}

/** 单维度执行输入 (worker payload 形态)。 */
export interface ExecutorInput {
  mode: SyncMode;
  /** 目标日 YYYY-MM-DD (worker payload 字符串形态, 控时由调用方注入)。 */
  asOf: string;
  /**
   * 注入控时 (watermark / 业务日期换算)。
   *
   * 🚫 **不是 SyncRun 的 `finished_at`** —— 它是 job **起点**, 拿去当收尾时刻会让
   * `finished_at ≈ started_at`、耗时永久不可读 (2026-08-09 修, 见 `SyncRunRecorder.finish`)。
   */
  now: Date;
  /** backfill 模式回填天数 (CLI `--history-depth` 覆盖 SyncDimension.historyDepth)。 */
  backfillHistoryDays?: number;
  /** 本窗 eod 预算上限 (耗尽→剩余顺延, FR-S07; 默认无限)。 */
  maxEodInstruments?: number;
  /**
   * backfill 市场范围缩窄 (038 seam#3, CLI `--markets` 透传): 与维度 marketScope 取交集
   * 定工作集 (运维可只回填某市场)。缺省 (夜间 delta) → 用全 marketScope。
   */
  markets?: string[];
  /**
   * backfill force-refetch (CLI `--no-skip-complete` 透传): 绕过 skip-complete 游标 — 老端已
   * 覆盖股也重拉重写 (补中段缺口场景, 如 044 日历停摆致 fundamental 某日缺行, skip-complete 会把
   * 「老端有行」的缺口股误跳)。缺省 false → 保留 skip-complete 省 fetch/避 OOM 的默认。仅 backfill
   * 路径消费; delta 路径无 skip-complete 概念, 此字段无效。
   */
  noSkipComplete?: boolean;
}

/** 执行结果: 统计 + 配额顺延信号 (D5; 仅 eod_bar 预算耗尽时 true, deferral ≠ failure)。 */
export interface ExecutorResult {
  stats: SyncRunStats;
  budgetExhausted: boolean;
}

/** 单维度 executor 函数形态 (019 T004 注册表 entry; 自含全部执行逻辑)。 */
export type DimensionExecutorFn = (input: ExecutorInput) => Promise<ExecutorResult>;

/**
 * executor 侧 SyncDimension 投影 (017): 在旧管线 Pick 之上扩 `enabled`/`retryMax`/
 * `misfirePolicy` (tick 入队 attempts / 灰度 gate / misfire 分流消费)。
 */
export type ExecutorSyncDimensionRow = {
  dimensionKey: string;
  enabled: boolean;
  cronExpr: string;
  /** 本维度同步工作集的市场范围 (038 seam#2): loadActiveInstruments 据此过滤, 取代旧 MARKET 常量。 */
  marketScope: string[];
  adjustTypes: string[];
  batchSize: number;
  historyDepth: number | null;
  retryMax: number;
  misfirePolicy: string;
  reAdjustLookbackDays: number | null;
  /** delta 回看窗 (天); NULL = 精确当日。定值规则见 schema.prisma 该列注释 + {@link deltaFrom}。 */
  deltaLookbackDays: number | null;
  pausedUntil: Date | null;
  /** eod 进度水位 (FR-S07 续跑锚; 019 T010 D2 除权命中检查的窗口左界)。 */
  lastWatermark: Date | null;
};

/** 工作集标的最小投影 (canonical symbol 由 market:code 拼)。 */
export interface WorkingInstrument {
  id: bigint;
  market: string;
  code: string;
}

const toDateOnly = (s: string): Date => new Date(`${s}T00:00:00Z`);
const dateOnlyStr = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * BuybackDto 股数字段 (string|null) → bigint|null (BuybackEvent `BigInt?` 股数列: num /
 * totalSharesForCancellation / totalSharesForTreasury)。金融数值跨边界以 string 承载 (FR-S08),
 * 落 BigInt? 列前显式转 bigint (避 JS number 对大股数精度损失); null 透传。
 */
const toBigIntOrNull = (v: string | null): bigint | null => (v === null ? null : BigInt(v));

/** YYYY-MM-DD 减 n 天 (UTC, 用于 backfill 起点)。 */
export function subtractDays(dateStr: string, days: number): string {
  const d = toDateOnly(dateStr);
  d.setUTCDate(d.getUTCDate() - days);
  return dateOnlyStr(d);
}

/** YYYY-MM-DD 加 n 天 (UTC; skip-complete grace-window 用)。 */
function addDays(dateStr: string, days: number): string {
  return subtractDays(dateStr, -days);
}

/** FundamentalSnapshotDto → 估值字段投影 (delta 批量 upsert + backfill 区间 createMany 共用; 缺字段透传 null, P2)。 */
function fundamentalUpsertData(d: FundamentalSnapshotDto) {
  return {
    peTtm: d.peTtm,
    peStatic: d.peStatic,
    peDynamic: d.peDynamic,
    pb: d.pb,
    ps: d.ps,
    dividendYield: d.dividendYield,
    marketCap: d.marketCap,
    circMarketCap: d.circMarketCap,
    pePctlY3: d.pePctlY3,
    pePctlY5: d.pePctlY5,
    pbPctlY3: d.pbPctlY3,
    pbPctlY5: d.pbPctlY5,
  };
}

/** EodBarPoint → DailyBar createMany row (string→Decimal 由 Prisma 接收)。 */
export function toDailyBarRow(
  instrumentId: bigint,
  b: EodBarPoint,
): Prisma.DailyBarCreateManyInput {
  return {
    instrumentId,
    tradeDate: toDateOnly(b.tradeDate),
    adjust: b.adjust,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    changePct: b.changePct,
    prevClose: b.prevClose,
    volume: b.volume,
    amount: b.amount,
    turnoverRate: b.turnoverRate,
  };
}

/**
 * `daily_bar` 落库: **尾部窗口 upsert + 更老 insert-only** (063 Phase 3.1, 形态照抄
 * {@link DimensionExecutor.writeUsIndexRows})。**唯二**两个 `daily_bar` 写入口 —— 采集轮的
 * `syncEodBarNone` 与建锚旁路 `EnsureLatestEodBarUseCase` —— 共用本函数。两处各写一遍必漂,
 * 而漂移的形态恰是「同一根 K 在一条路上改得动、在另一条路上永远冻着」。
 *
 * ## 为什么不再是纯 insert-only
 *
 * 原写法 `createMany(skipDuplicates)` 对已存在的 `(instrument, date, adjust)` **静默跳过** ⇒
 * vendor 的事后订正永远进不来, 且**盘中拿到的「进行中」K 线被永久冻结** (富途
 * `request_history_kline` 盘中返进行中 K 线 —— #103 的形状)。
 *
 * ⚠️ **代价**: 订正的是「值」不是「版本」—— 旧值不留档, 做不了严格 PIT 回测 (无 look-ahead
 * bias 的历史复盘)。业内正解是另开一条 vintage 轴, 但那是破坏性变更 (读侧全都要带「取最新
 * 版本」语义), 真要回测时再上, 走 expand-migrate-contract。
 *
 * ## 前提: 一批 = 单标的单口径
 *
 * 「尾部」按 `tradeDate` 升序取最后 N 行 ⇒ 一批里混多只标的 / 多个复权口径时这个切法没有意义。
 * 两个调用点都是「一只标的、一个口径、一段区间」, 保持这样。
 *
 * 🚨 **入参顺序不可信, 函数自己排** —— `EodBarPort` 契约说按 `tradeDate` 升序, 但顺序哪天变了,
 * 尾窗就静默切在错误的 N 行上 (老行被 upsert、新行反而 insert-only), 而这是个不报错、只是订正
 * 悄悄失效的偏差。排序 O(n log n) 相对 n 次往返可忽略。
 *
 * 复杂度: ⌈头部行数 / {@link BACKFILL_ROW_CHUNK}⌉ 次 `createMany` +
 * ≤ {@link DAILY_BAR_REVISABLE_TAIL_ROWS} 次 upsert (单 tx)。
 *
 * @returns **真正落到库里的行数** (063 Phase 3.3): insert-only 段取 PG 报的真新增 (撞唯一键
 *   被跳过的**不计**, 它们没落库); 尾窗段按行计 —— 那些行是订正, 确实落了库。
 */
export async function writeDailyBarRows(
  prisma: PrismaService,
  rows: Prisma.DailyBarCreateManyInput[],
): Promise<number> {
  if (rows.length === 0) return 0; // 停牌 / 新股无行情 —— 不开事务。
  const sorted = [...rows].sort(
    (a, b) => new Date(a.tradeDate).getTime() - new Date(b.tradeDate).getTime(),
  );
  const tailStart = Math.max(0, sorted.length - DAILY_BAR_REVISABLE_TAIL_ROWS);

  let written = 0;
  for (const chunk of chunked(sorted.slice(0, tailStart), BACKFILL_ROW_CHUNK)) {
    written += (await prisma.dailyBar.createMany({ data: chunk, skipDuplicates: true })).count;
  }

  const tail = sorted.slice(tailStart);
  await prisma.$transaction(async (tx) => {
    for (const row of tail) {
      const { instrumentId, tradeDate, adjust, ...values } = row;
      await tx.dailyBar.upsert({
        where: { instrumentId_tradeDate_adjust: { instrumentId, tradeDate, adjust } },
        create: row,
        update: values,
      });
    }
  });
  return written + tail.length;
}

/**
 * {@link UnderlyingIvSnapshot} → `underlying_iv_daily` 列 (046 T008)。
 *
 * `symbol` 是请求侧回填的**路由字段不是列**, 故不在此列出 (带进去 Prisma 直接抛未知字段)。
 * 金融数值全程 `string | null` 直传 Decimal 列 (FR-S08: 中途过一趟 JS number 就把精度丢在
 * 半路); `null` = 该项无值 **不是 0** —— IV 分位上 0 的意思是「一年最低」, 与「没有值」
 * 方向恰好相反 (FR-014 全片纪律)。
 */
function underlyingIvUpsertData(s: UnderlyingIvSnapshot) {
  return {
    iv: s.iv,
    ivRank: s.ivRank,
    ivPercentile: s.ivPercentile,
    preIv: s.preIv,
    hv30: s.hv30,
    hv30Percentile: s.hv30Percentile,
    hv60: s.hv60,
    hv60Percentile: s.hv60Percentile,
    hv90: s.hv90,
    hv90Percentile: s.hv90Percentile,
    hv120: s.hv120,
    hv120Percentile: s.hv120Percentile,
    hv365: s.hv365,
    hv365Percentile: s.hv365Percentile,
    callVolume: s.callVolume,
    putVolume: s.putVolume,
    callOi: s.callOi,
    putOi: s.putOi,
  };
}

/**
 * {@link UsIndexDailyPoint} → `us_index_daily` createMany row (046 T013)。
 *
 * 金融数值全程 `string` 直传 Decimal 列 (FR-S08)。🚨 **VVIX 的 OHLC 透传 `null` 不填 0**
 * (Guardrail 7 / FR-025): 源文件根本没有那三列, 填 0 会让「VVIX 开盘 0」这种假事实进库,
 * 且下游再也分不出「无此列」与「真是 0」。
 */
function usIndexDailyRow(
  indexCode: UsIndexCode,
  p: UsIndexDailyPoint,
): Prisma.UsIndexDailyCreateManyInput {
  return {
    indexCode,
    date: toDateOnly(p.date),
    open: p.open,
    high: p.high,
    low: p.low,
    close: p.close,
  };
}

/**
 * vendor 的 `string | null` 金融数值 → `Prisma.Decimal`（046 T010 对表侧）。
 *
 * 不可解析 / 非有限值 → `null`，**不是 0**：0 在分位语义上是「一年最低」，与「没有值」方向
 * 恰好相反；拿它当自算输入会凭空造出一次「差 50pp」的假漂移告警（FR-014 全片纪律）。
 */
function toDecimalOrNull(v: string | null): Prisma.Decimal | null {
  if (v === null) return null;
  try {
    const d = new Prisma.Decimal(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** in 范围内累加 from 的派发统计 (子执行计数并入本维度 SyncRun)。 */
export function mergeStats(into: SyncRunStats, from: SyncRunStats): void {
  into.scanned += from.scanned;
  into.ok += from.ok;
  into.skipped += from.skipped;
  into.failed += from.failed;
  // 🚨 written 是**三态**列 (null/0/>0), 不能跟着上面 `+=` —— null 起点会变 NaN 且一路不报错
  // (见 addWritten 注释)。只有 from 真上报过才动 into: 两边都 null ⇒ 保持 null (「一次都没
  // 上报」); from=0 ⇒ into 抬成 0 (「写了 0 行」)。这两态必须可分辨, 那是本列存在的理由。
  // #103: 本行曾整个缺失 ⇒ 外层 stats 恒 null ⇒ 生产上每个 sync_type 的 written 都是 NULL。
  if (from.written !== null) addWritten(into, from.written);
  into.failedTargets.push(...from.failedTargets);
}

/** instruments → canonical symbol → instrumentId 索引 (批量维度回填 instrumentId)。 */
function symbolIndex(instruments: WorkingInstrument[]): Map<string, bigint> {
  return new Map(instruments.map((i) => [`${i.market}:${i.code}`, i.id]));
}

/** 切片成 size 大小的块 (批量维度按 batchSize 分批隔离)。 */
function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  const step = size > 0 ? size : items.length || 1;
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

/**
 * backfill createMany 行分批配额 (incident 2026-07-12 P1): 单股历史 ~2400 行不再一条 tx 塞满 —
 * 按此配额 chunk, 每片一个 $transaction, 一举封顶事务时长 (避 Prisma 默认 5s 超时, #675 病根)
 * 与单批内存 (避全量重跑在 1.6GB host 上累积 OOM)。500 行/批 = Prisma 社区 + PG bulk-load 共识区间。
 */
const BACKFILL_ROW_CHUNK = 500;

/**
 * 指数日线**尾部可修订窗口**(行数, 046 T013): 只有最近这么多行走 upsert, 更老的走 insert-only。
 *
 * 10 行 ≈ 两个交易周: 覆盖「今天先发初值、隔天订正」以及一次长周末后的补发, 同时把每日往返从
 * 14k 次压到 20 次。取更大值只是白花往返 —— 1990 年以来的结算值不会变; 取更小值 (如 1) 则挡不住
 * 「上周某天的值被订正」这种情形。
 */
const US_INDEX_REVISABLE_TAIL_ROWS = 10;

/**
 * `daily_bar` **尾部可修订窗口** (行数, 063 Phase 3.1): 只有最近这么多根走 upsert, 更老的走
 * insert-only。取值与理由同 {@link US_INDEX_REVISABLE_TAIL_ROWS} 的 10 —— 约两个交易周, 覆盖
 * 「盘中先落进行中 K、收盘后订正」与一次长周末后的补发。
 *
 * 🚨 **必须 ≥ 各日线维度的 `delta_lookback_days`** (今天 us_equity_bar = 7, eod_bar = NULL):
 * 回看窗决定「每晚重新问 vendor 要哪几天」, 尾窗决定「问回来的这几天里哪几天改得动」。尾窗小于
 * 回看窗 = 每晚白拉几天回来又按 insert-only 丢掉, 纯浪费且不报错。调大回看窗时回到这里对一次。
 */
const DAILY_BAR_REVISABLE_TAIL_ROWS = 10;

/**
 * skip-complete 游标宽限窗口 (grace-window, 2026-07-13 实测优化): 判「老端已回填」用 `from + N 天`
 * 而非精确 `from`。完整股最早行常落在 from 之后几天 (窗口起点撞周末/长假顶到下个交易日 + 重跑 asOf
 * 逐日推进使 from 后移), 精确 `date<=from` 会把它们误判未回填 → 白重拉 (2026-07-13 实测多碰 ~260 股,
 * 无害但费 HTTP)。N=30: > 周末+~3 周漂移, 且 <<< 任何真缺口 (缺口是百天级) → 不会误跳真缺口
 * (fn=0 无行永不命中; 缺老端股最早行在中段 >> from+N 也不命中)。
 */
const SKIP_COMPLETE_GRACE_DAYS = 30;

/**
 * 039 新维度端口的 null-object 构造默认 (镜像 `backfillPacer = BackfillPacer.disabled()` 先例):
 * 22 处测试 positional 直实例化本注册表 —— 让不触及这些新维度的既有测试**零改动**编译通过
 * (省去 44 处机械改点)。返 [] 无害: 生产经 MarketdataModule DI 注真 adapter (缺 provider →
 * NestJS boot fail, 与 backfillPacer 同); 直调这些维度的测试 (T006+/T008 IT) 注真 mock。
 */
const NULL_SHORT_SELLING: ShortSellingPort = { getShortSellingRange: async () => [] };
const NULL_CONNECT_HOLDING: ConnectHoldingPort = { getConnectHoldingRange: async () => [] };
const NULL_FUND_HOLDING: FundHoldingPort = { getFundHoldingRange: async () => [] };
const NULL_FUND_COMPANY_HOLDING: FundCompanyHoldingPort = {
  getFundCompanyHoldingRange: async () => [],
};
const NULL_INDEX_MEMBERSHIP: IndexMembershipPort = { getIndexMembership: async () => [] };
const NULL_VOLATILITY: VolatilityPort = { getVolatilityRange: async () => [] };
const NULL_HOT_SNAPSHOT: HotSnapshotPort = { getHotSnapshot: async () => [] };
// 041 US1 回购端口 null-object (同 039/040 先例)。
const NULL_BUYBACK: BuybackPort = { getBuybackRange: async () => [] };
// 041 US2 股本变动端口 null-object (同 039/040/US1 先例)。
const NULL_EQUITY_CHANGE: EquityChangePort = { getEquityChangeRange: async () => [] };
// 041 US3 股东权益变动端口 null-object (同 039/040/US1/US2 先例)。
const NULL_SHAREHOLDER_CHANGE: ShareholderChangePort = {
  getShareholderChangeRange: async () => [],
};
// 041 US4 配股端口 null-object (同 039/040/US1/US2/US3 先例; 零样本 → 空返回天然对齐)。
const NULL_ALLOTMENT: AllotmentPort = { getAllotmentRange: async () => [] };
// 042 US1 营收构成端口 null-object (同 041 先例)。
const NULL_REVENUE_SEGMENT: RevenueSegmentPort = { getRevenueSegmentRange: async () => [] };
// 042 US2 最新股东端口 null-object (同 041/US1 先例)。
const NULL_SHAREHOLDER_SNAPSHOT: ShareholderSnapshotPort = {
  getShareholderSnapshotRange: async () => [],
};
// 042 US3 员工端口 null-object (同 041/US1/US2 先例)。
const NULL_EMPLOYEE: EmployeePort = { getEmployeeRange: async () => [] };
// 043 US1 所属行业端口 null-object (同 039 index_membership 覆盖式先例; 空返回天然对齐跳过不 wipe)。
const NULL_INDUSTRY_CLASSIFICATION: IndustryClassificationPort = {
  getIndustryClassification: async () => [],
};
// 043 US2 公告端口 null-object (同 041 buyback range 先例; 空返回天然对齐零 createMany)。
const NULL_ANNOUNCEMENT: AnnouncementPort = { getAnnouncementRange: async () => [] };
// 046 T008 标的级 IV 端口 null-object (同 039-043 尾部默认先例; 空返回 = 整批标的今日无 IV,
// 计 skipped 零 upsert)。生产经 MarketdataModule DI 注真 adapter。
const NULL_UNDERLYING_IV: UnderlyingIvPort = {
  getIvSnapshots: async () => [],
  getIvHistoryRange: async () => [],
};
// 046 T013 美股波动率指数端口 null-object (同上尾部默认先例)。生产经 MarketdataModule DI 注真 adapter。
const NULL_US_INDEX: UsIndexPort = {
  getIndexHistory: async (indexCode) => ({ indexCode, rows: [], skipped: 0, skippedSamples: [] }),
};
// 047 T014 期权链端口 null-object (同上尾部默认先例): 空到期日阶梯 ⇒ 零窗、零落库、零 gap。
// 生产经 MarketdataModule DI 注真 adapter (缺 provider → NestJS boot fail)。
const NULL_OPTION_CHAIN: OptionChainPort = {
  getExpiryDates: async () => [],
  getChainWindow: async () => [],
};
// 047 T016 期权快照端口 null-object (同上尾部默认先例): 空批 ⇒ 零落库 (`asOf` 取 epoch 是
// 刻意的哨兵 —— 它永远不会跟着任何一行进库, 因为 rows 恒空)。生产经 MarketdataModule DI 注真
// adapter (缺 provider → NestJS boot fail)。
const NULL_OPTION_SNAPSHOT: OptionSnapshotPort = {
  getSnapshots: async () => ({ asOf: new Date(0), rows: [] }),
};
// 047 T018 财报日历端口 null-object (同上尾部默认先例): 每个窗返空 ⇒ 零观测、零落库、零 diff。
// 生产经 MarketdataModule DI 注真 adapter (缺 provider → NestJS boot fail)。
const NULL_EARNINGS_CALENDAR: EarningsCalendarPort = {
  getWindow: async () => [],
};

/**
 * per-dimension executor 注册表 (017 T008, ADR-0049 执行层)。
 *
 * 016 旧 EOD 聚合管线 4 个 fact 私有方法 (syncEodBars/syncFundamentals/syncFinancials/
 * syncCorporateActions) + universe/profile use case 包装升格为 `DimensionKey → executor`,
 * PR-7 清退旧 22:00 聚合管线后是**唯一执行面** (BullMQ worker 消费) — 业务同步语义
 * (幂等 / per-instrument 隔离 / HTTP-out-of-tx, 016 四支柱) 逐行搬运零变化。
 */
@Injectable()
export class DimensionExecutorRegistry {
  private readonly logger = new Logger(DimensionExecutorRegistry.name);

  /** key → executor 注册表 (019 T004, switch 退役)。Map 形态允许 IT 注册测试维度 (SC-S05)。 */
  private readonly executors: Map<DimensionKey, DimensionExecutorFn>;

  constructor(
    private readonly syncUniverse: SyncUniverseUseCase,
    private readonly syncProfile: SyncProfileUseCase,
    @Inject(EOD_BAR_PORT) private readonly eodBar: EodBarPort,
    @Inject(FUNDAMENTAL_PORT) private readonly fundamental: FundamentalPort,
    @Inject(FINANCIALS_PORT) private readonly financials: FinancialsPort,
    @Inject(CORPORATE_ACTION_PORT) private readonly corporateAction: CorporateActionPort,
    private readonly prisma: PrismaService,
    private readonly recorder: SyncRunRecorder,
    private readonly tierRecalc: SyncTierRecalc,
    // 038 T017 (INV-3): 回填自限速节流器, 叠加在 backfill 路径的更保守层 (~600/min + jitter,
    // 共享 profile 900/min 桶不动)。默认 disabled —— 既有直调 IT / 非 backfill 路径零减速;
    // 生产经 MarketdataModule DI 注入 enabled 实例 (只 backfill 模式的 per-instrument 循环触发)。
    private readonly backfillPacer: BackfillPacer = BackfillPacer.disabled(),
    // 039 US1 日频高信号端口 (尾部 + null-object 默认, 见 NULL_SHORT_SELLING 注释)。生产经 DI 注真 adapter。
    @Inject(SHORT_SELLING_PORT)
    private readonly shortSelling: ShortSellingPort = NULL_SHORT_SELLING,
    @Inject(CONNECT_HOLDING_PORT)
    private readonly connectHolding: ConnectHoldingPort = NULL_CONNECT_HOLDING,
    // 039 US2 机构持仓端口 (尾部 + null-object 默认, 同 US1 先例)。生产经 DI 注真 adapter。
    @Inject(FUND_HOLDING_PORT)
    private readonly fundHolding: FundHoldingPort = NULL_FUND_HOLDING,
    @Inject(FUND_COMPANY_HOLDING_PORT)
    private readonly fundCompanyHolding: FundCompanyHoldingPort = NULL_FUND_COMPANY_HOLDING,
    // 039 US3 所属指数端口 (尾部 + null-object 默认, 同 US1/US2 先例)。生产经 DI 注真 adapter。
    @Inject(INDEX_MEMBERSHIP_PORT)
    private readonly indexMembership: IndexMembershipPort = NULL_INDEX_MEMBERSHIP,
    // 040 US1 波动率日频端口 (尾部 + null-object 默认, 同 039 先例)。生产经 DI 注真 adapter。
    @Inject(VOLATILITY_PORT)
    private readonly volatility: VolatilityPort = NULL_VOLATILITY,
    // 040 US2 热度精选快照端口 (尾部 + null-object 默认, 同 039/US1 先例)。生产经 DI 注真 adapter。
    @Inject(HOT_SNAPSHOT_PORT)
    private readonly hotSnapshot: HotSnapshotPort = NULL_HOT_SNAPSHOT,
    // 041 US1 回购事件端口 (尾部 + null-object 默认, 同 039/040 先例)。生产经 DI 注真 adapter。
    @Inject(BUYBACK_PORT)
    private readonly buyback: BuybackPort = NULL_BUYBACK,
    // 041 US2 股本变动事件端口 (尾部 + null-object 默认, 同 US1 先例)。生产经 DI 注真 adapter。
    @Inject(EQUITY_CHANGE_PORT)
    private readonly equityChange: EquityChangePort = NULL_EQUITY_CHANGE,
    // 041 US3 股东权益变动事件端口 (尾部 + null-object 默认, 同 US1/US2 先例)。生产经 DI 注真 adapter。
    @Inject(SHAREHOLDER_CHANGE_PORT)
    private readonly shareholderChange: ShareholderChangePort = NULL_SHAREHOLDER_CHANGE,
    // 041 US4 配股事件端口 (尾部 + null-object 默认, 同 US1/US2/US3 先例)。生产经 DI 注真 adapter。
    @Inject(ALLOTMENT_PORT)
    private readonly allotment: AllotmentPort = NULL_ALLOTMENT,
    // 042 US1 营收构成端口 (尾部 + null-object 默认, 同 041 先例)。生产经 DI 注真 adapter。
    @Inject(REVENUE_SEGMENT_PORT)
    private readonly revenueSegment: RevenueSegmentPort = NULL_REVENUE_SEGMENT,
    // 042 US2 最新股东端口 (尾部 + null-object 默认, 同 041/US1 先例)。生产经 DI 注真 adapter。
    @Inject(SHAREHOLDER_SNAPSHOT_PORT)
    private readonly shareholderSnapshot: ShareholderSnapshotPort = NULL_SHAREHOLDER_SNAPSHOT,
    // 042 US3 员工端口 (尾部 + null-object 默认, 同 041/US1/US2 先例)。生产经 DI 注真 adapter。
    @Inject(EMPLOYEE_PORT)
    private readonly employee: EmployeePort = NULL_EMPLOYEE,
    // 043 US1 所属行业端口 (尾部 + null-object 默认, 同 039 index_membership 先例)。生产经 DI 注真 adapter。
    @Inject(INDUSTRY_CLASSIFICATION_PORT)
    private readonly industryClassification: IndustryClassificationPort = NULL_INDUSTRY_CLASSIFICATION,
    // 043 US2 公告端口 (尾部 + null-object 默认, 同 041 buyback range 先例)。生产经 DI 注真 adapter。
    @Inject(ANNOUNCEMENT_PORT)
    private readonly announcement: AnnouncementPort = NULL_ANNOUNCEMENT,
    // 045 T015 采集闸重算 (FR-028/FR-029, plan D7): 与 tierRecalc 并列的 fact 前置步骤。
    // **尾部可选**而非插在 tierRecalc 旁 (同 039-043 尾部默认先例): 本构造器已有 17 位尾部
    // 默认参数、60+ 处直调点按位置传参, 插中间会波及全部。不传 ⇒ `?.` 短路 no-op, 既有直调
    // IT 零感知 (SC-007 既有 22 维度运行状态零变化); 生产经 MarketdataModule DI 注真实例。
    private readonly anchorGate?: AnchorDrivenSyncGate,
    // 046 T008 标的级 IV 端口 (尾部 + null-object 默认, 同 039-043 先例)。生产经 DI 注真 adapter。
    @Inject(UNDERLYING_IV_PORT)
    private readonly underlyingIv: UnderlyingIvPort = NULL_UNDERLYING_IV,
    // 046 T013 美股波动率指数端口 (尾部第 29 位 + null-object 默认, 同上先例)。生产经 DI 注真 adapter。
    @Inject(US_INDEX_PORT)
    private readonly usIndex: UsIndexPort = NULL_US_INDEX,
    // 047 T015 链合约发现 use case (尾部第 30 位 —— 本构造器已有 60+ 处按位置传参的直调点,
    // 插中间会波及全部)。默认值形态照 `backfillPacer = BackfillPacer.disabled()` 先例: 给一个
    // **真实例 + null-object 端口**, 让不触及本维度的既有测试零改动通过 (空阶梯 ⇒ 零窗零落库)。
    // 生产经 MarketdataModule DI 注真实例 (端口缺 provider → NestJS boot fail)。
    private readonly syncOptionContract: SyncOptionContractUseCase = new SyncOptionContractUseCase(
      NULL_OPTION_CHAIN,
      prisma,
    ),
    // 047 T016 逐日快照 use case (尾部第 31 位, 同上一位的理由与默认值形态)。
    private readonly syncOptionSnapshot: SyncOptionSnapshotUseCase = new SyncOptionSnapshotUseCase(
      NULL_OPTION_SNAPSHOT,
      prisma,
    ),
    // 047 T019 财报日历 use case (尾部第 32 位, 同上两位的理由与默认值形态)。
    // 🚨 默认值 **MUST NOT 写成 throw-on-missing** —— 十几个 IT 按位置直实例化本注册表, 一个
    // 「不给就炸」的默认会把它们全部打红, 而它们要验的根本不是本维度。
    private readonly syncEarningsEvent: SyncEarningsEventUseCase = new SyncEarningsEventUseCase(
      NULL_EARNINGS_CALENDAR,
      prisma,
    ),
  ) {
    this.executors = new Map(
      Object.entries(this.buildExecutors()) as [DimensionKey, DimensionExecutorFn][],
    );
  }

  /**
   * 既有 6 维度 executor 装配 (Record 形态 → 编译器强制 exhaustive, FR-S07): meta 维度
   * 包装 use case (零 fact 前置); fact 维度共享前置 (tier 重算 + dim 行 + 工作集, 016/018
   * 语义位置不变) 后绑各自搬运方法。
   */
  private buildExecutors(): Record<DimensionKey, DimensionExecutorFn> {
    return {
      universe: async () => ({ stats: await this.syncUniverse.run(), budgetExhausted: false }),
      profile: async () => ({ stats: await this.syncProfile.run(), budgetExhausted: false }),
      eod_bar: this.factExecutor('eod_bar', (instruments, dim, stats, input) =>
        this.syncEodBars(instruments, dim, stats, {
          targetDate: input.asOf,
          mode: input.mode,
          maxEodInstruments: input.maxEodInstruments ?? Number.POSITIVE_INFINITY,
          backfillHistoryDays: input.backfillHistoryDays,
          now: input.now,
        }),
      ),
      // us 正股日线: 与 eod_bar **同一搬运方法**, 只是维度行不同 (scope {us} / 清晨 cron /
      // 走 EOD_BAR_PORT 的 us 路由 = 富途)。除权机制对 us 是空转 (corporate_action 无 us
      // 数据 ⇒ 命中集恒空), 不需要也不应该另写一份精简版。
      us_equity_bar: this.factExecutor('us_equity_bar', (instruments, dim, stats, input) =>
        this.syncEodBars(instruments, dim, stats, {
          targetDate: input.asOf,
          mode: input.mode,
          maxEodInstruments: input.maxEodInstruments ?? Number.POSITIVE_INFINITY,
          backfillHistoryDays: input.backfillHistoryDays,
          now: input.now,
        }),
      ),
      fundamental: this.factExecutor('fundamental', async (instruments, dim, stats, input) => {
        await this.syncFundamentals(instruments, dim, stats, input);
      }),
      financial: this.factExecutor('financial', async (instruments, dim, stats, input) => {
        await this.syncFinancials(instruments, dim, stats, input);
      }),
      corporate_action: this.factExecutor(
        'corporate_action',
        async (instruments, dim, stats, input) => {
          // 复权重取回溯上限取 corporate_action 维度策略字段 (FR-S16; null → 兜底默认)。
          const lookback = dim.reAdjustLookbackDays ?? DEFAULT_RE_ADJUST_LOOKBACK_DAYS;
          await this.syncCorporateActions(instruments, input.asOf, lookback, stats);
        },
      ),
      // 039 T006 US1 做空日频 (照抄 eod_bar 区间形态: mode 分 from; per-stock createMany 幂等)。
      short_selling: this.factExecutor('short_selling', (instruments, dim, stats, input) =>
        this.syncShortSelling(instruments, dim, stats, input),
      ),
      // 039 T007 US1 南向持股日频 (同 short_selling 形态; 非港股通标的空返回 → 零落库不崩)。
      connect_holding: this.factExecutor('connect_holding', (instruments, dim, stats, input) =>
        this.syncConnectHolding(instruments, dim, stats, input),
      ),
      // 039 T011 US2 公募基金持股 (照 backfillFinancials: chunked createMany on 报告期自然键; 大表分片)。
      fund_holding: this.factExecutor('fund_holding', (instruments, dim, stats, input) =>
        this.syncFundHolding(instruments, dim, stats, input),
      ),
      // 039 T012 US2 基金公司持股 (同 fund_holding 形态; uk 换 fundCollectionCode)。
      fund_company_holding: this.factExecutor(
        'fund_company_holding',
        (instruments, dim, stats, input) =>
          this.syncFundCompanyHolding(instruments, dim, stats, input),
      ),
      // 039 T015 US3 所属指数 (第 3 形态: 无 mode 分支; 覆盖式 deleteMany+createMany 快照)。
      index_membership: this.factExecutor('index_membership', (instruments, _dim, stats, input) =>
        this.syncIndexMembership(instruments, stats, input),
      ),
      // 040 T005 US1 波动率日频 (照抄 eod_bar 区间形态 × VOLATILITY_WINDOWS 多窗口循环: mode 分 from;
      // 每窗口一 getVolatilityRange → createMany 幂等 on (instrumentId,date,volatilityDays))。
      volatility: this.factExecutor('volatility', (instruments, dim, stats, input) =>
        this.syncVolatility(instruments, dim, stats, input),
      ),
      // 040 T008 US2 热度精选快照 (第 2 形态: 无 mode 分支 × HOT_TYPES type 循环; 每 type 拉当前快照 →
      // 按 dataDate(last_data_date) upsert on (instrumentId,hotType,dataDate) 累积, 不回填历史)。
      hot_snapshot: this.factExecutor('hot_snapshot', (instruments, _dim, stats, input) =>
        this.syncHotSnapshot(instruments, stats, input),
      ),
      // 041 T005 US1 回购事件 (照抄 eod_bar/short_selling 区间形态: mode 分 from; per-stock
      // createMany 幂等 on (instrumentId,date); 丰富 typed 列)。
      buyback: this.factExecutor('buyback', (instruments, dim, stats, input) =>
        this.syncBuyback(instruments, dim, stats, input),
      ),
      // 041 T008 US2 股本变动事件 (照抄 buyback 区间形态: mode 分 from; per-stock createMany 幂等
      // on (instrumentId,date); 扁平列 capitalization/capitalizationH/changeReason/declarationDate)。
      equity_change: this.factExecutor('equity_change', (instruments, dim, stats, input) =>
        this.syncEquityChange(instruments, dim, stats, input),
      ),
      // 041 T011 US3 股东权益变动事件 (照抄 buyback 区间形态: mode 分 from; per-stock createMany 幂等
      // on (instrumentId,date,shareholderName); 嵌套 L/S payload Json 整存)。
      shareholder_change: this.factExecutor(
        'shareholder_change',
        (instruments, dim, stats, input) =>
          this.syncShareholderChange(instruments, dim, stats, input),
      ),
      // 041 T014 US4 配股事件 (照抄 buyback 区间形态: mode 分 from; per-stock createMany 幂等 on
      // (instrumentId,date); payload Json 整存; 港股极罕见 → 空返回零行优雅收敛不阻塞其余标的)。
      allotment: this.factExecutor('allotment', (instruments, dim, stats, input) =>
        this.syncAllotment(instruments, dim, stats, input),
      ),
      // 042 T005 US1 营收构成 (照抄 buyback 区间形态: mode 分 from; per-stock createMany 幂等 on
      // (instrumentId,date,parentItemName,itemName); adapter 已展开 dataList typed 子行, 头行判别/缺值 null/trim/signed 负)。
      revenue_segment: this.factExecutor('revenue_segment', (instruments, dim, stats, input) =>
        this.syncRevenueSegment(instruments, dim, stats, input),
      ),
      // 042 T008 US2 最新股东 (照抄 shareholder_change 区间形态: mode 分 from; per-stock createMany 幂等
      // on (instrumentId,date,shareholderName,contentHash); 嵌套 L/S/P payload Json 整存; SERIES 多 date 可回填)。
      shareholder_snapshot: this.factExecutor(
        'shareholder_snapshot',
        (instruments, dim, stats, input) =>
          this.syncShareholderSnapshot(instruments, dim, stats, input),
      ),
      // 042 T011 US3 员工 (照抄 revenue_segment/buyback 区间形态: mode 分 from; per-stock createMany 幂等
      // on (instrumentId,date,parentItemName,itemName,displayType); adapter 已展开 dataList typed 子行,
      // 头行判别/缺值 null/trim/displayType 进 NK 同名 number+percentage 两行共存)。
      employee: this.factExecutor('employee', (instruments, dim, stats, input) =>
        this.syncEmployee(instruments, dim, stats, input),
      ),
      // 043 T005 US1 所属行业 (覆盖式快照, 照抄 index_membership: 无 mode/无 date; per-instrument 单 tx
      // deleteMany({instrumentId})+createMany 原子替换; 空返回跳过不 wipe; NK (instrumentId,source,industryCode))。
      industry_classification: this.factExecutor(
        'industry_classification',
        (instruments, _dim, stats, input) =>
          this.syncIndustryClassification(instruments, stats, input),
      ),
      // 043 T008 US2 公告 (照抄 buyback 区间形态: mode 分 from; per-stock createMany 幂等 on
      // (instrumentId,date,linkUrl); linkUrl 天然唯一 NK 无需 hash; 超大表只存元数据 text[] types)。
      announcement: this.factExecutor('announcement', (instruments, dim, stats, input) =>
        this.syncAnnouncement(instruments, dim, stats, input),
      ),
      // 046 T008 标的级 IV 日快照: **走 factExecutor** ⇒ 工作集 = loadActiveInstruments
      // (`market ∈ {us} ∧ active ∧ needSync`) —— **无锚不采** (FR-026), 加第 13 只锚只需
      // 锚闸把它刷成 needSync, 零代码改动自动纳入 (FR-031)。
      // 🚨 与 `us_index_daily` **判据相反**, 别把两者写成同一形态: 那条是指数级、工作集 =
      // 两个固定代码常量, **不挂锚闸** (FR-027) —— 挂了零锚时会静默不跑。
      underlying_iv_daily: this.factExecutor(
        'underlying_iv_daily',
        (instruments, dim, stats, input) =>
          this.syncUnderlyingIvDaily(instruments, dim, stats, input),
      ),
      // 046 T013 美股波动率指数日线 (VIX / VVIX)。
      // 🚨 **刻意不走 `factExecutor`** —— 那条路径起手就 `loadActiveInstruments`
      // (`market ∈ scope ∧ active ∧ needSync`), 而本维度的两个代码**在 `Instrument` 表里根本
      // 不存在** (富途与东财均不收录, p3b E4/E26) ⇒ 工作集恒空 ⇒ **整个维度静默不跑**, 且不会
      // 红。它的工作集是 `US_INDEX_CODES` 两个常量, 与锚表无关 (FR-027 / plan D1); 形态上更接近
      // 上面 `universe` / `profile` 那类 meta 维度: 自己管自己的前置, 不吃 fact 前置那套
      // (tier 重算 / 锚闸重算跑了也不出错, 但会让「指数依赖锚表状态」这条假依赖在调用图上成立)。
      us_index_daily: (input) => this.syncUsIndexDaily(input),
      // 047 T015 M2b 链合约发现: **走 factExecutor** ⇒ 工作集 = loadActiveInstruments
      // (`market ∈ {us} ∧ active ∧ needSync`) —— per-code 接口, **无锚不采** (FR-035),
      // 加第 13 只锚只需锚闸把它刷成 needSync, 零代码改动自动纳入 (FR-038)。形态同 046 的
      // `underlying_iv_daily`, 与 `us_index_daily` 那条「不挂锚闸」判据相反, 别写成同一形态。
      // 返 true = vendor 限频预算耗尽 → 顺延重入队且不耗 attempts (deferral ≠ failure)。
      option_contract: this.factExecutor('option_contract', (instruments, dim, stats, input) =>
        this.syncOptionContract.run(instruments, dim, stats, input),
      ),
      // 047 T016 M2b 逐日快照: **同样走 factExecutor** (per-code 接口, 无锚不采) —— 但它的
      // 工作集实际是「锚的**合约**」: use case 内部再按 `underlying_instrument_id` +
      // 「到期日 ≥ 当前交易日」查 `option_contract`, 合约表无行 ⇒ 该票零外呼 (FR-031 的
      // hard 依赖落点)。cron 排在链发现之后 (T003 seed 的 priority 守卫)。
      // 返 true = vendor 限频预算耗尽 → 顺延重入队且不耗 attempts (deferral ≠ failure)。
      option_daily_snapshot: this.factExecutor(
        'option_daily_snapshot',
        (instruments, dim, stats, input) =>
          this.syncOptionSnapshot.run(instruments, dim, stats, input),
      ),
      // 047 T019 M2b 财报日历。🚨 **刻意不走 `factExecutor`** —— 那条路径起手就
      // `loadActiveInstruments` (`market ∈ scope ∧ active ∧ needSync`), 而本维度是**市场级**
      // 接口 (单次 ≤7 天窗返全市场), 工作集 = **固定前向时间窗序列**, 与锚表无关 (FR-035a)。
      // 挂上锚闸零收窄作用 (调用数只跟前向视野有关), 只会复刻「零锚时静默不采」那个坑, 且
      // **不会红**。判据是「接口是不是 per-code」, 不是「维度归属哪一片」—— 046 已在
      // `us_index_daily` 上订正过一次同形状问题, 本片是第三次。`market_scope` 对它**只是元数据**
      // (定业务日期时区 + 问哪个市场), 不用来推导工作集。形态同上面的 `us_index_daily`:
      // 自己管自己的前置, 不吃 fact 前置那套 (跑了也不出错, 但会让「财报依赖锚表状态」这条
      // 假依赖在调用图上成立)。返 true = vendor 限频预算耗尽 → 顺延重入队且不耗 attempts。
      earnings_event: async (input) => {
        const dim = await this.loadDimension('earnings_event');
        const stats = emptyStats();
        const budgetExhausted = await this.syncEarningsEvent.run(dim, stats, input);
        return { stats, budgetExhausted };
      },
    };
  }

  /**
   * fact 维度共用前置包装: tier 前置重算 (018 D1 单点, 4 维度 × 全触发路径起手取自选并集
   * 快照落 syncTier, 失败已内部降级返 null 不阻塞) + **采集闸重算** (045 T015: 按 optionsdesk
   * 锚表刷 needSync, 同样内部降级返 null 不阻塞) + 载 dim 行 + 工作集, 再进各维度逻辑。
   * 两个前置重算正交: needSync **筛范围**、syncTier 只**定顺序**, 故先后无关。
   * 返 true = 预算耗尽 (仅 eod_bar)。
   */
  private factExecutor(
    key: DimensionKey,
    run: (
      instruments: WorkingInstrument[],
      dim: ExecutorSyncDimensionRow,
      stats: SyncRunStats,
      input: ExecutorInput,
    ) => Promise<boolean | void>,
  ): DimensionExecutorFn {
    return async (input) => {
      await this.tierRecalc.recalcSafely();
      await this.anchorGate?.recalcSafely();
      const dim = await this.loadDimension(key);
      const instruments = await this.loadActiveInstruments(dim, input.markets);
      const stats = emptyStats();
      const exhausted = await run(instruments, dim, stats, input);
      return { stats, budgetExhausted: exhausted === true };
    };
  }

  /** 注册 executor (SC-S05 新维度接入面: 注册 + 一行 seed, 零 switch/常量改动)。 */
  registerExecutor(key: DimensionKey, fn: DimensionExecutorFn): void {
    this.executors.set(key, fn);
  }

  /**
   * 执行单维度: 自管 `sync:<dim>` SyncRun 行 (含 bullJobId 回链) + per-dim 降级告警;
   * 顶层异常收 failed 后上抛 (worker attempts 重试语义源)。`budgetExhausted` 顺延信号
   * 由 worker 消费 (D5, deferral ≠ failure 不耗 attempts)。
   */
  async execute(
    key: DimensionKey,
    input: ExecutorInput,
    bullJobId?: string,
  ): Promise<ExecutorResult> {
    const syncType = `sync:${key}`;
    const runId = await this.recorder.start(syncType, bullJobId);
    const stats = emptyStats();
    try {
      const result = await this.runDimension(key, input);
      mergeStats(stats, result.stats);
      // 🚨 **不传 input.now** —— 那是 job 起点, 传进去 finished_at 就等于 started_at,
      // 一轮跑了多久永远读不出来 (见 SyncRunRecorder.finish 注释)。默认取真实收尾时刻。
      await this.recorder.finish(runId, deriveStatus(stats), stats);
      this.alertIfDegraded(syncType, stats);
      return { stats, budgetExhausted: result.budgetExhausted };
    } catch (err) {
      // 顶层 (非 per-row) 异常: SyncRun 收为 failed, 不留 running 悬挂行 (016 范式)。
      await this.recorder.finish(runId, 'failed', stats);
      throw err;
    }
  }

  /** 维度路由 (019 T004 注册表): 未注册 key → 结构化报错 (SyncRun 收 failed, 不崩 worker)。 */
  private async runDimension(key: DimensionKey, input: ExecutorInput): Promise<ExecutorResult> {
    const executor = this.executors.get(key);
    if (!executor) {
      throw new Error(`维度 "${key}" 无注册 executor (seed 行存在但 executor 未注册, FR-S07)`);
    }
    return executor(input);
  }

  /** 载维度行 (executor 投影)。缺行 = seed 残缺 / 非法 job payload → 顶层 throw。 */
  private async loadDimension(key: DimensionKey): Promise<ExecutorSyncDimensionRow> {
    const row = await this.prisma.syncDimension.findUnique({ where: { dimensionKey: key } });
    if (!row) throw new Error(`SyncDimension "${key}" 不存在 (seed 缺行或非法维度键)`);
    return row;
  }

  /**
   * 同步工作集 = 黑名单外、市场落在本维度有效范围内的全活跃标的 (universe 已 upsert;
   * 黑名单命中不 insert)。038 seam#2: 市场范围从旧 `MARKET='cn'` 常量 → 维度级 `marketScope`
   * 列 (marketScope={cn} 无回归 / ={cn,hk} 纳入 hk)。038 seam#3: `markets` (CLI `--markets`
   * 透传) 非空时与 marketScope 取交集缩窄 (运维可只回填某市场); 缺省 → 用全 marketScope。
   * tier 序消费 (018 FR-S03): syncTier asc 优先 (T0 先吃令牌桶/预算), 同 tier 内 id 稳定序。
   * 采集闸 (`Instrument.needSync`): false 的标的**不进工作集** —— us 无锚不采 (仍全量入库供搜索),
   * cn/hk 全 true 故零回归。与 syncTier 正交: needSync **筛范围**、syncTier 只**定顺序**。
   */
  private async loadActiveInstruments(
    dim: ExecutorSyncDimensionRow,
    markets?: string[],
  ): Promise<WorkingInstrument[]> {
    const scope =
      markets && markets.length > 0
        ? dim.marketScope.filter((m) => markets.includes(m))
        : dim.marketScope;
    return this.prisma.instrument.findMany({
      where: { market: { in: scope }, status: 'active', needSync: true },
      select: { id: true, market: true, code: true },
      orderBy: [{ syncTier: 'asc' }, { id: 'asc' }],
    });
  }

  // ── eod_bar: per-instrument 拉 candlestick → DailyBar append (幂等) ──
  //
  // tier 序消费 (018 FR-S03): 按 syncTier asc 单序过共享双窗令牌桶 — T0 天然先吃预算,
  // maxEodInstruments 截断与顺延续跑按同一序生效 (T0 保底 = 排序推论, FR-S04 零新机制)。
  // **进度即幂等**: 跳过本目标日已有 DailyBar 的标的 (已同步不重复, 无谓重拉配额)。
  // **配额顺延** (水位): 本窗处理数达 `maxEodInstruments` → 停, 写 `SyncDimension.lastWatermark`
  // 记进度, 剩余标的计 skipped 顺延下窗 (下窗 pending 查询天然排除本窗已落库者)。
  // 返「预算耗尽」(D5 顺延信号, worker 据此 delayed re-enqueue)。
  //
  // **020 T008 写路径收窄 (FR-A01)**: 三模式全部只落 none 1 行/标的/日 — forward/backward
  // 读时换算 (020 T003), 019 推导段退役。delta 起手 D2 除权命中检查 (本地查零外呼, 019
  // 机制零碰): 平淡日恰 1 次 none; 命中标的 none + 1 次 transient 跃变锚定 (恰 2 次,
  // SC-A03); backfill = none 全历史 1 次 + 有除权史标的 backward transient 锚全部事件
  // 1 次 (零除权史跳过, ≤2 次/标的)。
  private async syncEodBars(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    ctx: {
      targetDate: string;
      mode: SyncMode;
      maxEodInstruments: number;
      backfillHistoryDays?: number;
      now: Date;
    },
  ): Promise<boolean> {
    const { targetDate, mode, maxEodInstruments, now } = ctx;
    const from =
      mode === 'backfill'
        ? subtractDays(targetDate, ctx.backfillHistoryDays ?? dim.historyDepth ?? 365)
        : deltaFrom(dim, targetDate);
    const backfillDays = ctx.backfillHistoryDays ?? dim.historyDepth ?? 365;

    // delta: 跳过已有 targetDate bar 的标的 (进度即幂等)。backfill: 全标的回填历史区间
    // (即便已有 targetDate bar 也要补历史 → 不跳过, skipDuplicates 兜重复)。
    // 有回看窗时游标不成立 → 全工作集重取 (见 deltaCursorUsable; 本维度 lookback 蓄意留 NULL,
    // 故当前逐行行为不变, 接线在此是为了「日后给本维度配了窗」不会静默走上不成立的游标)。
    const pending =
      mode === 'delta' && deltaCursorUsable(dim)
        ? await this.pendingEodInstruments(instruments, targetDate)
        : instruments;

    // D2 除权命中检查 (delta 起手本地查询, 零 vendor 外呼; backfill 不走)。
    const hitInstruments =
      mode === 'delta' ? await this.exDateHits(dim.lastWatermark, targetDate) : new Set<bigint>();

    let processed = 0;
    let exhausted = false;

    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    for (const inst of pending) {
      if (processed >= maxEodInstruments) {
        exhausted = true;
        break;
      }
      // 038 T017 (INV-3): 回填期自限速 (per-instrument), 叠加软护栏防风控; delta 不经此路径。
      if (mode === 'backfill') await this.backfillPacer.pace();
      stats.scanned++;
      try {
        // 三模式全部只落 none (FR-A01): delta 当日 1 行 / backfill 历史区间。
        addWritten(stats, await this.syncEodBarNone(inst, targetDate, from));
        if (mode === 'delta' && hitInstruments.has(inst.id)) {
          // 除权命中: + transient 跃变锚定 (恰 2 次/标的, SC-A03; 与 corp 扫描双点幂等)。
          const lookback = dim.reAdjustLookbackDays ?? DEFAULT_RE_ADJUST_LOOKBACK_DAYS;
          await this.anchorNewFactorVersion(inst, targetDate, lookback);
        } else if (mode === 'backfill') {
          // backfill: 有除权史标的 backward 全历史 transient 锚全部事件 (1 次; 零除权史
          // 跳过 — 无事件可锚, analyze L2)。
          const hasExHistory =
            (await this.prisma.corporateAction.count({ where: { instrumentId: inst.id } })) > 0;
          if (hasExHistory) await this.anchorNewFactorVersion(inst, targetDate, backfillDays);
        }
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({
          symbol: `${inst.market}:${inst.code}`,
          // 维度名取自入参而非字面量: 本方法被 eod_bar (cn/hk) 与 us_equity_bar 共用。
          step: dim.dimensionKey,
          error: String(err),
        });
      }
      processed++;
    }

    // 顺延: 预算耗尽 → 剩余标的计 skipped (非失败), 下窗续跑。
    if (exhausted) stats.skipped += pending.length - processed;

    // 补洞道 (delta 且预算未耗尽时): 捡回「当晚 vendor 还没出数」的那批。预算耗尽时不跑 ——
    // 那说明本窗连主跑都没做完, 该把额度留给顺延续跑, 而不是拿去补历史。
    if (mode === 'delta' && !exhausted) {
      await this.fillRecentEodGaps(dim, instruments, targetDate, stats);
    }
    // 水位推进 (本窗进度): 部分完成或全完成都记 lastWatermark = now (FR-S07/S14 续跑锚)。
    // 🚨 水位必须写回**本维度自己**的行。写死 'eod_bar' 会让 us_equity_bar 把水位写进
    // cn/hk 那一行 —— 而那个水位正是除权命中检查 (exDateHits) 的窗口起点, 串了会让 cn 的
    // 跃变锚定漏事件, 且完全静默。
    await this.prisma.syncDimension.update({
      where: { dimensionKey: dim.dimensionKey },
      data: { lastWatermark: now },
    });
    return exhausted;
  }

  /**
   * 补洞道: 回填最近 `EOD_GAP_FILL_LOOKBACK_DAYS` 个交易日里**缺 bar** 的标的 (delta 专用旁路)。
   *
   * ## 病灶: 当晚 vendor 还没出数的那批, 永远没有第二次机会
   *
   * `syncEodBarNone` 拿到空数组时 `return` (注释写「当日无 bar (停牌等)」) ⇒ 计 ok、零落库、
   * 无任何信号。但 22:00 CST 那一刻 vendor 对**一批 hk 标的**根本还没出数 —— 既不是停牌也不是
   * 失败, 只是**还没到**。而 delta 窗口是精确当日 (`from = to = asOf`) ⇒ 这天过去之后,
   * **再没有任何一次请求会问起它们**, 缺口永久且完全静默。
   *
   * 🚨 观测形态极具欺骗性, 三层信号会一致告诉你「健康」:
   *   · `sync:eod_bar` 天天 `scanned=8417 ok=8417 skip=0 fail=0` (空数组计 ok);
   *   · 表级探针判**数据年龄** —— 每天都在更新 ⇒ 恒绿;
   *   · 日报判 **run 成败** —— 全 ok ⇒ 恒绿。
   * 而 hk 每个交易日实际少约 18%。
   *
   * ## 为什么是 hk、为什么从 2026-07-14 起 (别把它当「一直如此」)
   *
   * prod `sync_run.scanned` 摆着变点: 07-09 及以前 = 5614 (**只有 cn**), 07-14 起 = 8399+
   * (cn+hk) —— 那正是 038 把维度 marketScope 扩到 `{cn, hk}`、hk 并入夜间 delta 的时点。
   * 07-13 及以前 hk 覆盖恒在 2636–2655 看着很健康, 但那是**回填**跑出来的 (宽窗 + 晚跑 ⇒ 数据
   * 已就绪); 一并入 22:00 的精确当日窗, 立刻掉到 2126–2215 并**再没回来过**。
   * ⇒ 病灶不是「hk 数据不好」, 是**「精确当日窗 + 空数组计 ok」这套组合撞上了披露更晚的市场**。
   * cn 不显形只是因为它的数据 22:00 就齐了 —— 同一套代码, 换个市场就漏, 这是本方法要防的形状。
   *
   * 2026-08-12 prod 取证: 在采 hk 标的 2783; 对 08-06 (一个「正常成功」的采集日, 当时 2155)
   * 重跑 delta —— `scanned=653 ok=653 failed=0`, 51 秒, hk **2155 → 2658**, 找回 503 根。
   * 另测出 vendor 约 **1–2 天**补齐: 08-11 (昨日) 当时重取仍是 2182, 而 08-04…08-10 都补到了
   * 2656–2660 ⇒ 7 天窗绰绰有余, 且缺口天然会「晚一两天」被这条旁路捡回。
   *
   * ## 为什么是旁路, 而不是给 eod_bar 配 `deltaLookbackDays`
   *
   * 那条路看起来更省事 (改一行 seed), 但 `deltaLookbackDays` 非 NULL ⇒ `deltaCursorUsable()`
   * 返 false ⇒ 关掉 `pendingEodInstruments`, 而它是**预算截断后顺延续跑的进度锚**: 关掉后下一窗
   * 会从全工作集头部重跑, 永远够不到被顺延的尾巴。2026-08-12 实测该改法打红 7 个 IT, 其中
   * 「① 分夜收敛」「② 下窗续跑」「T005 截断保底 + 顺延续跑」锁的就是这条不变量。
   * ⇒ 本方法走旁路, **主跑的游标语义一个字不动**。
   *
   * ## 判据: 分市场比「窗内应有交易日数」
   *
   * cn 与 hk 日历会错开 (国庆 / 重阳), 拿一个市场的日历判另一个市场必然造假缺口 ⇒ 逐市场算。
   * `DailyBar` 有 `@@unique([instrumentId, tradeDate, adjust])` ⇒ 按 instrument 数行数即等于
   * 去重交易日数, 无需 DISTINCT。
   *
   * 🚨 **日历为空 / 陈旧 ⇒ 本方法自然缩手, 不误补**: `expected` 取不到该市场就是 0, 没有标的会
   *    被判缺口。这是刻意的降级方向 —— 拿一张**可能已坏的表**当判据时, 宁可少补也不能乱补
   *    (乱补 = 对全工作集狂发请求)。`trading_day` 自身的陈旧由 044 日历健康探针独立看守,
   *    不在本方法里重判 (那会变成又一处循环信任)。代价: 日历坏掉期间缺口不再自愈, 但**也不会
   *    产生坏数据**, 且日历一恢复, 窗内的洞会在下一晚被重新看见。
   *
   * ⚠️ **长期停牌 / 已退市但仍在采的标的永远补不满** ⇒ 每晚都会被重问一次 (成本有界, 约等于
   *    缺口规模)。这是「保持追问」的代价, 刻意接受: 想收敛就得引入「放弃」判据, 而那会把
   *    「还没到」和「永远不会到」混在一起 —— 正是本病灶的形状。
   *
   * 复杂度: O(窗内交易日) + O(有 bar 的标的) 两次聚合查询 + O(缺口标的) 次 vendor 区间请求
   * (区间接口 1 次/标的, 与窗宽无关)。
   */
  private async fillRecentEodGaps(
    dim: ExecutorSyncDimensionRow,
    instruments: WorkingInstrument[],
    targetDate: string,
    stats: SyncRunStats,
  ): Promise<void> {
    if (instruments.length === 0) return;
    const from = subtractDays(targetDate, EOD_GAP_FILL_LOOKBACK_DAYS);

    // 🚨 判据查询失败 → WARN 后放弃本轮补洞, **不把整个维度判红**: 主跑 (真正的采集) 此刻
    //    已经成功了, 拿「治疗失败」去报「采集失败」是假警报, 而假警报会训练人无视这份报告。
    //    这不等于静默 —— 结果侧有**独立**看守: `marketdata-sync-report.sh` 的日频完整性闸判的是
    //    「库里到底缺不缺」, 不依赖本方法是否跑过。补洞道连着几晚没补上, 那道闸会自己红。
    let gappy: WorkingInstrument[];
    try {
      // 每市场在窗内应有的交易日数 (逐市场, 见上「判据」)。
      const days = await this.prisma.tradingDay.findMany({
        where: { date: { gte: toDateOnly(from), lte: toDateOnly(targetDate) } },
        select: { market: true },
      });
      const expected = new Map<string, number>();
      for (const d of days) expected.set(d.market, (expected.get(d.market) ?? 0) + 1);

      // 窗内每标的已有的 none bar 行数 (= 去重交易日数, 见上)。不加 `instrumentId IN (…)` ——
      // 工作集可达 8k+, 塞进 IN 会生成巨型语句; 分组结果本就只有几千行, 在 JS 侧按工作集过滤更省。
      const have = await this.prisma.dailyBar.groupBy({
        by: ['instrumentId'],
        where: {
          adjust: 'none',
          tradeDate: { gte: toDateOnly(from), lte: toDateOnly(targetDate) },
        },
        _count: { _all: true },
      });
      const haveByInstrument = new Map(have.map((h) => [h.instrumentId, h._count._all]));

      gappy = instruments.filter(
        (inst) => (haveByInstrument.get(inst.id) ?? 0) < (expected.get(inst.market) ?? 0),
      );
    } catch (err) {
      this.logger.warn(
        `eod 补洞道判据查询失败, 本轮跳过 (主跑不受影响; 缺口由日频完整性闸独立看守): ${String(err)}`,
      );
      return;
    }
    if (gappy.length === 0) return;

    // 🚨 截断必须可见 (见 EOD_GAP_FILL_MAX_INSTRUMENTS 注释)。
    const targets = gappy.slice(0, EOD_GAP_FILL_MAX_INSTRUMENTS);
    if (gappy.length > targets.length) {
      this.logger.warn(
        `eod 补洞道命中 ${gappy.length} 只 > 上限 ${EOD_GAP_FILL_MAX_INSTRUMENTS}, ` +
          `本窗只补前 ${targets.length} 只, 余 ${gappy.length - targets.length} 只留待下窗`,
      );
    }

    let filled = 0;
    for (const inst of targets) {
      try {
        addWritten(stats, await this.syncEodBarNone(inst, targetDate, from));
        filled++;
      } catch (err) {
        // 与主跑同口径计失败: 补洞期 vendor 挂了同样值得知道 (维度转 partial → 飞书红)。
        stats.failed++;
        stats.failedTargets.push({
          symbol: `${inst.market}:${inst.code}`,
          step: `${dim.dimensionKey}:gap-fill`,
          error: String(err),
        });
      }
    }
    this.logger.log(
      `eod 补洞道: 窗 [${from}, ${targetDate}] 命中 ${gappy.length} 只, 已补 ${filled} 只`,
    );
  }

  /**
   * D2 除权命中检查 (019 T010, 零 vendor 外呼): `corporateAction.exDate ∈ (上次 eod 水位日,
   * asOf]` 的标的集合 (命中 = 走全口径重拉 + reAdjustBars 全窗重算的 gate)。
   * 水位 NULL (首跑) → 空命中 (历史复权由 backfill/corp 扫描自愈路径承载, 不全量重拉)。
   * 未来 exDate 由 corp 周扫提前物化 — 到期日落入窗口即命中 (D2 可见性前提, T001 ③ 校真)。
   */
  private async exDateHits(lastWatermark: Date | null, asOf: string): Promise<Set<bigint>> {
    if (!lastWatermark) return new Set();
    const watermarkDate = toDateOnly(dateOnlyStr(lastWatermark));
    const rows = await this.prisma.corporateAction.findMany({
      where: { exDate: { gt: watermarkDate, lte: toDateOnly(asOf) } },
      select: { instrumentId: true },
    });
    return new Set(rows.map((r) => r.instrumentId));
  }

  /**
   * eod none 单口径落库 (020 T008, FR-A01): fetch [from, targetDate] none → 幂等落库
   * (尾窗可订正, 见 {@link writeDailyBarRows})。019 推导段 (none × 最新因子写 forward/backward 行) 退役 — forward/backward
   * 读时换算 (020 T003), DailyBar 收敛单口径事实表。
   */
  private async syncEodBarNone(
    inst: WorkingInstrument,
    targetDate: string,
    from: string,
  ): Promise<number> {
    const symbol = `${inst.market}:${inst.code}`;
    const bars = await this.eodBar.getBars({ symbol, adjust: 'none', from, to: targetDate });
    if (bars.length === 0) return 0; // 当日无 bar (停牌等) — 零落库。
    return writeDailyBarRows(
      this.prisma,
      bars.map((b) => toDailyBarRow(inst.id, b)),
    );
  }

  /**
   * 本目标日尚无 **none 口径** DailyBar 的标的 (resume 锚: 已落库者本窗不重拉, 满足
   * 「已同步不重复」)。020 后写路径只产 none — none 在场即已同步。
   */
  private async pendingEodInstruments(
    instruments: WorkingInstrument[],
    targetDate: string,
  ): Promise<WorkingInstrument[]> {
    const done = await this.prisma.dailyBar.findMany({
      where: { tradeDate: toDateOnly(targetDate), adjust: 'none' },
      select: { instrumentId: true },
      distinct: ['instrumentId'],
    });
    const doneSet = new Set(done.map((d) => d.instrumentId));
    return instruments.filter((i) => !doneSet.has(i.id));
  }

  // ── short_selling: per-instrument 拉做空日频区间 → ShortSellingDaily createMany (幂等), uk (instrumentId, date) ──
  //
  // 039 T006 US1 (照抄 eod_bar 区间形态): mode 分 from —— delta 抓当日 (from=asOf), backfill 回填
  // [asOf−historyDepth, asOf] 多年日频。delta 跳本目标日已落行的标的 (进度即幂等, 镜像
  // pendingEodInstruments); backfill 全标的。per-stock HTTP 在 tx 外 (FR-S10) + per-instrument 隔离
  // (单股失败不连坐); 行按 BACKFILL_ROW_CHUNK 分批 createMany(skipDuplicates) 幂等 (做空历史某日定值 →
  // insert-only 语义正确, 避大区间单 tx 撞 5s 超时, 同 backfillFinancials)。backfill 前 pacer.pace()。
  private async syncShortSelling(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<void> {
    const from =
      input.mode === 'backfill'
        ? subtractDays(input.asOf, input.backfillHistoryDays ?? dim.historyDepth ?? 3650)
        : deltaFrom(dim, input.asOf);
    const pending =
      input.mode === 'delta' && deltaCursorUsable(dim)
        ? await this.pendingShortSellingInstruments(instruments, input.asOf)
        : instruments;

    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    for (const inst of pending) {
      if (input.mode === 'backfill') await this.backfillPacer.pace(); // 038 T017 (INV-3): 回填自限速。
      const symbol = `${inst.market}:${inst.code}`;
      stats.scanned++;
      try {
        const points = await this.shortSelling.getShortSellingRange({
          symbol,
          from,
          to: input.asOf,
        }); // HTTP (tx 外)
        const rows = points.map((p) => ({
          instrumentId: inst.id,
          date: toDateOnly(p.date),
          shares: p.shares,
          amount: p.amount,
        }));
        // 行分批: 每 BACKFILL_ROW_CHUNK 行一 $transaction (封顶 tx 时长/内存); 空返回 → 零 createMany。
        for (const rowChunk of chunked(rows, BACKFILL_ROW_CHUNK)) {
          await this.prisma.$transaction(async (tx) => {
            addWritten(
              stats,
              (await tx.shortSellingDaily.createMany({ data: rowChunk, skipDuplicates: true }))
                .count,
            );
          });
        }
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol, step: 'short_selling', error: String(err) });
      }
    }
  }

  /** 本目标日尚无 ShortSellingDaily 行的标的 (delta resume 锚: 已落库者本窗不重拉, 镜像 pendingEodInstruments)。 */
  private async pendingShortSellingInstruments(
    instruments: WorkingInstrument[],
    targetDate: string,
  ): Promise<WorkingInstrument[]> {
    const done = await this.prisma.shortSellingDaily.findMany({
      where: { date: toDateOnly(targetDate) },
      select: { instrumentId: true },
      distinct: ['instrumentId'],
    });
    const doneSet = new Set(done.map((d) => d.instrumentId));
    return instruments.filter((i) => !doneSet.has(i.id));
  }

  // ── buyback: per-instrument 拉回购事件区间 → BuybackEvent createMany (幂等), uk (instrumentId, date, vendorEventId) ──
  //
  // 041 T005 US1 (照抄 short_selling/eod_bar 区间形态): mode 分 from —— delta 抓当日 (from=asOf),
  // backfill 回填 [asOf−historyDepth(3650, ~10yr), asOf] 多年回购事件。delta 跳本目标日已落行的标的
  // (进度即幂等, 镜像 pendingShortSellingInstruments); backfill 全标的。per-stock HTTP 在 tx 外 (FR-S10)
  // + per-instrument 隔离 (单股失败不连坐); 行按 BACKFILL_ROW_CHUNK 分批 createMany(skipDuplicates) 幂等
  // (回购历史某日事件定值 → insert-only 语义正确, 避大区间单 tx 撞 5s 超时, 同 backfillFinancials)。
  // 丰富 typed 列: num/totalSharesFor* 为 BigInt? 股数列 (toBigIntOrNull 转换), highestPrice/lowestPrice/
  // avgPrice/totalPaid/ratioPurchasedSinceResolution 为 Decimal? 列 (string 直落), methodOfPurchase/
  // currency/boardType 为 VarChar? 文本列。无回购历史标的空返回 → 零 createMany 不崩。backfill 前 pacer.pace()。
  // C1 扩键 (T018 真调实证同日多笔真实存在: 汇丰 00005 同日两市场回购): vendorEventId (vendor `_id`) 进自然键
  // (instrumentId, date, vendorEventId) → 同日不同笔各落行、同 `_id` 重同步 skipDuplicates 折叠幂等。
  private async syncBuyback(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<void> {
    const from =
      input.mode === 'backfill'
        ? subtractDays(input.asOf, input.backfillHistoryDays ?? dim.historyDepth ?? 3650)
        : deltaFrom(dim, input.asOf);
    const pending =
      input.mode === 'delta' && deltaCursorUsable(dim)
        ? await this.pendingBuybackInstruments(instruments, input.asOf)
        : instruments;

    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    for (const inst of pending) {
      if (input.mode === 'backfill') await this.backfillPacer.pace(); // 038 T017 (INV-3): 回填自限速。
      const symbol = `${inst.market}:${inst.code}`;
      stats.scanned++;
      try {
        const events = await this.buyback.getBuybackRange({ symbol, from, to: input.asOf }); // HTTP (tx 外)
        const rows = events.map((e) => ({
          instrumentId: inst.id,
          date: toDateOnly(e.date),
          vendorEventId: e.vendorEventId, // C1 自然键判别字段 (vendor `_id`)。
          num: toBigIntOrNull(e.num),
          highestPrice: e.highestPrice,
          lowestPrice: e.lowestPrice,
          avgPrice: e.avgPrice,
          totalPaid: e.totalPaid,
          totalSharesForCancellation: toBigIntOrNull(e.totalSharesForCancellation),
          totalSharesForTreasury: toBigIntOrNull(e.totalSharesForTreasury),
          ratioPurchasedSinceResolution: e.ratioPurchasedSinceResolution,
          methodOfPurchase: e.methodOfPurchase,
          currency: e.currency,
          boardType: e.boardType,
        }));
        // 行分批: 每 BACKFILL_ROW_CHUNK 行一 $transaction (封顶 tx 时长/内存); 空返回 → 零 createMany。
        for (const rowChunk of chunked(rows, BACKFILL_ROW_CHUNK)) {
          await this.prisma.$transaction(async (tx) => {
            addWritten(
              stats,
              (await tx.buybackEvent.createMany({ data: rowChunk, skipDuplicates: true })).count,
            );
          });
        }
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol, step: 'buyback', error: String(err) });
      }
    }
  }

  /** 本目标日尚无 BuybackEvent 行的标的 (delta resume 锚, 镜像 pendingShortSellingInstruments)。 */
  private async pendingBuybackInstruments(
    instruments: WorkingInstrument[],
    targetDate: string,
  ): Promise<WorkingInstrument[]> {
    const done = await this.prisma.buybackEvent.findMany({
      where: { date: toDateOnly(targetDate) },
      select: { instrumentId: true },
      distinct: ['instrumentId'],
    });
    const doneSet = new Set(done.map((d) => d.instrumentId));
    return instruments.filter((i) => !doneSet.has(i.id));
  }

  // ── equity_change: per-instrument 拉股本变动事件区间 → EquityChange createMany (幂等), uk (instrumentId, date) ──
  //
  // 041 T008 US2 (照抄 syncBuyback 区间形态): mode 分 from —— delta 抓当日 (from=asOf), backfill 回填
  // [asOf−historyDepth(3650, ~10yr), asOf] 多年股本变动事件。delta 跳本目标日已落行的标的 (进度即幂等,
  // 镜像 pendingBuybackInstruments); backfill 全标的。per-stock HTTP 在 tx 外 (FR-S10) + per-instrument
  // 隔离 (单股失败不连坐); 行按 BACKFILL_ROW_CHUNK 分批 createMany(skipDuplicates) 幂等 (股本变动历史某日
  // 定值 → insert-only 语义正确, 避大区间单 tx 撞 5s 超时, 同 syncBuyback)。扁平列: capitalization/
  // capitalizationH 为 Decimal? 列 (string 直落), changeReason 为 VarChar? 文本列, declarationDate 为
  // 可空 Date 列 (toDateOnly 转换, 缺失 null)。无股本变动历史标的空返回 → 零 createMany 不崩。backfill 前 pacer.pace()。
  // ⚠️ 同日多事件: 当前 NK (instrumentId,date) skipDuplicates 落定行为, 真实同日基数待 T018 真调核
  // (plan Deferred-probe, C1 护栏; 撞则扩键加判别字段, 本 PR 未 merge 前可调)。
  private async syncEquityChange(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<void> {
    const from =
      input.mode === 'backfill'
        ? subtractDays(input.asOf, input.backfillHistoryDays ?? dim.historyDepth ?? 3650)
        : deltaFrom(dim, input.asOf);
    const pending =
      input.mode === 'delta' && deltaCursorUsable(dim)
        ? await this.pendingEquityChangeInstruments(instruments, input.asOf)
        : instruments;

    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    for (const inst of pending) {
      if (input.mode === 'backfill') await this.backfillPacer.pace(); // 038 T017 (INV-3): 回填自限速。
      const symbol = `${inst.market}:${inst.code}`;
      stats.scanned++;
      try {
        const events = await this.equityChange.getEquityChangeRange({
          symbol,
          from,
          to: input.asOf,
        }); // HTTP (tx 外)
        const rows = events.map((e) => ({
          instrumentId: inst.id,
          date: toDateOnly(e.date),
          capitalization: e.capitalization,
          capitalizationH: e.capitalizationH,
          changeReason: e.changeReason,
          declarationDate: e.declarationDate ? toDateOnly(e.declarationDate) : null,
        }));
        // 行分批: 每 BACKFILL_ROW_CHUNK 行一 $transaction (封顶 tx 时长/内存); 空返回 → 零 createMany。
        for (const rowChunk of chunked(rows, BACKFILL_ROW_CHUNK)) {
          await this.prisma.$transaction(async (tx) => {
            addWritten(
              stats,
              (await tx.equityChange.createMany({ data: rowChunk, skipDuplicates: true })).count,
            );
          });
        }
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol, step: 'equity_change', error: String(err) });
      }
    }
  }

  /** 本目标日尚无 EquityChange 行的标的 (delta resume 锚, 镜像 pendingBuybackInstruments)。 */
  private async pendingEquityChangeInstruments(
    instruments: WorkingInstrument[],
    targetDate: string,
  ): Promise<WorkingInstrument[]> {
    const done = await this.prisma.equityChange.findMany({
      where: { date: toDateOnly(targetDate) },
      select: { instrumentId: true },
      distinct: ['instrumentId'],
    });
    const doneSet = new Set(done.map((d) => d.instrumentId));
    return instruments.filter((i) => !doneSet.has(i.id));
  }

  // ── shareholder_change: per-instrument 拉股东权益变动事件区间 → ShareholderChange createMany (幂等), uk (instrumentId, date, shareholderName, contentHash) ──
  //
  // 041 T011 US3 (照抄 syncBuyback/syncEquityChange 区间形态): mode 分 from —— delta 抓当日 (from=asOf),
  // backfill 回填 [asOf−historyDepth(3650, ~10yr), asOf] 多年大股东权益变动事件。delta 跳本目标日已落行的
  // 标的 (进度即幂等, 镜像 pendingEquityChangeInstruments); backfill 全标的。per-stock HTTP 在 tx 外 (FR-S10)
  // + per-instrument 隔离 (单股失败不连坐); 行按 BACKFILL_ROW_CHUNK 分批 createMany(skipDuplicates) 幂等。
  // **4 维度里唯一有嵌套结构的维度** (plan Decision 4): shareholderName + contentHash 进自然键 (同日多大股东
  // 各一行; C1 扩键: contentHash 判别同名同日多笔申报, T018 真调实证 JPMorgan 09988 同日 3 笔 involved 不同);
  // payload 落 Prisma.InputJsonValue (vendor 原始行整存无损含 numOfSharesInvolvedList, 照 hot_snapshot payload
  // 范式) — 缺 L 或 S 值 / 缺字段由 adapter 层归一存 null 不崩 (FR-007)。contentHash 由 adapter 算 (见 vendor
  // 原始行)。无股东权益变动历史标的空返回 → 零 createMany 不崩。backfill 前 pacer.pace()。
  private async syncShareholderChange(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<void> {
    const from =
      input.mode === 'backfill'
        ? subtractDays(input.asOf, input.backfillHistoryDays ?? dim.historyDepth ?? 3650)
        : deltaFrom(dim, input.asOf);
    const pending =
      input.mode === 'delta' && deltaCursorUsable(dim)
        ? await this.pendingShareholderChangeInstruments(instruments, input.asOf)
        : instruments;

    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    for (const inst of pending) {
      if (input.mode === 'backfill') await this.backfillPacer.pace(); // 038 T017 (INV-3): 回填自限速。
      const symbol = `${inst.market}:${inst.code}`;
      stats.scanned++;
      try {
        const events = await this.shareholderChange.getShareholderChangeRange({
          symbol,
          from,
          to: input.asOf,
        }); // HTTP (tx 外)
        const rows = events.map((e) => ({
          instrumentId: inst.id,
          date: toDateOnly(e.date),
          shareholderName: e.shareholderName,
          contentHash: e.contentHash, // C1 自然键判别字段 (vendor 原始行 hashdiff)。
          // vendor 原始行整存 payload Json (无损容纳 L/S 及潜在第三类 P + numOfSharesInvolvedList, plan Decision 4)。
          payload: e.payload as Prisma.InputJsonValue,
        }));
        // 行分批: 每 BACKFILL_ROW_CHUNK 行一 $transaction (封顶 tx 时长/内存); 空返回 → 零 createMany。
        for (const rowChunk of chunked(rows, BACKFILL_ROW_CHUNK)) {
          await this.prisma.$transaction(async (tx) => {
            addWritten(
              stats,
              (await tx.shareholderChange.createMany({ data: rowChunk, skipDuplicates: true }))
                .count,
            );
          });
        }
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol, step: 'shareholder_change', error: String(err) });
      }
    }
  }

  /** 本目标日尚无 ShareholderChange 行的标的 (delta resume 锚, 镜像 pendingEquityChangeInstruments)。 */
  private async pendingShareholderChangeInstruments(
    instruments: WorkingInstrument[],
    targetDate: string,
  ): Promise<WorkingInstrument[]> {
    const done = await this.prisma.shareholderChange.findMany({
      where: { date: toDateOnly(targetDate) },
      select: { instrumentId: true },
      distinct: ['instrumentId'],
    });
    const doneSet = new Set(done.map((d) => d.instrumentId));
    return instruments.filter((i) => !doneSet.has(i.id));
  }

  // ── allotment: per-instrument 拉配股事件区间 → AllotmentEvent createMany (幂等), uk (instrumentId, date) ──
  //
  // 041 T014 US4 (照抄 syncBuyback 区间形态): mode 分 from —— delta 抓当日 (from=asOf), backfill 回填
  // [asOf−historyDepth(3650, ~10yr), asOf] 多年配股事件。delta 跳本目标日已落行的标的 (进度即幂等, 镜像
  // pendingBuybackInstruments); backfill 全标的。per-stock HTTP 在 tx 外 (FR-S10) + per-instrument 隔离
  // (单股失败不连坐); 行按 BACKFILL_ROW_CHUNK 分批 createMany(skipDuplicates) 幂等。**港股配股极罕见零样本**
  // (plan Decision 5 + US4/SC-004): payload 落 Prisma.InputJsonValue (vendor 原始行整存无损, 字段 schema
  // 未知, 照 shareholder_change/hot payload 范式)。**预期多数标的 vendor 返 0 行** → 空返回 → chunked([]) 空 →
  // 零 createMany, stats.ok++ (非 failed, 优雅收敛不崩不阻塞其余标的)。backfill 前 pacer.pace()。
  private async syncAllotment(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<void> {
    const from =
      input.mode === 'backfill'
        ? subtractDays(input.asOf, input.backfillHistoryDays ?? dim.historyDepth ?? 3650)
        : deltaFrom(dim, input.asOf);
    const pending =
      input.mode === 'delta' && deltaCursorUsable(dim)
        ? await this.pendingAllotmentInstruments(instruments, input.asOf)
        : instruments;

    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    for (const inst of pending) {
      if (input.mode === 'backfill') await this.backfillPacer.pace(); // 038 T017 (INV-3): 回填自限速。
      const symbol = `${inst.market}:${inst.code}`;
      stats.scanned++;
      try {
        const events = await this.allotment.getAllotmentRange({ symbol, from, to: input.asOf }); // HTTP (tx 外)
        const rows = events.map((e) => ({
          instrumentId: inst.id,
          date: toDateOnly(e.date), // vendor `date` = 公告日 (自然键), 非除权日。
          // exDate 才是除权日 (复权因子版本边界); vendor 可缺 → null (35/545 实测)。
          exDate: e.exDate ? toDateOnly(e.exDate) : null,
          allotmentRatio: e.allotmentRatio,
          allotmentPrice: e.allotmentPrice,
          currency: e.currency,
          // 提列列之外的字段 (allotmentShares 等) 靠 payload 整存无损保留 (plan Decision 5)。
          payload: e.payload as Prisma.InputJsonValue,
        }));
        // 行分批: 每 BACKFILL_ROW_CHUNK 行一 $transaction; 空返回 (港股极罕见配股零样本) → chunked([]) 空 → 零 createMany。
        for (const rowChunk of chunked(rows, BACKFILL_ROW_CHUNK)) {
          await this.prisma.$transaction(async (tx) => {
            addWritten(
              stats,
              (await tx.allotmentEvent.createMany({ data: rowChunk, skipDuplicates: true })).count,
            );
          });
        }
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol, step: 'allotment', error: String(err) });
      }
    }
  }

  /** 本目标日尚无 AllotmentEvent 行的标的 (delta resume 锚, 镜像 pendingBuybackInstruments)。 */
  private async pendingAllotmentInstruments(
    instruments: WorkingInstrument[],
    targetDate: string,
  ): Promise<WorkingInstrument[]> {
    const done = await this.prisma.allotmentEvent.findMany({
      where: { date: toDateOnly(targetDate) },
      select: { instrumentId: true },
      distinct: ['instrumentId'],
    });
    const doneSet = new Set(done.map((d) => d.instrumentId));
    return instruments.filter((i) => !doneSet.has(i.id));
  }

  // ── revenue_segment: per-instrument 拉营收构成报告期区间 → RevenueSegment createMany (幂等), uk (instrumentId, date, parentItemName, itemName) ──
  //
  // 042 T005 US1 (照抄 syncBuyback 区间形态): mode 分 from —— delta 抓当期 (from=asOf), backfill 回填
  // [asOf−historyDepth(3650, ~10yr), asOf] 多年报告期分部营收。delta 跳本目标日已落行的标的 (进度即幂等,
  // 镜像 pendingBuybackInstruments); backfill 全标的。per-stock HTTP 在 tx 外 (FR-S10) + per-instrument 隔离
  // (单股失败不连坐); 行按 BACKFILL_ROW_CHUNK 分批 createMany(skipDuplicates) 幂等 (报告期分部营收定值 →
  // insert-only 语义正确, 避大区间单 tx 撞 5s 超时, 同 syncBuyback)。adapter 已展开 dataList typed 子行
  // (头行判别: 纯头行跳/有 parent 缺 value 落 null/顶层有 value 行 parentItemName 哨兵 ''/key trim 归一/revenue
  // signed 负, plan Decision 3); date/declarationDate 已 HK-aware 归一 (adapter 层 lixDateOnlyHk, M1)。扁平 typed
  // 列: revenue/costs 为 Decimal?(24,2) 列 (signed, string 直落), grossProfitMargin 为 Decimal?(10,6) 列,
  // parentItemName/itemName 为 VarChar NOT NULL (顶层行哨兵 ''), declarationDate 为可空 Date 列 (toDateOnly 转换,
  // 缺失 null), currency 为 VarChar? 文本列。无营收披露标的空返回 → 零 createMany 不崩。backfill 前 pacer.pace()。
  private async syncRevenueSegment(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<void> {
    const from =
      input.mode === 'backfill'
        ? subtractDays(input.asOf, input.backfillHistoryDays ?? dim.historyDepth ?? 3650)
        : deltaFrom(dim, input.asOf);
    const pending =
      input.mode === 'delta' && deltaCursorUsable(dim)
        ? await this.pendingRevenueSegmentInstruments(instruments, input.asOf)
        : instruments;

    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    for (const inst of pending) {
      if (input.mode === 'backfill') await this.backfillPacer.pace(); // 038 T017 (INV-3): 回填自限速。
      const symbol = `${inst.market}:${inst.code}`;
      stats.scanned++;
      try {
        const segments = await this.revenueSegment.getRevenueSegmentRange({
          symbol,
          from,
          to: input.asOf,
        }); // HTTP (tx 外)
        const rows = segments.map((s) => ({
          instrumentId: inst.id,
          date: toDateOnly(s.date),
          declarationDate: s.declarationDate ? toDateOnly(s.declarationDate) : null,
          currency: s.currency,
          parentItemName: s.parentItemName, // 顶层行哨兵 '' 由 adapter 归一 (NK 列 NOT NULL)。
          itemName: s.itemName,
          revenue: s.revenue, // Decimal? 列 (signed, string 直落)
          costs: s.costs,
          grossProfitMargin: s.grossProfitMargin,
        }));
        // 行分批: 每 BACKFILL_ROW_CHUNK 行一 $transaction (封顶 tx 时长/内存); 空返回 → 零 createMany。
        for (const rowChunk of chunked(rows, BACKFILL_ROW_CHUNK)) {
          await this.prisma.$transaction(async (tx) => {
            addWritten(
              stats,
              (await tx.revenueSegment.createMany({ data: rowChunk, skipDuplicates: true })).count,
            );
          });
        }
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol, step: 'revenue_segment', error: String(err) });
      }
    }
  }

  /** 本目标日尚无 RevenueSegment 行的标的 (delta resume 锚, 镜像 pendingBuybackInstruments)。 */
  private async pendingRevenueSegmentInstruments(
    instruments: WorkingInstrument[],
    targetDate: string,
  ): Promise<WorkingInstrument[]> {
    const done = await this.prisma.revenueSegment.findMany({
      where: { date: toDateOnly(targetDate) },
      select: { instrumentId: true },
      distinct: ['instrumentId'],
    });
    const doneSet = new Set(done.map((d) => d.instrumentId));
    return instruments.filter((i) => !doneSet.has(i.id));
  }

  // ── shareholder_snapshot: per-instrument 拉最新股东报告期区间 → ShareholderSnapshot createMany (幂等), uk (instrumentId, date, shareholderName, contentHash) ──
  //
  // 042 T008 US2 (照抄 syncShareholderChange 区间形态, 复用 041 payload+contentHash 范式): mode 分 from ——
  // delta 抓当期 (from=asOf), backfill 回填 [asOf−historyDepth(3650, ~10yr), asOf] 多年报告期股东名册。delta
  // 跳本目标日已落行的标的 (进度即幂等, 镜像 pendingShareholderChangeInstruments); backfill 全标的。per-stock
  // HTTP 在 tx 外 (FR-S10) + per-instrument 隔离 (单股失败不连坐); 行按 BACKFILL_ROW_CHUNK 分批
  // createMany(skipDuplicates) 幂等。**嵌套结构维度** (plan Decision 4, 复用 041): shareholderName + contentHash
  // 进自然键 (同日多大股东各一行; C1 扩键: contentHash 判别同名同日多笔, 内容全同折叠、实质差异保留);
  // payload 落 Prisma.InputJsonValue (vendor 原始行整存无损含嵌套 L/S/P 数组, 照 shareholder_change payload
  // 范式) — 缺 L/S/P 值 / 缺字段由 adapter 层归一存 null 不崩 (FR-007)。contentHash 由 adapter 算 (见 vendor
  // 原始行)。**probe verified SERIES**: 多个不同 date 行都落 (报告期×股东序列, date 进自然键可回填历史)。
  // 无最新股东历史标的空返回 → 零 createMany 不崩。backfill 前 pacer.pace()。
  private async syncShareholderSnapshot(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<void> {
    const from =
      input.mode === 'backfill'
        ? subtractDays(input.asOf, input.backfillHistoryDays ?? dim.historyDepth ?? 3650)
        : deltaFrom(dim, input.asOf);
    const pending =
      input.mode === 'delta' && deltaCursorUsable(dim)
        ? await this.pendingShareholderSnapshotInstruments(instruments, input.asOf)
        : instruments;

    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    for (const inst of pending) {
      if (input.mode === 'backfill') await this.backfillPacer.pace(); // 038 T017 (INV-3): 回填自限速。
      const symbol = `${inst.market}:${inst.code}`;
      stats.scanned++;
      try {
        const rows0 = await this.shareholderSnapshot.getShareholderSnapshotRange({
          symbol,
          from,
          to: input.asOf,
        }); // HTTP (tx 外)
        const rows = rows0.map((e) => ({
          instrumentId: inst.id,
          date: toDateOnly(e.date),
          shareholderName: e.shareholderName,
          contentHash: e.contentHash, // C1 自然键判别字段 (vendor 原始行 hashdiff)。
          // vendor 原始行整存 payload Json (无损容纳嵌套 L/S 及潜在第三类 P, plan Decision 4)。
          payload: e.payload as Prisma.InputJsonValue,
        }));
        // 行分批: 每 BACKFILL_ROW_CHUNK 行一 $transaction (封顶 tx 时长/内存); 空返回 → 零 createMany。
        for (const rowChunk of chunked(rows, BACKFILL_ROW_CHUNK)) {
          await this.prisma.$transaction(async (tx) => {
            addWritten(
              stats,
              (await tx.shareholderSnapshot.createMany({ data: rowChunk, skipDuplicates: true }))
                .count,
            );
          });
        }
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol, step: 'shareholder_snapshot', error: String(err) });
      }
    }
  }

  /** 本目标日尚无 ShareholderSnapshot 行的标的 (delta resume 锚, 镜像 pendingShareholderChangeInstruments)。 */
  private async pendingShareholderSnapshotInstruments(
    instruments: WorkingInstrument[],
    targetDate: string,
  ): Promise<WorkingInstrument[]> {
    const done = await this.prisma.shareholderSnapshot.findMany({
      where: { date: toDateOnly(targetDate) },
      select: { instrumentId: true },
      distinct: ['instrumentId'],
    });
    const doneSet = new Set(done.map((d) => d.instrumentId));
    return instruments.filter((i) => !doneSet.has(i.id));
  }

  // ── employee: per-instrument 拉员工报告期区间 → EmployeeSnapshot createMany (幂等), uk (instrumentId, date, parentItemName, itemName, displayType) ──
  //
  // 042 T011 US3 (照抄 syncRevenueSegment/syncBuyback 区间形态): mode 分 from —— delta 抓当期 (from=asOf),
  // backfill 回填 [asOf−historyDepth(3650, ~10yr), asOf] 多年报告期员工数据。delta 跳本目标日已落行的标的
  // (进度即幂等, 镜像 pendingRevenueSegmentInstruments); backfill 全标的。per-stock HTTP 在 tx 外 (FR-S10)
  // + per-instrument 隔离 (单股失败不连坐); 行按 BACKFILL_ROW_CHUNK 分批 createMany(skipDuplicates) 幂等
  // (报告期员工数据定值 → insert-only 语义正确, 避大区间单 tx 撞 5s 超时, 同 syncRevenueSegment)。adapter 已展开
  // dataList typed 子行 (头行判别: 纯头行跳/有 parent 缺 value 落 null/顶层有 value 行 parentItemName 哨兵 ''/
  // key trim 归一, plan Decision 3); date/declarationDate 已 HK-aware 归一 (adapter 层 lixDateOnlyHk, M1)。**扁平
  // typed 列**: value 为 Decimal?(20,4) 列 (headcount 或 percentage, string 直落), parentItemName/itemName/displayType
  // 为 VarChar NOT NULL (顶层行 parentItemName 哨兵 '', displayType 进 NK), declarationDate 为可空 Date 列
  // (toDateOnly 转换, 缺失 null)。**displayType 进自然键** (Decision 6, probe 实证同名 (parent,item) 出 number+
  // percentage 两行, 如「流失率按性别分‖男性」= {58812 number, 15.2 percentage}): NK 含 displayType → 两行各落、
  // 不折叠 (adapter 层不去重、executor 忠实透传)。无员工披露标的空返回 → 零 createMany 不崩。backfill 前 pacer.pace()。
  private async syncEmployee(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<void> {
    const from =
      input.mode === 'backfill'
        ? subtractDays(input.asOf, input.backfillHistoryDays ?? dim.historyDepth ?? 3650)
        : deltaFrom(dim, input.asOf);
    const pending =
      input.mode === 'delta' && deltaCursorUsable(dim)
        ? await this.pendingEmployeeInstruments(instruments, input.asOf)
        : instruments;

    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    for (const inst of pending) {
      if (input.mode === 'backfill') await this.backfillPacer.pace(); // 038 T017 (INV-3): 回填自限速。
      const symbol = `${inst.market}:${inst.code}`;
      stats.scanned++;
      try {
        const employees = await this.employee.getEmployeeRange({
          symbol,
          from,
          to: input.asOf,
        }); // HTTP (tx 外)
        const rows = employees.map((e) => ({
          instrumentId: inst.id,
          date: toDateOnly(e.date),
          declarationDate: e.declarationDate ? toDateOnly(e.declarationDate) : null,
          parentItemName: e.parentItemName, // 顶层行哨兵 '' 由 adapter 归一 (NK 列 NOT NULL)。
          itemName: e.itemName,
          displayType: e.displayType, // NK 判别字段 (number/percentage), 同名两行经此共存。
          value: e.value, // Decimal? 列 (headcount/percentage, string 直落)
        }));
        // 行分批: 每 BACKFILL_ROW_CHUNK 行一 $transaction (封顶 tx 时长/内存); 空返回 → 零 createMany。
        for (const rowChunk of chunked(rows, BACKFILL_ROW_CHUNK)) {
          await this.prisma.$transaction(async (tx) => {
            addWritten(
              stats,
              (await tx.employeeSnapshot.createMany({ data: rowChunk, skipDuplicates: true }))
                .count,
            );
          });
        }
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol, step: 'employee', error: String(err) });
      }
    }
  }

  /** 本目标日尚无 EmployeeSnapshot 行的标的 (delta resume 锚, 镜像 pendingRevenueSegmentInstruments)。 */
  private async pendingEmployeeInstruments(
    instruments: WorkingInstrument[],
    targetDate: string,
  ): Promise<WorkingInstrument[]> {
    const done = await this.prisma.employeeSnapshot.findMany({
      where: { date: toDateOnly(targetDate) },
      select: { instrumentId: true },
      distinct: ['instrumentId'],
    });
    const doneSet = new Set(done.map((d) => d.instrumentId));
    return instruments.filter((i) => !doneSet.has(i.id));
  }

  // ── connect_holding: per-instrument 拉南向持股日频区间 → ConnectHoldingDaily createMany (幂等), uk (instrumentId, date) ──
  //
  // 039 T007 US1 (同 syncShortSelling 形态): 仅 ~600 港股通标的有数据, 非港股通标的 vendor 返 0 行 →
  // `points=[]` → chunked([]) 空 → 零 createMany, stats.ok++ (非 failed, spec state_branch「南向非成分
  // 标的空数据」)。mode 分 from / delta pending-skip / per-instrument 隔离 / 分批 createMany 均同 short_selling。
  private async syncConnectHolding(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<void> {
    const from =
      input.mode === 'backfill'
        ? subtractDays(input.asOf, input.backfillHistoryDays ?? dim.historyDepth ?? 3650)
        : // T+1 披露: delta 回看补昨日未发布行 (窗宽由 dim.deltaLookbackDays 定, 见 deltaFrom)。
          deltaFrom(dim, input.asOf);
    const pending =
      input.mode === 'delta' && deltaCursorUsable(dim)
        ? await this.pendingConnectHoldingInstruments(instruments, input.asOf)
        : instruments;

    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    for (const inst of pending) {
      if (input.mode === 'backfill') await this.backfillPacer.pace(); // 038 T017 (INV-3): 回填自限速。
      const symbol = `${inst.market}:${inst.code}`;
      stats.scanned++;
      try {
        const points = await this.connectHolding.getConnectHoldingRange({
          symbol,
          from,
          to: input.asOf,
        }); // HTTP (tx 外)
        const rows = points.map((p) => ({
          instrumentId: inst.id,
          date: toDateOnly(p.date),
          shareholdings: p.shareholdings,
        }));
        // 非港股通标的 points=[] → chunked([]) 空 → 零 createMany (零落库不崩)。
        for (const rowChunk of chunked(rows, BACKFILL_ROW_CHUNK)) {
          await this.prisma.$transaction(async (tx) => {
            addWritten(
              stats,
              (await tx.connectHoldingDaily.createMany({ data: rowChunk, skipDuplicates: true }))
                .count,
            );
          });
        }
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol, step: 'connect_holding', error: String(err) });
      }
    }
  }

  /** 本目标日尚无 ConnectHoldingDaily 行的标的 (delta resume 锚, 镜像 pendingShortSellingInstruments)。 */
  private async pendingConnectHoldingInstruments(
    instruments: WorkingInstrument[],
    targetDate: string,
  ): Promise<WorkingInstrument[]> {
    const done = await this.prisma.connectHoldingDaily.findMany({
      where: { date: toDateOnly(targetDate) },
      select: { instrumentId: true },
      distinct: ['instrumentId'],
    });
    const doneSet = new Set(done.map((d) => d.instrumentId));
    return instruments.filter((i) => !doneSet.has(i.id));
  }

  // ── volatility: per-instrument × 多窗口拉波动率日频区间 → VolatilityDaily createMany (幂等), uk (instrumentId, date, volatilityDays) ──
  //
  // 040 T005 US1 (照抄 eod_bar/short_selling 区间形态 × VOLATILITY_WINDOWS 多窗口循环): mode 分 from ——
  // delta 抓当日 (from=asOf), backfill 回填 [asOf−historyDepth(3650, ~10yr), asOf] 多年日频。**每窗口一次
  // 独立请求** (理杏仁 volatilityDays 单数 number) → 落 (instrumentId, date, volatilityDays) 行 (窗口数 = 行
  // 倍数)。delta 跳本目标日已落全部窗口的标的 (多窗口幂等锚, 镜像 pendingEodInstruments); backfill 全标的。
  // per-stock HTTP 在 tx 外 (FR-S10) + per-instrument 隔离 (单股失败不连坐, 3 窗口任一抛 → 计 failed);
  // 行按 BACKFILL_ROW_CHUNK 分批 createMany(skipDuplicates) 幂等 (波动率历史某日某窗定值 → insert-only,
  // 避大区间单 tx 撞 5s 超时)。**backfillPacer.pace() per-窗口** (backfill 每次 vendor 调用前 await ——
  // 波动率 3× 请求数须 3× 节流护共享令牌桶, plan Decision 4「回填 per-stock × 3 窗口 = 3× 请求数」)。
  private async syncVolatility(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<void> {
    const from =
      input.mode === 'backfill'
        ? subtractDays(input.asOf, input.backfillHistoryDays ?? dim.historyDepth ?? 3650)
        : deltaFrom(dim, input.asOf);
    const pending =
      input.mode === 'delta' && deltaCursorUsable(dim)
        ? await this.pendingVolatilityInstruments(instruments, input.asOf)
        : instruments;

    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    for (const inst of pending) {
      const symbol = `${inst.market}:${inst.code}`;
      stats.scanned++;
      try {
        // 多窗口: 对每个 VOLATILITY_WINDOWS 独立请求 (volatilityDays 单数 number) → 各落一批
        // (instrumentId, date, volatilityDays) 行。
        for (const window of VOLATILITY_WINDOWS) {
          if (input.mode === 'backfill') await this.backfillPacer.pace(); // 038 T017 (INV-3): per-窗口自限速。
          const points = await this.volatility.getVolatilityRange({
            symbol,
            volatilityDays: window,
            from,
            to: input.asOf,
          }); // HTTP (tx 外)
          const rows = points.map((p) => ({
            instrumentId: inst.id,
            date: toDateOnly(p.date),
            volatilityDays: window,
            value: p.value,
          }));
          // 行分批: 每 BACKFILL_ROW_CHUNK 行一 $transaction; 空返回 → 零 createMany。
          for (const rowChunk of chunked(rows, BACKFILL_ROW_CHUNK)) {
            await this.prisma.$transaction(async (tx) => {
              addWritten(
                stats,
                (await tx.volatilityDaily.createMany({ data: rowChunk, skipDuplicates: true }))
                  .count,
              );
            });
          }
        }
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol, step: 'volatility', error: String(err) });
      }
    }
  }

  /**
   * 本目标日尚未落**全部** VOLATILITY_WINDOWS 窗口行的标的 (delta resume 锚, 多窗口幂等版):
   * 缺任一窗口即视为 pending (重拉, skipDuplicates 兜已落窗口)。全窗覆盖才算「本目标日已同步」,
   * 避部分窗口落库后被永久跳过留窗口缺口 (镜像 pendingEodInstruments, 但按自然键含 volatilityDays)。
   */
  private async pendingVolatilityInstruments(
    instruments: WorkingInstrument[],
    targetDate: string,
  ): Promise<WorkingInstrument[]> {
    const done = await this.prisma.volatilityDaily.findMany({
      where: { date: toDateOnly(targetDate) },
      select: { instrumentId: true, volatilityDays: true },
    });
    const doneWindows = new Map<bigint, Set<number>>();
    for (const r of done) {
      const set = doneWindows.get(r.instrumentId) ?? new Set<number>();
      set.add(r.volatilityDays);
      doneWindows.set(r.instrumentId, set);
    }
    return instruments.filter((i) => {
      const set = doneWindows.get(i.id);
      return !set || VOLATILITY_WINDOWS.some((w) => !set.has(w));
    });
  }

  // ── hot_snapshot: per-instrument × HOT_TYPES 拉当前快照 → HotSnapshot upsert (按 dataDate 累积), uk (instrumentId, hotType, dataDate) ──
  //
  // 040 T008 US2 (第 2 形态, 异于 volatility 的区间日频): **无 mode 分支 / 无 date** —— vendor hot/{type}
  // 忽略请求日期永返最新快照 (1 行/股, 含 last_data_date)。对 HOT_TYPES=['ss','tr','capita','rep'] (adapter
  // 常量) 循环、每 type 一请求当前快照 → 按自然键 (instrumentId, hotType, dataDate=last_data_date) **upsert**:
  // 数据日期未变=幂等覆盖同行 (payload 更新为最新)、变=落新行 (随各 type 更新频率自建前向序列 tr 日频/capita
  // 年度, plan Decision 3/4)。**不回填历史** (vendor 快照无历史, history_depth=NULL)。payload 整存 vendor 原始
  // 异构字段 (每 type 结构不同, 忽略 undefined key 已由 adapter 层处理; 样板 CorporateAction.payload)。
  // **per-type 隔离** (FR-007「不阻塞其余 type」): 某 type vendor 抛错 → 捕获计 failed **不 mutate**, 不影响
  // 该股其余 type / 其余股。backfillPacer.pace() per-type (每次 vendor 调用前, hot 无 mode 恒限速, 同 index_membership)。
  private async syncHotSnapshot(
    instruments: WorkingInstrument[],
    stats: SyncRunStats,
    _input: ExecutorInput,
  ): Promise<void> {
    // #138: 本维度有写路径 ⇒ 起手声明一次, 让「工作集为空 / vendor 零行」的一轮报 0 而非
    // null —— 「跑了、一行没写」正是本列要抓的形态, 与「没上报」必须可分辨。
    addWritten(stats, 0);
    for (const inst of instruments) {
      const symbol = `${inst.market}:${inst.code}`;
      for (const hotType of HOT_TYPES) {
        await this.backfillPacer.pace(); // 038 T017 (INV-3): 每 type (每次 vendor 调用) 前自限速 (hot 无 mode 恒限速)。
        stats.scanned++;
        try {
          // per-stock 单只传入 → dtos ≤ 1 (vendor 1 行/股); 空返回 (某标的某 type 无数据) → 零 upsert 不崩。
          const dtos = await this.hotSnapshot.getHotSnapshot({ hotType, stockCodes: [symbol] }); // HTTP (tx 外)
          if (dtos.length === 0) {
            stats.ok++;
            continue;
          }
          await this.prisma.$transaction(async (tx) => {
            for (const d of dtos) {
              const dataDate = toDateOnly(d.dataDate);
              const payload = d.payload as Prisma.InputJsonValue;
              // 按自然键 upsert: 同 dataDate 命中→覆盖 payload (最新值)、新 dataDate→落新行 (前向累积)。
              await tx.hotSnapshot.upsert({
                where: {
                  instrumentId_hotType_dataDate: { instrumentId: inst.id, hotType, dataDate },
                },
                create: { instrumentId: inst.id, hotType, dataDate, payload },
                update: { payload },
              });
            }
          });
          // #138: 逐行 upsert 按行计 —— per-stock 单只传入 ⇒ dtos ≤ 1, 稳态每 type 各 1 行。
          // 🚨 口径不分 insert / update ⇒ 本维度**每晚恒等于当轮拿到的行数**, 它抓不到
          // 「覆盖了但内容没变」。抓得到的是「vendor 整轮返空」(dtos 恒 0 ⇒ written 0)。
          addWritten(stats, dtos.length);
          stats.ok++;
        } catch (err) {
          // per-type 隔离: 某 type 抛错计 failed 不 mutate, 不阻塞其余 type / 其余股 (FR-007)。
          stats.failed++;
          stats.failedTargets.push({ symbol, step: `hot_snapshot:${hotType}`, error: String(err) });
        }
      }
    }
  }

  // ── fund_holding: per-instrument 拉公募基金持股报告期区间 → FundHolding createMany (幂等), uk (instrumentId, reportDate, fundCode) ──
  //
  // 039 T011 US2 (行处理照 backfillFinancials; from 按 mode 算 per plan Decision 2): backfill 回填
  // [asOf−historyDepth(1825, 近 5 年), asOf] 报告期序列 (报告期×基金); delta 近窗单日 (from=asOf)。
  // ⚠️ 基金表「新鲜度」靠**周期性 re-backfill**, 非夜间 delta: 2026-07-13 prod 真调 (hk:00700) 实证
  // 报告期 date 严格季度末, 而 declarationDate (公告日) 滞后季度末 ~2 个月 (reportDate 06-30 → 08-30),
  // 区间按 reportDate 过滤 → delta 单日近窗几乎永不命中新公告数据 (季末当天该季尚未披露)。故 delta
  // 是安全空转 (不误拉/不崩), 新数据由周期 backfill 经 skipDuplicates 补入。
  // **真·大表** (2026-07-13 真调: hk:00700 单股 13322 行/3.5yr → 5yr ~19k) → 行按 BACKFILL_ROW_CHUNK 分片, 每片一 $transaction createMany
  // (skipDuplicates 天然幂等: 历史某报告期某基金持仓定值 → insert-only 语义正确; 封顶 tx 时长/内存,
  // 同 backfillFinancials)。per-stock HTTP 在 tx 外 (FR-S10) + per-instrument 隔离 (单股失败不连坐);
  // 缺字段 (marketCapRank/declarationDate/proportionOutstandingSharesA 等) 存 null 不崩。backfill 前 pacer.pace()。
  // NB: `coveredFundHoldingIds` skip-complete 游标 (tasks T011「可选」) 暂缓 —— 全量多夜回填是后续 ops
  // (master INV-3, Out-of-Scope); chunked tx 已封顶单事务, 重跑 skipDuplicates 幂等。大表重跑提效可后补
  // (镜像 coveredFundamentalIds)。
  private async syncFundHolding(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<void> {
    const from =
      input.mode === 'backfill'
        ? subtractDays(input.asOf, input.backfillHistoryDays ?? dim.historyDepth ?? 1825)
        : deltaFrom(dim, input.asOf); // delta = 近窗单日 (plan Decision 2; 本维度 lookback 蓄意留 NULL)。

    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    for (const inst of instruments) {
      if (input.mode === 'backfill') await this.backfillPacer.pace(); // 038 T017 (INV-3): 回填自限速。
      const symbol = `${inst.market}:${inst.code}`;
      stats.scanned++;
      try {
        const dtos = await this.fundHolding.getFundHoldingRange({ symbol, from, to: input.asOf }); // HTTP (tx 外)
        const rows = dtos.map((d) => ({
          instrumentId: inst.id,
          reportDate: toDateOnly(d.reportDate),
          fundCode: d.fundCode,
          name: d.name,
          holdings: d.holdings,
          marketCap: d.marketCap,
          netValueRatio: d.netValueRatio,
          marketCapRank: d.marketCapRank,
          proportionOutstandingSharesA: d.proportionOutstandingSharesA,
          declarationDate: d.declarationDate ? toDateOnly(d.declarationDate) : null,
        }));
        // 大表分片: 每 BACKFILL_ROW_CHUNK 行一 $transaction (封顶 tx 时长/内存); 空返回 → 零 createMany。
        for (const rowChunk of chunked(rows, BACKFILL_ROW_CHUNK)) {
          await this.prisma.$transaction(async (tx) => {
            addWritten(
              stats,
              (await tx.fundHolding.createMany({ data: rowChunk, skipDuplicates: true })).count,
            );
          });
        }
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol, step: 'fund_holding', error: String(err) });
      }
    }
  }

  // ── fund_company_holding: per-instrument 拉基金公司持股报告期区间 → FundCompanyHolding createMany (幂等), uk (instrumentId, reportDate, fundCollectionCode) ──
  //
  // 039 T012 US2 (同 syncFundHolding 形态, 更简: 无 marketCapRank/declarationDate/proportion): backfill
  // 回填 [asOf−historyDepth(1825), asOf] 报告期序列 (报告期×基金公司); delta 近窗单日 (同 fund_holding:
  // 报告期季频 + 公告滞后 ~2mo → delta 单日近窗空转, 新鲜度靠周期 re-backfill, 2026-07-13 prod 真调实证)。
  // 行按 BACKFILL_ROW_CHUNK 分片 createMany(skipDuplicates); per-instrument 隔离; 缺字段 null 不崩。
  private async syncFundCompanyHolding(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<void> {
    const from =
      input.mode === 'backfill'
        ? subtractDays(input.asOf, input.backfillHistoryDays ?? dim.historyDepth ?? 1825)
        : deltaFrom(dim, input.asOf); // delta = 近窗单日 (plan Decision 2; 本维度 lookback 蓄意留 NULL)。

    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    for (const inst of instruments) {
      if (input.mode === 'backfill') await this.backfillPacer.pace(); // 038 T017 (INV-3): 回填自限速。
      const symbol = `${inst.market}:${inst.code}`;
      stats.scanned++;
      try {
        const dtos = await this.fundCompanyHolding.getFundCompanyHoldingRange({
          symbol,
          from,
          to: input.asOf,
        }); // HTTP (tx 外)
        const rows = dtos.map((d) => ({
          instrumentId: inst.id,
          reportDate: toDateOnly(d.reportDate),
          fundCollectionCode: d.fundCollectionCode,
          name: d.name,
          holdings: d.holdings,
          marketCap: d.marketCap,
        }));
        // 分片: 每 BACKFILL_ROW_CHUNK 行一 $transaction (封顶 tx 时长/内存); 空返回 → 零 createMany。
        for (const rowChunk of chunked(rows, BACKFILL_ROW_CHUNK)) {
          await this.prisma.$transaction(async (tx) => {
            addWritten(
              stats,
              (await tx.fundCompanyHolding.createMany({ data: rowChunk, skipDuplicates: true }))
                .count,
            );
          });
        }
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol, step: 'fund_company_holding', error: String(err) });
      }
    }
  }

  // ── index_membership: per-instrument 拉当前所属指数快照 → 覆盖式 deleteMany+createMany, uk (instrumentId, indexCode) ──
  //
  // 039 T015 US3 (第 3 形态, 异于其他 4 维): **无 mode 分支 / 无 date** —— vendor indices 端点返当前成分
  // 快照 (无历史), 恒取全量当前归属集合, 覆盖式反映最新 (旧归属被删, profile 富化式非 append backfill)。
  // per-instrument 单 $transaction 内 deleteMany({instrumentId}) + createMany(newSet) 原子替换 (中途失败
  // 整股回滚, 不留半量)。per-instrument 隔离: 单股 vendor 抛错 → 捕获计 failed **不 mutate** (tx 未开,
  // 旧归属保留不被误删)。backfillPacer.pace() per-stock: index 是全域一次性扫 (每股一 HTTP), 恒限速防 429。
  //
  // ⚠️ 空返回语义 (plan Deferred-probe #2, T019 真调定): vendor 返 [] = 真无归属 vs transient blip 未定
  //    → **interim: 空返回跳过 mutate (不 wipe), 计 ok** (保守: 不因疑似瞬时空响应误清既有归属; 从未有
  //    归属的股 deleteMany([])+createMany([]) 本就零行, 二者等价; 唯一差别在「曾有归属→突返空」时保留旧行)。
  private async syncIndexMembership(
    instruments: WorkingInstrument[],
    stats: SyncRunStats,
    _input: ExecutorInput,
  ): Promise<void> {
    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    for (const inst of instruments) {
      await this.backfillPacer.pace(); // 038 T017 (INV-3): 全域扫每股自限速 (index 无 delta/backfill 分, 恒限速)。
      const symbol = `${inst.market}:${inst.code}`;
      stats.scanned++;
      try {
        const dtos = await this.indexMembership.getIndexMembership(symbol); // HTTP (tx 外)
        // 空返回 → 跳过 (interim, 见方法头注释): 不 deleteMany 以免瞬时空响应误 wipe 既有归属。
        if (dtos.length === 0) {
          stats.ok++;
          continue;
        }
        const rows = dtos.map((d) => ({
          instrumentId: inst.id,
          indexCode: d.indexCode,
          name: d.name,
          source: d.source,
          areaCode: d.areaCode,
        }));
        // 覆盖式: 单 tx 内清本股旧归属 + 灌当前快照 (原子替换, 反映最新)。
        await this.prisma.$transaction(async (tx) => {
          await tx.indexMembership.deleteMany({ where: { instrumentId: inst.id } });
          addWritten(
            stats,
            (await tx.indexMembership.createMany({ data: rows, skipDuplicates: true })).count,
          );
        });
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol, step: 'index_membership', error: String(err) });
      }
    }
  }

  // ── industry_classification: per-instrument 拉当前所属行业快照 → 覆盖式 deleteMany+createMany,
  //    uk (instrumentId, source, industryCode) ──
  //
  // 043 T005 US1 (覆盖式快照, 照抄 039 syncIndexMembership): **无 mode 分支 / 无 date** —— vendor
  // industries 端点返当前所属行业快照 (无历史; 00700 → hsi 3 级层级 3 行 H70/H7020/H702015), 恒取全量
  // 当前归属集合, 覆盖式反映最新 (旧归属被删)。per-instrument 单 $transaction 内 deleteMany({instrumentId})
  // + createMany(newSet) 原子替换 (中途失败整股回滚, 不留半量)。per-instrument 隔离: 单股 vendor 抛错 →
  // 捕获计 failed **不 mutate** (tx 未开, 旧归属保留不被误删)。backfillPacer.pace() per-stock: 全域一次性
  // 扫 (每股一 HTTP), 恒限速防 429 (同 index_membership)。
  //
  // ⚠️ 空返回语义 (plan Decision 3, 同 index_membership Deferred-probe #2): vendor 返 [] = 真无归属 vs
  //    transient blip 未定 → **interim: 空返回跳过 mutate (不 wipe), 计 ok** (保守: 不因疑似瞬时空响应误清
  //    既有归属; 从未有归属的股 deleteMany([])+createMany([]) 本零行, 二者等价; 差别仅「曾有归属→突返空」保留旧行)。
  //
  // NK 组件 source/industryCode DB 列 NOT NULL (probe 恒有值) → DTO 跨边界 string|null 缺失落 sentinel ''
  // (plan Decision 3), name/areaCode 缺失落 null。
  private async syncIndustryClassification(
    instruments: WorkingInstrument[],
    stats: SyncRunStats,
    _input: ExecutorInput,
  ): Promise<void> {
    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    for (const inst of instruments) {
      await this.backfillPacer.pace(); // 全域扫每股自限速 (industry 无 delta/backfill 分, 恒限速)。
      const symbol = `${inst.market}:${inst.code}`;
      stats.scanned++;
      try {
        const dtos = await this.industryClassification.getIndustryClassification(symbol); // HTTP (tx 外)
        // 空返回 → 跳过 (interim, 见方法头注释): 不 deleteMany 以免瞬时空响应误 wipe 既有归属。
        if (dtos.length === 0) {
          stats.ok++;
          continue;
        }
        const rows = dtos.map((d) => ({
          instrumentId: inst.id,
          source: d.source ?? '', // NK 组件 NOT NULL → 缺失落 sentinel '' (probe 恒 hsi)。
          industryCode: d.industryCode ?? '', // NK 组件 NOT NULL → 缺失落 sentinel '' (probe 恒 H70 等)。
          name: d.name,
          areaCode: d.areaCode,
        }));
        // 覆盖式: 单 tx 内清本股旧归属 + 灌当前快照 (原子替换, 反映最新)。
        await this.prisma.$transaction(async (tx) => {
          await tx.industryClassification.deleteMany({ where: { instrumentId: inst.id } });
          addWritten(
            stats,
            (await tx.industryClassification.createMany({ data: rows, skipDuplicates: true }))
              .count,
          );
        });
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol, step: 'industry_classification', error: String(err) });
      }
    }
  }

  // ── announcement: per-instrument 拉公告流区间 → Announcement createMany (幂等), uk (instrumentId, date, linkUrl) ──
  //
  // 043 T008 US2 (照抄 041 syncBuyback 区间形态): mode 分 from —— delta 抓当日 (from=asOf), backfill 回填
  // [asOf−historyDepth(3650, ~10yr), asOf] 多年公告流。delta 跳本目标日已落行的标的 (进度即幂等, 镜像
  // pendingBuybackInstruments); backfill 全标的。per-stock HTTP 在 tx 外 (FR-S10) + per-instrument 隔离
  // (单股失败不连坐); 行按 BACKFILL_ROW_CHUNK 分批 createMany(skipDuplicates) 幂等 (公告历史某日某文档定值 →
  // insert-only 语义正确, 避大区间单 tx 撞 5s 超时, 同 syncBuyback)。**本 feature 唯一潜在超大表** (~3M 行/全
  // 港股 10yr, HK 数据集最大表) → **只存元数据不存 PDF 正文**: 列 linkUrl/linkText/linkType 为 VarChar? 文本
  // 列, types 为 Postgres text[] (string[] 直落, 缺→[])。**NK (instrumentId,date,linkUrl)**: linkUrl 是 HKEX
  // 文档全局唯一 URL (probe 433/433 unique) → 同日不同 linkUrl 各落行 (不折叠丢真行)、同 linkUrl 重同步
  // skipDuplicates 折叠幂等, **无需 vendorEventId/contentHash** (异于 buyback/shareholder)。**≤10yr 硬上限**
  // (>10yr → 403): backfill from=asOf−3650 天然卡限内, adapter 不构造超 10yr 区间。无公告标的空返回 → 零
  // createMany 不崩。backfill 前 pacer.pace()。
  private async syncAnnouncement(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<void> {
    const from =
      input.mode === 'backfill'
        ? subtractDays(input.asOf, input.backfillHistoryDays ?? dim.historyDepth ?? 3650)
        : deltaFrom(dim, input.asOf);
    const pending =
      input.mode === 'delta' && deltaCursorUsable(dim)
        ? await this.pendingAnnouncementInstruments(instruments, input.asOf)
        : instruments;

    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    for (const inst of pending) {
      if (input.mode === 'backfill') await this.backfillPacer.pace(); // 038 T017 (INV-3): 回填自限速。
      const symbol = `${inst.market}:${inst.code}`;
      stats.scanned++;
      try {
        const anns = await this.announcement.getAnnouncementRange({
          symbol,
          from,
          to: input.asOf,
        }); // HTTP (tx 外)
        const rows = anns.map((a) => ({
          instrumentId: inst.id,
          date: toDateOnly(a.date),
          linkUrl: a.linkUrl, // NK 判别字段 (HKEX 文档全局唯一 URL)。
          linkText: a.linkText,
          linkType: a.linkType,
          types: a.types, // text[] 列 (string[] 直落, 缺→[])。
        }));
        // 行分批: 每 BACKFILL_ROW_CHUNK 行一 $transaction (封顶 tx 时长/内存); 空返回 → 零 createMany。
        for (const rowChunk of chunked(rows, BACKFILL_ROW_CHUNK)) {
          await this.prisma.$transaction(async (tx) => {
            addWritten(
              stats,
              (await tx.announcement.createMany({ data: rowChunk, skipDuplicates: true })).count,
            );
          });
        }
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol, step: 'announcement', error: String(err) });
      }
    }
  }

  /** 本目标日尚无 Announcement 行的标的 (delta resume 锚, 镜像 pendingBuybackInstruments)。 */
  private async pendingAnnouncementInstruments(
    instruments: WorkingInstrument[],
    targetDate: string,
  ): Promise<WorkingInstrument[]> {
    const done = await this.prisma.announcement.findMany({
      where: { date: toDateOnly(targetDate) },
      select: { instrumentId: true },
      distinct: ['instrumentId'],
    });
    const doneSet = new Set(done.map((d) => d.instrumentId));
    return instruments.filter((i) => !doneSet.has(i.id));
  }

  // ── fundamental: delta 批量拉最新快照 upsert / backfill 逐股区间回填历史 createMany, uk (instrumentId, date) ──
  //
  // 038 T014: delta (夜间) 走批量 `date:'latest'` 前向累积 (016 语义不变); backfill 走 T013
  // per-stock 区间模式拉 [from, asOf] **多行日频历史** (10yr 回填). marketScope 纳 hk 已由 T001
  // seam 在 loadActiveInstruments 生效 (hk 标的经工作集进入), 本方法市场无关。
  private async syncFundamentals(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<void> {
    if (input.mode === 'backfill') {
      await this.backfillFundamentals(instruments, dim, stats, input);
      return;
    }
    const idBySymbol = symbolIndex(instruments);
    // #138: 本维度有写路径 ⇒ 起手声明一次, 让「工作集为空 / vendor 零行」的一轮报 0 而非
    // null —— 「跑了、一行没写」正是本列要抓的形态, 与「没上报」必须可分辨。
    addWritten(stats, 0);
    for (const chunk of chunked(instruments, dim.batchSize)) {
      const symbols = chunk.map((i) => `${i.market}:${i.code}`);
      stats.scanned += chunk.length;
      try {
        const dtos = await this.fundamental.getFundamentals(symbols); // HTTP (tx 外)
        let upserted = 0;
        await this.prisma.$transaction(async (tx) => {
          for (const d of dtos) {
            const instrumentId = idBySymbol.get(d.symbol);
            if (instrumentId === undefined) continue;
            const date = toDateOnly(d.date);
            const data = fundamentalUpsertData(d);
            await tx.fundamentalSnapshot.upsert({
              where: { instrumentId_date: { instrumentId, date } },
              create: { instrumentId, date, ...data },
              update: data,
            });
            upserted++;
          }
        });
        // #138: 逐行 upsert 按**发生了写操作的行**计 (insert 与 update 都算, 口径见 addWritten)。
        // 计 upserted 而非 dtos.length —— 后者含 symbol 对不上工作集、被 continue 掉的行。
        addWritten(stats, upserted);
        stats.ok += chunk.length;
      } catch (err) {
        stats.failed += chunk.length;
        stats.failedTargets.push({
          symbol: `${symbols[0]}..${chunk.length}`,
          step: 'fundamental',
          error: String(err),
        });
      }
    }
  }

  /**
   * fundamental backfill (038 T014, seam#4 消费): per-instrument 逐股拉 [from, asOf] 区间历史
   * (T013 `getFundamentalsRange`) → 批量 `createMany(skipDuplicates)` on (instrumentId,date) uk
   * **多行日频** (镜像 eod_bar `syncEodBarNone`)。HTTP 在 tx 外 (FR-S10); per-instrument 隔离
   * (单股失败不连坐); 字段缺失 (P2 分位) 存 null 不崩 (沿 015)。
   *
   * **为何 createMany 而非逐行 upsert** (fix/marketdata-backfill-createmany): 历史某日估值不可变
   * (某日 PE/PB 定值), insert-only (skipDuplicates 跳已存、只补缺) 语义正确且与 eod_bar 一致 —
   * 逐行 `upsert × ~2400 行/10yr` 塞进单 `$transaction` 会撞 Prisma 默认 5s 事务超时回滚 (prod
   * 实证: 60 只长历史 hk 标的 6-11s 超时 → 缺口, median 1634 行 vs 健康 2404), bulk insert 一次
   * 落库无此问题。
   *
   * **2026-07-12 P1 incident 后加固**: 单条 createMany 塞全股历史, 在 1.6GB host 上「全 2781 股
   * 全量重跑」会累积 OOM (skipDuplicates 只跳 DB 写、不省 fetch/marshal/conflict-check)。改两层:
   * (1) 按 `BACKFILL_ROW_CHUNK` 行分批, 每片一 `$transaction`; (2) `coveredFundamentalIds`
   * skip-complete 游标 — 老端已回填的股本窗跳过 (连 HTTP 都省), 重跑只 fetch+写缺口股。
   */
  private async backfillFundamentals(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<void> {
    const from = subtractDays(input.asOf, input.backfillHistoryDays ?? dim.historyDepth ?? 365);
    // skip-complete (incident 2026-07-12 P1): 老端已回填的股本窗跳过, 重跑只 fetch+写缺口股 →
    // 补缺口不再全 2781 股扫 → 避 1.6GB host 累积 OOM。--no-skip-complete (force-refetch) → 空
    // covered 集 = 全股重扫, 补中段缺日 (skipDuplicates 兜已存; 见 ExecutorInput.noSkipComplete)。
    const covered = input.noSkipComplete
      ? new Set<bigint>()
      : await this.coveredFundamentalIds(
          instruments.map((i) => i.id),
          from,
        );
    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    for (const inst of instruments) {
      if (covered.has(inst.id)) {
        stats.skipped++;
        continue;
      }
      await this.backfillPacer.pace(); // 038 T017 (INV-3): 回填期自限速, 叠加软护栏防风控。
      const symbol = `${inst.market}:${inst.code}`;
      stats.scanned++;
      try {
        const dtos = await this.fundamental.getFundamentalsRange({ symbol, from, to: input.asOf }); // HTTP (tx 外)
        const rows = dtos.map((d) => ({
          instrumentId: inst.id,
          date: toDateOnly(d.date),
          ...fundamentalUpsertData(d),
        }));
        // 行分批: 每 BACKFILL_ROW_CHUNK 行一个 $transaction (封顶 tx 时长 + 单批内存);
        // skipDuplicates: 历史不可变 → 跳已存补缺, 天然幂等 (重跑不翻倍)。
        for (const rowChunk of chunked(rows, BACKFILL_ROW_CHUNK)) {
          await this.prisma.$transaction(async (tx) => {
            addWritten(
              stats,
              (await tx.fundamentalSnapshot.createMany({ data: rowChunk, skipDuplicates: true }))
                .count,
            );
          });
        }
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol, step: 'fundamental', error: String(err) });
      }
    }
  }

  /**
   * backfill skip-complete 锚 (incident 2026-07-12 P1): 已有 `date <= from+grace` fundamental 行的
   * 标的 = 老端历史已回填过 → 本窗跳过 (思路镜像 eod_bar `pendingEodInstruments`, 但 fundamental 靠
   * 「老端覆盖」而非「当日已落」)。⚠️ 不用「有行就跳」朴素判据 — nightly delta 给全标的都写近端行,
   * 缺口股 (缺的是老端) 会被误跳; 「老端有行」才是「历史已回填」的真信号。
   * grace-window (`+SKIP_COMPLETE_GRACE_DAYS` 天, 见该常量注释) 吸收 from 边界漂移: 精确 `from` 会把
   * 最早行落在 from 之后几天的完整股误判未回填 → 白重拉 (2026-07-13 实测)。单次 bulk 查询 (非逐股 N 次)。
   */
  private async coveredFundamentalIds(instrumentIds: bigint[], from: string): Promise<Set<bigint>> {
    if (instrumentIds.length === 0) return new Set();
    const rows = await this.prisma.fundamentalSnapshot.findMany({
      where: {
        instrumentId: { in: instrumentIds },
        date: { lte: toDateOnly(addDays(from, SKIP_COMPLETE_GRACE_DAYS)) },
      },
      select: { instrumentId: true },
      distinct: ['instrumentId'],
    });
    return new Set(rows.map((r) => r.instrumentId));
  }

  // ── financial: delta 批量拉最新 upsert / backfill 逐股区间回填多期 createMany, uk (instrumentId, reportPeriod) ──
  private async syncFinancials(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<void> {
    if (input.mode === 'backfill') {
      await this.backfillFinancials(instruments, dim, stats, input);
      return;
    }
    const idBySymbol = symbolIndex(instruments);
    // #138: 本维度有写路径 ⇒ 起手声明一次, 让「工作集为空 / vendor 零行」的一轮报 0 而非
    // null —— 「跑了、一行没写」正是本列要抓的形态, 与「没上报」必须可分辨。
    addWritten(stats, 0);
    for (const chunk of chunked(instruments, dim.batchSize)) {
      const symbols = chunk.map((i) => `${i.market}:${i.code}`);
      stats.scanned += chunk.length;
      try {
        const dtos = await this.financials.getFinancials(symbols); // HTTP (tx 外)
        let upserted = 0;
        await this.prisma.$transaction(async (tx) => {
          for (const d of dtos) {
            const instrumentId = idBySymbol.get(d.symbol);
            if (instrumentId === undefined) continue;
            const data = { roe: d.roe, grossMargin: d.grossMargin, eps: d.eps, bps: d.bps };
            await tx.financialMetric.upsert({
              where: {
                instrumentId_reportPeriod: { instrumentId, reportPeriod: d.reportPeriod },
              },
              create: { instrumentId, reportPeriod: d.reportPeriod, ...data },
              update: data,
            });
            upserted++;
          }
        });
        // #138: 同 fundamental delta —— 逐行 upsert 按**发生了写操作的行**计。
        addWritten(stats, upserted);
        stats.ok += chunk.length;
      } catch (err) {
        stats.failed += chunk.length;
        stats.failedTargets.push({
          symbol: `${symbols[0]}..${chunk.length}`,
          step: 'financial',
          error: String(err),
        });
      }
    }
  }

  /**
   * financial backfill (038 T014): per-instrument 逐股拉 [from, asOf] 区间多期财报
   * (T013 `getFinancialsRange`) → 批量 `createMany(skipDuplicates)` on (instrumentId,reportPeriod)
   * uk **多期**。HTTP 在 tx 外; per-instrument 隔离; 缺字段存 null 不崩。
   *
   * createMany 而非逐行 upsert 同 `backfillFundamentals`: 历史某季财报不可变 (某季 ROE/EPS 定值)
   * → insert-only 语义正确, 避逐行 upsert × 多期塞单 `$transaction` 撞 5s 事务超时; 重跑只补缺期。
   */
  private async backfillFinancials(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<void> {
    const from = subtractDays(input.asOf, input.backfillHistoryDays ?? dim.historyDepth ?? 365);
    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    for (const inst of instruments) {
      await this.backfillPacer.pace(); // 038 T017 (INV-3): 回填期自限速, 叠加软护栏防风控。
      const symbol = `${inst.market}:${inst.code}`;
      stats.scanned++;
      try {
        const dtos = await this.financials.getFinancialsRange({ symbol, from, to: input.asOf }); // HTTP (tx 外)
        await this.prisma.$transaction(async (tx) => {
          const written = await tx.financialMetric.createMany({
            data: dtos.map((d) => ({
              instrumentId: inst.id,
              reportPeriod: d.reportPeriod,
              roe: d.roe,
              grossMargin: d.grossMargin,
              eps: d.eps,
              bps: d.bps,
            })),
            skipDuplicates: true, // 历史不可变 → 跳已存补缺; 天然幂等。
          });
          addWritten(stats, written.count);
        });
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol, step: 'financial', error: String(err) });
      }
    }
  }

  // ── corporate_action: per-instrument 拉公司行动 → upsert + **新增触发复权重取** ──
  //
  // 复权重取 (FR-S11, clarify 2026-06-02): 仅**新增** action (diff 既有自然键) 触发, 对受影响
  // 标的的 **最早新增 ex-date 之后区间**重拉 Lixinger 已复权 candlestick → 覆盖旧复权行
  // (本地不重算复权因子)。无新增则零重取 (避免每夜全量重拉, D7)。
  private async syncCorporateActions(
    instruments: WorkingInstrument[],
    targetDate: string,
    reAdjustLookbackDays: number,
    stats: SyncRunStats,
  ): Promise<void> {
    // #138: 本维度有写路径 ⇒ 起手声明一次, 让「工作集为空 / vendor 零行」的一轮报 0 而非
    // null —— 「跑了、一行没写」正是本列要抓的形态, 与「没上报」必须可分辨。
    addWritten(stats, 0);
    for (const inst of instruments) {
      const symbol = `${inst.market}:${inst.code}`;
      stats.scanned++;
      try {
        const actions = await this.corporateAction.getCorporateActions(symbol); // HTTP (tx 外)
        if (actions.length > 0) {
          const { minNewExDate, written } = await this.upsertCorporateActions(inst.id, actions);
          addWritten(stats, written); // #138: 逐行 upsert 按行计 (口径见 addWritten)。
          // 新增 action → transient 跃变锚定 (020 T007, 仅受影响标的; 窗口 = 策略字段)。
          if (minNewExDate) {
            await this.anchorNewFactorVersion(inst, targetDate, reAdjustLookbackDays);
          }
        }
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol, step: 'corporate_action', error: String(err) });
      }
    }
  }

  /**
   * upsert 公司行动 (自然键), 返**新增** action 的最早 exDate (无新增 → null) + 本次
   * **发生了写操作的行数** (#138: insert 与 update 都计 —— 两者都真的写了库, 口径见 addWritten)。
   */
  private async upsertCorporateActions(
    instrumentId: bigint,
    actions: { exDate: string; type: string; payload: unknown }[],
  ): Promise<{ minNewExDate: string | null; written: number }> {
    const existing = await this.prisma.corporateAction.findMany({
      where: { instrumentId },
      select: { exDate: true, type: true },
    });
    const existingKeys = new Set(existing.map((e) => `${dateOnlyStr(e.exDate)}|${e.type}`));

    let minNewExDate: string | null = null;
    await this.prisma.$transaction(async (tx) => {
      for (const a of actions) {
        const exDate = toDateOnly(a.exDate);
        const payload = a.payload as Prisma.InputJsonValue;
        await tx.corporateAction.upsert({
          where: { instrumentId_exDate_type: { instrumentId, exDate, type: a.type } },
          create: { instrumentId, exDate, type: a.type, payload },
          update: { payload },
        });
        if (!existingKeys.has(`${a.exDate}|${a.type}`)) {
          if (minNewExDate === null || a.exDate < minNewExDate) minNewExDate = a.exDate;
        }
      }
    });
    return { minNewExDate, written: actions.length };
  }

  /**
   * 跃变锚定 (020 T007 起; 2026-08-01 换口径): 窗内除权事件 → 事件条款法 + 涨跌幅复权法
   * 2-of-2 判定 → upsert (uk instrument×exDate 幂等; 写 factorBackward + source + status)。
   * 窗口 = reAdjustLookbackDays, 语义为「重算 ≥ 该日的事件」(防老票全量回溯的成本护栏)。
   * 锚定失败 → WARN 不阻塞 none 落库 (clarify ④ 最终一致), corp 扫描 / eod 除权命中双触发点
   * 下次幂等补锚。未来 exDate 无 ex 日 bar 由纯函数天然跳过 (019 D2 零碰)。
   *
   * 🚨 **本路径已零 vendor 外呼**。旧口径 (`anchorFactorJumps`) 从 vendor backward 序列反推
   * 跃变, 隐含假设 vendor 用乘法复权 —— 2026-08-01 直连实测证伪 (理杏仁 `bc_rights` 是仿射
   * `bc = K·ex − C`, C≠0 且随窗内事件数累积), 故该口径下窗口长度直接决定正确性 (PR #764)。
   * 换成事件条款法后输入全在本地库, 窗口退化为纯成本参数, 不再影响算出的值。
   */
  private async anchorNewFactorVersion(
    inst: WorkingInstrument,
    targetDate: string,
    lookbackDays: number,
  ): Promise<void> {
    const symbol = `${inst.market}:${inst.code}`;
    try {
      await anchorFactorsForInstrument(
        this.prisma,
        { instrumentId: inst.id, fromExDate: subtractDays(targetDate, lookbackDays) },
        this.logger,
      );
    } catch (err) {
      // FR-A05: 锚定失败不计维度 failed — none 链不受影响, WARN 后下次触发自愈。
      this.logger.warn(
        `factor anchor failed (re-anchor on next trigger): ${JSON.stringify({
          symbol,
          targetDate,
          error: String(err),
        })}`,
      );
    }
  }

  /**
   * 046 T008 标的级 IV 日快照 (FR-023/FR-026/FR-028/FR-029/FR-030/FR-031)。
   *
   * 形态是**批量快照**, 与既有区间型维度都不同: `overview` 一次问一批 codes, 且**不吃日期
   * 区间** —— 它回答的永远是「现在」。故本方法无 mode 分支、无 from/to、无 pending 游标。
   * (backfill 模式下的历史序列走另一条路径 —— `his_volatility` 分页回填, T009。)
   *
   * ## 业务日期 = A′, 且**刻意不取 `input.asOf`** (FR-028)
   *
   * vendor 不随快照下发日期 ⇒ 这一行归哪个交易日只能由**市场时钟**定, 取
   * `exchangeCalendarDateForScope(dim.marketScope, input.now)` (us ⇒ America/New_York)。不取 `input.asOf`
   * 有两个各自独立的理由:
   *   ① `input.asOf` 是**入队时刻**算的, 而这一行归哪个交易日要按**执行时刻**的市场时钟定
   *      —— 队列积压 / 重试跨过收盘或午夜时两条钟会分叉 (ADR-0066: event time ≠ processing
   *      time)。⚠️ 063 Phase 1 前这里还有第三条理由「CLI 的 asOf 兜底是上海日」, 那个形态
   *      已随两条 CLI 改逐维度求值而消失, 别再引用。
   *   ② 运维显式 `--as-of <过去某天>` 更糟: 会把**今天的**快照写进过去那天的行, 直接污染
   *      历史。区间型维度不受此影响 (vendor 按行下发日期), 故不动它们。
   *
   * ## 幂等 = upsert on 唯一键 (FR-029)
   *
   * `(instrument_id, date)` 唯一键即幂等语义载体; 同日重跑覆盖同一行, 不产生重复。
   *
   * 复杂度 O(标的数) 次 upsert + ⌈标的数 / batchSize⌉ 次 vendor 调用。
   */
  private async syncUnderlyingIvDaily(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<void> {
    // backfill = 完全不同的取数形态 (his_volatility 区间分页 → underlying_iv_history), 早退
    // 分流同 syncFundamentals 先例。两条路径共用维度行但不共用端点。
    if (input.mode === 'backfill') {
      await this.backfillUnderlyingIvHistory(instruments, dim, stats, input);
      return;
    }
    const date = toDateOnly(exchangeCalendarDateForScope(dim.marketScope, input.now));
    const idBySymbol = symbolIndex(instruments);
    // #138: 本维度有写路径 ⇒ 起手声明一次, 让「工作集为空 / vendor 零行」的一轮报 0 而非
    // null —— 「跑了、一行没写」正是本列要抓的形态, 与「没上报」必须可分辨。
    addWritten(stats, 0);

    for (const chunk of chunked(instruments, dim.batchSize)) {
      const symbols = chunk.map((i) => `${i.market}:${i.code}`);
      stats.scanned += chunk.length;
      try {
        const snapshots = await this.underlyingIv.getIvSnapshots(symbols); // HTTP (tx 外)
        const matched: { instrumentId: bigint; snapshot: UnderlyingIvSnapshot }[] = [];
        await this.prisma.$transaction(async (tx) => {
          for (const s of snapshots) {
            const instrumentId = idBySymbol.get(s.symbol);
            if (instrumentId === undefined) continue;
            const data = underlyingIvUpsertData(s);
            await tx.underlyingIvDaily.upsert({
              where: { instrumentId_date: { instrumentId, date } },
              create: { instrumentId, date, ...data },
              update: data,
            });
            matched.push({ instrumentId, snapshot: s });
          }
        });
        // #138: 逐行 upsert 按行计。取 matched 而非 chunk.length —— 无期权的标的整行缺席,
        // 那些标的一行都没写 (它们计 skipped, 见下一行)。
        addWritten(stats, matched.length);
        stats.ok += matched.length;
        // 无期权的标的**整行缺席** (port 契约: 返回长度可 < 请求长度)。这既不是成功也不是
        // 失败 —— 计 skipped 才能与真失败区分开, 且不让它被静默丢掉。
        stats.skipped += chunk.length - matched.length;
        // 046 T010 双算对表 (tx 外, 监控侧信道 —— 见方法注释)。
        await this.crossCheckIvPercentile(matched, date);
      } catch (err) {
        stats.failed += chunk.length;
        stats.failedTargets.push({
          symbol: `${symbols[0]}..${chunk.length}`,
          step: 'underlying_iv_daily',
          error: String(err),
        });
        // 🚨 FR-030 告警等级 = 「**可重拉**」, 刻意**不照抄期权链的「当日必须叫醒人」**:
        // 这一档 IV 读数在 `his_volatility` 的 3 年滑动窗里还留着, 次日重跑 / 回填都能补回来;
        // 期权链 EOD 是漏采即**永久**缺口, 才配那个等级。把两者混同会让告警面失去分辨力。
        // 「不破坏已落历史」在结构上成立: 失败发生在 tx 外的 HTTP 段, 没有任何写路径被触及。
        this.logger.warn(
          `underlying_iv_daily 批次取数失败 (可重拉: 次日重跑 / his_volatility 回填即可补齐, 非当日必醒): ${JSON.stringify(
            {
              batchHead: symbols[0],
              batchSize: chunk.length,
              date: dateOnlyStr(date),
              error: String(err),
            },
          )}`,
        );
      }
    }
  }

  /**
   * 046 T010 IVP **双算对表** → 采集侧告警面 (FR-034/FR-035, plan D4)。
   *
   * ## 这东西为什么存在 (代码里看不出来的那半)
   *
   * 富途 `overview` 的 `iv_percentile` 是 **vendor 结论**, 其聚合规则**未文档化** (p3 §9-1:
   * 该序列非严格 30d-ATM 锁定口径)。它若哪天悄悄改了规则, **这条自算对表是唯一能发现的
   * 信号** —— 数据本就要落 (`underlying_iv_history` 是回填出来的), 无额外 vendor 调用,
   * 成本近零。删掉它, 口径漂移就会以「界面数字慢慢不对劲」的形式存在很久没人知道。
   *
   * ## 🚨 结果**只进告警面**: MUST NOT 进写路径 / API 响应 / UI
   *
   * 界面显示的 IVP **恒为直读值** (显示口径单源, FR-035)。自算值只用于发现漂移 —— 让它顺着
   * 落库行或 DTO 漏出去, 同一个读数就有了两个来源, 而那正是本对表要监控的东西本身。
   * 故本方法**只读不写**, 返回 void, 出口只有 logger。
   *
   * ## 三档 + 跳过 (阈值 / 边界归属见 `underlying-iv.rules.ts`)
   *
   * `ok` 静默 · `warn` 进 WARN 复核名单 · `hard` 硬门 ERROR。**窗口不足 / 无直读值 ⇒
   * `skipped`, 不告警** —— 缺窗口不是口径漂移, 否则告警面会被上线头一年的新标的刷屏。
   *
   * 窗口取「最近 {@link IVP_MIN_WINDOW_TRADING_DAYS} 个交易日的历史行」而非「最近 N 个
   * 自然日」: 常量的单位就是交易日, 而 `underlying_iv_history` 一行即一个交易日 ⇒ `take`
   * 语义天然对齐; 按自然日切会因假期长短让样本数在 252 上下抖动, 把「够/不够」变成随机数。
   *
   * 对表**失败不拖垮采集**: 它是监控侧信道, 不是采集的前置条件 (catch 内降级为 WARN)。
   * 复杂度 O(标的数) 次查询 × O(252) 计数。
   */
  private async crossCheckIvPercentile(
    matched: { instrumentId: bigint; snapshot: UnderlyingIvSnapshot }[],
    date: Date,
  ): Promise<void> {
    for (const { instrumentId, snapshot } of matched) {
      try {
        const rows = await this.prisma.underlyingIvHistory.findMany({
          where: { instrumentId, date: { lte: date } },
          select: { iv: true },
          orderBy: { date: 'desc' },
          take: IVP_MIN_WINDOW_TRADING_DAYS,
        });
        const self = computeIvPercentile(
          rows.map((r) => r.iv),
          toDecimalOrNull(snapshot.iv),
        );
        const verdict = classifyIvpDivergence(toDecimalOrNull(snapshot.ivPercentile), self);
        const detail = JSON.stringify({
          symbol: snapshot.symbol,
          date: dateOnlyStr(date),
          level: verdict.level,
          diffPp: verdict.diffPp?.toFixed(4) ?? null,
          reason: verdict.reason,
        });
        if (verdict.level === 'warn') {
          this.logger.warn(`IVP 双算对表 WARN (进复核名单): ${detail}`);
        } else if (verdict.level === 'hard') {
          this.logger.error(
            `IVP 双算对表 硬门 (疑似 vendor 聚合口径漂移, 需人工核口径): ${detail}`,
          );
        }
        // 'ok' / 'skipped' 蓄意零输出: 前者是噪声带内, 后者不成立对表 (见上文)。
      } catch (err) {
        this.logger.warn(
          `IVP 双算对表 执行失败 (监控侧信道, 不影响本轮采集): ${JSON.stringify({
            symbol: snapshot.symbol,
            error: String(err),
          })}`,
        );
      }
    }
  }

  /**
   * 046 T013 `us_index_daily`: VIX / VVIX 日线 (FR-025/FR-027/FR-028/FR-029, plan D1/D6)。
   *
   * ## 工作集 = 两个常量, **不挂锚闸**
   *
   * 遍历 {@link US_INDEX_CODES}, **不查 `Instrument`、不走 `loadActiveInstruments`** ——
   * 完整理由见 `buildExecutors()` 里本维度那条注释与 `us-index.port.ts`。一句话: 挂了闸零锚时
   * 会静默不跑, 与「指数表盘不依赖锚」直接矛盾, 而且**不会红**。
   *
   * ## 取数形态 = **全量文件**, 故没有「回填区间」这个概念
   *
   * 源是覆盖式历史 CSV, 每次拿到的都是整段历史 (plan D6) ⇒ **`delta` 与 `backfill` 走同一条
   * 路, 无 mode 分支**; 维度行的 `delta_lookback_days` / `history_depth` 对它**不适用**
   * (那两个字段是给「按 `[from, asOf]` 区间问 vendor」的接口设计的, 见 seed migration 注释),
   * 故 seed 里它们留 NULL, 本方法也不读。**幂等因此天然成立**: 唯一键 `(index_code, date)`
   * 就是语义载体, 同日重跑覆盖同一批行 (真库半边验在 T014 IT)。
   *
   * ## A′ 在全量文件形态下的**唯一职责** = 未来日期行的上界闸 (FR-028)
   *
   * 行的日期来自文件本身, 不是算出来的 ⇒ A′ 不当「落库日期」用。但它仍要按 us 时区求
   * ({@link exchangeCalendarDateForScope}, 不吃 `input.asOf` —— 后者是入队时刻的日期, 而上界闸
   * 要问执行时刻的「今天」): **晚于 A′ 的行一律拦下并计 `skipped`**。正常情况下拦不到任何东西 (文件末行
   * 恒为上一交易日), 拦到了就是源侧日期异常或本机时钟跑偏 —— 两种都该被数出来而不是默默入库。
   *
   * ## per-code 隔离
   *
   * 一个文件拉不到 → 计 `failed` + WARN, **另一个照常落**、**不上抛**: 全量文件天然自愈
   * (明天那份文件里今天这行还在), 抛出去只会让 worker 按「崩溃」重试整轮。
   *
   * 计数单位: `scanned` / `ok` / `skipped` 是**行**, `failed` 是**文件** —— 取数失败时一行都
   * 没拿到, 没有行可计。正常路径下 `scanned = ok + skipped` 恒成立。
   *
   * 复杂度: 2 次 HTTP + O(总行数) 解析/过滤 + ⌈头部行数 / {@link BACKFILL_ROW_CHUNK}⌉ 次
   * `createMany` + {@link US_INDEX_REVISABLE_TAIL_ROWS} 次 upsert。
   */
  private async syncUsIndexDaily(input: ExecutorInput): Promise<ExecutorResult> {
    const dim = await this.loadDimension('us_index_daily');
    const businessDate = exchangeCalendarDateForScope(dim.marketScope, input.now);
    const stats = emptyStats();

    for (const indexCode of US_INDEX_CODES) {
      let history;
      try {
        history = await this.usIndex.getIndexHistory(indexCode); // HTTP (tx 外)
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol: indexCode, step: 'us_index_daily', error: String(err) });
        this.logger.warn(
          `us_index_daily 取数失败 (可重拉: 源是覆盖式全量文件, 次日重跑自愈, 非当日必醒): ${JSON.stringify(
            { indexCode, businessDate, error: String(err) },
          )}`,
        );
        continue;
      }

      // 非法行**上抛后计入 SyncRun**(plan D6 禁静默丢): 静默丢会让「源格式悄悄变了」以
      // 「最近的数据越来越少」这种极难归因的形式存在很久。
      stats.scanned += history.rows.length + history.skipped;
      stats.skipped += history.skipped;
      if (history.skipped > 0) {
        this.logger.warn(
          `us_index_daily 源文件含非法行 (已跳过并计入 SyncRun 统计): ${JSON.stringify({
            indexCode,
            skipped: history.skipped,
            samples: history.skippedSamples,
          })}`,
        );
      }

      const usable = history.rows.filter((row) => row.date <= businessDate);
      const futureRows = history.rows.length - usable.length;
      if (futureRows > 0) {
        stats.skipped += futureRows;
        this.logger.warn(
          `us_index_daily 源文件含晚于业务日 A′ 的行 (已拦下, 疑源侧日期异常 / 本机时钟跑偏): ${JSON.stringify(
            { indexCode, businessDate, futureRows },
          )}`,
        );
      }

      addWritten(stats, await this.writeUsIndexRows(indexCode, usable));
      stats.ok += usable.length;
    }

    return { stats, budgetExhausted: false };
  }

  /**
   * 全量文件落库: **尾部窗口 upsert + 其余 `createMany(skipDuplicates)`**。
   *
   * 为什么不整份逐行 upsert (「全量文件 upsert」的字面读法): VIX 约 9.2k 行 + VVIX 约 5.1k 行,
   * **每天** 14k 次往返, 而其中 99.9% 是 1990 年以来早已定死的结算值。只有最近几天可能被修订
   * 或以初值先发 ⇒ 只给尾部 {@link US_INDEX_REVISABLE_TAIL_ROWS} 行 upsert 的更新能力, 更老的
   * 走 insert-only (撞唯一键即跳过)。两条通路合起来覆盖全部行, 幂等语义不变。
   *
   * 头部按 {@link BACKFILL_ROW_CHUNK} 分片: 首跑一次要灌 9.2k 行, 单条 `createMany` 塞满会
   * 顶到 Prisma 默认 5s 事务超时 (#675 病根)。
   */
  private async writeUsIndexRows(
    indexCode: UsIndexCode,
    rows: UsIndexDailyPoint[],
  ): Promise<number> {
    const tailStart = Math.max(0, rows.length - US_INDEX_REVISABLE_TAIL_ROWS);

    let written = 0;
    for (const chunk of chunked(rows.slice(0, tailStart), BACKFILL_ROW_CHUNK)) {
      written += (
        await this.prisma.usIndexDaily.createMany({
          data: chunk.map((row) => usIndexDailyRow(indexCode, row)),
          skipDuplicates: true,
        })
      ).count;
    }

    const tail = rows.slice(tailStart);
    if (tail.length === 0) return written;
    await this.prisma.$transaction(async (tx) => {
      for (const row of tail) {
        const data = { open: row.open, high: row.high, low: row.low, close: row.close };
        const date = toDateOnly(row.date);
        await tx.usIndexDaily.upsert({
          where: { indexCode_date: { indexCode, date } },
          create: { indexCode, date, ...data },
          update: data,
        });
      }
    });
    return written + tail.length;
  }

  /**
   * 046 T009 `his_volatility` 历史序列回填 → `underlying_iv_history` (FR-024)。
   *
   * ## 🚨 首次上线**拉满 vendor 上限 (约 3 年, 维度行 `history_depth = 1095`)**
   *
   * 不是只拉 IVP 所需的 252 交易日下限。决定性理由是**不可逆性**: `his_volatility` 的 3 年是
   * **滑动窗** —— 今天不拉, 明年再想要中间那段就**永久没有了**(与期权 EOD「漏采即永久缺口」
   * 同形, 只是窗口更宽)。成本可忽略: 12 只 × 4 页 ≈ 48 次, 一次性。
   *
   * ## 分页只有一份实现
   *
   * 切分走 {@link splitBackfillWindows} (≤364 天/窗, 闭区间首尾相接不重不漏)。**回填 CLI 的
   * 额度估算调的是同一个函数** —— 估算口径与执行口径同源, 才不会出现「估算说 N 页、实跑 M 页」
   * (#754 `--dimension us_equity_bar` 报 350,760 实跑 7 就是两处各写一遍的后果)。
   *
   * ## 区间端点取 `input.asOf`, 与 delta 路径取 A′ **不矛盾**
   *
   * delta 那边 `asOf` 是给无日期的快照**打戳**, 错一天就永久错位 (故必须 A′); 这边只是**问
   * vendor 要哪段**, 多问一天返空、少问一天下轮补, 且 `--as-of` 是运维显式声明的结算日 (D9)
   * —— 拿 A′ 覆盖掉反而是静默忽略运维意图。同其余区间型维度。
   *
   * per-instrument 隔离: 单只失败计 failed 续跑其余 (`skipDuplicates` 让重跑幂等补齐)。
   * 复杂度 O(标的数 × 窗口数) 次 vendor 调用。
   */
  private async backfillUnderlyingIvHistory(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<void> {
    const depth = input.backfillHistoryDays ?? dim.historyDepth ?? HIS_VOLATILITY_MAX_SPAN_DAYS;
    const windows = splitBackfillWindows(subtractDays(input.asOf, depth), input.asOf);

    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    for (const inst of instruments) {
      const symbol = `${inst.market}:${inst.code}`;
      stats.scanned++;
      try {
        const pages: UnderlyingIvHistoryPoint[][] = [];
        for (const w of windows) {
          // 038 T017 (INV-3): 回填自限速 —— 这里按**页**而非按标的 pace, 因为一只标的就是
          // 4 次外呼, 按标的计会让瞬时速率翻 4 倍。
          await this.backfillPacer.pace();
          pages.push(
            await this.underlyingIv.getIvHistoryRange({ symbol, from: w.start, to: w.end }),
          );
        }
        // 页间合并: 窗口不重叠 ⇒ 天然逐日无重无漏; `skipDuplicates` 只兜 vendor 端边界重发。
        const rows = pages.flat().map((p) => ({
          instrumentId: inst.id,
          date: toDateOnly(p.date),
          iv: p.iv,
          hv: p.hv,
          underlyingPrice: p.underlyingPrice,
        }));
        // 行分批: 每 BACKFILL_ROW_CHUNK 行一 $transaction (封顶 tx 时长/内存, #675 病根);
        // 空返回 → 零 createMany。
        for (const rowChunk of chunked(rows, BACKFILL_ROW_CHUNK)) {
          await this.prisma.$transaction(async (tx) => {
            addWritten(
              stats,
              (await tx.underlyingIvHistory.createMany({ data: rowChunk, skipDuplicates: true }))
                .count,
            );
          });
        }
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol, step: 'underlying_iv_daily', error: String(err) });
      }
    }
  }

  /** 本维度 failed ≥ 阈值 → 结构化 ERROR log (FR-S17 log-based alerting 出口, per-dim 粒度)。 */
  private alertIfDegraded(syncType: string, stats: SyncRunStats): void {
    if (stats.failed >= FAILURE_ALERT_THRESHOLD) {
      this.logger.error(
        `${syncType} failures reached alert threshold: ${JSON.stringify({
          scanned: stats.scanned,
          ok: stats.ok,
          skipped: stats.skipped,
          failed: stats.failed,
          threshold: FAILURE_ALERT_THRESHOLD,
        })}`,
      );
    }
  }
}
