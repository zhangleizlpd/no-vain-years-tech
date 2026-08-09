import type { Msg } from '../../src/integrations/llm/llm-provider.port.js';

/**
 * 收窄 `Msg.content` 为纯文本 (T-2 修复配套, 2026-08-03)。
 *
 * 036 T004 多模态后 `content: string | MsgPart[]`, 而纯文本轮 (本仓 IT 的 fake LLM
 * 路径) 恒为 `string`。测试里直接 `.startsWith` / `.indexOf` 在联合类型上会
 * TS2339/TS2345 (联合方法参数塌成 `string & MsgPart`)。经本 helper 收窄: 类型对了,
 * 且万一哪天真拿到 MsgPart[] 会**响亮抛错**而不是断言静默假过。
 */
export function msgText(content: Msg['content']): string {
  if (typeof content !== 'string') {
    throw new Error(`expected string Msg.content, got MsgPart[]: ${JSON.stringify(content)}`);
  }
  return content;
}
