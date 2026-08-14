import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { marketdataConfig } from './marketdata.config.js';

const ENV_KEYS = [
  'MARKETDATA_PROVIDER',
  'LIXINGER_TOKEN',
  'LIXINGER_BASE_URL',
  'EASTMONEY_BASE_URL',
  'FUTU_SHIM_URL',
  'FUTU_SHIM_TOKEN',
] as const;

/** live 分支的必填项 (均无 schema default —— 缺一即 boot 抛)。 */
const SHIM_URL = 'http://10.89.0.1:8811';
const SHIM_TOKEN = 'shim-tok';

function setLiveRequired(): void {
  process.env.MARKETDATA_PROVIDER = 'live';
  process.env.LIXINGER_TOKEN = 'tok';
  process.env.FUTU_SHIM_URL = SHIM_URL;
  process.env.FUTU_SHIM_TOKEN = SHIM_TOKEN;
}

// 015 T003 verify: config discriminated-union — mock default (zero env) + live fail-fast。
describe('marketdataConfig discriminated union', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('defaults to kind=mock when MARKETDATA_PROVIDER unset (zero env)', () => {
    expect(marketdataConfig()).toEqual({ kind: 'mock' });
  });

  it('returns kind=mock when MARKETDATA_PROVIDER=mock (no token required)', () => {
    process.env.MARKETDATA_PROVIDER = 'mock';
    expect(marketdataConfig()).toEqual({ kind: 'mock' });
  });

  // 054 T004 (FR-008, state_branch 12): 非法值 MUST NOT 被静默吞成 mock。
  //
  // 🚨 空串是这里的**主角**, 不是陪跑: `docker-compose.tight.yml` 的 `${MARKETDATA_PROVIDER}`
  // 在变量未设时喂给容器的正是**空串**, 而 `??` 是 nullish 合并、空串不触发 —— 旧实现于是
  // 让「prod env-file 没加载」一路穿到底、零告警地跑 mock。
  it.each([['liv'], ['Live'], ['production'], ['MOCK'], ['']])(
    '🚨 boot fail-fast: MARKETDATA_PROVIDER=%j (非法值) → throws, 不静默落 mock',
    (raw) => {
      process.env.MARKETDATA_PROVIDER = raw;
      expect(() => marketdataConfig()).toThrow(/MARKETDATA_PROVIDER/);
    },
  );

  it('🚨 反向断言: 变量**缺失**仍解析为 mock (带论证的刻意保留, 非疏漏)', () => {
    // 与上一条的区别是 undefined vs 空串。ADR-0047 的「零 env → dev/test 可跑」靠这条;
    // 而 054 之后 mock 已不能写库, silent default 在本例中不再危险 (plan D-5)。
    delete process.env.MARKETDATA_PROVIDER;
    expect(marketdataConfig()).toEqual({ kind: 'mock' });
  });

  it('boot fail-fast: kind=live 缺 LIXINGER_TOKEN → throws (不静默降级)', () => {
    setLiveRequired();
    delete process.env.LIXINGER_TOKEN;
    // token undefined → zod parse 抛 (fail-fast); 不退默认 mock。
    expect(() => marketdataConfig()).toThrow();
    // 空串同样拒 (.min(1))。
    process.env.LIXINGER_TOKEN = '';
    expect(() => marketdataConfig()).toThrow();
  });

  it('🚨 boot fail-fast: kind=live 缺 FUTU_SHIM_URL / FUTU_SHIM_TOKEN → throws', () => {
    // sellput-viz Phase 1 #5: 这两项**蓄意无 default** —— 悄悄没有 US 日历 L1 = us 退回腾讯
    // 单源, 而 6 个 {us}-only 维度正要拿它判交易日闸。静默降级正是 044 病根。
    setLiveRequired();
    delete process.env.FUTU_SHIM_URL;
    expect(() => marketdataConfig()).toThrow();

    setLiveRequired();
    delete process.env.FUTU_SHIM_TOKEN;
    expect(() => marketdataConfig()).toThrow();

    setLiveRequired();
    process.env.FUTU_SHIM_TOKEN = ''; // 空串同样拒 (.min(1))。
    expect(() => marketdataConfig()).toThrow();

    setLiveRequired();
    process.env.FUTU_SHIM_URL = 'not-a-url'; // 非 URL 亦拒 (.url())。
    expect(() => marketdataConfig()).toThrow();
  });

  it('parses live config with token + default vendor baseUrls', () => {
    setLiveRequired();
    expect(marketdataConfig()).toEqual({
      kind: 'live',
      lixingerToken: 'tok',
      lixingerBaseUrl: 'https://open.lixinger.com/api',
      eastmoneyBaseUrl: 'https://searchapi.eastmoney.com',
      eastmoneyClistBaseUrl: 'https://push2.eastmoney.com',
      // 044: 东财指数 kline 日历源已退役 (端点被定向下线 + robots Disallow) → 腾讯 ifzq 接替。
      tencentCalendarBaseUrl: 'https://web.ifzq.gtimg.cn',
      // sellput-viz Phase 1 #5: 富途 shim (隧道虚 IP, 无 default)。
      futuShimUrl: SHIM_URL,
      futuShimToken: SHIM_TOKEN,
    });
  });

  it('live baseUrl env override 生效', () => {
    setLiveRequired();
    process.env.LIXINGER_BASE_URL = 'https://lixinger.test/api';
    process.env.EASTMONEY_BASE_URL = 'https://em.test';
    const cfg = marketdataConfig();
    expect(cfg).toMatchObject({
      kind: 'live',
      lixingerBaseUrl: 'https://lixinger.test/api',
      eastmoneyBaseUrl: 'https://em.test',
    });
  });
});
