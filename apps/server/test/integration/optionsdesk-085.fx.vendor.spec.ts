import { describe, it, expect } from 'vitest';
import { Prisma } from '../../src/generated/prisma/client';
import { TENCENT_PROFILE } from '../../src/marketdata/tencent.constraint-profile';
import { VendorHttpClient } from '../../src/marketdata/vendor-http-client';
import { FX_PAIRS } from '../../src/optionsdesk/fx-rate.port';
import { decodeGbk, parseTencentFx } from '../../src/optionsdesk/fx-rate.rules';
import { SINA_FX_PROFILE } from '../../src/optionsdesk/sina-fx.constraint-profile';
import { SinaFxAdapter } from '../../src/optionsdesk/sina-fx.adapter';
import { TencentFxAdapter } from '../../src/optionsdesk/tencent-fx.adapter';

/**
 * 085 T002 FX 双源真 vendor IT (env-gated, 默认 skip)。
 *
 * 目的: 校真 mock 单测**覆盖不到**的 vendor 契约 —— 字段数 / `f3` 与 `f5` 的形态 / 新浪
 * `idx3` / **反向三对是否真的 MISS**。单测夹具是我们自己写的, 它只能证明解析器按夹具的形状
 * 工作; vendor 到底是不是那个形状, 只有打真端点能答。
 *
 * **默认 skip** (沿 `RUN_MARKETDATA_IT` 范式, per `testing.md` §4 步 4): 公开端点无 SLA,
 * CI / 常规 `nx affected` 不跑, 不触真 vendor。`RUN_FX_VENDOR_IT` 已登记进
 * `scripts/checks/check-env-sync.ts` 的 `ALLOWLIST` (vitest gate, 非 application config)。
 *
 * **本地启用**:
 *   RUN_FX_VENDOR_IT=true pnpm nx test server test/integration/optionsdesk-085.fx.vendor.spec.ts
 *
 * 📌 **未覆盖且蓄意的**: 新浪 `idx3` 的更新频率 (plan「未能验证的事项」) 需 ≥ 30 分钟、跨在岸
 * CNY 开盘的长窗采样, 不适合放进一条用例; 它只影响备源, 且 D5 已把上屏时刻锁在我们自己的
 * `capturedAt`, 故按 tasks.md 文末「是消法不是本片验收门」留在本文件之外。
 */
const RUN_FX_VENDOR_IT = process.env.RUN_FX_VENDOR_IT === 'true';

/** 端点常量写死在本文件: 被测的就是这两个地址本身, 从 config 读会把「地址对不对」测没了。 */
const TENCENT_BASE = 'https://qt.gtimg.cn';
const SINA_BASE = 'https://hq.sinajs.cn';

/** 腾讯 `wh` 响应实测字段数 (plan PoC P1: 22 段 `~` 分隔)。 */
const TENCENT_FIELD_COUNT = 22;

describe.skipIf(!RUN_FX_VENDOR_IT)('085 FX 双源真 vendor IT (env-gated, 默认 skip)', () => {
  const tencentHttp = new VendorHttpClient(TENCENT_PROFILE);
  const sinaHttp = new VendorHttpClient(SINA_FX_PROFILE);

  it('腾讯 wh 裸响应: 三对齐回 / 每条 22 字段 / f3 可 Decimal 解析 / f5 为 14 位时间戳', async () => {
    const url = `${TENCENT_BASE}/q=${FX_PAIRS.map((pair) => `wh${pair}`).join(',')}`;
    const text = decodeGbk(await tencentHttp.requestBytes({ url }));

    const lines = [...text.matchAll(/v_wh(\w+)="([^"]*)"/g)];
    expect(lines).toHaveLength(FX_PAIRS.length);
    for (const [, symbol, payload] of lines) {
      const fields = payload.split('~');
      // 字段数变了 = schema drift。解析器只消费 f3 / f5, 故它自己不会红 —— 这条是那个盲区的哨兵。
      expect(fields, `wh${symbol} 字段数`).toHaveLength(TENCENT_FIELD_COUNT);
      expect(new Prisma.Decimal(fields[3]).gt(0)).toBe(true);
      expect(fields[5]).toMatch(/^\d{14}$/);
    }
  }, 30_000);

  it('腾讯 adapter 端到端: 三对齐出, capturedAt 落在调用前后之间 (是我们的采集时刻)', async () => {
    const adapter = new TencentFxAdapter(tencentHttp, TENCENT_BASE);

    const before = Date.now();
    const rates = await adapter.fetchRates();
    const after = Date.now();

    expect(rates.map((r) => r.pair).sort()).toEqual([...FX_PAIRS].sort());
    for (const rate of rates) {
      expect(rate.rate.gt(0)).toBe(true);
      // vendor 的 f5 恒早于本次调用 (它是 vendor 刷新记录的时刻) ⇒ 取错的实现会掉出这个区间。
      expect(rate.capturedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(rate.capturedAt.getTime()).toBeLessThanOrEqual(after);
    }
  }, 30_000);

  it('🚨 反向三对真的 MISS —— 倒数不是省事, 是 vendor 压根不给', async () => {
    // 反向码全无效时腾讯返哨兵 `v_pv_none_match="1"`, 解析器显式挡 ⇒ 抛。
    // 这条一旦变绿 (vendor 开始支持反向码), 说明 `invertRate` 那条路可以重估了。
    const url = `${TENCENT_BASE}/q=whCNYHKD,whHKDUSD,whCNYUSD`;
    const text = decodeGbk(await tencentHttp.requestBytes({ url }));

    expect(() => parseTencentFx(text, ['USDCNY', 'HKDCNY', 'USDHKD'])).toThrow();
    expect(text).not.toMatch(/v_whCNYHKD="[^"]*~[^"]*~/);
  }, 30_000);

  it('新浪 fx_s 裸响应: 三对齐回 / idx3 可 Decimal 解析 (备源字段落点)', async () => {
    const url = `${SINA_BASE}/list=${FX_PAIRS.map((pair) => `fx_s${pair.toLowerCase()}`).join(',')}`;
    const text = decodeGbk(await sinaHttp.requestBytes({ url }));

    const lines = [...text.matchAll(/var hq_str_fx_s(\w+)="([^"]*)"/g)];
    expect(lines).toHaveLength(FX_PAIRS.length);
    for (const [, symbol, payload] of lines) {
      const fields = payload.split(',');
      expect(fields.length, `fx_s${symbol} 字段数`).toBeGreaterThan(3);
      expect(new Prisma.Decimal(fields[3]).gt(0)).toBe(true);
    }
  }, 30_000);

  it('新浪 adapter 端到端 (Referer 由 profile 注入; 漏了这里就是 403)', async () => {
    const adapter = new SinaFxAdapter(sinaHttp, SINA_BASE);

    const rates = await adapter.fetchRates();

    expect(rates.map((r) => r.pair).sort()).toEqual([...FX_PAIRS].sort());
    for (const rate of rates) expect(rate.rate.gt(0)).toBe(true);
  }, 30_000);

  it('双源对拍: 同一币对两源的即期汇率同量级 (差 > 5% 即某一侧的字段位读错了)', async () => {
    const tencent = await new TencentFxAdapter(tencentHttp, TENCENT_BASE).fetchRates();
    const sina = await new SinaFxAdapter(sinaHttp, SINA_BASE).fetchRates();

    for (const pair of FX_PAIRS) {
      const a = tencent.find((r) => r.pair === pair)?.rate;
      const b = sina.find((r) => r.pair === pair)?.rate;
      expect(a, `腾讯缺 ${pair}`).toBeDefined();
      expect(b, `新浪缺 ${pair}`).toBeDefined();
      if (a === undefined || b === undefined) continue;
      // 宽判据: 两源刷新时刻不同, 盘中真会差几个点; 但读错字段位会差一个数量级。
      const drift = a.minus(b).abs().div(a);
      expect(drift.lt(new Prisma.Decimal('0.05')), `${pair} 两源偏离 ${drift.toString()}`).toBe(
        true,
      );
    }
  }, 60_000);
});
