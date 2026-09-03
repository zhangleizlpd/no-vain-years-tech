import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../security/prisma.service.js';
import { parseGateTicker } from './anchor-driven-sync-gate.js';
import type {
  ExecutorInput,
  ExecutorSyncDimensionRow,
  WorkingInstrument,
} from './dimension-executor.js';
import { gapCheckExpiryDates, planOptionChainWindows } from './option-chain-window.rules.js';
import {
  OPTION_CHAIN_PORT,
  OptionChainBudgetExhaustedError,
  type OptionChainPort,
  type OptionContractStatic,
} from './option-chain.port.js';
import { addWritten, type SyncRunStats } from './sync-run.recorder.js';
import { seedInstrumentCreateData } from './sync-universe.usecase.js';
import { exchangeCalendarDateForScope } from './session-clock.js';

/**
 * 链合约发现维度 use case (047 T015, FR-028/028b/029/032/033/035/036/037/038)。
 *
 * 每票两步: `get_option_expiration_date` 取全部到期日 → 贪心分窗 (≤30 天/窗) → 逐窗
 * `get_option_chain` 取合约静态属性 → 落 `marketdata.option_contract`。跑完对表
 * (`gapCheckExpiryDates`)。
 *
 * ## 工作集 = 锚白名单 (FR-035), 由 `factExecutor` 前置给定
 *
 * 本 use case **不自己查 `Instrument`** —— 走 `DimensionExecutorRegistry.factExecutor` 那条既有
 * 路径 (tier 重算 → `AnchorDrivenSyncGate.recalcSafely()` → `loadActiveInstruments`), 与 046 的
 * `underlying_iv_daily` 同形态。066 T02 起本维度是**锚作用域**的:
 * `market ∈ scope ∧ active ∧ **有锚**`, `needSync` 已退出谓词 (登记表见
 * `anchor-scoped-dimensions.rules.ts`)。⇒ **零锚时工作集为空、对 vendor 的请求数为 0**,
 * 且加第 13 只锚零代码改动自动纳入 (FR-038)。
 *
 * ## 🚨 采集端零过滤 (Guardrail 3 / 4, plan D-DATA-3)
 *
 * 不设行权价带、不设到期日上限 (含 LEAPS, FR-032)、不滤边 (端口层根本没有 `optionType` 入参,
 * 真正的 `option_type=ALL` 由 adapter 写死)、非标合约照常落库只打 `is_standard` 标 (FR-033)。
 * 判据都是同一条不对称性: **快照漏采即永久缺口** (vendor 不提供历史交易日的链快照, 出处见
 * `option-chain.port.ts`), 而链接口
 * 一次返双边、调用数完全不变。排除只发生在下游选约层。
 *
 * ## 🚨 业务日期按 us 市场时区 (FR-036 / plan D-DATA-10)
 *
 * 取 `exchangeCalendarDateForScope(dim.marketScope, input.now)` 而**不是** `input.asOf`。
 * 🚨 理由在 063 Phase 1 之后**换了一条**, 别再引用旧的那条 (「CLI 兜底是上海日」——
 * 两条 CLI 的缺省已改为逐维度求值, 那个形态不复存在):
 *   ① `input.asOf` 是**入队时刻**算的, 而本维度要问的是**执行时刻**「现在是哪一天」——
 *      队列积压 / 重试跨过午夜时两条钟会分叉 (ADR-0066 的 event time vs processing time);
 *   ② 运维显式 `--as-of <过去某天>` 会让「剔除已过期到期日」按过去那天判, 把早已到期的合约
 *      当成有效的重新采回来。
 * 本维度用它来剔除**已过期**的到期日, 判据是 `≥ 当前交易日` **不是 `>`**
 * (FR-028a: 当日到期的合约当日仍要采; 选约表那侧才是 `>`, 两处故意不同)。
 *
 * ## 幂等 (FR-037) = `createMany(skipDuplicates)` on `(market, code)`
 *
 * 合约静态属性一经挂牌即不变 ⇒ 本表是 **insert-only** 的: 第一天灌满该票的全链, 此后每晚
 * 只有新挂的到期日会真正落行, 其余全被唯一键挡掉。换成逐行 `upsert` 会让每晚多付约 2.5 万条
 * UPDATE (12 票 × 约 2150 合约) 去重写一堆不会变的值。
 *
 * 🚨 **别把这条读成「本路径已经优化过了」**: 它省的是 **DB 层**, 而 DB 层从来不是瓶颈。
 * 占本维度 99.9% 成本的是 **vendor 外呼**, 那一侧**一个 skip 都没有** —— 重跑同一只票仍会
 * 把它的整条链完整重下一遍, 只是落库时全被 `skipDuplicates` 挡掉。⇒ `sync_run.written=0`
 * 是「DB 没写」, **不是**「没干活」。2026-08-23 prod 实证: 连续 11 轮 written=0, 每轮仍耗
 * 2555 秒 / 872 次外呼 (issue #159)。看这个指标判成本会得出完全相反的结论。
 *
 * ⚠️ 代价记在这里: vendor 若**订正**某个静态字段 (如 `is_standard`), 本路径不会自动改写既有
 * 行 —— 那属定向回填, 不该由夜间管线兜。
 *
 * ## 🚨 跑完 MUST 对表, 差集非空 MUST 上抛 (plan D-DATA-2)
 *
 * 分窗漏掉一个到期日 ⇒ 那一整批腿永久采不到, 而**每次调用都成功、日志全绿**。除了
 * `gapCheckExpiryDates` 这条对表, 没有任何下游会发现它。⇒ 静默 log 不算处理。
 */

/**
 * 单次 `createMany` 的行数配额 (incident 2026-07-12 P1 同款): 单票全链约 2150 行不塞一条语句,
 * 按此切片封顶单语句体积与内存。500 = Prisma 社区 + PG bulk-load 共识区间, 同
 * `dimension-executor.ts` 的 `BACKFILL_ROW_CHUNK`。
 */
const CONTRACT_ROW_CHUNK = 500;

/** `YYYY-MM-DD` → `@db.Date` 列的 UTC 零点 Date。 */
const toDateOnly = (s: string): Date => new Date(`${s}T00:00:00Z`);

/**
 * {@link SyncOptionContractUseCase.collect} 的显式入参 —— 本体需要的**全部**外部输入。
 *
 * 只有一个字段是刻意的: 链合约是**与交易日无关的静态属性**, 唯一用到业务日的地方是
 * 「剔除已过期到期日」那一步 (FR-028a, 判据 `≥` 不是 `>`)。字段少不等于该省掉这层 ——
 * 显式 spec 正是「本体不自己算日期」的结构保证 (同 `SyncOptionSnapshotUseCase` 的 spec)。
 */
export interface OptionChainCollectSpec {
  /** `YYYY-MM-DD`, 交易所本地日。维度轮从 `marketScope` 求, 冷启动从该锚的市场求。 */
  businessDate: string;
}

/** {@link OptionContractStatic} → `option_contract` createMany 行。 */
function contractRow(
  underlyingInstrumentId: bigint,
  c: OptionContractStatic,
): Prisma.OptionContractCreateManyInput {
  return {
    market: c.market,
    code: c.code,
    root: c.root,
    underlyingInstrumentId,
    expiryDate: toDateOnly(c.expiryDate),
    // 金融数值全程 string 直传 Decimal 列 (FR-S08): 中途过一趟 JS number 就把精度丢在半路。
    strikePrice: c.strikePrice,
    optionType: c.optionType,
    // 到期周期 / 结算方式 vendor 原样存, 缺失 null (禁默认值冒充)。
    expirationCycle: c.expirationCycle,
    settlementMode: c.settlementMode,
    isStandard: c.isStandard,
  };
}

/** 切片成 size 大小的块。 */
function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

@Injectable()
export class SyncOptionContractUseCase {
  private readonly logger = new Logger(SyncOptionContractUseCase.name);

  constructor(
    @Inject(OPTION_CHAIN_PORT) private readonly chain: OptionChainPort,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 逐票链发现。返 `true` = vendor 预算耗尽 (顺延信号, `ExecutorResult.budgetExhausted`)。
   *
   * **per-instrument 隔离** (016 四支柱): 单票失败计 `failed` + `findings` 后继续下一只,
   * 不整轮塌; **HTTP 在事务外**。
   *
   * 复杂度: O(工作集) 次到期日调用 + Σ O(窗数) 次链调用 (远端到期日稀疏 ⇒ 实测约 10–14 窗/票,
   * **不随时间线性增长**) + O(合约数 / 500) 次 createMany。
   */
  async run(
    instruments: WorkingInstrument[],
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<boolean> {
    // #138: 声明写路径 —— 让空工作集 / vendor 零行的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    // FR-028b 兜底 seed 先跑: 它修的是「有锚必有 Instrument 行」这个 FK 前提, 与本轮工作集
    // 无关 (本轮工作集已由 factExecutor 定死) —— 新 seed 的标的由**下一轮**锚闸开闸后纳入,
    // 正是 SC-003 定的「建锚 → 下一轮 cron → 进工作集」时序。
    //
    // 🚫 **MUST NOT 下沉进 `collect`**: 那条路径上冷启动每建一只锚都会全量扫一遍锚表,
    //    而它相一已经 seed 过自己那一只了。这是「维度级职责」与「本体职责」的分界线。
    await this.seedAnchoredInstruments(dim.marketScope);

    return this.collect(
      instruments,
      // 🚨 取交易所的今天而非 `input.asOf`, 两条理由见类注释 § 业务日期按 us 市场时区。
      { businessDate: exchangeCalendarDateForScope(dim.marketScope, input.now) },
      stats,
    );
  }

  /**
   * 采集本体 —— 夜间维度轮与**锚首建冷启动**共用。返 `true` = vendor 限频预算耗尽。
   *
   * ## 🚨 工作集由调用方给定, 本体从不自己查
   *
   * 维度轮的工作集来自 `DimensionExecutorRegistry.factExecutor` 的 `loadActiveInstruments`
   * (`market ∈ scope ∧ active ∧ needSync`); 冷启动直接传它那一只新锚。
   * ⚠️ 别把「收一个标的数组参数」误读成 `marketdata-sync.queue.ts` 那条注释警告的
   * **「给工作集选择开第二个口子」** —— 那条禁的是给 `DimensionJobPayload` 加筛选字段
   * (会让工作集有两套口径且会漂移)。本体收数组不新增任何口径, 选择权仍恒属 `factExecutor`。
   *
   * ## 🚨 冷启动 MUST 走这里, MUST NOT 入维度 job (issue #159)
   *
   * 维度 job 的工作集是**全部**已开闸标的 ⇒ 每建一只锚就把所有标的的链重下一遍, O(N²)。
   * 2026-08-23 prod 实证 (93 只锚批量导入): 每只耗 2555 秒 / 872 次外呼 / `written=0`
   * —— 本表 insert-only, 重跑全撞唯一键被 `skipDuplicates` 挡掉, 于是**DB 层看着零成本,
   * vendor 侧却每轮实打实全做了**。总计 59 小时, 而真正需要的是每只约 42 秒 (54× 放大)。
   *
   * 复杂度: **O(标的数 × 窗数) 次外呼, 与落库行数无关** —— 链接口是「单 code + 到期日窗
   * 跨度 ≤30 天」的硬约束。改这条路径时要盯的守恒量是这个乘积的**左**因子。
   */
  async collect(
    instruments: WorkingInstrument[],
    spec: OptionChainCollectSpec,
    stats: SyncRunStats,
  ): Promise<boolean> {
    const { businessDate } = spec;
    const gaps: string[] = [];
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
        const gap = await this.syncUnderlying(inst.id, symbol, businessDate, stats);
        if (gap !== null) gaps.push(gap);
        stats.ok++;
      } catch (err) {
        if (err instanceof OptionChainBudgetExhaustedError) {
          budgetExhausted = true;
          stats.skipped++;
          this.logger.warn(`链发现限频顺延 (剩余标的下一窗续跑): ${symbol}`);
          continue;
        }
        stats.failed++;
        stats.findings.push({
          kind: 'failure',
          symbol,
          step: 'option_contract',
          error: String(err),
        });
      }
    }

    if (gaps.length > 0) {
      // 🚨 MUST 上抛, 不许静默 log: 差集非空 = 某个到期日的整批腿没落库, 而分窗与链调用
      // **全都成功了** —— 除了这条对表, 没有任何东西会发现它。
      throw new Error(
        `[option-chain] 到期日对表有差集 (某批腿未落库, 分窗或 vendor 侧不自洽): ` +
          gaps.join(' | '),
      );
    }
    return budgetExhausted;
  }

  /** 单票: 到期日阶梯 → 分窗 → 逐窗落库 → 对表。返差集描述 (无差集 → null)。 */
  private async syncUnderlying(
    instrumentId: bigint,
    symbol: string,
    businessDate: string,
    stats: SyncRunStats,
  ): Promise<string | null> {
    const ladder = await this.chain.getExpiryDates(symbol); // HTTP (事务外)
    // FR-028a: 判据是 **≥** 当前交易日 —— 当日到期的合约当日仍可取快照 (官方文档「结束日期请
    // 输入今天或未来的日期」)。写成 `>` 只在到期日当天整批静默丢腿。
    const expiryDates = ladder.map((e) => e.expiryDate).filter((d) => d >= businessDate);
    const windows = planOptionChainWindows(expiryDates);
    const discovered = new Set<string>();

    for (const window of windows) {
      // 单次调用 = 单个窗 (切分在 planOptionChainWindows, 不在 adapter 也不在这里重实现)。
      const contracts = await this.chain.getChainWindow({
        symbol,
        start: window.start,
        end: window.end,
      }); // HTTP (事务外)

      const rows: Prisma.OptionContractCreateManyInput[] = [];
      for (const c of contracts) {
        if (c.underlyingSymbol !== symbol) {
          // 落到别的标的名下比没落更难发现 (同 IV adapter 的「code 不在本批请求内」闸)。
          throw new Error(
            `[option-chain] 合约归属错配 (契约变更 / 批次错配?): 请求 ${symbol} ` +
              `却收到 ${c.underlyingSymbol} 的 ${c.code}`,
          );
        }
        discovered.add(c.expiryDate);
        rows.push(contractRow(instrumentId, c));
      }
      for (const chunk of chunked(rows, CONTRACT_ROW_CHUNK)) {
        addWritten(
          stats,
          (await this.prisma.optionContract.createMany({ data: chunk, skipDuplicates: true }))
            .count,
        );
      }
    }

    const gap = gapCheckExpiryDates([...discovered], expiryDates);
    if (!gap.ok) {
      // 🚨 差集 = 分窗或 vendor 侧不自洽 ⇒ **不对账下架状态**: 此时 discovered 不是 vendor 的
      // 权威阶梯 (少了 / 多了到期日), 拿它当「vendor 现存清单」去摘会误摘真合约。
      return (
        `${symbol} 权威列表有而未发现=[${gap.missingFromDiscovered.join(',')}] ` +
        `发现了但不在列表=[${gap.unexpectedInDiscovered.join(',')}]`
      );
    }
    await this.reconcileListingState(instrumentId, symbol, businessDate, discovered, stats);
    return null;
  }

  /**
   * 挂牌状态对账 (软下架, 见 `schema.prisma` 的 `OptionContract.withdrawnAt` 注释)。
   *
   * **只在 gap.ok 的干净轮调用** —— 此刻 `discovered` == vendor 权威阶梯 (gapCheck 已核), 故:
   * · DB 里 expiry ≥ 当日、expiry 不在 `discovered` 里的合约 → vendor 已删该到期列 → 置 withdrawnAt;
   * · expiry 在 `discovered` 里、当前 withdrawn 的合约 → vendor 认回来了 → 清 withdrawnAt (自愈复采)。
   *
   * 收敛的是「一颗 vendor 已不认的码毒掉整批 snapshot」这个形态 (2026-09-02 hk:09988, #334): 摘掉
   * 之后死码不进快照 / OI 两轮的工作集, 也不进覆盖率分母。软戳不删行 —— 历史快照 onDelete:Cascade,
   * 物理删会连历史一起没且 vendor 不补 (schema 列注释)。
   *
   * 复杂度: 两条 `updateMany` (窄谓词, 走 `ix_option_contract_underlying_expiry`)。稳态零变动 ⇒
   * 两条各 0 行, 无 finding。
   */
  private async reconcileListingState(
    instrumentId: bigint,
    symbol: string,
    businessDate: string,
    discovered: ReadonlySet<string>,
    stats: SyncRunStats,
  ): Promise<void> {
    const liveExpiries = [...discovered].map(toDateOnly);
    const withdrawn = await this.prisma.optionContract.updateMany({
      where: {
        underlyingInstrumentId: instrumentId,
        expiryDate: { gte: toDateOnly(businessDate), notIn: liveExpiries },
        withdrawnAt: null,
      },
      data: { withdrawnAt: new Date() },
    });
    const restored = await this.prisma.optionContract.updateMany({
      where: {
        underlyingInstrumentId: instrumentId,
        expiryDate: { in: liveExpiries },
        withdrawnAt: { not: null },
      },
      data: { withdrawnAt: null },
    });
    if (withdrawn.count > 0 || restored.count > 0) {
      // notice (非失败, 值得人看): 下架 / 复采是 vendor 挂牌面变化的可观测信号, 不改本轮判定。
      stats.findings.push({
        kind: 'notice',
        step: 'option_contract_listing',
        detail: { symbol, withdrawn: withdrawn.count, restored: restored.count },
      });
    }
  }

  /**
   * FR-028b 兜底 seed: 已建锚但 `Instrument` 表无对应行 → 幂等 upsert, 保「**有锚必有
   * `Instrument` 行**」这个不变量恒成立 (否则合约表的外键因上游 universe 枚举缺失而断链)。
   *
   * 📌 **兜底不是主路径**: `universe` 维度仍是标的入库的正规通道, seed 只覆盖「新锚建了、
   * universe 还没轮到」这个时间差与上游漏收。
   *
   * 🚨 **create payload 走 {@link seedInstrumentCreateData} 这一个 helper** (066 T03,
   * FR-009), 与另一个 seed 点 (`anchor-cold-start.usecase.ts`) 及 `SyncUniverseUseCase.upsert`
   * 的 create 分支**共用同一份默认值**。此前这里无条件写 `needSync: false`, 理由是「重算的
   * 唯一权威是采集闸」—— **那条理由只对被闸管的市场 (us) 成立**: 港股没有闸, 被本路径首建的
   * 港股行会永远停在 `false` 并被 `eod_bar` 静默排除 ⇒ 那只标的永远没有日线。分工订正为
   * **create 路径定默认值, 闸只负责被闸市场的重算**。
   *
   * `update` 仍留空 —— 已有行的 `name` / `syncTier` / `needSync` 一个都不许被 seed 冲掉
   * (「每轮同步会不会冲掉人工配置」那条绊线的看护对象)。
   *
   * 复杂度: 1 次锚表读 + 1 次存在性批查 + O(缺失数) 次 upsert (稳态为 0)。
   */
  private async seedAnchoredInstruments(marketScope: string[]): Promise<void> {
    // CROSS-CONTEXT-READ: 只读 optionsdesk.anchor 全量 ticker (catalog Q7-B 只读逃生口,
    // ADR-0062 已记), 补 marketdata 自有的 Instrument 行。零写对方表、零 @Inject() 对方 use case。
    const rows = await this.prisma.anchor.findMany({ select: { ticker: true } });

    const wanted = new Map<string, { market: string; code: string }>();
    for (const { ticker } of rows) {
      const parsed = parseGateTicker(ticker);
      if (parsed === null || !marketScope.includes(parsed.market)) continue;
      wanted.set(`${parsed.market}:${parsed.code}`, parsed);
    }
    if (wanted.size === 0) return;

    const existing = await this.prisma.instrument.findMany({
      where: { OR: [...wanted.values()].map(({ market, code }) => ({ market, code })) },
      select: { market: true, code: true },
    });
    for (const row of existing) wanted.delete(`${row.market}:${row.code}`);

    for (const { market, code } of wanted.values()) {
      await this.prisma.instrument.upsert({
        where: { market_code: { market, code } },
        create: seedInstrumentCreateData(market, code),
        // 空 update = 纯兜底: 已有行的 name / syncTier / needSync 一个都不许被 seed 冲掉。
        update: {},
      });
      this.logger.warn(
        `兜底 seed 标的行 (有锚但 Instrument 缺行, universe 未轮到?): ${market}:${code}`,
      );
    }
  }
}
