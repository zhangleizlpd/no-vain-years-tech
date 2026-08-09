import { Pressable, Text, View } from 'react-native';

// 右侧 A-Z 字母条（012 页 C 券商选择）。点击某字母 → onJump(letter) 让列表滚到该分组。
// 仅渲染当前存在的分组首字母（letters 由 caller 从过滤后分组派生）。
// presentational 无单测 —— 走 Playwright e2e。

export interface AlphaIndexProps {
  letters: string[];
  onJump: (letter: string) => void;
}

export function AlphaIndex({ letters, onJump }: AlphaIndexProps) {
  return (
    <View className="absolute right-0 top-0 bottom-0 justify-center" style={{ width: 16 }}>
      {letters.map((letter) => (
        <Pressable
          key={letter}
          onPress={() => onJump(letter)}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel={`跳到 ${letter}`}
        >
          <Text className="text-xs font-semibold text-brand-500 text-center">{letter}</Text>
        </Pressable>
      ))}
    </View>
  );
}
