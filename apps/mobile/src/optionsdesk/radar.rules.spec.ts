// 045 T024 — 雷达五态 / 徽标 / 行字段 / 新鲜度 / 筛选 / 分页纯函数单测。
// 渲染与交互（下拉加载手势、chips 点击、占位入口 tap）走 T025 E2E。
import { describe, expect, it } from 'vitest';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import {
  MARKETS_WITHOUT_INTRADAY,
  RADAR_BADGE_ORDER,
  RADAR_MARKETS,
  RADAR_QUERY_KEY,
  radarQueryKey,
  RADAR_FILTER_KEYS,
  RADAR_ROW_FIELD_KEYS,
  distanceToWTone,
  formatDistanceToW,
  formatSpot,
  getRadarNextCursor,
  marketLacksIntraday,
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
    // 061：默认收盘档 ⇒ 生效 spot 三元组与 lastClose / lastCloseDate 同值同粒度。
    spot: '37.20',
    priceKind: 'eod_close',
    spotAsOf: '2026-07-28',
    distanceToWPct: '-3.10',
    ...over,
  };
}

/** 061 降级态（既无实时价也无收盘价）—— 三元组与两个收盘字段一起全空。 */
const NO_QUOTE = {
  lastClose: null,
  lastCloseDate: null,
  spot: null,
  spotAsOf: null,
  distanceToWPct: null,
  zone: null,
} satisfies Partial<RadarRowAnchor>;

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
    const p = page({ items: [row(NO_QUOTE)], emptyState: 'all_idle' });
    expect(radarViewState(p)).toBe('quotes_degraded');
  });

  it('部分行有行情 → 仍是常态（单票缺失走行内标记，不升级成整页降级）', () => {
    expect(radarViewState(page({ items: [row(), row({ id: '2', ...NO_QUOTE })] }))).toBe('normal');
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
    const badges = radarBadges(row({ ...NO_QUOTE, reviewFlagOn: true }));
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
    const fields = radarRowFields(row(NO_QUOTE));
    expect(Object.keys(fields)).toHaveLength(5);
    expect(fields.spot).toBe(COPY.quoteUnavailable);
    expect(fields.distanceToW).toBe(`${COPY.distancePrefix}${COPY.noValue}`);
  });
});

describe('SC-004 —— 不存在无标注的数值（数值与 asOf 同生共死）', () => {
  it('spot 有值但 spotAsOf 为 null → **不渲染数值**，退成显式不可用', () => {
    const a = row({ spot: '37.20', spotAsOf: null });
    expect(formatSpot(a)).toBe(COPY.quoteUnavailable);
    expect(formatSpot(a)).not.toContain('37.20');
  });

  it('距 W% 同理：没有 asOf 就不给数值', () => {
    const a = row({ distanceToWPct: '-3.10', spotAsOf: null });
    expect(formatDistanceToW(a)).toBe(`${COPY.distancePrefix}${COPY.noValue}`);
    expect(formatDistanceToW(a)).not.toContain('3.1');
  });

  it('色带也不画 spot 点（几何位置同样是「数值」）', () => {
    expect(radarRowFields(row({ spotAsOf: null })).band.lastClose).toBeNull();
  });

  it('asOf 齐备 → 数值照常，符号与量级正确', () => {
    expect(formatDistanceToW(row())).toBe('距 W −3.1%');
    expect(formatDistanceToW(row({ distanceToWPct: '13.10' }))).toBe('距 W +13.1%');
    expect(formatDistanceToW(row({ distanceToWPct: '0.00' }))).toBe('距 W 0.0%');
  });
});

describe('radarFreshness — asOf 新鲜度档（FR-016）', () => {
  it('server 判 CURRENT → 「数据截至 X · 收盘」', () => {
    const f = radarFreshness([row({ spotAsOf: '2026-07-30' })]);
    expect(f.tier).toBe('CURRENT');
    expect(f.text).toBe('数据截至 2026-07-30 · 收盘');
  });

  it('server 判 STALE → 同一句 + 陈旧后缀（禁静默当实时）', () => {
    const f = radarFreshness([row({ spotAsOf: '2026-07-28', quoteFreshnessTier: 'STALE' })]);
    expect(f.tier).toBe('STALE');
    expect(f.text).toBe(`数据截至 2026-07-28 · 收盘${COPY.freshStaleSuffix}`);
  });

  it('全无行情 → 显式不可用，asOf = null（不编造日期）', () => {
    const f = radarFreshness([row({ ...NO_QUOTE, quoteFreshnessTier: 'UNAVAILABLE' })]);
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
      row({ spotAsOf: '2026-07-27', quoteFreshnessTier: 'STALE' }),
      row({ spotAsOf: '2026-07-29', quoteFreshnessTier: 'CURRENT' }),
    ]);
    expect(f.asOf).toBe('2026-07-29');
    expect(f.tier).toBe('CURRENT');
    expect(f.text).toContain('2026-07-29');
  });
});

// ═══════ 061 T014 —— 生效 spot 的呈现（FR-009 / FR-014，plan D10） ═══════
//
// 本片给雷达行换了**取数口径**：价 / 距 W% / 色带点全部改吃 `spot`（生效 spot），
// 而不再各吃各的。只给档位不给价 ⇒ 「价说昨收、距 W% 说实时」，那正是 T011 把
// 三个字段一起下发的理由。

describe('061 —— 行内数值一律取生效 spot（禁两个口径同屏）', () => {
  /** 盘中实时档：spot 与 lastClose 是两个数（前者分钟级、后者昨收）。 */
  const REALTIME = {
    lastClose: '37.20',
    lastCloseDate: '2026-08-16',
    spot: '35.90',
    priceKind: 'realtime',
    spotAsOf: '2026-08-17T13:22:31',
    distanceToWPct: '-6.51',
  } satisfies Partial<RadarRowAnchor>;

  it('spot 串取 `spot` 而非 `lastClose` —— 两者不同值时渲染的是前者', () => {
    expect(formatSpot(row(REALTIME))).toBe('S 35.90');
    expect(formatSpot(row(REALTIME))).not.toContain('37.20');
  });

  it('色带黑点也落在生效 spot 上（点与距 W% 必须同源，否则同屏两个口径）', () => {
    expect(radarRowFields(row(REALTIME)).band.lastClose).toBe('35.90');
  });

  it('可呈现闸看 `spotAsOf`：lastCloseDate 缺席但实时价新鲜 → 照常出数', () => {
    const a = row({ ...REALTIME, lastClose: null, lastCloseDate: null });
    expect(formatSpot(a)).toBe('S 35.90');
    expect(formatDistanceToW(a)).toBe('距 W −6.5%');
    expect(radarBadges(a).map((b) => b.kind)).not.toContain('quote_unavailable');
  });
});

describe('061 —— asOf 粒度即档位（FR-009，档位本身不上屏）', () => {
  it('实时档 → 顶条呈**时刻**，不出现交易日、不出现「收盘」', () => {
    const f = radarFreshness([row({ priceKind: 'realtime', spotAsOf: '2026-08-17T13:22:31' })]);
    expect(f.text).toBe('数据截至 13:22');
    expect(f.text).not.toContain('2026-08-17');
    expect(f.text).not.toContain('收盘');
  });

  it('收盘档 → 顶条呈**交易日**（粒度不含时刻）', () => {
    const f = radarFreshness([row({ priceKind: 'eod_close', spotAsOf: '2026-08-14' })]);
    expect(f.text).toBe('数据截至 2026-08-14 · 收盘');
    expect(f.text).not.toMatch(/\d{2}:\d{2}/);
  });

  it('实时档在闸内 ⇒ 恒 CURRENT —— 90 秒内的价说「已过时」是自相矛盾', () => {
    const f = radarFreshness([
      row({ priceKind: 'realtime', spotAsOf: '2026-08-17T13:22:31', quoteFreshnessTier: 'STALE' }),
    ]);
    expect(f.tier).toBe('CURRENT');
    expect(f.text).not.toContain(COPY.freshStaleSuffix);
  });

  it('时刻串与日期串混排时仍取最新那行（`YYYY-MM-DD` 是 ISO 的前缀 ⇒ 字典序可比）', () => {
    const f = radarFreshness([
      row({ priceKind: 'eod_close', spotAsOf: '2026-08-17' }),
      row({ priceKind: 'realtime', spotAsOf: '2026-08-17T13:22:31' }),
    ]);
    expect(f.text).toBe('数据截至 13:22');
  });
});

describe('061 —— 降级时距 W% 呈空，MUST NOT 呈 0（FR-014）', () => {
  it('两价皆无 → 距 W% 是「—」而不是 0.0%（0 是「正好在带上」的强信号）', () => {
    const text = formatDistanceToW(row(NO_QUOTE));
    expect(text).toBe(`${COPY.distancePrefix}${COPY.noValue}`);
    expect(text).not.toContain('0');
    expect(text).not.toContain('%');
  });

  it('色调也退成中性（不借跌破 W 的危险色表达「没数据」）', () => {
    expect(distanceToWTone(row(NO_QUOTE))).toBe('none');
  });

  it('真的 0.0% 仍照常呈现 —— 空与 0 是两件事，别把有效值一起吞了', () => {
    expect(formatDistanceToW(row({ distanceToWPct: '0.00' }))).toBe('距 W 0.0%');
    expect(distanceToWTone(row({ distanceToWPct: '0.00' }))).toBe('above');
  });
});

// ═══════ 🚨 Guardrail 18 护栏 —— 档位不上屏，不新增任何视觉元素 ═══════
//
// tasks.md 原文建议「雷达行的渲染树节点数与改动前一致」。节点数断言只能落在 e2e，且对
// 无关的版式微调过敏（挪一个 wrapper 就红，但那不是本条要防的事）。这里换成**等价强度**
// 的值面断言：雷达行的渲染树由 `RADAR_ROW_FIELD_KEYS` 与 `RADAR_BADGE_ORDER` 两份白名单
// 完全决定（`radar-screen.tsx` 的 `RadarRow` 逐字段渲染 + `badges.map`）⇒ 只要这两份白名单
// 不变、且**档位翻转不改变任一字段的存在性**，就没有任何新节点能被生出来。
// 它比节点数更强的地方：节点数相等也可能是「加了一个徽标、删了一个字段」；这里逐键比对。

describe('🚨 Guardrail 18 —— 档位不产出任何新视觉元素', () => {
  const eod = row({ priceKind: 'eod_close', spotAsOf: '2026-07-28' });
  const realtime = row({ priceKind: 'realtime', spotAsOf: '2026-07-28T13:22:31' });

  it('行字段白名单恒为 5 项且键序不变（新增一个视觉维度会让它变长）', () => {
    expect(RADAR_ROW_FIELD_KEYS).toEqual(['identity', 'distanceToW', 'band', 'spot', 'badges']);
  });

  it('徽标白名单恒为 5 项 —— 没有 price_kind / realtime 一类的新 kind', () => {
    expect(RADAR_BADGE_ORDER).toEqual([
      'l_level',
      'zone',
      'overdue',
      'review_flag',
      'quote_unavailable',
    ]);
  });

  it('同一行只翻档位：字段键集合逐键相同（不多不少、不换序）', () => {
    expect(Object.keys(radarRowFields(realtime))).toEqual(Object.keys(radarRowFields(eod)));
  });

  it('同一行只翻档位：徽标序列**完全相同**（档位不生徽标、不改徽标文案）', () => {
    expect(radarBadges(realtime)).toEqual(radarBadges(eod));
  });

  it('行内任何一段文本都不含档位字样（realtime / 实时 / eod_close）', () => {
    const fields = radarRowFields(realtime);
    const texts = [fields.spot, fields.distanceToW, ...fields.badges.map((b) => b.text)];
    for (const t of texts) {
      expect(t).not.toMatch(/realtime|eod_close|实时/);
    }
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

// ── 065 T10 市场页签集合 (FR-001) ────────────────────────────────────────────

describe('065 RADAR_MARKETS —— 页签集合从契约派生', () => {
  it('🚨 恰好是文案表的键 —— 集合与契约的绑定靠它 (有人改成硬编码数组这条就会红)', () => {
    // 文案表是 `satisfies Record<RadarMarket, string>` ⇒ 契约加市场不补文案即 tsc 红。
    // 本条钉的是「集合确实取自那张表」—— 改成字面量 `['us','hk']` 后, 下次 server 加市场时
    // 文案表(被 tsc 逼着)会多一个键而集合不会, 这条当场红。那正是 FR-015 要防的时刻。
    expect(RADAR_MARKETS).toEqual(Object.keys(OPTIONSDESK_COPY.radar.marketTabs));
  });

  it('美股在前 —— FR-005「冷启动落美股」的前提 (顺序来自 server 常量, 不在前端改)', () => {
    expect(RADAR_MARKETS[0]).toBe('us');
  });

  it('每个市场都有页签文案且两两互异 (satisfies 是编译期, 这条是运行期兜底)', () => {
    const labels = RADAR_MARKETS.map((m) => OPTIONSDESK_COPY.radar.marketTabs[m]);
    expect(labels.filter((l) => typeof l === 'string' && l.length > 0)).toHaveLength(
      RADAR_MARKETS.length,
    );
    expect(new Set(labels).size).toBe(labels.length);
  });
});

// ── 066 T12 市场能力表 (FR-020) ──────────────────────────────

describe('066 MARKETS_WITHOUT_INTRADAY —— 港股实时报价上线后表内清空 (FR-020)', () => {
  it('🚨 hk 不再算「无盘中」—— 066 T10 把港股接进实时报价, 常驻说明再留就是骗人', () => {
    expect(marketLacksIntraday('hk')).toBe(false);
  });

  it('受支持市场无一缺盘中价 ⇒ 能力表为空 (常量本身保留: 下一个无盘中市场的落点)', () => {
    expect(MARKETS_WITHOUT_INTRADAY).toEqual([]);
    expect(RADAR_MARKETS.filter((m) => marketLacksIntraday(m))).toEqual([]);
  });

  it('表外市场一律 false —— 判据是白名单式「在表里才算」, 不是取反', () => {
    expect(marketLacksIntraday('cn')).toBe(false);
  });
});

// ── 065 T11 query key 工厂 + SC-002 新鲜度粒度 ───────────────────────────────

describe('065 radarQueryKey —— 列表侧与 mutation 失效侧的同一处', () => {
  it('同参数 → 同 key（结构相等即可, react-query 按结构比对）', () => {
    expect(radarQueryKey('us', { belowW: true })).toEqual(radarQueryKey('us', { belowW: true }));
  });

  it('🚨 市场不同 → key 不同 (切页签即换 query ⇒ pageParam 自然重置回首页)', () => {
    // 这条是 plan D6 敢撤销「market 编进游标」的依据: 跨市场游标在 app 里**不可达**。
    // 把 market 从 key 里拿掉, 那个判定当场失效, 而**列表照样能渲染**、没有别的断言会红。
    expect(radarQueryKey('us', {})).not.toEqual(radarQueryKey('hk', {}));
  });

  it('筛选不同 → key 不同; 且两者与前缀共享 RADAR_QUERY_KEY（mutation 失效靠这个前缀命中）', () => {
    expect(radarQueryKey('us', {})).not.toEqual(radarQueryKey('us', { pendingReview: true }));
    for (const key of [radarQueryKey('us', {}), radarQueryKey('hk', { belowW: true })]) {
      expect(key.slice(0, RADAR_QUERY_KEY.length)).toEqual([...RADAR_QUERY_KEY]);
    }
  });
});

describe('065 SC-002 —— 同一页签内行情时点粒度同质', () => {
  type FreshRow = Pick<RadarRowAnchor, 'spotAsOf' | 'priceKind' | 'quoteFreshnessTier'>;
  const freshRow = (
    spotAsOf: string,
    priceKind: FreshRow['priceKind'],
    tier: FreshRow['quoteFreshnessTier'],
  ): FreshRow => ({ spotAsOf, priceKind, quoteFreshnessTier: tier });

  it('🚨 只含 hk 行 → 交易日粒度, 不是时刻粒度 (港股无盘中实时价, 061 FR-010)', () => {
    const fresh = radarFreshness([freshRow('2026-08-21', 'eod_close', 'CURRENT')]);
    // 日粒度的判据是文本里**没有**时刻 —— 用冒号做判据比比对整句文案结实(文案会改)。
    expect(fresh.text).not.toMatch(/\d{2}:\d{2}/);
    expect(fresh.asOf).toBe('2026-08-21');
  });

  it('🚨 反例记录: 不分市场混排时, 一只美股实时行就把整条 bar 拉成时刻粒度', () => {
    // 本条断言的是**今天混排会发生什么**, 它是「为什么必须按市场分作用域」的机械证据:
    // 字典序 = 时间序, 美股的 `...T13:45:00` > 港股的 `2026-08-21` ⇒ 聚合落到美股那行,
    // 于是港股用户在顶部看到「实时」, 而他那几行全是昨收。065 之后两个市场各查各的, 撞不上。
    const mixed = radarFreshness([
      freshRow('2026-08-21', 'eod_close', 'CURRENT'),
      freshRow('2026-08-21T13:45:00.000Z', 'realtime', 'CURRENT'),
    ]);
    expect(mixed.text).toMatch(/\d{2}:\d{2}/);
  });
});

// ── 065 T13 空态映射强制穷举 (FR-008 / FR-010, SC-004) ───────────────────────

describe('065 radarViewState —— server 四态的全映射', () => {
  const statePage = (
    emptyState: RadarPageLike['emptyState'],
    items: RadarRowAnchor[] = [row()],
  ) => ({ emptyState, items });

  it('🚨 第 4 态映射到**自己的** view state, 而不是 filtered_empty', () => {
    // 改回 if 链的那一刻这条就红。fall-through 的病症很隐蔽: 文案是对的(server 下发),
    // 但会配一个什么都不做的「清除筛选」按钮 —— 当时根本没选筛选。
    expect(radarViewState(statePage('zero_anchors_in_market', []))).toBe('zero_anchors_in_market');
    expect(radarViewState(statePage('zero_anchors_in_market', []))).not.toBe('filtered_empty');
  });

  it('四个 server 态各自透传, 互不折叠', () => {
    expect(radarViewState(statePage('zero_anchors', []))).toBe('zero_anchors');
    expect(radarViewState(statePage('filtered_empty', []))).toBe('filtered_empty');
    expect(radarViewState(statePage('all_idle'))).toBe('all_idle');
    expect(radarViewState(statePage(null))).toBe('normal');
  });

  it('🚨 行情整体不可得仍压过 all_idle (「没数据」≠「今日无解, 空仓是常态」)', () => {
    const noQuote = [row({ spotAsOf: null })];
    expect(radarViewState({ emptyState: 'all_idle', items: noQuote })).toBe('quotes_degraded');
    // 而零锚类**不**让位给降级 —— 它们说的是「一行都没有」, 压根没有行可降级。
    expect(radarViewState({ emptyState: 'zero_anchors_in_market', items: noQuote })).toBe(
      'zero_anchors_in_market',
    );
  });
});
