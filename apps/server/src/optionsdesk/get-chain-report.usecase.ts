import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { parseAnchorTicker } from './anchor.rules';
import { dateOnlyOf, readMonthlyExpiries } from './monthly-expiry-lookup';
import {
  CHAIN_REPORT_METRICS,
  aggregateCell,
  atmImpliedVolatility,
  chainReportColumns,
  chainReportGateCounts,
  chainReportRows,
  chainReportSkeleton,
  classifyOtmBand,
  type ChainReportCell,
  type ChainReportGateCounts,
  type ChainReportLegVerdict,
  type ChainReportMetric,
  type ChainReportRow,
} from './chain-report.rules';
import {
  GetUnderlyingDetailUseCase,
  type UnderlyingIvReadout,
} from './get-underlying-detail.usecase';
import { activityVolume, computeEffectiveCostVsWPct, computeLegRates } from './leg-derive.rules';
import {
  BUILD_RECALL_DTE,
  RENT_RECALL_DTE,
  recallCandidates,
  type DteBand,
  type RecallContext,
} from './leg-recall.rules';
import { LEG_TABS, type LegTab } from './leg-tab.rules';
import { LEG_RETRIEVAL_PORT, type LegChainRow, type LegRetrievalPort } from './leg-retrieval.port';

/**
 * 055 标的链分析报表读端 (FR-005/010/011/012/013/014/031/033/034, plan D-API-1 / D-API-2 /
 * D-RECALL-1 / D-CTX-1)。范式 = ADR-0043 扁平 + 贫血: 文件平铺、数据是裸 Prisma row、
 * 无 repository、无 Domain Class; 全部业务不变量在 `chain-report.rules.ts` 纯函数里。
 *
 * 🚨 **独立端点而非 legs 端点的一个 mode** (plan D-API-1): 053 把选约表定成「每视角独立请求 +
 * 精排 + 表达层截断」, 而本片要的是「过权利金门槛之后的**整条链**、不排序不截断不分视角」。
 * 同一个端点同时满足两者只能加一个开关, 那等于在一个端点里塞两个契约。
 *
 * 🚨 **一次请求返四种格值** (plan D-API-2, 与 053「每视角独立请求」方向相反, **刻意的**):
 * FR-010 要求切换格值时**行列位置逐格不变**。拆四次请求 ⇒ 切换时先空后填, 且四发的 `spot` /
 * `asOf` 可能落在不同批报价上 ⇒ **骨架会跳**, 而那正是本片唯一不能出错的东西。
 * 053 拆请求的三条理由 (各自精排 / 各自截断 / 各自的条件三态) 在报表上一条都不成立。
 *
 * 🚨 **本端点零成员判据** (052 FR-003 / ADR-0064 不变量): 成员判定全部经召回层入口。本文件里
 * 出现任何一条 `filter` 形态的门槛都是第二个判据点, 而它**不会红** —— 网格照常渲染、数字照常有。
 *
 * **读端零写**, 且**不推进任何状态**。
 */

/** 屏级状态。三值与选约表同源 (`chain_not_ready` 是事实、`read_failed` 是故障, 蓄意分开)。 */
export const CHAIN_REPORT_STATES = ['available', 'chain_not_ready', 'read_failed'] as const;

export type ChainReportState = (typeof CHAIN_REPORT_STATES)[number];

/**
 * 格值 → 其成员集所在的召回视角。
 *
 * 🚨 **活跃度落全腿是判据不是省事** (FR-039 ①): 活跃量本就不分视角, 落全腿 ⇒ 下钻看到的就是
 * 用户刚点的那条腿; 另两种落法都可能让用户「点了 A 看到 B」。
 * 🚨 **这张表 MUST 只有一处** —— 客户端据它决定「本列是否该淡出」, 服务端据它取成员集。两处
 * 各写一份就会出现「格有值但整列淡出」这种自相矛盾, 而**两边都渲染得出来**。故服务端把结论
 * (`inRecallBand`) 随列下发, 客户端不做这个映射。
 */
export const CHAIN_REPORT_METRIC_TAB: Readonly<Record<ChainReportMetric, LegTab>> = {
  build_quality: 'build',
  rent_annualized: 'rent',
  all_annualized: 'all',
  activity: 'all',
};

/** 一列 = 链上一个实际到期日 (spec Key Entities「列」)。 */
export interface ChainReportColumn {
  readonly expiryDate: Date;
  readonly dteDays: number;
  /**
   * 是否月度到期链 (spec Key Entities「列」)。判据与选约表**同一处**
   * (`monthly-expiry-lookup.ts` + `leg-mark.rules.ts` 两个纯函数)。
   *
   * 📌 **「是否跨财报」蓄意不在本片呈现面内**（2026-08-14 定，见 tasks 故意零覆盖登记）:
   * mockup 未画、零 FR 要求, 且列头多一个 chip 要吃掉 FR-041 已经很紧的一屏高度预算。
   */
  readonly isMonthlyChain: boolean;
  /**
   * 该到期日的平值隐含波动率, vendor 原样百分数; 插值不可得 ⇒ `null` ⇒ 曲线该点**断开**
   * (FR-023, 🚫 MUST NOT 以任何形式填充)。
   */
  readonly atmIv: number | null;
  /**
   * **每种格值**下本列是否落在其对应视角的召回段内。
   *
   * 一个字段同时服务两处呈现, 蓄意不拆:
   * · FR-009 的两条召回段范围框 = `build_quality` / `rent_annualized` 那两项;
   * · FR-009a 的整列淡出 = 当前格值那一项为 `false`。
   * 📌 全腿口径的两项 (`all_annualized` / `activity`) 恒 `true` —— 全腿视角不设期限段。
   */
  readonly inRecallBand: Readonly<Record<ChainReportMetric, boolean>>;
}

/** 网格 —— `[行序][列序]`, 行序即 {@link ChainReportRow.index}。 */
export type ChainReportGrid = readonly (readonly ChainReportCell[])[];

export interface ChainReportView {
  symbol: string;
  state: ChainReportState;
  /** vendor 随链下发的标的价, **未复权**。页头显示, 也是行轴换算行权价区间的分母。 */
  spot: Prisma.Decimal | null;
  /** 本次检索所用的**交易所的今天** (FR-033 ①)。 */
  marketDate: string | null;
  /** 快照归属交易日 (FR-033 ②)。 */
  asOf: Date | null;
  quoteAsOf: Date | null;
  /** 🚨 OI 的归属交易日 (FR-033 ③) —— 与上面两个**不是同一天**, 活跃度格值的时点跟它 (FR-014)。 */
  oiAsOf: Date | null;
  source: string | null;
  lastClosedSession: string | null;
  /** 链级 IV 分位四态 —— **复用 046 那一份**, 🚫 零新增读点 (plan D-CTX-1)。 */
  iv: UnderlyingIvReadout;
  /** 锚被排除仍照常渲染, 仅带标记 (spec Assumptions, `state_branch` 21)。 */
  anchorExcluded: boolean;
  gateCounts: ChainReportGateCounts;
  rows: readonly ChainReportRow[];
  columns: readonly ChainReportColumn[];
  /** 四种格值**同一个骨架** (plan D-API-2): 四张网格的行列维度逐格相等, 变的只是读数与格态。 */
  cells: Readonly<Record<ChainReportMetric, ChainReportGrid>>;
}

@Injectable()
export class GetChainReportUseCase {
  private readonly logger = new Logger(GetChainReportUseCase.name);

  constructor(
    // 月度到期日的交易日历只读直查 (Q7-B) 走它 —— 本 ctx 无自有表要读。
    private readonly prisma: PrismaService,
    // 046 详情读端 —— 锚 + IV 四态 + 最近已收盘交易日**一次拿全**。
    // 🚨 同 ctx 内组合, 不是跨 ctx 注入 (护城河判据看的是 ctx 边界)。走它而不是自己再读一遍
    // marketdata 的 IV 快照, 是 plan D-CTX-1 的硬约束: 同一个读数有两个来源时**两边都读得出值**。
    private readonly detail: GetUnderlyingDetailUseCase,
    // 召回层的数据来源接缝 (ADR-0064 决策 4)。🚫 **不是**跨 ctx 注入对方 use case (Q7-C 仍成立)。
    @Inject(LEG_RETRIEVAL_PORT) private readonly retrieval: LegRetrievalPort,
  ) {}

  /**
   * @param symbol canonical `market:code`。
   * @param now 请求时刻 (注入以便测试钉住基准)。🚫 MUST NOT 在下游改成算好的 `today` 字符串。
   * @throws NotFoundException 该 symbol 尚未建锚 —— 由 046 详情读端抛, 本片不另写一份判定
   *   (FR-037a: 未建锚 ⇒ 入口不出现且报表不可达, 🚫 不做成「缺一角的报表」)。
   *
   * 复杂度: 1 次整链检索 (3 次跨 ctx 查询) + 046 的 3 次点查 + `O(n)` 三趟纯 CPU
   * (骨架召回 / 三视角召回 / 逐腿分格), `n` = 该链腿数 (实测上界 825)。
   */
  async execute(symbol: string, now: Date = new Date()): Promise<ChainReportView> {
    // 🚨 **在 try 之外**: 无锚要 404 上抛 (FR-037a), 不能被下面的降级兜住变成一张空报表。
    const detail = await this.detail.execute(symbol);
    const empty = (state: ChainReportState): ChainReportView => ({
      symbol,
      state,
      spot: null,
      marketDate: null,
      asOf: null,
      quoteAsOf: null,
      oiAsOf: null,
      source: null,
      lastClosedSession: detail.lastClosedSession,
      // 🚨 IV 块**按自己的四态独立降级, 不被网格失败波及** (spec Assumptions): 它与网格是两个
      // 端点两条链路, 网格挂了 IV 明明读得到。
      iv: detail.iv,
      anchorExcluded: detail.anchor.row.excluded,
      // 🚫 没有链就没有腿 —— 七个数取 0 而非 null: 它们是计数不是「未知」(同 053 的纪律)。
      gateCounts: chainReportGateCounts([]),
      // 🚫 **无 spot 就不给行轴** (`state_branch` 20): 行权价区间是 spot 的函数, 猜一个分母
      // 出来的区间会**看着完全正常**。行的价外幅度区间是常量, 但只给一半不如不给。
      rows: [],
      columns: [],
      cells: emptyGrids(),
    });

    try {
      // 🚨 **取整条链而不是候选集** (port `retrieveChain` 的存在理由): 候选集的成员判据是
      // 「至少进一个视角」⇒ 被权利金 / 活性挡下的腿结构上不在其中, 而本片两处都要它们
      // (骨架含被活性挡下的; 格态要分「无合约」与「有腿但太便宜」)。
      const snapshot = await this.retrieval.retrieveChain({ symbol, now });
      if (snapshot === null) return empty('chain_not_ready');
      const { chain, legs } = snapshot;
      const context: RecallContext = { spot: chain.spot };

      // 月度链标 —— 查询与选约表**同一处** (`monthly-expiry-lookup.ts`), 🚫 不各查一份:
      // 窗口计算两处不同步时**两边都标得出月度链**, 只是同一个到期日在两屏上标得不一样。
      const parsed = parseAnchorTicker(symbol);
      const monthlyExpiries =
        parsed === null
          ? new Set<string>()
          : await readMonthlyExpiries(
              this.prisma,
              parsed.market,
              legs.map((leg) => leg.expiryDate),
            );

      return {
        ...empty('available'),
        spot: chain.spot,
        marketDate: chain.marketDate,
        asOf: chain.sessionDate,
        quoteAsOf: chain.quoteAsOf,
        oiAsOf: chain.oiAsOf,
        source: chain.source,
        ...this.buildGrid(context, legs, detail.anchor.effective.v, monthlyExpiries),
      };
    } catch (err) {
      this.logger.warn(`标的链报表跨 ctx 读降级 (${symbol}, 页头照常返回): ${String(err)}`);
      return empty('read_failed');
    }
  }

  /**
   * 骨架 → 行列轴 → 四种格值一次求值 → 三互斥计数。全程纯 CPU, 零 I/O。
   *
   * 🚨 **两次召回调用口径不同, MUST NOT 合并** (plan D-RECALL-1):
   * ① 骨架 = 全腿视角 + 活性放开 ⇒「过权利金门槛之后的整条链」(FR-005);
   * ② 三视角归属 = 无覆盖的三视角召回 ⇒ 四种格值各自的成员集。
   * 实测两者在 `us:ACN` 上差 **38 条** (过权利金却被活性挡下的腿), 而**两种取法都渲染得出一张
   * 完整的网格** —— 拿②当骨架会让那 38 条在图上消失成「该位置无合约」。
   */
  private buildGrid(
    context: RecallContext,
    legs: readonly LegChainRow[],
    v: Prisma.Decimal,
    monthlyExpiries: ReadonlySet<string>,
  ): Pick<ChainReportView, 'rows' | 'columns' | 'cells' | 'gateCounts'> {
    const skeleton = chainReportSkeleton(context, legs);
    // 🚨 `candidateCap` 传 `legs.length` = **本次显式不设上限** (Guardrail 1): `RECALL_CANDIDATE_CAP`
    // 那道保险丝是给下游排序 / 表达限流的, 而格数由行列数决定、与腿数无关, 天然有界。沿用它等于
    // 给报表塞进一个 FR-005 明令不能有的截断, 且今天最大链 825 条**碰不到 ⇒ 真出问题时不会红**。
    const outcome = recallCandidates(context, LEG_TABS, legs, legs.length, null);
    const tabsByLeg = new Map<LegChainRow, readonly LegTab[]>();
    for (const candidate of outcome.candidates) tabsByLeg.set(candidate.leg, candidate.tabs);
    const inSkeleton = new Set(skeleton);

    // 行轴是 spot 的函数; 列轴取**整条链上实际存在的到期日** (FR-001 逐字), 🚫 **不是骨架**。
    //
    // 🚨 **这一条踩反了会让「全被门槛挡下」那一屏消失**: 若列轴取骨架, 一条腿全部低于权利金
    // 门槛的链骨架为空 ⇒ 零列 ⇒ 什么都渲染不出来; 而 `state_branch` 8 与 mockup 降级第二帧
    // 明确要求那时**整张网格照常渲染、每格呈「被门槛挡下」态**, 再配页脚三计数——
    // 「全是斜线」比「一片空白」多告诉用户一件事: 链是有的, 只是没有一条挂得出去。
    // 📌 与 FR-005 不冲突: 那条管的是**哪些腿算总体**(不按视角期限段裁、不套条数截断),
    // 不是列轴取谁。格的「无合约 vs 有腿但太便宜」同样要整条链才分得出 (Guardrail 13)。
    const rows = chainReportRows(context.spot);
    const columns = chainReportColumns(legs);
    const columnIndex = new Map<number, number>();
    columns.forEach((expiry, index) => columnIndex.set(expiry.getTime(), index));

    const chainLegCounts = grid(rows.length, columns.length, () => 0);
    const values = byMetric(() => grid(rows.length, columns.length, (): Prisma.Decimal[] => []));
    const legsByColumn = grid(1, columns.length, (): LegChainRow[] => [])[0];
    const dteByColumn = new Array<number>(columns.length).fill(0);
    const verdicts: ChainReportLegVerdict[] = [];

    for (const leg of legs) {
      const band = classifyOtmBand(context.spot, leg.strike);
      const tabs = tabsByLeg.get(leg) ?? [];
      // 「过两道三视角一律的门槛」⇔ 进得了全腿视角 —— 全腿的系统默认值只有权利金与活性两维
      // 非空 (`defaultCriteria`), 故 `all` 归属即活性通过。该不变量由 rules spec 钉住。
      verdicts.push({ inSkeleton: inSkeleton.has(leg), live: tabs.includes('all'), band });

      const column = columnIndex.get(leg.expiryDate.getTime());
      if (column === undefined) continue;
      legsByColumn[column].push(leg);
      dteByColumn[column] = leg.dteDays;
      if (band === null) continue;

      // 🚨 分母数在**整条链**上 (Guardrail 13): 用骨架数会让「有腿但全部太便宜」渲染成
      // 「该位置无合约」—— 即 US2 反对的「给出错误信息而不是缺失信息」。
      chainLegCounts[band][column] += 1;

      // 🚨 四种格值的口径**全部复用 `leg-derive.rules.ts` 既有导出**, 🚫 MUST NOT 另算一份
      // (FR-011 / FR-012 / FR-013: 与选约表同源)。收租与全腿用**同一个**年化数, 差别只在成员集。
      const rates =
        leg.bid === null
          ? null
          : computeLegRates({ strike: leg.strike, premium: leg.bid, dteDays: leg.dteDays });
      const perMetric: Readonly<Record<ChainReportMetric, Prisma.Decimal | null>> = {
        // 🚫 无 bid ⇒ 有效成本无定义, MUST NOT 拿 `K − 0` 冒充 (那是「白拿股票」的意思)。
        build_quality: leg.bid === null ? null : computeEffectiveCostVsWPct(v, leg.strike, leg.bid),
        rent_annualized: rates?.annualizedRate ?? null,
        all_annualized: rates?.annualizedRate ?? null,
        activity: new Prisma.Decimal(activityVolume(leg.openInterest, leg.volume)),
      };
      for (const metric of CHAIN_REPORT_METRICS) {
        if (!tabs.includes(CHAIN_REPORT_METRIC_TAB[metric])) continue;
        const value = perMetric[metric];
        if (value !== null) values[metric][band][column].push(value);
      }
    }

    return {
      rows,
      columns: columns.map((expiryDate, index) => ({
        expiryDate,
        dteDays: dteByColumn[index],
        isMonthlyChain: monthlyExpiries.has(dateOnlyOf(expiryDate)),
        // 平值 IV 取**整条链**上该到期日的腿 —— 隐含波动率是合约属性, 与挂不挂得出去无关,
        // 🚫 别拿骨架去插值 (被权利金挡下的档同样是定平值的两侧之一)。
        atmIv: atmImpliedVolatility(
          context.spot,
          legsByColumn[index].map((leg) => ({ strike: leg.strike, iv: leg.iv })),
        ),
        inRecallBand: inRecallBandOf(dteByColumn[index]),
      })),
      cells: byMetric((metric) =>
        rows.map((_row, r) =>
          columns.map((_column, c) =>
            aggregateCell(values[metric][r][c], metric, chainLegCounts[r][c]),
          ),
        ),
      ),
      gateCounts: chainReportGateCounts(verdicts),
    };
  }
}

/** `rows × columns` 的二维数组, 每格独立实例 (共享引用会让所有格指向同一个数组)。 */
function grid<T>(rows: number, columns: number, make: () => T): T[][] {
  return Array.from({ length: rows }, () => Array.from({ length: columns }, make));
}

/**
 * 逐格值各建一份。**四个键逐字写出**而不是 `Object.fromEntries` + `as` ——
 * 后者要一次类型断言, 而断言恰好会把「新增了第五种格值却忘了这里」变成静默通过。
 */
function byMetric<T>(make: (metric: ChainReportMetric) => T): Record<ChainReportMetric, T> {
  return {
    build_quality: make('build_quality'),
    rent_annualized: make('rent_annualized'),
    all_annualized: make('all_annualized'),
    activity: make('activity'),
  };
}

function emptyGrids(): Readonly<Record<ChainReportMetric, ChainReportGrid>> {
  return byMetric<ChainReportGrid>(() => []);
}

/**
 * 本列落在哪几种格值对应视角的召回段内。
 *
 * 🚨 **比区间用 `leg-recall.rules.ts` 导出的两个常量, 🚫 MUST NOT 写 `dteDays <= 49` 这类字面量**
 * —— 期限段是可调策略参数, 抄一处就多一处调参时会漏改的地方
 * (`check-optionsdesk-rule-constants` 不变量 #3 硬拦, 且它的 Fix 原文就是「import 常量比区间」)。
 */
function inRecallBandOf(dteDays: number): Readonly<Record<ChainReportMetric, boolean>> {
  return {
    build_quality: withinBand(dteDays, BUILD_RECALL_DTE),
    rent_annualized: withinBand(dteDays, RENT_RECALL_DTE),
    // 全腿视角不设期限段 (FR-003 of 050) ⇒ 两个全腿口径的格值恒覆盖。
    all_annualized: true,
    activity: true,
  };
}

function withinBand(dteDays: number, band: DteBand): boolean {
  return dteDays >= band.min && dteDays <= band.max;
}
