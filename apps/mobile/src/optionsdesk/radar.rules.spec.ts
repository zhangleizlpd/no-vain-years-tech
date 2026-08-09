// 045 T024 — 雷达五态 / 徽标 / 行字段 / 新鲜度 / 筛选 / 分页纯函数单测。
// 渲染与交互（下拉加载手势、chips 点击、占位入口 tap）走 T025 E2E。
import { describe, expect, it } from 'vitest';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import {
  RADAR_BADGE_ORDER,
  RADAR_FILTER_KEYS,
  RADAR_ROW_FIELD_KEYS,
  formatDistanceToW,
  formatSpot,
  getRadarNextCursor,
  mergeRadarPages,
  radarBadges,
  radarFilterParams,
  radarFreshness,
  radarRowFields,
  radarViewState,
  toggleRadarFilter,
  type RadarPageLike,
  type RadarRowAnchor,
} from './radar.rules';

const COPY = OPTIONSDESK_COPY.radar;

function row(over: Partial<RadarRowAnchor> = {}): RadarRowAnchor {
  return {
    id: '1',
    ticker: 'us:CPB',
    lLevelEffective: 'L2',
    zone: 'buy',
    quoteFreshnessTier: 'CURRENT',
    overdue: false,
    reviewFlagOn: false,
    w: '38.40',
    v: '48.00',
    zoneFloor: '28.80',
    zoneCeiling: '57.60',
    lastClose: '37.20',
    lastCloseDate: '2026-07-28',
    distanceToWPct: '-3.10',
    ...over,
  };
}

function page(over: Partial<RadarPageLike> = {}): RadarPageLike {
  return { items: [row()], nextCursor: null, hasMore: false, emptyState: null, ...over };
}

describe('radarViewState — 五态（FR-015 + FR-034）', () => {
  it('有行 + 有可动标的 → 常态', () => {
    expect(radarViewState(page())).toBe('normal');
  });

  it('server 判零锚 → zero_anchors（引导去建锚）', () => {
    expect(radarViewState(page({ items: [], emptyState: 'zero_anchors' }))).toBe('zero_anchors');
  });

  it('server 判筛选无结果 → filtered_empty（与「今日无解」不是同一态）', () => {
    expect(radarViewState(page({ items: [], emptyState: 'filtered_empty' }))).toBe(
      'filtered_empty',
    );
  });

  it('server 判全体不动区 → all_idle，且行照常在列表（非空白页）', () => {
    const p = page({ emptyState: 'all_idle' });
    expect(radarViewState(p)).toBe('all_idle');
    expect(p.items).toHaveLength(1);
  });

  it('全部行无行情 → quotes_degraded（**压过** all_idle：没数据不等于今日无解）', () => {
    const p = page({
      items: [row({ lastClose: null, lastCloseDate: null, distanceToWPct: null, zone: null })],
      emptyState: 'all_idle',
    });
    expect(radarViewState(p)).toBe('quotes_degraded');
  });

  it('部分行有行情 → 仍是常态（单票缺失走行内标记，不升级成整页降级）', () => {
    expect(
      radarViewState(
        page({ items: [row(), row({ id: '2', lastClose: null, lastCloseDate: null })] }),
      ),
    ).toBe('normal');
  });
});

describe('radarBadges — 顺序纪律 + 禁衍生徽标（FR-014）', () => {
  it('顺序 = L 层 → 区间 → 锚逾期 → 复核锚 → 提醒类', () => {
    const badges = radarBadges(row({ overdue: true, reviewFlagOn: true }));
    expect(badges.map((b) => b.kind)).toEqual(['l_level', 'zone', 'overdue', 'review_flag']);
    expect(badges[0]?.text).toBe('L2');
    expect(badges[1]?.text).toBe(COPY.zoneLabels.buy);
    expect(badges[2]?.text).toBe(COPY.badgeOverdue);
    expect(badges[3]?.text).toBe(COPY.badgeReviewFlag);
  });

  it('无异常态 → 只有 L 层 + 区间两个徽标', () => {
    expect(radarBadges(row()).map((b) => b.kind)).toEqual(['l_level', 'zone']);
  });

  it('行情不可用 → 区间徽标缺位，改挂显式「行情不可用」（提醒类，排最后）', () => {
    const badges = radarBadges(row({ zone: null, lastCloseDate: null, reviewFlagOn: true }));
    expect(badges.map((b) => b.kind)).toEqual(['l_level', 'review_flag', 'quote_unavailable']);
  });

  it('徽标种类**只能**取自白名单 —— 衍生徽标（达标腿数 / 直接买主案）无处可生', () => {
    const badges = radarBadges(row({ overdue: true, reviewFlagOn: true }));
    for (const b of badges) expect(RADAR_BADGE_ORDER).toContain(b.kind);
  });
});

describe('radarRowFields — 每行恰好 5 字段（SC-002 / plan D13）', () => {
  it('字段数恒为 5，键序固定', () => {
    const fields = radarRowFields(row());
    expect(Object.keys(fields)).toEqual([...RADAR_ROW_FIELD_KEYS]);
    expect(Object.keys(fields)).toHaveLength(5);
  });

  it('标的标识 = ticker + code 同一字段（「这是哪只票」算一个信息维度）', () => {
    expect(radarRowFields(row()).identity).toEqual({ code: 'CPB', ticker: 'us:CPB' });
  });

  it('spot 串**不重复**距 W（标题行已有一份，plan D13 明令删）', () => {
    const fields = radarRowFields(row());
    expect(fields.spot).toBe('S 37.20');
    expect(fields.spot).not.toContain(COPY.distancePrefix);
  });

  it('行情不可用的行仍产出全部 5 字段（行不被剔除，FR-017）', () => {
    const fields = radarRowFields(
      row({ lastClose: null, lastCloseDate: null, distanceToWPct: null, zone: null }),
    );
    expect(Object.keys(fields)).toHaveLength(5);
    expect(fields.spot).toBe(COPY.quoteUnavailable);
    expect(fields.distanceToW).toBe(`${COPY.distancePrefix}${COPY.noValue}`);
  });
});

describe('SC-004 —— 不存在无标注的数值（数值与 asOf 同生共死）', () => {
  it('lastClose 有值但 lastCloseDate 为 null → **不渲染数值**，退成显式不可用', () => {
    const a = row({ lastClose: '37.20', lastCloseDate: null });
    expect(formatSpot(a)).toBe(COPY.quoteUnavailable);
    expect(formatSpot(a)).not.toContain('37.20');
  });

  it('距 W% 同理：没有 asOf 就不给数值', () => {
    const a = row({ distanceToWPct: '-3.10', lastCloseDate: null });
    expect(formatDistanceToW(a)).toBe(`${COPY.distancePrefix}${COPY.noValue}`);
    expect(formatDistanceToW(a)).not.toContain('3.1');
  });

  it('色带也不画 spot 点（几何位置同样是「数值」）', () => {
    expect(radarRowFields(row({ lastCloseDate: null })).band.lastClose).toBeNull();
  });

  it('asOf 齐备 → 数值照常，符号与量级正确', () => {
    expect(formatDistanceToW(row())).toBe('距 W −3.1%');
    expect(formatDistanceToW(row({ distanceToWPct: '13.10' }))).toBe('距 W +13.1%');
    expect(formatDistanceToW(row({ distanceToWPct: '0.00' }))).toBe('距 W 0.0%');
  });
});

describe('radarFreshness — asOf 新鲜度档（FR-016）', () => {
  it('server 判 CURRENT → 「数据截至 X · 收盘」', () => {
    const f = radarFreshness([row({ lastCloseDate: '2026-07-30' })]);
    expect(f.tier).toBe('CURRENT');
    expect(f.text).toBe('数据截至 2026-07-30 · 收盘');
  });

  it('server 判 STALE → 同一句 + 陈旧后缀（禁静默当实时）', () => {
    const f = radarFreshness([row({ lastCloseDate: '2026-07-28', quoteFreshnessTier: 'STALE' })]);
    expect(f.tier).toBe('STALE');
    expect(f.text).toBe(`数据截至 2026-07-28 · 收盘${COPY.freshStaleSuffix}`);
  });

  it('全无行情 → 显式不可用，asOf = null（不编造日期）', () => {
    const f = radarFreshness([row({ lastCloseDate: null, quoteFreshnessTier: 'UNAVAILABLE' })]);
    expect(f.tier).toBe('UNAVAILABLE');
    expect(f.asOf).toBeNull();
    expect(f.text).toBe(COPY.freshUnavailable);
  });

  /**
   * 🚨 asOf 取各行最新、档位取**那一行自己的** —— 判据全程没有任何本地日期参与。
   * 045 初版拿 `asOf === 设备本地日期` 判，对美股永不相等 ⇒ 顶条恒显陈旧，这条是防它回归。
   */
  it('🚨 取最新那一行的 asOf 与它自己的档，不与本地日期比', () => {
    const f = radarFreshness([
      row({ lastCloseDate: '2026-07-27', quoteFreshnessTier: 'STALE' }),
      row({ lastCloseDate: '2026-07-29', quoteFreshnessTier: 'CURRENT' }),
    ]);
    expect(f.asOf).toBe('2026-07-29');
    expect(f.tier).toBe('CURRENT');
    expect(f.text).toContain('2026-07-29');
  });
});

describe('筛选 chips —— 多选（FR-034）', () => {
  it('6 项恒定：L1–L4 + 待复审 + 跌破 W', () => {
    expect(RADAR_FILTER_KEYS).toEqual(['L1', 'L2', 'L3', 'L4', 'pendingReview', 'belowW']);
  });

  it('多选：再点同一项取消，互不排斥', () => {
    let sel = toggleRadarFilter([], 'L1');
    sel = toggleRadarFilter(sel, 'L3');
    sel = toggleRadarFilter(sel, 'belowW');
    expect(sel).toEqual(['L1', 'L3', 'belowW']);
    expect(toggleRadarFilter(sel, 'L3')).toEqual(['L1', 'belowW']);
  });

  it('→ 查询参数：L 层进 lLevels，两个布尔各自一维', () => {
    expect(radarFilterParams(['L1', 'L3', 'pendingReview'])).toEqual({
      lLevels: ['L1', 'L3'],
      pendingReview: true,
    });
    expect(radarFilterParams(['belowW'])).toEqual({ belowW: true });
  });

  it('未选任何项 → 三个维度全部省略（不发空数组 / 不发 false）', () => {
    expect(radarFilterParams([])).toEqual({});
  });

  it('FR-008：L1 档无锚**不是**错误 —— chips 恒含 L1，参数构建对 L1 零特判', () => {
    expect(RADAR_FILTER_KEYS).toContain('L1');
    expect(radarFilterParams(['L1'])).toEqual({ lLevels: ['L1'] });
  });
});

describe('游标分页（SC-002：下拉增量加载，无页码控件）', () => {
  it('多页按页序拼接，跨页重复 id 去重保留首见', () => {
    const p1 = page({ items: [row({ id: '1' }), row({ id: '2' })] });
    const p2 = page({ items: [row({ id: '2' }), row({ id: '3' })] });
    expect(mergeRadarPages([p1, p2]).map((a) => a.id)).toEqual(['1', '2', '3']);
  });

  it('nextCursor null → undefined（停止翻页）', () => {
    expect(getRadarNextCursor(page({ nextCursor: 'abc' }))).toBe('abc');
    expect(getRadarNextCursor(page({ nextCursor: null }))).toBeUndefined();
  });
});

// ═══════ 046 T028 —— 行点击进详情：入口转真的机械防线（US1-AS1） ═══════
//
// 045 FR-018 的「即将可用」是**以「本片内详情页尚不存在」为前提**的占位；046 T021 落地后
// 前提失效 ⇒ 行点击直达标的详情。这里守的是「占位串真的没了」—— 留着它就还能被再接回轻提示。
// 「点行 → 详情三块可见」那半是 UI，归 T024 e2e（本仓分层：vitest=logic / Playwright=UI）。
//
// ⚠️ 断言面是**值面**不是源码 grep（Small 档禁磁盘 I/O，且「即将可用」**合法**出现在别的
//    子树 —— 详情屏的选约表分界条、锚表单的变更痕迹）⇒ 只深走 `OPTIONSDESK_COPY.radar`。

/** 深走一棵 copy 子树，把所有字符串（含函数产物）收成一条扁平清单。O(n)。 */
function collectStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (typeof node === 'function')
    out.push(String((node as (x: never) => string)('X' as never)));
  else if (node && typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) collectStrings(v, out);
  }
  return out;
}

describe('🚨 US1-AS1 —— 雷达页内不再有「标的详情即将可用」占位', () => {
  const strings = collectStrings(COPY);

  it('雷达文案子树非空（防「扫了个空对象所以全绿」的假阳性）', () => {
    expect(strings.length).toBeGreaterThan(15);
  });

  it('文案零命中「即将可用」一类占位措辞', () => {
    expect(strings.filter((s) => /即将可用|敬请期待|coming\s*soon/i.test(s))).toEqual([]);
  });

  it('键面也不留 detailComingSoon（防只改值不删键、下次又被接回轻提示）', () => {
    expect(Object.keys(COPY)).not.toContain('detailComingSoon');
  });
});
