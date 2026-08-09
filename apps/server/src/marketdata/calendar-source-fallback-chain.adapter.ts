import { Injectable, Logger } from '@nestjs/common';
import type {
  TradingCalendarFetchResult,
  TradingCalendarSource,
} from './trading-calendar-source.port.js';

const DAY_MS = 86_400_000;

/**
 * 合理性闸下界比例 (044 T010): 窗内交易日数 < `ceil(工作日数 × MIN_RATIO)` → 判该节点失败。
 *
 * ★ **PoC 实测校准, 非估算** (30 天窗 → 工作日 ~21.4 → 下界 ~9):
 *
 * | 场景 (30 天窗) | 实测交易日数 | vs 下界 ~9 |
 * | --- | --- | --- |
 * | 常规窗 2026-06-16..07-16 (hk) | **20** | 宽裕通过 |
 * | **春节窗** 2026-02-01..03-02 (cn, 春节 2/17) | **15** | 通过, margin 6 |
 * | 春节窗 同区间 (hk) | **18** | 通过 |
 * | 毒饵形态 (push2delay 类) | **0** | **拦下** |
 *
 * 初稿估「春节最坏 ~13」, 实测 **15** —— **保守优先**: 宁可漏判一个「轻微少报」的坏源, 不可
 * 误判长假为故障 (误报训练出「狼来了」, 比漏报更毁告警可信度)。**别自行调参**。
 */
const MIN_RATIO = 0.4;

/**
 * 🚨 **短窗豁免下界 (自然日)**: 窗口 < 14 天 → **跳过闸**。工作日基数太小时 `×0.4` 退化到 0/1,
 * 闸**无判别力** (如 5 天窗 → 工作日 5 → 下界 2, 拦不住任何真毒饵却可能误伤含假期的短窗)。
 *
 * **这是已知且有意的局限**: 日常 populate 恒 30 天窗 ⇒ **恒受闸保护**; 只有 seed CLI 的窄区间
 * 落入豁免区, 而 seed 是人工触发、结果当场可见 —— 不是静默失败的温床。
 */
const GATE_MIN_WINDOW_DAYS = 14;

const parseUtcDay = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/** 闭区间 [from, to] 的自然日数 (含首尾)。非法日期 → NaN (由调用方兜底)。 */
const naturalDays = (from: string, to: string): number =>
  (parseUtcDay(to) - parseUtcDay(from)) / DAY_MS + 1;

/**
 * 闭区间 [from, to] 内的工作日 (周一~周五) 数 —— 闸的基数。**不含节假日修正** (那正是要向
 * vendor 求证的东西), 故只作**下界**的基数、配 `MIN_RATIO` 大幅打折使用。
 * 复杂度 O(窗口自然日数) —— 最宽的 seed CLI 10yr 窗也仅 ~3650 次迭代。
 */
function countWeekdays(from: string, to: string): number {
  const end = parseUtcDay(to);
  let count = 0;
  for (let ms = parseUtcDay(from); ms <= end; ms += DAY_MS) {
    const weekday = new Date(ms).getUTCDay();
    if (weekday >= 1 && weekday <= 5) count++;
  }
  return count;
}

/**
 * 交易日历源 fallback 链 (044 T007, TRADING_CALENDAR_SOURCE live 绑定)。包裹有序节点
 * `[primary, ...secondaries]` (V1 = `[腾讯 L1, 静态离线 L2]`)。**换源治不了根 —— 链路 + 闸 +
 * 告警才治**: 东财日历源被定向下线后同步静默停摆 2 天, 根因不是「源挂了」而是「单点 + 无降级
 * + 无告警」。
 *
 * 单次 `fetchTradingDates(market, from, to)` 调用内按序尝试:
 *   - 节点**成功且过闸** → 短路返回其 `{dates, servedBy}` (**原样透传**, 见下), 不打后续节点
 *   - 节点**抛错** (vendor 故障 / 熔断 open / 静态表区间外) → WARN 打点, 平移下一节点
 *   - 节点**成功但不合理** (合理性闸, 见下) → **同样判该节点失败** → WARN 打点, 平移下一节点
 *   - **全链耗尽** → **throw** (禁静默返空 —— 返空 = 日历漏填且无人知晓 = 再造一个毒饵)
 *
 * 🚨 **`servedBy` 原样透传 = FR-014 降级可观测的传递环**: 链**不自报家门** (禁
 * `servedBy:'chain'`), 必须透传**胜出节点**自报的 `'tencent'` / `'static'` —— 心跳
 * (`calendar_sync_health.served_by`, T012) 落的就是这个值, 探针 (T014) 据其判「是否降级运行」
 * 并告警。链上截断这个值 → 降级告警链直接断掉。**降级 ≠ 健康**: L2 接住时填充虽成功, 但已
 * 失去冗余, 属需人工介入态。**探针比对的是「该市场自己的主源」** —— 本链被复用于两条不同
 * 组成的链 (cn/hk 的 L2 = 静态年历, 能力有限: 仅当年; us 的 L2 = 腾讯, 且 us 蓄意无 L3),
 * 接线见 `marketdata.module.ts` 的 `TRADING_CALENDAR_SOURCE`。
 *
 * 🔑 **合理性闸 (T010) 放在链上, 不在各 adapter** (刻意): 单点实现、对所有节点**一把尺**; 且
 * 「这个节点的答案可不可信」本就是链的判断职责 —— 下沉到 adapter 会各自为政且无从对比。判据
 * 见 {@link MIN_RATIO} / 短窗豁免见 {@link GATE_MIN_WINDOW_DAYS}。
 *
 * ⚠️ **闸的已知边界, 别误解成「有闸就够了」**: 闸**拦不住中度截断** (腾讯 `limit=10` → 返 10 天
 * ≥ 30 天窗下界 10 → **放行**, 然后写入残缺日历)。**截断已由 L1 的分片构造消除** (每片
 * `limit = 片内自然日数`, 由构造保证永不截断, T004), **闸只兜底 0/1/2 级的粗暴毒饵**。
 * **两者不可互相替代** —— 别为了让闸够得着截断而调阈值, 那只会换来长假误报。
 *
 * **per-market 独立**: 本链在单次调用内工作、无跨市场状态 —— per-market 隔离由调用方
 * `TradingCalendarSyncService.syncRange` 逐市场调用**天然保证** (一市场全链失败不拖垮其余)。
 *
 * ⚠️ **为何不复用既有 `FallbackChainAdapter` / `UniverseFallbackChainAdapter`** (刻意, 非疏忽):
 * 二者的降级判据是「抛错 或 **返空**」且整链耗尽**返空不抛** —— 对搜索/枚举合适 (无候选是业务
 * 常态), 对日历**致命**: 日历的「空」既可能是「区间确无交易日」(合法) 也可能是毒饵, 且整链
 * 耗尽返空正是本 feature 要消灭的静默失败。本链只照抄其**结构 / 命名 / `falling through` WARN
 * 范式**, 逻辑独立 (plan Decision 4)。
 */
@Injectable()
export class CalendarSourceFallbackChain implements TradingCalendarSource {
  private readonly logger = new Logger(CalendarSourceFallbackChain.name);

  constructor(private readonly nodes: TradingCalendarSource[]) {}

  /**
   * 按序尝试各节点, 首个**成功且过闸**者短路返回 (结果原样透传)。全链耗尽 → throw (含各节点
   * 失败明细)。复杂度 O(节点数) 次 vendor 调用 (主源健康时恒 1 次) + 每次 O(窗口自然日数) 过闸。
   */
  async fetchTradingDates(
    market: string,
    from: string,
    to: string,
  ): Promise<TradingCalendarFetchResult> {
    const failures: string[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      let reason: string;
      try {
        const result = await this.nodes[i].fetchTradingDates(market, from, to);
        const insane = this.sanityFailure(from, to, result.dates);
        // 🚨 原样返回胜出节点的 `{dates, servedBy}` —— 禁在此改写 servedBy (FR-014 传递环)。
        if (insane === null) return result;
        // 🚨 「成功但不合理」与「抛错」**同等对待** = 判该节点失败 → 降级, 且**不写库**。
        reason = `合理性闸判失败 (servedBy=${result.servedBy}): ${insane}`;
      } catch (err) {
        // 节点故障 → 平移下一节点; 末节点也故障则循环结束 → 下方 throw。
        reason = err instanceof Error ? err.message : String(err);
      }
      failures.push(`#${i}: ${reason}`);
      this.logger.warn(
        `[calendar] market=${market} ${from}..${to} node #${i} failed, falling through: ${reason}`,
      );
    }
    // 🚨 全链耗尽 → **显式失败**, 禁静默返空: 返空会被 syncRange 当成「区间无交易日」写下 0 行,
    // 日历就此陈旧且无人知晓 —— 正是 044 事故根因。抛出后由 T012 记 `lastError` + 心跳不更新
    // → 探针告警。
    throw new Error(
      `[calendar] market=${market} ${from}..${to} 全 ${this.nodes.length} 源均未产出可信日历 ` +
        `(取数失败 / 未过合理性闸; 本次填充显式失败, 禁静默返空)` +
        (failures.length > 0 ? `; 失败明细: ${failures.join(' | ')}` : ''),
    );
  }

  /**
   * 合理性闸: 「200 + 空/稀薄数组」这类**不抛错的毒饵**判定 (044 事故形态)。
   *
   * @returns 不合理 → 人读原因 (进 WARN + 全链失败明细); 合理 / 短窗豁免 / 日期非法 → `null`
   */
  private sanityFailure(from: string, to: string, dates: string[]): string | null {
    const windowDays = naturalDays(from, to);
    // 短窗 (含日期非法 → NaN) → 豁免: 闸此时无判别力, 强判只会误伤 (见 GATE_MIN_WINDOW_DAYS)。
    if (!Number.isFinite(windowDays) || windowDays < GATE_MIN_WINDOW_DAYS) return null;

    const weekdays = countWeekdays(from, to);
    const lowerBound = Math.ceil(weekdays * MIN_RATIO);
    if (dates.length >= lowerBound) return null;
    return `窗内交易日数 ${dates.length} < 下界 ${lowerBound} (工作日 ${weekdays} × ${MIN_RATIO})`;
  }
}
