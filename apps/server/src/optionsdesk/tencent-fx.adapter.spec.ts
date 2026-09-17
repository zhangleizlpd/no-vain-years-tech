import { describe, expect, it, vi } from 'vitest';
import { TENCENT_PROFILE } from '../marketdata/tencent.constraint-profile';
import { VendorHttpClient } from '../marketdata/vendor-http-client';
import { FX_PAIRS, type FxPair } from './fx-rate.port';
import { invertRate } from './fx-rate.rules';
import { TencentFxAdapter } from './tencent-fx.adapter';

/**
 * 085 T002 腾讯汇率 adapter 单测 (Small: HTTP 以假 fetch 注入, 不打真网)。
 *
 * 🚨 夹具汇率一律**合成值**, 逐个避开 `0.8` / `0.6` / `1.2` ——
 * `scripts/checks/check-optionsdesk-rule-constants.ts` 不变量 #1 的扫描面含 `*.spec.ts`
 * (刻意不排除), 真实值 `0.8549` 会被当场判成「档位系数外溢」。
 *
 * 用**真 `VendorHttpClient` + 假 fetch**而不是把 client 整个 stub 掉: 被测的一部分正是
 * 「走的是字节口还是文本口」, stub 掉 client 就把它一起 stub 掉了。限频桶初始装满
 * (`DualWindowGate` 构造即 `tokens = capacity`) ⇒ 每个用例 ≤ 4 发不触发排队 sleep, 无需假时钟。
 *
 * ## 🚨 夹具字节必须是**真 GBK**, 不能拿 UTF-8 字节充数
 *
 * 本文件初版把含中文名的行按 UTF-8 编码喂进去, 七条臂**全红**在「汇率位 = 0」上: 名称段
 * `美元人民币` 的 UTF-8 是 15 字节 (奇数), GBK 按双字节切到末字节时, 会把其后的 `~` 当成尾
 * 字节吞掉 ⇒ 分隔符少一个、字段整体左移一格, 汇率位读到的是 `f4` (恒 `0`)。
 * ⇒ 这正是「按错编码读就静默错位」的又一次实证 (2026-09-17 本文件实撞)。故默认夹具的名称段
 * 一律用 **ASCII 占位名** (两种编码下逐字节相同), 只有下面两条 GBK 专项臂注入真 GBK 字节。
 */

/** 合成汇率 —— 与 `fx-rate.rules.spec.ts` 同一套值, 不另造第二套。 */
const SYNTHETIC_RATE: Record<FxPair, string> = {
  USDCNY: '7.1500',
  HKDCNY: '0.9500',
  USDHKD: '2.5000',
};

/** ASCII 占位名 (见文件头): 两种编码下字节相同, 故不会把编码问题混进非编码臂。 */
const ASCII_NAME: Record<FxPair, string> = {
  USDCNY: 'USD-CNY',
  HKDCNY: 'HKD-CNY',
  USDHKD: 'USD-HKD',
};

/** 真 vendor 中文名 —— 形态取自 plan §D3 字段位对照表的样本行 (`f1` 段)。 */
const TENCENT_NAME_USDCNY = '美元人民币';

/**
 * 腾讯 `wh` 响应一行 —— `~` 分隔 22 字段 (plan §D3 字段位对照表)。
 *
 * `f10` 蓄意给一个**与 `f3` 不同**的值: 取错价格位的实现在「稳态下 f10 == f3」的夹具上会照样绿。
 */
function tencentLine(pair: FxPair, f3: string, f5 = '20260917094811', name = ASCII_NAME[pair]) {
  const seg = new Array<string>(22).fill('0');
  seg[0] = '310';
  seg[1] = name;
  seg[2] = pair;
  seg[3] = f3;
  seg[5] = f5;
  seg[10] = '9.9999';
  seg[11] = '3.3333';
  return `v_wh${pair}="${seg.join('~')}";`;
}

const ALL_THREE = FX_PAIRS.map((pair) => tencentLine(pair, SYNTHETIC_RATE[pair])).join('\n');

/** `美元人民币` 的 GBK 字节 (取值与 `fx-rate.rules.spec.ts` 同源)。 */
const GBK_NAME_USDCNY = Uint8Array.from([
  0xc3, 0xc0, 0xd4, 0xaa, 0xc8, 0xcb, 0xc3, 0xf1, 0xb1, 0xd2,
]);

/**
 * `皛` 的 GBK 字节 —— **尾字节恰是 `0x7E`**, 即腾讯的字段分隔符 `~`。
 *
 * EVIDENCE: GBK 尾字节值域 `0x40–0x7E`, `0xB0 0x7E` 解作「皛」; 同一串按 UTF-8 解则得
 * `U+FFFD` + 一个货真价实的 `~` (2026-09-17 以 Node `TextDecoder` 双向实拉)。
 * 🚨 **当前三个真币对名恰好都不含这类字**, 所以按 UTF-8 读今天也跑得通 —— 本条用一个含该
 * 字节的合成名把那条缝钉住, 否则 vendor 改一次名就静默错位, 而屏幕上一切正常。
 */
const GBK_NAME_WITH_TILDE_BYTE = Uint8Array.from([0xb0, 0x7e]);

const utf8 = (text: string) => new TextEncoder().encode(text);

/**
 * 造一份**真 GBK** 响应字节: USDCNY 那行的名称段换成给定 GBK 字节, 另两行用 ASCII 占位名
 * (ASCII 在 GBK 下逐字节不变) ⇒ 整份字节流是合法 GBK。
 */
function gbkBodyWithName(nameBytes: Uint8Array): Uint8Array {
  const head = tencentLine('USDCNY', SYNTHETIC_RATE.USDCNY, '20260917094811', TENCENT_NAME_USDCNY);
  const at = head.indexOf(TENCENT_NAME_USDCNY);
  const rest = FX_PAIRS.filter((pair) => pair !== 'USDCNY').map((pair) =>
    tencentLine(pair, SYNTHETIC_RATE[pair]),
  );
  return Uint8Array.from([
    ...utf8(head.slice(0, at)),
    ...nameBytes,
    ...utf8(head.slice(at + TENCENT_NAME_USDCNY.length)),
    ...utf8(`\n${rest.join('\n')}`),
  ]);
}

/** 显式建一个真 `ArrayBuffer` —— `Uint8Array.buffer` 的静态类型是 `ArrayBufferLike`。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

type FetchCall = { url: string };

/** 假 fetch: 按轮次依次返回给定字节 (末一份用完则重复), 记录每次入参。 */
function makeFetch(bodies: Uint8Array[], status = 200) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetch = vi.fn(async (url: string) => {
    calls.push({ url });
    const bytes = bodies[Math.min(i, bodies.length - 1)];
    i++;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => ({}),
      arrayBuffer: async () => toArrayBuffer(bytes),
    };
  });
  return { fetch, calls };
}

const BASE = 'https://qt.test';

function makeAdapter(bodies: Uint8Array[], now: () => Date = () => new Date()) {
  const { fetch, calls } = makeFetch(bodies);
  const client = new VendorHttpClient(TENCENT_PROFILE, { fetch });
  return { adapter: new TencentFxAdapter(client, BASE, now), calls, fetch };
}

describe('TencentFxAdapter —— 腾讯 wh 主源 (取 f3)', () => {
  it('① 正常响应 ⇒ 三对齐出, f3 值逐字正确', async () => {
    const { adapter } = makeAdapter([utf8(ALL_THREE)]);

    const rates = await adapter.fetchRates();

    expect(rates).toHaveLength(3);
    for (const pair of FX_PAIRS) {
      // 逐字比较而非 `.equals()`: 后者对「解出来是别的字段但数值凑巧」无鉴别力。
      expect(rates.find((r) => r.pair === pair)?.rate.toFixed(4)).toBe(SYNTHETIC_RATE[pair]);
    }
  });

  it('① GBK 中文名正常解码 ⇒ 汇率照样逐字正确 (真名样本, 真 GBK 字节)', async () => {
    const { adapter } = makeAdapter([gbkBodyWithName(GBK_NAME_USDCNY)]);

    const rates = await adapter.fetchRates();

    expect(rates.find((r) => r.pair === 'USDCNY')?.rate.toFixed(4)).toBe(SYNTHETIC_RATE.USDCNY);
  });

  it('🚨 名称段含 GBK 尾字节 0x7E ⇒ 汇率仍逐字正确 (按 UTF-8 读会多切一个字段, 汇率位后移)', async () => {
    // 这条是 `VendorHttpClient.requestBytes` 存在的全部理由: 走 `requestText` 时
    // `0xB0 0x7E` 解成 U+FFFD + `~`, 名称段凭空多出一个分隔符 ⇒ 汇率位读到的是 `f2` 的内容,
    // 而解析不报错、数字也还像个汇率。
    const { adapter } = makeAdapter([gbkBodyWithName(GBK_NAME_WITH_TILDE_BYTE)]);

    const rates = await adapter.fetchRates();

    expect(rates.find((r) => r.pair === 'USDCNY')?.rate.toFixed(4)).toBe(SYNTHETIC_RATE.USDCNY);
  });

  it('⑤ 两轮: vendor 时间戳推进而汇率不变 ⇒ capturedAt 逐字等于**我们注入的时钟**, 不是 f5', async () => {
    // 🚨 光断言「两次 capturedAt 不同」对取 f5 的实现**没有鉴别力** —— f5 本身也在推进。
    // 判据必须是「等于我们的时钟」: 那是 f5 永远给不出的值 (plan D5)。
    const round1 = utf8(
      FX_PAIRS.map((pair) => tencentLine(pair, SYNTHETIC_RATE[pair], '20260917094811')).join('\n'),
    );
    const round2 = utf8(
      FX_PAIRS.map((pair) => tencentLine(pair, SYNTHETIC_RATE[pair], '20260917095011')).join('\n'),
    );
    const ours = [new Date('2026-09-17T02:00:00.000Z'), new Date('2026-09-17T02:05:00.000Z')];
    let tick = 0;
    const { adapter } = makeAdapter([round1, round2], () => ours[Math.min(tick++, 1)]);

    const first = await adapter.fetchRates();
    const second = await adapter.fetchRates();

    // 汇率值两轮逐字相同 —— 数字确实没动, 动的只有 vendor 自报的时间戳。
    expect(first[0].rate.toFixed(4)).toBe(second[0].rate.toFixed(4));
    for (const rate of first) expect(rate.capturedAt).toEqual(ours[0]);
    for (const rate of second) expect(rate.capturedAt).toEqual(ours[1]);
    expect(first[0].capturedAt).not.toEqual(second[0].capturedAt);
  });

  it('⑥ 只请求正向三码; 反向对由 invertRate 取倒数得出, 不问 vendor', async () => {
    const { adapter, calls } = makeAdapter([utf8(ALL_THREE)]);

    const rates = await adapter.fetchRates();

    expect(calls[0].url).toBe(`${BASE}/q=whUSDCNY,whHKDCNY,whUSDHKD`);
    // EVIDENCE: 反向三对 (whCNYHKD / whHKDUSD / whCNYUSD) 全 MISS —— plan 作者 2026-09-16
    // PoC P3 实拉; 真端由 optionsdesk-085.fx.vendor.spec.ts 的门控块复核。
    for (const reverse of ['CNYHKD', 'HKDUSD', 'CNYUSD']) {
      expect(calls[0].url).not.toContain(reverse);
    }
    const hkdcny = rates.find((r) => r.pair === 'HKDCNY')?.rate;
    expect(hkdcny).toBeDefined();
    if (hkdcny === undefined) return;
    const cnyhkd = invertRate(hkdcny);
    expect(invertRate(cnyhkd).minus(hkdcny).abs().lt(1e-9)).toBe(true);
  });

  it('⑦ USDHKD 取自它自己的 f3, **不由另两对相除得出** (夹具三角蓄意不闭合)', async () => {
    const { adapter } = makeAdapter([utf8(ALL_THREE)]);

    const rates = await adapter.fetchRates();
    const usdcny = rates.find((r) => r.pair === 'USDCNY')?.rate;
    const hkdcny = rates.find((r) => r.pair === 'HKDCNY')?.rate;
    const usdhkd = rates.find((r) => r.pair === 'USDHKD')?.rate;
    expect(usdcny && hkdcny && usdhkd).toBeDefined();
    if (!usdcny || !hkdcny || !usdhkd) return;

    expect(usdhkd.toFixed(4)).toBe(SYNTHETIC_RATE.USDHKD);
    // 交叉出来的数字与 vendor 直接给的**不是一个数** —— 真端三角也不闭合 (约 0.057%,
    // plan PoC)。这条把「看起来也合理」的交叉实现挡在外面。
    expect(usdhkd.equals(usdcny.div(hkdcny))).toBe(false);
  });

  it('⑦ 缺 USDHKD 的响应 ⇒ **抛**, 而不是拿另两对凑一个出来', async () => {
    const partial = FX_PAIRS.filter((pair) => pair !== 'USDHKD').map((pair) =>
      tencentLine(pair, SYNTHETIC_RATE[pair]),
    );
    const { adapter } = makeAdapter([utf8(partial.join('\n'))]);

    await expect(adapter.fetchRates()).rejects.toThrow(/USDHKD/);
  });

  it('哨兵 v_pv_none_match ⇒ 抛 (零汇率但不报错是本条要挡的塌法)', async () => {
    const { adapter } = makeAdapter([utf8('v_pv_none_match="1";')]);

    await expect(adapter.fetchRates()).rejects.toThrow(/pv_none_match/);
  });
});
