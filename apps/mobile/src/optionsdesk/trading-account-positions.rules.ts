// 083 T013 — 交易账户页 · 持仓分段的视图判定与行展示规则单点（plan §D14）。vitest 覆盖。
//
// 🚨 对 `@nvy/api-client` 只 `import type`（mobile vitest 解析不到其运行时入口）；枚举值用
//    字符串字面量 + 生成类型约束，🚫 import 生成的枚举常量对象。
// 🚨 时间：服务端已给交易所当地时间串 `YYYY-MM-DD HH:mm:ss`（`…Local` 字段），这里**只做字符串
//    重排** + 按 `market` 拼时区标签；🚫 任何时区换算（plan §D13，Guardrail 8）。
// 📌 文案全部取 `OPTIONSDESK_COPY.tradingAccountPositions`（独立段，🚫 081 `tradingAccount` 段）。
import type {
  BrokerPositionGroupResponse,
  BrokerPositionListResponse,
  BrokerPositionOptionResponseRight,
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
