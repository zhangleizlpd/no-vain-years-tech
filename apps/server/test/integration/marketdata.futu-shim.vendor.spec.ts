import { describe, it, expect } from 'vitest';
import { VendorHttpClient } from '../../src/marketdata/vendor-http-client';
import {
  FUTU_SHIM_PROFILE,
  FUTU_SHIM_OPTION_CHAIN_PROFILE,
  FUTU_SHIM_OPTION_SNAPSHOT_PROFILE,
  FUTU_SHIM_EARNINGS_CALENDAR_PROFILE,
} from '../../src/marketdata/futu-shim.constraint-profile';
import { FutuCalendarAdapter } from '../../src/marketdata/futu-calendar.adapter';
import { FutuUniverseAdapter } from '../../src/marketdata/futu-universe.adapter';
import { FutuEodBarAdapter } from '../../src/marketdata/futu-eod-bar.adapter';
import { FutuUnderlyingIvAdapter } from '../../src/marketdata/futu-underlying-iv.adapter';
import { FutuOptionChainAdapter } from '../../src/marketdata/futu-option-chain.adapter';
import { FutuOptionSnapshotAdapter } from '../../src/marketdata/futu-option-snapshot.adapter';
import { FutuEarningsCalendarAdapter } from '../../src/marketdata/futu-earnings-calendar.adapter';
import {
  gapCheckExpiryDates,
  planOptionChainWindows,
} from '../../src/marketdata/option-chain-window.rules';
import { OPTION_SNAPSHOT_MAX_CONTRACT_CODES } from '../../src/marketdata/option-snapshot.port';
import { EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS } from '../../src/marketdata/earnings-calendar.port';
import { VendorHttpError } from '../../src/marketdata/vendor-http-client';

/**
 * 富途 US 交易日历真 vendor IT (sellput-viz Phase 1 #5, env-gated, 默认 skip)。
 *
 * 目的: 打真 shim → 真 OpenD → 富途, **校真 mock 单测无法覆盖的 vendor 契约**: 信封形状
 * (`rows[].time` / `trade_date_type`) / 节假日与半日市是否仍正确 / **两条静默边界是否还在原处**
 * (10 年历史上限 · 当年 12-31 未来视野)。adapter 的截断断言在此被证实或证伪。
 *
 * 🚨 **这是本换源的回归网**: 两条边界都以「200 + 更窄的答案」表现, 不报错 —— 若富途哪天把
 * 视野推远 / 收紧, 单测里的仿真端不会知道, 只有本套件会。
 *
 * ⚠️ **真实代价**: 每个用例都是一次真券商调用, 吃对应 capability 的限频桶 (`option_chain`
 * 10/30 s · 其余 60/30 s)。别循环重跑; 但**不必挑时段**, 盘中/休市只影响快照形状 (见下面
 * SC-009 块的「先看钟」段), 不影响能不能跑。
 *
 * 🚫 **此处原有的「跑一次会拉起 OpenD、把行情权从手机上收走约 10 分钟 (idle_stop 窗)、别在
 * 美股盘中随手跑」已于 2026-08-04 作废** —— 两个半句都不再成立。留下这条更正而不是直接删,
 * 是因为它此前真的骗到过人 (照读它去挑时段、或据它推迟部署):
 * ① OpenD 已改**常驻** (systemd `enable` + `Restart=always`, `FUTU_OPEND_IDLE_STOP_S=0`
 *    ⇒ shim 永不回收), 本套件既不拉起它、也不停它;
 * ② 「OpenD 会抢走手机最高权限行情」这个**前提本身**被 **V9 (08-03 美股) + V10 (08-04 港股)**
 *    两次实测证伪 —— OpenD 持实时订阅期间手机反复主动争用, 两侧同时保持最高档、零互踢; 且
 *    `auto_hold_quote_right=0` 的真实语义是「**被抢后**不抢回」, 官方从未说 OpenD 启动即抢占。
 * SoT = `ops/runbook/futu-opend-hk.md` §常驻 / §V9 / §V10。
 *
 * **默认 skip** (env-gated, 沿 RUN_MARKETDATA_IT 范式): shim 只在 B↔C 隧道内可达, CI /
 * 常规 `nx affected` 够不着, 也不该触真券商接口。
 *
 * **本地启用** (须先能打通隧道虚 IP, 即在 77 上、或本机已接入该隧道):
 *   RUN_MARKETDATA_IT=true FUTU_SHIM_URL=http://10.89.0.1:8811 FUTU_SHIM_TOKEN=<真值> \
 *     pnpm nx test server -- marketdata.futu-shim.vendor
 */
const RUN_MARKETDATA_IT = process.env.RUN_MARKETDATA_IT === 'true';
const BASE = process.env.FUTU_SHIM_URL ?? '';
const TOKEN = process.env.FUTU_SHIM_TOKEN ?? '';
const ENABLED = RUN_MARKETDATA_IT && BASE !== '' && TOKEN !== '';

describe.skipIf(!ENABLED)('富途 US 交易日历真 vendor IT (env-gated, 默认 skip)', () => {
  const adapter = new FutuCalendarAdapter(new VendorHttpClient(FUTU_SHIM_PROFILE), BASE, TOKEN);
  const iso = /^\d{4}-\d{2}-\d{2}$/;

  it('日常 30 天窗: 返交易日集 + servedBy=futu + 周末缺席', async () => {
    const { dates, servedBy } = await adapter.fetchTradingDates('us', '2026-07-01', '2026-07-31');
    expect(servedBy).toBe('futu'); // 自报家门 (降级可观测, FR-014)
    expect(dates.every((d) => iso.test(d))).toBe(true);
    // 23 个工作日 − 独立日顺延 (07-03) = 22。截断 / 解析错会远低于此。
    expect(dates.length).toBeGreaterThanOrEqual(18);
    expect(dates.length).toBeLessThanOrEqual(23);
    expect(dates).not.toContain('2026-07-04'); // 周六
    expect(dates).not.toContain('2026-07-03'); // Independence Day (observed)
  }, 60_000);

  it('半日市窗: 感恩节缺席、次日 (MORNING) 仍计为交易日', async () => {
    // 实测 2026-11-27 = `MORNING` —— 半日市**是**交易日, 误当休市每年会丢掉数天。
    const { dates } = await adapter.fetchTradingDates('us', '2026-11-20', '2026-12-04');
    expect(dates).toContain('2026-11-27');
    expect(dates).not.toContain('2026-11-26'); // Thanksgiving
  }, 60_000);

  it('🚨 未来视野边界仍止于当年 12-31 → 跨年窗被 adapter 判截尾 (边界没挪走)', async () => {
    // 若富途某天把视野推到次年, 本例会由「throw」变「通过」→ 红 → 提醒我们边界变了。
    // 那时该做的是**复核并放宽注释里的实测表**, 不是删断言。
    const nextYear = new Date().getUTCFullYear() + 1;
    await expect(
      adapter.fetchTradingDates('us', `${nextYear}-01-01`, `${nextYear}-06-30`),
    ).rejects.toThrow(/返 0 天|疑截/);
  }, 60_000);

  it('🚨 10 年历史上限仍在 → 远古窗被 adapter 判截头/越界 (边界没挪走)', async () => {
    await expect(adapter.fetchTradingDates('us', '2006-01-01', '2010-12-31')).rejects.toThrow(
      /返 0 天|疑截/,
    );
  }, 60_000);

  it('上限内的历史窗正常返回 (证明上一条红的是边界, 不是「历史一律取不到」)', async () => {
    const from = `${new Date().getUTCFullYear() - 2}-03-01`;
    const to = `${new Date().getUTCFullYear() - 2}-03-31`;
    const { dates } = await adapter.fetchTradingDates('us', from, to);
    expect(dates.length).toBeGreaterThanOrEqual(18);
  }, 60_000);
});

/**
 * us universe 真 vendor 回归网 (Phase 1 #4)。
 *
 * 🚨 **这里是那条「AAPL 断言」的新家**：它原本挂在东财 default-skip 的 IT 上、从未跑过，而按
 * p3b E30/E16 它一跑就是红的（东财按 code 降序静默截断到 2800/13683，A 打头的票取不到）。
 * 搬过来的同时补上它当初就该有的三件事：**全集规模 / 白名单 7 票逐个覆盖 / VICI 在集合内**。
 */
describe.skipIf(!ENABLED)('富途 us universe 真 vendor IT (env-gated, 默认 skip)', () => {
  const universe = new FutuUniverseAdapter(new VendorHttpClient(FUTU_SHIM_PROFILE), BASE, TOKEN);

  /** sellput 白名单（p3b E31「白名单 7/7 全覆盖」的那 7 票）。 */
  const WHITELIST = ['PEP', 'LULU', 'PSKY', 'CPB', 'VICI', 'AOS', 'TAP'];

  it('🚨 enumerate(["us"]) → 全集规模 + canonical us:<ticker> + 含 AAPL + 白名单 7/7', async () => {
    const out = await universe.enumerate(['us']);

    // 2026-07-31 实测 19,202（STOCK 13,047 ∪ ETF 6,155）。下界取 15,000：
    // 既能容下自然增删，又远高于东财残缺路径的 2,800 —— 若哪天并集塌回单一 stock_type，
    // 13,047 会跌破本闸而不是静默通过。
    expect(out.length).toBeGreaterThan(15_000);
    expect(out.every((e) => e.market === 'us' && e.code.length > 0 && e.name.length > 0)).toBe(
      true,
    );

    const codes = new Set(out.map((e) => e.code));
    expect(codes.has('AAPL')).toBe(true); // 东财路径上取不到的那一只
    for (const anchor of WHITELIST) expect(codes.has(anchor)).toBe(true);
    // 🚨 VICI 是 REIT 但被富途分类成 ETF —— 它在集合里 = STOCK ∪ ETF 并集没被谁改回单查 STOCK。
    expect(codes.has('VICI')).toBe(true);
    // canonical 无重复（19,202 行实测零重复；塌陷会让搜索命中错票）。
    expect(codes.size).toBe(out.length);
  }, 180_000);

  it('cn/hk 零外呼返空 (本源只承担 us, 由链交回理杏仁/东财)', async () => {
    expect(await universe.enumerate(['cn', 'hk'])).toEqual([]);
  }, 30_000);
});

/**
 * us 正股日线真 vendor 回归网。除了「取得到」之外，这里还钉两件**只有真端能验**的事：
 * ① NONE 口径拿到的是**真实市价**（拿它跟同一时刻的 universe/收盘价对不上就说明口径被换过）；
 * ② 富途历史视野的**实际边界** —— p3b E35 在 `trading_days` 上实证了「滚动 10 年」，
 *    kline 侧是否同界当时未验，这里补上。
 */
describe.skipIf(!ENABLED)('富途 us 正股日线真 vendor IT (env-gated, 默认 skip)', () => {
  const bars = new FutuEodBarAdapter(new VendorHttpClient(FUTU_SHIM_PROFILE), BASE, TOKEN);
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const year = new Date().getUTCFullYear();

  it('近一月窗: 取到日线 + 字段语义符合落库契约', async () => {
    const from = `${year}-06-01`;
    const to = `${year}-06-30`;
    const out = await bars.getBars({ symbol: 'us:PEP', adjust: 'none', from, to });

    // 6 月约 21 个美股交易日；截断/解析错会远低于此。
    expect(out.length).toBeGreaterThanOrEqual(18);
    expect(out.every((b) => iso.test(b.tradeDate))).toBe(true);
    expect(out.map((b) => b.tradeDate)).toEqual([...out.map((b) => b.tradeDate)].sort()); // 升序

    const last = out[out.length - 1];
    // 🚨 changePct 恒 null（富途给的是原始差，与本列"官方口径"语义不同 → 走读侧回退）。
    expect(last.changePct).toBeNull();
    // 🚨 prevClose 有真值 —— us 是第一个真有它的市场（cn 侧恒 null）。
    expect(Number(last.prevClose)).toBeGreaterThan(0);
    // 🚨 turnoverRate 是**分数**不是百分数（乘过 100 的话这里会 >1）。
    expect(Number(last.turnoverRate)).toBeGreaterThan(0);
    expect(Number(last.turnoverRate)).toBeLessThan(1);
    // 价格量级合理（PEP 常年 100–200 美元档）——口径被换成复权价也未必越界，故只作粗闸。
    expect(Number(last.close)).toBeGreaterThan(10);
  }, 120_000);

  it('🚨 adjust=forward/backward 在真端同样被本地拦下 (零外呼)', async () => {
    await expect(bars.getBars({ symbol: 'us:PEP', adjust: 'forward' })).rejects.toThrow(
      /只支持 adjust='none'/,
    );
  }, 30_000);

  it('🚨 富途历史视野边界实测 (p3b E35 在 trading_days 上实证滚动 10 年; kline 侧此处补验)', async () => {
    // 请求一个远超 10 年的窗口。两种结果都可接受、但**必须二选一且可分辨**:
    //   · shim 返 400「window too wide」→ 分页上限拦下 (预期的响亮失败)
    //   · 返回数据但首日晚于请求 from → 说明 vendor **静默截头**, 需在此记录实际边界
    // 🚨 绝不能是「返回了且首日 == 请求 from」—— 那意味着我们对边界的认知是错的。
    const from = `${year - 15}-01-01`;
    const to = `${year - 14}-12-31`;
    let firstDate: string | null = null;
    let refused = false;
    try {
      const out = await bars.getBars({ symbol: 'us:PEP', adjust: 'none', from, to });
      firstDate = out[0]?.tradeDate ?? null;
    } catch {
      refused = true;
    }
    // 15 年前那一整年若真能取到且从 from 开始，说明"滚动 10 年"这个认知需要复核。
    expect(refused || firstDate === null || firstDate > from).toBe(true);
  }, 180_000);
});

/**
 * 标的级 IV 真 vendor 回归网（046 T007，FR-023/FR-024）。
 *
 * 这里校真的是 mock 单测**结构上够不着**的三件事：
 * ① 20 列字段名与量纲（单测的仿真行是照 SDK docstring 抄的，抄错了自己不会知道）；
 * ② `his-vol` 的 ≤364 天单次跨度上限**仍是响亮的 400**，不是静默截断的短序列；
 * ③ **SC-005 的墙钟** —— 12 只锚一轮的真实耗时。T011/T014 那两条 hermetic IT 把 vendor 换成了
 *    mock，在那里计时测的是 mock 往返，与 5 分钟预算毫无关系；只有这里的数字算数。
 *
 * ⚠️ 与本文件其余块共用 `RUN_MARKETDATA_IT` + `FUTU_SHIM_URL` + `FUTU_SHIM_TOKEN`（同一个 shim
 * 不该有第二个门），⇒ 同样**恒 skip**：本套件全绿对上述三件事**不构成任何证据**，它们要么被手工
 * 真跑过一次，要么就是没验过。
 */

/**
 * SC-005 的「12 只锚」规模样本。锚是用户数据、库里没有固定清单 ⇒ 这里取 sellput 白名单 7 只
 * + 5 只补足规模；**本例量的是规模不是具体票**（换票不影响结论，换数量会）。
 */
const IV_ANCHORS_12 = [
  'us:PEP',
  'us:LULU',
  'us:PSKY',
  'us:CPB',
  'us:VICI',
  'us:AOS',
  'us:TAP',
  'us:KO',
  'us:MDLZ',
  'us:GIS',
  'us:JNJ',
  'us:XOM',
];

describe.skipIf(!ENABLED)('富途标的级 IV overview 真 vendor IT (env-gated, 默认 skip)', () => {
  const iv = new FutuUnderlyingIvAdapter(new VendorHttpClient(FUTU_SHIM_PROFILE), BASE, TOKEN);

  it('12 只锚一次批量调用 → IV 读数 + 字段量纲符合落库契约', async () => {
    const out = await iv.getIvSnapshots(IV_ANCHORS_12);

    // 无期权的标的整行缺席是允许的（≤ 请求数）；但缺一大半就是批量参数没被吃进去。
    expect(out.length).toBeGreaterThanOrEqual(8);
    expect(out.length).toBeLessThanOrEqual(IV_ANCHORS_12.length);
    expect(out.map((s) => s.symbol)).toContain('us:PEP');
    // 回填的是 canonical，不是 vendor 的 `US.PEP` —— 混了会让落库按错 symbol 建行。
    expect(out.every((s) => s.symbol.startsWith('us:'))).toBe(true);

    const pep = out.find((s) => s.symbol === 'us:PEP');
    // 🚨 **百分数口径**（24.8 = 24.8%，不是 0.248）。若哪天 vendor 改成分数，这里会跌破 1 而变红
    // —— 那时该改的是落库/呈现的口径注释，不是把断言放宽。
    expect(Number(pep?.iv)).toBeGreaterThan(1);
    expect(Number(pep?.iv)).toBeLessThan(300);
    // 分位是 0–100 而非 0–1（FR-035 的显示口径单源就是 ivPercentile，量纲错会让分档整体走位）。
    expect(Number(pep?.ivPercentile)).toBeGreaterThanOrEqual(0);
    expect(Number(pep?.ivPercentile)).toBeLessThanOrEqual(100);
    expect(Number(pep?.ivRank)).toBeGreaterThanOrEqual(0);
    expect(Number(pep?.ivRank)).toBeLessThanOrEqual(100);
    // HV 阶梯五档都在（单测里它们是抄来的列名，只有真端能证明名字没抄错）。
    for (const hv of [pep?.hv30, pep?.hv60, pep?.hv90, pep?.hv120, pep?.hv365]) {
      expect(Number(hv)).toBeGreaterThan(0);
    }
    // 🚨 数值一律 string 过边界（走一趟 JS number 就把 Decimal 精度丢在半路）。
    expect(typeof pep?.iv).toBe('string');
  }, 120_000);

  it('非 us symbol 在真端同样被本地拦下 (零外呼)', async () => {
    await expect(iv.getIvSnapshots(['cn:600519'])).rejects.toThrow(/不支持 symbol/);
  }, 30_000);

  it('🚨 SC-005: 12 只锚单轮墙钟 ≤5min (overview 1 次 + his-vol 尾部增量 12 次)', async () => {
    // 日更一轮的真实形状：`underlying_iv_daily` 一次批量 + `underlying_iv_history` 逐票尾增量。
    // 对照基线 `us_equity_bar` 7 票约 1 分钟。
    // ⚠️ 用例超时**必须宽于 5 分钟预算**，否则超预算时先被 vitest 判超时、断言根本轮不到跑
    //    —— 那样红的原因会写成 "timeout" 而不是 "预算破了"，两者的处置完全不同。
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

    const startedAt = Date.now();
    const snapshots = await iv.getIvSnapshots(IV_ANCHORS_12);
    for (const symbol of IV_ANCHORS_12) {
      await iv.getIvHistoryRange({ symbol, from, to });
    }
    const elapsedMs = Date.now() - startedAt;

    // 墙钟必须**被记录**而不只是被断言：破了预算时要能一眼看出是「差一点」还是「差一个量级」。
    console.log(
      `[SC-005] 12 只锚单轮墙钟 = ${(elapsedMs / 1000).toFixed(1)}s ` +
        `(overview 1 次返 ${snapshots.length} 行 + his-vol 12 次, 窗 ${from}..${to})`,
    );
    expect(elapsedMs).toBeLessThanOrEqual(5 * 60 * 1000);
  }, 480_000);
});

describe.skipIf(!ENABLED)('富途标的级 IV 历史序列真 vendor IT (env-gated, 默认 skip)', () => {
  const iv = new FutuUnderlyingIvAdapter(new VendorHttpClient(FUTU_SHIM_PROFILE), BASE, TOKEN);
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const year = new Date().getUTCFullYear();

  it('上限内的整年窗: 取到日序列 + 升序 + 字段语义符合落库契约', async () => {
    // 364 天 = shim 的单次跨度上限，正好压着边界取（证明「上限内」这一侧是通的）。
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 364 * 86_400_000).toISOString().slice(0, 10);
    const out = await iv.getIvHistoryRange({ symbol: 'us:PEP', from, to });

    // 一年约 252 个美股交易日；分页没跟到尽头 / 被截断都会远低于此。
    expect(out.length).toBeGreaterThanOrEqual(230);
    expect(out.every((p) => iso.test(p.date))).toBe(true);
    // 🚨 vendor 侧按日期**降序**下发，端口契约是升序 —— 这条是 adapter 翻正逻辑的唯一真验。
    expect(out.map((p) => p.date)).toEqual([...out.map((p) => p.date)].sort());

    const last = out[out.length - 1];
    expect(Number(last.iv)).toBeGreaterThan(1); // 百分数口径，同 overview
    expect(Number(last.hv)).toBeGreaterThan(0);
    expect(Number(last.underlyingPrice)).toBeGreaterThan(10); // PEP 常年 100–200 美元档
  }, 180_000);

  it('🚨 >364 天单次窗被 shim 以 400 拒 (响亮失败, 不是静默截短的序列)', async () => {
    // 切窗归回填侧 (`splitBackfillWindows`)，adapter 蓄意不切。这条钉的是「shim 会说出来」——
    // 若哪天它改成静默截断，回填就会以为自己拉满了 3 年、实则少了几段，且永远不会红。
    // VendorHttpError（4xx=永久）而非 TransientVendorError：被判成瞬时会一路重试到熔断。
    await expect(
      iv.getIvHistoryRange({ symbol: 'us:PEP', from: `${year - 2}-01-01`, to: `${year}-01-01` }),
    ).rejects.toBeInstanceOf(VendorHttpError);
  }, 60_000);

  it('🚨 约 3 年滑动窗深度边界仍在原处 (FR-024 「今天不拉、明年就没了」的前提)', async () => {
    // 实测 2026-07-29: US.PEP 776 行回到 2023-06-26。若 4 年前那一整年真能取到且从 from 开始，
    // 说明窗深变了 —— 那时该做的是**复核 FR-024 的回填深度**，不是删断言。
    const from = `${year - 4}-01-01`;
    const out = await iv.getIvHistoryRange({ symbol: 'us:PEP', from, to: `${year - 4}-12-31` });
    expect(out.length === 0 || out[0].date > from).toBe(true);
  }, 180_000);
});

/**
 * 047 期权链四端点真 vendor 回归网（T013，FR-039 / plan D-SHIM）。
 *
 * 校真的是三件 mock 单测**结构上够不着**的事：
 * ① 四条新路由的**真实字段名与量纲** —— 单测的仿真行是照 shim 源码 / SDK docstring 抄的，
 *    抄错了自己不会知道；
 * ② 两条**窗宽 / 批量硬约束**在真端到底落在哪一档（`option_chain` ≤30 天窗 ·
 *    `earnings-calendar` 端点差上限）—— 这两个数字在本仓是**常量**，猜宽一天的后果是整窗
 *    静默失败，猜严一天只是多付一次调用，不对称性一边倒；
 * ③ **SC-009 的墙钟与调用数** —— hermetic IT 把 vendor 换成了 mock，在那里计时测的是 mock
 *    往返，与 15 分钟预算毫无关系；只有这里的数字算数。
 *
 * ⚠️ 与本文件其余块共用 `RUN_MARKETDATA_IT` + `FUTU_SHIM_URL` + `FUTU_SHIM_TOKEN`（同一个
 * shim 不该有第二个门，tasks Guardrail 17 ②），⇒ 同样**恒 skip**：本套件全绿对上述三件事
 * **不构成任何证据**，它们要么被手工真跑过一次，要么就是没验过。
 *
 * ## 🚨 跑之前先看钟：**盘中 / 休市拿到的快照形状不同**
 *
 * 期权快照的 greeks / IV / 盘口在**美股休市时段**（ET 16:00–次日 04:00）大面积为 0 或缺失，
 * 而 OI 仍在。⇒ 断言 MUST 挂在**总体**上（「有多少行有值」），MUST NOT 挂在任意抽样行上
 * ——「抽到的那行 IV=0」在休市时段是**正常**的，把它读成产品坏了会引出一次无谓的排查。
 * 本块的断言已按此写；实测基线记在各用例里，都标了采样时刻。
 *
 * 🚨 **每个 adapter 各持自己的 `VendorHttpClient` 实例** —— 三个 capability 在 shim 侧是
 * **per-capability 限频桶**（`option_chain` 10/30 s vs `snapshot` / `earnings_calendar`
 * 60/30 s），共用一个客户端桶会让链发现与快照互吃令牌，测出来的墙钟也就不是生产形状。
 */

/**
 * SC-009 的「12 条锚」规模样本 —— 与 SC-005 共用**同一份** {@link IV_ANCHORS_12}：两条 SC 量的
 * 都是「12 条锚」这个**规模**（换票不影响结论，换数量会）。复制第二份清单只会让两处日后悄悄漂移。
 */
const ANCHORS_12 = IV_ANCHORS_12;

/**
 * 实测的 `earnings-calendar` 单窗**端点差**上限（证据见下面那条回归锚用例的注释段）。
 *
 * 🚫 这里蓄意**不引用** `EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS` —— 这是**外部事实**，那个常量
 * 是被它校准的一方（曾宽一天，拿它当窗宽则本文件的财报用例每发必 502；T019a 已校准为 6）。
 * 两者保持独立，常量哪天再被谁改宽，下面那条回归锚才照得出来。
 */
const OBSERVED_EARNINGS_MAX_ENDPOINT_DIFF = 6;

/** `YYYY-MM-DD` + n 天 → `YYYY-MM-DD`（UTC 日历，避开本机时区把日期滚错一天）。 */
function addUtcDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 定长切片（快照批切分在调用方，见 `option-snapshot.port.ts` 文件头）。 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `option_chain` 官方限频：**每 30 秒最多 10 次**（2026-08-04 复核 `openapi.futunn.com` 原文）。 */
const OPTION_CHAIN_RATE_LIMIT = 10;
/** 同上的窗口。取 31 s 而非 30 s：多等 1 秒换掉边界竞态，比撞 429 重跑一整轮便宜得多。 */
const OPTION_CHAIN_RATE_WINDOW_MS = 31_000;

/**
 * `option_chain` 的**滑动窗节流器** —— 与 shim `ratelimit.py` 的 `option_chain: (10, 30)` 同形状。
 *
 * 🚨 **这不是「绕过限频」，恰恰相反**：SC-009 要量的就是「**按官方限频节流地跑一轮要多久**」，
 * 而不是「不节流能多快打完」。不节流的裸循环 17 秒就会撞 429（实测：第 13 发、us:LULU 首窗），
 * 那时测出来的既不是墙钟也不是吞吐，只是「多久会被拒」。
 *
 * 🚫 MUST NOT 靠放宽限频 / 加重试 / 吞掉 429 让本用例变绿（Guardrail 5：10 次/30 s 是官方真值）。
 * 客户端画像 `FUTU_SHIM_OPTION_CHAIN_PROFILE` 的 `perMin: 20` **均值等价但起步是满桶**，头 30 秒
 * 能放出 20 发 ⇒ 每一轮开局必吃一次 429（其画像注释里「诚实记账」那段已预告，此处实测坐实）。
 *
 * 复杂度：每次调用 O(1) 摊还（队列长度恒 ≤ {@link OPTION_CHAIN_RATE_LIMIT}）。
 */
function createChainPacer(): () => Promise<void> {
  const firedAt: number[] = [];
  return async () => {
    if (firedAt.length >= OPTION_CHAIN_RATE_LIMIT) {
      const oldest = firedAt[firedAt.length - OPTION_CHAIN_RATE_LIMIT];
      const waitMs = oldest + OPTION_CHAIN_RATE_WINDOW_MS - Date.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    firedAt.push(Date.now());
  };
}

describe.skipIf(!ENABLED)('富途期权链四端点真 vendor IT (env-gated, 默认 skip)', () => {
  const chain = new FutuOptionChainAdapter(
    new VendorHttpClient(FUTU_SHIM_OPTION_CHAIN_PROFILE),
    BASE,
    TOKEN,
  );
  const snapshot = new FutuOptionSnapshotAdapter(
    new VendorHttpClient(FUTU_SHIM_OPTION_SNAPSHOT_PROFILE),
    BASE,
    TOKEN,
  );
  const earnings = new FutuEarningsCalendarAdapter(
    new VendorHttpClient(FUTU_SHIM_EARNINGS_CALENDAR_PROFILE),
    BASE,
    TOKEN,
  );
  const iso = /^\d{4}-\d{2}-\d{2}$/;

  it('① /option-expirations: 到期日阶梯升序 + 含 LEAPS + 字段非空', async () => {
    const out = await chain.getExpiryDates('us:PEP');

    // 实测 2026-08-07: US.PEP 15 个到期日, 2026-08-07(0DTE) → 2028-01-21(LEAPS)。
    // 下界取 5: 周度 + 月度 + 季度最少也该有这么多; 塌到 1-2 个 = 端点悄悄裁了远端
    // (而裁掉不报错, 只让那一整批腿永远采不到 —— FR-032 唯一要防的 bug 类)。
    expect(out.length).toBeGreaterThanOrEqual(5);
    expect(out.every((e) => iso.test(e.expiryDate))).toBe(true);
    // 端口契约是升序（分窗的输入; 乱序会让贪心分组静默漏掉到期日）。
    expect(out.map((e) => e.expiryDate)).toEqual([...out.map((e) => e.expiryDate)].sort());

    // 🚨 **含 LEAPS**（FR-032「不设到期日上限」的真端证据）：最远到期日必须在一年以上。
    // 若哪天只剩几个月, 说明 vendor 或 shim 开始裁远端 —— 那时该复核的是 FR-032 的成本账,
    // 不是把断言放宽。
    const farthest = out[out.length - 1].expiryDate;
    expect(farthest > addUtcDays(new Date().toISOString().slice(0, 10), 365)).toBe(true);

    // vendor 原样字段非空（`expiration_cycle` 实测 WEEK / MONTH；DTE 是 vendor 直给的自然日）。
    expect(out.every((e) => e.expirationCycle !== null && e.expirationCycle.length > 0)).toBe(true);
    // 月度档必然存在（周度可能因标的而缺，月度是期权的基础档）；全表只剩一个值 = 该列被回落了。
    expect(out.some((e) => e.expirationCycle === 'MONTH')).toBe(true);
    // 🚨 DTE **不回落 0** —— 0 的语义是「今天到期」, 与「没有值」方向相反。
    expect(out.every((e) => e.daysToExpiry !== null && e.daysToExpiry >= 0)).toBe(true);
  }, 120_000);

  it('② /option-chain: 首窗返双边合约 + 静态属性字段非空 (option_type=ALL 真端确认)', async () => {
    const expiries = await chain.getExpiryDates('us:PEP');
    const [firstWindow] = planOptionChainWindows(expiries.map((e) => e.expiryDate));
    const out = await chain.getChainWindow({
      symbol: 'us:PEP',
      start: firstWindow.start,
      end: firstWindow.end,
    });

    // 一个 ≤30 天窗内含数个到期日 × 数十行权价 × 双边 —— 实测量级在数百。塌到两位数
    // = 端点在按什么维度裁, 而裁掉的腿不可回补。
    expect(out.length).toBeGreaterThanOrEqual(50);

    // 🚨 **双边都在**（Guardrail 3 的真端证据）：链接口一次返双边、调用数完全不变, 若某天
    // 只回一边, 采集端会静默给 CALL 侧留下永久缺口, 而每次调用都成功、日志全绿。
    const types = new Set(out.map((c) => c.optionType));
    expect(types).toContain('PUT');
    expect(types).toContain('CALL');

    // 逐列非空 + 语义（与 `option_contract` 落库契约 1:1）。
    expect(out.every((c) => c.market === 'us')).toBe(true);
    // code **含市场前缀**且原样 —— 这串正是喂回 /option-snapshot 的键, 剥了再拼只会拼错。
    expect(out.every((c) => c.code.startsWith('US.'))).toBe(true);
    expect(out.every((c) => c.underlyingSymbol === 'us:PEP')).toBe(true);
    expect(out.every((c) => c.root.length > 0)).toBe(true);
    expect(out.every((c) => iso.test(c.expiryDate))).toBe(true);
    // 行权价是**正**的 Decimal-safe string（走一趟 JS number 就把精度丢在半路）。
    expect(out.every((c) => typeof c.strikePrice === 'string' && Number(c.strikePrice) > 0)).toBe(
      true,
    );
    expect(out.every((c) => c.expirationCycle !== null && c.expirationCycle.length > 0)).toBe(true);

    // 窗内到期日全部落在请求区间内（分窗边界与 vendor 实际返回同口径的唯一真验）。
    expect(
      out.every((c) => c.expiryDate >= firstWindow.start && c.expiryDate <= firstWindow.end),
    ).toBe(true);
  }, 180_000);

  it('③ /option-snapshot: 合约行 + 标的自身行同批返回 (spot 不另发调用)', async () => {
    const expiries = await chain.getExpiryDates('us:PEP');
    const [firstWindow] = planOptionChainWindows(expiries.map((e) => e.expiryDate));
    const contracts = await chain.getChainWindow({
      symbol: 'us:PEP',
      start: firstWindow.start,
      end: firstWindow.end,
    });
    const codes = contracts.slice(0, 50).map((c) => c.code);

    const batch = await snapshot.getSnapshots({
      underlyingSymbol: 'us:PEP',
      contractCodes: codes,
    });

    // 🚨 `asOf` 取自信封 `as_of` = **本批实际采集时刻**（落 `quote_as_of`）。用本机时钟顶替
    // 会把「这一行什么时候采的」变成「这段代码什么时候跑到这一句」, 链路卡顿时差得很远。
    expect(batch.asOf).toBeInstanceOf(Date);
    expect(Number.isNaN(batch.asOf.getTime())).toBe(false);
    // 采集时刻应在近期（粗闸：一天内）——恒定的远古时间戳说明 shim 在回落什么默认值。
    expect(Math.abs(Date.now() - batch.asOf.getTime())).toBeLessThan(86_400_000);

    // 🚨 **标的自身那行与期权行同批回来**（本端口不为 spot 另发一次调用）。
    const underlyingRow = batch.rows.find((r) => !r.isOption);
    expect(underlyingRow).toBeDefined();
    expect(underlyingRow?.code).toBe('US.PEP');
    // spot 来源 = 标的行的 last（PEP 常年 100–200 美元档，粗闸防口径被换）。
    expect(Number(underlyingRow?.last)).toBeGreaterThan(10);

    const optionRows = batch.rows.filter((r) => r.isOption);
    // vendor 未返回某个 code 是合法状态（停牌 / 刚摘牌），但缺一大半就是 codes 没被吃进去。
    expect(optionRows.length).toBeGreaterThanOrEqual(codes.length / 2);
    expect(optionRows.every((r) => r.underlyingCode === 'US.PEP')).toBe(true);
    // 期权行的 greeks 完整性标记**恒为 boolean**（null ⟺ 非期权行）。
    expect(optionRows.every((r) => typeof r.greeksComplete === 'boolean')).toBe(true);
    expect(underlyingRow?.greeksComplete).toBeNull();

    // 🚨 断言挂在**总体**上，不挂任意一行：整批 IV 全 0 / 全 null = 字段名抄错或 OpenD 没订阅，
    // 而**单行** IV 为 0 是合法且常见的（见下一条）。抽第一行来断言只会测到运气。
    // 实测 2026-08-07 06:22Z（美股收盘后）PEP 首窗 60 行：iv>0 41 行 / iv==0 19 行 / oi>0 53 行。
    const withPositiveIv = optionRows.filter((r) => r.iv !== null && Number(r.iv) > 0);
    // 诊断消息要能**当场分辨**两种红：休市时段的正常稀疏 vs 字段名抄错 / OpenD 没订阅。
    expect(
      withPositiveIv.length,
      `${optionRows.length} 个期权行里 IV>0 的只有 ${withPositiveIv.length} 个。` +
        `若此刻是美股休市时段(ET 16:00–次日 04:00)，稀疏属正常，请在盘中复跑再判；` +
        `若盘中仍然如此，那才是字段名抄错 / OpenD 未订阅期权行情。`,
    ).toBeGreaterThan(optionRows.length / 4);
    // 🚨 数值一律 string 过边界（走一趟 JS number 就把 Decimal 精度丢在半路）。
    expect(withPositiveIv.every((r) => typeof r.iv === 'string')).toBe(true);
    expect(optionRows.every((r) => r.delta === null || typeof r.delta === 'string')).toBe(true);

    // 🚨 **`greeksComplete === true` 并不蕴含 greeks 非零** —— 实测 `US.PEP260807C75000`
    // （0-DTE 深实值 CALL）vendor 直给 `greeks_complete: true`，而 delta/gamma/theta/vega/rho/IV
    // **全是 0**。这正是 FR-047 说的「实值腿 IV 无解」那类数学固有现象在**真端的实际形状**：
    // 它以 0 而不是 null 出现 ⇒ 下游把 0 当真值读（delta=0 = 无方向暴露）就会把一条深实值腿
    // 判成没有风险。这条断言把该现象**钉成已知事实**，防止有人把它当脏数据在采集端滤掉
    // （滤掉即永久缺口，且覆盖率分母跟着少一个、缺口自我掩盖）。
    const complete = optionRows.filter((r) => r.greeksComplete === true);
    const zeroGreeksButComplete = complete.filter((r) => Number(r.iv) === 0);
    console.log(
      `[T013] /option-snapshot 采样 ${batch.asOf.toISOString()}: 期权行 ${optionRows.length}, ` +
        `IV>0 ${withPositiveIv.length}, greeksComplete ${complete.length}, ` +
        `其中 greeks 全 0 的 ${zeroGreeksButComplete.length} 行`,
    );
    // 🚨 `greeksComplete === true` 的**耐久语义 = 六个字段都在**（不是「都非零」）。这条才是
    // 跨时段成立的不变量；零值行数随时段与标的浮动，只记录不断言（断言它会变成时段抽奖）。
    expect(complete.every((r) => r.iv !== null && r.delta !== null && r.gamma !== null)).toBe(true);

    // OI 是逐日快照的承重列（FR-030）—— 整批缺失会让下游的流动性判据静默失效。
    expect(optionRows.filter((r) => r.openInterest !== null).length).toBeGreaterThan(
      optionRows.length / 2,
    );
    expect(optionRows.some((r) => r.bid !== null && r.ask !== null)).toBe(true);
  }, 240_000);

  it('④ /earnings-calendar: 市场级窗返全市场事件 + 字段非空', async () => {
    // 🚨 窗宽取**实测可用**的端点差（见下一条用例：真实上限是 6，不是常量写的 7）。
    const start = new Date().toISOString().slice(0, 10);
    const out = await earnings.getWindow({
      market: 'us',
      start,
      end: addUtcDays(start, OBSERVED_EARNINGS_MAX_ENDPOINT_DIFF),
    });

    // 🚨 **市场级**：一发返该市场窗内全部标的（实测 2026-08-07 起 7 天 = 877 条）。
    // 若返回量塌到两位数, 说明谁在某处偷偷加了 `filter_list` —— 而 PIT 三件套
    // (`first_seen_at` / `date_changed_at` / 变更前日期) 只有连续观察全市场才成立。
    expect(out.length).toBeGreaterThan(50);
    // 全市场 ⇒ 必然含 `Instrument` 表里没有的标的，这是预期状态（处置在 use case，不在端口）。
    // ⚠️ 蓄意**不断言 symbol 唯一**：同一标的在一个窗内出现两条（改期 / 跨报告期）是允许的。
    expect(out.every((e) => e.underlyingSymbol.startsWith('us:'))).toBe(true);
    expect(out.every((e) => iso.test(e.earningsDate))).toBe(true);
    expect(out.every((e) => e.earningsDate >= start)).toBe(true);
    // pubType **vendor 原样**（实测值域 BEFORE / AFTER / REGULAR）——归一成自造枚举一次,
    // 就再也说不清库里那个值是谁的口径。缓冲判定该怎么读它是 T026 的事。
    expect(out.every((e) => ['BEFORE', 'AFTER', 'REGULAR'].includes(e.pubType))).toBe(true);
    // 报告期文本 + EPS 预估至少在一部分行上有值（整列全 null = 字段名抄错）。
    expect(out.some((e) => e.periodText !== null && e.periodText.length > 0)).toBe(true);
    expect(out.some((e) => e.epsPredict !== null)).toBe(true);
  }, 180_000);

  it('🚨 /earnings-calendar 真实窗宽上限 = 端点差 6，不是常量写的 7 (已知缺陷的回归锚)', async () => {
    // ── 实测证据（2026-08-07，经 77 → wg1 打真 shim）───────────────────────────────
    //   端点差 5 / 6 → 200；端点差 7 → **502 `NN_ProtoRet_SvrFailed`**；端点差 8 → shim 自己
    //   的 400「window too wide」。差 7 在 **3 个相隔一个多月的 start（08-07 / 09-02 /
    //   10-19）上 3/3 复现**，不是抖动。
    //   ⇒ vendor 原文「与 beginDate 间隔不超过 7 天」说的是**含首尾的 7 天窗**（端点差 ≤6），
    //     而 `EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS = 7` 按**端点差**读，宽了整一天。
    //
    // ✅ **已修（T019a，2026-08-07）**：曾经 `planEarningsWindows` 发出的**每一个**窗都是
    //    `end = start + 7`（端点差恰好 7）⇒ 生产的财报采集**窗窗 502**，而 502 映射成瞬时错误
    //    ⇒ 一路重试 / 顺延，永远不会以「参数错」的形状说出来。常量已改 6，窗序列 26 → 31 窗
    //    （末窗夹紧到视野末端），单测按常量参数化跟着走；财报是市场级 60/30 s 限频，+5 次可忽略。
    // ✅ **挂账已清（2026-08-08）**：shim 侧 `EARNINGS_MAX_SPAN_DAYS` 也已 7 → 6 ⇒ 端点差 7 现在
    //    **在 shim 就 400**，不再漏到 vendor 变 502。同日复测把采样面从 08-07 那次的 5/6/7/8 扩到
    //    **0–8 全扫 × 3 个 start**（0–6 全 200 且 count 单调递增 ⇒ 窄窗未被静默裁剪），并加了两条
    //    此前没有的对照：**HK 同样 diff 7 → 502**（上限与市场无关）；**吃完 502 后回打 diff 6 仍
    //    200 且 count 与首发一致**（⇒ 该 502 是确定性参数拒绝，不是把端点打坏了的瞬时故障）。
    //
    // 本断言的**耐久形状**：端点差 7「不可用」。今天不可用是因为 vendor 502；常量修成 6 之后
    // 不可用是因为 adapter 本地前置拒绝（零外呼）。两种都 throw ⇒ 修复不会把这条弄红，
    // 而**vendor 哪天真放宽到 7**会让它红 —— 那时该做的是复核常量，不是删断言。
    expect(EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS).toBeGreaterThanOrEqual(
      OBSERVED_EARNINGS_MAX_ENDPOINT_DIFF,
    );
    const start = new Date().toISOString().slice(0, 10);
    await expect(
      earnings.getWindow({ market: 'us', start, end: addUtcDays(start, 7) }),
    ).rejects.toThrow();
  }, 180_000);

  it('非 us 在真端同样被本地拦下 (零外呼)', async () => {
    const start = new Date().toISOString().slice(0, 10);
    await expect(chain.getExpiryDates('cn:600519')).rejects.toThrow(/仅承担 us/);
    await expect(
      snapshot.getSnapshots({ underlyingSymbol: 'cn:600519', contractCodes: ['CN.X'] }),
    ).rejects.toThrow(/仅承担 us/);
    await expect(
      earnings.getWindow({ market: 'cn', start, end: addUtcDays(start, 5) }),
    ).rejects.toThrow(/仅承担 us/);
  }, 60_000);
});

/**
 * SC-009 的墙钟与调用数（T013）。
 *
 * 量的是**日更一轮的真实形状**：12 条锚 → 逐票「1 次到期日阶梯 + N 次 ≤30 天窗链调用」→
 * 全量合约按 ≤399/批取快照。三件事一起落在这一条用例里，因为它们本就是同一轮：
 *
 * ① **墙钟**对照 SC-009 的 15 分钟门；
 * ② **实际调用次数**校验 plan「10–14 次/票」的估算；
 * ③ **gap check** —— 已发现合约的到期日集合 vs vendor 权威列表。它是「腿静默消失」这一整类
 *    无声 bug 的唯一对表：分窗与链调用**全都会成功**，除了这条差集没有任何东西会发现它。
 *
 * ⚠️ 用例超时**必须宽于 15 分钟预算**，否则超预算时先被 vitest 判超时、断言根本轮不到跑
 * —— 那样红的原因会写成 "timeout" 而不是「预算破了」，两者的处置完全不同。
 */
describe.skipIf(!ENABLED)('SC-009 12 条锚链发现单轮墙钟 (env-gated, 默认 skip)', () => {
  // 各 capability 各持自己的桶（生产形状），且与上面的契约块不共享 —— 那几发不该算进本轮墙钟。
  const chain = new FutuOptionChainAdapter(
    new VendorHttpClient(FUTU_SHIM_OPTION_CHAIN_PROFILE),
    BASE,
    TOKEN,
  );
  const snapshot = new FutuOptionSnapshotAdapter(
    new VendorHttpClient(FUTU_SHIM_OPTION_SNAPSHOT_PROFILE),
    BASE,
    TOKEN,
  );

  it('🚨 SC-009: 12 条锚单轮墙钟 ≤15min + 逐票调用数 + 到期日 gap check', async () => {
    // 🚨 先空转一个限频窗，**再**开始计时：同文件前面的四端点契约块刚烧掉几个 `option_chain`
    // 令牌，不等它们滑出窗口就开跑，头一波必撞 429。等待不计入墙钟 —— 它是测试自身的产物，
    // 生产的日更一轮开跑时桶本来就是空的。
    await new Promise((resolve) => setTimeout(resolve, OPTION_CHAIN_RATE_WINDOW_MS));

    const startedAt = Date.now();
    let expiryCalls = 0;
    let chainCalls = 0;
    let snapshotCalls = 0;
    const perTicker: string[] = [];
    const gapFailures: string[] = [];
    const discoveredPerTicker: { symbol: string; codes: string[] }[] = [];
    // 🚨 节流器**跨票共享**：shim 的限频桶是 per-capability 的全局桶，不是 per-code。
    // 每票各起一个 = 12 倍超发，开局就 429。
    const paceChainCall = createChainPacer();

    // ── 阶段 1: 链发现（到期日阶梯 → 贪心分窗 → 逐窗取链）──────────────────────────
    for (const symbol of ANCHORS_12) {
      const expiries = await chain.getExpiryDates(symbol);
      expiryCalls += 1;
      const expiryDates = expiries.map((e) => e.expiryDate);
      const windows = planOptionChainWindows(expiryDates);

      const codes: string[] = [];
      const discoveredExpiries = new Set<string>();
      for (const w of windows) {
        await paceChainCall();
        const contracts = await chain.getChainWindow({ symbol, start: w.start, end: w.end });
        chainCalls += 1;
        for (const c of contracts) {
          codes.push(c.code);
          discoveredExpiries.add(c.expiryDate);
        }
      }

      // 跑完 MUST 对表（plan D-DATA-2）——差集非空 = 某个到期日的整批腿没被任何请求问起。
      const gap = gapCheckExpiryDates([...discoveredExpiries], expiryDates);
      if (!gap.ok) {
        gapFailures.push(
          `${symbol}: 权威有但未发现=${JSON.stringify(gap.missingFromDiscovered)} ` +
            `发现了但不在权威列表=${JSON.stringify(gap.unexpectedInDiscovered)}`,
        );
      }
      perTicker.push(
        `${symbol} ${1 + windows.length} 次 (1 exp + ${windows.length} chain), ` +
          `${expiryDates.length} 到期日 → ${codes.length} 合约`,
      );
      discoveredPerTicker.push({ symbol, codes });
    }
    const chainPhaseMs = Date.now() - startedAt;

    // ── 阶段 2: 快照（每票按 ≤399 合约一批，标的自身占第 400 个位）───────────────────
    let snapshotRows = 0;
    for (const { symbol, codes } of discoveredPerTicker) {
      for (const batch of chunk(codes, OPTION_SNAPSHOT_MAX_CONTRACT_CODES)) {
        const out = await snapshot.getSnapshots({ underlyingSymbol: symbol, contractCodes: batch });
        snapshotCalls += 1;
        snapshotRows += out.rows.length;
      }
    }

    const elapsedMs = Date.now() - startedAt;
    const totalCalls = expiryCalls + chainCalls + snapshotCalls;

    // 墙钟与调用数必须**被记录**而不只是被断言：破了预算时要能一眼看出是「差一点」还是
    // 「差一个量级」，以及是链发现还是快照吃掉的。
    console.log(
      `[SC-009] 12 条锚单轮墙钟 = ${(elapsedMs / 1000).toFixed(1)}s ` +
        `(链发现 ${(chainPhaseMs / 1000).toFixed(1)}s + 快照 ${((elapsedMs - chainPhaseMs) / 1000).toFixed(1)}s)\n` +
        `[SC-009] 调用数合计 ${totalCalls} = 到期日 ${expiryCalls} + 链 ${chainCalls} + 快照 ${snapshotCalls}\n` +
        `[SC-009] 链发现调用数/票 = ${((expiryCalls + chainCalls) / ANCHORS_12.length).toFixed(1)} ` +
        `(plan 估 10–14)\n` +
        `[SC-009] 快照行数 ${snapshotRows}\n` +
        perTicker.map((l) => `  · ${l}`).join('\n'),
    );

    // 🚨 gap check 先断言：一轮采集「快但漏」比「慢而全」严重得多，别让墙钟绿盖过缺口。
    expect(gapFailures).toEqual([]);
    // 每票至少发一次到期日 + 一次链调用，且真取到了合约（空轮会让墙钟假绿）。
    expect(expiryCalls).toBe(ANCHORS_12.length);
    expect(chainCalls).toBeGreaterThanOrEqual(ANCHORS_12.length);
    expect(discoveredPerTicker.every((t) => t.codes.length > 0)).toBe(true);
    expect(snapshotRows).toBeGreaterThan(0);

    // 🚨 逐票调用数是**结构性事实**，两侧都必须响：塌到 1 次/票 = 贪心分窗把远端到期日
    // 整批丢了（FR-032 唯一要防的 bug 类，而每次调用都成功、日志全绿）；显著冲高 =
    // 到期日阶梯变密，SC-009 的预算账要重算。
    // 实测基线 2026-08-07（12 票，经 77 → wg1 打真 shim）：合计 98 次 = 12 exp + 86 chain，
    // **5–11 次/票、均值 8.2**（PEP 15 个到期日 → 8 窗；XOM 17 个 → 10 窗）。
    // ⇒ plan 估的「10–14 次/票 ⇒ 120–170 次」**偏高约 40%**：远端到期日稀疏且相邻 28 天的
    // 能并进同一个 ≤30 天窗，贪心分组把整段 LEAPS 压成了每段 1 窗。
    // 下界 2 / 上界 14 是给自然增减留量，不是放水 —— plan 上界仍是这条的上界。
    const callsPerTicker = (expiryCalls + chainCalls) / ANCHORS_12.length;
    expect(callsPerTicker).toBeGreaterThan(2);
    expect(callsPerTicker).toBeLessThanOrEqual(14);

    expect(elapsedMs).toBeLessThanOrEqual(15 * 60 * 1000);
  }, 1_500_000);
});
