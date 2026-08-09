import { Inject, Injectable, Logger } from '@nestjs/common';
import { marketdataSyncConfig, type MarketdataSyncConfig } from '../config/marketdata.config.js';
import { PrismaService } from '../security/prisma.service.js';

/**
 * 期权快照完整性核对: **逐合约覆盖率** (047 T021, FR-045 / plan D-DATA-6)。
 *
 * ```
 * 分母 = 基线日快照里、**到期日 ≥ 当日交易日**的合约集   分子 = 当日实得快照的合约数
 * ```
 *
 * ## 🚨 为什么不是「逐票总行数落在 [0.7,1.3]×」
 *
 * 采全到期日之后合约集**天天在变** (周期权每周到期 / 月度合约集体到期 / vendor 同时挂新到期日),
 * 行数波动是**正常态而非故障信号** —— 拿它当判据必然每月假红一次。逐合约覆盖率对「到期减少」
 * 与「新挂增加」两个方向天然免疫。
 *
 * ## 🚨 判定**逐票**, MUST NOT 只看全局总数
 *
 * 行数分布极不均 (实测 PEP 730 行 / VICI 48 行): 一只小票整票消失落在全局比值的噪声里
 * (778 → 730 = 93.8%, 任何合理的全局阈值都判绿)。故阈值逐票施加, 全局数字只作上下文。
 *
 * ## 🚨 到期判据是 `>=` 不是 `>` (Guardrail 7, 与采集侧同源)
 *
 * 当日到期的合约**当日仍可取快照** (官方「结束日期请输入今天或未来的日期」) ⇒ 它当日缺席就是
 * 真缺口, 而那是这批腿**最后一次**可采的机会。写成 `>` 只在到期日当天整批放行, 平时看不出来。
 * ⚠️ 选约表那侧 (T027) 是 `>` (已到期腿不可交易) —— **两处判据故意不同, 别统一**。
 *
 * ## 🚫 MUST NOT 用交易日历打「今天是大到期日所以放宽阈值」的补丁
 *
 * 那是拿被监控对象的邻近物证明自己健康 (循环信任, 044 同款)。假阳性由**分母口径**解决 ——
 * 已到期的腿本就不进分母, 大到期日次日的分母自然缩小, 无需任何日期特判。
 *
 * ## 基线日取「最近**有数据**的更早交易日」, 而不是日历上的上一交易日
 *
 * 若取日历日而那天恰好也整体停摆 ⇒ 分母为空 ⇒ 判「无对象」⇒ **连续停摆自我掩盖**。取最近有
 * 数据的那天则缺口一直挂着直到补回来。跨假期的陈旧基线不会造成假红: `到期日 ≥ 当日` 已把期间
 * 到期的腿滤掉。⚠️ 代价是**非交易日调用会假红** (当日本就无快照) ⇒ 调用方 MUST 只在 us 交易日
 * 调用 (管线既有的交易日闸), 本类不自己判日历。
 *
 * ## 分母为空 = 「无对象」, **不是 0%**
 *
 * 零锚 (`need_sync` 全 false) / 首日 / 基线日合约当日全部到期 —— 判 0% 会让这些正常空态天天红。
 *
 * 📌 **本类只产出「判定 + 逐票明细 + 结构化 ERROR log」** (沿 `alertIfDegraded` 的 log-based
 * alerting 范式)。**触达**是另一件事, 归 `ops/jobs/marketdata-snapshot-integrity.{sh,sql}` 的独立 timer
 * (T025a): app 整个挂掉时数据自然缺失, 而进程内的 log 也一起没了 —— 两处实现的判据必须同源。
 */

/** 一票的覆盖率明细。 */
export interface UnderlyingCoverage {
  /** 标的 `Instrument.id` —— 补救侧 (T022) 据此直接重采该票, 不必再查一次表。 */
  instrumentId: bigint;
  /** canonical `market:code` (`us:PEP`)。 */
  symbol: string;
  /** 分母: 基线日在、当日仍未到期的合约数。 */
  expected: number;
  /** 分子: 其中当日实得快照的合约数。 */
  covered: number;
  /** 缺席合约的 vendor code 全量 (按 contract_id 序; 日志侧才截断)。 */
  missingContractCodes: string[];
  /** 该票是否低于阈值。 */
  degraded: boolean;
}

export interface OptionCoverageReport {
  /** 被核对的交易日 (us 业务日, 调用方按 `marketDateFor(['us'], now)` 求值)。 */
  sessionDate: string;
  /** 分母取自哪一天; `null` = 全表无更早的快照行 (首日 / 零锚)。 */
  baselineDate: string | null;
  /** 本次判定所用阈值 (配置化, 先验起手 1 = 100%)。 */
  threshold: number;
  /** `no_subject` = 分母为空 (正常空态, 不告警)。 */
  status: 'no_subject' | 'ok' | 'degraded';
  /** 全局分母 / 分子 —— **仅作上下文**, 判定不看它 (大票会盖住小票)。 */
  expected: number;
  covered: number;
  /** 逐票明细 (按 symbol 升序)。 */
  underlyings: UnderlyingCoverage[];
  /** 低于阈值的子集 (= `underlyings.filter(u => u.degraded)`)。 */
  degraded: UnderlyingCoverage[];
}

/** ERROR log 里每票最多列几个缺席合约 code (报告对象里仍是全量)。 */
const MAX_LOGGED_MISSING_CODES = 20;

/** `YYYY-MM-DD` → `@db.Date` 列的 UTC 零点 Date。 */
const toDateOnly = (s: string): Date => new Date(`${s}T00:00:00Z`);

/** UTC `Date` → `YYYY-MM-DD`。 */
const toIsoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** 分组累加中的可变态 (成型后转 {@link UnderlyingCoverage})。 */
interface CoverageAccumulator {
  instrumentId: bigint;
  symbol: string;
  expected: number;
  covered: number;
  missingContractCodes: string[];
}

@Injectable()
export class OptionSnapshotCoverageCheck {
  private readonly logger = new Logger(OptionSnapshotCoverageCheck.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(marketdataSyncConfig.KEY) private readonly cfg: MarketdataSyncConfig,
  ) {}

  /**
   * 判定 + 告警。返回值同 {@link evaluate} (调用方可继续消费明细)。
   *
   * @param sessionDate 被核对的 **us 业务日** `YYYY-MM-DD`
   */
  async check(sessionDate: string): Promise<OptionCoverageReport> {
    const report = await this.evaluate(sessionDate);
    this.alertIfDegraded(report);
    return report;
  }

  /**
   * **纯判定, 不告警** —— 两级自动补救 (T022) 要在补回来之后才决定响不响 (FR-046「两级都失败
   * 才升 ERROR」), 合成一个方法就没法既判定又不响。
   *
   * 复杂度 O(n): 两次以 `session_date` 为入口的索引查询 (基线日行 + 当日行), 逐行一次 Map/Set
   * 操作; n = 两日快照行数之和。
   */
  async evaluate(sessionDate: string): Promise<OptionCoverageReport> {
    const threshold = this.cfg.optionCoverageThreshold;
    const baselineDate = await this.resolveBaselineDate(sessionDate);
    if (baselineDate === null) {
      return this.emptyReport(sessionDate, null, threshold);
    }

    // 分母: 基线日的行 × **到期日 ≥ 当日** (Guardrail 7 —— `>` 会在到期日当天整批放行)。
    const baselineRows = await this.prisma.optionDailySnapshot.findMany({
      where: {
        sessionDate: toDateOnly(baselineDate),
        contract: { expiryDate: { gte: toDateOnly(sessionDate) } },
      },
      select: {
        contractId: true,
        contract: {
          select: { code: true, underlying: { select: { id: true, market: true, code: true } } },
        },
      },
      // 缺席明细的稳定序 (ERROR log 逐日可比); 同时让同一合约的多来源行相邻。
      orderBy: { contractId: 'asc' },
    });
    if (baselineRows.length === 0) {
      return this.emptyReport(sessionDate, baselineDate, threshold);
    }

    // 分子: 当日实得的合约集。同一合约可有多来源行 (eod / premarket_backfill), Set 天然去重。
    const collectedRows = await this.prisma.optionDailySnapshot.findMany({
      where: { sessionDate: toDateOnly(sessionDate) },
      select: { contractId: true },
    });
    const collected = new Set(collectedRows.map((r) => r.contractId));

    const byUnderlying = new Map<string, CoverageAccumulator>();
    const seenContracts = new Set<bigint>();
    for (const row of baselineRows) {
      // 基线日同一合约的多来源行只算一个分母单位。
      if (seenContracts.has(row.contractId)) continue;
      seenContracts.add(row.contractId);

      const underlying = row.contract.underlying;
      const symbol = `${underlying.market}:${underlying.code}`;
      let acc = byUnderlying.get(symbol);
      if (acc === undefined) {
        acc = {
          instrumentId: underlying.id,
          symbol,
          expected: 0,
          covered: 0,
          missingContractCodes: [],
        };
        byUnderlying.set(symbol, acc);
      }
      acc.expected++;
      if (collected.has(row.contractId)) acc.covered++;
      else acc.missingContractCodes.push(row.contract.code);
    }

    const underlyings: UnderlyingCoverage[] = [...byUnderlying.values()]
      .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
      .map((acc) => ({
        ...acc,
        // 乘法而非除法: 阈值 = 1 时退化成 `covered < expected` 的精确比较, 不吃浮点误差。
        degraded: acc.covered < acc.expected * threshold,
      }));
    const degraded = underlyings.filter((u) => u.degraded);

    return {
      sessionDate,
      baselineDate,
      threshold,
      status: degraded.length > 0 ? 'degraded' : 'ok',
      expected: underlyings.reduce((n, u) => n + u.expected, 0),
      covered: underlyings.reduce((n, u) => n + u.covered, 0),
      underlyings,
      degraded,
    };
  }

  /**
   * 结构化 ERROR (FR-045 的「告警」= 这条 log)。`ok` / `no_subject` 一律静默 —— 每日一次的
   * 检查天然「恢复后不持续重复告警」。
   *
   * @param context 补救链路用来标注是哪一级判的 (如 `premarket_backfill 之后`)
   */
  alertIfDegraded(report: OptionCoverageReport, context?: string): void {
    if (report.status !== 'degraded') return;
    this.logger.error(
      `[option-snapshot-coverage] 逐合约覆盖率跌破阈值${context === undefined ? '' : ` (${context})`}: ` +
        JSON.stringify({
          sessionDate: report.sessionDate,
          baselineDate: report.baselineDate,
          threshold: report.threshold,
          expected: report.expected,
          covered: report.covered,
          // 🚨 逐票明细是本条 log 的全部价值: 只报全局比值 = 小票整票消失读不出来。
          degraded: report.degraded.map((u) => ({
            symbol: u.symbol,
            expected: u.expected,
            covered: u.covered,
            missing: u.missingContractCodes.slice(0, MAX_LOGGED_MISSING_CODES),
            missingTotal: u.missingContractCodes.length,
          })),
        }),
    );
  }

  /**
   * 基线日 = **有快照行的**、早于 `sessionDate` 的最近一个交易日 (见文件头的取值论证)。
   * 复杂度: `ix_option_daily_snapshot_session_date` 上的倒序 limit-1。
   */
  private async resolveBaselineDate(sessionDate: string): Promise<string | null> {
    const row = await this.prisma.optionDailySnapshot.findFirst({
      where: { sessionDate: { lt: toDateOnly(sessionDate) } },
      orderBy: { sessionDate: 'desc' },
      select: { sessionDate: true },
    });
    return row === null ? null : toIsoDate(row.sessionDate);
  }

  /** 分母为空 ⇒ 「无对象」而非 0% (零锚 / 首日 / 基线日合约当日全部到期)。 */
  private emptyReport(
    sessionDate: string,
    baselineDate: string | null,
    threshold: number,
  ): OptionCoverageReport {
    return {
      sessionDate,
      baselineDate,
      threshold,
      status: 'no_subject',
      expected: 0,
      covered: 0,
      underlyings: [],
      degraded: [],
    };
  }
}
