import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  exchangeCalendarDate,
  exchangeClock,
  exchangeLocalDateTime,
} from '../marketdata/session-clock';
import {
  TRADING_CALENDAR_PORT,
  type TradingCalendarPort,
} from '../marketdata/trading-calendar.port';
import { PrismaService } from '../security/prisma.service';
import { parseAnchorTicker } from './anchor.rules';
import { parseBrokerCode, type BrokerMarket } from './broker-code.rules';
import { isStale, resolveJudgementSlot } from './broker-freshness.rules';
import {
  buildPositionGroups,
  type DisplayedPositionRow,
  type PositionDisplayRow,
  type PositionGroup,
} from './broker-position-display.rules';
import {
  convertRows,
  defaultCurrencyForMarket,
  finalizeConvertedGroups,
  resolveDisplayRate,
  type ConvertedRow,
  type FinalizedGroup,
} from './display-currency.rules';
import { FX_RATE_PORT, type FxCurrency, type FxRate, type FxRatePort } from './fx-rate.port';
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

/** 列表行 = 持仓行 + 折算元信息。**详情读端的行不带后者** (折算只发生在列表, FR-010)。 */
export type ConvertedBrokerPositionRow = ConvertedRow<BrokerPositionRow>;

export type BrokerPositionGroupView = FinalizedGroup<PositionGroup<ConvertedBrokerPositionRow>> & {
  underlyingName: string;
};

/** 本屏实际消费的那一条参考汇率 (FR-007)。展示币种 = 该市场原币种 ⇒ 整个对象为 `null`。 */
export interface DisplayFxRateView {
  /** 折算的源币种 = 该市场原币种。 */
  from: FxCurrency;
  /** 折算的目标币种 = 本屏展示币种。 */
  to: FxCurrency;
  /** 取不到 ⇒ `null` (此时 {@link available} 为 false, 整屏走原币种)。 */
  rate: Prisma.Decimal | null;
  /** **我们采到它的时刻** (ingestion time; 🚫 vendor 自报时间戳, plan D5)。 */
  capturedAt: Date | null;
  available: boolean;
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
  /** 本屏展示币种; 请求未指定 ⇒ 该市场原币种。 */
  displayCurrency: FxCurrency;
  /** 参考汇率; **无需折算 ⇒ `null`** (mobile 据此决定出不出参考汇率行, FR-007 / FR-011)。 */
  fxRate: DisplayFxRateView | null;
  groups: BrokerPositionGroupView[];
}

export type BrokerPositionRecord = Prisma.BrokerPositionGetPayload<object>;

/** futu SDK 缺值哨兵 (同 `futu-broker-account.adapter.ts` 的 `VENDOR_NA`)。 */
const VENDOR_NA = 'N/A';

export function rawRecord(raw: Prisma.JsonValue): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** vendor 数值字段 → Decimal; 缺失 / 空串 / `N/A` / 不可解析 ⇒ `null` (不猜成 0)。O(1)。 */
export function rawDecimal(value: unknown): Prisma.Decimal | null {
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
  positions: readonly Pick<BrokerPositionRecord, 'underlyingTicker' | 'code' | 'raw'>[],
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
  private readonly logger = new Logger(ListBrokerPositionsUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    // CROSS-CONTEXT-SYNC: optionsdesk → marketdata 交易日历读端口 —— 陈旧判定要「今天」的三态与
    // 上一交易日 (plan D7); 自己直查 trading_day 会绕过覆盖声明那一维, 漂了只让陈旧悄悄错一天。零写。
    @Inject(TRADING_CALENDAR_PORT) private readonly calendar: TradingCalendarPort,
    // 085 T006 FX 取数口 —— 住本 ctx (不经 marketdata, ADR-0062 四条 trigger 一条未命中), 故不是
    // 跨 ctx 注入。展示币种 = 该市场原币种时**一次都不调用**它 (见 `loadDisplayRates`)。
    @Inject(FX_RATE_PORT) private readonly fxRates: FxRatePort,
  ) {}

  /**
   * @param displayCurrency 展示币种; `null` ⇒ 该市场原币种 (FR-011 的缺省档)。
   *
   * 🚨 **它不进任何 `where`** (Guardrail 4): 只影响呈现。让它参与取数就等于给同一份持仓开了
   * 第二条数据路径, 而账号隔离只守在第一条上。
   *
   * 复杂度: 至多 7 次查询 (连接 / 同步记录 / 日历 ≤ 2 / 锚 / 持仓 / 名称) + 至多 1 次 FX 取数
   * (缺省档为 0) + 展示规则 O(n log n), n = 该账号该市场持仓行数。
   */
  async execute(
    accountId: bigint,
    market: BrokerMarket,
    displayCurrency: FxCurrency | null = null,
    now: Date = new Date(),
  ): Promise<BrokerPositionList> {
    const target = displayCurrency ?? defaultCurrencyForMarket(market);
    const connections = await this.prisma.brokerConnection.findMany({
      where: { accountId },
      select: { id: true, brokerCode: true, label: true },
    });
    if (connections.length === 0) {
      return {
        hasConnection: false,
        brokerCount: 0,
        syncedAt: null,
        syncedAtLocal: null,
        stale: false,
        unresolvedCount: 0,
        displayCurrency: target,
        // 无连接 = 整屏一个金额都没有 ⇒ 不取汇率, 也没有「参考汇率」可标。
        fxRate: null,
        groups: [],
      };
    }

    // 🚨 同步失败不清空 (branch 5): 只取成功记录; 持仓照常读, 与最近一次是否失败无关。
    const syncedAt = await this.lastSucceededSyncAt(accountId, market);
    const { rates, fxRate } = await this.loadDisplayRates(market, target);
    const empty: BrokerPositionList = {
      hasConnection: true,
      brokerCount: connections.length,
      syncedAt,
      syncedAtLocal: syncedAt === null ? null : exchangeLocalDateTime(market, syncedAt),
      // 从未成功 ⇒ mobile 显示「尚未同步」, 陈旧无意义 ⇒ 不判、不调日历。
      stale: syncedAt === null ? false : await this.resolveStale(market, syncedAt, now),
      unresolvedCount: 0,
      displayCurrency: target,
      fxRate,
      groups: [],
    };

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

    // 🚨 **折算在分组聚合之前** (plan D2): 反过来会把降级行的原币种值混进 `signedSum`, 乘上
    // 汇率后得到一个「看起来合理」的错数 —— 组市值照样算得出来, 屏幕上一切正常。
    const converted = convertRows(rows, { target, rates });
    const { unresolvedCount, groups } = buildPositionGroups({
      rows: converted,
      anchoredTickers,
      anchorSpots,
      now,
    });
    return {
      ...empty,
      unresolvedCount,
      // 分组**之后**收口: 含降级行的组把两个聚合值都置 null 并沉底。混合组的聚合值是非 null 的
      // 部分和, `compareGroups` 的 null 排末分支盖不住它 (`display-currency.rules.ts` 同名函数)。
      groups: finalizeConvertedGroups(groups).map((g) => ({
        ...g,
        underlyingName: names.get(g.underlyingTicker) ?? g.underlyingTicker,
      })),
    };
  }

  /**
   * 该账号该市场最近一次**成功**同步的 `finishedAt` (plan D7): 「对账 ∧ `market=m`」或
   * 「补齐 ∧ (`target='*'` ∨ `target` 以 `m:` 开头)」。
   *
   * 🚨 🚫 只按 `market` 列筛: 补齐记录不写 `market` (执行时从 `target` 推市场, plan V5) ——
   * 只有补齐、还没有对账的市场会被误判「尚未同步」。单次索引查询 O(1) 往返。
   */
  private async lastSucceededSyncAt(accountId: bigint, market: BrokerMarket): Promise<Date | null> {
    const run = await this.prisma.brokerSyncRun.findFirst({
      where: {
        accountId,
        status: 'succeeded',
        finishedAt: { not: null },
        OR: [
          { kind: 'reconcile', market },
          { kind: 'backfill', OR: [{ target: '*' }, { target: { startsWith: `${market}:` } }] },
          // 084 FR-012: 推送刷新 (`push`) 与缺口补偿 (`gapfill`) 都按市场记录 ⇒ 与对账同形按
          // `market` 取。🚨 只认对账与补齐会让推送刚刷新完的持仓仍显示为旧时刻, 并因此被误标陈旧。
          // `gapfill` 记录由 084 T010 才开始产生, 这里**一次写全**, 免得 T010 再回来改读端。
          { kind: { in: ['push', 'gapfill'] }, market },
        ],
      },
      orderBy: { finishedAt: 'desc' },
      select: { finishedAt: true },
    });
    return run?.finishedAt ?? null;
  }

  /**
   * 陈旧判定 (plan D7): 判定时点 = 最近一个已过宽限的对账时点。上一交易日**只在需要时**取;
   * 端口返回 `null` ⇒ 不可判定 ⇒ 不标陈旧 + warn (🚫 回落日历日: 端口契约「null = 不可判定,
   * 调用方 MUST NOT 猜」)。日志不含账号。≤ 2 次端口调用。
   */
  private async resolveStale(market: BrokerMarket, syncedAt: Date, now: Date): Promise<boolean> {
    const nowLocal = exchangeClock(market, now);
    const todayStatus = await this.calendar.classify(market, exchangeCalendarDate(market, now));
    const slot = resolveJudgementSlot({ market, nowLocal, todayStatus });
    const judgementDate =
      slot === 'today'
        ? nowLocal.date
        : await this.calendar.previousTradingDay(market, nowLocal.date);
    const { stale, undeterminable } = isStale({
      market,
      judgementDate,
      lastSyncLocal: exchangeClock(market, syncedAt),
    });
    if (undeterminable) {
      this.logger.warn(
        `交易日历无法判定 ${market} 在 ${nowLocal.date} 之前的上一交易日, 本次不标陈旧 (083 FR-009)`,
      );
    }
    return stale;
  }

  /**
   * 取本屏所需的参考汇率 (plan D5)。
   *
   * 🚨 **仅在展示币种 ≠ 该市场原币种时才打 FX port** —— 缺省视图 (老客户端与每次首屏) 因此
   * 一次 vendor 往返都不发生, 且走的是与上线前逐字相同的代码路径 (SC-006)。代价: 缺省档下
   * 原币种与该市场不符的行 (券商未回报 / 回报了第三种币种) 走降级, 而不是被折算 —— 单市场页签下
   * 同屏各行必然同币种 (spec Assumptions), 这类行本就是异常数据, 降级标注比静默折算更可读。
   *
   * 🚨 **全源失败 ⇒ catch 成降级态**, 🚫 让端点 500: 汇率只是呈现口径, 取不到时正确的行为是整屏
   * 退回原币种并标注 (FR-006 / branch 8); 500 会让一屏本来读得到的持仓整个消失。日志不含账号。
   *
   * 至多 1 次 port 调用。
   */
  private async loadDisplayRates(
    market: BrokerMarket,
    target: FxCurrency,
  ): Promise<{ rates: readonly FxRate[]; fxRate: DisplayFxRateView | null }> {
    const from = defaultCurrencyForMarket(market);
    if (from === target) return { rates: [], fxRate: null };

    let rates: readonly FxRate[] = [];
    try {
      rates = await this.fxRates.fetchRates();
    } catch (err) {
      this.logger.warn(
        `${market} 展示币种 ${target} 汇率取数失败, 本屏降级为原币种 (085 FR-006): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    // 这里的 `null` **只可能**是「汇率不可用」—— `resolveDisplayRate` 的另一条返 null 的分支
    // (`from === target`, 意为「不需要折算」) 已被上面那行拦掉。两个含义混成一个 falsy 分支,
    // 就会在不需要折算时也报「汇率不可用」。
    const applied = resolveDisplayRate(rates, from, target);
    return {
      rates,
      fxRate:
        applied === null
          ? { from, to: target, rate: null, capturedAt: null, available: false }
          : {
              from,
              to: target,
              rate: applied.rate,
              capturedAt: applied.capturedAt,
              available: true,
            },
    };
  }
}

export type BrokerPositionListRow = DisplayedPositionRow<BrokerPositionRow>;

/** 列表**组内**的行: 详情行的全部字段 + 折算元信息 (`degraded` / `original*` 等)。 */
export type BrokerPositionListGroupRow = DisplayedPositionRow<ConvertedBrokerPositionRow>;
