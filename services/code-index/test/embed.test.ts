import { describe, it, expect } from 'vitest';
import { embedSequential, type Embedder } from '../src/embed.js';

const fake = (onEmbed?: (text: string) => void): Embedder => ({
  usedId: 'fake',
  dim: 2,
  embed: async (texts) => {
    onEmbed?.(texts[0]);
    return texts.map((t) => [t.length, 0]);
  },
});

describe('embedSequential', () => {
  it('每条 embed 完立刻回调落库,不攒批', async () => {
    const trace: string[] = [];
    const e = fake((t) => trace.push(`embed:${t}`));

    await embedSequential(e, ['a', 'bb'], async (i) => {
      trace.push(`store:${i}`);
    });

    // 交替 = 流式。攒批实现会给出 embed,embed,store,store
    expect(trace).toEqual(['embed:a', 'store:0', 'embed:bb', 'store:1']);
  });

  it('中途失败时先前的条目已落库 —— builder 被 SIGTERM 杀掉不再丢光整批', async () => {
    const stored: number[] = [];
    const e: Embedder = {
      usedId: 'fake',
      dim: 2,
      embed: async (texts) => {
        if (texts[0] === 'boom') throw new Error('killed mid-batch');
        return [[1, 0]];
      },
    };

    await expect(
      embedSequential(e, ['a', 'boom', 'c'], async (i) => {
        stored.push(i);
      }),
    ).rejects.toThrow('killed mid-batch');
    expect(stored).toEqual([0]);
  });

  it('回调收到的向量与输入顺序对齐', async () => {
    const got: Array<[number, number[]]> = [];

    await embedSequential(fake(), ['a', 'bbb'], async (i, vec) => {
      got.push([i, vec]);
    });

    expect(got).toEqual([
      [0, [1, 0]],
      [1, [3, 0]],
    ]);
  });

  it('报告进度用的是已落库条数', async () => {
    const progress: Array<[number, number]> = [];

    await embedSequential(
      fake(),
      ['a', 'b', 'c'],
      async () => {},
      (done, total) => progress.push([done, total]),
    );

    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
});
