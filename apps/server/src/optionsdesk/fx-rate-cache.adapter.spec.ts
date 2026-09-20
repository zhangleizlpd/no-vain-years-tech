import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { FX_PAIRS, type FxPair, type FxRate, type FxRatePort } from './fx-rate.port';
import { FX_RATE_CACHE_TTL_MS, FxRateCacheAdapter } from './fx-rate-cache.adapter';

/**
 * 085 T003 FX 取值缓存装饰器单测 (Small: 内层是 port 级 test double, 零外部依赖)。
 *
 * 🚨 判据是**对内层 port 的调用次数**, 不是「返回值对不对」—— 缓存坏掉时返回值照样对, 只是
 * 每一发都打了 vendor (plan D4 要防的正是这一面)。
 *
 * 🚨 夹具汇率一律**合成值**, 逐个避开 `0.8` / `0.6` / `1.2` ——
 * `scripts/checks/check-optionsdesk-rule-constants.ts` 不变量 #1 的扫描面含 `*.spec.ts`。
 */

/** 一批合成汇率 (三对共享同一个 `capturedAt`, 与真 adapter 同口径)。 */
function ratesAt(capturedAt: Date, marker = '7.1500'): FxRate[] {
  return FX_PAIRS.map((pair) => ({ pair, rate: new Prisma.Decimal(marker), capturedAt }));
}

/** 按 `pair` 取 —— 顺序随 vendor 响应, **不按位置索引** (T002 口径)。 */
function rateOf(rates: readonly FxRate[], pair: FxPair): FxRate {
  const found = rates.find((r) => r.pair === pair);
  if (found === undefined) throw new Error(`夹具缺 ${pair}`);
  return found;
}

/** 可控时钟 —— 同 `FutuMarketStateAdapter` 单测的注入范式，🚫 不用 fake timers（这里没有定时器）。 */
function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** 内层 port: 每发按**当前时钟**产出 `capturedAt` (与真 adapter 的可注入 `now` 同形)。 */
function makeInner(clock: { now: () => number }) {
  const fetchRates = vi.fn(async (): Promise<readonly FxRate[]> => ratesAt(new Date(clock.now())));
  return { port: { fetchRates } satisfies FxRatePort, fetchRates };
}

/** 固定失败的内层 port。 */
function makeFailingInner(message: string) {
  const fetchRates = vi.fn(async (): Promise<readonly FxRate[]> => {
    throw new Error(message);
  });
  return { port: { fetchRates } satisfies FxRatePort, fetchRates };
}

/** 可手动放行的内层 port —— 用来制造「第一发还在途中, 第二发就来了」。 */
function makeDeferredInner() {
  const pending: {
    resolve: (rates: readonly FxRate[]) => void;
    reject: (err: unknown) => void;
  }[] = [];
  const fetchRates = vi.fn(
    (): Promise<readonly FxRate[]> =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  return {
    port: { fetchRates } satisfies FxRatePort,
    fetchRates,
    // 🚨 放行 / 拒**全部**在途项, 而非只放最后一发: single-flight 正常时 `pending` 恒只有一项,
    // 两者等价; 而 single-flight 被拿掉时, 「只放最后一发」会让其余调用方**挂住** ⇒ 那条臂红在
    // 15 秒超时上, 读起来像基建卡死而不是「内层被打了 4 次」。全放行才能让它红在判据本身。
    settleAll: (rates: readonly FxRate[]) => pending.forEach((p) => p.resolve(rates)),
    rejectAll: (err: unknown) => pending.forEach((p) => p.reject(err)),
  };
}

/** 把微任务队列抽干 —— 用来证明「在途这一刻调用方那一发确实还没落地」。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('FxRateCacheAdapter · 单格 TTL 缓存', () => {
  it('① 第一发打内层, TTL 内的第二发零外呼', async () => {
    const clock = makeClock();
    const inner = makeInner(clock);
    const adapter = new FxRateCacheAdapter(inner.port, clock.now);

    const first = await adapter.fetchRates();
    clock.advance(FX_RATE_CACHE_TTL_MS - 1);
    const second = await adapter.fetchRates();

    expect(inner.fetchRates).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('② TTL 过期后再打 (🚨 反例: 缓存恒不过期 ⇒ 汇率永远停在进程启动那一刻)', async () => {
    const clock = makeClock();
    const inner = makeInner(clock);
    const adapter = new FxRateCacheAdapter(inner.port, clock.now);

    await adapter.fetchRates();
    clock.advance(FX_RATE_CACHE_TTL_MS);
    await adapter.fetchRates();

    expect(inner.fetchRates).toHaveBeenCalledTimes(2);
  });

  it('⑤ 命中缓存时 `capturedAt` 恒为**首次采集**时刻, 不随读取移动', async () => {
    const clock = makeClock();
    const inner = makeInner(clock);
    const adapter = new FxRateCacheAdapter(inner.port, clock.now);

    const capturedInstant = clock.now();
    await adapter.fetchRates();
    clock.advance(FX_RATE_CACHE_TTL_MS - 1);
    const second = await adapter.fetchRates();

    // 🚨 断到**等于注入时钟的首次采集时刻**这一点上: 只断「两次相同」的话, 「每次读取都重写成
    // 当前时刻」的实现在同一毫秒内照样相同 ⇒ 那条臂对它没有鉴别力。
    expect(rateOf(second, 'USDCNY').capturedAt.getTime()).toBe(capturedInstant);
    expect(rateOf(second, 'USDCNY').capturedAt.getTime()).not.toBe(clock.now());
    // 三对共享同一个采集时刻 (一发取全三对), 按 pair 取而非按位置。
    for (const pair of FX_PAIRS) {
      expect(rateOf(second, pair).capturedAt.getTime()).toBe(capturedInstant);
    }
  });
});

describe('FxRateCacheAdapter · single-flight 与失败语义', () => {
  it('④ 🚨 single-flight: 冷缓存下并发 4 发 ⇒ 内层**恰打 1 次**, 四个调用方拿到同一份', async () => {
    const inner = makeDeferredInner();
    const adapter = new FxRateCacheAdapter(inner.port, makeClock().now);

    // 🚨 四发全部在第一发落定**之前**发出 —— 纯 TTL 缓存在这一格不设防 (都还没写进缓存)。
    const concurrent = Array.from({ length: 4 }, () => adapter.fetchRates());
    await flushMicrotasks();
    inner.settleAll(ratesAt(new Date(1_700_000_000_000), '2.5000'));
    const results = await Promise.all(concurrent);

    expect(inner.fetchRates).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r).toBe(results[0]);
  });

  it('③ 🚨 失败不入缓存: 抛了之后下一发立刻真打 (否则一次抖动把降级态钉死整个 TTL)', async () => {
    const clock = makeClock();
    const inner = makeFailingInner('all fx rate sources failed');
    const adapter = new FxRateCacheAdapter(inner.port, clock.now);

    // 🚨 两发之间**不推进时钟** —— 第二发落在同一个 TTL 窗内, 缓存了失败的实现在这里只会打 1 次。
    await expect(adapter.fetchRates()).rejects.toThrow(/all fx rate sources failed/);
    await expect(adapter.fetchRates()).rejects.toThrow(/all fx rate sources failed/);

    expect(inner.fetchRates).toHaveBeenCalledTimes(2);
  });

  it('③b 失败之后恢复 ⇒ 下一发拿到真值 (降级态不被缓存粘住)', async () => {
    const clock = makeClock();
    const failing = makeFailingInner('vendor 403');
    const healthy = makeInner(clock);
    let healed = false;
    const adapter = new FxRateCacheAdapter(
      {
        fetchRates: () => (healed ? healthy.port.fetchRates() : failing.port.fetchRates()),
      },
      clock.now,
    );

    await expect(adapter.fetchRates()).rejects.toThrow(/vendor 403/);
    healed = true;
    const rates = await adapter.fetchRates();

    expect(rateOf(rates, 'HKDCNY').rate.toString()).toBe('7.15');
  });

  it('⑥ 取数在途 ⇒ 调用方那一发仍悬着: 「加载中」与「已失败」在调用方可分 (branch 18 前置)', async () => {
    const inner = makeDeferredInner();
    const adapter = new FxRateCacheAdapter(inner.port, makeClock().now);

    let outcome: 'resolved' | 'rejected' | null = null;
    const call = adapter.fetchRates().then(
      () => {
        outcome = 'resolved';
      },
      () => {
        outcome = 'rejected';
      },
    );

    await flushMicrotasks();
    // 在途这一刻: 既没解析成值 (会被读成「汇率到手」), 也没拒 (会被读成「已失败」) ⇒ 加载中。
    expect(outcome).toBeNull();

    inner.rejectAll(new Error('vendor down'));
    await call;
    expect(outcome).toBe('rejected');
  });

  it('⑥b 并发在途时失败 ⇒ 每个等待者都收到错误 (🚫 不许有人拿到空数组当成「汇率是空的」)', async () => {
    const inner = makeDeferredInner();
    const adapter = new FxRateCacheAdapter(inner.port, makeClock().now);

    const waiters = Array.from({ length: 3 }, () => adapter.fetchRates());
    // 🚨 先挂上 catch 再 reject —— 否则 Node 会把尚未被 await 的那两个记成 unhandled rejection。
    const settled = waiters.map((p) =>
      p.then(() => 'resolved' as const).catch(() => 'rejected' as const),
    );
    inner.rejectAll(new Error('vendor down'));

    expect(await Promise.all(settled)).toEqual(['rejected', 'rejected', 'rejected']);
  });
});
