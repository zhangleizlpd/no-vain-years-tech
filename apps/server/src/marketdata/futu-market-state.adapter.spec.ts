import { Logger } from '@nestjs/common';
import { describe, it, expect, vi } from 'vitest';
import { FutuMarketStateAdapter, MARKET_STATE_CACHE_TTL_MS } from './futu-market-state.adapter.js';
import type { VendorHttpClient, VendorRequest } from './vendor-http-client.js';

/**
 * 富途市场时段 adapter mock 单测 (061 T004)。
 *
 * 仿真 payload **逐字段照 shim 的实测形态** (`services/futu-shim/tests/test_app.py` 的
 * `_global_state_payload`, 即 `get_global_state()` 直出的 SDK dict, 与官方文档 v10.10
 * 的 Example 同源)。
 *
 * 真端点契约由真跑校真 (061 T018 美股盘中实证) —— ⚠️ 本文件全绿**不**构成真契约的证据,
 * 它只钉住「拿到这份形状之后我们怎么判」。
 */
const BASE = 'http://10.89.0.1:8811';
const TOKEN = 'test-shim-token';

/** `/market-state` 的一行全局状态 (照 shim pytest 的 `_global_state_payload`)。 */
function globalState(extra: Record<string, unknown> = {}) {
  return {
    market_sz: 'MORNING',
    market_sh: 'MORNING',
    market_hk: 'MORNING',
    market_us: 'AFTER_HOURS_END',
    market_hkfuture: 'FUTURE_DAY_OPEN',
    market_usfuture: 'FUTURE_OPEN',
    server_ver: '504',
    trd_logined: true,
    qot_logined: true,
    timestamp: '1620962951',
    local_timestamp: 1620962951.047128,
    program_status_type: 'READY',
    program_status_desc: '',
    ...extra,
  };
}

function makeShim(rows: unknown[], countOverride?: number) {
  const calls: { url: string; auth: string | undefined }[] = [];
  const request = vi.fn(async (req: VendorRequest) => {
    calls.push({ url: req.url, auth: req.headers?.Authorization });
    return { as_of: '2026-08-17T13:19:48+00:00', count: countOverride ?? rows.length, rows };
  });
  return { http: { request } as unknown as VendorHttpClient, calls, request };
}

/** 每次调用直接抛 `err` 的假 transport。 */
function makeThrowingShim(err: unknown) {
  const request = vi.fn(async () => {
    throw err;
  });
  return { http: { request } as unknown as VendorHttpClient, request };
}

const makeAdapter = (http: VendorHttpClient) => new FutuMarketStateAdapter(http, BASE, TOKEN);

/** 归一结果按 market 查表 —— 顺序不是契约, 别让断言依赖它。 */
const sessionOf = (states: { market: string; session: string }[], market: string) =>
  states.find((s) => s.market === market)?.session;

const spyWarn = () => vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

describe('FutuMarketStateAdapter', () => {
  describe('调用形态', () => {
    it('GET <shim>/market-state + Bearer, 一发返回全部已登记市场 (无 market 入参)', async () => {
      const { http, calls } = makeShim([globalState()]);
      const states = await makeAdapter(http).getMarketSessions();

      expect(calls).toHaveLength(1);
      const url = new URL(calls[0].url);
      expect(url.pathname).toBe('/market-state');
      expect([...url.searchParams.keys()]).toEqual([]); // 市场级接口: 没有任何查询参数
      expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
      // 一发拿全集 —— 上游按 market 查表, 不为每个市场各打一发。
      expect(states.map((s) => s.market).sort()).toEqual(['hk', 'us']);
    });
  });

  describe('白名单归一 (FR-002)', () => {
    it.each([['MORNING'], ['AFTERNOON']])(
      '白名单内的 %s → regular (午休分段的市场上下午各一个值, 无午休的市场只出现其一)',
      async (raw) => {
        const { http } = makeShim([globalState({ market_us: raw })]);
        const states = await makeAdapter(http).getMarketSessions();
        expect(sessionOf(states, 'us')).toBe('regular');
      },
    );

    it.each([
      ['PRE_MARKET_BEGIN'],
      ['PRE_MARKET_END'],
      ['AFTER_HOURS_BEGIN'],
      ['AFTER_HOURS_END'],
      ['NIGHT_OPEN'],
      ['OVERNIGHT'],
      ['AUCTION'],
      ['WAITING_OPEN'],
      ['REST'],
      ['CLOSED'],
    ])('白名单外的已知状态 %s → other, 不采', async (raw) => {
      const { http } = makeShim([globalState({ market_us: raw })]);
      const states = await makeAdapter(http).getMarketSessions();
      expect(sessionOf(states, 'us')).toBe('other');
    });

    it('🚨 反例: 没见过的状态串 → unknown, 且 MUST NOT 静默归到 other', async () => {
      // 这条是**黑名单实现的照妖镜**: 写成「不是 CLOSED 就算 regular」时它得到 regular;
      // 写成「不在白名单就都算 other」时它得到 other。两种都当场红。
      const { http } = makeShim([globalState({ market_us: 'SOMETHING_NEW' })]);
      const warn = spyWarn();
      const states = await makeAdapter(http).getMarketSessions();

      expect(sessionOf(states, 'us')).toBe('unknown');
      expect(sessionOf(states, 'us')).not.toBe('other');
      warn.mockRestore();
    });

    it('未知状态必须留痕 —— vendor 值域扩充时我们要看得见', async () => {
      // 不落日志的话, vendor 哪天新增一个**本该算常规时段**的值, 表现是「那个时段从此不采」
      // 且无人知晓 —— 一个静默的、只在特定时段发作的数据缺口。
      const { http } = makeShim([globalState({ market_us: 'SOMETHING_NEW' })]);
      const warn = spyWarn();
      await makeAdapter(http).getMarketSessions();

      const messages = warn.mock.calls.map((args) => String(args[0]));
      expect(messages.some((m) => m.includes('SOMETHING_NEW') && m.includes('us'))).toBe(true);
      warn.mockRestore();
    });

    it('各市场独立归一 —— us 常规时段不会把 hk 的闭市也说成开市', async () => {
      const { http } = makeShim([globalState({ market_us: 'MORNING', market_hk: 'CLOSED' })]);
      const states = await makeAdapter(http).getMarketSessions();

      expect(sessionOf(states, 'us')).toBe('regular');
      expect(sessionOf(states, 'hk')).toBe('other');
    });

    it('cn 刻意不在值域内 (vendor 用 sh + sz 两个字段表达一个 canonical market)', async () => {
      const { http } = makeShim([globalState()]);
      const states = await makeAdapter(http).getMarketSessions();
      expect(sessionOf(states, 'cn')).toBeUndefined();
    });
  });

  // ── 066 T10: 港股盘中采价的**唯一**闸就在这一层 (FR-003, plan §A7) ────────────────
  /**
   * 🚨 **午休 / 提前收盘挡在这儿, 不在本地时段表**: `market-session.rules.ts` 把港股登记成
   * **含午休的单段** `[09:30, 16:00]` —— 那是补数闸要的语义, 盘中采价**根本不读那张表** ⇒
   * MUST NOT 为了午休去把它拆两段 (066 tasks.md 排序铁律 6)。
   */
  describe('066 T10 港股时段 (state_branches 16 / 17 / 19)', () => {
    it.each([['MORNING'], ['AFTERNOON']])(
      '港股连续竞价 %s → regular, 准采 (state_branches 16; 有午休的市场上下午各出现一个值)',
      async (raw) => {
        const { http } = makeShim([globalState({ market_hk: raw })]);
        const states = await makeAdapter(http).getMarketSessions();
        expect(sessionOf(states, 'hk')).toBe('regular');
      },
    );

    it('🚨 港股午休 → vendor 报 REST ⇒ 归一成 other ⇒ 不采 (state_branches 17)', async () => {
      const { http } = makeShim([globalState({ market_hk: 'REST' })]);
      const states = await makeAdapter(http).getMarketSessions();

      expect(sessionOf(states, 'hk')).toBe('other');
      // 反向也钉住: 午休**不得**被当成常规时段, 否则午休盘口会被标成盘中价写进锚表。
      expect(sessionOf(states, 'hk')).not.toBe('regular');
    });

    it.each([['REST'], ['CLOSED'], ['HK_CAS']])(
      '⚠️ 半日市当天下午: 供应方报 %s 一律不采 (state_branches 19)',
      async (raw) => {
        // 🚨 **未实测**: 港股半日市 12:00 提前收盘之后供应方到底报哪个状态, 本机够不到 vendor,
        // 待 T15 在真锚上收口。⇒ 这里**不得**凭推断写一条「半日市 = CLOSED」的绿断言。
        // 今天能断死的只有归一这一层: 只要不是 MORNING / AFTERNOON 就不采, 而三个候选值
        // (午休 REST / 收市 CLOSED / 收市竞价 HK_CAS) 归一后全是 other。
        const { http } = makeShim([globalState({ market_hk: raw })]);
        const states = await makeAdapter(http).getMarketSessions();
        expect(sessionOf(states, 'hk')).toBe('other');
      },
    );
  });

  describe('取不到状态 → 抛 (FR-003, state_branch 4)', () => {
    it('端点不可达 → 原样上抛, MUST NOT 吞成空数组', async () => {
      // 空数组会被上游读成「取到了, 只是没有市场」⇒ 不采但也不计失败 ⇒ 真故障永不显形。
      const boom = new Error('connect ECONNREFUSED');
      const { http } = makeThrowingShim(boom);
      await expect(makeAdapter(http).getMarketSessions()).rejects.toThrow(boom);
    });

    it('响应缺已登记市场的字段 → 抛 (契约变更, 不是「值域变了」)', async () => {
      const withoutUs: Record<string, unknown> = { ...globalState() };
      delete withoutUs.market_us;
      const { http } = makeShim([withoutUs]);
      await expect(makeAdapter(http).getMarketSessions()).rejects.toThrow(/market_us/);
    });

    it('字段在但不是非空字符串 → 抛', async () => {
      const { http } = makeShim([globalState({ market_us: null })]);
      await expect(makeAdapter(http).getMarketSessions()).rejects.toThrow(/market_us/);
    });

    it('信封不是恰好一行全局状态 → 抛', async () => {
      const empty = makeShim([]);
      await expect(makeAdapter(empty.http).getMarketSessions()).rejects.toThrow(/一行/);

      const doubled = makeShim([globalState(), globalState()]);
      await expect(makeAdapter(doubled.http).getMarketSessions()).rejects.toThrow(/一行/);
    });
  });
});

/**
 * 取值缓存 + single-flight（064 T013 期实证后补，见 adapter 类注释「为什么要有这一层」）。
 *
 * 🚨 判据是**对 transport 的调用次数**，不是「返回值对不对」—— 缓存坏掉时返回值照样对，
 *    只是每一发都打了 vendor，而那正是把 10 发/30 秒配额打爆、让请求静默排队十几秒的病灶。
 */
describe('FutuMarketStateAdapter · 取值缓存 + single-flight', () => {
  /** 可手动放行的假 transport —— 用来制造「第一发还在途中，第二发就来了」。 */
  function makeDeferredShim() {
    const pending: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
    const request = vi.fn(
      () =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    );
    const settleLast = (rows: unknown[]) =>
      pending[pending.length - 1].resolve({
        as_of: '2026-08-19T13:31:00+00:00',
        count: rows.length,
        rows,
      });
    const rejectLast = (err: unknown) => pending[pending.length - 1].reject(err);
    return { http: { request } as unknown as VendorHttpClient, request, settleLast, rejectLast };
  }

  /** 可控时钟 —— 同 `VendorRateLimiter` 的注入范式，🚫 不用 fake timers（这里没有定时器）。 */
  function makeClock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it('TTL 内的重复调用零外呼（配额是 10 发/30 秒，每发都打就会静默排队）', async () => {
    const { http, request } = makeShim([globalState()]);
    const clock = makeClock();
    const adapter = new FutuMarketStateAdapter(http, BASE, TOKEN, clock.now);

    const first = await adapter.getMarketSessions();
    clock.advance(MARKET_STATE_CACHE_TTL_MS - 1);
    const second = await adapter.getMarketSessions();

    expect(request).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('TTL 过期后重新取（🚨 反例：缓存恒不过期会把收盘那一刻的切换永久钉住）', async () => {
    const { http, request } = makeShim([globalState()]);
    const clock = makeClock();
    const adapter = new FutuMarketStateAdapter(http, BASE, TOKEN, clock.now);

    await adapter.getMarketSessions();
    clock.advance(MARKET_STATE_CACHE_TTL_MS);
    await adapter.getMarketSessions();

    expect(request).toHaveBeenCalledTimes(2);
  });

  it('🚨 single-flight：冷缓存下并发 5 发 → 只打 vendor 1 次，5 个调用方拿到同一份', async () => {
    const { http, request, settleLast } = makeDeferredShim();
    const adapter = new FutuMarketStateAdapter(http, BASE, TOKEN, makeClock().now);

    // 🚨 全部在第一发落定**之前**发出 —— 纯 TTL 缓存在这一格是不设防的（都还没写进缓存）。
    const inFlight = Array.from({ length: 5 }, () => adapter.getMarketSessions());
    settleLast([globalState()]);
    const results = await Promise.all(inFlight);

    expect(request).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it('🚨 失败不进缓存：抛了之后下一发立刻真打（否则一次抖动被钉死整个 TTL）', async () => {
    const { http, request } = makeThrowingShim(new Error('boom'));
    const clock = makeClock();
    const adapter = new FutuMarketStateAdapter(http, BASE, TOKEN, clock.now);

    await expect(adapter.getMarketSessions()).rejects.toThrow(/boom/);
    await expect(adapter.getMarketSessions()).rejects.toThrow(/boom/);

    expect(request).toHaveBeenCalledTimes(2);
  });

  it('🚨 并发失败时每个等待者都收到错误（🚫 不许有人拿到 undefined 当成「闸开着」）', async () => {
    const { http, rejectLast } = makeDeferredShim();
    const adapter = new FutuMarketStateAdapter(http, BASE, TOKEN, makeClock().now);

    const waiters = Array.from({ length: 3 }, () => adapter.getMarketSessions());
    // 🚨 先挂上 catch 再 reject —— 否则 Node 会把尚未被 await 的那两个记成 unhandled rejection。
    const settled = waiters.map((p) =>
      p.then(() => 'resolved' as const).catch(() => 'rejected' as const),
    );
    rejectLast(new Error('boom'));

    expect(await Promise.all(settled)).toEqual(['rejected', 'rejected', 'rejected']);
  });
});
