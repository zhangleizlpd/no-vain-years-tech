import { describe, it, expect } from 'vitest';
import { MAX_CODE_SUGGESTIONS, suggestNewCodes } from './symbol-candidate.rules';

/**
 * 086 T017 新码建议纯函数 (FR-018; plan D8)。Small 档: 零 IO。
 * 公司名取自公开行情事件 (PARA → PSKY → SKYD), 代码一律合成。
 */
describe('suggestNewCodes — 名称分词交集打分', () => {
  it('① 「Paramount Skydance」⇒ 前两名含 Skydance, 0 分的 Banzai 不收 (branch 21)', () => {
    const out = suggestNewCodes('Paramount Skydance Corp', [
      { code: 'AAA', name: 'Skydance' },
      { code: 'BBB', name: 'Paramount Global' },
      { code: 'CCC', name: 'Banzai International' },
    ]);

    expect(out.slice(0, 2).map((s) => s.code)).toContain('AAA');
    expect(out.map((s) => s.code)).not.toContain('CCC');
    expect(out.every((s) => s.score > 0)).toBe(true);
  });

  it('② 无任何名称交集 ⇒ 空数组 (= 「代码失效」, branch 22)', () => {
    expect(
      suggestNewCodes('Paramount Skydance', [
        { code: 'AAA', name: 'Banzai International' },
        { code: 'BBB', name: 'Ccc Robotics' },
      ]),
    ).toEqual([]);
  });

  it('③ 后缀词 (Inc / Corp / Holdings / Ltd …) 不计分 —— 只撞后缀 ⇒ 不收', () => {
    expect(
      suggestNewCodes('Aaa Holdings Inc', [
        { code: 'BBB', name: 'Bbb Holdings Inc.' },
        { code: 'CCC', name: 'Ccc Corp, Ltd' },
      ]),
    ).toEqual([]);
  });

  it('按分数降序, 同分按代码升序 (确定性), 至多 3 个', () => {
    const out = suggestNewCodes('Alpha Beta Gamma Delta', [
      { code: 'EEE', name: 'Alpha' },
      { code: 'DDD', name: 'Alpha Beta Gamma' },
      { code: 'CCC', name: 'Beta' },
      { code: 'BBB', name: 'Alpha Beta' },
      { code: 'AAA', name: 'Gamma' },
    ]);

    expect(out).toHaveLength(MAX_CODE_SUGGESTIONS);
    expect(out.map((s) => [s.code, s.score])).toEqual([
      ['DDD', 3],
      ['BBB', 2],
      ['AAA', 1],
    ]);
  });

  it('大小写 / 标点不影响分词; 空名 ⇒ 空数组', () => {
    expect(suggestNewCodes('SKYDANCE-MEDIA', [{ code: 'AAA', name: 'Skydance, Media' }])).toEqual([
      { code: 'AAA', name: 'Skydance, Media', score: 2 },
    ]);
    expect(suggestNewCodes('', [{ code: 'AAA', name: 'Skydance' }])).toEqual([]);
  });
});
