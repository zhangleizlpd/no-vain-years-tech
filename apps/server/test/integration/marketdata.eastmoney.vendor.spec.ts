import { describe, it, expect } from 'vitest';
import { VendorHttpClient } from '../../src/marketdata/vendor-http-client';
import { EASTMONEY_PROFILE } from '../../src/marketdata/eastmoney.constraint-profile';
import { EastmoneySearchAdapter } from '../../src/marketdata/eastmoney-search.adapter';
import { EastmoneyUniverseAdapter } from '../../src/marketdata/eastmoney-universe.adapter';

/**
 * 东财搜索 adapter 真 vendor IT (015 T012, env-gated, 默认 skip) — SC-S08。
 *
 * 目的: 打真东财 searchapi (suggest/get), **校真 mock 单测无法覆盖的 vendor 契约**:
 * `QuotationCodeTable.Data` 结构 / `MktNum` 值域 / `Code`·`Name`·`Classify` 字段名 / 公开
 * token 是否仍有效。adapter 里标的字段映射在此被证实或证伪 (错则按 spec L253 修 adapter)。
 *
 * **默认 skip** (env-gated, 沿 RUN_PERF_IT / RUN_MARKETDATA_IT 范式): 逆向接口无 SLA,
 * CI / 常规 `nx affected` 不跑。东财 suggest 无需 token (公开固定 token 内置 adapter)。
 *
 * **本地启用**:
 *   RUN_MARKETDATA_IT=true pnpm nx test server -- marketdata.eastmoney.vendor
 */
const RUN_MARKETDATA_IT = process.env.RUN_MARKETDATA_IT === 'true';
const BASE = process.env.EASTMONEY_BASE_URL ?? 'https://searchapi.eastmoney.com';

describe.skipIf(!RUN_MARKETDATA_IT)('东财搜索真 vendor IT (env-gated, 默认 skip)', () => {
  const http = new VendorHttpClient(EASTMONEY_PROFILE);
  const adapter = new EastmoneySearchAdapter(http, BASE);

  it('"贵州茅台" → 含 cn:600519 (canonical + name + type=stock)', async () => {
    const out = await adapter.search('贵州茅台');
    expect(out.length).toBeGreaterThan(0);
    const maotai = out.find((h) => h.symbol === 'cn:600519');
    expect(maotai).toBeDefined();
    expect(maotai?.name).toContain('茅台');
    expect(maotai?.type).toBe('stock');
  }, 30_000);

  it('代码 "600519" → 命中归一化 canonical', async () => {
    const out = await adapter.search('600519');
    expect(out.some((h) => h.symbol === 'cn:600519')).toBe(true);
  }, 30_000);

  it('冷僻串 → 空数组 (非 error)', async () => {
    const out = await adapter.search('zzzzzznonexistentqueryxxx');
    expect(Array.isArray(out)).toBe(true);
  }, 30_000);
});

/**
 * 东财 universe adapter 真 vendor IT (016 T007, env-gated, 默认 skip) — SC-S08。
 *
 * 目的: 打真东财 clist (push2), **校真 mock 单测无法覆盖的 vendor 契约**: clist `data.diff`
 * 结构 / `f12`·`f13`·`f14` 字段值 / `fs` 板块码是否覆盖全 A 股含北交所 / 分页 `total` 字段。
 * adapter 的 FS_ALL_A_SHARES 板块码在此被证实或证伪 (错则按 spec L253 修 adapter)。
 *
 * **本地启用**:
 *   RUN_MARKETDATA_IT=true pnpm nx test server -- marketdata.eastmoney.vendor
 */
const CLIST_BASE = process.env.EASTMONEY_CLIST_BASE_URL ?? 'https://push2.eastmoney.com';

describe.skipIf(!RUN_MARKETDATA_IT)('东财 universe 真 vendor IT (env-gated, 默认 skip)', () => {
  const http = new VendorHttpClient(EASTMONEY_PROFILE);
  const adapter = new EastmoneyUniverseAdapter(http, CLIST_BASE);

  it('enumerate(["cn"]) → 全 A 股规模 (>4000) + 含贵州茅台 + 含北交所标的', async () => {
    const out = await adapter.enumerate(['cn']);
    // 全 A 股 ~5000+; 保守断言 >4000 防板块码漏配静默少收。
    expect(out.length).toBeGreaterThan(4000);
    expect(out.every((e) => e.market === 'cn' && e.code.length > 0 && e.name.length > 0)).toBe(
      true,
    );

    const maotai = out.find((e) => e.code === '600519');
    expect(maotai?.name).toContain('茅台');

    // 北交所代码段 8xxxx/4xxxx 应有收录 (验 fs 北交所板块码生效)。
    expect(out.some((e) => e.code.startsWith('8') || e.code.startsWith('4'))).toBe(true);
  }, 60_000);

  it('enumerate(["hk"]) → 港股全集非空 + canonical hk:code + 含腾讯 00700 (S2-T2)', async () => {
    const out = await adapter.enumerate(['hk']);
    expect(out.length).toBeGreaterThan(1000); // PoC-2 实测 ~17938; 保守 >1000 防 fs 漏配。
    expect(out.every((e) => e.market === 'hk' && e.code.length > 0 && e.name.length > 0)).toBe(
      true,
    );
    expect(out.some((e) => e.code === '00700')).toBe(true); // 腾讯 (canonical hk:00700)
  }, 60_000);

  // 🪦 **us 用例已随源退役删除** (2026-07-31, sellput-viz Phase 1 #4)。
  //
  // 原用例断言 `out.some(e => e.code === 'AAPL')`，且**从来没跑过**（整个套件 default-skip）。
  // p3b E30/E16 后来查明：它一旦跑就是**红的** —— 东财 `push2` 服务端硬封顶 100 条/响应而代码
  // 按 `PAGE_SIZE=500` 推进游标 ⇒ us 只收 2800/13683 且按 code **降序**截断，`AAPL` 这种 A 打头
  // 的票根本不在返回里。一条永远不跑的断言替我们"守"了几个月一个一直是坏的路径。
  //
  // ⇒ 换源富途后该断言搬到 `marketdata.futu-shim.vendor.spec.ts`，并**加了它当初该有的东西**：
  //   全集规模、白名单 7/7 逐票覆盖、VICI（被分类为 ETF 的 REIT）在集合内。
  //   本文件下方新增的 `enumerate(['us']) → []` 单测（`eastmoney-universe.adapter.spec.ts`）
  //   守住"us 真的退了"，那条**每次 CI 都跑**。
});

/**
 * 🪦 **「东财指数日历源真 vendor IT」块已随源退役删除** (044 T008, FR-007): 该端点被**定向
 * 下线** + `robots.txt` 明确 `Disallow: /` → 日历填充静默停摆 2 天。接替者 = 腾讯 ifzq
 * (L1) + 静态离线年历 (L2) 的 fallback 链, 其真 vendor 回归网见
 * `marketdata.tencent.vendor.spec.ts`。
 *
 * ⚠️ 上方**搜索 (searchapi) + universe (push2) 两块蓄意保留**: 不同 host、当前可达, 044 只治
 * 日历这一个源。
 */
