import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { earningsDateSourcesConfig } from '../config/marketdata.config.js';
import {
  assembleEarningsDateSources,
  EARNINGS_DATE_SOURCE_NAMES,
  UnknownEarningsDateSourceError,
  type EarningsDateSource,
  type EarningsDateSourceName,
} from './earnings-date-source.port.js';

// 079 T009 (FR-001 / FR-002 / FR-018, plan §D2 / §D11): 来源数组按 `EARNINGS_DATE_SOURCES` 装配。
// 模块工厂 (`marketdata.module.ts`) 只把 config 与「来源名 → 实例」表交给本函数, 判据全在这里 ⇒
// 纯函数 Small spec 即覆盖「未知名 ⇒ boot 抛」: Nest 在 init 期同步实例化 provider, 工厂抛 = 启动报错。
function fakeSource(name: EarningsDateSourceName): EarningsDateSource {
  return {
    name,
    capabilities: () => null,
    collect: () =>
      Promise.resolve({ observations: [], noticeSignals: [], skippedUnknownInstruments: 0 }),
  };
}

const FULL_REGISTRY: Record<EarningsDateSourceName, EarningsDateSource> = {
  futu_calendar: fakeSource('futu_calendar'),
  hkex_announcement: fakeSource('hkex_announcement'),
  hkex_board_meeting_list: fakeSource('hkex_board_meeting_list'),
};

describe('assembleEarningsDateSources', () => {
  it('三个来源全开 ⇒ 数组按配置顺序三个, 且就是注册表里的实例', () => {
    const got = assembleEarningsDateSources(
      ['hkex_board_meeting_list', 'futu_calendar', 'hkex_announcement'],
      FULL_REGISTRY,
    );
    expect(got.map((s) => s.name)).toEqual([
      'hkex_board_meeting_list',
      'futu_calendar',
      'hkex_announcement',
    ]);
    expect(got[1]).toBe(FULL_REGISTRY.futu_calendar);
  });

  it('去掉一个来源 ⇒ 数组只剩另两个', () => {
    const got = assembleEarningsDateSources(['futu_calendar', 'hkex_announcement'], FULL_REGISTRY);
    expect(got.map((s) => s.name)).toEqual(['futu_calendar', 'hkex_announcement']);
  });

  it('🚨 未知名 ⇒ 装配期抛错 (含该名与合法名单), 🚫 静默忽略', () => {
    const assemble = () =>
      assembleEarningsDateSources(['futu_calendar', 'hkex_board_list'], FULL_REGISTRY);
    expect(assemble).toThrow(UnknownEarningsDateSourceError);
    expect(assemble).toThrow(/hkex_board_list/);
    expect(assemble).toThrow(/hkex_board_meeting_list/);
  });

  it('重复名 ⇒ 装配期抛错 (同一来源跑两遍会让观测与失败计数翻倍)', () => {
    expect(() =>
      assembleEarningsDateSources(['futu_calendar', 'futu_calendar'], FULL_REGISTRY),
    ).toThrow(/futu_calendar/);
  });

  it('空清单 ⇒ 装配期抛错 (零来源的维度每轮空跑且全绿)', () => {
    expect(() => assembleEarningsDateSources([], FULL_REGISTRY)).toThrow(/EARNINGS_DATE_SOURCES/);
  });
});

describe('EARNINGS_DATE_SOURCES 默认值与来源名单一致', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.EARNINGS_DATE_SOURCES;
    delete process.env.EARNINGS_DATE_SOURCES;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.EARNINGS_DATE_SOURCES;
    else process.env.EARNINGS_DATE_SOURCES = saved;
  });

  it('env 缺失 ⇒ 默认三来源全开, 且能被装配 (config 默认串与 port 名单不漂移)', () => {
    const names = earningsDateSourcesConfig().names;
    expect(names).toEqual([...EARNINGS_DATE_SOURCE_NAMES]);
    expect(assembleEarningsDateSources(names, FULL_REGISTRY)).toHaveLength(3);
  });
});
