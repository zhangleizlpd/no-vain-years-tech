/**
 * 疑似改名候选的值域与新码建议 (086 T017, FR-018; plan D8)。纯函数, 零 IO。
 *
 * 候选表 `optionsdesk.symbol_change_candidate` 的 signal / status 是贫血字符串, 值域权威在本文件。
 * 「代码失效」不另起列: `suggestions` 为空数组即是 (同市场标的名称无任何交集)。
 */

/** v1 唯一的信号类型: 行情源明确报「不认识该代码」(实时报价端口的 `unknownSymbols`)。 */
export const CANDIDATE_SIGNAL_VENDOR_UNKNOWN = 'vendor_unknown';

export const CANDIDATE_STATUS = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  DISMISSED: 'DISMISSED',
} as const;
export type CandidateStatus = (typeof CANDIDATE_STATUS)[keyof typeof CANDIDATE_STATUS];

/** 新码建议上限 (plan D8: 最多 3 个)。 */
export const MAX_CODE_SUGGESTIONS = 3;

export interface InstrumentNameRef {
  code: string;
  name: string;
}

export interface CodeSuggestion {
  code: string;
  name: string;
  /** 与旧名共有的有效词数 (后缀词不计), 恒 > 0。 */
  score: number;
}

/**
 * 公司名里不承载身份的后缀 / 泛用词: 只撞上这些词的两家公司不是同一家。小写比较。
 * 只收英文 —— 本 feature 的起因是美股改名 (PSKY → SKYD, 见 PR #495 commit message)。
 */
const SUFFIX_WORDS: ReadonlySet<string> = new Set([
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'ltd',
  'limited',
  'holding',
  'holdings',
  'group',
  'plc',
  'llc',
  'lp',
  'sa',
  'ag',
  'nv',
  'the',
  'and',
  'class',
  'adr',
  'ads',
]);

/** 名称 → 有效词集合 (小写, 按非字母数字切, 去后缀词)。O(名称长度)。 */
function tokenize(name: string): Set<string> {
  const out = new Set<string>();
  for (const raw of name.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw !== '' && !SUFFIX_WORDS.has(raw)) out.add(raw);
  }
  return out;
}

/**
 * 按名称分词交集给同市场标的打分, 取前 {@link MAX_CODE_SUGGESTIONS} 个作为新码建议; 0 分不收。
 * 排序: 分数降序, 同分按代码升序 (结果确定, 便于对账与测试)。
 *
 * 🚨 调用方负责把**旧码自身**从 `sameMarketInstruments` 里剔掉 —— 它与旧名同名, 必然满分排第一。
 *
 * ⚠️ 中文名不含空格 ⇒ 整串是一个词, 只有全名相同才计分。v1 接受这个局限: 无建议时候选即为
 * 「代码失效」, 由人工补新码。
 *
 * 复杂度: O(N·L) 分词打分 (N = 同市场标的数, L = 名称平均长度) + O(M log M) 排序 (M = 命中数 ≤ N)。
 * 仅在出现未知代码时调用, 线性扫即可, 不建倒排索引。
 */
export function suggestNewCodes(
  oldName: string,
  sameMarketInstruments: readonly InstrumentNameRef[],
): CodeSuggestion[] {
  const oldTokens = tokenize(oldName);
  if (oldTokens.size === 0) return [];

  const scored: CodeSuggestion[] = [];
  for (const { code, name } of sameMarketInstruments) {
    let score = 0;
    for (const token of tokenize(name)) if (oldTokens.has(token)) score += 1;
    if (score > 0) scored.push({ code, name, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return scored.slice(0, MAX_CODE_SUGGESTIONS);
}
