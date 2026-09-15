// 083 T013 — 交易账户页 · 持仓分段的视图判定与行展示规则单点（plan §D14）。vitest 覆盖。
//
// 🚨 对 `@nvy/api-client` 只 `import type`（mobile vitest 解析不到其运行时入口）；枚举值用
//    字符串字面量 + 生成类型约束，🚫 import 生成的枚举常量对象。
// 🚨 时间：服务端已给交易所当地时间串 `YYYY-MM-DD HH:mm:ss`（`…Local` 字段），这里**只做字符串
//    重排** + 按 `market` 拼时区标签；🚫 任何时区换算（plan §D13，Guardrail 8）。
// 📌 文案全部取 `OPTIONSDESK_COPY.tradingAccountPositions`（独立段，🚫 081 `tradingAccount` 段）。
import type {
  BrokerBackfillRunResponse,
  BrokerPositionGroupResponse,
  BrokerPositionListResponse,
  BrokerPositionOptionResponseRight,
  BrokerPositionRowResponseKind,
  BrokerPositionRowResponseMarket,
} from '@nvy/api-client';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.tradingAccountPositions;

/** 持仓分段的视图：四种非列表状态 + 列表（FR-010）。 */
export type PositionsView = 'error' | 'no-connection' | 'never-synced' | 'empty' | 'list';

/**
 * 视图判定入参。
 *
 * 📌 「无数据且未失败」（首载进行中）**刻意不可表示**：那是调用方 `isPending` 分支的加载态，
 *    不属于这五种视图；类型上排除它，调用方漏判加载态会编译不过，而不是静默显示错误卡。
 */
export type PositionsViewInput =
  | { hasData: false; isError: true; data?: undefined }
  | { hasData: true; isError: boolean; data: BrokerPositionListResponse };

/**
 * 优先级：无已加载数据且失败 → 无连接 → 从未同步 → 空 → 列表。O(1)。
 *
 * 🚨 **已有数据时重读失败仍返回当前视图**（`isError` 只在无数据时生效）—— 失败提示由
 *    {@link refetchFailed} 驱动、换掉同步时刻行；🚫 用错误卡替换已显示数据（FR-023，Guardrail 10）。
 */
export function resolvePositionsView(input: PositionsViewInput): PositionsView {
  if (!input.hasData) return 'error';
  const { data } = input;
  if (!data.hasConnection) return 'no-connection';
  if (data.syncedAt === null) return 'never-synced';
  if (data.groups.length === 0) return 'empty';
  return 'list';
}

/** 有已加载数据且最近一次请求失败 ⇒ 同步时刻行换成「刷新失败」提示（FR-023）。O(1)。 */
export function refetchFailed(input: { hasData: boolean; isError: boolean }): boolean {
  return input.hasData && input.isError;
}

/** 详情屏（持仓 / 订单共用）的视图。 */
export type DetailView = 'loading' | 'not-found' | 'error' | 'ready';

/**
 * 详情请求失败是否为「记录不存在」（FR-020）。O(1)。
 * 判 HTTP 404（同 `underlying-detail.rules.ts` `isNoAnchorError` 体例）：不存在 / 不属于本账号 / 正股未归类 /
 * 不在锚集四种情况服务端响应逐字节相同（错误码在 ProblemDetail `detail`，没有 `code`），状态码即足够，订单详情共用。
 */
export function isDetailNotFound(error: unknown): boolean {
  const e = error as { isAxiosError?: boolean; response?: { status?: number } } | null | undefined;
  return e?.isAxiosError === true && e.response?.status === 404;
}

/**
 * 详情屏视图，优先级：不存在 → 已有数据 → 首次加载中 → 加载失败。O(1)。
 * 🚨 404 **优先于**已显示的旧数据（FR-020）；其余失败有数据时保留数据，顶部提示走 `refetchFailed`（FR-023）。
 */
export function resolveDetailView(input: {
  isPending: boolean;
  hasData: boolean;
  isError: boolean;
  notFound: boolean;
}): DetailView {
  if (input.isError && input.notFound) return 'not-found';
  if (input.hasData) return 'ready';
  return input.isPending ? 'loading' : 'error';
}

/** 组内 ≥ 2 行才出组头；单行组直接平铺（FR-004）。O(1)。 */
export function showGroupHeader(group: Pick<BrokerPositionGroupResponse, 'rows'>): boolean {
  return group.rows.length >= 2;
}

/** 券商连接 > 1 个才在行上显示连接名称（FR-012）。O(1)。 */
export function showConnectionLabel(brokerCount: number): boolean {
  return brokerCount > 1;
}

/** 未归类条数 > 0 显示提示；空态同样适用（FR-010 / FR-011）。O(1)。 */
export function showUnresolvedHint(count: number): boolean {
  return count > 0;
}

/** 期权名称 = 正股名 + 美股 `Call` / `Put`、港股 `购` / `沽`（FR-007）。O(1)。 */
export function optionDisplayName(input: {
  market: BrokerPositionRowResponseMarket;
  underlyingName: string;
  right: BrokerPositionOptionResponseRight;
}): string {
  return `${input.underlyingName} ${COPY.optionRight[input.market][input.right]}`;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** `2026-09-29` ⇒ `260929`；形态不合法 ⇒ 原样返回（不吞信息）。O(1)。 */
export function expiryYymmdd(expiry: string): string {
  if (!YMD.test(expiry)) return expiry;
  return `${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}`;
}

/**
 * 行权价去尾零：`12.500` ⇒ `12.5`、`300.000` ⇒ `300`。O(n)。
 * 🚨 纯字符串处理：无小数点的整数（`300`）不动，🚫 转 Number（避免精度与科学计数法）。
 */
export function trimStrike(strike: string): string {
  if (!strike.includes('.')) return strike;
  return strike.replace(/0+$/, '').replace(/\.$/, '');
}

export interface LocalDateTimeParts {
  /** `2026/09/08` */
  ymd: string;
  /** `14:05:12` */
  hms: string;
  /** `09-08 14:05` */
  mdHm: string;
}

/**
 * 交易所当地时间串 `YYYY-MM-DD HH:mm:ss` 拆成展示片段。**只重排，不换算。** O(1)。
 * 形态不合法（如带 `T` / `Z` 的 ISO 串）⇒ null，调用方不渲染，🚫 猜时区。
 */
export function localDateTimeParts(local: string): LocalDateTimeParts | null {
  const m = LOCAL_DATE_TIME.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return { ymd: `${y}/${mo}/${d}`, hms: `${h}:${mi}:${s}`, mdHm: `${mo}-${d} ${h}:${mi}` };
}

/** 按市场出时区标签：`（美东）` / `（香港）`。O(1)。 */
export function marketTzLabel(market: BrokerPositionRowResponseMarket): string {
  return COPY.tzLabel[market];
}

/** canonical ticker 前缀 → 市场；非 `us:` / `hk:` ⇒ null（补齐接口只收这两种，server `^(us|hk):` 校验）。O(1)。 */
function tickerMarket(ticker: string): BrokerPositionRowResponseMarket | null {
  if (ticker.startsWith('us:')) return 'us';
  if (ticker.startsWith('hk:')) return 'hk';
  return null;
}

/**
 * 冷启动结局 → 补齐状态请求的 `tickers`：去重、只留 `us:` / `hk:` 前缀（混进一个非法形态会让整次请求 400）。
 * 结局条数受冷启动页 `MAX_TRACKED_ANCHORS = 50` 约束 ⇒ 不超过接口的 50 上限。O(n)。
 */
export function backfillQueryTickers(runs: readonly { ticker: string }[]): string[] {
  return [...new Set(runs.map((run) => run.ticker))].filter(
    (ticker) => tickerMarket(ticker) !== null,
  );
}

/** 补齐记录按 ticker 建索引（FR-018「按 ticker 合并」；记录只带 ticker，🚫 按 anchorId）。O(n)。 */
export function indexBackfillRunsByTicker<T extends { ticker: string }>(
  runs: readonly T[],
): ReadonlyMap<string, T> {
  return new Map(runs.map((run) => [run.ticker, run]));
}

/**
 * 冷启动页「券商历史 · 状态 · 时刻」一行（FR-018，plan D16）。无记录 ⇒「券商历史 · 未触发」；
 * 时刻 = `atLocal` 重排为 `MM-DD HH:mm` + 按 ticker 前缀市场的时区标签（🚫 换算）；缺失或形态不合法 ⇒ 不拼时刻。O(1)。
 */
export function brokerBackfillLine(
  ticker: string,
  run: Pick<BrokerBackfillRunResponse, 'status' | 'atLocal'> | undefined,
): string {
  const copy = COPY.brokerBackfill;
  if (run === undefined) return `${copy.prefix} · ${copy.none}`;
  const head = `${copy.prefix} · ${copy.status[run.status]}`;
  const parts = run.atLocal === null ? null : localDateTimeParts(run.atLocal);
  const market = tickerMarket(ticker);
  return parts === null || market === null
    ? head
    : `${head} · ${parts.mdHm}${marketTzLabel(market)}`;
}

/** 数值串 → 有限数；null / 空串 / 不可解析（如 `N/A`）⇒ null。 */
function parseFinite(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export type PlColorClass =
  | 'text-quote-up'
  | 'text-quote-down'
  | 'text-quote-flat'
  | 'text-ink-subtle';

/**
 * 持仓盈亏（金额 / 比例 / 组盈亏）涨跌色：正 ⇒ up、负 ⇒ down、0 ⇒ flat；null / 非法 ⇒ 中性灰。O(1)。
 * 📌 映射体例同 `portfolio/use-quote-merge.ts` `quoteColorClass`（跨 feature 不可 import，此处独立一份）。
 */
export function plColorClass(value: string | null): PlColorClass {
  const n = parseFinite(value);
  if (n === null) return 'text-ink-subtle';
  if (n > 0) return 'text-quote-up';
  if (n < 0) return 'text-quote-down';
  return 'text-quote-flat';
}

/**
 * 持仓盈亏比例：带符号两位小数 + `%`；null / 非法 ⇒ `--`。O(1)。
 * 🚫 再乘 100 —— EVIDENCE: pl_ratio_avg_cost 为百分数值（非小数）—— 维护者 082 POC 私有持仓样本逐行复核，
 * 与 (现价 − 平均成本) ÷ 平均成本 的比值均约为 100 倍；主 agent 2026-09-15 核；证据 docs/private/evidence/broker-account-poc/
 * 比例不缩写（FR-022）；舍入后为零不带符号。
 */
export function formatPlRatio(value: string | null): string {
  const n = parseFinite(value);
  if (n === null) return '--';
  const digits = Math.abs(n).toFixed(2);
  const sign = Number(digits) === 0 ? '' : n < 0 ? '-' : '+';
  return `${sign}${digits}%`;
}

/** 正股行第二行代码：去掉券商市场前缀（`US.ZQY` ⇒ `ZQY`）；无前缀 ⇒ 原样。O(n)。 */
export function displayCode(code: string): string {
  const dot = code.indexOf('.');
  return dot < 0 ? code : code.slice(dot + 1);
}

/** 持仓身份字段（列表行与详情响应同形；详情屏与列表行共用下面两个拼接）。 */
interface PositionIdentity {
  market: BrokerPositionRowResponseMarket;
  code: string;
  name: string;
  option: { expiry: string; right: BrokerPositionOptionResponseRight; strike: string } | null;
}

/** 名称：正股 = 名称；期权 = 正股名 + Call / Put · 购 / 沽（FR-007）。O(1)。 */
export function positionDisplayName(position: PositionIdentity): string {
  if (position.option === null) return position.name;
  return optionDisplayName({
    market: position.market,
    underlyingName: position.name,
    right: position.option.right,
  });
}

/** 代码行：正股 = 去前缀代码；期权 = 到期日 6 位 + 行权价去尾零（FR-007）。O(n)。 */
export function positionCodeLine(position: PositionIdentity): string {
  if (position.option === null) return displayCode(position.code);
  return `${expiryYymmdd(position.option.expiry)} ${trimStrike(position.option.strike)}`;
}

// ── T018：订单枚举文案（plan D11，Guardrail 16） ────────────────────────────────

/**
 * 券商订单状态值域。生成类型是 `string`，这里用字面量 union 让文案 `Record` 穷举（漏值编译红）。
 * EVIDENCE: 订单状态恰为这 17 值 —— futu OpenAPI Python SDK 公开源码 `futu/common/constant.py`
 * `class OrderStatus`（本机 futu-shim venv 内核，2026-09-15）
 */
export type BrokerOrderStatus =
  | 'N/A'
  | 'UNSUBMITTED'
  | 'WAITING_SUBMIT'
  | 'SUBMITTING'
  | 'SUBMIT_FAILED'
  | 'TIMEOUT'
  | 'SUBMITTED'
  | 'FILLED_PART'
  | 'FILLED_ALL'
  | 'CANCELLING_PART'
  | 'CANCELLING_ALL'
  | 'CANCELLED_PART'
  | 'CANCELLED_ALL'
  | 'FAILED'
  | 'DISABLED'
  | 'DELETED'
  | 'FILL_CANCELLED';

/**
 * 券商交易方向值域。
 * EVIDENCE: 交易方向恰为这 5 值 —— 同上 SDK 源码 `class TrdSide`
 */
export type BrokerTradeSide = 'N/A' | 'BUY' | 'SELL' | 'SELL_SHORT' | 'BUY_BACK';

/** 按枚举值查文案；值域外 ⇒ 原样返回（只认自有键，`toString` 之类原型链键名同样原样）。O(1)。 */
function labelOf<K extends string>(labels: Readonly<Record<K, string>>, value: string): string {
  return Object.prototype.hasOwnProperty.call(labels, value) ? labels[value as K] : value;
}

/** 订单状态文案；值域外（SDK 日后新增）⇒ 原样返回枚举名，🚫 编文案。O(1)。 */
export function orderStatusText(status: string): string {
  return labelOf(COPY.orderStatusLabel, status);
}

/** 交易方向文案；值域外 ⇒ 原样返回枚举名。O(1)。 */
export function tradeSideText(side: string): string {
  return labelOf(COPY.tradeSideLabel, side);
}

/** 订单数量单位按品种：期权或组合单 ⇒ `option`（张），否则 `stock`（股）；响应无 `kind` 字段。O(1)。 */
export function orderKind(order: {
  option: object | null;
  comboLegCodes: readonly string[];
}): BrokerPositionRowResponseKind {
  return order.option !== null || order.comboLegCodes.length > 0 ? 'option' : 'stock';
}

/**
 * 批次「剩余 / 原始」数量去掉负号（空头批次带符号为负；方向已由汇总的持仓数量体现，mockup 帧 4）。
 * 纯字符串处理，🚫 转 Number。O(1)。
 */
export function unsignedQty(qty: string): string {
  return qty.startsWith('-') ? qty.slice(1) : qty;
}
