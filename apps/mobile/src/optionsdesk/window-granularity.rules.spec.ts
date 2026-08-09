// 046 T020 — 窗口→粒度映射纯函数单测（logic-only；折线 / chip 的渲染走 T024 E2E）。
// 末段是 SC-007 / FR-009 的**机械防线**：本模块必须一直是「只查表、不碰序列」。
import { describe, expect, it } from 'vitest';

import mobilePackageJson from '../../package.json';
import {
  DEFAULT_TIME_SERIES_WINDOW,
  TIME_SERIES_WINDOWS,
  barsPeriodForWindow,
  isTimeSeriesWindow,
} from './window-granularity.rules';

describe('窗口档与默认值（FR-008）', () => {
  it('四档按 chip 行的呈现顺序排列', () => {
    expect(TIME_SERIES_WINDOWS).toEqual(['1Y', '3Y', '5Y', '10Y']);
  });

  it('默认窗口 = 近 1 年，且其粒度为日线', () => {
    expect(DEFAULT_TIME_SERIES_WINDOW).toBe('1Y');
    expect(barsPeriodForWindow(DEFAULT_TIME_SERIES_WINDOW)).toBe('day');
  });
});

describe('barsPeriodForWindow（FR-009 固定映射）', () => {
  it.each([
    ['1Y', 'day'],
    ['3Y', 'week'],
    ['5Y', 'week'],
    ['10Y', 'month'],
  ])('%s → %s', (window, period) => {
    expect(barsPeriodForWindow(window)).toBe(period);
  });

  it('四档穷举可解析（不留「在册但没定义映射」的档）', () => {
    for (const window of TIME_SERIES_WINDOWS) {
      expect(() => barsPeriodForWindow(window)).not.toThrow();
    }
  });
});

describe('🚨 未知档位 fail-closed（禁静默回落 day）', () => {
  // 大小写 / 空白 / 邻近合法值都要拦：静默回落 day 会让 10 年窗按日线全拉（约 2500 点），
  // 慢、费流量，且**不会有人发现** —— 无声地错正是这条要防的。
  it.each(['', '2Y', '1y', 'day', 'MAX', '10Y ', 'ALL'])('「%s」→ 抛错而非回落', (bad) => {
    expect(() => barsPeriodForWindow(bad)).toThrow(/未知的区间时序窗口档/);
  });

  it('错误消息带上允许值，便于定位是哪个持久化 / 深链值坏了', () => {
    expect(() => barsPeriodForWindow('2Y')).toThrow(/1Y \/ 3Y \/ 5Y \/ 10Y/);
  });

  it('isTimeSeriesWindow 是它的非抛错版（恢复持久化档位时先判再用）', () => {
    expect(isTimeSeriesWindow('3Y')).toBe(true);
    expect(isTimeSeriesWindow('2Y')).toBe(false);
    expect(isTimeSeriesWindow('')).toBe(false);
  });
});

// ── 🚨 SC-007 / FR-009 机械防线：本模块不做降采样 ──
//
// ⚠️ 断言面刻意**不是源码文本 grep**，两个理由：① Small 档禁磁盘 I/O（testing.md 分类学）
//    ② 「LTTB」「降采样」字样**合法地**出现在被测模块与本文件的警示注释里 —— 文本形态的
//    断言必假红，还会诱人删掉警示注释来「修绿」（同 T012 `delayed_quotes` 断言吃过的教训，
//    见 `cboe-us-index.adapter.spec.ts` 那段说明）。
//    改成两个**值面**断言：① 降采样库根本不在依赖图里 ⇒ 本模块想 import 也 import 不到
//    ② 导出面穷举 ⇒ 塞不进第三样东西。
describe('🚨 本模块不做降采样（SC-007 / FR-009）', () => {
  /**
   * LTTB 系 / 通用抽稀的常见 npm 实现名。**非穷举** —— 真正的零依赖门是 T027 的
   * 「`git diff` 无 package.json dependencies 新增」，本条只是本模块面的早期哨兵。
   */
  const DOWNSAMPLING_PACKAGES = [
    'downsample',
    'lttb',
    'largest-triangle-three-buckets',
    'tsdownsample',
    'simplify-js',
  ];

  it('降采样库不在 apps/mobile 依赖图内 ⇒ 本模块 import 不到', () => {
    const installed = new Set([
      ...Object.keys(mobilePackageJson.dependencies),
      ...Object.keys(mobilePackageJson.devDependencies),
    ]);
    expect(DOWNSAMPLING_PACKAGES.filter((name) => installed.has(name))).toEqual([]);
  });

  it('导出面穷举：只有窗口档常量 + 判别 + 映射，没有任何吃序列的东西', async () => {
    const mod = await import('./window-granularity.rules');
    expect(Object.keys(mod).sort()).toEqual([
      'DEFAULT_TIME_SERIES_WINDOW',
      'TIME_SERIES_WINDOWS',
      'barsPeriodForWindow',
      'isTimeSeriesWindow',
    ]);
  });

  it('产物值域只落在 bars 端点既有的 day / week / month（聚合是服务端的事）', () => {
    expect(new Set(TIME_SERIES_WINDOWS.map(barsPeriodForWindow))).toEqual(
      new Set(['day', 'week', 'month']),
    );
  });
});
