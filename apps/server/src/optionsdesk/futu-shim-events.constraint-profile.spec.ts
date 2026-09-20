import { describe, it, expect } from 'vitest';
import { VendorRateLimiter, type RateLimit } from '../marketdata/vendor-rate-limiter';
import { PUSH_EVENT_POLL_SECONDS } from './broker-account.scheduler';
import { FUTU_SHIM_EVENTS_PROFILE } from './futu-shim-events.constraint-profile';
import { FUTU_SHIM_TRADE_PROFILE } from './futu-shim-trade.constraint-profile';

/**
 * 推送事件面限频画像回归测试 (issue #469; Small —— 纯函数 + 虚拟时钟, 不打网、不起容器)。
 *
 * 钉的不是「常量等于某个数」, 而是**节奏与限额的关系**: 事件轮询按设计节奏跑时 MUST NOT 被
 * 自家限频器排队。084 上线时 `/trade/events` 与交易查询共用 `FUTU_SHIM_TRADE_PROFILE` 的
 * 10 次/30 秒桶, 而该桶是券商对五个查询接口的硬限, 事件端点读的是 shim 进程内存、一发不打
 * 券商 ⇒ 2 秒一拍 = 15 发/30 秒必然超限, 表现为每 30 秒排队 10 秒且**无任何错误留痕**。
 *
 * 判别力: 臂②用**修复前的**画像跑同一节奏, 必须复现出那个形态 —— 否则本文件测不出回归。
 */

/**
 * 按固定节拍驱动真实限频器, 回每拍的等待。`waitForCompletion` 语义: 下一拍 = 严格大于当前
 * 时刻的最近节拍边界。`callsPerTick` = 一拍内串行打几发 —— 心跳按连接逐个拉事件
 * (`broker-account.scheduler.ts:183`), 而限频器是 adapter 级单例, 故它等于连接数。
 */
async function simulate(limit: RateLimit, cadenceMs: number, ticks: number, callsPerTick = 1) {
  let t = 0;
  const limiter = new VendorRateLimiter(
    limit,
    () => t,
    async (ms) => {
      t += ms;
    },
  );
  const waits: number[] = [];
  const slowStarts: number[] = [];
  for (let i = 0; i < ticks; i += 1) {
    t = Math.ceil((t + 1) / cadenceMs) * cadenceMs;
    const startedAt = t;
    for (let c = 0; c < callsPerTick; c += 1) await limiter.acquire();
    const waited = t - startedAt;
    waits.push(waited);
    if (waited > 0) slowStarts.push(startedAt);
  }
  return { waits, slowStarts };
}

const CADENCE_MS = PUSH_EVENT_POLL_SECONDS * 1_000;
/** 600 拍 ≈ 半小时真实节奏, 足够跨十余个 30 秒窗口, 稳态形态已完全展开。 */
const TICKS = 600;

describe('FUTU_SHIM_EVENTS_PROFILE —— 事件轮询不被自家限频器排队 (#469)', () => {
  it('① 事件面画像 + 2 秒节拍 ⇒ 零排队', async () => {
    const { waits } = await simulate(FUTU_SHIM_EVENTS_PROFILE.rateLimit, CADENCE_MS, TICKS);
    expect(Math.max(...waits)).toBe(0);
  });

  it('①b 连接数长到 10 个仍零排队 —— 护栏 MUST NOT 随连接数增长悄悄咬回来', async () => {
    // 心跳逐连接各打一发 (`broker-account.scheduler.ts:183`), 限频器却是 adapter 级单例 ⇒
    // 实际发数 = 连接数 × 15 发/30 秒。这条钉的就是那个线性关系, 不是某个具体常量。
    const { waits } = await simulate(FUTU_SHIM_EVENTS_PROFILE.rateLimit, CADENCE_MS, TICKS, 10);
    expect(Math.max(...waits)).toBe(0);
  });

  it('② 判别力臂: 交易面画像跑同一节奏 ⇒ 复现 #469 的形态 (每 30 秒排队 10 秒)', async () => {
    const { waits, slowStarts } = await simulate(
      FUTU_SHIM_TRADE_PROFILE.rateLimit,
      CADENCE_MS,
      TICKS,
    );
    // 单次等待恒 10 000 ms —— prod 观测 10 076–10 288 ms, 差值是 HTTP 往返与处理开销。
    expect(Math.max(...waits)).toBe(10_000);
    // 慢拍周期恒 30 000 ms（= 滚动窗跨度），唯一值。prod 观测同为 30 秒、相位稳定。
    const periods = new Set(slowStarts.slice(1).map((s, i) => s - slowStarts[i]!));
    expect([...periods]).toEqual([30_000]);
    // 慢拍占比落在 prod 观测的 10.2% 附近。
    const slowShare = slowStarts.length / waits.length;
    expect(slowShare).toBeGreaterThan(0.09);
    expect(slowShare).toBeLessThan(0.11);
  });

  it('③ 两个画像的 vendor 标签互不相同 —— 日志与熔断态可分辨', () => {
    expect(FUTU_SHIM_EVENTS_PROFILE.vendor).not.toBe(FUTU_SHIM_TRADE_PROFILE.vendor);
  });

  it('④ 交易面画像的券商硬限未被放宽 —— 本次拆桶 MUST NOT 顺手动它', () => {
    expect(FUTU_SHIM_TRADE_PROFILE.rateLimit).toEqual({ maxCalls: 10, windowMs: 30_000 });
  });
});
