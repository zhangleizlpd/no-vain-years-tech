import { parseGateTicker } from './anchor-driven-sync-gate.js';

/**
 * 「哪些同步维度是**锚作用域**的」的**唯一**登记处 (066 T02, FR-006 / FR-007 / FR-008,
 * plan §A3)。纯函数、**零 I/O**、无 DI (ADR-0043 §4) —— 锚集与标的表的读取由调用方
 * (`dimension-executor.ts` 的 `loadWorkingSet`) 做, 本文件只定判据。
 *
 * 范式**照抄** `anchor-cold-start.rules.ts` 的 {@link
 * import('./anchor-cold-start.rules.js').COLD_START_CAPABILITY}: 一张表 + 一个查表函数,
 * **一处登记**。🚫 判据 MUST NOT 散进 `dimension-executor.ts` 的 if 分支 —— 那正是
 * `COLD_START_CAPABILITY` 当初要禁的形态 (散开就会漂, 且漂了不报错)。
 *
 * ## 这一类维度是什么
 *
 * 工作集 = `{ market ∈ marketScope, status: 'active' } ∩ 锚集`, **`needSync` 不进谓词**。
 *
 * 判据是「**该维度的工作集在语义上就是锚集本身**」—— per-code 接口 (单 code 一次调用),
 * 无锚不采, 调用数与锚数量成正比。凡满足这条的维度都该登记在此。
 *
 * ## 🚨 为什么不能靠 `needSync` (这是本表存在的全部理由)
 *
 * `needSync` 的重算方只有 `AnchorDrivenSyncGate`, 而它只循环 `ANCHOR_GATED_MARKETS`
 * = `['us']` ⇒ **港股的 `needSync` 恒为 true** (`sync-universe` create 分支
 * `market !== 'us'` 给 true, update 分支刻意不写, 闸不碰)。⇒ 对港股, `needSync` 谓词
 * **零收窄作用**: `market_scope={hk}` 的期权维度单靠它, 工作集就是整个港股 universe,
 * 链发现 (单 code 接口 × 每票多窗) 会炸成小时级墙钟。
 *
 * 🚫 **MUST NOT 把 `hk` 加进 `ANCHOR_GATED_MARKETS` 来"修"这件事** ——
 * `anchor-driven-sync-gate.ts` 粗体写明: 关闸路径 (`notIn`) 放到 cn/hk 会把全部 cn/hk
 * **在市**标的一次性移出工作集, 直接打死 22:00 那 18 个理杏仁维度 (SC-004)。那条路是
 * 成对约束的另一半, 不是本表的替代品。本文件的单测有一条机械断言钉住 `hk` 不在里面。
 *
 * ## 🚨 对美股是**逐点等价**改写, 不是行为变更
 *
 * 闸已让 `needSync ≡ 有锚` (us 双 `updateMany`: 有锚开、无锚关), 故对 us 而言
 * 「`needSync = true`」与「code ∈ 锚集」是同一集合 —— 换判据后 us 侧工作集逐元素不变
 * (FR-008)。这条**必须是断言不是承诺**, 载体见
 * `test/integration/marketdata-066.anchor-scoped-workset.it.spec.ts` 的 ①。
 *
 * 顺带免疫 A4 那条缺口: 锚集里的标的不会再因为 `needSync` 被 seed 路径写错而掉出自己的
 * 期权维度 (但 A4 仍必须修 —— `eod_bar` / `sync-profile` / backfill CLI 三个消费方
 * **仍然**读这一列, 见 plan §A4 末尾)。
 */
export const ANCHOR_SCOPED_DIMENSIONS: readonly string[] = [
  // 046 M2a 标的级 IV 日快照: per-code overview + his_volatility, 无锚不采 (FR-026)。
  'underlying_iv_daily',
  // 047 M2b 链合约发现: `get_option_chain` 是单 code + 到期日窗接口 (FR-035)。
  'option_contract',
  // 047 M2b 全链逐日快照: 同为 per-code, 且工作集实际是「锚的**合约**」(FR-031)。
  'option_daily_snapshot',
  // ── 066 港股三行。**蓄意先于 T04 的 seed 登记**(排序铁律 2): 反了的话
  //    `hk_option_contract` 上线那一刻工作集是整个港股 universe。登记一个尚无 seed 行的
  //    维度键是**无害 no-op** —— 本表按 key 查, 没有 `SyncDimension` 行的维度根本不会跑。
  'hk_underlying_iv_daily',
  'hk_option_contract',
  'hk_option_daily_snapshot',
  // 073 T001 轮2 OI 定稿回填: 工作集 = **主轮同一批锚的合约** (`option_contract` 表), 同为
  // per-code 快照接口 ⇒ 与 `hk_option_daily_snapshot` 同档。
  // 🚨 漏登记**不会红** —— 港股 `needSync` 恒 true (见上文), 表现是 21:40 那轮对整个港股
  // universe 发请求。
  'hk_option_oi_settle',
];

/**
 * 该维度是不是锚作用域的。复杂度 O(表长) —— 表是常量级 (个位数), 且每轮维度执行只查一次。
 *
 * 🚨 **不在表里的维度一律走旧判据 (`needSync`), 这是刻意的**, 别顺手把日线类维度加进来:
 * - `eod_bar` (`{cn,hk}`) / `us_equity_bar` (`{us}`): **市场级成员制**语义 —— cn/hk 是全量
 *   采集, us 由闸收成锚集。它们不是 per-code 稀疏接口, 判据归闸管 (这也是 SC-004 的前提)。
 * - `us_index_daily` / `earnings_event`: 压根不走 `loadWorkingSet` (前者工作集 = 两个固定
 *   代码常量, 后者是市场级接口), 挂锚闸零收窄作用且会复刻「零锚时静默不采」那个坑。
 */
export function isAnchorScopedDimension(dimensionKey: string): boolean {
  return ANCHOR_SCOPED_DIMENSIONS.includes(dimensionKey);
}

/**
 * 锚表 ticker 列 → 按市场分组的 code 集, 只保留落在 `scope` 内的市场。
 *
 * 分组而**不是**拍平成一个 code 数组: 拍平后 `code: { in: [...] }` 会跨市场误命中
 * (同一 code 在两个市场各有一只票时, 另一市场那只会被捞进来)。今天 scope 恒为单市场,
 * 这条防的是「日后某个锚作用域维度配了多市场 scope」——那时错了不会红。
 *
 * 🚨 只吃 `ticker` 一列: `excluded` **MUST NOT** 参与判定 (同
 * `anchor-driven-sync-gate.ts` 的 FR-028 —— 锚 = 采集意愿、`excluded` = 交易意愿,
 * 要彻底停采只能删锚)。不可解析的 ticker 静默跳过, 与闸侧同口径。
 *
 * 复杂度: O(锚数)。
 */
export function anchoredCodesForScope(
  tickers: readonly string[],
  scope: readonly string[],
): Map<string, string[]> {
  const byMarket = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const ticker of tickers) {
    const parsed = parseGateTicker(ticker);
    if (parsed === null || !scope.includes(parsed.market)) continue;
    // 同一 `market:code` 可有多只锚 (锚按用户 / 按方法区分), 工作集去重后才是标的集。
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    const codes = byMarket.get(parsed.market);
    if (codes) codes.push(parsed.code);
    else byMarket.set(parsed.market, [parsed.code]);
  }
  return byMarket;
}
