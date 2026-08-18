import { Injectable } from '@nestjs/common';
import type {
  TradingCalendarFetchResult,
  TradingCalendarSource,
} from './trading-calendar-source.port.js';

/**
 * 按市场路由的日历源 (sellput-viz Phase 1 #5)。`TRADING_CALENDAR_SOURCE` 只有一个绑定, 而
 * `TradingCalendarSyncService.syncRange` 逐市场调用 —— 故「不同市场用不同 fallback 链」这件事
 * 必须由一层路由承担。
 *
 * V1 路由 (见 `marketdata.module.ts` 接线):
 * - `us` → `[富途 L1, 腾讯 L2]`
 * - `cn` / `hk` → `[腾讯 L1, 静态离线 L2]`
 *
 * 🚨 **为什么不是「一条链 `[富途, 腾讯, 静态]` 打全部市场」** (刻意, 非疏忽): 富途只承担 us,
 * 对 cn/hk 会抛「不支持市场」→ 链每日为 cn/hk 各打一条
 * `node #0 failed, falling through` WARN。两个后果都很实在:
 * 1. **告警疲劳** —— 每天 2 条恒定的假失败, 训练出「这条 WARN 可以忽略」, 真降级也被一起忽略;
 * 2. **主源语义被搅浑** —— 探针判「是否降级运行」靠 `served_by` 比对**该市场的主源**
 *    (cn/hk=`tencent` / us=`futu`)。把不服务某市场的节点排在链首, 「链首=主源」这个读法就不再成立。
 *
 * 🚨 **无默认路由 = 刻意 fail-closed**: 未登记的市场直接 throw, 而不是悄悄落到某条链上。
 * 静态层只覆盖 cn/hk, 「默认落 cn/hk 链」会让新市场静默地只剩腾讯单源 —— 正是本 feature 在
 * 消灭的形状。加市场时必须回到接线处显式决定它的源与兜底。
 *
 * 本类**无状态、无 IO**: per-market 隔离由 `syncRange` 逐市场调用天然保证 (一市场全链失败
 * 不拖垮其余), 路由只是选链。
 */
@Injectable()
export class MarketRoutedCalendarSource implements TradingCalendarSource {
  constructor(private readonly routes: Readonly<Record<string, TradingCalendarSource>>) {}

  /** 复杂度 O(1) 选链 + 被选链自身的开销。未登记市场 → throw (见类注释 fail-closed)。 */
  async fetchTradingDates(
    market: string,
    from: string,
    to: string,
  ): Promise<TradingCalendarFetchResult> {
    const route = this.routes[market];
    if (!route) {
      throw new Error(
        `[calendar] 市场 "${market}" 未登记日历源路由 ` +
          `(已登记: ${Object.keys(this.routes).join('/') || '无'}; ` +
          `加市场须在 marketdata.module.ts 显式指定其源与兜底, 禁默认落链)`,
      );
    }
    return route.fetchTradingDates(market, from, to);
  }
}

/**
 * **前瞻路由**工厂 (062 T003, plan §D4)。同一个 {@link MarketRoutedCalendarSource} 类的
 * **第二个实例** —— 差别只在 routes map, 故 fail-closed / 原样透传 / per-market 隔离三条语义
 * 全部原样继承, **零新抽象**。
 *
 * 与 `TRADING_CALENDAR_SOURCE` (历史段) 的分工: 历史段问的是 `[今天-30, 今天]` (**永远是过去**),
 * 走活源链; 前瞻段问的是 `[明天, 当年 12-31]` (**永远是未来**), 只能走**权威年历**。两条路径
 * 互为交叉校验 (FR-009), 且一段失败 MUST NOT 让另一段的覆盖声明失真。
 *
 * 🚨 **腾讯 MUST NOT 进本路由** (Impl Guardrail 5, plan §D4): 它是「某指数当日有 bar ⟺ 当日
 * 开市」的**反推**源 —— 未来的 bar 不存在, 结构上答不了。把它排进链首只会让 cn/hk 每天各多
 * 一条恒定的假失败 WARN, 044 已论证过这种告警疲劳的代价 (且会把「链首 = 该市场主源」这个
 * 探针读法搅浑)。
 *
 * 🚨 **us 只有富途一层, cn/hk 只有静态一层 —— 蓄意无兜底**: 前瞻段整段失败的后果是「视野不
 * 前进」, 由 T011 的视野探针接住; 而**给前瞻段配一个答不了未来的兜底**才是真正的毒饵 (它会
 * 让缺失日被当成非交易日落库)。静态层在年末整段 `throw` (其 Guardrail 7) 同理是设计不是 bug。
 */
export function createForwardCalendarSource(
  futu: TradingCalendarSource,
  staticCalendar: TradingCalendarSource,
): MarketRoutedCalendarSource {
  return new MarketRoutedCalendarSource({ cn: staticCalendar, hk: staticCalendar, us: futu });
}
