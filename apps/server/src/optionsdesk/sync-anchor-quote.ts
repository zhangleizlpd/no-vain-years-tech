import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { parseAnchorTicker } from './anchor.rules';
import type { PriceKind } from '../marketdata/marketdata.types';
import { toUtcDateOnly } from './create-anchor.usecase';

/**
 * 045 US2 — `last_close` / `last_close_date` **单向投影** (FR-016 / FR-017 / FR-027 / FR-036,
 * plan D4/D5)。
 *
 * 🚨 **单向铁律**: `marketdata.daily_bar` 是行情的**唯一真相源**; 锚表这两列是**投影/缓存不是
 * 事实**, 读端 MUST NOT 反写对方。落列的唯一理由 = 让距 W% = `(last_close − W) / W` 成为
 * **同表**表达式, 从而 SQL 可排序 (跨表 join 排序 = 把护城河边界拖进查询计划, plan D4)。
 *
 * 🚨 **跨 ctx 只读直查 (catalog Q7-B, FR-027)**: 走 `PrismaService` 直查 marketdata 的两张表,
 * **禁 `@Inject()` marketdata 的 use case** (Q7-C)。`// CROSS-CONTEXT-READ:` 注释挂在
 * **prisma 调用语句上方** —— `scripts/checks/check-server-moat.ts` 的 AST 探针只认「调用语句
 * 紧邻上方的连续注释」与「构造器注入参数上方」两处, 挂 import 上方**不被采信**。
 *
 * 读法逐字对齐既有 `marketdata/eod-backed-quote.adapter.ts:35-45`:
 * `Instrument(market_code)` → `DailyBar(instrumentId, adjust:'none', 最新 tradeDate)` ——
 * 该路径**完全 market-agnostic、零 cn/hk 硬编码**, us 日线落进既有 `DailyBar` 后自动有数。
 *
 * 降级纪律 (FR-017): 未注册 instrument / 无任何 bar / ticker 非法 ⇒ 显式 no-data
 * (`hasData:false`), **MUST NOT 写 0、MUST NOT 清空既有投影、MUST NOT 让单只失败污染同批其余**。
 *
 * ⚠️ 这两列**故意不入变更痕迹表**: 痕迹记的是「锚事实被谁改成什么」(FR-031 的 PIT 还原对象),
 * 而行情投影是外部数据的单向镜像、不是人或模型对锚的判断 —— 灌进痕迹只会把 PIT 回放淹没在
 * 每日行情噪声里。同理本文件**不碰** `breach_started_on` (那是雷达读端 T013 的状态机)。
 */

/**
 * FR-027 新鲜度档: 本 ctx 消费的行情**恒为「回落到 EOD 快照」一档**。
 *
 * 该档在既有 `PriceKind` 值域 (`marketdata.types.ts:29`) 里已有落点 = `eod_close`
 * (「V1 无实时源 → 报价由 PG DailyBar 最近收盘价支撑」), 故本片**不新增 wire 值** ——
 * 造一个恒等于 `eod_close` 的第二个名字 = 同一语义两套词表, mobile 侧还得写永远走不到的分支。
 * 类型标注取 marketdata 的 `PriceKind` 而非裸字面量: 将来实时源接入翻档时, 这里编译期即绑住。
 */
export const ANCHOR_QUOTE_PRICE_KIND: PriceKind = 'eod_close';

/** 锚标的行情投影 (三件套 `asOf` / `priceKind` / `hasData` 沿用既有行情读端契约, FR-027)。 */
export interface AnchorQuoteProjection {
  /** canonical `market:code`。 */
  ticker: string;
  /** 最新未复权收盘价; 行情不可得 ⇒ `null` (**禁伪造 0**, FR-017)。 */
  lastClose: Prisma.Decimal | null;
  /** 数据自身的 session 日期 `YYYY-MM-DD` (EC-14); 行情不可得 ⇒ `null`。 */
  asOf: string | null;
  priceKind: PriceKind;
  hasData: boolean;
}

export interface SyncAnchorQuoteReport {
  /** 本轮扫过的锚数。 */
  scanned: number;
  /** 真正落了 UPDATE 的锚数 (值未变不写 ⇒ 幂等)。 */
  updated: number;
  /** 逐锚投影结果, **含 `hasData:false` 的降级项** —— 显式 no-data 不隐藏 (FR-017)。 */
  projections: readonly AnchorQuoteProjection[];
}

/** 投影只需要这 4 列 (id 定位 + ticker 寻址 + 两列现值做幂等比较)。 */
interface AnchorQuoteRef {
  id: bigint;
  ticker: string;
  lastClose: Prisma.Decimal | null;
  lastCloseDate: Date | null;
}

/**
 * 🚨 **EC-14**: asOf 取**数据自身的 session 日期** (`daily_bar.tradeDate`), **不是本地日期** ——
 * 美股 session 跨本地交易日边界, 盘后时段取本地日期会把「昨天的收盘」标成今天 = 谎报新鲜度,
 * 而 FR-016 的「数据截至 X · 收盘」正是靠它可验证。纯函数, 与运行时时钟无关。
 */
export function toQuoteAsOf(tradeDate: Date): string {
  return toUtcDateOnly(tradeDate).toISOString().slice(0, 10);
}

/** 显式 no-data 投影 (未注册 / 无 bar / ticker 非法三条降级路径共用)。 */
function noQuote(ticker: string): AnchorQuoteProjection {
  return {
    ticker,
    lastClose: null,
    asOf: null,
    priceKind: ANCHOR_QUOTE_PRICE_KIND,
    hasData: false,
  };
}

/** 投影值与锚表现值是否一致 (一致则本轮不写, 避免每日全表无谓 UPDATE)。 */
function isSameProjection(ref: AnchorQuoteRef, lastClose: Prisma.Decimal, asOf: string): boolean {
  if (ref.lastClose === null || ref.lastCloseDate === null) return false;
  return ref.lastClose.equals(lastClose) && toQuoteAsOf(ref.lastCloseDate) === asOf;
}

@Injectable()
export class SyncAnchorQuoteUseCase {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 全锚一轮投影。O(n) 次跨 ctx 只读查询 (n = 锚数, 上限约 1000, spec Assumptions) ——
   * 逐锚独立, 单只 no-data 不影响同批其余。
   */
  async execute(): Promise<SyncAnchorQuoteReport> {
    const anchors = (await this.prisma.anchor.findMany({
      select: { id: true, ticker: true, lastClose: true, lastCloseDate: true },
    })) as AnchorQuoteRef[];

    const projections: AnchorQuoteProjection[] = [];
    let updated = 0;
    for (const anchor of anchors) {
      const projection = await this.projectOne(anchor.ticker);
      projections.push(projection);
      if (!projection.hasData || projection.lastClose === null || projection.asOf === null) {
        // 行情不可得: 既不写 0 也不清空既有投影 —— 清空会把「陈旧但可用」误降成「不可用」。
        continue;
      }
      if (isSameProjection(anchor, projection.lastClose, projection.asOf)) continue;
      await this.prisma.anchor.updateMany({
        where: { id: anchor.id },
        data: {
          lastClose: projection.lastClose,
          lastCloseDate: new Date(`${projection.asOf}T00:00:00.000Z`),
        },
      });
      updated += 1;
    }
    return { scanned: anchors.length, updated, projections };
  }

  /** 单只标的的行情投影 (读法对齐 `eod-backed-quote.adapter.ts:35-45`)。 */
  private async projectOne(ticker: string): Promise<AnchorQuoteProjection> {
    const parsed = parseAnchorTicker(ticker);
    if (parsed === null) return noQuote(ticker);

    // CROSS-CONTEXT-READ: marketdata.instrument 只读直查 (catalog Q7-B) —— 锚 ticker → 标的 id
    // 寻址。零写、零 @Inject() 对方 use case (Q7-C); marketdata 不知道锚表存在 (方向铁律)。
    const instrument = await this.prisma.instrument.findUnique({
      where: { market_code: { market: parsed.market, code: parsed.code } },
      select: { id: true },
    });
    if (instrument === null) return noQuote(ticker);

    // CROSS-CONTEXT-READ: marketdata.daily_bar 只读直查 (catalog Q7-B) —— 最新未复权收盘价。
    // 🚨 单向: daily_bar 是唯一真相源, 本 ctx MUST NOT 反写它 (FR-036)。
    const latest = await this.prisma.dailyBar.findFirst({
      where: { instrumentId: instrument.id, adjust: 'none' },
      orderBy: { tradeDate: 'desc' },
      select: { tradeDate: true, close: true },
    });
    if (latest === null) return noQuote(ticker);

    return {
      ticker,
      lastClose: latest.close,
      asOf: toQuoteAsOf(latest.tradeDate),
      priceKind: ANCHOR_QUOTE_PRICE_KIND,
      hasData: true,
    };
  }
}
