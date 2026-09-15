import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { parseAnchorTicker } from './anchor.rules';
import { parseBrokerCode, type BrokerMarket } from './broker-code.rules';
import {
  buildPositionGroups,
  type DisplayedPositionRow,
  type PositionDisplayRow,
  type PositionGroup,
} from './broker-position-display.rules';
import { resolveInstrumentNames } from './instrument-name';
import { resolveAnchorSpot } from './intraday-spot.rules';

/**
 * 083 US1 —— 交易账户页**持仓列表**读端 (FR-001 / FR-002 / FR-003 / FR-005 / FR-007 / FR-011 /
 * FR-012 / FR-021; plan D1–D8)。
 *
 * 🚨 **只读** (Guardrail 1): 零写路径、零事务。
 *
 * 🚨 **账号隔离在查询条件里** (Guardrail 2): 本文件每一条 `broker_*` 查询的 `where` 都带
 * `accountId` —— 🚫 查全表后在代码里比账号。锚表是全局事实 (无 `account_id`), 不参与隔离。
 *
 * 展示过滤 / 分组 / 排序 / 到期判定全部在 `broker-position-display.rules.ts` (🚫 复用
 * `inBrokerScope`, plan D3); 本文件只负责取数与行组装。行组装 ({@link toBrokerPositionRow} /
 * {@link resolveUnderlyingNames}) 导出给持仓详情读端复用 —— 详情汇总与列表行必须逐字段同口径。
 */

export type BrokerPositionKind = 'stock' | 'option';

/** 连接行里行组装要用的两列。 */
export interface BrokerConnectionLabel {
  brokerCode: string;
  /** 人读标签 —— 🚫 用 `brokerCode` 代替 (同券商两个连接会完全相同, plan D2)。 */
  label: string;
}

/** 列表 / 详情共用的持仓行 (展示判定所需字段 + 透传字段)。 */
export interface BrokerPositionRow extends PositionDisplayRow {
  brokerCode: string;
  kind: BrokerPositionKind;
  /** 正股名 (期权行同样是**正股**名, 由 mobile 拼 Call / Put、购 / 沽)。 */
  name: string;
  option: { expiry: string; right: 'C' | 'P'; strike: Prisma.Decimal } | null;
  qty: Prisma.Decimal;
  averageCost: Prisma.Decimal | null;
  unrealizedPlRatio: Prisma.Decimal | null;
  currency: string | null;
  openedAt: Date;
  openedAtSource: string;
}

export interface BrokerPositionGroupView extends PositionGroup<BrokerPositionRow> {
  underlyingName: string;
}

export interface BrokerPositionList {
  hasConnection: boolean;
  /** 该账号的连接数 (> 1 才显示连接标签, 由 mobile 判)。 */
  brokerCount: number;
  syncedAt: Date | null;
  /** 交易所当地时间串 `YYYY-MM-DD HH:mm:ss`。 */
  syncedAtLocal: string | null;
  stale: boolean;
  unresolvedCount: number;
  groups: BrokerPositionGroupView[];
}

export type BrokerPositionRecord = Prisma.BrokerPositionGetPayload<object>;

/** futu SDK 缺值哨兵 (同 `futu-broker-account.adapter.ts` 的 `VENDOR_NA`)。 */
const VENDOR_NA = 'N/A';

function rawRecord(raw: Prisma.JsonValue): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** vendor 数值字段 → Decimal; 缺失 / 空串 / `N/A` / 不可解析 ⇒ `null` (不猜成 0)。O(1)。 */
function rawDecimal(value: unknown): Prisma.Decimal | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Prisma.Decimal(value) : null;
  }
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '' || s === VENDOR_NA) return null;
  try {
    const d = new Prisma.Decimal(s);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

function rawText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s === '' || s === VENDOR_NA ? null : s;
}

/**
 * 持仓库行 + 连接 → 列表行。`name` 由调用方先经 {@link resolveUnderlyingNames} 取好。O(1)。
 *
 * 期权字段只从券商代码字面解析 (`parseBrokerCode`); 解析不出期权 ⇒ 按正股行 (`option = null`)。
 */
export function toBrokerPositionRow(
  position: BrokerPositionRecord,
  connection: BrokerConnectionLabel,
  name: string,
): BrokerPositionRow {
  const parsed = parseBrokerCode(position.code);
  const option =
    parsed?.kind === 'option'
      ? { expiry: parsed.expiry, right: parsed.right, strike: parsed.strike }
      : null;
  const raw = rawRecord(position.raw);
  return {
    id: position.id,
    market: position.market as BrokerMarket,
    code: position.code,
    underlyingTicker: position.underlyingTicker,
    brokerCode: connection.brokerCode,
    connectionLabel: connection.label,
    kind: option === null ? 'stock' : 'option',
    name,
    option,
    qty: position.qty,
    marketValue: position.marketValue,
    currentPrice: position.currentPrice,
    averageCost: position.averageCost,
    // 持仓盈亏取**平均成本口径**的两个字段 (plan D6)。
    // EVIDENCE: `unrealized_pl` / `pl_ratio_avg_cost` 逐行符合「现价 − 平均成本」口径, `pl_val` /
    // `pl_ratio` 是摊薄口径 —— 维护者 2026-09-13 采集的 082 POC-1 私有原始输出
    // (`docs/private/evidence/broker-account-poc/`), 结论见 083 plan「plan 前验证」V0a。
    unrealizedPl: rawDecimal(raw.unrealized_pl),
    unrealizedPlRatio: rawDecimal(raw.pl_ratio_avg_cost),
    currency: position.currency,
    openedAt: position.openedAt,
    openedAtSource: position.openedAtSource,
  };
}

/**
 * 正股 ticker → 展示名: `marketdata.instrument.name` → 该正股**正股行**的 `raw.stock_name` →
 * ticker 的代码段。🚫 取期权行的 `raw.stock_name` (那是合约名, 不是正股名)。
 *
 * 复杂度: 一次 `findMany` 往返 + O(n) 扫描, n = 持仓行数。
 */
export async function resolveUnderlyingNames(
  prisma: PrismaService,
  positions: readonly BrokerPositionRecord[],
): Promise<Map<string, string>> {
  const tickers = new Set<string>();
  const rawNames = new Map<string, string>();
  for (const p of positions) {
    const ticker = p.underlyingTicker;
    if (ticker === null) continue;
    tickers.add(ticker);
    if (rawNames.has(ticker) || parseBrokerCode(p.code)?.kind === 'option') continue;
    const stockName = rawText(rawRecord(p.raw).stock_name);
    if (stockName !== null) rawNames.set(ticker, stockName);
  }
  const instrumentNames = await resolveInstrumentNames(prisma, [...tickers]);
  const names = new Map<string, string>();
  for (const ticker of tickers) {
    names.set(
      ticker,
      instrumentNames.get(ticker) ??
        rawNames.get(ticker) ??
        parseAnchorTicker(ticker)?.code ??
        ticker,
    );
  }
  return names;
}

@Injectable()
export class ListBrokerPositionsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 复杂度: 固定 4 次查询 (连接 / 锚 / 持仓 / 名称) + 展示规则 O(n log n), n = 该账号该市场持仓行数。
   */
  async execute(
    accountId: bigint,
    market: BrokerMarket,
    now: Date = new Date(),
  ): Promise<BrokerPositionList> {
    const connections = await this.prisma.brokerConnection.findMany({
      where: { accountId },
      select: { id: true, brokerCode: true, label: true },
    });
    const empty: BrokerPositionList = {
      hasConnection: connections.length > 0,
      brokerCount: connections.length,
      syncedAt: null,
      syncedAtLocal: null,
      stale: false,
      unresolvedCount: 0,
      groups: [],
    };
    if (connections.length === 0) return empty;

    // 锚集 = 锚表全部行 (含 excluded; 锚全局, plan D2), 每请求读一次。
    const anchors = await this.prisma.anchor.findMany({
      select: {
        ticker: true,
        intradayPrice: true,
        intradayAt: true,
        lastClose: true,
        lastCloseDate: true,
      },
    });
    const anchoredTickers = new Set(anchors.map((a) => a.ticker));
    const anchorSpots = new Map(anchors.map((a) => [a.ticker, resolveAnchorSpot(a, now).price]));

    const positions = await this.prisma.brokerPosition.findMany({ where: { accountId, market } });
    const names = await resolveUnderlyingNames(
      this.prisma,
      positions.filter(
        (p) => p.underlyingTicker !== null && anchoredTickers.has(p.underlyingTicker),
      ),
    );
    const connectionById = new Map(connections.map((c) => [c.id, c]));
    // 🚨 取不到连接 (连接行被人工删除而持仓未清; 本仓无删连接的代码路径) ⇒ 行照常展示、标签为空。
    // 🚫 在这里按连接再过滤一次: 那等于「在代码里比账号」, 会遮住查询条件上的账号隔离 ——
    // 去掉持仓查询的 `accountId` 后测试仍全绿 (083 T005 定向变异 a 实撞)。
    const orphan: BrokerConnectionLabel = { brokerCode: '', label: '' };
    const rows = positions.map((p) =>
      toBrokerPositionRow(
        p,
        connectionById.get(p.connectionId) ?? orphan,
        p.underlyingTicker === null ? p.code : (names.get(p.underlyingTicker) ?? p.code),
      ),
    );

    const { unresolvedCount, groups } = buildPositionGroups({
      rows,
      anchoredTickers,
      anchorSpots,
      now,
    });
    return {
      ...empty,
      unresolvedCount,
      groups: groups.map((g) => ({
        ...g,
        underlyingName: names.get(g.underlyingTicker) ?? g.underlyingTicker,
      })),
    };
  }
}

export type BrokerPositionListRow = DisplayedPositionRow<BrokerPositionRow>;
