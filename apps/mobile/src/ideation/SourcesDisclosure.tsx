// 034 T010 — 接地来源折叠 disclosure（翻面 B/C 上）。挂在触发检索的助手气泡下：默认折叠
// 头部「来源 (N)」+ caret（▸/▾）；点开列每条 relPath:line（+ symbol），≤5。
//
// 视觉 0 新 token：复用 ~/theme（surface/line/ink/brand-soft）；font-mono 走 theme typography。
// presentational（折叠态本地 UI state）→ 折叠/展开走 T012 Playwright e2e（per 测试分层）。
//
// NativeWind ≤4 原子：头部 / 行各自原子受控；行视图抽 SourceRow 子组件（复用频次 ≥2）。
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { IdeationSource } from './ideation-sse-parse';

export interface SourcesDisclosureProps {
  sources: IdeationSource[];
}

export function SourcesDisclosure({ sources }: SourcesDisclosureProps) {
  const [expanded, setExpanded] = useState(false);
  if (sources.length === 0) return null;

  return (
    <View className="bg-surface border border-line rounded-md" testID="ideation-sources-disclosure">
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={`来源 ${sources.length} 条`}
        accessibilityState={{ expanded }}
        className="flex-row items-center gap-1.5 px-md py-2"
        testID="ideation-sources-toggle"
      >
        <Text className="text-xs text-ink-subtle">{expanded ? '▾' : '▸'}</Text>
        <Text className="text-xs font-medium text-ink-muted">来源 ({sources.length})</Text>
      </Pressable>

      {expanded ? (
        <View className="px-md pb-2" testID="ideation-sources-list">
          {sources.map((src, i) => (
            <SourceRow key={`${src.relPath}:${src.startLine}-${i}`} source={src} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** 单条来源：relPath + 行号（等宽）+ symbol（可选）。 */
function SourceRow({ source }: { source: IdeationSource }) {
  const range =
    source.startLine === source.endLine
      ? `${source.startLine}`
      : `${source.startLine}-${source.endLine}`;
  return (
    <View className="py-1 border-t border-line-soft" testID="ideation-source-row">
      <Text className="text-xs font-mono text-ink" numberOfLines={1}>
        {source.relPath}:{range}
      </Text>
      {source.symbol ? (
        <Text className="text-xs font-mono text-ink-subtle" numberOfLines={1}>
          {source.symbol}
        </Text>
      ) : null}
    </View>
  );
}
