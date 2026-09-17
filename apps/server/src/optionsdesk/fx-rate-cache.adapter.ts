import { Injectable } from '@nestjs/common';
import type { FxRate, FxRatePort } from './fx-rate.port';

/**
 * 汇率取值缓存的 TTL。
 *
 * **取分钟级的依据**: plan 作者 2026-09-16 的 3.5 分钟 10 轮采样里 `USDCNY` / `HKDCNY` 两对
 * 零变化、`USDHKD` 变 1 次 (EVIDENCE: plan §plan 前验证) ⇒ 秒级刷新拿不到新数字, 只是在替
 * 用户打 vendor。
 *
 * 🚫 **不把 TTL 锚到某个刷新窗** (`marketdata/get-quotes.usecase.ts:22` 把 TTL 算到「下一个
 * EOD」): 那条锚的是**收盘**这个真实事件, 而**外汇 24h 交易 —— 没有下一个刷新窗可锚**。照抄
 * 会得到一个算得出来、却什么都不对齐的过期时刻。⇒ 用固定秒数。
 */
export const FX_RATE_CACHE_TTL_MS = 60_000;

/**
 * 085 T003 FX 取值缓存装饰器 (FR-002 / FR-009, plan D4)。
 *
 * 形态照 `marketdata/futu-market-state.adapter.ts:132-182` —— 进程内**单格** + single-flight +
 * 失败不入缓存。包在 `FxRateFallbackChainAdapter` 外面 (T004 装配)。
 *
 * **一格存三对**: port 蓄意无入参, 一发取全三对 (plan PoC P1) ⇒ 天然单键语义。🚫 Map / LRU /
 * 淘汰策略 —— 单键上那些都是照抄形状, 没有第二个键可淘汰。
 *
 * 🚫 **不加 jitter** (`futu-market-state.adapter.ts:129-130` 同一理由): jitter 防的是「多键同秒
 * 集体过期」, 单键上加它同样只是照抄形状。
 *
 * **进程内而非 Redis**: 单实例部署下两者正确性等价 (plan D4); 60s TTL 下「跨重启存活」无价值,
 * 而 `Prisma.Decimal` 经 Redis 要序列化。绊线: server 变多实例 ⇒ 每实例各自一格 (多打 vendor,
 * 正确性不变), 真要收敛再迁 Redis。
 */
@Injectable()
export class FxRateCacheAdapter implements FxRatePort {
  /** 缓存的那一格。**单键** —— 本 port 只答一个问题 (「此刻三对汇率是多少」), 一个字段就够。 */
  private cached: { rates: readonly FxRate[]; expiresAt: number } | null = null;

  /**
   * 在途的那一发 (**single-flight**)。
   *
   * 🚨 **承重的是这一格, 不是上面的 TTL**: 冷缓存下 N 个并发请求会**同时** miss (谁都还没写进
   * 缓存), 纯 TTL 缓存在那一瞬间完全不设防 ⇒ N 发照样打满 vendor。放行一发、其余等它的结果,
   * 是这个形状的标准解法 (request coalescing)。
   */
  private inFlight: Promise<readonly FxRate[]> | null = null;

  constructor(
    private readonly inner: FxRatePort,
    /** 注入仅为单测可控虚拟时钟 (同 `FutuMarketStateAdapter.now` 的范式); 生产恒 `Date.now`。 */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * 复杂度: 命中缓存 `O(1)` 零外呼; 未命中 **1 发**内层取数 (无论多少并发调用方)。
   *
   * 🚨 **失败不进缓存**: 内层抛时既不写 {@link cached} 也不留 {@link inFlight} (`finally` 清),
   * 下一发立刻真打 —— 缓存住失败会让一次网络抖动把降级态钉死整个 TTL, 而这里的降级是
   * **用户可见**的 (那一屏按原币显示、金额不参与合计)。
   *
   * 🚨 **命中时原样返回首次采集的那批** ⇒ `capturedAt` 恒是**首次采集时刻**, 不随读取移动
   * (plan D5: 那个字段回答的是「这个数字是什么时候采到的」, 重写它就是给旧数字盖新时间戳)。
   */
  async fetchRates(): Promise<readonly FxRate[]> {
    const cached = this.cached;
    if (cached !== null && cached.expiresAt > this.now()) return cached.rates;
    if (this.inFlight !== null) return this.inFlight;

    this.inFlight = this.inner
      .fetchRates()
      .then((rates) => {
        this.cached = { rates, expiresAt: this.now() + FX_RATE_CACHE_TTL_MS };
        return rates;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}
