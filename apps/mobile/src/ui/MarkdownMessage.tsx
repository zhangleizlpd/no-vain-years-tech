// AI 回复 markdown 渲染（027 PoC）。底层 react-native-enriched-markdown（Software Mansion）:
// native = Fabric 原生文本渲染（New Arch），web = md4c 编译为 WASM + RN-Web 渲染器（同一
// `markdown` API，无 WebView）。DeepSeek 默认吐 markdown（粗体/列表/标题/代码块/表格），
// 纯 <Text> 会显示字面 `**星号**`，故 assistant 气泡走此组件。
//
// 样式经 `markdownStyle` 接 ~/theme token —— markdown 库以 RN style 对象配置，是 NativeWind
// className 约定的既定例外（无法用 className 表达逐元素 markdown 样式）。
// React.memo：仅 `content` 变化才重渲；配合「只让末条流式消息变化」可避免每 token 重解析全量历史。
import { memo } from 'react';
import { EnrichedMarkdownText, type MarkdownStyle } from 'react-native-enriched-markdown';
import { colors } from '~/theme';

// 对齐既有 assistant 气泡（text-base / text-ink / leading-relaxed）。值仍引 ~/theme token。
const MD_STYLE: MarkdownStyle = {
  paragraph: { fontSize: 16, lineHeight: 24, color: colors.ink.DEFAULT },
  h1: { fontSize: 22, lineHeight: 30, color: colors.ink.DEFAULT, fontWeight: '700', marginTop: 8 },
  h2: { fontSize: 20, lineHeight: 28, color: colors.ink.DEFAULT, fontWeight: '700', marginTop: 8 },
  h3: { fontSize: 18, lineHeight: 26, color: colors.ink.DEFAULT, fontWeight: '600', marginTop: 6 },
  h4: { fontSize: 16, lineHeight: 24, color: colors.ink.DEFAULT, fontWeight: '600' },
  h5: { fontSize: 16, lineHeight: 24, color: colors.ink.DEFAULT, fontWeight: '600' },
  h6: { fontSize: 16, lineHeight: 24, color: colors.ink.muted, fontWeight: '600' },
  strong: { color: colors.ink.DEFAULT },
  em: { color: colors.ink.DEFAULT },
  link: { color: colors.brand[500], underline: true },
  list: { fontSize: 16, lineHeight: 24, color: colors.ink.DEFAULT, markerColor: colors.ink.muted },
  blockquote: { color: colors.ink.muted, borderColor: colors.line.strong, borderWidth: 3 },
  code: { color: colors.ink.DEFAULT, backgroundColor: colors.surface.sunken },
  codeBlock: {
    fontFamily: 'monospace',
    color: colors.ink.DEFAULT,
    backgroundColor: colors.surface.sunken,
    borderColor: colors.line.soft,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
  },
  table: { borderColor: colors.line.DEFAULT },
};

export interface MarkdownMessageProps {
  /** assistant 回复的原始 markdown 文本（流式中逐 token 累加）。 */
  content: string;
}

export const MarkdownMessage = memo(function MarkdownMessage({ content }: MarkdownMessageProps) {
  return <EnrichedMarkdownText markdown={content} markdownStyle={MD_STYLE} />;
});
