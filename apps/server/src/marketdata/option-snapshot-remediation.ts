import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../security/prisma.service.js';
import type { DimensionKey, WorkingInstrument } from './dimension-executor.js';
import {
  OptionSnapshotCoverageCheck,
  type OptionCoverageReport,
} from './option-snapshot-coverage.check.js';
import {
  deriveStatus,
  emptyStats,
  SyncRunRecorder,
  type SyncRunStats,
} from './sync-run.recorder.js';
import {
  SNAPSHOT_SOURCE_EOD,
  SNAPSHOT_SOURCE_PREMARKET_BACKFILL,
  SyncOptionSnapshotUseCase,
  type SnapshotCollectionSpec,
} from './sync-option-snapshot.usecase.js';
import { oiRefreshedAtEod } from './market-session.rules.js';
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
 *
 * ## 🚨 港股两档已于 073 退役 —— 本类**只服务美股**了
 *
 * 原先还有 hk ① 级 23:40 与 hk ② 级 08:30 两档。073 把港股期权采集拆成两轮 (主轮 16:20 抢
 * 盘口 + 轮2 21:40 回填定稿后的 OI) 之后, **轮2 自带补漏** (`sync-option-oi-settle.usecase.ts`
 * 的段 b), 且档位严格优于那两档: 同日、同 session、同 `source = eod`, 不留
 * `premarket_backfill` 痕, 并与 OI 回填共用同一轮外呼。
 *
 * 🚨 **退役的是触发点, 不是机制**: {@link retrySameDay} / {@link backfillPremarket} 仍是
 * market 参数化的, 传 `'hk'` 进去语义照旧正确 (「按市场分派」那组单测仍在, 它们钉的
 * 「hk 的 OI 当晚定稿 ⇒ `oi_as_of` = `session_date`, 与 us 方向相反」这条不对称性,
 * 如今是轮2 的承重判据)。⇒ 🚫 **MUST NOT 因为「hk 没人调了」去删这两个方法或它们的 hk 用例。**
 *
 * ⚠️ 代价已知并接受 (clarify 期裁决): 港股重试深度从 3 (夜链 + 两级) 降到 **2** (主轮 + 轮2)。
 *
 * 📌 那两档退役前的时刻论证 (① 级为什么钉 23:40 不跨午夜 / ② 级对 hk 买不到 OI 正确性) 已随
 *    触发点一并移除 —— 它们论证的是**已不存在的时刻**, 留着会让下一个人以为那两档还在。
 *    要翻旧账去 git 史 (本注释改动的那个 commit)。
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
 * ## 🚨 时区字面量只许一个 —— 两档都写 `Asia/Shanghai`
 *
 * `@Cron` 的 `timeZone` 必须是静态值, 而「每个市场一个时区字面量」就是一张 market → 时区表的
 * 形状 —— 全仓只允许有一份 (ADR-0066 §3, `MARKET_SESSION`), `check-time-semantics` 机器强制。
 * 🚫 也**不能**改成从那张表取: `marketTimeZone('us')` 会给 `America/New_York`, 而 us 两档的
 * 08:00 / 18:00 本就是**北京时刻**(挑出来是为了落在 ET 的正确窗口内), 换成 ET 是行为改变。
 *
 * ⇒ 统一用运维视角的 `Asia/Shanghai`。📌 073 退役港股两档之前, 这条对 hk 是**恰好**等价的
 *    (两地同为 UTC+8 且均不实行夏令时); 将来若再给别的 UTC+8 市场接触发点, 那个「恰好」要重新
 *    确认一次, 而不是照抄。
 *
 * ## 🚨 每个市场一套 cron, 而不是一个 cron 循环市场
 *
 * `@Cron` 表达式是**静态**的, 而各市场的正确时刻由各自的收盘 / 定稿 / 开市决定, 相差数小时。
 * 写成「一个 cron 里 for (const m of MARKETS)」等于让其中一个市场跑在别人的时刻上 ——
 * 那正是 #255 的病根 (拿一个市场的语义去处理另一个市场) 换了个形态复发。⇒ 每档一个方法、
 * 时刻直接写在装饰器上, 看得见。
 * 📌 073 退役 hk 两档后本类只剩美股两档, 但这条纪律**不因此作废**: 它管的是「再接一个市场时
 *    该怎么接」。
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

/**
 * market → 该市场快照维度的键。补救轮开的 `SyncRun` **与夜间 tick 轮同名**, 两者靠
 * `triggered_by` 分辨 (值域见 `DimensionTriggeredBy`) —— 同一维度的历史因此串在一条线上,
 * 而不是被拆成两个互相看不见的 `sync_type`。
 *
 * 🚨 **查不到就抛, 不 fallback**: 猜一个键的后果是补救轮把自己记到别的维度名下, 而那正是
 * 事后归因最不该出现的一种脏数据。新市场上线时这里当场红, 是设计如此。
 */
const SNAPSHOT_DIMENSION_KEY: Readonly<Record<string, DimensionKey>> = {
  us: 'option_daily_snapshot',
  hk: 'hk_option_daily_snapshot',
};

/**
 * `sync:<维度键>` —— 形状的定义方是 `dimensionJobName()` (marketdata-sync.queue.ts)。
 *
 * 🚫 **不从那边 import**: 那个模块 top-level `import 'bullmq'`, 拉进来会把本文件的 Small
 * 单测 (mock port + mock prisma, 零容器) 变成要起 bullmq/ioredis 的重测。`dimension-executor`
 * 的 tick 路径同样是就地拼这个前缀 (`const syncType = \`sync:${key}\``), 本处照它。
 */
function snapshotSyncType(market: string): string {
  const key = SNAPSHOT_DIMENSION_KEY[market];
  if (!key) {
    throw new Error(
      `[option-snapshot-remediation] 未登记市场 "${market}" 的快照维度键 —— ` +
        `新市场上线须补 SNAPSHOT_DIMENSION_KEY`,
    );
  }
  return `sync:${key}`;
}

@Injectable()
export class OptionSnapshotRemediation {
  private readonly logger = new Logger(OptionSnapshotRemediation.name);

  /** 归属判据的**唯一**取数入口 (#187) —— 曾内联 `resolvePreviousTradingDay` 一份同构查询。 */
  private readonly attribution: SnapshotSessionAttributionLookup;

  constructor(
    private readonly coverage: OptionSnapshotCoverageCheck,
    private readonly snapshot: SyncOptionSnapshotUseCase,
    private readonly prisma: PrismaService,
    @Inject(TRADING_CALENDAR_PORT) private readonly calendar: TradingCalendarPort,
    private readonly recorder: SyncRunRecorder,
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

  // 🚨 **港股两个触发点已于 073 退役** (FR-013, 原为 hk ① 级 23:40 / hk ② 级 08:30)。
  //    退役的是**触发点**, 不是机制: 下面两个方法本体与美股两条 cron 一字未动, 传 `'hk'`
  //    进去语义仍然正确 (见「按市场分派」那组单测)。
  //    港股的补漏改由 073 轮2 (`sync-option-oi-settle.usecase.ts` 段 b) 承担, 档位**严格更优**:
  //    同日、同 session、同 `source = eod`, 不留 `premarket_backfill` 痕, 且它与 OI 回填共用
  //    同一轮外呼。
  //    ⚠️ 代价已知并接受: 港股的重试深度从 3 (夜链 + 两级) 降到 2 (主轮 + 轮2)。clarify 期裁决。
  //    🚫 **别顺手补回来一个** —— 「零个 hk 触发点」有机械断言钉着 (同名 spec 顶部)。

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

    const { report: after } = await this.recollect(
      market,
      before,
      attribution.spec,
      'same_day_retry',
    );
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

    // 🚨 本级**落库 source** 由 {@link oiRefreshedAtEod} 派生, 🚫 MUST NOT 新开一张 per-market
    // 表 (2026-08-31 收口): `source` 第三段与 `eod` 分开的**唯一**理由是承载 OI vintage, 而
    // 「这个市场的 vintage 到底有没有差别」这个事实早已登记在 `MARKET_OI_SETTLE_LOCAL_MINUTE`
    // —— 再写一份 per-market 表就是同一事实两处各存一份, 调参那天必漂。
    //
    // 当晚定稿的市场 (hk) 两个 source 的 `oi_as_of` **逐值相同** ⇒ `source` 不承载任何信息,
    // 却让唯一键 `(contract_id, session_date, source)` 不再碰撞 ⇒ 本级平行写**整条链**, 而读侧
    // 「按 quote_as_of 取新」恒选中这份**闭市采**的行。2026-08-31 实证: hk:00700 为补 2 条被
    // 无套利守卫拒掉的腿重写了 **1110 行** (放大 555×), 而那批 greeks 是 vendor 在无盘口时
    // 退化用陈旧 `last` 反解出来的 (IV 30.7 vs 同日 `eod` 行 40.4, 与次日实时 40.4 对不上)。
    // ⇒ 定稿市场落 `eod` ⇒ 撞唯一键 ⇒ `createMany(skipDuplicates)` 挡掉已有行, **只补真缺的**;
    //   整场零行的日子 (hk 2026-08-24/25/26) 无行可撞, 照旧全量兜底 —— 两种缺口形态自动分流,
    //   不需要第二条判据。
    //
    // 🚫 仍然 MUST NOT 改成走 `resolveSnapshotAttribution` 推导 —— 上一节那条禁令原样成立:
    // 判据层在日历 `unknown` 那天会给出 `eod`, 把痕悄悄擦掉。本式**不读日历**, 只查
    // `MARKET_OI_SETTLE_LOCAL_MINUTE` + 一次时区折算, 且与写库侧 (`sync-option-snapshot.usecase`
    // 的 `oiFinalizedAtSessionClose`) 调的是**同一个函数**, 两处同源、改坏任一边单测立刻红。
    // 📌 未登记市场 `oiRefreshedAtEod` 返 `false` ⇒ 沿用 `premarket_backfill` (保守方向): 新市场
    //   若其 OI 盘前才翻新, 合并 source 会把两种 vintage 混成一个标签 —— 数字与标签双错且不报错。
    // 📌 FR-052 的「这天是靠兜底续命的」那条痕**不丢**, 载体换成 `sync_run.triggered_by =
    //   'premarket_backfill'`: 同样是落库行 (T025a 的独立探针一样数得到), 且**不参与唯一键**。
    const writeSource = oiRefreshedAtEod(market, sessionDate, now)
      ? SNAPSHOT_SOURCE_EOD
      : SNAPSHOT_SOURCE_PREMARKET_BACKFILL;
    // 🚨 **假修复闸** (2026-08-31, A′): 上一轮被硬门拒掉的合约, 重采**修不了** —— 拒的是内容
    // (`ask` 相对内在价值的偏差是持续的, 不是 vendor 抖动), 同样的报价再采一次还是同样被拒。
    // 而港股 08:30 盘前**无盘口** ⇒ 门 ④ 的输入缺失 ⇒ 那条门根本没跑 ⇒ 零违规 ⇒ 行落库 ⇒
    // 覆盖率数字达标 ⇒ 判「补回了」。**空数据反而比有瑕疵的数据更"合格"**, 而这一级正是靠它
    // 宣布成功的 (prod 2026-08-28 场实撞: hk:00700 两条深实值 PUT 撞 `ask_below_intrinsic`,
    // ① 级 23:40 重采仍被拒 `written=0`, ② 级 08:30 写入后判 recovered, ERROR 被吞成 WARN)。
    //
    // ⇒ 把「上一轮拒了谁」点名交给采集侧盯住 (`unjudgedWatch`), 本轮它们若仍是**没判成**的行,
    //   就不算修复。🚫 MUST NOT 退化成「本轮有任何 unjudged 行就判失败」: 港股闭市七成腿的门
    //   ①/④ 都判不动, 那样会让 hk 恒红 —— 判别器是**上一轮被拒**这个交集, 不是 unjudged 本身。
    const priorRejected = await this.priorGuardRejections(market, sessionDate);
    const focus = [...new Set(before.degraded.flatMap((u) => u.missingContractCodes))].filter(
      (code) => priorRejected.has(code),
    );

    const { report: after, stats } = await this.recollect(
      market,
      before,
      {
        sessionDate,
        mode: writeSource,
        marketScope: [market],
        now,
        unjudgedWatch: focus,
      },
      'premarket_backfill',
    );
    const attempted = before.degraded.map((u) => u.symbol);
    const falselyRecovered = stats.findings.flatMap((f) =>
      f.kind === 'unjudged' ? f.contracts : [],
    );
    if (falselyRecovered.length > 0) {
      // 覆盖率可能已经"达标"了, 所以这条 ERROR 不能等 `alertIfDegraded` 去发 —— 它看的是数字。
      this.logger.error(
        `[option-snapshot-remediation] ${market} ② 级**假修复**: ${sessionDate} 的 ` +
          `${falselyRecovered.length} 条合约上一轮被硬门拒, 本轮只拿到「门没判成」的行 ` +
          `(缺盘口 ⇒ 无套利下界根本没跑) ⇒ 缺口未修, 覆盖率数字不作数: ` +
          `${falselyRecovered.join(', ')}`,
      );
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
    if (after.status !== 'degraded') {
      // 降级 MUST 留痕 + 告警 (FR-052), 但**不是** ERROR —— 缺口已补上。留痕的权威形态是
      // 落库行的 `source`, 本条 log 只是让它当场可见。
      this.logger.warn(
        `[option-snapshot-remediation] ${market} ② 次日盘前兜底补回 ${sessionDate} (source=` +
          `${writeSource}, 本日数据来自兜底补采): ${attempted.join(', ')}`,
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
   *
   * ## 🚨 本级开自己的 `SyncRun` 行 —— 补救轮此前在库里**完全不存在**
   *
   * `collect()` 会把硬门拒绝写进 `stats.findings` (#198 的违规码 + #261 的带数字样本), 而
   * `stats` 要变成库里的一行**只有一条通道**: {@link SyncRunRecorder.finish}。本方法此前拿
   * 一个局部 `emptyStats()` 接住再丢掉 ⇒ 补救轮上的拒绝**三层全空**:
   *   ① 没有 `sync_run` 行 ⇒ findings 落不了库;
   *   ② 那条兜底 WARN 的条件是 `stats.failed > 0`, 而硬门拒绝**蓄意不计 `failed`**
   *      (粒度是标的不是行, 见 `SyncRunFinding` 的 `reject` 注释) ⇒ 连 WARN 都不打;
   *   ③ `RemediationOutcome` 被 @Cron handler 直接 await 掉, 无人接收。
   * 2026-08-28 实证: 08:00 那轮 us ① 级把 1110 行按美股语义写进港股 (#255), 而 `sync_run`
   * 里**查无此轮** —— 唯一能证明它发生过的东西是那批行自己的 `quote_as_of`。
   *
   * 📌 形态照 `dimension-executor` 的 tick 路径逐字来 (start → collect → finish, catch 收
   * `failed` 不留悬挂 running 行), 因为「一次执行 = 一行」这个口径**只该有一份**。
   */
  private async recollect(
    market: string,
    before: OptionCoverageReport,
    spec: SnapshotCollectionSpec,
    level: RemediationLevel,
  ): Promise<{ report: OptionCoverageReport; stats: SyncRunStats }> {
    const stats: SyncRunStats = emptyStats();
    const runId = await this.recorder.start(snapshotSyncType(market), {
      // 🚨 两级各报自己是谁 —— 判据侧「只有 tick 算一轮」(#202) 据此把补救轮排除在计数外。
      triggeredBy: level,
      asOf: spec.sessionDate,
    });
    try {
      // 🚨 只重采**缺的那几票**, 不整轮重跑: 整轮会让已达标的票平白多一批 vendor 请求, 且在
      // ② 级把 `premarket_backfill` 的痕盖到本来正常的票上。
      await this.snapshot.collect(before.degraded.map(toWorkingInstrument), spec, stats);
      await this.recorder.finish(runId, deriveStatus(stats), stats);
    } catch (err) {
      // 顶层异常: 收成 failed, 不留 running 悬挂行 (同 dimension-executor)。
      await this.recorder.finish(runId, 'failed', stats);
      throw err;
    }
    if (stats.failed > 0) {
      this.logger.warn(
        `[option-snapshot-remediation] ${market} 重采期间 ${stats.failed} 票失败: ` +
          `${JSON.stringify(stats.findings)}`,
      );
    }
    // 🚨 连 `stats` 一起返回 —— 复判只看覆盖率数字是分不出「真补回了」与「靠没判成的行凑够
    // 了行数」的 (见 {@link backfillPremarket} 的假修复判据), 而那个信息只活在本轮的 findings 里。
    return { report: await this.coverage.evaluate(market, spec.sessionDate), stats };
  }

  /**
   * 同一 `(sync_type, as_of)` 下**既往轮**被落库前硬门拒掉的合约码 (2026-08-31, A′)。
   *
   * 🚨 它答的是「这条腿到底是**没采到**还是**采到了被拒**」—— 覆盖率只数逐合约行数, 两者
   * 长得一模一样 (都是「该合约当日无行」), 而处置**完全相反**: 没采到 ⇒ 重采能救; 被拒 ⇒
   * 内容问题, 重采一万次也是同样的报价、同样被拒。判别信息只活在 `sync_run.findings` 里。
   *
   * 📌 本级跑在自己的 `SyncRun` 行**开出来之前**调用 ⇒ 读到的恒是既往轮 (夜链 + ① 级)。
   * 📌 `findings` 是 `Json?`, 形状的单一来源是 `SyncRunFinding` —— 这里只按 `kind` 取, 拿不准
   *    的行一律跳过 (历史行可能是旧形状), 🚫 MUST NOT 因为一条读不懂的 finding 就炸掉本级。
   *
   * 复杂度: 一次按 `(sync_type, as_of)` 的索引查询 + `O(findings)` 展平。
   */
  private async priorGuardRejections(market: string, sessionDate: string): Promise<Set<string>> {
    const runs = await this.prisma.syncRun.findMany({
      where: { syncType: snapshotSyncType(market), asOf: new Date(`${sessionDate}T00:00:00Z`) },
      select: { findings: true },
    });
    const rejected = new Set<string>();
    for (const run of runs) {
      if (!Array.isArray(run.findings)) continue;
      for (const raw of run.findings) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const entry = raw as { kind?: unknown; contracts?: unknown };
        if (entry.kind !== 'reject' || !Array.isArray(entry.contracts)) continue;
        for (const code of entry.contracts) if (typeof code === 'string') rejected.add(code);
      }
    }
    return rejected;
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
