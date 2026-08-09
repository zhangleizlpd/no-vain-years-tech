import { Injectable, Logger } from '@nestjs/common';

/**
 * 日历命中检查 (019 T013, US2/FR-S02/S03, plan D6): event-calendar 维度 tick won 后、
 * 组 flow 前的轻量命中判定 — 命中才组真同步, 未命中零 vendor 数据外呼。
 *
 * **source 路由**: 按 `SyncDimension.calendarSource` 路由到已注册 checker (轻量 1 次调用
 * 判定「今日该维度有无新事件」)。slow-drift / continuous-daily 维度**不经此检查** (analyze
 * C1: corp 周扫即同步不自我 gate — 以自身物化的日历 gate 自己 = 鸡生蛋饿死)。
 *
 * **防御语义** (spec edge cases):
 * - source NULL / 未注册 → 按未命中 + WARN (与「executor 未注册」同精神, 不崩不阻塞);
 * - checker 自身异常 (vendor 日历端点超时等) → 按未命中 + WARN, 下一 tick 重查。
 *
 * **live source 现状** (T001 探测 2026-06-05): 理杏仁无市场级披露日历端点 → 暂无 live
 * checker 注册 (financial 落 slow-drift fallback); 机制照建, IT 用测试 source 验证。
 */

/** 单 source 命中判定 fn: 返「asOf 当日该维度是否有新事件」。 */
export type CalendarHitChecker = (dimensionKey: string, asOf: string) => Promise<boolean>;

/** 检查输入: 维度行最小投影。 */
export interface CalendarCheckDimension {
  dimensionKey: string;
  calendarSource: string | null;
}

@Injectable()
export class CalendarHitCheck {
  private readonly logger = new Logger(CalendarHitCheck.name);

  /** source → checker 注册表 (新日历源 = 注册一个 checker, 与 executor 注册表同精神)。 */
  private readonly checkers = new Map<string, CalendarHitChecker>();

  registerSource(source: string, checker: CalendarHitChecker): void {
    this.checkers.set(source, checker);
  }

  /** 命中判定 (防御不 throw): 未知/NULL source 与 checker 异常一律按未命中 + WARN。 */
  async isHit(dim: CalendarCheckDimension, asOf: string): Promise<boolean> {
    if (!dim.calendarSource) {
      this.logger.warn(
        `event-calendar 维度 "${dim.dimensionKey}" calendarSource 为空 — 按未命中 (配置残缺?)`,
      );
      return false;
    }
    const checker = this.checkers.get(dim.calendarSource);
    if (!checker) {
      this.logger.warn(
        `calendarSource "${dim.calendarSource}" 无注册 checker (维度 "${dim.dimensionKey}") — 按未命中`,
      );
      return false;
    }
    try {
      return await checker(dim.dimensionKey, asOf);
    } catch (err) {
      // 日历检查自身失败 (端点超时等): 按未命中 + 告警不阻塞, 下一 tick 重查 (spec edge case)。
      this.logger.warn(
        `日历命中检查失败 (维度 "${dim.dimensionKey}" source "${dim.calendarSource}"): ${String(err)} — 按未命中`,
      );
      return false;
    }
  }
}
