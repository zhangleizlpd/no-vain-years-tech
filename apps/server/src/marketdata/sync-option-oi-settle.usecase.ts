import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service.js';
import type {
  ExecutorInput,
  ExecutorSyncDimensionRow,
  WorkingInstrument,
} from './dimension-executor.js';
import { oiRefreshedAtEod } from './market-session.rules.js';
import { OptionSnapshotCoverageCheck } from './option-snapshot-coverage.check.js';
import {
  OPTION_SNAPSHOT_MAX_CONTRACT_CODES,
  OPTION_SNAPSHOT_PORT,
  OptionSnapshotBudgetExhaustedError,
  type OptionSnapshotPort,
} from './option-snapshot.port.js';
import { SnapshotSessionAttributionLookup } from './snapshot-session-attribution.lookup.js';
import type { SnapshotAttribution } from './snapshot-session-attribution.rules.js';
import { SNAPSHOT_SOURCE_EOD, SyncOptionSnapshotUseCase } from './sync-option-snapshot.usecase.js';
import { addWritten, emptyStats, type SyncRunStats } from './sync-run.recorder.js';
import { TRADING_CALENDAR_PORT, type TradingCalendarPort } from './trading-calendar.port.js';

/**
 * 轮2 —— 港股期权「OI 定稿回填」维度 use case (073 T002/T003, FR-006…FR-011, plan §D3)。
 *
 * ## 它为什么是一个独立的轮次
 *
 * 报价与 OI 的**最优采集时刻不是同一个**: 做市商盘口在港股收盘后阶梯式撤走 (16:2x 那一档
 * 只有 11.5% 的腿缺买价, 到 23:00 变成 45.2%), 而未平仓量要等清算侧 21:30 才定稿。原先一轮
 * 打包采集只能二选一, 073 把它拆成主轮 16:20 抢报价 + 本轮 21:40 补 OI。
 *
 * ## 两段写, 且 MUST 对**不相交**的合约集 (Guardrail 2)
 *
 * | 段 | 对象 | 动作 |
 * | --- | --- | --- |
 * | a | 主轮已写的行 `(contract_id, session_date, source='eod')` | **定向 UPDATE 三列**: `open_interest` / `net_open_interest` / `oi_as_of` |
 * | b | 主轮整行缺失的合约 | 复用主轮的采集本体补整行 (073 T003) |
 *
 * 🚫 **MUST NOT 写成「先全量 createMany 再全量 UPDATE」** —— 那对已有行是 no-op、对新行是
 * 双写, 看起来也对, 但把两段的语义搅在一起, 日后改一段必踩另一段。⇒ **先查已存在集合再分流**。
 *
 * ## 🚨 起手 MUST 调 `oiRefreshedAtEod`, 而不是靠 cron 时刻推定 (plan §D3)
 *
 * 本轮的 cron 排在 21:40, 静态看恒在 21:30 的定稿时刻之后 ⇒ **漏掉这道闸在稳态下永远不会红**。
 * 而 `option-snapshot-remediation.ts` 的 #187 注释记着他们正是从「正确性靠 cron 时刻成立,
 * 不是靠判据」那个形态重构走的: 有人挪一次时刻 (或 misfire 补触发落在定稿之前), 抓到的就是
 * D−1 的 OI 而标签写 D —— **数字与标签双错, 且不报错**。
 *
 * 🚫 判据为假时正确动作是**不写**, 不是「写个近似值」(Testing Invariant 2)。
 *
 * ## 🚨 MUST NOT 为本轮新开 `source` 取值
 *
 * `market-session.rules.ts` 明文「OI 归属与 `source` 正交」。新开一个 `oi_settle` 会让唯一键
 * `(contract_id, session_date, source)` 不再碰撞, 于是段 b 平行写出整条链的第二份 —— 正是
 * #306 修掉的 555× 放大形态。⇒ 两段一律落 {@link SNAPSHOT_SOURCE_EOD}。
 *
 * ## 🚫 MUST NOT 重跑链发现
 *
 * 工作集取自 `option_contract` 表 (主轮当天已填)。重跑一遍是 453 秒的纯浪费, 且会在 21:40
 * 制造一个新的限频尖峰。
 */

/**
 * 单个 `$transaction` 批里的 UPDATE 条数配额。
 *
 * 段 a 是**逐合约**的定向 UPDATE (每行的 OI 值各不相同 ⇒ 一条 `updateMany` 盖不住多行),
 * 港股稳态单轮约 1.8 万行 ⇒ 裸 `await` 一条一条发就是 1.8 万次往返。按此配额切片、每片一个
 * 数组式 `$transaction`, 把往返压到 O(n / 500) 次, 同时封顶单事务时长 (避 Prisma 默认 5s
 * 超时) —— 与 `dimension-executor.ts` 回填侧「每 BACKFILL_ROW_CHUNK 行一 $transaction」同款。
 */
const OI_UPDATE_CHUNK = 500;

/** 工作集投影: id 建定位键, code 做批次键。轮2 不读行权价 / 到期日以外的任何列。 */
interface SettleContract {
  id: bigint;
  code: string;
}

/** 单票分流的结论 —— 两段各自的对象集是否非空。 */
interface SettleOutcome {
  /** 段 a 真的发过 UPDATE。 */
  updated: boolean;
  /** 本票有主轮**整行缺失**的合约 ⇒ 交给段 b。 */
  needsBackfill: boolean;
}

/** `YYYY-MM-DD` → `@db.Date` 列的 UTC 零点 Date。 */
const toDateOnly = (s: string): Date => new Date(`${s}T00:00:00Z`);

/** 切片成 size 大小的块 (同 `sync-option-snapshot.usecase.ts` 的同名私有 helper)。 */
function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

@Injectable()
export class SyncOptionOiSettleUseCase {
  private readonly logger = new Logger(SyncOptionOiSettleUseCase.name);

  /** 归属判据的**唯一**取数入口 (#187) —— 与主轮 / 补救链读同一份日历事实。 */
  private readonly attribution: SnapshotSessionAttributionLookup;

  constructor(
    @Inject(OPTION_SNAPSHOT_PORT) private readonly snapshot: OptionSnapshotPort,
    private readonly prisma: PrismaService,
    @Inject(TRADING_CALENDAR_PORT) calendar: TradingCalendarPort,
    /**
     * 段 b 的**唯一**执行体 (plan §D3)。
     *
     * 🚨 **MUST NOT 在本类里另抄一份 vendor 行 → DB 行的映射** —— 与
     * `ensure-latest-eod-bar.usecase.ts` 头部那条「两份必漂」同一条纪律。补漏要写的是一整行
     * (三个时点列 + 报价 + greeks + 硬门 + 异常监控), 抄过来就是第二份实现, 且**漂了不报错**。
     * ⇒ 直接调它的 `collect`, 连硬门与幂等键一起继承。
     */
    private readonly snapshotCollector: SyncOptionSnapshotUseCase,
    /**
     * 轮2 收尾的覆盖率判定 (T008)。
     *
     * **尾部可选**而非必填: `DimensionExecutorRegistry` 的默认实参形态要求本类能在没有
     * Nest 容器的情况下被直实例化 (同 `anchorGate` 的先例) —— 不传 ⇒ 收尾只报「轮2 自身
     * 失败」那一条, 不判覆盖率。生产经 `MarketdataModule` DI 注真实例。
     */
    private readonly coverage?: OptionSnapshotCoverageCheck,
  ) {
    this.attribution = new SnapshotSessionAttributionLookup(prisma, calendar);
  }

  /**
   * 逐票回填 OI。返 `true` = vendor 预算耗尽 (顺延信号, `ExecutorResult.budgetExhausted`)。
   *
   * **per-instrument 隔离** (016 四支柱): 单票失败计 `failed` + `findings` 后继续下一只,
   * 不整轮塌; **HTTP 在事务外**。
   *
   * 复杂度: O(工作集) 次合约表查询 + O(工作集) 次已存在行查询 + Σ O(合约数 / 399) 次快照
   * 调用 + O(合约数 / 500) 次批量 UPDATE。
   */
  async run(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<boolean> {
    // #138: 声明写路径 —— 让空工作集 / 判据短路的一轮报 0 而非 null。
    addWritten(stats, 0);
    const market = this.singleMarket(dim);
    // 🚨 归属走判据层, 与主轮同源 (#181/#187): 本轮虽然只改三列, 但那三列里的 `oi_as_of`
    // 与定位行用的 `session_date` 都是**业务日**, 拿日历日会在队列延迟跨午夜时整批错一天。
    const attribution = await this.attribution.resolve(market, input.now);
    if (attribution.decision === 'skip') {
      stats.skipped += instruments.length;
      this.logger.warn(`[option-oi-settle] 该场进行中, 本轮不采 (端点此刻返盘中态): ${market}`);
      return false;
    }
    if (attribution.decision === 'abandon') {
      stats.skipped += instruments.length;
      this.logger.error(
        `[option-oi-settle] 交易日历查不到 ${market} 上一个已收盘交易日 ⇒ 判不出归属, ` +
          `放弃本轮 (MUST NOT 猜日子)`,
      );
      return false;
    }
    const sessionDate = attribution.spec.sessionDate;

    // 🚨 plan §D3 的那道闸: 定稿判据为假 ⇒ 整轮跳过 OI 写入并留痕。
    // 🚫 MUST NOT 换成「反正 cron 排在 21:40」那种时刻推定 —— 见类注释。
    if (!oiRefreshedAtEod(market, sessionDate, input.now)) {
      stats.skipped += instruments.length;
      this.logger.error(
        `[option-oi-settle] ${market} ${sessionDate} 的 OI 尚未定稿 (本轮执行时刻早于定稿 ` +
          `时刻) ⇒ 整轮跳过 OI 写入。此刻端点返的仍是上一场的持仓量, 写进去就是「数字与` +
          `标签双错」且不可逆 (供应方不提供历史快照)`,
      );
      return false;
    }

    let budgetExhausted = false;
    /** 段 b 的对象集 —— 有主轮整行缺失合约的票 (先分流, 循环结束后一次性补)。 */
    const backfill: WorkingInstrument[] = [];
    for (const inst of instruments) {
      stats.scanned++;
      if (budgetExhausted) {
        stats.skipped++;
        continue;
      }
      const symbol = `${inst.market}:${inst.code}`;
      try {
        const outcome = await this.settleUnderlying(inst.id, symbol, sessionDate, stats);
        if (outcome.needsBackfill) {
          // 🚨 这一票的 ok / skipped **蓄意不在这里记** —— 段 b 的 `collect` 本就 per-instrument
          // 记, 两边都记会把同一只票数两遍。`scanned` 反过来只在这里记 (见下面的合并处)。
          backfill.push(inst);
          continue;
        }
        if (outcome.updated) stats.ok++;
        else stats.skipped++;
      } catch (err) {
        if (err instanceof OptionSnapshotBudgetExhaustedError) {
          budgetExhausted = true;
          stats.skipped++;
          this.logger.warn(`OI 回填限频顺延 (剩余标的下一窗续跑): ${symbol}`);
          continue;
        }
        stats.failed++;
        stats.findings.push({
          kind: 'failure',
          symbol,
          step: 'hk_option_oi_settle',
          error: String(err),
        });
      }
    }

    if (backfill.length > 0 && !budgetExhausted) {
      budgetExhausted = await this.backfillMissingRows(backfill, attribution, stats);
    }
    await this.reportOutcome(market, sessionDate, stats);
    return budgetExhausted;
  }

  /**
   * 轮2 收尾的**一级制**告警 (FR-014 / FR-021, plan §D5)。
   *
   * 港股两级补救的触发点已随 073 退役 ⇒ 这条线上不再有「① 级只 WARN 挂着等 ②」那条阶梯。
   * 轮2 是当日最后一次机会, 不达标就**直接 ERROR**。
   *
   * ## 🚨 两条 ERROR 各管一件事, MUST NOT 合并成一条
   *
   * | 条件 | 它说的是 | 覆盖率判据看得见吗 |
   * | --- | --- | --- |
   * | `stats.failed > 0` | 行**在**, 但 OI **没回填成** | ❌ 看不见 |
   * | 覆盖率 degraded | 行**缺**了 | ✅ 就是它 |
   *
   * 第一条不是冗余: `option-snapshot-coverage.check.ts` 数的是「这个合约今天有没有行」
   * (`collected.has(row.contractId)`), 对 OI 的**新鲜度**完全无输出 ⇒ 主轮成功而轮2 整轮挂掉
   * 时它恒判 `ok`, 只靠它这一条就是**静默**。而「OI 静默停在隔日口径」正是本片要消灭的东西。
   *
   * ## 🚨 本 ERROR 当前**无接收端** (#209 仍开着)
   *
   * 落进容器 stdout (30MB 环, 无投递, 部署即滚) + `sync_run.findings`。**没有人会被叫醒。**
   * 🚫 别因为「报了 ERROR」就以为这件事有人管 —— 本片让语义更诚实, 但触达是另一条线上的事。
   *
   * 复杂度: 一次覆盖率判定 (两趟以 `session_date` 为入口的索引查询), 与工作集大小无关。
   */
  private async reportOutcome(
    market: string,
    sessionDate: string,
    stats: SyncRunStats,
  ): Promise<void> {
    if (stats.failed > 0) {
      this.logger.error(
        `[option-oi-settle] ${market} ${sessionDate} 的 OI 回填未完成: ${stats.failed} 只标的失败 ` +
          `⇒ 这些票的 OI 仍停在隔日口径, 且当日不可回补 (供应方不提供历史快照)。` +
          `⚠️ 覆盖率判据看不见这件事 —— 它数的是「行在不在」, 不是「OI 新不新」`,
      );
    }
    if (this.coverage === undefined) return;
    const report = await this.coverage.evaluate(market, sessionDate);
    // 一级制: 判完立刻响。🚫 这里**不是** `option-snapshot-coverage.check.ts` 注释里禁的那种
    // 「判完就响」的便利入口 —— 那条禁的是绕过 FR-046 的两级补救, 而港股这条线上的两级
    // 已经没有了, 轮2 之后不存在「等下一级」。显式写两行, 让「我此刻就响」在 diff 里看得见。
    this.coverage.alertIfDegraded(report, '轮2 OI 回填之后 (一级制, 没有下一级了)');
  }

  /**
   * 段 b: 主轮整行缺失的合约 → 复用主轮采集本体补整行 (FR-009 / FR-010, plan §D3)。
   *
   * ## 🚨 `source` 硬编码 `eod`, MUST NOT 交给判据层推导
   *
   * 判据层在「已跨进下一个交易日」那一档会给 `premarket_backfill` (misfire 把本轮推过午夜时
   * 就会撞上)。而段 b 落哪个 `source` 不是结论、是**身份**: 唯一键
   * `(contract_id, session_date, source)` 必须与段 a 面对的那批行**碰撞**, 才能让
   * `createMany(skipDuplicates)` 天然挡住重写。换成另一个取值 ⇒ 不碰撞 ⇒ 整条链被平行写出
   * 第二份, 正是 #306 修掉的 555× 放大形态。
   *
   * ⚠️ 与 `option-snapshot-remediation.ts` ① 级的「`spec` 原样喂下去」**方向相反**, 别照抄那条:
   * 那一级的 `mode` 是结论 (它可能真的被推迟到次日盘前), 本段的 `mode` 是身份。同一份判据的
   * 两种正确用法, 判据是「这个取值承载的是路径还是归属」。
   *
   * ## 🚨 `collect` 会把整条链重打一遍, 这是**已知代价**
   *
   * `collect` 的粒度是「标的」而非「合约」—— 它按票取全部未到期合约再分批外呼。段 a 已经打过
   * 的那些合约会被再打一次 (落库侧由 `skipDuplicates` 挡住, 不会重写)。用**合约级**的补漏换
   * 掉这次重打, 代价是在本类里复制一份行映射 + 硬门 + 异常监控 —— 那是本文件顶上明令禁止的
   * 那件事。⇒ 取重打。港股稳态单票 ~6 次外呼、全轮 ~38s, 且落在 21:40 的空窗。
   *
   * 复杂度: 同 `SyncOptionSnapshotUseCase.collect`。
   */
  private async backfillMissingRows(
    instruments: WorkingInstrument[],
    attribution: Extract<SnapshotAttribution, { decision: 'collect' }>,
    stats: SyncRunStats,
  ): Promise<boolean> {
    this.logger.warn(
      `[option-oi-settle] 段 b 补漏: ${instruments.length} 只票有主轮整行缺失的合约 ` +
        `(${instruments.map((i) => `${i.market}:${i.code}`).join(', ')})`,
    );
    // 🚨 子 stats: `collect` 的 `scanned` 与本轮循环的 `scanned` 数的是同一批票, 合并会翻倍。
    // 其余四项 (ok / skipped / failed / written / findings) 才是它独有的结论。
    const sub = emptyStats();
    const budgetExhausted = await this.snapshotCollector.collect(
      instruments,
      { ...attribution.spec, mode: SNAPSHOT_SOURCE_EOD },
      sub,
    );
    stats.ok += sub.ok;
    stats.skipped += sub.skipped;
    stats.failed += sub.failed;
    stats.findings.push(...sub.findings);
    addWritten(stats, sub.written ?? 0);
    return budgetExhausted;
  }

  /**
   * 单票: 取工作集 → 查当日已有的 `eod` 行 → **分流** → 段 a 定向 UPDATE。
   *
   * 🚨 **两段的对象集在这里被切成不相交的两半** (Guardrail 2): `settled` = 已有行的合约,
   * `missing` = 整行缺失的合约, 二者按同一次存在性查询分出来。🚫 MUST NOT 退化成
   * 「先全量 createMany 再全量 UPDATE」—— 那对已有行是 no-op、对新行是双写, 看起来也对,
   * 但两段的语义就此搅在一起。
   */
  private async settleUnderlying(
    instrumentId: bigint,
    symbol: string,
    sessionDate: string,
    stats: SyncRunStats,
  ): Promise<SettleOutcome> {
    const contracts: SettleContract[] = await this.prisma.optionContract.findMany({
      // 口径与主轮逐字一致 (FR-028a: 当日到期的合约当日仍可取快照)。
      where: {
        underlyingInstrumentId: instrumentId,
        expiryDate: { gte: toDateOnly(sessionDate) },
      },
      select: { id: true, code: true },
      orderBy: { id: 'asc' },
    });
    if (contracts.length === 0) {
      // 与主轮同口径: 无合约 ≠ 失败 (港股绝大多数标的没有挂牌期权)。
      this.logger.log(`跳过 OI 回填 (库中零未到期期权合约): ${symbol}`);
      return { updated: false, needsBackfill: false };
    }

    const persisted = await this.loadPersistedContractIds(contracts, sessionDate);
    const settled = contracts.filter((c) => persisted.has(c.id));
    const missing = contracts.length - settled.length;
    if (settled.length > 0) {
      await this.refreshOpenInterest(symbol, settled, sessionDate, stats);
    }
    if (missing > 0) {
      this.logger.warn(
        `主轮当日在本票上缺 ${missing}/${contracts.length} 个合约的整行 ⇒ 转段 b 补漏: ${symbol}`,
      );
    }
    return { updated: settled.length > 0, needsBackfill: missing > 0 };
  }

  /**
   * 分流的**唯一**判据: 当日已落 `source='eod'` 行的那些合约。
   *
   * 🚨 谓词里的 `source` 不是装饰 —— 美股那侧仍在产 `premarket_backfill` 行, 不限定会把它们
   * 一起捞进段 a 的对象集 (Guardrail 6 的读侧半边)。
   *
   * 复杂度: 1 次唯一索引 `(contract_id, session_date, source)` 上的 `IN` 查询。
   */
  private async loadPersistedContractIds(
    contracts: SettleContract[],
    sessionDate: string,
  ): Promise<ReadonlySet<bigint>> {
    const rows = await this.prisma.optionDailySnapshot.findMany({
      where: {
        contractId: { in: contracts.map((c) => c.id) },
        sessionDate: toDateOnly(sessionDate),
        source: SNAPSHOT_SOURCE_EOD,
      },
      select: { contractId: true },
    });
    return new Set(rows.map((r) => r.contractId));
  }

  /**
   * 段 a: 打一遍快照端口取定稿后的 OI, 对已存在的行**只**写三列。
   *
   * 🚨 `oi_as_of` 恒 `= sessionDate` —— 本方法只在定稿判据为真时被调到 (run 的入口闸),
   * 此刻端点返的就是 `sessionDate` 这一场自己的真值, 不必也不该退到上一交易日。
   *
   * 🚫 **MUST NOT 顺手把报价列一起刷新**: 21:40 的盘口正是本片要躲开的那份 (收租召回集
   * 45.2% 的腿在那个时刻拿不到买价), 刷进去等于把主轮 16:20 抢到的那份盖掉 —— 而抢那份是
   * 本片存在的全部理由。SC-004 钉的就是这条。
   */
  private async refreshOpenInterest(
    symbol: string,
    contracts: SettleContract[],
    sessionDate: string,
    stats: SyncRunStats,
  ): Promise<void> {
    const oiAsOf = toDateOnly(sessionDate);
    for (const batch of chunked(contracts, OPTION_SNAPSHOT_MAX_CONTRACT_CODES)) {
      const byCode = new Map(batch.map((c) => [c.code, c]));
      const { rows } = await this.snapshot.getSnapshots({
        underlyingSymbol: symbol,
        contractCodes: batch.map((c) => c.code),
      }); // HTTP (事务外)

      const updates = rows
        .filter((row) => row.isOption)
        .map((row) => {
          const contract = byCode.get(row.code);
          if (contract === undefined) {
            // 与主轮同一条闸: 落到别的合约名下比没落更难发现。
            throw new Error(
              `[option-oi-settle] 快照行不在本批请求内 (契约变更 / 批次错配?): 请求 ${symbol} ` +
                `${batch.length} 个合约, 却收到 ${row.code}`,
            );
          }
          return {
            where: {
              contractId: contract.id,
              sessionDate: oiAsOf,
              source: SNAPSHOT_SOURCE_EOD,
            },
            // 🚨 三列, 一个不多。数值全程 string 直传 Decimal 列 (FR-S08); 缺失恒 null。
            data: {
              openInterest: row.openInterest,
              netOpenInterest: row.netOpenInterest,
              oiAsOf,
            },
          };
        });

      for (const chunk of chunked(updates, OI_UPDATE_CHUNK)) {
        const results = await this.prisma.$transaction(
          chunk.map((u) => this.prisma.optionDailySnapshot.updateMany(u)),
        );
        addWritten(
          stats,
          results.reduce((n, r) => n + r.count, 0),
        );
      }
    }
  }

  /**
   * 单市场 scope 守卫 —— 与主轮逐字同源: 定稿判据问的是「**这个市场**的 OI 定稿没有」,
   * 混 scope 没有单一答案。fail-closed 抛而不是挑第一个。
   */
  private singleMarket(dim: ExecutorSyncDimensionRow): string {
    if (dim.marketScope.length !== 1) {
      throw new Error(
        `[option-oi-settle] 定稿判据要求单市场 scope, 收到 ${JSON.stringify(dim.marketScope)} ` +
          `(混 scope 请拆成各自的维度)`,
      );
    }
    return dim.marketScope[0];
  }
}
