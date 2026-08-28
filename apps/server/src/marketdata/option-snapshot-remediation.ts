import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../security/prisma.service.js';
import type { WorkingInstrument } from './dimension-executor.js';
import {
  OptionSnapshotCoverageCheck,
  type OptionCoverageReport,
} from './option-snapshot-coverage.check.js';
import { emptyStats, type SyncRunStats } from './sync-run.recorder.js';
import {
  SNAPSHOT_SOURCE_PREMARKET_BACKFILL,
  SyncOptionSnapshotUseCase,
  type SnapshotCollectionSpec,
} from './sync-option-snapshot.usecase.js';
import { exchangeCalendarDate } from './session-clock.js';
import { SnapshotSessionAttributionLookup } from './snapshot-session-attribution.lookup.js';
import { TRADING_CALENDAR_PORT, type TradingCalendarPort } from './trading-calendar.port.js';

/**
 * 快照缺口的**两级自动补救** (047 T022, FR-046 / FR-052, plan D-DATA-4/5)。
 *
 * 四档 cron 的时刻**一律用 `Asia/Shanghai` 表达** (运维视角的墙上时钟), 见下方「时区字面量只许一个」。
 *
 * | 市场 | 级 | 时刻 (Asia/Shanghai) | 落库口径 | 失败后 |
 * | --- | --- | --- | --- | --- |
 * | us | ① 当日重试 | 08:00 (夜间采集窗之后) | 与正常路径**同源**: 归属整份取自 `resolveSnapshotAttribution` (该时点 ⇒ `source=eod` · `oi_as_of` = 上一交易日) | 只 WARN, 挂着等 ② |
 * | us | ② 次日盘前兜底 | 18:00 (= ET 05:00/06:00, 落在盘前 04:00–09:30 内) | `source=premarket_backfill` · `session_date` = **被补的那天** · `oi_as_of` = `session_date` | **升 ERROR** |
 * | hk | ① 当日重试 | **23:40** (= HKT 23:40; 夜链 23:00 起, 约 40s 跑完) | 判据在该时点给 `source=eod` · `oi_as_of` = `session_date` (hk 的 OI 21:30 已定稿) | 只 WARN, 挂着等 ② |
 * | hk | ② 次日盘前兜底 | **08:30** (= HKT 08:30, 09:00 竞价前) | `source=premarket_backfill` · `oi_as_of` = `session_date` | **升 ERROR** |
 *
 * ## 🚨 hk ① 级钉在 23:40 而不是跨过午夜 (#255)
 *
 * 两个时刻都能补上缺口, 但落库形态不同, 差别全在**同不同一个港股日历日**:
 *
 * · **23:40 (选中)** —— 仍是同一日历日 ⇒ `crossedIntoNextSession` 为假 ⇒ 判据给 `mode=eod`,
 *   与 23:00 夜链**同 source** ⇒ 撞唯一键 `(contract_id, session_date, 'eod')` ⇒ 夜链已写过的
 *   行被 `createMany(skipDuplicates)` 天然挡掉, **只有真缺的那几张会落库**。
 * · 00:30 (否决) —— 已跨日 ⇒ 判据给 `mode=premarket_backfill` ⇒ 每一轮重采都给数据盖上
 *   「这天是靠兜底续命的」那条痕。而 FR-052 那条痕的意义正在于稀有, **天天有等于没有**
 *   (同下一节「二级起手先复判」的判据, 只是换了个触发面)。
 *
 * ⚠️ 两个时刻都在 hk 的 close-write 闸之外 (收盘 16:00 + settle buffer 10min = 16:10)。
 *
 * ## 🚨 hk ② 级存在的理由与 us **不同**, 别照抄论证
 *
 * us 的 ② 级是**等 OI 翻新**: 「T 日的 OI 要 T+1 盘前才发布」是美股清算所的行为。hk 的 OI 在
 * D 日收盘当晚 21:30 就已定稿 (066 T09 / `MARKET_OI_SETTLE_LOCAL_MINUTE`) ⇒ 对 hk 而言 ② 级
 * **买不到任何 OI 正确性**, 它留下来只为两件事: 再补一次, 以及 FR-046 的「两级都失败才升
 * ERROR」需要有个第二级。⇒ 🚫 将来若有人想「hk 反正 OI 已定稿, 把 ② 级砍了」, 砍掉的是
 * **ERROR 升级路径**, 不是一次冗余重采。
 *
 * ## 🚨 二级起手先复判 —— 一级救回了就**零外呼**
 *
 * 「无条件重采一遍」每天白打一轮全链快照, 且会给**每一天**的数据都盖上 `premarket_backfill`
 * 的痕 —— 那条痕的意义正是「这天是靠兜底续命的」, 天天有等于没有。
 *
 * ## 🚨 降级留痕的形态是**行状态**, 不是 log (FR-052)
 *
 * `source = premarket_backfill` 本身就是可被一条 SQL 数出来的痕。只落 log 的话, T025a 那条
 * **独立于 app 进程**的探针 (app 挂了数据自然缺失 ⇒ log 也一起没了) 根本看不见它。
 *
 * ## 🚨 两级都失败**才**升 ERROR (FR-046)
 *
 * 一级就响会把每次 vendor 抖动都变成红。ERROR 的**触达**仍归 `ops/jobs/marketdata-snapshot-integrity.{sh,sql}`
 * 的独立 timer (Guardrail 16) —— 落进 `sync_run` 等次日日报读, 就违反了「ERROR 触达 MUST NOT
 * 并入次日日报」。
 *
 * ## 🚨 非交易日两级都不跑
 *
 * 周末 / 节假日当天本就没有 session, 照跑会把「今天没有交易日」读成整批缺失 (一次全量假红 +
 * 一轮白烧的 vendor 配额)。判据走管线既有的交易日闸 —— ⚠️ 这**不是** FR-045 禁的那种「拿日历
 * 给告警打补丁」: 那条禁的是「今天是大到期日所以放宽阈值」, 而这里判的是「今天到底有没有 session」。
 *
 * ⚠️ **062 起这道闸是三态的**: 只有**确认**的非交易日才短路; 「日历视野还没填到今天」
 * (`unknown`) 一律继续执行 —— 起手的覆盖率复判会决定是否真外呼, 不缺即零外呼返回
 * (`state_branch` 6)。改前那个「无记录 ⇒ 非交易日」的布尔正是二级兜底静默死掉的成因:
 * 它每天在北京 18:00 判「今天不是美股交易日」, 而那一刻今天那一行还没落库。
 *
 * ## 🚨 时区字面量只许一个 —— hk 的两档也写 `Asia/Shanghai`
 *
 * `@Cron` 的 `timeZone` 必须是静态值, 而「每个市场一个时区字面量」就是一张 market → 时区表的
 * 形状 —— 全仓只允许有一份 (ADR-0066 §3, `MARKET_SESSION`), `check-time-semantics` 机器强制。
 * 🚫 也**不能**改成从那张表取: `marketTimeZone('us')` 会给 `America/New_York`, 而 us 两档的
 * 08:00 / 18:00 本就是**北京时刻**(挑出来是为了落在 ET 的正确窗口内), 换成 ET 是行为改变。
 *
 * ⇒ 四档统一用运维视角的 `Asia/Shanghai`。对 hk 这**恰好**等价: 两地同为 UTC+8 且都不实行
 * 夏令时 (香港 1979 年、内地 1991 年后再未实行)。
 * 📌 万一哪天其中一边变了, 这里必须拆成两个时区 —— 而拆的那一刻 `check-time-semantics` 会
 * 当场红并要求你去动 `MARKET_SESSION`。**那道红是这个简化的安全网, 不是它的障碍。**
 *
 * ## 🚨 每个市场一套 cron, 而不是一个 cron 循环市场
 *
 * `@Cron` 表达式是**静态**的, 而两个市场的正确时刻由各自的收盘 / 定稿 / 开市决定, 差了 9 个
 * 小时。写成「一个 cron 里 for (const m of MARKETS)」等于让其中一个市场跑在别人的时刻上 ——
 * 那正是 #255 的病根 (拿一个市场的语义去处理另一个市场) 换了个形态复发。⇒ 每档一个方法、
 * 时刻直接写在装饰器上, 看得见。
 *
 * ## 周末的时序 (看起来晚, 但仍然正确)
 *
 * 周五 session 的采集发生在北京周六 06:30 (ET 周五晚)。① 级北京周六 08:00 跑时 us 业务日仍是
 * **周五** ⇒ 照常重试; ② 级要等到北京周一 18:00 (ET 周一盘前) —— 那时「上一交易日」仍是周五,
 * 而周一盘前的 last close 也仍是周五收盘 ⇒ 补回的值正确。🚫 **MUST NOT 把 ② 级改成「补最近 N 天」**:
 * 只有**紧邻的上一个 session** 能从盘前快照原样补回, 再往前一天拿到的是错的收盘价。
 */

export type RemediationLevel = 'same_day_retry' | 'premarket_backfill';

export type RemediationStatus =
  /** 覆盖率达标 (含「无对象」) 或非交易日 ⇒ 本级零外呼。 */
  | 'not_needed'
  /** 本级补回。 */
  | 'recovered'
  /** 本级重采后仍缺 (① 级 → 等 ②; ② 级 → 已升 ERROR)。 */
  | 'still_missing'
  /**
   * 该场**进行中** ⇒ 端点此刻返的是盘中态, 本级不采 (#187)。
   *
   * 🚨 **不折进 `not_needed`**: 那个值的意思是「不缺、无事可做」, 而这条是「缺不缺都不能在
   * 此刻采」—— 折叠之后一条按结局分组的查询再也分不出这两件事, 而正是同一类折叠让二级兜底
   * 静默死了几个月 (`unknown` 被读成 `non-trading`, 见 {@link RemediationCalendarBasis})。
   *
   * 📌 现役两级 cron **够不到本档** (① 北京 08:00 = ET 19:00/20:00 收盘后; ② 北京 18:00 =
   * ET 05:00/06:00 盘前, 盘前不算场内)。留着它不是形式主义: 判据层能给出这个决策, 而把一个
   * 「判据说不该采」的时刻映射成「不缺」是在撒谎, 一旦有人挪 cron 时刻就会静默写脏行。
   */
  | 'session_underway'
  /** 前置缺失, 无法定位待补交易日 (日历缺行) —— 已升 ERROR。 */
  | 'blocked';

/**
 * 本级**凭什么**走到这个结局的日历判据 (062 T009, FR-013)。
 *
 * 🚨 三值而不是两值: 「确认非交易日」与「覆盖率达标」都落 `not_needed`, 少了这一格,
 * 一条按结局分组的查询再也分不出「今天本就没有 session」和「今天有 session 且不缺」——
 * 而二级兜底恰恰是靠**前者天天成立**才静默死了几个月 (`unknown` 被读成 `non-trading`)。
 */
export type RemediationCalendarBasis = 'confirmed' | 'unknown' | 'non-trading';

export interface RemediationOutcome {
  /** 本级服务的市场 (#255) —— 与 `sessionDate` 配对才说得清「补的是哪一场」。 */
  market: string;
  level: RemediationLevel;
  /**
   * 本级的日历判据来源。`unknown` = 视野还没填到该业务日, 本级是「不知道所以照跑」——
   * 与 `confirmed` 事后必须分得出 (FR-013)。
   */
  calendar: RemediationCalendarBasis;
  /** 被补救的交易日; `null` = 无法定位。 */
  sessionDate: string | null;
  status: RemediationStatus;
  /** 本级重采过的票 (canonical symbol)。 */
  attempted: string[];
  /** 重采后仍缺的票。 */
  stillMissing: string[];
}

@Injectable()
export class OptionSnapshotRemediation {
  private readonly logger = new Logger(OptionSnapshotRemediation.name);

  /** 归属判据的**唯一**取数入口 (#187) —— 曾内联 `resolvePreviousTradingDay` 一份同构查询。 */
  private readonly attribution: SnapshotSessionAttributionLookup;

  constructor(
    private readonly coverage: OptionSnapshotCoverageCheck,
    private readonly snapshot: SyncOptionSnapshotUseCase,
    prisma: PrismaService,
    @Inject(TRADING_CALENDAR_PORT) private readonly calendar: TradingCalendarPort,
  ) {
    this.attribution = new SnapshotSessionAttributionLookup(prisma, calendar);
  }

  /** us ① 级: 每日 08:00 Asia/Shanghai —— 夜间快照窗之后, 留足限频顺延重入队的时间。 */
  @Cron('0 0 8 * * *', { timeZone: 'Asia/Shanghai' })
  async handleUsSameDayRetryCron(): Promise<void> {
    await this.retrySameDay('us', new Date());
  }

  /** us ② 级: 每日 18:00 Asia/Shanghai —— 见类注释的窗口论证 (@Cron 表达式静态, 故取固定时刻)。 */
  @Cron('0 0 18 * * *', { timeZone: 'Asia/Shanghai' })
  async handleUsPremarketBackfillCron(): Promise<void> {
    await this.backfillPremarket('us', new Date());
  }

  /** hk ① 级: 每日 23:40 (= HKT 23:40) —— 夜链 23:00 起、约 40s 跑完; 时刻论证见类注释。 */
  @Cron('0 40 23 * * *', { timeZone: 'Asia/Shanghai' })
  async handleHkSameDayRetryCron(): Promise<void> {
    await this.retrySameDay('hk', new Date());
  }

  /** hk ② 级: 每日 08:30 (= HKT 08:30) —— 09:00 竞价前; 它的存在理由与 us 不同, 见类注释。 */
  @Cron('0 30 8 * * *', { timeZone: 'Asia/Shanghai' })
  async handleHkPremarketBackfillCron(): Promise<void> {
    await this.backfillPremarket('hk', new Date());
  }

  /**
   * ① 当日重试: 复采**最近一个已收盘 session** 里覆盖率不达标的那几票。
   *
   * ## 🚨 归属走判据层, 不是「今天几号」(#187)
   *
   * 本方法此前是 `const sessionDate = exchangeCalendarDateForScope(US_MARKET_SCOPE, now)`
   * —— 正确性**靠 cron 时刻成立** (北京 08:00 = ET 19:00/20:00, 恒在美股收盘后的同一日历日
   * 内), 不是靠判据。两个后果, 第二个才是真的:
   *
   * 1. 执行时刻真被推过 ET 午夜时整批标错一天 (风险低: `@Cron` 是进程内定时器, 不入队);
   * 2. 🚨 **日历滞后那天它与夜间轮对不上** —— 夜间 `option_daily_snapshot` 维度自 #181 起按
   *    `resolveSnapshotAttribution` 落 `session_date`, 即 `trading_day` 里最近一个已收盘
   *    交易日; 今天那一行还没落库时 (062 类注释记的那个真实状态) 夜间轮写的是**昨天**, 而本级
   *    去查**今天**的覆盖率 ⇒ 查到空 ⇒ 判 degraded ⇒ 白重采一轮, 并把行写进一个尚未收盘的
   *    日子。两侧共用同一份判据后, 这类错位在结构上不可能发生。
   *
   * 🚨 `spec` **原样**喂给 `collect`, 连 `mode` 都不在这里重写: 本级被推迟到次日盘前时判据会
   * 给出 `premarket_backfill` + OI 归属被补那天, 那是**对的** —— 硬写 `eod` 会让 `oi_as_of`
   * 差一天且永远不会红。(② 级相反, 见 {@link backfillPremarket} 里为什么它必须硬编码。)
   *
   * 复杂度: 3 次日历点查 + 2 次覆盖率判定 (各 O(n)) + O(缺票数) 次采集。
   */
  async retrySameDay(market: string, now: Date): Promise<RemediationOutcome> {
    // ⚠️ 这一格取的**就是日历日**, 且合法: 它问的是「今天开不开市」(交易日闸), 与「该写哪一天」
    // 正交 —— 后者才是下面的判据层。非交易日短路逐点不变 (见类注释「非交易日两级都不跑」)。
    const today = exchangeCalendarDate(market, now);
    const calendar = await this.calendarBasis(market, today);
    if (calendar === 'non-trading') {
      return this.idle(market, 'same_day_retry', today, calendar, '确认非交易日, 本就没有 session');
    }
    const attribution = await this.attribution.resolve(market, now);
    if (attribution.decision === 'skip') {
      this.logger.log(
        `[option-snapshot-remediation] ${market} same_day_retry 本级零外呼: 该场进行中, ` +
          `端点此刻返盘中态 (calendar=${calendar})`,
      );
      return {
        market,
        level: 'same_day_retry',
        calendar,
        sessionDate: null,
        status: 'session_underway',
        attempted: [],
        stillMissing: [],
      };
    }
    if (attribution.decision === 'abandon') {
      // 🚫 不猜日子 —— 与 ② 级的 `blocked` 同档 (ERROR 级, 需人工补日历)。
      this.logger.error(
        `[option-snapshot-remediation] 交易日历查不到 ${market} 最近一个已收盘交易日 ⇒ ① 级` +
          `当日重试无法定位待补 session, 跳过 (请补交易日历)`,
      );
      return {
        market,
        level: 'same_day_retry',
        calendar,
        sessionDate: null,
        status: 'blocked',
        attempted: [],
        stillMissing: [],
      };
    }
    const sessionDate = attribution.spec.sessionDate;
    const before = await this.coverage.evaluate(market, sessionDate);
    if (before.status !== 'degraded') {
      return this.idle(market, 'same_day_retry', sessionDate, calendar, `覆盖率 ${before.status}`);
    }

    const after = await this.recollect(market, before, attribution.spec);
    const attempted = before.degraded.map((u) => u.symbol);
    if (after.status !== 'degraded') {
      this.logger.warn(
        `[option-snapshot-remediation] ${market} ① 当日重试补回 ${sessionDate}: ` +
          `${attempted.join(', ')}`,
      );
      return {
        market,
        level: 'same_day_retry',
        calendar,
        sessionDate,
        status: 'recovered',
        attempted,
        stillMissing: [],
      };
    }
    // 🚫 这里**不**升 ERROR: 还有 ② 级兜底 (FR-046「两级都失败才升 ERROR」)。
    const stillMissing = after.degraded.map((u) => u.symbol);
    this.logger.warn(
      `[option-snapshot-remediation] ${market} ① 当日重试后仍缺 ${stillMissing.length} 票 ` +
        `(${sessionDate}: ${stillMissing.join(', ')}), 待次日盘前 ② 级兜底`,
    );
    return {
      market,
      level: 'same_day_retry',
      calendar,
      sessionDate,
      status: 'still_missing',
      attempted,
      stillMissing,
    };
  }

  /**
   * ② 次日盘前兜底: 在美股盘前窗口重采**上一个交易日**的缺口, 落 `premarket_backfill` 行。
   *
   * ## 🚨 本级的 `mode` 硬编码, MUST NOT 交给判据层推导 (#187)
   *
   * `source = premarket_backfill` **就是本级留痕的载体本身** (FR-052: 「这天是靠兜底续命的」
   * 那条痕, T025a 的独立探针只数得到落库行的这一列, 数不到 log)。而
   * `resolveSnapshotAttribution` 在日历 `unknown` 那天会给出 `eod` —— 恰恰是本级
   * **最需要留痕**的日子 (062 记的那个真实状态: 北京 18:00 时今天那一行还没落库)。
   * 让判据推导它, 就是在日历滞后那天把痕悄悄擦掉, 且**不会红**。
   *
   * ⇒ 本级只把「上一个交易日」这一次查询与其余三处合并 (`tradingDayBefore`), 归属仍由本级
   * 自己声明。① 级相反 (它的 `mode` 不是身份而是结论), 见 {@link retrySameDay}。
   *
   * 复杂度同 {@link retrySameDay}。
   */
  async backfillPremarket(market: string, now: Date): Promise<RemediationOutcome> {
    const today = exchangeCalendarDate(market, now);
    const calendar = await this.calendarBasis(market, today);
    if (calendar === 'non-trading') {
      // 非交易日无盘前窗口 (OI 也不会翻新) ⇒ 不补; 下一个交易日的盘前仍能补回同一个 session。
      return this.idle(market, 'premarket_backfill', null, calendar, '确认非交易日, 无盘前窗口');
    }
    const sessionDate = await this.attribution.tradingDayBefore([market], today);
    if (sessionDate === null) {
      // 🚫 不猜日子: 猜错就是一批 `session_date` 标错的脏行, 比不补更难发现且要人工回删。
      this.logger.error(
        `[option-snapshot-remediation] 交易日历缺 ${market} 在 ${today} 之前的行, 无法定位待补` +
          `交易日 ⇒ ② 级兜底跳过 (请补交易日历)`,
      );
      return {
        market,
        level: 'premarket_backfill',
        calendar,
        sessionDate: null,
        status: 'blocked',
        attempted: [],
        stillMissing: [],
      };
    }

    const before = await this.coverage.evaluate(market, sessionDate);
    // 🚨 ① 级已补回 ⇒ 零外呼、不留降级痕 (见类注释)。
    if (before.status !== 'degraded') {
      return this.idle(
        market,
        'premarket_backfill',
        sessionDate,
        calendar,
        `覆盖率 ${before.status}`,
      );
    }

    const after = await this.recollect(market, before, {
      sessionDate,
      mode: SNAPSHOT_SOURCE_PREMARKET_BACKFILL,
      marketScope: [market],
      now,
    });
    const attempted = before.degraded.map((u) => u.symbol);
    if (after.status !== 'degraded') {
      // 降级 MUST 留痕 + 告警 (FR-052), 但**不是** ERROR —— 缺口已补上。留痕的权威形态是
      // 落库行的 `source`, 本条 log 只是让它当场可见。
      this.logger.warn(
        `[option-snapshot-remediation] ${market} ② 次日盘前兜底补回 ${sessionDate} (source=` +
          `${SNAPSHOT_SOURCE_PREMARKET_BACKFILL}, 本日数据来自兜底补采): ${attempted.join(', ')}`,
      );
      return {
        market,
        level: 'premarket_backfill',
        calendar,
        sessionDate,
        status: 'recovered',
        attempted,
        stillMissing: [],
      };
    }
    // 两级都失败 ⇒ ERROR。文案复用覆盖率核对的同一个结构化格式 (同判据两处措辞必漂移),
    // 逐票明细 + sessionDate 都在里面。
    this.coverage.alertIfDegraded(after, '两级补救均失败: ① 当日重试 + ② 次日盘前兜底');
    return {
      market,
      level: 'premarket_backfill',
      calendar,
      sessionDate,
      status: 'still_missing',
      attempted,
      stillMissing: after.degraded.map((u) => u.symbol),
    };
  }

  /**
   * 重采不达标的那几票 → 复判。返回**重采后**的报告。
   *
   * `spec` 收完整的 {@link SnapshotCollectionSpec}: ① 级原样转判据层的产物 (**不重算**),
   * ② 级自己声明 (它的 `mode` 是留痕载体, 见 {@link backfillPremarket})。
   */
  private async recollect(
    market: string,
    before: OptionCoverageReport,
    spec: SnapshotCollectionSpec,
  ): Promise<OptionCoverageReport> {
    const stats: SyncRunStats = emptyStats();
    // 🚨 只重采**缺的那几票**, 不整轮重跑: 整轮会让已达标的票平白多一批 vendor 请求, 且在
    // ② 级把 `premarket_backfill` 的痕盖到本来正常的票上。
    await this.snapshot.collect(before.degraded.map(toWorkingInstrument), spec, stats);
    if (stats.failed > 0) {
      this.logger.warn(
        `[option-snapshot-remediation] ${market} 重采期间 ${stats.failed} 票失败: ` +
          `${JSON.stringify(stats.findings)}`,
      );
    }
    return this.coverage.evaluate(market, spec.sessionDate);
  }

  /**
   * 「今天到底有没有 session」的**三态**分派 (062 T009, `state_branch` 6)。
   *
   * 🚨 `unknown` 走**继续执行**侧: 本级起手就有一次覆盖率复判, 不缺即零外呼返回 ——
   * 「不知道」的代价只是一次本地查询, 而判错成非交易日的代价是**永久缺口**
   * (期权收盘数据无跨日补救, 二级放弃掉的那一场再也补不回来)。
   * 🚫 **MUST NOT 写成 `!== 'trading'`** —— 那就是 062 修掉的病原样犯回去。
   */
  private async calendarBasis(market: string, date: string): Promise<RemediationCalendarBasis> {
    const status = await this.calendar.classify(market, date);
    if (status === 'non-trading') return 'non-trading';
    if (status === 'trading') return 'confirmed';
    this.logger.warn(
      `[option-snapshot-remediation] 交易日历视野未覆盖 ${market} 的 ${date} ⇒ 本级按「未知」` +
        `继续执行 (起手的覆盖率复判决定是否真外呼; 请补前瞻视野)`,
    );
    return 'unknown';
  }

  /**
   * 本级零外呼的出口。**必须留痕** —— 这条路径以前是一句静默 `return`, 而二级盘前兜底正是
   * 沿它每天判「无事可做」并返回, 一连几个月没有任何信号 (SC-004 实测执行率 0%)。
   * `log` 而非 `warn`: 它在正常日子里每天都成立, 用 `warn` 会训练出「这条可以忽略」。
   */
  private idle(
    market: string,
    level: RemediationLevel,
    sessionDate: string | null,
    calendar: RemediationCalendarBasis,
    reason: string,
  ): RemediationOutcome {
    this.logger.log(
      `[option-snapshot-remediation] ${market} ${level} 本级零外呼: ${reason} ` +
        `(calendar=${calendar}, session=${sessionDate ?? '-'})`,
    );
    return {
      market,
      level,
      calendar,
      sessionDate,
      status: 'not_needed',
      attempted: [],
      stillMissing: [],
    };
  }
}

/** 覆盖率明细 → 采集工作集项 (`symbol` 是 `${market}:${code}` 的拼接, 此处反解)。 */
function toWorkingInstrument(underlying: {
  instrumentId: bigint;
  symbol: string;
}): WorkingInstrument {
  const [market, code] = underlying.symbol.split(':');
  return { id: underlying.instrumentId, market, code };
}
