/**
 * chat 会话标题派生不变量 —— 无状态纯函数 (per ADR-0043 §2 贫血 + 纯函数)。
 *
 * 标题 = 截首条用户消息 (plan D5 / spec FR-013): 折叠换行/空白 + trim + 截前 N 字;
 * 空/纯空白兜底「新对话」。会话创建/首条消息时 set 到 conversation.title (028 历史列表用)。
 * AI 生成标题留二期 (Clarify) —— 本函数不引 LLM。纯函数,无 DB / 无 side effect。
 */

/**
 * 标题最大字符数 (plan D5 举例 20)。值 = 配置常量;phase 1 取保守短值,够区分会话即可。
 * 按 Unicode code point 计数 (非 UTF-16 code unit),避免截断 emoji/补充平面字符出半字符。
 */
export const TITLE_MAX_LEN = 20;

/** 空/纯空白消息的兜底标题 (spec FR-013 / plan D5)。 */
export const EMPTY_TITLE_FALLBACK = '新对话';

/**
 * 从首条用户消息派生会话标题:
 * ① 把任意连续空白 (含换行/制表符) 折叠成单个空格 → 单行标题;
 * ② trim 首尾空白;
 * ③ 空 → 兜底「新对话」;
 * ④ 截前 TITLE_MAX_LEN 个 code point (按字符而非 UTF-16 单元,防 emoji 半字符)。
 *
 * 复杂度 O(n),n = content 字符数 (一次正则折叠 + 一次展开切片)。
 */
export function deriveTitle(firstUserContent: string): string {
  const folded = firstUserContent.replace(/\s+/g, ' ').trim();
  if (folded.length === 0) return EMPTY_TITLE_FALLBACK;
  // 展开成 code point 数组再切片,避免在代理对中间截断。
  return [...folded].slice(0, TITLE_MAX_LEN).join('');
}
