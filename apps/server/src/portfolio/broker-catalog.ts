/**
 * 012 券商静态字典 —— **server 校验副本** (FR-S08, D5)。
 *
 * 仅 `{ brokerCode, brokerName }`: bind UC 字典校验 (isKnownBroker) + list response
 * 的 brokerName 来源。pinyinInitials / logoAsset 是 client-only (页 C A-Z 索引 + 搜索 +
 * logo chip), 落 apps/mobile/src/portfolio/broker-catalog.ts (client-bundled, D5);
 * 两份 code 集合在 release 人工对齐。V1 硬编码 12 家, 变动需发版。
 *
 * code / 名称对齐 mockup baseline (design/handoff-claude-design BrokerFlow.jsx BROKERS)。
 */
export interface BrokerCatalogEntry {
  /** 券商码 (持久化于 broker_account.broker_code; ∈ 本字典) */
  brokerCode: string;
  /** 中文券商名 (mockup 定稿) */
  brokerName: string;
}

export const BROKER_CATALOG: readonly BrokerCatalogEntry[] = [
  { brokerCode: 'dfcf', brokerName: '东方财富' },
  { brokerCode: 'gfzq', brokerName: '广发证券' },
  { brokerCode: 'gtja', brokerName: '国泰君安' },
  { brokerCode: 'gxzq', brokerName: '国信证券' },
  { brokerCode: 'htzq', brokerName: '海通证券' },
  { brokerCode: 'htai', brokerName: '华泰证券' },
  { brokerCode: 'pazq', brokerName: '平安证券' },
  { brokerCode: 'swhy', brokerName: '申万宏源' },
  { brokerCode: 'yhzq', brokerName: '银河证券' },
  { brokerCode: 'zszq', brokerName: '招商证券' },
  { brokerCode: 'zxzq', brokerName: '中信证券' },
  { brokerCode: 'zjgs', brokerName: '中金公司' },
];

const KNOWN_BROKER_CODES = new Set(BROKER_CATALOG.map((b) => b.brokerCode));
const BROKER_NAME_BY_CODE = new Map(BROKER_CATALOG.map((b) => [b.brokerCode, b.brokerName]));

/** 是否字典已知券商码 (bind UC 校验闸: 未知 → 400 FORM_VALIDATION)。 */
export function isKnownBroker(code: string): boolean {
  return KNOWN_BROKER_CODES.has(code);
}

/** 查券商中文名; 未知码 → null (list response merge 时回退为 code 本身)。 */
export function brokerNameOf(code: string): string | null {
  return BROKER_NAME_BY_CODE.get(code) ?? null;
}
