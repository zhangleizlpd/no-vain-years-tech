import { describe, it, expect } from 'vitest';
import { parseFiscalProfileArgs } from './marketdata-fiscal-profile.cli.js';

/**
 * 财年档案人工补录 CLI 参数解析单测 (079 T029)。落库本体 (manual 行、幂等、主表外零写入) 由
 * `test/integration/marketdata-079.earnings-dates.it.spec.ts` 校真；此处只验 argv 解析与校验。
 */
describe('parseFiscalProfileArgs', () => {
  it('--set hk:00005=12 ⇒ 一条补录', () => {
    expect(parseFiscalProfileArgs(['--set', 'hk:00005=12'])).toEqual({
      entries: [{ ticker: 'hk:00005', market: 'hk', code: '00005', month: 12 }],
    });
  });

  it('多个 --set 依次收集', () => {
    expect(parseFiscalProfileArgs(['--set', 'hk:00005=12', '--set', 'hk:09988=3']).entries).toEqual(
      [
        { ticker: 'hk:00005', market: 'hk', code: '00005', month: 12 },
        { ticker: 'hk:09988', market: 'hk', code: '09988', month: 3 },
      ],
    );
  });

  it.each([
    ['月份 0', ['--set', 'hk:00005=0'], /1–12/],
    ['月份 13', ['--set', 'hk:00005=13'], /1–12/],
    ['非港股', ['--set', 'us:AAPL=12'], /--set 须为/],
    ['代码非 5 位', ['--set', 'hk:5=12'], /--set 须为/],
    ['缺值', ['--set'], /--set 须为/],
    ['未知参数', ['--month', '12'], /未知参数/],
    ['无参数', [], /至少需要一个/],
  ])('%s ⇒ 抛 (entry 映射为退出码 1)', (_label, argv, message) => {
    expect(() => parseFiscalProfileArgs(argv)).toThrow(message);
  });
});
