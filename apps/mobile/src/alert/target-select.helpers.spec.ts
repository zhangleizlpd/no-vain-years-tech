import { describe, expect, it } from 'vitest';

import { splitNameHighlight } from './target-select.helpers';

// marketBadgeLabel 测试随函数提升迁至 ~/ui/market-badge.rules.spec.ts。

describe('splitNameHighlight', () => {
  it('命中中段 → 三段（前/命中/后）', () => {
    expect(splitNameHighlight('京东方A', '东方')).toEqual([
      { text: '京', hit: false },
      { text: '东方', hit: true },
      { text: 'A', hit: false },
    ]);
  });

  it('命中开头 → 两段', () => {
    expect(splitNameHighlight('京东方A', '京东')).toEqual([
      { text: '京东', hit: true },
      { text: '方A', hit: false },
    ]);
  });

  it('命中结尾 → 两段', () => {
    expect(splitNameHighlight('旭升集团', '集团')).toEqual([
      { text: '旭升', hit: false },
      { text: '集团', hit: true },
    ]);
  });

  it('整名命中 → 单 hit 段', () => {
    expect(splitNameHighlight('旭升集团', '旭升集团')).toEqual([{ text: '旭升集团', hit: true }]);
  });

  it('未命中（如按代码搜）→ 单非 hit 段', () => {
    expect(splitNameHighlight('京东方A', '000725')).toEqual([{ text: '京东方A', hit: false }]);
  });

  it('空/全空白 query → 单非 hit 段', () => {
    expect(splitNameHighlight('京东方A', '')).toEqual([{ text: '京东方A', hit: false }]);
    expect(splitNameHighlight('京东方A', '  ')).toEqual([{ text: '京东方A', hit: false }]);
  });

  it('query 首尾空白裁剪后再匹配', () => {
    expect(splitNameHighlight('京东方A', ' 京东 ')).toEqual([
      { text: '京东', hit: true },
      { text: '方A', hit: false },
    ]);
  });

  it('多次出现只高亮首处（mockup 体例）', () => {
    expect(splitNameHighlight('中国中车', '中')).toEqual([
      { text: '中', hit: true },
      { text: '国中车', hit: false },
    ]);
  });
});
