// 012 券商静态字典 —— **client 副本** (D5)。server 校验副本在
// apps/server/src/portfolio/broker-catalog.ts(仅 code+name);此份多带 client-only 的
// `pinyinInitials`（简拼:搜索 + A-Z 首字母分组)+ `logoAsset`(品牌 logo,V1 占位)。
// 两份 code 集合在 release 人工对齐。V1 硬编码 12 家,变动需发版。
// code / 名称 / 简拼对齐 mockup baseline(design/handoff-claude-design BrokerFlow.jsx BROKERS)。

import type { BrokerPickerItem } from '~/ui';

export interface BrokerCatalogEntry {
  /** 券商码(持久化于 broker_account.broker_code; ∈ 本字典),与 server 副本一致。 */
  brokerCode: string;
  /** 中文券商名(mockup 定稿)。 */
  brokerName: string;
  /**
   * 简拼:全名拼音首字母串。搜索按此小写匹配;A-Z 分组取首字符大写。
   * 注:海通(htzq)与华泰(htai)简拼同为 'htzq'(mockup 刻意),靠 brokerCode 区分。
   */
  pinyinInitials: string;
  /**
   * 品牌 logo 资源(require() asset id)。V1 全 null → UI 回退「名首字 brand chip」占位,
   * 真品牌 logo 后续接入(FR-M07)。预留字段以免接入时改 catalog shape。
   */
  logoAsset: number | null;
}

export const BROKER_CATALOG: readonly BrokerCatalogEntry[] = [
  { brokerCode: 'dfcf', brokerName: '东方财富', pinyinInitials: 'dfcf', logoAsset: null },
  { brokerCode: 'gfzq', brokerName: '广发证券', pinyinInitials: 'gfzq', logoAsset: null },
  { brokerCode: 'gtja', brokerName: '国泰君安', pinyinInitials: 'gtja', logoAsset: null },
  { brokerCode: 'gxzq', brokerName: '国信证券', pinyinInitials: 'gxzq', logoAsset: null },
  { brokerCode: 'htzq', brokerName: '海通证券', pinyinInitials: 'htzq', logoAsset: null },
  { brokerCode: 'htai', brokerName: '华泰证券', pinyinInitials: 'htzq', logoAsset: null },
  { brokerCode: 'pazq', brokerName: '平安证券', pinyinInitials: 'pazq', logoAsset: null },
  { brokerCode: 'swhy', brokerName: '申万宏源', pinyinInitials: 'swhy', logoAsset: null },
  { brokerCode: 'yhzq', brokerName: '银河证券', pinyinInitials: 'yhzq', logoAsset: null },
  { brokerCode: 'zszq', brokerName: '招商证券', pinyinInitials: 'zszq', logoAsset: null },
  { brokerCode: 'zxzq', brokerName: '中信证券', pinyinInitials: 'zxzq', logoAsset: null },
  { brokerCode: 'zjgs', brokerName: '中金公司', pinyinInitials: 'zjgs', logoAsset: null },
];

/**
 * 页 C BrokerPickerSheet 数据源:catalog → BrokerPickerItem 派生
 * (initial = 简拼首字母大写,供 A-Z 分组;pinyin = 简拼小写,供搜索)。
 * 分组 / 排序 / 过滤逻辑在 BrokerPickerSheet 内(纯展示派生)。
 */
export const BROKER_PICKER_ITEMS: readonly BrokerPickerItem[] = BROKER_CATALOG.map((b) => ({
  code: b.brokerCode,
  name: b.brokerName,
  initial: b.pinyinInitials.charAt(0).toUpperCase(),
  pinyin: b.pinyinInitials.toLowerCase(),
}));

const BROKER_NAME_BY_CODE = new Map(BROKER_CATALOG.map((b) => [b.brokerCode, b.brokerName]));

/** 查券商中文名(已绑行展示);未知码 → 回退 code 本身。 */
export function brokerNameOf(code: string): string {
  return BROKER_NAME_BY_CODE.get(code) ?? code;
}
