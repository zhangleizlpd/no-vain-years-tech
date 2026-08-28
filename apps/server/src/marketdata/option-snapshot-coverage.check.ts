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
 * 到期的腿滤掉。⚠️ 代价是**非交易日调用会假红** (当日本就无快照) ⇒ 调用方 MUST 只在**该市场**
 * 的交易日调用 (管线既有的交易日闸), 本类不自己判日历。
 *
 * ⚠️ **探针那份实现在这一点上故意与本类不同, 别为了「同源」抄平**: `ops/jobs/marketdata-snapshot-integrity.sql`
 * 的调用方是 systemd timer (`*-*-* 08:00` **每日**跑, 没有任何交易日闸) ⇒ 那份**自带一道 ET 周末闸**
 * (纯 `isodow` 算术, 不查 `trading_day`, 故不构成循环信任)。本类不需要, 因为管线的交易日闸已经在
 * 调用侧挡住了。**「两处判据必须同源」指的是分母 / 分子 / 阈值, 不是调用侧的闸** —— IT 里那组周末
 * 用例因此刻意不走 `assertBothAgree`。
 *
 * ## 🚨 每一处取数都必须带 `market` (#255)
 *
 * 本类的四处查询 (基线日 / 分母 / 分子 / 名册) 此前**只有名册**带市场谓词, 另三处是裸的 ——
 * 而「只有美股」这个前提不是写成字面量, 是写成**没有过滤条件**。港股期权 2026-08-23 接入后
 * 该前提失效, 却没有任何一处会因此报错: 港股与美股的 `session_date` 常是同一天 ⇒ 港股合约混进
 * 美股补救的分母 ⇒ `hk:00700` 被判覆盖不足 ⇒ 美股补救器拿 `marketScope: ['us']` 去重采它, 并按
 * 美股归属语义写库 (2026-08-28 08:00 实撞, 1110 行 `oi_as_of` 差一天)。
 *
 * ⇒ 市场是**必填首参**, 不给默认值。给了默认值就等于把同一个洞留在原地, 只是换了个写法。
 *
 * 🚨 过滤钉在**标的**的市场 (`contract.underlying.market`) 而不是 `option_contract.market`:
 * 本报告的单位是「票」, 消费方 (补救器) 也是按票重采 ⇒ 判据必须保证「报告里每一只票都属于这个
 * 市场」。两列可以不一致 —— #199 那批跨市场幽灵合约正是 `contract.market='us'` 挂在港股标的
 * 名下, 按合约列过滤会把它们放回美股分母, 原样复发本 bug。
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
  /** 被核对的市场 (#255) —— 基线日 / 分母 / 分子 / 名册四层全部收窄到它。 */
  market: string;
  /** 被核对的交易日 (该市场的业务日, 调用方按 `exchangeCalendarDate(market, now)` 求值)。 */
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
   * @param market      被核对的市场 (`us` / `hk`)
   * @param sessionDate 被核对的**该市场业务日** `YYYY-MM-DD`
   */
  async check(market: string, sessionDate: string): Promise<OptionCoverageReport> {
    const report = await this.evaluate(market, sessionDate);
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
  async evaluate(market: string, sessionDate: string): Promise<OptionCoverageReport> {
    const threshold = this.cfg.optionCoverageThreshold;
    const baselineDate = await this.resolveBaselineDate(market, sessionDate);
    if (baselineDate === null) {
      return this.emptyReport(market, sessionDate, null, threshold);
    }

    // 分母: 基线日的行 × **到期日 ≥ 当日** (Guardrail 7 —— `>` 会在到期日当天整批放行)。
    const baselineRows = await this.prisma.optionDailySnapshot.findMany({
      where: {
        sessionDate: toDateOnly(baselineDate),
        // #255: 市场谓词钉在**标的**上, 见文件头「每一处取数都必须带 market」。
        contract: { expiryDate: { gte: toDateOnly(sessionDate) }, underlying: { market } },
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
    // 分子: 当日实得的合约集。同一合约可有多来源行 (eod / premarket_backfill), Set 天然去重。
    // 🚨 多取 `underlyingInstrumentId` 一列是**存在性层**的输入 (#231) —— 同一趟查询、零额外
    // 往返。单独再查一次「今天有哪些票有行」等于把这 9 万行再扫一遍。
    const collectedRows = await this.prisma.optionDailySnapshot.findMany({
      where: { sessionDate: toDateOnly(sessionDate), contract: { underlying: { market } } },
      select: { contractId: true, contract: { select: { underlyingInstrumentId: true } } },
    });
    const collected = new Set(collectedRows.map((r) => r.contractId));
    const presentUnderlyings = new Set(collectedRows.map((r) => r.contract.underlyingInstrumentId));

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

    // 🚨 存在性层 (#231): 名册里今天一行都没有的票。比例层结构上看不见它们 —— 连缺两轮时
    // 它在基线日也没有行 ⇒ 不进分母 ⇒ 无输出。判据与 SQL 侧 `absent` CTE **必须同源**。
    const absent = await this.resolveAbsentUnderlyings(
      market,
      sessionDate,
      presentUnderlyings,
      byUnderlying,
    );

    const underlyings: UnderlyingCoverage[] = [...byUnderlying.values()]
      .map((acc) => ({
        ...acc,
        // 乘法而非除法: 阈值 = 1 时退化成 `covered < expected` 的精确比较, 不吃浮点误差。
        degraded: acc.covered < acc.expected * threshold,
      }))
      .concat(absent)
      .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
    const degraded = underlyings.filter((u) => u.degraded);

    return {
      market,
      sessionDate,
      baselineDate,
      threshold,
      // 分母为空 = 「无对象」而非 0%（零锚 / 首日 / 基线日合约当日全部到期）。两层都空才算。
      status: underlyings.length === 0 ? 'no_subject' : degraded.length > 0 ? 'degraded' : 'ok',
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
          market: report.market,
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
   * **存在性层** (#231): 名册里今天一行都没有的票 —— 缺席用**名册**判, 与历史分母无关。
   *
   * ## 🚨 为什么比例层判不出来
   *
   * 比例层的分母取自**基线日的快照数据自己**。一只票连缺两轮时, 它在基线日也没有行 ⇒ 不进分母
   * ⇒ 聚合产不出这一组 ⇒ 判据对它**无输出**。与 Prometheus「实例从服务发现消失后
   * `avg by (job)(up)` **returning nothing rather than alerting**」逐字同构 —— 期望源取自被监控
   * 数据自身, 数据一消失把期望一起带走。2026-08-27 `us:ALB` 实撞: 连缺三轮, 只在第一轮可见。
   *
   * ## 名册 = **该市场工作集 ∧ 有未到期合约**, 两个限定各自承重
   *
   * · `needSync` —— 它是锚闸 (`anchor-driven-sync-gate`) 对锚表重算后的**物化结果**, 与采集侧
   *   同源; **删锚**后下一轮闸置 false ⇒ 该票自动离开名册。不挂它 = 删锚变永久假红。
   *   🚫 MUST NOT 改读 `anchor.excluded`: 那是**交易**意愿不是采集意愿 (FR-028 / Guardrail 8),
   *   prod 现有 3 只 `excluded=true` 的锚**照常在采**。
   * · **有未到期合约** —— 合约全到期的票本就无可采, 留在名册里 = 每天假红一次。
   *
   * 📌 `expected` 取**库内未到期合约数**而非历史分母: 缺席是**二值**的, 这个数只用来说明
   * 「有多少没采到」, 判定本身不依赖它。⇒ 无需把分母窗口拉宽 (2026-08-27 实测: 拉到 21 自然日
   * 窗要多付 2.4x 耗时 + 342k buffers, 而买到的信息**只有缺席那一只票**)。
   *
   * 复杂度: 1 次 instrument 索引扫 (名册, 个位数~百级) + **仅在真有缺席时**再取一次那几只票的
   * 合约 code。稳态零缺席 ⇒ 第二次查询不发生。
   */
  private async resolveAbsentUnderlyings(
    market: string,
    sessionDate: string,
    presentUnderlyings: ReadonlySet<bigint>,
    alreadyCounted: ReadonlyMap<string, CoverageAccumulator>,
  ): Promise<UnderlyingCoverage[]> {
    const unexpired = { expiryDate: { gte: toDateOnly(sessionDate) } };
    const roster = await this.prisma.instrument.findMany({
      where: { market, needSync: true, optionContracts: { some: unexpired } },
      select: { id: true, market: true, code: true },
    });
    const absent = roster.filter(
      (r) => !presentUnderlyings.has(r.id) && !alreadyCounted.has(`${r.market}:${r.code}`),
    );
    if (absent.length === 0) return [];

    // 缺席票的未到期合约 code —— 只为 ERROR log 的逐票明细, 稳态下这一发不发生。
    const contracts = await this.prisma.optionContract.findMany({
      where: { underlyingInstrumentId: { in: absent.map((r) => r.id) }, ...unexpired },
      select: { underlyingInstrumentId: true, code: true },
      orderBy: { id: 'asc' },
    });
    const codesByInstrument = new Map<string, string[]>();
    for (const c of contracts) {
      const key = c.underlyingInstrumentId.toString();
      const bucket = codesByInstrument.get(key);
      if (bucket) bucket.push(c.code);
      else codesByInstrument.set(key, [c.code]);
    }

    return absent.map((r) => {
      const codes = codesByInstrument.get(r.id.toString()) ?? [];
      return {
        instrumentId: r.id,
        symbol: `${r.market}:${r.code}`,
        expected: codes.length,
        covered: 0,
        missingContractCodes: codes,
        // 名册说它该有, 而它一行都没有 ⇒ 恒降级 (不走阈值乘法: 那是比例层的判据)。
        degraded: true,
      };
    });
  }

  /**
   * 基线日 = **有快照行的**、早于 `sessionDate` 的最近一个交易日 (见文件头的取值论证)。
   * 复杂度: `ix_option_daily_snapshot_session_date` 上的倒序 limit-1。
   */
  private async resolveBaselineDate(market: string, sessionDate: string): Promise<string | null> {
    const row = await this.prisma.optionDailySnapshot.findFirst({
      // 🚨 基线日也必须按市场取 (#255): 取全表最近一天时, 一个「该市场休市、别的市场开市」的
      // 日子会被选成基线 ⇒ 分母整个来自别的市场。这条与另外三处同源, 少任何一处洞就还在。
      where: { sessionDate: { lt: toDateOnly(sessionDate) }, contract: { underlying: { market } } },
      orderBy: { sessionDate: 'desc' },
      select: { sessionDate: true },
    });
    return row === null ? null : toIsoDate(row.sessionDate);
  }

  /** 分母为空 ⇒ 「无对象」而非 0% (零锚 / 首日 / 基线日合约当日全部到期)。 */
  private emptyReport(
    market: string,
    sessionDate: string,
    baselineDate: string | null,
    threshold: number,
  ): OptionCoverageReport {
    return {
      market,
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
