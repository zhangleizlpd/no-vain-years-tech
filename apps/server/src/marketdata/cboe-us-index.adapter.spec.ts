import { describe, expect, it, vi } from 'vitest';
import { CboeCsvHeaderError } from './cboe-index-csv.rules.js';
import { CBOE_PROFILE } from './cboe.constraint-profile.js';
import {
  CBOE_HISTORY_CSV_BASE_URL,
  CBOE_HISTORY_CSV_URLS,
  CboeUsIndexAdapter,
} from './cboe-us-index.adapter.js';
import { US_INDEX_CODES } from './us-index.port.js';
import { TransientVendorError, VendorHttpClient, VendorHttpError } from './vendor-http-client.js';

/**
 * CBOE 指数 adapter 单测 (046 T012)。
 *
 * 打的是**真 `VendorHttpClient` + 假 fetch**（不是把整个 client mock 掉）—— 本条通路的
 * 新东西恰恰在传输层: 它是全仓第一个**非 JSON** 的 vendor 响应, 走 `requestText()`。把
 * client 整个替掉就把被测面抽走了, 4xx/5xx 的错误映射也只剩「我 mock 它抛什么它就抛什么」。
 *
 * 仿真 CSV 逐字段照 2026-08-02 在 77 上实拉的形态: VIX 表头 `DATE,OPEN,HIGH,LOW,CLOSE`、
 * VVIX 表头 `DATE,VVIX`（**只有 CLOSE**）、日期 `MM/DD/YYYY`、尾部有空行。
 */

/** VIX 官方历史文件片段（四列齐全）。 */
const VIX_CSV = [
  'DATE,OPEN,HIGH,LOW,CLOSE',
  '07/30/2026,15.2100,15.9800,14.8700,15.4300',
  '07/31/2026,15.4000,16.1200,15.0500,15.8800',
  '', // 源文件尾部有换行 —— 空白行不是坏数据, 不计 skipped
].join('\n');

/** VVIX 官方历史文件片段（单值列, 无 OHLC）。 */
const VVIX_CSV = ['DATE,VVIX', '07/30/2026,92.310000', '07/31/2026,94.070000', ''].join('\n');

type CsvByUrl = Record<string, string>;

/**
 * 可编程假 fetch: 按 URL 返 CSV 文本, 记录每次实际请求的 URL。
 *
 * 🚨 `json()` 蓄意**抛错而不是返占位**: 它是一条断言 —— adapter 若退回 `request<T>()`
 * 走 JSON 通道会当场炸, 而不是悄悄拿到一个空对象。
 */
function makeCsvFetch(bodyByUrl: CsvByUrl, status = 200) {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    calls.push(url);
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async (): Promise<unknown> => {
        throw new Error('CBOE 历史文件是 CSV, 不该走 json()');
      },
      text: async () => bodyByUrl[url] ?? '',
    };
  });
  return { fetch, calls };
}

const BOTH_FILES: CsvByUrl = {
  [CBOE_HISTORY_CSV_URLS.VIX]: VIX_CSV,
  [CBOE_HISTORY_CSV_URLS.VVIX]: VVIX_CSV,
};

type FakeFetch = ReturnType<typeof makeCsvFetch>['fetch'];

/**
 * 打真 `VendorHttpClient` + 假 fetch，并把限频排空到被测面之外（它归
 * `dual-window-rate-limiter.spec.ts` 管，不在这条通路的验证责任里）。
 *
 * 🚨 **`sleep` 注 no-op 时必须同时注一个会前进的 `now`**：`DualWindowRateLimiter.acquireOne`
 * 是 `for(;;) { refill(now()); if (ok) break; await sleep(wait) }` —— sleep 空转而虚拟时钟
 * 不动 ⇒ 令牌永远补不上 ⇒ **无限忙等**（CBOE profile `perSec:1`，第 2 个请求就撞上）。
 * 这行注释是踩出来的：只注 no-op sleep 会让整个 vitest 进程静默挂死，不报错、不超时。
 * 每次读时钟跳 1 分钟 ⇒ 两窗恒补满 ⇒ 一次都不 sleep。
 */
function makeAdapter(fetch: FakeFetch): CboeUsIndexAdapter {
  let clockMs = Date.parse('2026-08-02T00:00:00Z');
  return new CboeUsIndexAdapter(
    new VendorHttpClient(CBOE_PROFILE, {
      fetch,
      sleep: async () => {},
      now: () => (clockMs += 60_000),
    }),
  );
}

describe('CboeUsIndexAdapter', () => {
  describe('官方历史 CSV 解析', () => {
    it('VIX: 打官方历史文件 URL, 四列 OHLC 原样字符串直通 (禁过 Number)', async () => {
      const { fetch, calls } = makeCsvFetch(BOTH_FILES);
      const out = await makeAdapter(fetch).getIndexHistory('VIX');

      expect(calls).toEqual([CBOE_HISTORY_CSV_URLS.VIX]);
      expect(out.indexCode).toBe('VIX');
      expect(out.rows).toEqual([
        { date: '2026-07-30', open: '15.2100', high: '15.9800', low: '14.8700', close: '15.4300' },
        { date: '2026-07-31', open: '15.4000', high: '16.1200', low: '15.0500', close: '15.8800' },
      ]);
      expect(out.skipped).toBe(0);
    });

    it('🚨 VVIX: 只有 CLOSE, 其余 OHLC 为 null **不为 0** (Guardrail 7 / FR-025)', async () => {
      const { fetch, calls } = makeCsvFetch(BOTH_FILES);
      const out = await makeAdapter(fetch).getIndexHistory('VVIX');

      expect(calls).toEqual([CBOE_HISTORY_CSV_URLS.VVIX]);
      expect(out.rows).toEqual([
        { date: '2026-07-30', open: null, high: null, low: null, close: '92.310000' },
        { date: '2026-07-31', open: null, high: null, low: null, close: '94.070000' },
      ]);
      // 填 0 会让「VVIX 开盘 0」这种假事实进库, 且下游分不出「无此列」与「真是 0」。
      for (const row of out.rows) {
        expect([row.open, row.high, row.low]).not.toContain('0');
      }
    });

    it('非法行**跳过并计数**, 计数与样本随返回值上抛 (禁静默丢 → 采集侧进 SyncRun 统计)', async () => {
      const dirty = [
        'DATE,OPEN,HIGH,LOW,CLOSE',
        '07/30/2026,15.2100,15.9800,14.8700,15.4300',
        '13/45/2026,1,2,3,4', // 日期不存在
        '07/31/2026,15.4000,16.1200,15.0500,n/a', // close 非数值 ⇒ 整行跳过, 不落半行
        '',
      ].join('\n');
      const { fetch } = makeCsvFetch({ [CBOE_HISTORY_CSV_URLS.VIX]: dirty });

      const out = await makeAdapter(fetch).getIndexHistory('VIX');
      expect(out.rows.map((r) => r.date)).toEqual(['2026-07-30']);
      expect(out.skipped).toBe(2);
      expect(out.skippedSamples).toEqual([
        '13/45/2026,1,2,3,4',
        '07/31/2026,15.4000,16.1200,15.0500,n/a',
      ]);
    });

    it('表头变更 → CboeCsvHeaderError 上抛 (vendor 改格式 = 硬信号, adapter 不吞不降级)', async () => {
      const { fetch } = makeCsvFetch({
        [CBOE_HISTORY_CSV_URLS.VIX]: 'DATE,OPEN,HIGH,LOW,CLOSE,SETTLE\n07/31/2026,1,2,3,4,5\n',
      });
      await expect(makeAdapter(fetch).getIndexHistory('VIX')).rejects.toBeInstanceOf(
        CboeCsvHeaderError,
      );
    });
  });

  describe('vendor 错误映射 (不自造分类, 只负责不吞)', () => {
    it('HTTP 404 → VendorHttpError (永久错, 不重试)', async () => {
      const { fetch, calls } = makeCsvFetch({}, 404);
      await expect(makeAdapter(fetch).getIndexHistory('VIX')).rejects.toBeInstanceOf(
        VendorHttpError,
      );
      expect(calls).toHaveLength(1);
    });

    it('HTTP 503 → TransientVendorError, 退避重试耗尽后上抛 (maxAttempts+1 次)', async () => {
      // fake timers 只为抹掉 cockatiel 的指数退避 (0.5s+1s+2s 真睡)；限频那侧靠注入的
      // 虚拟 `now` 已经排空, 与本处无关。
      vi.useFakeTimers();
      try {
        const { fetch, calls } = makeCsvFetch({}, 503);
        const settled = makeAdapter(fetch)
          .getIndexHistory('VIX')
          .then(
            () => ({ err: undefined as unknown }),
            (e: unknown) => ({ err: e }),
          );
        await vi.runAllTimersAsync();
        expect((await settled).err).toBeInstanceOf(TransientVendorError);
        // CBOE profile maxAttempts=3 (E13 大响应体截断实证) ⇒ 1 初次 + 3 重试。
        expect(calls).toHaveLength(4);
      } finally {
        vi.useRealTimers();
      }
    });

    it('源返空 body → 表头校验就把它拦下 (空 body = 抓取坏了, 不是「今天没数据」)', async () => {
      const { fetch } = makeCsvFetch({ [CBOE_HISTORY_CSV_URLS.VIX]: '' });
      await expect(makeAdapter(fetch).getIndexHistory('VIX')).rejects.toBeInstanceOf(
        CboeCsvHeaderError,
      );
    });
  });

  // ── 🚨 合规红线的机器版 (Guardrail 4 / FR-033 / SC-008) ──
  //
  // ⚠️ 断言面**限定在 URL / fetch 构造面**, 不是整文件 / 整目录 grep: 那个字样**合法地**
  // 存在于本 adapter 与 `cboe-index-csv.rules.ts` 的 ToS 警示注释、以及 `schema.prisma` 的列
  // 注释里 —— 全目录扫描形态的断言必假红, 且会诱人把警示注释删掉来「修绿」。
  describe('🚨 禁碰盘中报价端点 (p3b E1/E24)', () => {
    const BANNED = 'delayed_quotes';

    it('URL 常量面: 前缀与两条文件 URL 均不含盘中报价端点字样', () => {
      expect(CBOE_HISTORY_CSV_BASE_URL).not.toContain(BANNED);
      for (const url of Object.values(CBOE_HISTORY_CSV_URLS)) expect(url).not.toContain(BANNED);
    });

    it('实际发起面: adapter 能发起的 URL **全集**恰为两条官方历史 CSV (穷举, 无第三条)', async () => {
      const { fetch, calls } = makeCsvFetch(BOTH_FILES);
      const adapter = makeAdapter(fetch);
      for (const code of US_INDEX_CODES) await adapter.getIndexHistory(code);

      // 代码域是二值 union + URL 只来自常量表 ⇒ 可能 URL 的全集就是这两条, 可穷举断言。
      expect(calls).toEqual([CBOE_HISTORY_CSV_URLS.VIX, CBOE_HISTORY_CSV_URLS.VVIX]);
      expect(calls.some((u) => u.includes(BANNED))).toBe(false);
      // 正向: 只走 `*_History.csv` 官方历史文件, 不走任何 `.json` 报价端点。
      expect(calls.every((u) => u.endsWith('_History.csv'))).toBe(true);
    });
  });
});
