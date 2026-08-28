import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../security/prisma.service.js';
import type {
  ExecutorInput,
  ExecutorSyncDimensionRow,
  WorkingInstrument,
} from './dimension-executor.js';
import { detectOptionAnomalies, type OptionAnomalyRow } from './option-anomaly.rules.js';
import {
  checkOptionSnapshotRows,
  type OptionSide,
  type OptionSnapshotGuardRow,
  type OptionSnapshotVerdict,
} from './option-snapshot-guard.rules.js';
import {
  OPTION_SNAPSHOT_MAX_CONTRACT_CODES,
  OPTION_SNAPSHOT_PORT,
  OptionSnapshotBudgetExhaustedError,
  type OptionSnapshotPort,
  type OptionSnapshotRow,
} from './option-snapshot.port.js';
import { addWritten, type SyncRunStats } from './sync-run.recorder.js';
import { SnapshotSessionAttributionLookup } from './snapshot-session-attribution.lookup.js';
import type { SnapshotAttribution } from './snapshot-session-attribution.rules.js';
import { oiRefreshedAtEod } from './market-session.rules.js';
import { TRADING_CALENDAR_PORT, type TradingCalendarPort } from './trading-calendar.port.js';

/**
 * 逐日快照维度 use case (047 T016, FR-030/031/032/037/040/043/044)。
 *
 * 每票一步到底: 读**自己**的合约表取工作集 → 按 ≤399 合约切批 → 逐批打快照端口 (标的自身
 * 并在同一批里, spot 不另发调用) → 逐行过硬门 → `createMany(skipDuplicates)` 落
 * `marketdata.option_daily_snapshot`。
 *
 * ## 🚨 hard 依赖链发现 (FR-031): 合约表无行 ⇒ **零外呼**
 *
 * 快照的工作集不是「锚」而是「锚的合约」—— 链发现没跑过 (或该票根本没有期权链) 时, 本维度
 * 对该票**一次请求都不发**并计 `skipped`。写成「照发请求让 vendor 返空」会把一个明确的前置
 * 缺失变成一次成功的空采集, 且白烧限频预算。工作集口径 = **到期日 ≥ 当前交易日**
 * (FR-028a: 当日到期的合约当日仍可取快照; 选约表那侧才是 `>`, 两处故意不同)。
 *
 * ## 🚨 三个时点列各自取值 (Guardrail 6 / plan D-DATA-4) —— 本片最容易盲写错的一条
 *
 * | 列 | 取值 | 为什么不能省 |
 * | --- | --- | --- |
 * | `session_date` | 当前 **us** 交易日 (`exchangeCalendarDateForScope`, 按**执行时刻**求) | 取 `input.asOf` 会拿入队时刻的日期; 取宿主日会错位一天且每周固定丢周五 |
 * | `quote_as_of` | **本批**采集时刻 (端口 envelope 的 `as_of`) | 行内 vendor `update_time` 是**最后成交时刻**, 停牌腿会把采集时刻说成上周 |
 * | `oi_as_of` | **上一交易日** | 官方文档明写「美股期权 OI 在**盘前时段**更新」⇒ T 日收盘后采的快照, 其 OI 其实是 **T−1 日**的持仓量 |
 *
 * 🚫 **MUST NOT 为「对齐」把 OI 归到 `session_date`** —— 那是拿标签掩盖真实 vintage:
 * 三个字段全填 `session_date` **永远不会红**, 但活跃度排名与 UI 的 `asOf` 全错一天。
 *
 * ## 🚨 硬门**逐行**拒绝 (FR-043)
 *
 * `checkOptionSnapshotRows` 从不抛异常, ERROR 的上抬归本 use case。违规行不入库、同批其余行
 * 照常入库 —— 整批回滚会让一条脏行带走**当日唯一一次采集机会** (vendor 不提供历史交易日的
 * 期权快照), 且「MUST NOT 破坏已落历史」在 append-only + `skipDuplicates` 下天然成立。
 *
 * ## 幂等 (FR-037) = `createMany(skipDuplicates)` on `(contract_id, session_date, source)`
 *
 * 同日重跑第二遍全被唯一键挡掉 —— 换 `upsert` 会让重跑改写已落行的 `quote_as_of`, 而那一列的
 * 意义正是「这一行是什么时候采的」。夜间维度走 `eod`; ② 级盘前兜底 (FR-046, `option-snapshot-
 * remediation.ts`) 走 `premarket_backfill` 并**共用本 use case 的 {@link
 * SyncOptionSnapshotUseCase.collect}** —— 两条路径只差三个时点列的取值, 复制一份采集循环必漂移。
 */

/**
 * 单次 `createMany` 的行数配额: 单票全链约 2150 行不塞一条语句。500 = Prisma 社区 + PG
 * bulk-load 共识区间, 同 `sync-option-contract.usecase.ts` 的 `CONTRACT_ROW_CHUNK`。
 */
const SNAPSHOT_ROW_CHUNK = 500;

/** 收盘后正常采集 (FR-040 幂等键第三段的两个活值之一)。 */
export const SNAPSHOT_SOURCE_EOD = 'eod';

/** 次日美股盘前窗口的 ② 级兜底补采 (FR-046)。 */
export const SNAPSHOT_SOURCE_PREMARKET_BACKFILL = 'premarket_backfill';

/**
 * 采集路径。**取值同时就是 `source` 列的值** —— 「走的哪条路径」与「这行是哪来的」本就是同
 * 一件事, 分成两个概念只会让它们各自漂移。
 */
export type SnapshotCollectionMode =
  | typeof SNAPSHOT_SOURCE_EOD
  | typeof SNAPSHOT_SOURCE_PREMARKET_BACKFILL;

/** 一次采集的归属声明 (三个时点列的取值全从这里派生)。 */
export interface SnapshotCollectionSpec {
  /** 落 `session_date` 的**业务日** `YYYY-MM-DD` (调用方按 us 市场时区求值)。 */
  sessionDate: string;
  mode: SnapshotCollectionMode;
  /** 求「上一交易日」用的市场范围 (仅 `eod` 路径用到)。 */
  marketScope: string[];
  /**
   * 本轮的**绝对时刻** (T024a): 异常监控 ② 的 DTE 基准由 `daysToExpiry` 从它折成 **ET 的今天**。
   *
   * 🚫 收 instant 而非 `sessionDate` 那个字符串: 后者是**归属业务日**, 而 DTE 要的是「今天离
   * 到期还有几天」—— 盘前兜底路径上两者恰好差一天 (补的是昨天的 session, 数的是今天到期距离),
   * 拿 `sessionDate` 当基准会让豁免线在补采路径上系统性偏一天且永远不会红 (Guardrail 18)。
   */
  now: Date;
}

/** 三个时点列 + 来源, 逐行落库前已解析完毕。 */
interface ResolvedSnapshotContext {
  sessionDate: string;
  source: SnapshotCollectionMode;
  oiAsOf: Date;
}

/** `YYYY-MM-DD` → `@db.Date` 列的 UTC 零点 Date。 */
const toDateOnly = (s: string): Date => new Date(`${s}T00:00:00Z`);

/** UTC `Date` → `YYYY-MM-DD`。 */
const toIsoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** 切片成 size 大小的块 (同 `sync-option-contract.usecase.ts` 的同名私有 helper)。 */
function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * 交易日历缺行时的**兜底**上一交易日: 往前退到最近的工作日 (周末跳过, 节假日**不认**)。
 *
 * 取值方向由不对称性决定: 这条路径本不该发生 (`trading_day` 的 us 行由日历维度每日填充),
 * 但真发生时 —— 整轮不落库 = 当日快照永久缺口 (买不回来), 而近似的 `oi_as_of` 只是一个可回查
 * 订正的标签。⇒ 落库继续, 但**抬 ERROR**。🚫 兜底值仍恒 `< session_date`, 绝不退化成
 * `session_date` 本身 (那正是 Guardrail 6 要防的那件事)。复杂度 O(1) (最多退 3 天)。
 */
function previousWeekday(date: string): string {
  const d = toDateOnly(date);
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return toIsoDate(d);
}

/**
 * 合约表投影: id 建 FK, code 做批次键, 类型/行权价/is_standard 喂硬门 (#186: 非标合约的内在
 * 价值算不出 ⇒ 门 ④ 跳过); 另两列 (T024a) 喂异常监控 —— root 配 is_standard 判 ③「新非标
 * root」, expiry_date 判 ② 的 DTE 豁免线。
 *
 * 🚨 三列一律取**库内合约行**而非 vendor 快照行: 落库归属的是前者, 让告警面与入库面对同一条
 * 腿的判断同源 (同 `toGuardRow` 的口径)。
 */
interface WorkingContract {
  id: bigint;
  code: string;
  optionType: string;
  strikePrice: Prisma.Decimal;
  root: string;
  isStandard: boolean;
  expiryDate: Date;
}

@Injectable()
export class SyncOptionSnapshotUseCase {
  private readonly logger = new Logger(SyncOptionSnapshotUseCase.name);

  /** 归属判据的**唯一**取数入口 (#187) —— 曾在本类内联三个私有查询, 与另外两处逐字同构。 */
  private readonly attribution: SnapshotSessionAttributionLookup;

  constructor(
    @Inject(OPTION_SNAPSHOT_PORT) private readonly snapshot: OptionSnapshotPort,
    private readonly prisma: PrismaService,
    // #181: 归属判据要问「今天是不是交易日」的**三态** —— `unknown` 必须走「不猜口径、放弃」
    // 那一档 (062 T009)。这是真实依赖不是顺手注入: 定「这批数据归哪一场」本来就需要交易日历。
    @Inject(TRADING_CALENDAR_PORT) calendar: TradingCalendarPort,
  ) {
    this.attribution = new SnapshotSessionAttributionLookup(prisma, calendar);
  }

  /**
   * 逐票快照。返 `true` = vendor 预算耗尽 (顺延信号, `ExecutorResult.budgetExhausted`)。
   *
   * **per-instrument 隔离** (016 四支柱): 单票失败计 `failed` + `findings` 后继续下一只,
   * 不整轮塌; **HTTP 在事务外**。
   *
   * 复杂度: O(工作集) 次合约表查询 + Σ O(合约数 / 399) 次快照调用 + O(合约数 / 500) 次
   * createMany; 硬门 O(合约数)。
   */
  async run(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<boolean> {
    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    // 🚨 #181: 归属**必须**走判据层, MUST NOT 在这里写死 `sessionDate = 当前日历日` + `eod`。
    // 日历日 00:00 就翻页, 与「这一场收没收盘」无关 —— 队列延迟把本 job 挤过午夜就整批标错
    // 一天且不可逆 (2026-08-25 01:30 prod 实撞, 2200 行)。判据与它的完整理由见
    // `snapshot-session-attribution.rules.ts`。
    const attribution = await this.resolveAttribution(dim, input.now);
    if (attribution.decision === 'skip') {
      // **不是失败**: 端点此刻返的是盘中态, 落成任何 session 的收盘都是脏数据 ⇒ 本轮不采。
      // 计 skipped 让「跑了但没采」与「采了零行」可分辨 (同 written 三态的判据)。
      stats.skipped += instruments.length;
      this.logger.warn(
        `[option-snapshot] 该场进行中, 本轮不采 (端点此刻返盘中态): ${dim.marketScope.join('/')}`,
      );
      return false;
    }
    if (attribution.decision === 'abandon') {
      // ERROR 级 = 需人工介入 (补前瞻视野), 与冷启动的 `calendar_missing` 同档。
      stats.skipped += instruments.length;
      this.logger.error(
        `[option-snapshot] 交易日历查不到 ${dim.marketScope.join('/')} 上一个已收盘交易日 ⇒ ` +
          `判不出归属, 放弃本轮 (MUST NOT 猜日子: 猜错就是一批 session_date 标错的脏行)`,
      );
      return false;
    }
    // 🚨 spec **原样**喂下去, 别在这里重算任何一格 —— 重算就是第二处判据。
    return this.collect(instruments, attribution.spec, stats);
  }

  /**
   * 单市场 scope 守卫 + 归属决策 (#181)。日历查询与判据均已单点化 (#187), 本方法只剩
   * 「维度行 → 市场」这一格适配。
   */
  private async resolveAttribution(
    dim: ExecutorSyncDimensionRow,
    now: Date,
  ): Promise<SnapshotAttribution> {
    // 🚨 单市场 scope 是本维度族的**前提**: 盘中闸问的是「**这个市场**的这一场收了没」,
    // 混 scope 没有单一答案。fail-closed 抛而不是挑第一个 —— 挑一个会让另一个市场的行
    // 静默标错, 且不报错。
    if (dim.marketScope.length !== 1) {
      throw new Error(
        `[option-snapshot] 归属判据要求单市场 scope, 收到 ${JSON.stringify(dim.marketScope)} ` +
          `(混 scope 请拆成各自的维度)`,
      );
    }
    return this.attribution.resolve(dim.marketScope[0], now);
  }

  /**
   * 采集本体 (夜间维度与 ② 级盘前兜底**共用**)。返 `true` = vendor 预算耗尽。
   *
   * ## 🚨 两条路径唯一的差别就在 `oi_as_of` 的方向 (Guardrail 6 / plan D-DATA-4)
   *
   * | 路径 | `source` | `session_date` | `oi_as_of` |
   * | --- | --- | --- | --- |
   * | 收盘后正常采集 | `eod` | 当前 us 交易日 | **上一交易日** (T 日的 OI 要 T+1 盘前才发布) |
   * | 次日盘前兜底 | `premarket_backfill` | **被补的那一天** | **= `session_date`** (盘前 OI 已翻新, 正是被补那天的真值) |
   *
   * 🚫 **MUST NOT 把两者无差别抹平成同一个取值** —— 抹平后永远不会红, 但两条路径产出的 OI
   * 差一天, 而活跃度排名与 UI 的 asOf 都读它。
   *
   * ## 🚨 上表第三列是 **us 口径**; `eod` 那一行按市场分叉 (066 T09, `FR-016`)
   *
   * 「T 日的 OI 要 T+1 才发布」是**清算所的**行为, 不是普适规律。hk 在 D 日收盘当晚就已定稿
   * (2026-08-25 U2 实测: 360 行样本里 OI 只在 D 日 16:30–21:30 之间变过一次, 跨 22:00 日终
   * 那一拍 0/30) ⇒ hk 走 `eod` 时 `oi_as_of` **= `session_date`**, 不退到上一交易日。
   * 事实位登记在 {@link oiRefreshedAtEod}, 与判据层 (`snapshot-session-attribution.rules.ts`,
   * #187 起全仓唯一的一份, 冷启动已折进它) 读的是**同一张表** —— 两处同源, 改坏任一边单测立刻红。
   * 🚨 判据层给出的 `oiAsOf` 只喂单测对表, **真正写库的是这里** ⇒ 只改判据层会「单测全绿而
   * 库里照旧偏一天」。
   *
   * ## 🚨 「当晚定稿」是**时刻**判据, 故本处 MUST 把 `spec.now` 喂进去
   *
   * 上一段的实测把定稿时刻夹在 D 日 16:30–21:30 之间, 而本维度的 hk cron 跑 23:30 ⇒ **cron
   * 这条路** 恒在定稿之后, 静态查表也不会错。但 `collect` 还服务**事件驱动**那条路 (锚首建
   * 冷启动经 `resolveSnapshotAttribution` 直调本体, 不读 `sync_dimension`): 用户在 D 日 17:00
   * 建锚时, 端点返的仍是 **D−1 的 OI**, 而静态判据照样标 D ⇒ 数字与标签双错。
   * 🚨 更要命的是它**不可回补**: 本处 `createMany(skipDuplicates)` 的唯一键是
   * `(contract_id, session_date, source)` ⇒ 冷启动先落的那批行会让当晚 23:30 那轮**正确的**
   * 写入被静默跳过, 而供应方不提供历史快照。
   * 📌 与之相对, `underlying_spot` 在同一时刻的偏早 (港股 CAS 撮合前的最后成交价) **不治** ——
   * `quote_as_of` 已如实记录采集时刻, 那个偏差是**披露过的**; 而 OI 标签没有任何列在披露它。
   */
  async collect(
    instruments: WorkingInstrument[],
    spec: SnapshotCollectionSpec,
    stats: SyncRunStats,
  ): Promise<boolean> {
    // 🚨 fail-closed: 工作集里每一只标的都必须属于本次声明的市场 (#255)。
    //
    // 下面整段 `ctx` 的三个时点列全部从 `spec` 派生, 而 `spec.marketScope` 决定了 OI 归属按
    // 哪个市场的清算行为算 —— 混进别的市场的标的, 产出的就是「值对、标签错一天」的行, 且
    // **不报错**: 唯一键第三段是 `source`, 两套语义的行可以并存, 读侧按 `max(quote_as_of)`
    // 去重时错的那份还恒定胜出。2026-08-28 08:00 实撞 1110 行。
    //
    // 🚫 **MUST NOT 改成「过滤掉不属于本市场的」** —— 静默少采一批票与静默写错一批行同档,
    //    只是方向相反。调用方传错了就该当场知道。
    //
    // ⚠️ 与 `manual-sync-session-guard.ts` 记的那次「断言下沉到 collect() 失败」**不是一回事**,
    //    别把那条教训套到这里: 那条断言问的是「这一场收盘了没有」, 结论依赖墙上时钟 ⇒ IT 的
    //    成败取决于运行时刻。本条是**纯结构不变式**, 零时间依赖、零 I/O, 与本方法上方
    //    `resolveAttribution` 里那道 `marketScope.length !== 1` 的守卫同族。
    const foreign = instruments.filter((i) => !spec.marketScope.includes(i.market));
    if (foreign.length > 0) {
      throw new Error(
        `[option-snapshot] 工作集含 ${JSON.stringify(spec.marketScope)} 之外的标的: ` +
          `${foreign.map((i) => `${i.market}:${i.code}`).join(', ')} ` +
          `(归属语义按 marketScope 派生, 混市场会写出「值对、标签错一天」且不报错的行)`,
      );
    }
    // 全轮取一次: OI 的归属日只跟交易日历有关, 与标的无关。零工作集时也不该多查 —— 但它
    // 先于循环发生, 代价是 1 次索引查询, 换掉「每票重复查一遍」。
    // 066 T09: `eod` 路径的 OI 归属按市场分叉。该市场若在收盘当晚就把 OI 定稿, 此刻抓到的
    // 就是 `sessionDate` 自己的真值 —— 不必退到上一交易日, 连那次索引查询也一并省掉。
    // 🚨 `every` + 非空 而非 `some`: 混合 scope 下只有**全体**都当晚定稿才走这条, 否则保守
    // 沿用隔日口径。方向由不对称性定 (同 FR-016): 保守取值只是标签偏早, 一条确定性 UPDATE
    // 可订正; 而猜早了是标签与数字**双错**且不报错。空数组走 `every` 恒真是 JS 的坑, 显式挡掉。
    // 📌 混合 scope 今天不存在 (维度 per-market, 冷启动传 `[market]`) —— 这里写死答案是为了
    // 它将来出现时**有个确定行为**, 而不是留一个「碰巧看第一个元素」的隐式结果。
    const oiFinalizedAtSessionClose =
      spec.marketScope.length > 0 &&
      spec.marketScope.every((m) => oiRefreshedAtEod(m, spec.sessionDate, spec.now));
    const ctx: ResolvedSnapshotContext = {
      sessionDate: spec.sessionDate,
      source: spec.mode,
      oiAsOf:
        spec.mode === SNAPSHOT_SOURCE_EOD && !oiFinalizedAtSessionClose
          ? await this.resolveOiSessionDate(spec.marketScope, spec.sessionDate)
          : toDateOnly(spec.sessionDate),
    };
    // 🚨 T024a: 「已见过的非标 root」MUST 在**本轮落库之前**取一次 —— 载体就是快照历史本身,
    // 落完再取会把本轮刚落的行读成「见过」, ③ 于是永不触发且永远不会红 (见 loadKnownNonStandardRoots)。
    const knownNonStandardRoots = await this.loadKnownNonStandardRoots();
    // 全轮累积一批再判 (不逐票判): ① 的「整批零可用 greeks = 全域降级」需要看到**全域**,
    // 逐票判会把休市时段的一次采集变成 N 条假 WARN, 正是 T024 要避免的那件事。
    const anomalyRows: OptionAnomalyRow[] = [];
    let budgetExhausted = false;

    for (const inst of instruments) {
      stats.scanned++;
      if (budgetExhausted) {
        // 预算耗尽后不再外呼: 剩余标的整批顺延下一窗 (deferral ≠ failure)。
        stats.skipped++;
        continue;
      }
      const symbol = `${inst.market}:${inst.code}`;
      try {
        const synced = await this.syncUnderlying(inst.id, symbol, ctx, stats, anomalyRows);
        if (synced) stats.ok++;
        else stats.skipped++;
      } catch (err) {
        if (err instanceof OptionSnapshotBudgetExhaustedError) {
          budgetExhausted = true;
          stats.skipped++;
          this.logger.warn(`快照限频顺延 (剩余标的下一窗续跑): ${symbol}`);
          continue;
        }
        stats.failed++;
        stats.findings.push({
          kind: 'failure',
          symbol,
          step: 'option_daily_snapshot',
          error: String(err),
        });
      }
    }
    this.reportAnomalies(anomalyRows, knownNonStandardRoots, spec.now);
    return budgetExhausted;
  }

  /**
   * 单票: 取工作集 → 切批 → 逐批打端口 → 过硬门 → 落库。
   *
   * 返 `false` = 该票**无合约**(hard 依赖链发现未满足) ⇒ 调用方计 skipped 且本函数零外呼。
   */
  private async syncUnderlying(
    instrumentId: bigint,
    symbol: string,
    ctx: ResolvedSnapshotContext,
    stats: SyncRunStats,
    anomalyRows: OptionAnomalyRow[],
  ): Promise<boolean> {
    const contracts: WorkingContract[] = await this.prisma.optionContract.findMany({
      // FR-028a: 判据是 **≥** 当前交易日 —— 当日到期的合约当日仍可取快照。
      where: {
        underlyingInstrumentId: instrumentId,
        expiryDate: { gte: toDateOnly(ctx.sessionDate) },
      },
      select: {
        id: true,
        code: true,
        optionType: true,
        strikePrice: true,
        root: true,
        isStandard: true,
        expiryDate: true,
      },
      orderBy: { id: 'asc' },
    });
    if (contracts.length === 0) {
      // 🚨 hard 依赖链发现 (FR-031): 零外呼。不是失败, 但**两种成因定性相反** (#173) ——
      // 判据是同一张表的**全部**合约计数 (不带到期日过滤), 与上层冷启动的 `hasListedContracts`
      // 同口径, 两层对同一件事才不会一个说「常态」一个说「未覆盖?」。
      // 🚫 MUST NOT 无差别降级成一条日志: 「链发现 stale」那一档是真缺口, 埋掉就再也没人看。
      const listed = await this.prisma.optionContract.count({
        where: { underlyingInstrumentId: instrumentId },
      });
      if (listed === 0) {
        // 终态、非故障 —— 港股绝大多数标的没有挂牌期权, 066 开通港股后这一档从罕见变常态,
        // 抬 WARN 会每晚每票复发一条, 把真信号稀释掉 (SC-011: MUST NOT 产生需人工介入的告警)。
        this.logger.log(`跳过快照 (库中零期权合约 ⇒ 无挂牌期权): ${symbol}`);
        return false;
      }
      this.logger.warn(
        `跳过快照 (${listed} 个合约全部已到期 ⇒ 链发现 stale / 尚未轮到该票): ${symbol}`,
      );
      return false;
    }

    for (const batch of chunked(contracts, OPTION_SNAPSHOT_MAX_CONTRACT_CODES)) {
      const byCode = new Map(batch.map((c) => [c.code, c]));
      const { asOf, rows } = await this.snapshot.getSnapshots({
        underlyingSymbol: symbol,
        contractCodes: batch.map((c) => c.code),
      }); // HTTP (事务外)

      // 标的自身那行就在同一批里 (spot 不另发调用); 期权行经 `underlyingCode` 关联它。
      const spotByCode = new Map(rows.filter((r) => !r.isOption).map((r) => [r.code, r.last]));
      const optionRows = rows.filter((r) => r.isOption);
      const guardRows = optionRows.map((row) => {
        const contract = byCode.get(row.code);
        if (contract === undefined) {
          // 落到别的合约名下比没落更难发现 (同链发现的「合约归属错配」闸)。
          throw new Error(
            `[option-snapshot] 快照行不在本批请求内 (契约变更 / 批次错配?): 请求 ${symbol} ` +
              `${batch.length} 个合约, 却收到 ${row.code}`,
          );
        }
        return this.toGuardRow(row, contract, spotByCode);
      });

      const verdicts = checkOptionSnapshotRows(guardRows);
      this.reportRejected(symbol, verdicts, stats);

      const persistable = optionRows.filter((_, i) => verdicts[i].admitted);
      const spotOf = (row: OptionSnapshotRow) => spotByCode.get(row.underlyingCode ?? '') ?? null;
      const data = persistable.map((row) =>
        this.toSnapshotRow(row, byCode.get(row.code) as WorkingContract, {
          ...ctx,
          quoteAsOf: asOf,
          spot: spotOf(row),
        }),
      );
      // 🚨 异常监控的判定面 = **落库行** (T024a): 被硬门拒的行已由 reportRejected 出过 ERROR,
      // 再进 WARN 就是同一件事报两遍; 且它们不会进快照历史 ⇒ 拿它们报 ③ 会让「记忆面」与
      // 「判定面」永久错位 (那个 root 天天报, 而 T024 的 ③ 恰恰是为了只报一次)。
      for (const row of persistable) {
        anomalyRows.push(
          this.toAnomalyRow(row, byCode.get(row.code) as WorkingContract, spotOf(row)),
        );
      }
      for (const chunk of chunked(data, SNAPSHOT_ROW_CHUNK)) {
        addWritten(
          stats,
          (await this.prisma.optionDailySnapshot.createMany({ data: chunk, skipDuplicates: true }))
            .count,
        );
      }
      if (optionRows.length < batch.length) {
        // 覆盖率核对是 FR-045 (另 task) 的事; 这里只留可 grep 的痕, 不自建第二套判据。
        this.logger.warn(
          `快照行数少于请求合约数 (停牌 / 刚摘牌?): ${symbol} ` +
            `请求 ${batch.length} 收到 ${optionRows.length}`,
        );
      }
    }
    return true;
  }

  /** 端口行 + 合约行 → 硬门入参。行权价与买卖方向取**库内**合约行 (落库归属的就是它)。 */
  private toGuardRow(
    row: OptionSnapshotRow,
    contract: WorkingContract,
    spotByCode: Map<string, string | null>,
  ): OptionSnapshotGuardRow {
    return {
      contractCode: row.code,
      optionSide: contract.optionType as OptionSide,
      strikePrice: contract.strikePrice,
      isStandard: contract.isStandard,
      bid: row.bid,
      ask: row.ask,
      delta: row.delta,
      underlyingSpot: spotByCode.get(row.underlyingCode ?? '') ?? null,
    };
  }

  /**
   * 违规行 → ERROR + `findings` 审计痕。
   *
   * **不计 `failed`**: 那个计数的粒度是「标的」, 用它记行级拒绝会把一票里的一条脏行说成整票
   * 失败并触发降级告警。`findings` 作审计明细通道是既有用法 (同
   * `SyncRunRecorder.recordSkippedWithReason`)。FR-043 要的「ERROR」是这条 log。
   */
  private reportRejected(
    symbol: string,
    verdicts: OptionSnapshotVerdict[],
    stats: SyncRunStats,
  ): void {
    const rejected = verdicts.filter((v) => !v.admitted);
    if (rejected.length === 0) return;
    const detail = rejected
      .map(
        (v) => `${v.contractCode}: ${v.violations.map((x) => `${x.code}(${x.reason})`).join('; ')}`,
      )
      .join(' | ');
    this.logger.error(
      `[option-snapshot] 落库前硬门拒绝 ${rejected.length} 行 (不入库, 已落历史不受影响): ` +
        `${symbol} ${detail}`,
    );
    // #198 / #261: 违规码是**唯一**能分辨四条门的东西, 样本是**唯一**能判「差多少」的东西。
    // 两者此前都只出现在上面那条 ERROR 里, 而日志只进容器 stdout (30MB 环, 无投递, 部署即滚)
    // —— `findings` 才是持久的那一份。不带进来, 事后就只剩一个 `rejected: N`: us:CPB 连拒四晚
    // 是这么变成不可归因的, hk:00700 那四张深实值 PUT「ask 到底差内在价值多少」同理。
    // 🚫 去重聚合而非逐合约: `contracts` 的数组形状**不变**, 既有读者不受影响。
    // 🚨 码与样本从**同一个 Map** 派生 ⇒ 同序等长由构造保证, 不会各排各的然后悄悄错位。
    const sampleByCode = new Map<string, string>();
    for (const v of rejected) {
      for (const x of v.violations) {
        if (!sampleByCode.has(x.code)) sampleByCode.set(x.code, `${v.contractCode}: ${x.reason}`);
      }
    }
    const byCode = [...sampleByCode].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    stats.findings.push({
      kind: 'reject',
      symbol,
      step: 'option_snapshot_guard',
      rejected: rejected.length,
      contracts: rejected.map((v) => v.contractCode),
      violations: byCode.map(([code]) => code),
      violationSamples: byCode.map(([, sample]) => sample),
    });
  }

  /**
   * 端口行 + 合约行 → 异常监控入参 (T024a)。
   *
   * 🚨 **蓄意不带 `greeksComplete`** —— {@link OptionAnomalyRow} 的入参里根本没有它的位置:
   * 2026-08-07 真 vendor 实测 `greeks_complete === true` 而五个数全为 0, 完整性标记**不蕴含**
   * 值可用。把标记递过去就等于给「拿标记当证据」留了门。
   */
  private toAnomalyRow(
    row: OptionSnapshotRow,
    contract: WorkingContract,
    spot: string | null,
  ): OptionAnomalyRow {
    return {
      contractCode: row.code,
      optionSide: contract.optionType as OptionSide,
      root: contract.root,
      isStandard: contract.isStandard,
      expiryDate: contract.expiryDate,
      strikePrice: contract.strikePrice,
      underlyingSpot: spot,
      iv: row.iv,
      delta: row.delta,
      gamma: row.gamma,
      vega: row.vega,
      theta: row.theta,
    };
  }

  /**
   * 三条异常监控 (FR-047/048/049) 的**上报**: 逐条 finding 一行 WARN。
   *
   * 上报形态顺 {@link SyncOptionSnapshotUseCase.reportRejected} 的 log-based alerting (同
   * `alertIfDegraded` 范式), **不另造通道**。🚫 不进 `stats.findings`: 那条通道只在
   * `sync_run.status` 为问题态时才被次日日报展开, 而本组恒为 WARN 且不改判 `failed` ⇒ 写进去
   * 只是让一条永不被读的 JSON 变长。🚫 更不碰 FR-046 的**当日触达** —— 那道门的唯一载体是
   * T025a 的独立 timer (Guardrail 16), 本组是完全不同的一条线。
   *
   *   ⚠️ #209 注记 (顺序敏感, 别倒着做): 「只在问题态展开」是**读侧**的毛病, 不是这条通道的
   *   性质 —— 三步法第 2 步会把 `ops/jobs/marketdata-sync-report.sh` 改成按 `kind` 展开。那之后
   *   本段第一个 🚫 的前提就消失了, 这组 finding 应当改走 `stats.findings` 的 `kind:'notice'`。
   *   **但必须等读侧先改**: 反过来先动这里, 只是往一条仍然没人读的 JSON 里多塞一种形态。
   *   (第二个 🚫「不碰当日触达」与 #209 无关, 那条线照旧。)
   *
   * 复杂度 O(n)，n = 本轮落库行数 (判定单趟遍历, findings 基数为常数)。
   */
  private reportAnomalies(
    rows: OptionAnomalyRow[],
    knownNonStandardRoots: string[],
    now: Date,
  ): void {
    // 零落库行 ⇒ 无判定对象。判一遍会拿空批算出「零可用 greeks」之类的空洞结论。
    if (rows.length === 0) return;
    const report = detectOptionAnomalies({ rows, now, knownNonStandardRoots });
    for (const finding of report.findings) {
      this.logger.warn(
        `[option-anomaly] ${finding.code} (${finding.affected} 条): ${finding.reason}` +
          (finding.samples.length > 0 ? ` | 样本: ${finding.samples.join(', ')}` : ''),
      );
    }
  }

  /**
   * 「已见过的非标 root」(T024 ③ 的 `knownNonStandardRoots`) —— **载体 = 既有两表, 无新表无新列**。
   *
   * 判据 = `is_standard = false` **且该 root 已有过快照行**。
   *
   * ## 🚨 为什么不能只查 `option_contract`
   *
   * 链发现是快照的 hard 前置 (FR-031) 且**同一夜先跑**: 新非标 root 在本 use case 开跑时早已
   * 躺在合约表里 ⇒ 「合约表里有没有」恒为「有」, ③ 永不触发, 而且**永远不会红**。把记忆钉在
   * **快照历史**上才与判定面 (落库行) 同一 population。
   *
   * ## 🚨 为什么必须在本轮落库**之前**取
   *
   * 落完再取会把本轮刚落的行读成「见过」—— 同上, 首见永远为空。反过来, 放在落库前取还白得一个
   * 正确行为: 同日重跑时今日行已在库 ⇒ 静默 (同一天的同一件事只说一次), 次日同理。
   *
   * 复杂度: 一次 `option_contract` 上的过滤 + 对快照唯一索引 `(contract_id, …)` 的存在性探测;
   * 非标合约是全表里的极小子集, 且全轮只跑一次。
   */
  private async loadKnownNonStandardRoots(): Promise<string[]> {
    const rows = await this.prisma.optionContract.findMany({
      where: { isStandard: false, snapshots: { some: {} } },
      select: { root: true },
      distinct: ['root'],
    });
    return rows.map((r) => r.root);
  }

  /** 端口行 + 合约行 + 三个时点 → `option_daily_snapshot` createMany 行。 */
  private toSnapshotRow(
    row: OptionSnapshotRow,
    contract: WorkingContract,
    ctx: ResolvedSnapshotContext & { quoteAsOf: Date; spot: string | null },
  ): Prisma.OptionDailySnapshotCreateManyInput {
    return {
      contractId: contract.id,
      sessionDate: toDateOnly(ctx.sessionDate),
      source: ctx.source,
      quoteAsOf: ctx.quoteAsOf,
      // 🚨 Guardrail 6: eod 路径下是**上一交易日**而非 sessionDate; 盘前兜底路径反之
      // (取值已在 collect() 按 mode 解析完, 见那里的对照表)。
      oiAsOf: ctx.oiAsOf,
      // 金融数值全程 string 直传 Decimal 列 (FR-S08); 缺失恒 null, 禁 0 冒充。
      bid: row.bid,
      ask: row.ask,
      bidSize: row.bidSize,
      askSize: row.askSize,
      last: row.last,
      prevClose: row.prevClose,
      iv: row.iv,
      delta: row.delta,
      gamma: row.gamma,
      vega: row.vega,
      theta: row.theta,
      rho: row.rho,
      openInterest: row.openInterest,
      netOpenInterest: row.netOpenInterest,
      volume: row.volume,
      turnover: row.turnover,
      underlyingSpot: ctx.spot,
      vendorUpdateTime: row.vendorUpdateTime,
      // 期权行的完整性标记由 adapter 保证为 boolean (null 只属非期权行, 已被上游滤掉)。
      greeksComplete: row.greeksComplete === true,
    };
  }

  /**
   * OI 的归属交易日 = `session_date` 的**上一交易日** (Guardrail 6)。
   *
   * 权威来源是 `marketdata.trading_day` (日历维度每日填充, `CALENDAR_MARKETS` 含 us) ——
   * 「减一天」会在周一与长假后错成非交易日。缺行时走 {@link previousWeekday} 兜底并抬 ERROR,
   * 见该函数注释的不对称性论证。
   *
   * ⚠️ 查询本体已归 {@link SnapshotSessionAttributionLookup.tradingDayBefore} (#187) —— 本方法
   * 只保留**兜底 + ERROR** 那半段, 它连同它的告警全仓仍只有这一处。
   * 复杂度: 1 次 (market, date) 主键索引上的倒序 limit-1 查询。
   */
  private async resolveOiSessionDate(marketScope: string[], sessionDate: string): Promise<Date> {
    const prev = await this.attribution.tradingDayBefore(marketScope, sessionDate);
    if (prev !== null) return toDateOnly(prev);

    const fallback = previousWeekday(sessionDate);
    this.logger.error(
      `[option-snapshot] 交易日历缺 ${marketScope.join('/')} 在 ${sessionDate} 之前的行, ` +
        `oi_as_of 退到最近工作日 ${fallback} (近似值, 节假日不认) —— 请补交易日历`,
    );
    return toDateOnly(fallback);
  }
}
