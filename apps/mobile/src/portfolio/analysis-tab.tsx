import { Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { colors } from '~/theme';
import { STOCK_DETAIL_COPY } from './stock-detail-copy';

// 分析 Tab（014 US7 / FR-M09，研报容器 V1 占位）。居中空态：doc 图标 +「研报功能即将上线」+
// 指向独立研报 PRD 的副文案（OQ2，完整研报阅读能力在独立版本提供）。无数据依赖、无交互。
// presentational —— 渲染走 Playwright e2e（per mono 测试分层）。

const COPY = STOCK_DETAIL_COPY.analysis;

export function AnalysisTab() {
  return (
    <View className="items-center gap-sm px-xl py-3xl">
      <DocIcon />
      <Text className="text-base font-medium text-ink mt-sm">{COPY.title}</Text>
      <Text className="text-sm text-ink-subtle text-center">{COPY.sub}</Text>
    </View>
  );
}

// 研报 doc 图标（port mockup Icon 'doc'，线性描边）。
function DocIcon() {
  const p = {
    fill: 'none',
    stroke: colors.ink.subtle,
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const;
  return (
    <Svg width={44} height={44} viewBox="0 0 24 24">
      <Path {...p} d="M6 3h8l4 4v14H6zM14 3v4h4" />
      <Path {...p} d="M9 12h6M9 16h6" />
    </Svg>
  );
}
