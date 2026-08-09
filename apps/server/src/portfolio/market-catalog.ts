/**
 * 011 证券市场静态字典 (FR-S06 真相源)。
 *
 * 9 个市场分两组: 核心 3 (A 股 / 港股 / 美股, 可开关) + 海外 6 (恒置灰 v1Available=false)。
 * 市场码 = 小写市场标识 (cn/hk/us/...), 与 015 `Instrument.market` 同一词表
 * (canonical symbol `cn:600519`), 全仓不做币种↔市场码映射; isoCurrency (CNY/HKD/USD)
 * 独立保留供 UI 显示 / 未来 FX。分组 / 顺序 / 市场→币种映射的单一真相源,
 * 客户端无需硬编码字典 (FR-S01)。V1 硬编码, 变动需发版。
 *
 * 名称 / 顺序对齐 mockup baseline (design/, commit 3ece552)。
 */
export type MarketGroup = 'core' | 'overseas';

export interface MarketCatalogEntry {
  /** 市场码 (cn/hk/us/..., 与 015 Instrument.market 同词表), 持久化于 portfolio_preference.active_markets (核心) */
  marketCode: string;
  /** 中文显示名 (mockup 定稿) */
  displayName: string;
  /** ISO 4217 货币码 (UI 显示用; 与 marketCode 解耦, 如 cn↔CNY) */
  isoCurrency: string;
  group: MarketGroup;
  /** V1 是否可激活: 核心 true / 海外恒 false */
  v1Available: boolean;
  /** 固定渲染顺序 (1-based, 核心在前) */
  order: number;
}

export const MARKET_CATALOG: readonly MarketCatalogEntry[] = [
  // 核心 3 (可开关)
  {
    marketCode: 'cn',
    displayName: 'A 股',
    isoCurrency: 'CNY',
    group: 'core',
    v1Available: true,
    order: 1,
  },
  {
    marketCode: 'hk',
    displayName: '港股',
    isoCurrency: 'HKD',
    group: 'core',
    v1Available: true,
    order: 2,
  },
  {
    marketCode: 'us',
    displayName: '美股',
    isoCurrency: 'USD',
    group: 'core',
    v1Available: true,
    order: 3,
  },
  // 海外 6 (V1 恒置灰不可激活)
  {
    marketCode: 'jp',
    displayName: '日股',
    isoCurrency: 'JPY',
    group: 'overseas',
    v1Available: false,
    order: 4,
  },
  {
    marketCode: 'sg',
    displayName: '新加坡',
    isoCurrency: 'SGD',
    group: 'overseas',
    v1Available: false,
    order: 5,
  },
  {
    marketCode: 'my',
    displayName: '马来西亚',
    isoCurrency: 'MYR',
    group: 'overseas',
    v1Available: false,
    order: 6,
  },
  {
    marketCode: 'ca',
    displayName: '加拿大',
    isoCurrency: 'CAD',
    group: 'overseas',
    v1Available: false,
    order: 7,
  },
  {
    marketCode: 'au',
    displayName: '澳大利亚',
    isoCurrency: 'AUD',
    group: 'overseas',
    v1Available: false,
    order: 8,
  },
  {
    marketCode: 'kr',
    displayName: '韩股',
    isoCurrency: 'KRW',
    group: 'overseas',
    v1Available: false,
    order: 9,
  },
];

export const CORE_MARKETS: readonly MarketCatalogEntry[] = MARKET_CATALOG.filter(
  (m) => m.group === 'core',
);
export const OVERSEAS_MARKETS: readonly MarketCatalogEntry[] = MARKET_CATALOG.filter(
  (m) => m.group === 'overseas',
);

/**
 * 新账号 (无持久化行) 的核心市场默认激活态 (FR-S01): A 股 ON, 港股 / 美股 OFF。
 * 读侧投影默认 + 首次 PUT materialize 落库的初值 (plan D4) 单一真相源。
 */
export const DEFAULT_CORE_ACTIVE: Readonly<Record<string, boolean>> = {
  cn: true,
  hk: false,
  us: false,
};

/**
 * 新账号默认**激活的**核心市场码集合（= DEFAULT_CORE_ACTIVE 里 true 的码）。
 * ADR-0046 单行模型：首次 PUT upsert 落此默认行；读侧无行时投影亦用它。当前 = ['cn']。
 */
export const DEFAULT_ACTIVE_MARKETS: readonly string[] = CORE_MARKETS.filter(
  (m) => DEFAULT_CORE_ACTIVE[m.marketCode],
).map((m) => m.marketCode);

const CORE_CODES = new Set(CORE_MARKETS.map((m) => m.marketCode));
const KNOWN_CODES = new Set(MARKET_CATALOG.map((m) => m.marketCode));

/** 是否核心市场码 (可开关)。 */
export function isCoreMarket(code: string): boolean {
  return CORE_CODES.has(code);
}

/** 是否字典已知市场码 (核心 ∪ 海外 9 个)。 */
export function isKnownMarket(code: string): boolean {
  return KNOWN_CODES.has(code);
}
