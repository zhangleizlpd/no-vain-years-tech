import { Pressable, TextInput, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { colors } from '~/theme';

// 搜索输入条（012 页 C 券商选择）。圆角 sunken 底 + 前置放大镜 svg + 末尾清除按钮。
// 受控（value + onChangeText）。presentational 无单测 —— 走 Playwright e2e。

export interface SearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  /** 清除按钮回调；省略则不渲染清除按钮。 */
  onClear?: () => void;
}

function SearchGlyph() {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Circle cx={7} cy={7} r={5} stroke={colors.ink.subtle} strokeWidth={1.6} />
      <Path d="M11 11l3 3" stroke={colors.ink.subtle} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
}

export function SearchBar({ value, onChangeText, placeholder, onClear }: SearchBarProps) {
  return (
    <View
      className="flex-row items-center gap-sm bg-surface-sunken rounded-md px-md"
      style={{ height: 36 }}
    >
      <SearchGlyph />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.ink.subtle}
        accessibilityLabel={placeholder ?? '搜索'}
        autoCapitalize="none"
        autoCorrect={false}
        className="flex-1 text-sm text-ink"
      />
      {value && onClear ? (
        <Pressable
          onPress={onClear}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="清除搜索"
        >
          <Svg width={14} height={14} viewBox="0 0 14 14" fill="none">
            <Path
              d="M3.5 3.5l7 7M10.5 3.5l-7 7"
              stroke={colors.ink.subtle}
              strokeWidth={1.6}
              strokeLinecap="round"
            />
          </Svg>
        </Pressable>
      ) : null}
    </View>
  );
}
