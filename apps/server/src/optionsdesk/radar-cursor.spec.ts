import { describe, it, expect } from 'vitest';
import {
  RADAR_PAGE_SIZE_DEFAULT,
  RADAR_PAGE_SIZE_MAX,
  compareRadarKeys,
  decodeRadarCursor,
  encodeRadarCursor,
  isAfterRadarCursor,
  normalizeRadarLimit,
  radarKeysetPredicate,
  type RadarSortKey,
} from './radar-cursor';

describe('radar 游标编解码 (FR-033 keyset)', () => {
  it('往返: 距 W% + 锚 id 二元组原样还原', () => {
    const cursor = { distanceToWPct: '-12.3456', anchorId: '42' };
    expect(decodeRadarCursor(encodeRadarCursor(cursor))).toEqual(cursor);
  });

  it('往返: 行情不可用段 (距 W% = null) 也可编码', () => {
    const cursor = { distanceToWPct: null, anchorId: '7' };
    expect(decodeRadarCursor(encodeRadarCursor(cursor))).toEqual(cursor);
  });

  it('游标不透明 (base64url, 无 +/= 需转义) —— 客户端不该解读它', () => {
    const token = encodeRadarCursor({ distanceToWPct: '-1.5', anchorId: '999999999999' });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['乱码', 'not-a-cursor!!'],
    ['空串', ''],
    ['合法 base64 但形状不对', Buffer.from('{"a":1}', 'utf8').toString('base64url')],
    ['距 W% 非数值', Buffer.from('["abc","1"]', 'utf8').toString('base64url')],
    ['id 非数字串', Buffer.from('["1.0","x"]', 'utf8').toString('base64url')],
  ])('被篡改的游标 (%s) → null, 由调用方折 400 而非静默从头翻页', (_label, raw) => {
    expect(decodeRadarCursor(raw)).toBeNull();
  });
});

describe('compareRadarKeys — 距 W% ASC NULLS LAST, 锚 id ASC (全序)', () => {
  it('距 W% 小的在前', () => {
    expect(
      compareRadarKeys(
        { distanceToWPct: '-5', anchorId: '9' },
        { distanceToWPct: '3', anchorId: '1' },
      ),
    ).toBeLessThan(0);
  });

  it('🚨 距 W% 并列 → 锚 id 升序 tiebreaker (无它则 SQL 并列行顺序不稳定 ⇒ 游标跳行)', () => {
    const a: RadarSortKey = { distanceToWPct: '-5.0000', anchorId: '2' };
    const b: RadarSortKey = { distanceToWPct: '-5', anchorId: '10' };
    expect(compareRadarKeys(a, b)).toBeLessThan(0); // 值相等 (Decimal 比较, 非字符串比较)
    expect(compareRadarKeys(b, a)).toBeGreaterThan(0);
  });

  it('id 比较按数值而非字典序 (2 < 10)', () => {
    expect(
      compareRadarKeys(
        { distanceToWPct: null, anchorId: '2' },
        { distanceToWPct: null, anchorId: '10' },
      ),
    ).toBeLessThan(0);
  });

  it('行情不可用 (距 W% = null) 恒排在尾段 —— 行仍在列表 (EC-15), 只是排最后', () => {
    expect(
      compareRadarKeys(
        { distanceToWPct: null, anchorId: '1' },
        { distanceToWPct: '999', anchorId: '9' },
      ),
    ).toBeGreaterThan(0);
  });

  it('全序: 同键比较为 0, 反对称', () => {
    const k: RadarSortKey = { distanceToWPct: '1', anchorId: '1' };
    expect(compareRadarKeys(k, { ...k })).toBe(0);
  });
});

describe('keyset 分页不跳行 / 不重复 (并列距 W% 场景)', () => {
  /** 5 条锚, 其中 3 条距 W% 完全并列 —— 无 tiebreaker 时正是漏行/重复的高发场景。 */
  const rows: RadarSortKey[] = [
    { distanceToWPct: '-5', anchorId: '3' },
    { distanceToWPct: '-5.00', anchorId: '1' },
    { distanceToWPct: '-5', anchorId: '2' },
    { distanceToWPct: '0', anchorId: '9' },
    { distanceToWPct: null, anchorId: '4' },
  ];

  /** SQL 语义的内存镜像: 排序 → keyset 过滤 → 取 n 条。 */
  function page(cursor: RadarSortKey | null, size: number): RadarSortKey[] {
    return [...rows]
      .sort(compareRadarKeys)
      .filter((r) => cursor === null || isAfterRadarCursor(r, cursor))
      .slice(0, size);
  }

  it('逐页翻完 = 全集一次不漏、一条不重 (每页 2 条)', () => {
    const seen: RadarSortKey[] = [];
    let cursor: RadarSortKey | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const batch: RadarSortKey[] = page(cursor, 2);
      if (batch.length === 0) break;
      seen.push(...batch);
      cursor = batch[batch.length - 1]!;
    }
    expect(seen.map((r) => r.anchorId)).toEqual(['1', '2', '3', '9', '4']);
    expect(new Set(seen.map((r) => r.anchorId)).size).toBe(rows.length);
  });

  it('翻页期间并列行的 last_close 被刷新 → 已翻过的行不再出现 (id 单调)', () => {
    const firstPage = page(null, 2);
    const cursor = firstPage[firstPage.length - 1]!;
    // 模拟同步把某条并列行的距 W% 改小 (它排到了游标之前) —— keyset 按 (dist,id) 判定,
    // 不会因此把它再吐一次 (OFFSET 分页在此处正是漏/重的来源)。
    const refreshed: RadarSortKey = { distanceToWPct: '-9', anchorId: '1' };
    expect(isAfterRadarCursor(refreshed, cursor)).toBe(false);
  });
});

describe('radarKeysetPredicate — SQL 谓词与内存镜像同义', () => {
  it('非 null 游标 → 三支: 距 W% 更大 / 并列且 id 更大 / 尾段 NULL', () => {
    const sql = radarKeysetPredicate({ distanceToWPct: '-5', anchorId: '2' }).sql;
    expect(sql).toContain('distance_to_w_pct >');
    expect(sql).toContain('distance_to_w_pct =');
    expect(sql).toContain('id >');
    expect(sql).toContain('distance_to_w_pct IS NULL');
  });

  it('null 游标 (已进尾段) → 只在 NULL 段内按 id 递增', () => {
    const sql = radarKeysetPredicate({ distanceToWPct: null, anchorId: '2' }).sql;
    expect(sql).toContain('distance_to_w_pct IS NULL');
    expect(sql).toContain('id >');
    expect(sql).not.toContain('distance_to_w_pct >');
  });

  it('游标值走参数绑定, 不拼进 SQL 文本', () => {
    const predicate = radarKeysetPredicate({ distanceToWPct: '-5', anchorId: '2' });
    expect(predicate.values).toContain('-5');
    expect(predicate.sql).not.toContain('-5');
  });
});

describe('normalizeRadarLimit — 下拉增量加载的页长 (FR-010 禁页码控件)', () => {
  it('缺省 → 默认页长', () => {
    expect(normalizeRadarLimit(undefined)).toBe(RADAR_PAGE_SIZE_DEFAULT);
  });

  it('超上限 → 钳到上限 (防一次拉全表绕过分页)', () => {
    expect(normalizeRadarLimit(10_000)).toBe(RADAR_PAGE_SIZE_MAX);
  });

  it.each([0, -1, 1.5, Number.NaN])('非法页长 %s → 回默认值', (raw) => {
    expect(normalizeRadarLimit(raw)).toBe(RADAR_PAGE_SIZE_DEFAULT);
  });
});
