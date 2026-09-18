// 085 T008 — 交易账户持仓页 · 展示币种的值域 / 每页签一格状态 / 汇率行出没 / 降级标判定单点
// （plan §D0 / §D7 / §D9）。vitest 覆盖。
//
// 🚨 对 `@nvy/api-client` 只 `import type`：mobile vitest 解析不到它的运行时入口，import 生成的
//    枚举常量对象会让整个 spec 0 用例却 exit 1（同 `trading-account-positions.rules.ts` 头注释）。
// 🚨 **不设「原币种」档**：持仓列表恒按单一市场页签呈现 ⇒ 同屏各行必然同币种，在 hk 页签选
//    「HKD」与选「原币种」显示结果逐字相同，两个档位长得一模一样（spec Clarifications 2026-09-16）。
// 🚨 状态形状 = **每个市场页签一格**（FR-005 / SC-005）：「两个页签各记各的」由形状本身保证，
//    🚫 另加「是否切过」标志 —— 用户手选「与当前市场相同的那一档」时它无法从币种值反推
//    （spec Session 2026-09-17 已据此去掉原 `touched` 设计）。
// 📌 折算全在 server（plan §D2 / Guardrail 8）：本文件只判「出不出汇率行 / 标什么」，
//    🚫 自算汇率、🚫 自算折算值。
// 📌 文案全部取 `OPTIONSDESK_COPY.tradingAccountPositions.displayCurrency`（083 既有段内新增，plan §D9）。
import type {
  BrokerFxRateResponse,
  BrokerPositionGroupResponse,
  BrokerPositionListResponseDisplayCurrency,
  BrokerPositionListRowResponse,
} from '@nvy/api-client';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import type { RadarMarket } from './radar.rules';

const COPY = OPTIONSDESK_COPY.tradingAccountPositions.displayCurrency;

/** 展示币种（= 契约的本屏币种值域；行级那个可空，另有其类型）。 */
export type DisplayCurrency = BrokerPositionListResponseDisplayCurrency;

/** 选择器档位值域。🚨 数组顺序 = 面板上的显示顺序（FR-001：三档 USD / HKD / CNY）。 */
export const DISPLAY_CURRENCIES = [
  'USD',
  'HKD',
  'CNY',
] as const satisfies readonly DisplayCurrency[];

/**
 * 市场 → 该市场原币种（FR-011）。
 * 🚨 `Record<RadarMarket, …>` 穷举：契约新增受支持市场而这里没补，编译当场红。
 */
const MARKET_CURRENCY = {
  us: 'USD',
  hk: 'HKD',
} as const satisfies Record<RadarMarket, DisplayCurrency>;

/** 某市场的原币种 = 该页签首次呈现时的展示币种（FR-011）。O(1)。 */
export function defaultCurrencyForMarket(market: RadarMarket): DisplayCurrency {
  return MARKET_CURRENCY[market];
}

/** 展示币种状态：**每个市场页签一格**（FR-005）。 */
export type DisplayCurrencyByMarket = Record<RadarMarket, DisplayCurrency>;

/**
 * 本次停留的初值：两格各自为其市场原币种（branch 1 / 2）。O(1)。
 * 📌 每次调用返回**新对象** —— 它是屏组件 `useState` 的 initializer，共享同一个对象会让两次进入
 *    该屏共用一份状态，正好绕过 FR-005 的「离开再进入即复原」。
 */
export function initialCurrencyState(): DisplayCurrencyByMarket {
  return { ...MARKET_CURRENCY };
}

/**
 * 在某页签选一档 ⇒ **只写该页签那一格**，另一格逐字不动（FR-005 / branch 4）。不可变更新。O(1)。
 * 🚨 切换市场页签是**读**另一格，不经过本函数 —— 切页签不写任何格（branch 3）。
 */
export function selectCurrency(
  state: DisplayCurrencyByMarket,
  market: RadarMarket,
  currency: DisplayCurrency,
): DisplayCurrencyByMarket {
  return { ...state, [market]: currency };
}

/**
 * 出不出参考汇率行：仅在展示币种 ≠ 当前市场原币种时为真（FR-007 / FR-011；branch 14 / 15）。O(1)。
 * 📌 与服务端「`fxRate === null` 表示不需要折算」是**同一个谓词**；🚫 拿 `fxRate` 是否 falsy 当判据
 *    —— 那会把「已失败」（`available: false`）也当成「不需要折算」而把汇率行整条吞掉。
 */
export function showFxRateLine(input: { market: RadarMarket; current: DisplayCurrency }): boolean {
  return input.current !== defaultCurrencyForMarket(input.market);
}

/**
 * 降级行的币种标（FR-006 / FR-013）：未降级 ⇒ null；券商未回报币种 ⇒ 专门文案；
 * 否则标出该行原币种的三字母代码。O(1)。
 * 🚨 币种未知时 MUST NOT 回落任何币种 —— 标里不出现三档中的任何一个（US3-AS2）。
 */
export function degradedRowLabel(
  row: Pick<BrokerPositionListRowResponse, 'degraded' | 'displayCurrency'>,
): string | null {
  if (!row.degraded) return null;
  if (row.displayCurrency === null) return COPY.rowCurrencyUnknown;
  return COPY.rowOriginalCurrency(row.displayCurrency);
}

/**
 * 组「合计不完整」标（FR-006）：聚合完整 ⇒ null；否则**组市值与组持仓盈亏两列都给标**。O(1)。
 * 🚨 只标一列会让人以为另一列是完整的 —— FR-006 的「聚合值」是这两个。
 */
export function groupIncompleteLabel(
  group: Pick<BrokerPositionGroupResponse, 'aggregateComplete'>,
): { marketValue: string; unrealizedPl: string } | null {
  if (group.aggregateComplete) return null;
  return { marketValue: COPY.aggregateIncomplete, unrealizedPl: COPY.aggregateIncomplete };
}

// ── 085 T010：汇率行 / 降级行金额 / 切档取数期间的占位（plan §D8） ─────────────

/**
 * `capturedAt`（ISO UTC **绝对时刻**）→ 设备本地 `MM-DD HH:mm`；缺失或非法 ⇒ 空串。O(1)。
 *
 * 🚨 **本地墙钟，不是 UTC**：这是给人读的时刻，体例同 `~/format/as-of.ts` 的 `clockHm`
 *    （那里也明写「本地时区，不是 UTC」）。
 * 🚫 `Intl.DateTimeFormat` / `toLocaleString`：Hermes 上 Intl 支持不确定
 *    （`~/format/compact-amount.ts` 文件头同一纪律）⇒ 手工补零。
 */
export function capturedAtLabel(iso: string | null): string {
  if (iso === null) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 参考汇率行的四态；`text` 恒在（`hidden` 时为空串），调用方按 `kind` 决定渲不渲染。 */
export interface FxRateLineView {
  kind: 'hidden' | 'loading' | 'unavailable' | 'ready';
  text: string;
}

/**
 * 参考汇率行（FR-007 / FR-011；branch 14 / 15 / 18 / 19）。O(1)。
 *
 * 🚨 四态**互不合并**，尤其这两个分水岭：
 *    ① 展示币种 = 原币种 ⇒ `hidden`（此刻并未发生折算，标了反而暗示折算过）；
 *    ② 全源失败（`available === false`）⇒ `unavailable`，**不是** `hidden`。
 *    把 `fxRate` 是否 falsy 当判据会把 ② 并进 ①，于是整屏降级却一声不吭。
 * 🚨 陈旧**不是**一态：取数时刻再早也照常 `ready` 并标注时刻（plan §D6 —— 在岸 CNY 盘前
 *    会给数小时前的值，判成不可用会让盘前整屏退回原币种）。本文件不设陈旧阈值。
 */
export function fxRateLine(input: {
  market: RadarMarket;
  current: DisplayCurrency;
  fxRate: BrokerFxRateResponse | null;
  /** 在手数据仍是上一档 ⇒ 取数进行中（见 {@link amountsPending}）。 */
  pending: boolean;
}): FxRateLineView {
  if (!showFxRateLine({ market: input.market, current: input.current })) {
    return { kind: 'hidden', text: '' };
  }
  if (input.pending) return { kind: 'loading', text: COPY.fxRateLoading };
  const fx = input.fxRate;
  if (fx === null || !fx.available || fx.rate === null || fx.capturedAt === null) {
    return { kind: 'unavailable', text: COPY.fxRateUnavailable };
  }
  return {
    kind: 'ready',
    text: COPY.fxRate(COPY.fxRatePair(fx.from, fx.to), fx.rate, capturedAtLabel(fx.capturedAt)),
  };
}

/**
 * 行上该显示的两个金额（FR-006）。O(1)。
 *
 * 🚨 **降级行必须读 `original*`**：server 已把 `marketValue` / `unrealizedPl` 置 `null`
 *    （降级行不进组聚合），直接读那两个字段，降级行在屏上就是两个 `--`，而 FR-006 要的是
 *    「以原币种显示其金额」。
 */
export function rowAmounts(
  row: Pick<
    BrokerPositionListRowResponse,
    'degraded' | 'marketValue' | 'unrealizedPl' | 'originalMarketValue' | 'originalUnrealizedPl'
  >,
): { marketValue: string | null; unrealizedPl: string | null } {
  if (row.degraded) {
    return { marketValue: row.originalMarketValue, unrealizedPl: row.originalUnrealizedPl };
  }
  return { marketValue: row.marketValue, unrealizedPl: row.unrealizedPl };
}

/**
 * 在手响应是否还是**上一档**的币种 ⇒ 金额位占位（branch 18）。O(1)。
 *
 * 🚨 切档那一拍 react-query 换 key，`placeholderData: keepPreviousData` 让上一档的行留在屏上
 *    —— 那些数字是**上一个币种**的。判据取响应自报的 `displayCurrency` 与当前所选是否一致，
 *    🚫 拿 `isFetching` 当判据：下拉重读同一档时它也为真，会把好好的金额全抹成 `--`。
 */
export function amountsPending(input: {
  selected: DisplayCurrency;
  responseCurrency: DisplayCurrency;
}): boolean {
  return input.selected !== input.responseCurrency;
}
