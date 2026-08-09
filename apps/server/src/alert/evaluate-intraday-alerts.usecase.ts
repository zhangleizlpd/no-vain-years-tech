import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../security/prisma.service.js';
import { ALERT_QUEUE_REDIS } from './alert-queue-connection.js';
import { ALERT_CONDITION_META, type AlertConditionType } from './alert-condition-meta.js';
import { evaluateAlertConditions, type EvaluationInputs } from './alert-evaluation.rules.js';
import { REALTIME_QUOTE_PORT, type RealtimeQuotePort } from './realtime-quote.port.js';
import { toVendorSymbol, type RealtimeQuote } from './realtime-quote.rules.js';

/** 上一 tick 快照 Redis 键前缀 (hash: field=vendor 符号, value=现价串; 带 tradeDate 自然换日作废)。 */
const LASTTICK_KEY_PREFIX = 'alert:intraday:lasttick:';
const lasttickKey = (tradeDate: string): string => `${LASTTICK_KEY_PREFIX}${tradeDate}`;
/** 快照 TTL = 6h (每 tick 续期; 末 tick ~15:00 + 6h 自清, 防 date 键累积)。 */
const LASTTICK_TTL_SECONDS = 6 * 60 * 60;

/** 盘中一轮求值汇总 (intraday-eval processor 日志 / IT 观察点)。 */
export interface IntradayEvalSummary {
  /** 本 tick 实时拉取集标的数 (intradayEligible 派生去重, plan D5)。 */
  fetched: number;
  /** 本 tick 触发 (流水已落) 数。 */
  triggered: number;
  /** 同 (alertId, tradeDate) 已触发跳过 (盘中幂等 / 盘中→EOD 判重, plan D6)。 */
  skippedDuplicate: number;
  /** 缺标的实时价 (vendor 未返该符号) → 不命中跳过 (plan D3 防御)。 */
  skippedNoData: number;
}

/** P2002 结构化判定 (evaluate-alerts 同式; Prisma 7 兼容)。 */
const isP2002 = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002';

/** type 是否盘中可即时判定 (到价 2 类 + 5min 2 类, alert-condition-meta SoT)。 */
function isIntradayEligible(type: string): boolean {
  return ALERT_CONDITION_META[type as AlertConditionType]?.intradayEligible === true;
}

/**
 * 实时报价 → 求值输入 (双模, plan D3):
 *   - 到价类: 现价单点喂 noneBar high=low=close, 昨收喂 prevClose → `evaluateAlertConditions`
 *     零改即「PRICE_RISE_TO: 现价≥阈 / PRICE_FALL_TO: 现价≤阈 / 日内涨跌幅: (现价-昨收)/昨收」。
 *   - 5min 差分类 (T010): 现价 + 上一 tick 价 → `realtimeDiff` 喂新 realtime 求值分支
 *     ((现价-上一tick价)/上一tick价×100); 首 tick (prevTickPrice null) → 5min 类不命中 (防御)。
 */
function buildRealtimeInputs(quote: RealtimeQuote, prevTickPrice: number | null): EvaluationInputs {
  const price = new Prisma.Decimal(quote.price);
  return {
    noneBar: {
      high: price,
      low: price,
      close: price,
      prevClose: new Prisma.Decimal(quote.prevClose),
    },
    realtimeDiff: { price: quote.price, prevTickPrice },
  };
}

/**
 * 024 盘中实时求值 UC (US1/US2; intraday-eval processor 在交易时段调用, 源故障上抛供熔断计数)。
 *
 * 流程 (plan D3/D4/D5/D6): load 启用预警(含 conditions) → 按 `intradayEligible` 派生拉取集
 * (∃ 盘中可判条件的标的去重 → vendor 符号) → `REALTIME_QUOTE_PORT` 批量取价 (腾讯主/新浪备
 * FallbackChain, 全断 → **抛**) → 读上一 tick 快照 (Redis `alert:intraday:lasttick:{tradeDate}`
 * hash, field=vendor 符号) → 逐预警双模求值 (到价类喂实时价零改 + 5min 差分类喂「现价/上一 tick 价」
 * 对; `evaluateAlertConditions`) → 命中走 021 同款单 alert 小 tx (`AlertTrigger` 快照携
 * `priceContext:'intraday'` + 022 push fan-out PENDING + 三档后置) → 判重撞
 * `@@unique([alertId, tradeDate])` P2002 catch-skip (盘中幂等 + 当日 EOD 轮再触发 no-op) →
 * 循环后以本 tick 报价覆写快照 (下一 tick 差分基准, 首 tick 无键 → 差分类不命中, plan D4)。
 *
 * 与 EOD UC 共用 `evaluateAlertConditions` 纯函数但独立入口 (021/023 零回归)。instrumentName 取
 * vendor 实时名 (现价同源, 省一次 marketdata 跨 ctx 读 — 本 UC 零 marketdata 耦合, alert 叶子 ctx)。
 * 快照按 vendor 符号 (非 instrumentId) 索引 — 保本 UC 零 marketdata 读 (plan D4 「{instrumentId}」
 * 的等价细化, 符号已是去重拉取集天然键)。
 */
@Injectable()
export class EvaluateIntradayAlertsUseCase {
  private readonly logger = new Logger(EvaluateIntradayAlertsUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REALTIME_QUOTE_PORT) private readonly realtimeQuotes: RealtimeQuotePort,
    @Inject(ALERT_QUEUE_REDIS) private readonly redis: Redis,
  ) {}

  /**
   * @param tradeDate 上海当日交易日 (YYYY-MM-DD), 供 trigger 落库 + 判重键 (与当日 EOD 轮 bar
   *   tradeDate 同值 → 跨盘中/EOD 唯一键判重)。
   */
  async execute(tradeDate: string): Promise<IntradayEvalSummary> {
    const summary: IntradayEvalSummary = {
      fetched: 0,
      triggered: 0,
      skippedDuplicate: 0,
      skippedNoData: 0,
    };

    const alerts = await this.prisma.alert.findMany({
      where: { enabled: true },
      include: { conditions: true },
      orderBy: { id: 'asc' },
    });
    // 拉取集派生 (plan D5): ∃ intradayEligible 条件的预警 → (market, code) → vendor 符号去重。
    // 纯 EOD 条件预警标的不进 tick (最小请求集, SC-003)。
    const intradayAlerts = alerts.filter((a) =>
      a.conditions.some((c) => isIntradayEligible(c.type)),
    );
    const symbolByKey = new Map<string, string>();
    for (const a of intradayAlerts) {
      const key = `${a.market} ${a.code}`;
      if (symbolByKey.has(key)) continue;
      try {
        symbolByKey.set(key, toVendorSymbol(a.market, a.code));
      } catch {
        // 非 cn 标的 (V1 盘中实时仅 A 股): 不入拉取集, 该预警本 tick 跳过 (EOD 兜底)
      }
    }
    const symbols = [...new Set(symbolByKey.values())];
    summary.fetched = symbols.length;
    if (symbols.length === 0) return summary;

    const quotes = await this.realtimeQuotes.fetchQuotes(symbols); // 源全断 → 抛 (processor 熔断计数)
    const tradeDateValue = new Date(tradeDate);
    // 上一 tick 快照 (5min 差分依赖, plan D4): 求值前读、循环后覆写。首 tick 无键 → 差分类跳过。
    const lastTick = await this.redis.hgetall(lasttickKey(tradeDate));

    for (const alert of intradayAlerts) {
      const symbol = symbolByKey.get(`${alert.market} ${alert.code}`);
      if (symbol === undefined) continue; // 非 cn → 不在拉取集
      const quote = quotes.get(symbol);
      if (quote === undefined) {
        summary.skippedNoData += 1; // vendor 未返 (无效码/停牌) → 不命中, 与 EOD「无 bar 跳过」一致
        continue;
      }
      const prevRaw = lastTick[symbol];
      const prevTickPrice =
        prevRaw !== undefined && Number.isFinite(Number(prevRaw)) ? Number(prevRaw) : null;

      const hits = evaluateAlertConditions(
        alert.conditions,
        buildRealtimeInputs(quote, prevTickPrice),
      );
      if (hits === null) continue;
      // 盘中口径标注 (plan D7): 每条快照元素携 priceContext, message.response per-element 读取。
      const snapshot = hits.map((h) => ({ ...h, priceContext: 'intraday' as const }));

      try {
        await this.prisma.$transaction(async (tx) => {
          const trigger = await tx.alertTrigger.create({
            data: {
              alertId: alert.id,
              accountId: alert.accountId,
              market: alert.market,
              code: alert.code,
              instrumentName: quote.name || alert.code,
              tradeDate: tradeDateValue,
              conditionsSnapshot: snapshot as unknown as Prisma.InputJsonValue,
              frequencySnapshot: alert.frequency,
              noteSnapshot: alert.note,
            },
          });
          // push fan-out (022, same-ctx outbox): 每绑定一行 PENDING; 0 绑定 → 消息中心兜底。
          // 同 tx — trigger 回滚连带 delivery 零残留。
          const bindings = await tx.pushBinding.findMany({
            where: { accountId: alert.accountId },
            select: { registrationId: true },
          });
          if (bindings.length > 0) {
            await tx.pushDelivery.createMany({
              data: bindings.map((b) => ({
                triggerId: trigger.id,
                accountId: alert.accountId,
                registrationId: b.registrationId,
              })),
            });
          }
          // 三档后置 — affected-count 体例 (评估窗口内被删/改 → count 0 no-op)。
          if (alert.frequency === 'ONCE_DELETE') {
            await tx.alert.deleteMany({ where: { id: alert.id } });
          } else if (alert.frequency === 'ONCE_DISABLE') {
            await tx.alert.updateMany({ where: { id: alert.id }, data: { enabled: false } });
          } // DAILY: 不动 (新 tradeDate 自然再触发, 同日撞唯一键 dup-skip)
        });
        summary.triggered += 1;
      } catch (e) {
        if (isP2002(e)) {
          summary.skippedDuplicate += 1; // 盘中已触发 (同日重 tick) / 当日 EOD 已触发 → 幂等 no-op
          continue;
        }
        this.logger.error(
          `intraday eval alert ${alert.id.toString()} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // 覆写上一 tick 快照 (本 tick 全部有效报价 → 下一 tick 差分基准, plan D4)。每 tick 续 TTL。
    if (quotes.size > 0) {
      const snapshot: Record<string, string> = {};
      for (const [symbol, q] of quotes) snapshot[symbol] = String(q.price);
      await this.redis.hset(lasttickKey(tradeDate), snapshot);
      await this.redis.expire(lasttickKey(tradeDate), LASTTICK_TTL_SECONDS);
    }

    this.logger.log(
      `intraday eval round (${tradeDate}): fetched=${summary.fetched} triggered=${summary.triggered} ` +
        `dup=${summary.skippedDuplicate} noData=${summary.skippedNoData}`,
    );
    return summary;
  }
}
