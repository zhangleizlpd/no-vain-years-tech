import { describe, expect, it } from 'vitest';
import { tickerCode, underlyingDisplayName } from './underlying-identity.rules';

/** 045 plan D13 主位显示判据 —— 雷达 / 锚列表 / 详情题头三处共用的那一份。 */
describe('underlyingDisplayName', () => {
  it('有名字 ⇒ 主位是名字（港股代号人读不出是哪只票，这条是本片的全部理由）', () => {
    expect(underlyingDisplayName({ name: '快手-W', ticker: 'hk:01024' })).toBe('快手-W');
  });

  it('名字为 null（未在行情库注册）⇒ 退回代号，MUST NOT 拼假名字', () => {
    expect(underlyingDisplayName({ name: null, ticker: 'hk:01024' })).toBe('01024');
  });

  it('名字为空串 ⇒ 同样退回代号（空串不是「这票就叫这个」）', () => {
    expect(underlyingDisplayName({ name: '', ticker: 'us:AOS' })).toBe('AOS');
  });

  it('ticker 不含冒号 ⇒ 退回原串，不丢信息', () => {
    expect(underlyingDisplayName({ name: null, ticker: 'AOS' })).toBe('AOS');
  });
});

describe('tickerCode', () => {
  it('取 `market:code` 的 code 段', () => {
    expect(tickerCode('hk:01024')).toBe('01024');
  });

  it('code 段含点也原样保留（`us:BRK.B` 那类）', () => {
    expect(tickerCode('us:BRK.B')).toBe('BRK.B');
  });

  it('无冒号 ⇒ 原串', () => {
    expect(tickerCode('AOS')).toBe('AOS');
  });
});
