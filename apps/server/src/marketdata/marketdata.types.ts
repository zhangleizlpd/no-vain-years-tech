/**
 * marketdata 共享端口 DTO + 值类型 (015, ADR-0047 可插拔访问层)。
 *
 * 设计要点:
 *  - canonical symbol = `${market}:${code}` (如 `cn:600519`); adapter 内部经
 *    `*-symbol.rules.ts` 双向归一化 vendor symbol (PR2/PR3)。
 *  - 金融数值在端口层即以 **string** 承载 (FR-S08: 禁 Float, 跨边界 string),
 *    Mock/adapter 产出 string, UC/DTO 透传; PG Decimal 在 UC 层 `.toString()`。
 *  - 缺失维度一律 `null` (detail field coverage: 字段缺失不报错)。
 */

/** 复权口径 (FR-S06)。缺省 `none` (D7: 不复权原始价)。 */
export type Adjust = 'none' | 'forward' | 'backward';

export const ADJUSTS: readonly Adjust[] = ['none', 'forward', 'backward'] as const;

/** K线聚合周期 (FR-S06)。`day` 直返日线, 更粗周期服务端聚合。 */
export type BarPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year';

export const BAR_PERIODS: readonly BarPeriod[] = [
  'day',
  'week',
  'month',
  'quarter',
  'year',
] as const;

/** 报价新鲜度口径 (FR-S07)。V1 仅 `eod_close`; 实时源接入翻 `realtime` 零消费者改。 */
export type PriceKind = 'eod_close' | 'realtime';

/**
 * {@link PriceKind} 的运行时值域 (体例同 {@link ADJUSTS} / {@link BAR_PERIODS}) ——
 * swagger `enum:` 需要一个真数组。类型标注绑住它, 与 wire 值域不会各写各的。
 */
export const PRICE_KINDS: readonly PriceKind[] = ['eod_close', 'realtime'] as const;

// ── 搜索 (INSTRUMENT_SEARCH_PORT) ────────────────────────────────────────────
export interface InstrumentSearchHit {
  /** canonical `market:code` */
  symbol: string;
  name: string;
  type: string;
}

// ── universe 枚举 (INSTRUMENT_UNIVERSE_PORT) ─────────────────────────────────
export interface UniverseEntry {
  market: string;
  code: string;
  name: string;
  /**
   * 转换后状态 — `loadActiveInstruments` 同步过滤的 driver。仅 listingStatus-aware 源
   * (理杏仁) 提供; 缺省 (东财 clist / Mock 等无状态概念源) → sync-universe upsert 默认 'active'。
   */
  status?: 'active' | 'inactive';
  /** vendor 原始上市状态 (理杏仁 listingStatus 原值, 如 normally_listed/special_treatment);
   *  无此概念的源 (东财) → 省略, upsert 存 null。保留原值供审计/前端 ST 徽标/改映射不重 sync。 */
  listingStatus?: string | null;
  /** 上市日 `YYYY-MM-DD` (理杏仁 ipoDate); 东财无 → 省略。 */
  listDate?: string | null;
}

// ── EOD 日线 (EOD_BAR_PORT) ─────────────────────────────────────────────────
export interface EodBarQuery {
  symbol: string;
  adjust: Adjust;
  from?: string; // YYYY-MM-DD (含)
  to?: string; // YYYY-MM-DD (含)
}

export interface EodBarPoint {
  tradeDate: string; // YYYY-MM-DD
  adjust: Adjust;
  open: string;
  high: string;
  low: string;
  close: string;
  /** 官方涨跌幅 (百分数, 如 -2.1500); 已含除权除息调整 (复权不变量)。IPO 首日 / 缺失 → null。 */
  changePct: string | null;
  prevClose: string | null;
  volume: string | null;
  amount: string | null;
  turnoverRate: string | null;
}

// ── per-stock 区间查询 (038 T013 seam#4) ────────────────────────────────────
/**
 * fundamental / fs 历史区间抓取入参 (形态照抄 `EodBarQuery` 的 from/to per-stock 区间)。
 * 理杏仁 startDate 模式**仅限单股** (多股批量必须 date:'latest') → symbol 单只。供 backfill
 * 拉 10yr 历史日频/多期序列, 替代 `date:'latest'` 单快照 (delta 仍用批量 latest)。
 */
export interface FundamentalRangeQuery {
  /** canonical `market:code` (单只)。 */
  symbol: string;
  /** YYYY-MM-DD startDate (必填; 理杏仁 fundamental/fs 区间必填)。 */
  from: string;
  /** YYYY-MM-DD endDate (可选; 省略 = 至最新)。 */
  to?: string;
}

/** fs 财报区间抓取入参 (与 FundamentalRangeQuery 同形, 端口分列以保 per-port DTO 约定)。 */
export interface FinancialsRangeQuery {
  symbol: string;
  from: string;
  to?: string;
}

// ── 估值 + 分位 (FUNDAMENTAL_PORT) ──────────────────────────────────────────
export interface FundamentalSnapshotDto {
  symbol: string;
  date: string;
  peTtm: string | null;
  peStatic: string | null;
  peDynamic: string | null;
  pb: string | null;
  ps: string | null;
  dividendYield: string | null;
  marketCap: string | null;
  circMarketCap: string | null;
  pePctlY3: string | null;
  pePctlY5: string | null;
  pbPctlY3: string | null;
  pbPctlY5: string | null;
}

// ── 财报衍生 (FINANCIALS_PORT) ──────────────────────────────────────────────
export interface FinancialMetricDto {
  symbol: string;
  reportPeriod: string; // YYYYQn
  roe: string | null;
  grossMargin: string | null;
  eps: string | null;
  bps: string | null;
}

// ── 公司行动 (CORPORATE_ACTION_PORT) ────────────────────────────────────────
export interface CorporateActionDto {
  symbol: string;
  exDate: string;
  type: string; // dividend | split | allotment
  payload: unknown;
}

// ── 最新报价 (QUOTE_PORT) ───────────────────────────────────────────────────
export interface QuoteSnapshot {
  /** canonical `market:code` */
  symbol: string;
  /** 标的名称 (Instrument 注册即有, 与 hasData 正交); 未注册/非法 symbol → null。 */
  name: string | null;
  price: string | null;
  change: string | null;
  changePct: string | null;
  asOf: string | null; // 数据日期 YYYY-MM-DD
  priceKind: PriceKind;
  /** 无任何 EOD 数据 → false (显式 no-data, 不崩不伪造, FR-S07)。 */
  hasData: boolean;
}

// ── 039 港股量化高信号 per-stock 区间 DTO (形态照抄 EodBarQuery from/to; 金融数值 string|null) ──

// ── 做空日频 (SHORT_SELLING_PORT, US1) ──────────────────────────────────────
/** 做空日频区间抓取入参 (单只 symbol; 理杏仁 short-selling 单数 stockCode + startDate/endDate)。 */
export interface ShortSellingRangeQuery {
  /** canonical `market:code` (单只)。 */
  symbol: string;
  /** YYYY-MM-DD startDate (必填; 理杏仁区间必填)。 */
  from: string;
  /** YYYY-MM-DD endDate (可选; 省略 = 至最新)。 */
  to?: string;
}

export interface ShortSellingPoint {
  date: string; // YYYY-MM-DD
  shares: string | null; // 做空股数
  amount: string | null; // 做空金额
}

// ── 南向持股日频 (CONNECT_HOLDING_PORT, US1) ────────────────────────────────
/** 南向持股日频区间抓取入参 (与 ShortSellingRangeQuery 同形, per-port 分列保 DTO 约定)。 */
export interface ConnectHoldingRangeQuery {
  symbol: string;
  from: string;
  to?: string;
}

export interface ConnectHoldingPoint {
  date: string; // YYYY-MM-DD
  shareholdings: string | null; // 互联互通南向持股数 (仅 ~600 港股通标的有数据)
}

// ── 公募基金持股 (FUND_HOLDING_PORT, US2) ───────────────────────────────────
/** 公募基金持股报告期区间抓取入参 (单只 symbol; 理杏仁 fund-shareholders 单数 stockCode + startDate/endDate)。 */
export interface FundHoldingRangeQuery {
  symbol: string;
  from: string;
  to?: string;
}

/**
 * 公募基金持股行 (报告期×基金)。自然键 (instrumentId, reportDate, fundCode)。金融数值一律
 * `string|null` (FR-S08 跨边界 string); marketCapRank 例外为 `number|null` —— 对应 Prisma
 * `Int?` 市值排名序数列, 序数整数无 Float 精度风险 (FR-S08 「禁 Float」针对 decimal 金融值)。
 */
export interface FundHoldingDto {
  reportDate: string; // YYYY-MM-DD (vendor `date` = 报告期)
  fundCode: string; // 基金代码 (自然键之一)
  name: string | null; // 基金名
  holdings: string | null; // 持仓份额
  marketCap: string | null; // 持仓市值
  netValueRatio: string | null; // 净值占比
  marketCapRank: number | null; // 市值排名 (序数整数; Prisma Int? 列)
  declarationDate: string | null; // YYYY-MM-DD 公告日 (可空)
  /** 名带 `A` (hk 返 null, 疑理杏仁 A 股字段复用) → 存 null, 不因命名歧义丢弃 (spec 字段命名残留)。 */
  proportionOutstandingSharesA: string | null;
}

// ── 基金公司持股 (FUND_COMPANY_HOLDING_PORT, US2) ────────────────────────────
/** 基金公司持股报告期区间抓取入参 (与 FundHoldingRangeQuery 同形, per-port 分列保 DTO 约定)。 */
export interface FundCompanyHoldingRangeQuery {
  symbol: string;
  from: string;
  to?: string;
}

/** 基金公司持股行 (报告期×基金公司)。自然键 (instrumentId, reportDate, fundCollectionCode)。 */
export interface FundCompanyHoldingDto {
  reportDate: string; // YYYY-MM-DD (vendor `date` = 报告期)
  fundCollectionCode: string; // 基金公司代码 (自然键之一)
  name: string | null; // 基金公司名
  holdings: string | null; // 持仓份额
  marketCap: string | null; // 持仓市值
}

// ── 波动率日频 (VOLATILITY_PORT, 040 US1) ───────────────────────────────────
/**
 * 波动率日频区间抓取入参 (单只 symbol × 单窗口)。理杏仁 `/{market}/company/volatility` 单数
 * stockCode + startDate/endDate + **`volatilityDays` 单数 number** (数组 `[250]` → HTTP 400
 * `"volatilityDays must be a number"`, p3 探查报告实测; param 契约每端点单独确认, 波动率必单数)。
 * 多窗口 = 每窗口一次请求 (executor 对 `VOLATILITY_WINDOWS` 循环)。
 */
export interface VolatilityRangeQuery {
  /** canonical `market:code` (单只)。 */
  symbol: string;
  /** 回看窗口天数 (单数 number; 每窗口独立请求)。 */
  volatilityDays: number;
  /** YYYY-MM-DD startDate (必填; 理杏仁区间必填)。 */
  from: string;
  /** YYYY-MM-DD endDate (可选; 省略 = 至最新)。 */
  to?: string;
}

export interface VolatilityPoint {
  date: string; // YYYY-MM-DD
  value: string | null; // 该窗口年化历史波动率 (HV); 金融数值跨边界 string|null (FR-S08)。
}

// ── 热度精选快照 (HOT_SNAPSHOT_PORT, 040 US2) ────────────────────────────────
/**
 * 热度快照抓取入参 (某 hot type × 一组 stockCodes)。理杏仁 `/{market}/company/hot/{type}` 请求体
 * **`stockCodes[]` 数组** (与波动率单数 stockCode 相反! param 契约每端点单独确认, p3 探查报告实测)
 * + **无日期** (快照忽略请求日期永返最新)。executor per-stock 传单只 symbol (DTO 无 symbol 无法批量
 * ⇒ 出处同上: p3 探针 2026-07-14 §3。
 * 映射回标的), 对 `HOT_TYPES` 循环每 type 一次请求。
 */
export interface HotSnapshotQuery {
  /** hot type (ss/tr/capita/rep 精选子集之一; path 段)。 */
  hotType: string;
  /** canonical `market:code` 列表 (数组 param; executor 每次传单只)。 */
  stockCodes: string[];
}

/**
 * 热度快照行 (某标的某 hot type 的当前快照)。自然键 (instrumentId, hotType, dataDate)。**无 symbol
 * 字段** (executor per-stock 调用, 落库时用当前 instrumentId + hotType)。`dataDate` = vendor
 * `last_data_date` (按数据日期累积: 未变幂等覆盖同行、变则落新行)。`payload` 整存 vendor 原始异构字段
 * (每 type 结构不同, 样板 `CorporateActionDto.payload`; adapter 已忽略异常 key `"undefined"`, FR-007)。
 */
export interface HotSnapshotDto {
  hotType: string;
  dataDate: string; // YYYY-MM-DD (vendor `last_data_date`; 自然键之一, 非空)
  payload: Record<string, unknown>; // vendor 原始异构字段 (忽略 `undefined` key), 落 payload Json
}

// ── 所属指数归属 (INDEX_MEMBERSHIP_PORT, US3) ─────────────────────────────────
/**
 * 所属指数归属行 (该股当前所属指数之一)。自然键 (instrumentId, indexCode)。**无 date**: 理杏仁
 * `indices` 端点返当前成分快照 (无历史/无日期) → 覆盖式建模 (无 range query 入参, port 只取 symbol)。
 * `indexCode` = vendor `stockCode` 字段 (该字段实为**指数代码**, 非个股; p2 探查报告实测 00700 归属 14 个指数)。
 */
export interface IndexMembershipDto {
  indexCode: string; // 指数代码 (自然键之一; = vendor `stockCode` 字段, 指数非个股)
  name: string | null; // 指数名 (如「港股全指」「恒生指数」)
  source: string | null; // 指数来源 (vendor `source`, 如 lxri)
  areaCode: string | null; // 区域码 (vendor `areaCode`, 如 hk)
}

// ── 所属行业归属 (INDUSTRY_CLASSIFICATION_PORT, 043 US1) ──────────────────────
/**
 * 所属行业归属行 (该股当前所属行业之一)。自然键 (instrumentId, source, industryCode)。**无 date**:
 * 理杏仁 `industries` 端点返当前所属行业快照 (无历史/无日期) → 覆盖式建模 (无 range query 入参,
 * port 只取 symbol; 照抄 index_membership 第 3 形态)。`industryCode` = vendor `stockCode` 字段
 * (该字段实为**行业代码**, 非个股; probe 实测 00700 → hsi H70/H7020/H702015 3 级层级 3 行)。
 * 文本字段跨边界一律 `string|null` (FR-S08); NK 组件 source/industryCode 缺失由 executor 落
 * sentinel `''` (DB 列 NOT NULL, plan Decision 3), name/areaCode 缺失落 null。
 */
export interface IndustryClassificationDto {
  source: string | null; // 分类体系来源 (vendor `source`, probe 今全 hsi; NK 组件, 缺 → executor sentinel '')
  industryCode: string | null; // 行业代码 (= vendor `stockCode` 字段, 如 H70; NK 组件, 缺 → executor sentinel '')
  name: string | null; // 行业名
  areaCode: string | null; // 区域码 (vendor `areaCode`, 如 hk)
}

// ── 公告 (ANNOUNCEMENT_PORT, 043 US2) ────────────────────────────────────────
/** 公告区间抓取入参 (单只 symbol; 理杏仁 announcement 单数 stockCode + startDate/endDate)。 */
export interface AnnouncementRangeQuery {
  /** canonical `market:code` (单只)。 */
  symbol: string;
  /** YYYY-MM-DD startDate (必填; 理杏仁区间必填)。 */
  from: string;
  /** YYYY-MM-DD endDate (可选; 省略 = 至最新)。 */
  to?: string;
}

/**
 * 公告行 (某标的某公告)。自然键 (instrumentId, date, linkUrl) — probe verified `linkUrl` 是 HKEX 文档
 * 全局唯一 URL (00700 2 年 433/433 unique, `(date,linkUrl)` 433/433 无碰撞) → **无需 vendorEventId/
 * contentHash** (异于 041 buyback 的 `_id`、041 shareholder 的 hash)。**本 feature 唯一潜在超大表**
 * (~3M 行/全港股 10yr) → **只存元数据不存 PDF 正文** (无正文列)。`date` = vendor `date` (probe verified
 * `+08:00` HK-local → `lixDateOnly` slice 正确无 off-by-one, 照抄 buyback, 异于 042 营收 UTC-Z 需
 * `lixDateOnlyHk`)。`linkUrl` NOT NULL (NK 组件, probe 恒有值); `linkText`/`linkType` 文本字段跨边界
 * `string|null` (缺存 null); `types` 是 vendor 分类标签数组 (值域 srp/ndd_r/mr/fs/dividend…) → Postgres
 * `String[]` (text[], 量化 array-overlap 可查), 非数组/缺 → 空数组 `[]`。
 */
export interface AnnouncementDto {
  date: string; // YYYY-MM-DD (vendor `date` = 公告日, +08:00 HK-local, 自然键之一)
  linkUrl: string; // HKEX 文档全局唯一 URL (自然键之一, 非空; VarChar(512) 列)
  linkText: string | null; // 公告标题 (VarChar? 列)
  linkType: string | null; // 文档类型 (如 PDF, VarChar? 列)
  types: string[]; // 分类标签数组 (text[] 列; 缺/非数组 → 空数组)
}

// ── 041 港股事件流 4 维度 per-stock 区间 DTO (形态照抄 ShortSellingRangeQuery; 金融数值 string|null) ──

// ── 回购事件 (BUYBACK_PORT, US1) ────────────────────────────────────────────
/** 回购事件区间抓取入参 (单只 symbol; 理杏仁 repurchase 单数 stockCode + startDate/endDate)。 */
export interface BuybackRangeQuery {
  /** canonical `market:code` (单只)。 */
  symbol: string;
  /** YYYY-MM-DD startDate (必填; 理杏仁区间必填)。 */
  from: string;
  /** YYYY-MM-DD endDate (可选; 省略 = 至最新)。 */
  to?: string;
}

/**
 * 回购事件行 (某标的某回购日某笔回购)。自然键 (instrumentId, date, vendorEventId) — C1 扩键: T018 真调实证
 * 同日多笔真实存在 (汇丰 00005 同日两市场回购: GBP/turquoise + HKD/exchange), 单纯 (instrumentId, date) 会
 * skipDuplicates 丢真行 → 加 vendor `_id` (源头稳定唯一 24 位 hex, 全非空, Kafka 幂等键范式)。金融数值跨边界
 * 一律 `string|null` (FR-S08); num / totalSharesForCancellation / totalSharesForTreasury 对应 Prisma `BigInt?`
 * 股数列 (executor 落库时 `BigInt()` 转换), 价格/金额/比率对应 `Decimal?` 列 (string 直落),
 * methodOfPurchase/currency/boardType 对应 `VarChar?` 文本列。
 */
export interface BuybackDto {
  date: string; // YYYY-MM-DD (vendor `date` = 回购日, 自然键之一)
  vendorEventId: string; // vendor `_id` (源头稳定唯一 id, 自然键之一, 非空; VarChar 列)
  num: string | null; // 回购股数 (BigInt? 列)
  highestPrice: string | null; // 回购最高价 (Decimal 列)
  lowestPrice: string | null; // 回购最低价
  avgPrice: string | null; // 回购均价
  totalPaid: string | null; // 回购总金额 (Decimal 列)
  totalSharesForCancellation: string | null; // 注销股数 (BigInt? 列)
  totalSharesForTreasury: string | null; // 库存股数 (BigInt? 列)
  ratioPurchasedSinceResolution: string | null; // 决议以来累计回购占比 (Decimal 列)
  methodOfPurchase: string | null; // 回购方式 (如 exchange)
  currency: string | null; // 币种 (如 HKD)
  boardType: string | null; // 板块 (如 main)
}

// ── 股本变动事件 (EQUITY_CHANGE_PORT, US2) ──────────────────────────────────
/** 股本变动事件区间抓取入参 (单只 symbol; 理杏仁 equity-change 单数 stockCode + startDate/endDate)。 */
export interface EquityChangeRangeQuery {
  /** canonical `market:code` (单只)。 */
  symbol: string;
  /** YYYY-MM-DD startDate (必填; 理杏仁区间必填)。 */
  from: string;
  /** YYYY-MM-DD endDate (可选; 省略 = 至最新)。 */
  to?: string;
}

/**
 * 股本变动事件行 (某标的某变动日)。自然键 (instrumentId, date)。金融数值跨边界一律 `string|null`
 * (FR-S08); capitalization / capitalizationH 对应 Prisma `Decimal?(24,0)` 列 (string 直落),
 * changeReason 对应 `VarChar` 无界文本列, declarationDate 对应可空 `Date` 列 (executor 落库时
 * `toDateOnly` 转换)。
 */
export interface EquityChangeDto {
  date: string; // YYYY-MM-DD (vendor `date` = 变动日, 自然键之一)
  capitalization: string | null; // 总股本 (Decimal(24,0) 列)
  capitalizationH: string | null; // H 股股本 (Decimal(24,0) 列)
  changeReason: string | null; // 变动原因 (如 定期報告, VarChar 无界列)
  declarationDate: string | null; // 公告日 YYYY-MM-DD (可空 Date 列)
}

// ── 股东权益变动事件 (SHAREHOLDER_CHANGE_PORT, US3) ──────────────────────────
/** 股东权益变动事件区间抓取入参 (单只 symbol; 理杏仁 shareholders-equity-change 单数 stockCode + startDate/endDate)。 */
export interface ShareholderChangeRangeQuery {
  /** canonical `market:code` (单只)。 */
  symbol: string;
  /** YYYY-MM-DD startDate (必填; 理杏仁区间必填)。 */
  from: string;
  /** YYYY-MM-DD endDate (可选; 省略 = 至最新)。 */
  to?: string;
}

/**
 * 股东权益变动事件行 (某标的某变动日某大股东某笔申报)。自然键 (instrumentId, date, shareholderName, contentHash)
 * — C1 扩键: T018 真调实证同股东同日多笔真实存在 (JPMorgan 09988 同日 3 笔, involved 不同; 汇丰同股东同日 2 笔),
 * 三列 (instrumentId, date, shareholderName) 会 skipDuplicates 丢真行 → 加 contentHash (对 vendor 原始事件行做
 * 确定性 canonical 序列化后 sha256 hex, Data Vault hashdiff 范式; 内容全同才折叠、任何实质差异都保留)。
 * **唯一有嵌套结构的维度** (plan Decision 4): vendor 返 `numOfSharesInterestedList[]` / `numOfSharesInvolvedList[]` /
 * `percentageOfIssuedVotingShares[]` (每项 `{value, sharesType}`, sharesType 见 L/S, HK SDI 有第三类 P) → **payload Json
 * 整存 vendor 原始行无损** (样板 `HotSnapshotDto.payload`), **拒绝**扁平 long/short 四列 (假定 L/S 二元会丢第三类)。
 * 缺 L 或 S 值 / 缺字段 → 存 null 不崩 (FR-007)。`shareholderName` = vendor `name` (大股东名, 自然键之一, 非空;
 * 缺 name 无法建自然键 → adapter 跳过该行)。
 */
export interface ShareholderChangeDto {
  date: string; // YYYY-MM-DD (vendor `date` = 变动日, 自然键之一)
  shareholderName: string; // vendor `name` (大股东名, 自然键之一, 非空)
  contentHash: string; // vendor 原始事件行 canonical sha256 hex (自然键之一, 非空; hashdiff 判别同名同日多笔)
  /**
   * vendor 原始行整存 (numOfSharesInterestedList / numOfSharesInvolvedList / percentageOfIssuedVotingShares
   * 及任何 vendor 字段), 落 payload Json。已知描述性数组缺项 → null (不崩); 每项 `{value, sharesType}` 无损
   * 保留 (L/S 及潜在第三类 P)。
   */
  payload: Record<string, unknown>;
}

// ── 配股事件 (ALLOTMENT_PORT, US4) ──────────────────────────────────────────
/** 配股事件区间抓取入参 (单只 symbol; 理杏仁 allotment 单数 stockCode + startDate/endDate)。 */
export interface AllotmentRangeQuery {
  /** canonical `market:code` (单只)。 */
  symbol: string;
  /** YYYY-MM-DD startDate (必填; 理杏仁区间必填)。 */
  from: string;
  /** YYYY-MM-DD endDate (可选; 省略 = 至最新)。 */
  to?: string;
}

/**
 * 配股事件行。自然键 (instrumentId, date)。多数标的 vendor 返 0 行 → adapter 返空数组 (不崩)。
 *
 * 041 建表时按「零样本 / 字段 schema 未知」只存 `payload` (plan Decision 5 预留提列)。该前提
 * 2026-08-01 证伪 (prod 545 行真实样本, 字段固定) → 本 DTO 兑现提列; `payload` 保留无损兜底。
 *
 * 🚨 `date` 是 vendor **公告日** (自然键), `exDate` 才是**除权日** —— 545 行实测 510 行两者不同。
 * 复权因子按除权日定版本边界, 关联时用 `exDate`。金融数值跨边界 string|null (FR-S08)。
 */
export interface AllotmentDto {
  date: string; // YYYY-MM-DD (vendor `date` = 公告日, 自然键之一)
  /** YYYY-MM-DD 除权日; vendor 缺失 → null (35/545 实测)。 */
  exDate: string | null;
  /** 配股比率 q (每股可认购股数)。 */
  allotmentRatio: string | null;
  /** 配股价 P (`currency` 计价)。 */
  allotmentPrice: string | null;
  /** 配股价计价币种。 */
  currency: string | null;
  /** vendor 原始行整存 (提列列之外字段无损保留, 如 allotmentShares), 落 payload Json。 */
  payload: Record<string, unknown>;
}

// ── 042 港股报告期 3 维度 per-stock 区间 DTO (形态照抄 BuybackRangeQuery; 金融数值 string|null) ──

// ── 营收构成 (REVENUE_SEGMENT_PORT, US1) ────────────────────────────────────
/** 营收构成区间抓取入参 (单只 symbol; 理杏仁 operation-revenue-constitution 单数 stockCode + startDate/endDate)。 */
export interface RevenueSegmentRangeQuery {
  /** canonical `market:code` (单只)。 */
  symbol: string;
  /** YYYY-MM-DD startDate (必填; 理杏仁区间必填)。 */
  from: string;
  /** YYYY-MM-DD endDate (可选; 省略 = 至最新)。 */
  to?: string;
}

/**
 * 营收构成行 (某标的某报告期某分部)。自然键 (instrumentId, date, parentItemName, itemName) — probe verified
 * 22 期 0 碰撞 (含 "其他" 跨两组不撞)。vendor `dataList[]` 是「维度头行 + 数据行」混合结构 (plan Decision 3):
 * adapter 展开为 typed 列子行 —— **跳过纯头行** (无 parentItemName + 无 value, 如 "按服務類型分"/"按地區分");
 * **有 parentItemName 的行一律出** (value 可 null, HSBC "按地區分" 下英國/香港等有 parent 缺 revenue = 缺值
 * 数据行、落 null); 顶层有 value 行 (合計) parentItemName 落哨兵 `''` (Decision 6, NK 列 NOT NULL)。
 * parentItemName/itemName 解析时 `.trim()` 归一 (vendor 带尾随空格, 否则 GROUP BY 漏行)。per-报告期 metadata
 * (declarationDate/currency) 反规范化到每行。金融数值跨边界 `string|null` (FR-S08); revenue/costs **signed 可负**
 * (probe 实证 HSBC 企業中心 −1e10) 对应 Prisma `Decimal?(24,2)`, grossProfitMargin 对应 `Decimal?(10,6)`。
 * date/declarationDate 经 `lixDateOnlyHk` HK-aware 归一 (营收为 UTC-Z, 防跨维度 join off-by-one, plan §风险 #6)。
 */
export interface RevenueSegmentDto {
  date: string; // YYYY-MM-DD (vendor `date` = 报告期, HK-aware 归一, 自然键之一)
  declarationDate: string | null; // YYYY-MM-DD 公告日 (可空 Date 列, HK-aware 归一)
  currency: string | null; // 币种 (如 CNY/HKD, VarChar? 列)
  parentItemName: string; // 分部维度名 (如 按服務類型分; 顶层行哨兵 '', 自然键之一, NOT NULL)
  itemName: string; // 分部项名 (如 增值服務/合計, 自然键之一, NOT NULL)
  revenue: string | null; // 分部营收 (Decimal(24,2) 列, signed 可负)
  costs: string | null; // 分部成本 (Decimal(24,2) 列, signed 可负)
  grossProfitMargin: string | null; // 分部毛利率 (Decimal(10,6) 列, signed)
}

// ── 最新股东 (SHAREHOLDER_SNAPSHOT_PORT, US2) ────────────────────────────────
/** 最新股东区间抓取入参 (单只 symbol; 理杏仁 latest-shareholders 单数 stockCode + startDate/endDate)。 */
export interface ShareholderSnapshotRangeQuery {
  /** canonical `market:code` (单只)。 */
  symbol: string;
  /** YYYY-MM-DD startDate (必填; 理杏仁区间必填)。 */
  from: string;
  /** YYYY-MM-DD endDate (可选; 省略 = 至最新)。 */
  to?: string;
}

/**
 * 最新股东行 (某标的某报告期某大股东)。自然键 (instrumentId, date, shareholderName, contentHash) —
 * 复用 041 ShareholderChange 范式 (plan Decision 4): contentHash = vendor 原始行 canonical 序列化后
 * sha256 hex (Data Vault hashdiff), 应对同股东同日多笔 (内容全同才折叠、任何实质差异都保留)。**probe
 * verified SERIES**: latest-shareholders 返多个不同 date 行 (报告期×股东序列, 00700 9 行/5 date),
 * date 进自然键可回填历史。**嵌套结构**: vendor 返 `numOfSharesInterestedList[]` /
 * `percentageOfIssuedVotingShares[]` (每项 `{value, sharesType}`, sharesType 见 L/S, HK SDI 有第三类
 * P, 041 T018 实证) → **payload Json 整存 vendor 原始行无损** (样板 041 `ShareholderChangeDto.payload`),
 * **拒绝**扁平 L/S 列 (假定 L/S 二元会丢第三类)。缺 L/S/P 值 / 缺字段 → 存 null 不崩 (FR-007)。
 * `shareholderName` = vendor `name` (大股东名, 自然键之一, 非空; 缺 name 无法建自然键 → adapter 跳过该行)。
 */
export interface ShareholderSnapshotDto {
  date: string; // YYYY-MM-DD (vendor `date` = 报告期, HK-aware 归一, 自然键之一)
  shareholderName: string; // vendor `name` (大股东名, 自然键之一, 非空)
  contentHash: string; // vendor 原始行 canonical sha256 hex (自然键之一, 非空; hashdiff 判别同名同日多笔)
  /**
   * vendor 原始行整存 (numOfSharesInterestedList / percentageOfIssuedVotingShares 及任何 vendor 字段),
   * 落 payload Json。已知描述性数组缺项 → null (不崩); 每项 `{value, sharesType}` 无损保留 (L/S 及潜在
   * 第三类 P)。
   */
  payload: Record<string, unknown>;
}

// ── 员工 (EMPLOYEE_PORT, US3) ────────────────────────────────────────────────
/** 员工区间抓取入参 (单只 symbol; 理杏仁 employee 单数 stockCode + startDate/endDate)。 */
export interface EmployeeRangeQuery {
  /** canonical `market:code` (单只)。 */
  symbol: string;
  /** YYYY-MM-DD startDate (必填; 理杏仁区间必填)。 */
  from: string;
  /** YYYY-MM-DD endDate (可选; 省略 = 至最新)。 */
  to?: string;
}

/**
 * 员工行 (某标的某报告期某分类项)。自然键 (instrumentId, date, parentItemName, itemName, displayType) —
 * probe 实证 00700+00005 全期 0 碰撞 (加 displayType 后完全去重, 无需 contentHash)。vendor `dataList[]` 是
 * 「维度头行 + 数据行」混合结构 (plan Decision 3): adapter 展开为 typed 列子行 —— **跳过纯头行** (无
 * parentItemName + 无 value); 有 parentItemName 的行一律出 (value 可 null, 缺值容错); 顶层有 value 行
 * (员工总数/总流失率) parentItemName 落哨兵 `''` (Decision 6, NK 列 NOT NULL)。**displayType (number/
 * percentage) 进自然键且原样保留** (Decision 6, probe 实证同名 (parentItemName,itemName) 出 number+
 * percentage 两行, 如「流失率按性别分‖男性」= {58812 number, 15.2 percentage}): 两行都出、不去重。
 * parentItemName/itemName/displayType 解析时 `.trim()` 归一 (vendor 带尾随空格, 否则 NK 漏行/跨期不一致)。
 * value 金融数值跨边界 `string|null` (FR-S08) 对应 Prisma `Decimal?(20,4)` (兼容 headcount 与 percentage)。
 * date/declarationDate 经 `lixDateOnlyHk` HK-aware 归一 (员工为 +08:00, 保跨维度对齐一致, plan §风险 #6)。
 */
export interface EmployeeDto {
  date: string; // YYYY-MM-DD (vendor `date` = 报告期, HK-aware 归一, 自然键之一)
  declarationDate: string | null; // YYYY-MM-DD 公告日 (可空 Date 列, HK-aware 归一)
  parentItemName: string; // 分类维度名 (如 按年龄分; 顶层行哨兵 '', 自然键之一, NOT NULL)
  itemName: string; // 分类项名 (如 30歲以下/员工总数, 自然键之一, NOT NULL)
  displayType: string; // 值语义 (number/percentage, 自然键之一, NOT NULL; 原样保留不去重)
  value: string | null; // 员工数/占比 (Decimal(20,4) 列, headcount 或 percentage)
}
