/**
 * 074 锚搜索的**入参判据层**。纯函数、零 I/O、无 DI (ADR-0043 §4, 体例同
 * `anchor-submission.rules.ts`)。
 *
 * 🚨 **{@link escapeLike} 是对参照物 `marketdata/local-instrument-search.adapter.ts`
 * 不转义行为的有意偏离** (plan §D4): 那边用户输入的 `%` / `_` 会当 LIKE 通配符生效; 本片
 * spec Edge 钉死了「输入含 `%`、`_` 按**字面**处理, 不改变匹配语义」, 所以 ILIKE 三路的
 * 实参必须先过本函数, 且 SQL 端配显式 `ESCAPE '\'`。CR 时 **MUST NOT** 以「与既有 adapter
 * 对齐」为由把这层转义拆掉 —— 差异的出处是 spec 边界条款, 不是疏忽。
 * ⚠️ 射程只有 ILIKE: pg_trgm 的 `%` 算符与 `similarity()` 是相似度语义, 不吃 LIKE 元字符,
 * 那两路传原串 (plan §D3/§D4)。
 *
 * 🚨 **{@link normalizeSearchQuery} 落在这里而不是 class-validator** (plan §D1): `@MaxLength`
 * / `@IsNotEmpty` 会把超长与空判成 **400**, 而这两个是搜索框的**常态分支**不是校验错误 ——
 * 空 ⇒ use case 短路返 `[]`, 超长 ⇒ 静默截断继续搜 (Edge「超长输入」: 宁静默收窄不报错)。
 */

/** `q` 上限 (plan §D1 拍的 64)。超出**截断**继续匹配, MUST NOT 报 400。 */
export const SEARCH_QUERY_MAX_LENGTH = 64;

/**
 * 搜索串归一化: trim → 截断到 {@link SEARCH_QUERY_MAX_LENGTH} → 空 ⇒ `null`。
 *
 * 截断按 **code point** 数 (`[...str]`), 不按 UTF-16 code unit —— 按 unit 截会把 BMP 外
 * 字符 (emoji 等) 拦腰斩成孤代理半, 送下游的就不再是用户输入的任何字符。O(n), n ≤ 输入长。
 */
export function normalizeSearchQuery(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return [...trimmed].slice(0, SEARCH_QUERY_MAX_LENGTH).join('');
}

/**
 * LIKE / ILIKE 元字符字面化: `\` `%` `_` 前各垫一个 `\`。
 *
 * 单趟正则 (`$&` = 命中字符本身), 每个元字符恰好吃一个转义符 —— 分两趟先 `%` 后 `\` 的写法
 * 会把刚插入的转义符自己再翻倍、`%` 反而重新裸奔 (spec 见「不双重转义」臂)。
 *
 * 🚨 消费侧契约: 拼进 ILIKE 实参 (`%<escaped>%` / `<escaped>%`) 的语句 **MUST** 带显式
 * `ESCAPE '\'` —— 转义符约定跟着语句走, 不赌 session 默认。O(n)。
 */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, '\\$&');
}
