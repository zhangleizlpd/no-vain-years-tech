import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../security/prisma.service.js';
import { TRADING_CALENDAR_PORT, type TradingCalendarPort } from './trading-calendar.port.js';

/**
 * 新鲜度 SLA 检查 (019 T017, US4/FR-S09, plan D9): 每日一次 (盘后窗口尾 08:30
 * Asia/Shanghai) 扫 `sla_hours NOT NULL` 维度, stale 基准 = SyncRun 该维度最近
 * `success|partial|skipped` 行 finishedAt (skipped 视同按日历正常 — event-calendar
 * 平淡日跳过 ≠ stale; lastWatermark 仅 eod 维护不通用) — 按**交易日历折算**逾期
 * (休市日不计龄, 长假不误报), 超期 → 结构化 ERROR log (维度名/最后成功时间/SLA 阈值,
 * `alertIfDegraded` 同形态, clarify ⑤ 零新基建)。每日一次天然「恢复后不持续重复告警」。
 * `sla_hours` NULL = 该维度不检查 (列级开关, 无需独立灰度 flag)。
 */

/** 逾期折算的日扫描上限 (远超最大 SLA 192h ÷ 24; 超出 = 必然 stale, 防长循环)。 */
const MAX_SCAN_DAYS = 60;

const DAY_MS = 86_400_000;

/** Date → Asia/Shanghai 当日 YYYY-MM-DD (+8 固定偏移, 无夏令时)。 */
function shanghaiDate(d: Date): string {
  return new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

@Injectable()
export class FreshnessSlaCheck {
  private readonly logger = new Logger(FreshnessSlaCheck.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(TRADING_CALENDAR_PORT) private readonly calendar: TradingCalendarPort,
  ) {}

  /** 每日 08:30 Asia/Shanghai (盘后窗口尾, D9; @Cron 表达式静态)。 */
  @Cron('0 30 8 * * *', { timeZone: 'Asia/Shanghai' })
  async handleCron(): Promise<void> {
    await this.check(new Date());
  }

  /** 检查本体 (可直调控时, IT 面): 返超期维度键列表 (告警已发)。 */
  async check(now: Date): Promise<string[]> {
    const dims = await this.prisma.syncDimension.findMany({
      where: { slaHours: { not: null } },
      select: { dimensionKey: true, slaHours: true, marketScope: true },
    });
    const stale: string[] = [];
    // per-market 交易日缓存 (`${market}:${date}` → 开市与否), 跨维度复用避免重复查表 (S2-T1)。
    const openCache = new Map<string, boolean>();
    for (const dim of dims) {
      const lastOk = await this.prisma.syncRun.findFirst({
        where: {
          syncType: `sync:${dim.dimensionKey}`,
          status: { in: ['success', 'partial', 'skipped'] },
          finishedAt: { not: null },
        },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true },
      });
      if (!lastOk?.finishedAt) {
        // 无任何成功基准 (fresh deploy / 维度从未跑) — 不按 stale 告警 (避免上线即误报),
        // WARN 留痕; 首跑落 SyncRun 后进入正常判定。
        this.logger.warn(
          `freshness SLA: 维度 "${dim.dimensionKey}" 无 success/partial/skipped 基准行 — 跳过判定 (首跑前?)`,
        );
        continue;
      }
      const ageHours = await this.tradingAgeHours(
        lastOk.finishedAt,
        now,
        dim.marketScope,
        openCache,
      );
      if (ageHours > (dim.slaHours as number)) {
        stale.push(dim.dimensionKey);
        // 结构化 ERROR (FR-S09 字段齐: 维度名/最后成功时间/SLA 阈值/折算龄)。
        this.logger.error(
          `freshness SLA exceeded: ${JSON.stringify({
            dimensionKey: dim.dimensionKey,
            lastSuccessAt: lastOk.finishedAt.toISOString(),
            slaHours: dim.slaHours,
            tradingAgeHours: Math.round(ageHours * 10) / 10,
          })}`,
        );
      }
    }
    return stale;
  }

  /**
   * 交易日历折算龄 (FR-S09 休市不计龄): [from, now] 按 Shanghai 日切片, 仅交易日的切片时长计入。
   * S2-T1 per-market: 维度 `marketScope` 内**任一市场**当日开市即计该日 (OR 语义 — 有市场开市
   * 该维度就该刷新, 未刷即算龄)。复杂度 O(天数×市场数) (天数上限 MAX_SCAN_DAYS, 超出按必然 stale
   * 返 +∞; `openCache` 跨维度复用每 `market:date` 判定)。
   */
  private async tradingAgeHours(
    from: Date,
    now: Date,
    marketScope: string[],
    openCache: Map<string, boolean>,
  ): Promise<number> {
    if (from >= now) return 0;
    if (now.getTime() - from.getTime() > MAX_SCAN_DAYS * DAY_MS) {
      return Number.POSITIVE_INFINITY; // 远超扫描上限 = 必然超任何 SLA。
    }
    let hours = 0;
    // 逐 Shanghai 日切片: 当日切片 = [max(from, 当日0点), min(now, 次日0点)]。
    let cursor = from;
    while (cursor < now) {
      const date = shanghaiDate(cursor);
      // 当日 (Shanghai) 次日 0 点的 UTC 时刻。
      const nextMidnightUtc = new Date(new Date(`${date}T00:00:00+08:00`).getTime() + DAY_MS);
      const sliceEnd = nextMidnightUtc < now ? nextMidnightUtc : now;
      if (await this.isAnyMarketOpen(marketScope, date, openCache)) {
        hours += (sliceEnd.getTime() - cursor.getTime()) / 3_600_000;
      }
      cursor = sliceEnd;
    }
    return hours;
  }

  /** marketScope 内任一市场当日开市 (OR 语义, per-market 折算龄); 按 `market:date` 缓存跨维度复用。 */
  private async isAnyMarketOpen(
    marketScope: string[],
    date: string,
    openCache: Map<string, boolean>,
  ): Promise<boolean> {
    for (const market of marketScope) {
      const key = `${market}:${date}`;
      let open = openCache.get(key);
      if (open === undefined) {
        // 062 T006 机械映射: 旧布尔 `isTradingDay` ≡ `classify(...) !== 'non-trading'` ——
        // `unknown` 走**当开市**侧 (保守多算龄), 与改动前日历未 populate 时 fail-open 逐点
        // 相同 (Impl Guardrail 1)。`unknown` 的显式语义分派 (含留痕) 留给 T009。
        open = (await this.calendar.classify(market, date)) !== 'non-trading';
        openCache.set(key, open);
      }
      if (open) return true;
    }
    return false;
  }
}
