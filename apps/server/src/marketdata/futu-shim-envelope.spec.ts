import { describe, expect, it } from 'vitest';
import { parseShimEnvelope, parseShimRows } from './futu-shim-envelope';

const WHAT = 'option-snapshot 3 codes';

describe('parseShimRows —— 闸① 缺 rows[] / 闸② count 对账', () => {
  it('rows 是数组 → 原样返回 (不拷贝、不过滤)', () => {
    const rows = [{ a: 1 }, { a: 2 }];
    expect(parseShimRows({ count: 2, rows }, WHAT)).toBe(rows);
  });

  it('缺 rows[] → 抛 (契约变更), 报错带 what 供定位', () => {
    expect(() => parseShimRows({ count: 0 }, WHAT)).toThrow(/响应缺 rows\[\]/);
    expect(() => parseShimRows({ count: 0 }, WHAT)).toThrow(new RegExp(WHAT));
  });

  it('rows 非数组 (对象 / null / 字符串) → 同样走闸①', () => {
    expect(() => parseShimRows({ rows: {} }, WHAT)).toThrow(/响应缺 rows\[\]/);
    expect(() => parseShimRows({ rows: null }, WHAT)).toThrow(/响应缺 rows\[\]/);
    expect(() => parseShimRows({ rows: 'x' }, WHAT)).toThrow(/响应缺 rows\[\]/);
  });

  it('整个响应 undefined → 走闸① (不是 TypeError)', () => {
    expect(() => parseShimRows(undefined, WHAT)).toThrow(/响应缺 rows\[\]/);
  });

  it('count 与实收不符 → 抛「疑截断」, 且把两个数都报出来', () => {
    const err = (): unknown[] => parseShimRows({ count: 285, rows: [{}, {}] }, WHAT);
    expect(err).toThrow(/疑截断/);
    expect(err).toThrow(/count=285/);
    expect(err).toThrow(/rows=2/);
  });

  it('🚨 count 缺失 / 非 number → 跳过闸② (现行语义, 不得顺手收紧)', () => {
    // 收紧成「必须有 count」会让没有该字段的 shim 端点全部炸掉 —— 那是行为变化, 不属重构。
    const rows = [{}, {}];
    expect(parseShimRows({ rows }, WHAT)).toBe(rows);
    expect(parseShimRows({ count: '2', rows }, WHAT)).toBe(rows);
  });
});

describe('parseShimEnvelope —— 追加闸③ as_of', () => {
  it('as_of 可解析 → 返回 Date + 原样 rows', () => {
    const rows = [{ a: 1 }];
    const out = parseShimEnvelope({ as_of: '2026-08-19T13:47:32+00:00', count: 1, rows }, WHAT);
    expect(out.rows).toBe(rows);
    expect(out.asOf.toISOString()).toBe('2026-08-19T13:47:32.000Z');
  });

  it('🚨 as_of 缺失 → 抛, MUST NOT 拿本机时钟顶替', () => {
    // 顶替会把「这一行什么时候采的」换成「这段代码什么时候跑到这一句」,
    // 而 90 秒新鲜度闸判的正是前者。
    expect(() => parseShimEnvelope({ count: 1, rows: [{}] }, WHAT)).toThrow(/as_of/);
  });

  it('as_of 不可解析 (乱串 / null) → 同样抛', () => {
    expect(() => parseShimEnvelope({ as_of: 'not-a-date', count: 1, rows: [{}] }, WHAT)).toThrow(
      /as_of/,
    );
    expect(() => parseShimEnvelope({ as_of: null, count: 1, rows: [{}] }, WHAT)).toThrow(/as_of/);
  });

  it('闸①② 与 parseShimRows **恒等** —— 同一份坏输入抛同样的错', () => {
    // 这条是本次抽取的存在理由: 两个入口共用同一实现, 结构上不可能分叉。
    const bad = { count: 9, rows: [{}] };
    expect(() => parseShimRows(bad, WHAT)).toThrow(/疑截断/);
    expect(() => parseShimEnvelope({ ...bad, as_of: '2026-08-19T00:00:00Z' }, WHAT)).toThrow(
      /疑截断/,
    );
  });

  it('闸序: rows 与 as_of 同时坏 → 先报 rows (契约变更是更根本的事实)', () => {
    expect(() => parseShimEnvelope({ as_of: 'x' }, WHAT)).toThrow(/响应缺 rows\[\]/);
  });
});
