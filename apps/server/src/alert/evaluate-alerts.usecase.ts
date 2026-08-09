import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { deriveAdjustedBars, type AdjustableBarRow } from '../marketdata/adjusted-bars.rules.js';
import {
  conditionDataNeed,
  evaluateAlertConditions,
  type EvaluationInputs,
  type FundamentalRow,
} from './alert-evaluation.rules';
import type { IndicatorBar } from './alert-indicator.rules';

/** 一轮评估汇总 (CLI/processor 日志用)。 */
export interface EvaluateAlertsSummary {
  /** 扫描到的启用预警数。 */
  enabledAlerts: number;
  /** 本轮触发 (流水已落) 数。 */
  triggered: number;
  /** 标的无 instrument / 无 none bar 跳过的预警数。 */
  skippedNoBar: number;
  /** 同 (alertId, tradeDate) 已触发跳过数 (幂等重跑 / 停牌旧 bar no-op)。 */
  skippedDuplicate: number;
}

/** P2002 结构化判定 (portfolio bind-broker-account 同式; Prisma 7 兼容)。 */
const isP2002 = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002';

const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);

/** 指标窗口统一取数上限 (plan D5: MA250/NEW_HIGH(250) 需 251; 520≈2年+ 罩递推初始化误差)。 */
const INDICATOR_WINDOW = 520;

/**
 * 021 US2 + 023 US2 — EOD 评估引擎核心 UC (plan D1/D2 调度自治; processor/CLI 共用入口)。
 *
 * 流程: load 启用预警(含 conditions) → (market,code) 去重 → Q7-B 只读批量取 instrument →
 * **per-instrument 按需取数分层** (plan D2, conditionDataNeed 派生):
 *   - 021 价格 4 类: 最新 none bar (D8 真实成交价口径)
 *   - 价格扩展/成交量/技术指标: 最近 520 根 none bar + 全量 adjustment_factor →
 *     deriveAdjustedBars(…,'forward') → 前复权数值序列 (FR-S05)
 *   - 估值 10 类: 最新 fundamental_snapshot 行 + staleness = count(trading_day) ≤3 gate (D4)
 * → 求值纯函数 (alert-evaluation.rules T011 查表比较) → 命中: 单 alert 小 tx (create
 * AlertTrigger 快照 + push fan-out PENDING delivery (022 T005) + 三档后置)。
 *
 * 幂等/竞态 (plan D9):
 * - 重跑/停牌旧 bar: trigger 撞 @@unique([alertId, tradeDate]) → P2002 catch-skip (整 tx 回滚)。
 * - 评估中用户删除/toggle: 后置走 deleteMany/updateMany (affected-count 体例) — count 0 no-op。
 * - 单 alert 失败隔离: 逐 alert 独立 tx, 异常不传染本轮其余预警。
 *
 * 规模 (SC-004 ≤5min): V1 自用 ~几十预警; 标的级 520 行索引扫 <10ms + 指标纯函数 O(n) 微秒级
 * → 全轮秒级, 余量 2 个数量级 (plan D2 容量论证)。上量再换 DISTINCT ON 批查。双模 seam:
 * 盘中模式换实时 tick 喂同形 inputs, 求值零改。
 */
@Injectable()
export class EvaluateAlertsUseCase {
  private readonly logger = new Logger(EvaluateAlertsUseCase.name);

  constructor(private readonly prisma: PrismaService) {}

  async execute(): Promise<EvaluateAlertsSummary> {
    const alerts = await this.prisma.alert.findMany({
      where: { enabled: true },
      include: { conditions: true },
      orderBy: { id: 'asc' },
    });
    const summary: EvaluateAlertsSummary = {
      enabledAlerts: alerts.length,
      triggered: 0,
      skippedNoBar: 0,
      skippedDuplicate: 0,
    };
    if (alerts.length === 0) return summary;

    const ctxByKey = await this.assembleContexts(alerts);

    for (const alert of alerts) {
      const ctx = ctxByKey.get(`${alert.market} ${alert.code}`);
      if (ctx === undefined) {
        summary.skippedNoBar += 1; // 停牌未同步/未收录标的: 本轮跳过不报错 (spec Edge)
        continue;
      }

      const hits = evaluateAlertConditions(alert.conditions, ctx.inputs);
      if (hits === null) continue;

      try {
        await this.prisma.$transaction(async (tx) => {
          const trigger = await tx.alertTrigger.create({
            data: {
              alertId: alert.id,
              accountId: alert.accountId,
              market: alert.market,
              code: alert.code,
              instrumentName: ctx.name,
              tradeDate: ctx.tradeDate,
              conditionsSnapshot: hits as unknown as Prisma.InputJsonValue,
              frequencySnapshot: alert.frequency,
              noteSnapshot: alert.note,
            },
          });
          // push fan-out (022 T005, R1 same-ctx outbox per plan D2): 每绑定一行 PENDING,
          // registrationId 为创建时快照 (dispatch 前复核绑定仍存在); 0 绑定 → 0 行,
          // 消息中心兜底 (FR-004)。同 tx — trigger 回滚连带 delivery 零残留。
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
          // 三档后置 — affected-count 体例: 评估窗口内被删/已改 → count 0 no-op (D9)。
          if (alert.frequency === 'ONCE_DELETE') {
            await tx.alert.deleteMany({ where: { id: alert.id } });
          } else if (alert.frequency === 'ONCE_DISABLE') {
            await tx.alert.updateMany({ where: { id: alert.id }, data: { enabled: false } });
          } // DAILY: 不动 (新 tradeDate 自然再触发)
        });
        summary.triggered += 1;
      } catch (e) {
        if (isP2002(e)) {
          summary.skippedDuplicate += 1; // 同 tradeDate 已触发 (重跑/停牌旧 bar) → 幂等 no-op
          continue;
        }
        // 单 alert 失败隔离: 记日志继续本轮其余预警, 不让一坏行废整轮。
        this.logger.error(
          `evaluate alert ${alert.id.toString()} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    this.logger.log(
      `alert eval round: enabled=${summary.enabledAlerts} triggered=${summary.triggered} ` +
        `noBar=${summary.skippedNoBar} dup=${summary.skippedDuplicate}`,
    );
    return summary;
  }

  /**
   * per-标的取数装配 (plan D2): 去重标的 → 按该标的所有预警条件 union 决定取哪些数据源 →
   * 最新 none bar (必) + 按需 520 前复权序列 / 估值快照+staleness。无最新 bar 的标的不入表
   * (alert 循环按缺失计 skippedNoBar)。返回 key=`market code` → {name, tradeDate, inputs}。
   */
  private async assembleContexts(
    alerts: Array<{ market: string; code: string; conditions: { type: string }[] }>,
  ): Promise<Map<string, { name: string; tradeDate: Date; inputs: EvaluationInputs }>> {
    const needByKey = new Map<string, { forwardBars: boolean; fundamental: boolean }>();
    for (const a of alerts) {
      const key = `${a.market} ${a.code}`;
      const need = needByKey.get(key) ?? { forwardBars: false, fundamental: false };
      for (const c of a.conditions) {
        const dataNeed = conditionDataNeed(c.type);
        if (dataNeed === 'forwardBars') need.forwardBars = true;
        else if (dataNeed === 'fundamental') need.fundamental = true;
      }
      needByKey.set(key, need);
    }
    const keys = [...needByKey.keys()].map((k) => {
      const [market, code] = k.split(' ');
      return { market: market!, code: code! };
    });
    // CROSS-CONTEXT-READ: 评估触发快照需 marketdata.instrument 的 id+name (只读, Q7-B per ADR-0052)
    const instruments = await this.prisma.instrument.findMany({
      where: { OR: keys },
      select: { id: true, market: true, code: true, name: true },
    });

    const ctxByKey = new Map<string, { name: string; tradeDate: Date; inputs: EvaluationInputs }>();
    for (const inst of instruments) {
      const need = needByKey.get(`${inst.market} ${inst.code}`) ?? {
        forwardBars: false,
        fundamental: false,
      };
      // CROSS-CONTEXT-READ: 评估读 marketdata.daily_bar none 口径最新行 (只读, Q7-B per ADR-0052)
      const latest = await this.prisma.dailyBar.findFirst({
        where: { instrumentId: inst.id, adjust: 'none' },
        orderBy: { tradeDate: 'desc' },
        select: { tradeDate: true, high: true, low: true, close: true, prevClose: true },
      });
      if (latest === null) continue; // 无 bar (停牌/未收录) → 不入表, alert 循环计 skippedNoBar

      const inputs: EvaluationInputs = {
        noneBar: {
          high: latest.high,
          low: latest.low,
          close: latest.close,
          prevClose: latest.prevClose,
        },
      };
      if (need.forwardBars) inputs.forwardBars = await this.loadForwardBars(inst.id);
      if (need.fundamental) {
        const f = await this.loadFundamental(inst.id, latest.tradeDate);
        inputs.fundamental = f.row;
        inputs.fundamentalStaleness = f.staleness;
      }
      ctxByKey.set(`${inst.market} ${inst.code}`, {
        name: inst.name,
        tradeDate: latest.tradeDate,
        inputs,
      });
    }
    return ctxByKey;
  }

  /**
   * 前复权数值序列: 最近 520 根 none bar (升序) + 全量因子版本 → forward 换算 → 数值投影。
   * volume/turnoverRate 复权不变量 (adjusted-bars 直拷), 故量类条件同读本序列 (plan D2)。
   */
  private async loadForwardBars(instrumentId: bigint): Promise<IndicatorBar[]> {
    // CROSS-CONTEXT-READ: 评估读 marketdata.daily_bar none 序列 520 根算指标 (只读, Q7-B per ADR-0052)
    const rows = await this.prisma.dailyBar.findMany({
      where: { instrumentId, adjust: 'none' },
      orderBy: { tradeDate: 'desc' },
      take: INDICATOR_WINDOW,
      select: {
        tradeDate: true,
        open: true,
        high: true,
        low: true,
        close: true,
        changePct: true,
        prevClose: true,
        volume: true,
        amount: true,
        turnoverRate: true,
      },
    });
    rows.reverse(); // desc 取最近 N → 反转为升序 (deriveAdjustedBars / 指标纯函数前提)
    // CROSS-CONTEXT-READ: 评估读 marketdata.adjustment_factor 全量版本算前复权 (只读, Q7-B per ADR-0052)
    const versions = await this.prisma.adjustmentFactor.findMany({
      where: { instrumentId },
      select: { exDate: true, factorBackward: true },
    });
    const noneRows: AdjustableBarRow[] = rows.map((r) => ({
      tradeDate: dateOnly(r.tradeDate),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      changePct: r.changePct,
      prevClose: r.prevClose,
      volume: r.volume,
      amount: r.amount,
      turnoverRate: r.turnoverRate,
    }));
    const forward = deriveAdjustedBars(
      noneRows,
      versions.map((v) => ({ exDate: dateOnly(v.exDate), factorJump: v.factorBackward })),
      'forward',
    );
    return forward.map((b) => ({
      tradeDate: b.tradeDate,
      open: b.open.toNumber(),
      high: b.high.toNumber(),
      low: b.low.toNumber(),
      close: b.close.toNumber(),
      prevClose: b.prevClose === null ? null : b.prevClose.toNumber(),
      volume: b.volume === null ? null : b.volume.toNumber(),
      turnoverRate: b.turnoverRate === null ? null : b.turnoverRate.toNumber(),
    }));
  }

  /**
   * 最新估值快照 + staleness (= 快照日与触发交易日的交易日距离, plan D4)。
   * 无快照 → {null, null} (求值层不命中); staleness = count(trading_day in (snap.date, tradeDate])。
   */
  private async loadFundamental(
    instrumentId: bigint,
    tradeDate: Date,
  ): Promise<{ row: FundamentalRow | null; staleness: number | null }> {
    // CROSS-CONTEXT-READ: 评估读 marketdata.fundamental_snapshot 最新行 (只读, Q7-B per ADR-0052)
    const snap = await this.prisma.fundamentalSnapshot.findFirst({
      where: { instrumentId },
      orderBy: { date: 'desc' },
      select: {
        date: true,
        peTtm: true,
        pb: true,
        dividendYield: true,
        pePctlY3: true,
        pePctlY5: true,
        pbPctlY3: true,
        pbPctlY5: true,
      },
    });
    if (snap === null) return { row: null, staleness: null };
    // CROSS-CONTEXT-READ: 评估 count marketdata.trading_day 算估值 staleness gate (只读, plan D4)
    // staleness = 快照日后到触发日之间的交易日数; ≤3 gate 在 rules 层判 (FundamentalRow 同源 number)。
    const staleness = await this.prisma.tradingDay.count({
      where: { market: 'cn', date: { gt: snap.date, lte: tradeDate } },
    });
    const row: FundamentalRow = {
      date: dateOnly(snap.date),
      peTtm: snap.peTtm === null ? null : snap.peTtm.toNumber(),
      pb: snap.pb === null ? null : snap.pb.toNumber(),
      dividendYield: snap.dividendYield === null ? null : snap.dividendYield.toNumber(),
      pePctlY3: snap.pePctlY3 === null ? null : snap.pePctlY3.toNumber(),
      pePctlY5: snap.pePctlY5 === null ? null : snap.pePctlY5.toNumber(),
      pbPctlY3: snap.pbPctlY3 === null ? null : snap.pbPctlY3.toNumber(),
      pbPctlY5: snap.pbPctlY5 === null ? null : snap.pbPctlY5.toNumber(),
    };
    return { row, staleness };
  }
}
