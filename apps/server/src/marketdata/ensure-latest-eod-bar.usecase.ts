import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service.js';
import { subtractDays, toDailyBarRow, writeDailyBarRows } from './dimension-executor.js';
import { EOD_BAR_PORT, type EodBarPort } from './eod-bar.port.js';
import { parseCanonicalSymbol } from './marketdata.rules.js';
import type { EodBarPoint } from './marketdata.types.js';

/**
 * **单标的按需取最近收盘 + 幂等落库** —— 给「刚建的锚立刻要有价」这类**同步**诉求用的窄入口。
 *
 * ## 它为什么存在（不是「又一个采集口」）
 *
 * 常规 EOD 采集是**批量 / 按维度 / 按工作集**跑的（`DimensionExecutor` 的 `us_equity_bar`），
 * 而工作集由「已有的锚」派生 ⇒ **全新标的在成为锚之前不会被采**，成为锚之后又要等下一轮。
 * 对建锚这个动作而言那是个死循环：锚要有价得先有 EOD，EOD 要被采得先有锚。本 use case 把这
 * 个环剪断 —— 建锚那一刻就地取一次。
 *
 * ## 三条刻意的性质
 *
 * 1. **与落盘 EOD 同源**：走的是同一个 {@link EOD_BAR_PORT}（按市场路由：us→富途 shim、
 *    cn/hk→理杏仁），映射复用 `DimensionExecutor` 的 `toDailyBarRow`。⇒ 本入口写进
 *    `daily_bar` 的行与常规轮写的**逐字段同口径**，不会出现「两条路两个数」。
 *    🚨 **MUST NOT 在这里另抄一份映射** —— 那正是两份必漂的形状。
 * 2. **幂等 + 尾窗可订正**：与采集轮共用 {@link writeDailyBarRows}，唯一键
 *    `(instrumentId, tradeDate, adjust)` ⇒ 与常规轮抢跑仍是各自 no-op、不需要协调；而落在
 *    尾窗内的行改得动 ⇒ vendor 事后订正 / 盘中「进行中」K 线不会被这条旁路永久冻住。
 * 3. **不推水位**：`sync_dimension.lastWatermark` 一格不动。本入口是**旁路**，不是采集轮的
 *    一次执行；推了水位会让常规轮以为这段区间已经跑过，静默漏掉同批其余标的。
 *
 * ## 调用方须知
 *
 * ⚠️ 它**不走** `DimensionExecutor` 的预算核算 ⇒ 每次调用 = 一次真实 vendor 请求。故只允许
 * **单标的、由用户动作触发**的场景调它（建锚有 30/60s 限流兜着），MUST NOT 拿它去循环补一批。
 */
@Injectable()
export class EnsureLatestEodBarUseCase {
  private readonly logger = new Logger(EnsureLatestEodBarUseCase.name);

  /**
   * 回看窗天数。取 10 是为了跨过周末 + 常规节假日仍能拿到至少一根；再长没有收益 ——
   * 本入口只关心「最近一根」，历史补齐是 backfill 的活。
   */
  private static readonly LOOKBACK_DAYS = 10;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EOD_BAR_PORT) private readonly eodBar: EodBarPort,
  ) {}

  /**
   * @param symbol canonical `market:code`
   * @param targetDate 目标交易日 (YYYY-MM-DD)，通常 = 该市场最近一个已收盘交易日
   * @returns 落库后的最近一根 none 口径日线；标的未注册 / vendor 无数据 → `null`
   */
  async execute(symbol: string, targetDate: string): Promise<EodBarPoint | null> {
    const parsed = parseCanonicalSymbol(symbol);
    if (parsed === null) return null;

    const instrument = await this.prisma.instrument.findUnique({
      where: { market_code: { market: parsed.market, code: parsed.code } },
      select: { id: true },
    });
    if (instrument === null) {
      // 标的未注册 ⇒ 不猜、不建 instrument 行 (那是 universe 同步的职责)。
      this.logger.warn(`[ensure-latest-eod-bar] ${symbol} 未在 instrument 注册, 跳过`);
      return null;
    }

    const bars = await this.eodBar.getBars({
      symbol,
      adjust: 'none',
      from: subtractDays(targetDate, EnsureLatestEodBarUseCase.LOOKBACK_DAYS),
      to: targetDate,
    });
    if (bars.length === 0) return null; // 停牌 / 新股尚无行情 —— 零落库, 非错误。

    await writeDailyBarRows(
      this.prisma,
      bars.map((b) => toDailyBarRow(instrument.id, b)),
    );

    // 端口契约说按 tradeDate 升序, 但这里**不赖它** —— 顺序若哪天变了, 取错的那根是一个
    // 「不报错、只是价格差几天」的静默偏差, 而这正是本仓反复踩的形状。取最大值零成本。
    return bars.reduce((acc, b) => (b.tradeDate > acc.tradeDate ? b : acc));
  }
}
