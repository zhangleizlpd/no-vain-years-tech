import { describe, expect, it } from 'vitest';
import type { MarketdataConfig } from '../config/marketdata.config';
import { FxRateCacheAdapter } from './fx-rate-cache.adapter';
import { createFxRatePort } from './fx-rate-fallback-chain.adapter';
import { RefusingFxRateAdapter } from './refusing-fx-rate.adapter';

/**
 * 085 T004 FX port 按 `marketdataConfig.kind` 装配 + mock 档拒绝壳单测 (Small: 只做装配判断,
 * 零 I/O —— live 分支只**构造**对象, 不调用它)。
 *
 * 🚨 承重的是臂①: mock 档**必须**拿到拒绝壳。dev 机与 IT 跑的都是 mock 档, 绑错就是本地每次
 * 打开那一屏都真打腾讯 / 新浪 —— 而它一切正常, 只是在替 vendor 计数 (054 的同一病根)。
 */

/** live 档的完整 config 夹具 (值全是合成的; 隧道地址用 RFC1918, 同 futu 既有单测体例)。 */
const LIVE_CONFIG: MarketdataConfig = {
  kind: 'live',
  lixingerToken: 'test-token',
  lixingerBaseUrl: 'https://open.lixinger.com/api',
  eastmoneyBaseUrl: 'https://searchapi.eastmoney.com',
  eastmoneyClistBaseUrl: 'https://push2.eastmoney.com',
  tencentCalendarBaseUrl: 'https://web.ifzq.gtimg.cn',
  tencentFxBaseUrl: 'https://qt.gtimg.cn',
  sinaFxBaseUrl: 'https://hq.sinajs.cn',
  // 🚨 末段刻意避开 `10.89` 一类写法: 它含子串 `0.8` ——
  // `check-optionsdesk-rule-constants.ts` 不变量 #1 扫本目录全部 `.ts`(含 spec), 当场红。
  futuShimUrl: 'http://10.77.0.3:8811',
  futuShimToken: 'test-shim-token',
};

describe('createFxRatePort —— 按 kind 绑定 FX 取数口', () => {
  it('① mock 档 ⇒ 拒绝壳, 调用即抛且错误点明「本地 dev 不打真 vendor」', async () => {
    const port = createFxRatePort({ kind: 'mock' });

    expect(port).toBeInstanceOf(RefusingFxRateAdapter);
    // 🚨 反向也钉住: 绑成真链时这一条当场红 —— 只断 instanceof 的话, 「mock 也绑真 adapter」
    // 那个变异会在类型上照样成立 (两者都是 FxRatePort)。
    expect(port).not.toBeInstanceOf(FxRateCacheAdapter);

    await expect(port.fetchRates()).rejects.toThrow(/MARKETDATA_PROVIDER=mock/);
    // 错误要能自己说清「为什么拒」—— 读到它的人多半是本地 dev, 不是写这行的人。
    await expect(port.fetchRates()).rejects.toThrow(/vendor/);
  });

  it('② live 档 ⇒ 缓存装饰器在最外层 (单格 + single-flight 包住 FallbackChain)', () => {
    const port = createFxRatePort(LIVE_CONFIG);

    // 最外层必须是缓存: 反过来 (链在外、缓存在内) 每个节点各缓存一份, single-flight 形同虚设。
    expect(port).toBeInstanceOf(FxRateCacheAdapter);
    expect(port).not.toBeInstanceOf(RefusingFxRateAdapter);
  });

  it('② live 档只构造、不外呼 —— 装配期零 vendor 请求', () => {
    // 构造函数里若真去打一发 (预热之类), 本 Small 档就会变成打真网络的测试。
    expect(() => createFxRatePort(LIVE_CONFIG)).not.toThrow();
  });
});
