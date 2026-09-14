import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { PrismaService } from '../security/prisma.service.js';
import { BoardListParseError, parseBoardMeetingList } from './hkex-board-meeting-list.rules.js';
import {
  BOARD_LIST_STALE_TRADING_DAYS,
  HKEX_BOARD_MEETING_LIST_URL,
  HkexBoardMeetingListSource,
} from './hkex-board-meeting-list.source.js';
import { HKEXNEWS_PROFILE } from './hkexnews.constraint-profile.js';
import type { TradingCalendarPort } from './trading-calendar.port.js';
import {
  VendorHttpClient,
  VendorHttpError,
  type VendorHttpClientDeps,
} from './vendor-http-client.js';

// 079 T012 来源 C 港交所清单 (FR-006 / FR-020a / FR-025, plan §D7; state_branches 19、21、22)。
// Small: **真** VendorHttpClient + 假 fetch —— `redirect: 'manual'` 透传与 3xx / 404 永久错通路要走真
// 传输层才证得到; 主表与交易日历用替身。fixture 同 T003 (港交所公开页面)。

function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', 'hkex-board-meeting-list', name), 'utf8');
}

/** 当日页, 页首 10/09/2026, 业绩行 29 (无人民币柜台)。 */
const TODAY = fixture('ebmn_c-2026-09-13.htm');
/** Wayback 快照, 页首 23/04/2024, 业绩行 218。 */
const SNAPSHOT_2024 = fixture('ebmn_c-wayback-20240424125921.htm');
const NEW_LOCATION = 'https://www3.hkexnews.hk/reports/bmn/moved.htm';
const NOW = new Date('2026-09-14T15:30:00Z');

type FetchInit = { redirect?: 'follow' | 'manual' };

function textResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      throw new Error('清单是 HTML, 不应走 json()');
    },
    text: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  };
}

function harness(opts: {
  respond: (init: FetchInit | undefined) => ReturnType<typeof textResponse>;
  tradingDays?: number | null;
}) {
  const fetch = vi.fn(async (_url: string, init?: FetchInit) => opts.respond(init));
  const http = new VendorHttpClient(HKEXNEWS_PROFILE, {
    fetch: fetch as unknown as VendorHttpClientDeps['fetch'],
    sleep: async () => undefined,
  });
  // 主表 = 除人民币柜台 8xxxx 外的全部代码; id 取代码数值, 便于断言。
  const findMany = vi.fn(async (args: { where: { code: { in: string[] } } }) =>
    args.where.code.in
      .filter((code) => !code.startsWith('8'))
      .map((code) => ({ id: BigInt(Number(code)), code })),
  );
  const countTradingDays = vi.fn(async () =>
    opts.tradingDays === undefined ? 0 : opts.tradingDays,
  );
  const source = new HkexBoardMeetingListSource(
    http,
    { instrument: { findMany } } as unknown as PrismaService,
    { countTradingDays } as unknown as TradingCalendarPort,
  );
  return { source, fetch, findMany, countTradingDays };
}

const collect = (source: HkexBoardMeetingListSource, businessDate: string) =>
  source.collect({ market: 'hk', businessDate, now: NOW, mode: 'daily' });

describe('HkexBoardMeetingListSource 正常页', () => {
  it('2024-04-24 快照: 人民币柜台跳过计数, 其余业绩行全部成 meeting 观测; 期间空白 ⇒ D:<来源>:<会议日>; 回传清单键集合与扫描统计', async () => {
    const { source, fetch, countTradingDays } = harness({
      respond: () => textResponse(200, SNAPSHOT_2024),
      tradingDays: 1,
    });
    const page = parseBoardMeetingList(SNAPSHOT_2024);

    const result = await collect(source, '2024-04-24');

    expect(source.capabilities('hk')).toEqual({
      forward: 'announced_only',
      confirmationSignal: false,
      publicationFact: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(HKEX_BOARD_MEETING_LIST_URL);
    expect(fetch.mock.calls[0][1]?.redirect).toBe('manual');
    // 快照统计 (本 task impl 期对 fixture 逐行核): 业绩行 218, 其中人民币柜台 8xxxx 9 行,
    // 期间空白 2 行 (03311 / 00386), 同标的同期重复 0。
    expect(page.counts.resultRows).toBe(218);
    expect(result.skippedUnknownInstruments).toBe(9);
    expect(result.observations).toHaveLength(209);
    expect(
      result.observations.every(
        (o) =>
          o.basis === 'meeting' &&
          o.announceDate === null &&
          o.meetingDate !== null &&
          o.evidence === `${HKEX_BOARD_MEETING_LIST_URL} 页首日期=2024-04-23`,
      ),
    ).toBe(true);
    expect(
      result.observations
        .filter((o) => o.periodKey.startsWith('D:'))
        .map((o) => [o.instrumentId, o.periodKey, o.periodText]),
    ).toEqual([
      [3311n, 'D:hkex_board_meeting_list:2024-04-26', null],
      [386n, 'D:hkex_board_meeting_list:2024-04-28', null],
    ]);
    // 「年度DD/MM/YY」行照常落观测 (T029 财年反推读它)。
    const annualRows = page.rows.filter(
      (r) => r.periodText.startsWith('年度') && !r.code.startsWith('8'),
    );
    expect(annualRows.length).toBeGreaterThan(0);
    expect(
      annualRows.every((r) => result.observations.some((o) => o.periodText === r.periodText)),
    ).toBe(true);
    expect(result.listedPeriodKeys).toEqual(
      result.observations.map((o) => ({ instrumentId: o.instrumentId, periodKey: o.periodKey })),
    );
    expect(result.boardListScan).toEqual({ pageDate: '2024-04-23', counts: page.counts });
    expect(result.noticeSignals).toEqual([]);
    expect(countTradingDays).toHaveBeenCalledWith('hk', '2024-04-23', '2024-04-24');
    expect(result.stale).toBe(false);
  });
});

describe('HkexBoardMeetingListSource 陈旧判定 (页首日期 → 业务日交易日数)', () => {
  it.each([
    [3, true],
    [BOARD_LIST_STALE_TRADING_DAYS, false],
    [1, false],
    [null, 'unknown'],
  ] as const)('%s 个交易日 ⇒ stale = %s, 观测照常产出', async (tradingDays, expected) => {
    const { source } = harness({ respond: () => textResponse(200, TODAY), tradingDays });

    const result = await collect(source, '2026-09-14');

    expect(result.stale).toBe(expected);
    expect(result.observations).toHaveLength(29);
  });
});

describe('HkexBoardMeetingListSource 响亮失败 (🚫 捕获后返回空)', () => {
  it('🚨 301 ⇒ VendorHttpError 带状态码与跳转目标, 不重试、不查主表 (假站点: 不带 redirect manual 就跟随到新地址拿 200)', async () => {
    const { source, fetch, findMany } = harness({
      respond: (init) =>
        init?.redirect === 'manual'
          ? textResponse(301, '', { location: NEW_LOCATION })
          : textResponse(200, TODAY),
    });

    const error = await collect(source, '2026-09-14').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VendorHttpError);
    expect((error as VendorHttpError).message).toContain('301');
    expect((error as VendorHttpError).message).toContain(NEW_LOCATION);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('404 ⇒ VendorHttpError 带状态码, 不重试', async () => {
    const { source, fetch } = harness({ respond: () => textResponse(404, 'Not Found') });

    const error = await collect(source, '2026-09-14').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VendorHttpError);
    expect((error as VendorHttpError).message).toContain('404');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('变异页 (删掉攜程那行的「期間」格) ⇒ BoardListParseError 带首个不合法行, 不查主表', async () => {
    const broken = TODAY.replace(
      "<td valign=top><font face='monospace' style='font-size: 12'>截至30/06/26止6個月</font></td>",
      '',
    );
    expect(broken).not.toBe(TODAY);
    const { source, findMany } = harness({ respond: () => textResponse(200, broken) });

    const error = await collect(source, '2026-09-14').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BoardListParseError);
    expect((error as BoardListParseError).message).toContain('首个不合法行');
    expect((error as BoardListParseError).offendingRow).toContain('9961');
    expect(findMany).not.toHaveBeenCalled();
  });
});
