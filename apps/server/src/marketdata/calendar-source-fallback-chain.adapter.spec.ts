import { describe, it, expect, vi } from 'vitest';
import { CalendarSourceFallbackChain } from './calendar-source-fallback-chain.adapter.js';
import type { TradingCalendarSource } from './trading-calendar-source.port.js';

/**
 * 日历源 fallback 链纯逻辑: **节点选择** (044 T007 — 主源成功短路 / 抛错平移 / 全链失败显式抛 /
 * 胜出节点的 `servedBy` 原样透传) + **合理性闸** (044 T010 — 成功但空 / 成功但不合理 → 判该节点
 * 失败降级)。
 */
function node(
  impl: (
    market: string,
    from: string,
    to: string,
  ) => Promise<{ dates: string[]; servedBy: string }>,
): TradingCalendarSource {
  return { fetchTradingDates: vi.fn(impl) };
}

/**
 * 生成 n 个连续占位交易日。闸只**数个数**、不校验日期落点 ⇒ 内容无关, 个数才是断言面。
 */
const nDates = (n: number, start = '2026-06-16'): string[] =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
  );

/** 日常 populate 恒 30 天窗 (自然日 31 / 工作日 23 → 闸下界 `ceil(23 × 0.4)` = **10**)。 */
const RANGE = ['cn', '2026-06-16', '2026-07-16'] as const;

/**
 * 春节窗 (自然日 30 / 工作日 21 → 闸下界 `ceil(21 × 0.4)` = **9**)。**闸最危险的误报区** ——
 * PoC 实测该窗 cn 真实交易日 **15** 个 (初稿估「最坏 ~13」偏悲观), margin 6。
 */
const SPRING_RANGE = ['cn', '2026-02-01', '2026-03-02'] as const;

/** 短窗 (自然日 5 < 14) = seed CLI 窄区间形态 → **闸豁免** (工作日基数太小, ×0.4 无判别力)。 */
const SHORT_RANGE = ['cn', '2026-07-06', '2026-07-10'] as const;

/** 合理的 L1 / L2 日历 (30 天窗内 20 / 18 个交易日, PoC 实测常规值 → 稳过闸)。 */
const L1_DATES = nDates(20);
const L2_DATES = nDates(18);

describe('CalendarSourceFallbackChain', () => {
  it('L1 成功 → 短路返回其结果, **不调 L2** (主源健康时备源零打扰)', async () => {
    const l1 = node(async () => ({ dates: L1_DATES, servedBy: 'tencent' }));
    const l2 = node(async () => ({ dates: L2_DATES, servedBy: 'static' }));
    const chain = new CalendarSourceFallbackChain([l1, l2]);

    expect(await chain.fetchTradingDates(...RANGE)).toEqual({
      dates: L1_DATES,
      servedBy: 'tencent',
    });
    expect(l2.fetchTradingDates).not.toHaveBeenCalled();
  });

  it('L1 成功 → 入参 (market/from/to) 原样透传给节点', async () => {
    const l1 = node(async () => ({ dates: L1_DATES, servedBy: 'tencent' }));
    const chain = new CalendarSourceFallbackChain([l1]);

    await chain.fetchTradingDates(...RANGE);

    expect(l1.fetchTradingDates).toHaveBeenCalledWith('cn', '2026-06-16', '2026-07-16');
  });

  it('L1 抛错 → 降级 L2, 返回 L2 结果', async () => {
    const l1 = node(async () => {
      throw new Error('vendor 503');
    });
    const l2 = node(async () => ({ dates: L2_DATES, servedBy: 'static' }));
    const chain = new CalendarSourceFallbackChain([l1, l2]);

    expect(await chain.fetchTradingDates(...RANGE)).toEqual({
      dates: L2_DATES,
      servedBy: 'static',
    });
    expect(l2.fetchTradingDates).toHaveBeenCalledOnce();
  });

  it('🚨 降级时 `servedBy` = **胜出节点自报的家门** (非 "chain") — FR-014 传递环', async () => {
    const l1 = node(async () => {
      throw new Error('vendor down');
    });
    const l2 = node(async () => ({ dates: L2_DATES, servedBy: 'static' }));
    const chain = new CalendarSourceFallbackChain([l1, l2]);

    const { servedBy } = await chain.fetchTradingDates(...RANGE);
    // 链**不得**自报家门 — 心跳落 servedBy='static' 才能被探针判「降级运行」并告警。
    expect(servedBy).toBe('static');
    expect(servedBy).not.toBe('chain');
  });

  it('L1 抛错 + L2 返空数组 (**短窗, 闸豁免**) → 空是合法结果, 原样返回 (区间确无交易日)', async () => {
    const l1 = node(async () => {
      throw new Error('vendor down');
    });
    const l2 = node(async () => ({ dates: [], servedBy: 'static' }));
    const chain = new CalendarSourceFallbackChain([l1, l2]);

    expect(await chain.fetchTradingDates(...SHORT_RANGE)).toEqual({
      dates: [],
      servedBy: 'static',
    });
  });

  it('🚨 全链抛错 → **显式 throw** (禁静默返空: 返空 = 日历漏填且无人知晓)', async () => {
    const l1 = node(async () => {
      throw new Error('tencent 503');
    });
    const l2 = node(async () => {
      throw new Error('static 区间外');
    });
    const chain = new CalendarSourceFallbackChain([l1, l2]);

    await expect(chain.fetchTradingDates(...RANGE)).rejects.toThrow(/全 2 源/);
  });

  it('全链失败的错误消息含各节点失败明细 (排障面: 哪层因何而挂)', async () => {
    const chain = new CalendarSourceFallbackChain([
      node(async () => {
        throw new Error('tencent 503');
      }),
      node(async () => {
        throw new Error('static 区间外');
      }),
    ]);

    await expect(chain.fetchTradingDates(...RANGE)).rejects.toThrow(/tencent 503.*static 区间外/s);
  });

  it('单节点链: 成功 → 原样返回', async () => {
    const chain = new CalendarSourceFallbackChain([
      node(async () => ({ dates: L1_DATES, servedBy: 'mock' })),
    ]);

    expect(await chain.fetchTradingDates(...RANGE)).toEqual({
      dates: L1_DATES,
      servedBy: 'mock',
    });
  });

  it('单节点链: 抛错 → 抛 (无处可降级)', async () => {
    const chain = new CalendarSourceFallbackChain([
      node(async () => {
        throw new Error('boom');
      }),
    ]);

    await expect(chain.fetchTradingDates(...RANGE)).rejects.toThrow(/全 1 源/);
  });

  it('空链 → 抛 (装配错误须响亮, 禁静默返空)', async () => {
    const chain = new CalendarSourceFallbackChain([]);

    await expect(chain.fetchTradingDates(...RANGE)).rejects.toThrow(/全 0 源/);
  });

  it('per-market 隔离: 链在单次调用内工作 — hk 全链失败不影响 cn 的独立调用', async () => {
    // 链本身无跨市场状态 (per-market 隔离由调用方 syncRange 逐市场调用天然保证)。
    const l1 = node(async (market) => {
      if (market === 'hk') throw new Error('hk down');
      return { dates: L1_DATES, servedBy: 'tencent' };
    });
    const l2 = node(async (market) => {
      if (market === 'hk') throw new Error('hk 区间外');
      return { dates: L2_DATES, servedBy: 'static' };
    });
    const chain = new CalendarSourceFallbackChain([l1, l2]);

    await expect(chain.fetchTradingDates('hk', '2026-06-16', '2026-07-16')).rejects.toThrow();
    // 同一链实例, cn 调用不受 hk 那次全链失败污染。
    expect(await chain.fetchTradingDates('cn', '2026-06-16', '2026-07-16')).toEqual({
      dates: L1_DATES,
      servedBy: 'tencent',
    });
  });

  /**
   * 044 T010 合理性闸: 「200 + 空/稀薄数组」是本 feature 要消灭的**静默毒饵** —— 旧东财源被
   * 定向下线后正是以此形态回应 (`push2delay` 类), 链只认 throw ⇒ 降不了级 ⇒ 空日历静默落库。
   */
  describe('合理性闸 (T010): 成功但不合理 → 判该节点失败降级', () => {
    it('🚨 L1 返**空数组** (push2delay 毒饵形态) → 判 L1 失败 → 降级 L2', async () => {
      const l1 = node(async () => ({ dates: [], servedBy: 'tencent' }));
      const l2 = node(async () => ({ dates: L2_DATES, servedBy: 'static' }));
      const chain = new CalendarSourceFallbackChain([l1, l2]);

      // 「200 + 空数组」HTTP 层无异常 → 只认 throw 的链会当成「区间确无交易日」原样写库。
      expect(await chain.fetchTradingDates(...RANGE)).toEqual({
        dates: L2_DATES,
        servedBy: 'static',
      });
      expect(l2.fetchTradingDates).toHaveBeenCalledOnce();
    });

    it('🚨 L1 交易日数**低于下界** (30 天窗返 9 < 10) → 判 L1 失败 → 降级 L2', async () => {
      const l1 = node(async () => ({ dates: nDates(9), servedBy: 'tencent' }));
      const l2 = node(async () => ({ dates: L2_DATES, servedBy: 'static' }));
      const chain = new CalendarSourceFallbackChain([l1, l2]);

      expect(await chain.fetchTradingDates(...RANGE)).toEqual({
        dates: L2_DATES,
        servedBy: 'static',
      });
    });

    it('30 天窗 **20** 个交易日 (PoC 实测常规值) → 放行, 不降级', async () => {
      const l1 = node(async () => ({ dates: nDates(20), servedBy: 'tencent' }));
      const l2 = node(async () => ({ dates: L2_DATES, servedBy: 'static' }));
      const chain = new CalendarSourceFallbackChain([l1, l2]);

      expect((await chain.fetchTradingDates(...RANGE)).servedBy).toBe('tencent');
      expect(l2.fetchTradingDates).not.toHaveBeenCalled();
    });

    it('恰好落在下界 (30 天窗 **10** 个) → 放行 (判据是 `<` 下界才降级, 非 `<=`)', async () => {
      const l1 = node(async () => ({ dates: nDates(10), servedBy: 'tencent' }));
      const chain = new CalendarSourceFallbackChain([l1]);

      expect((await chain.fetchTradingDates(...RANGE)).servedBy).toBe('tencent');
    });

    it('🚨 **春节窗 15 个交易日 → 放行** (PoC 实测, 长假绝不误报成故障)', async () => {
      // 误报比漏报更毁告警可信度 ——「狼来了」之后没人再看告警。下界 9, margin 6。
      const l1 = node(async () => ({ dates: nDates(15, '2026-02-01'), servedBy: 'tencent' }));
      const l2 = node(async () => ({ dates: L2_DATES, servedBy: 'static' }));
      const chain = new CalendarSourceFallbackChain([l1, l2]);

      expect((await chain.fetchTradingDates(...SPRING_RANGE)).servedBy).toBe('tencent');
      expect(l2.fetchTradingDates).not.toHaveBeenCalled();
    });

    it('**短窗豁免** (自然日 5 < 14): 返 1 个交易日也放行 (seed CLI 窄区间不被闸干扰)', async () => {
      const l1 = node(async () => ({ dates: ['2026-07-06'], servedBy: 'tencent' }));
      const l2 = node(async () => ({ dates: L2_DATES, servedBy: 'static' }));
      const chain = new CalendarSourceFallbackChain([l1, l2]);

      expect(await chain.fetchTradingDates(...SHORT_RANGE)).toEqual({
        dates: ['2026-07-06'],
        servedBy: 'tencent',
      });
      expect(l2.fetchTradingDates).not.toHaveBeenCalled();
    });

    it('🚨 **全链皆「成功但不合理」→ 显式 throw** (禁静默返空 —— 空日历落库正是事故本体)', async () => {
      const l1 = node(async () => ({ dates: [], servedBy: 'tencent' }));
      const l2 = node(async () => ({ dates: nDates(2), servedBy: 'static' }));
      const chain = new CalendarSourceFallbackChain([l1, l2]);

      // 全链无 throw、皆 HTTP 200 —— 但一行都不许写库。
      await expect(chain.fetchTradingDates(...RANGE)).rejects.toThrow(/合理性闸/);
      await expect(chain.fetchTradingDates(...RANGE)).rejects.toThrow(/全 2 源/);
    });

    it('全链不合理时错误明细含**各节点交易日数与下界** (排障面: 是源坏了还是闸太严)', async () => {
      const chain = new CalendarSourceFallbackChain([
        node(async () => ({ dates: [], servedBy: 'tencent' })),
        node(async () => ({ dates: nDates(2), servedBy: 'static' })),
      ]);

      await expect(chain.fetchTradingDates(...RANGE)).rejects.toThrow(/tencent.*0 < 下界 10/s);
      await expect(chain.fetchTradingDates(...RANGE)).rejects.toThrow(/static.*2 < 下界 10/s);
    });

    it('闸对**所有节点一致生效**: L1 抛错 + L2 返空 (30 天窗) → 全链失败, 禁把 L2 的空写库', async () => {
      // 闸在链上 = 单点实现、对每个节点同一把尺 (禁下沉到各 adapter 各自为政)。
      const chain = new CalendarSourceFallbackChain([
        node(async () => {
          throw new Error('tencent 503');
        }),
        node(async () => ({ dates: [], servedBy: 'static' })),
      ]);

      await expect(chain.fetchTradingDates(...RANGE)).rejects.toThrow(/合理性闸/);
    });

    it('⚠️ **已知边界**: 闸拦不住中度截断 (limit=10 → 返 10 天 ≥ 下界 10 → 放行)', async () => {
      // 这是**有意的**局限, 不是 bug: 截断由 T004 的分片构造 (每片 limit = 片内自然日数) 消除,
      // 闸只兜底 0/1/2 级粗暴毒饵。**两者不可互相替代** —— 别为了追截断去调阈值 (那会误报长假)。
      const l1 = node(async () => ({ dates: nDates(10), servedBy: 'tencent' }));
      const l2 = node(async () => ({ dates: L2_DATES, servedBy: 'static' }));
      const chain = new CalendarSourceFallbackChain([l1, l2]);

      expect((await chain.fetchTradingDates(...RANGE)).dates).toHaveLength(10);
      expect(l2.fetchTradingDates).not.toHaveBeenCalled();
    });
  });
});
