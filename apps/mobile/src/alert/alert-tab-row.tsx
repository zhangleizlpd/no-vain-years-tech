import { Pressable, Text, View } from 'react-native';

// 顶部 tab 行（021 屏 4 自选/搜索、屏 5 单 A股 共用，mockup AlertScreens TabRow 翻 RN）：
// 等分 + 选中底部短横条（brand），disabled 灰不可点。
// 🔁 072 T014 起**屏 6 消息中心不再是调用方**（「待办」整栏退役，单栏 tab 行无意义）。
// `disabled` 目前无调用方传入,保留是因为它是本组件的通用能力、不是 072 造出来的 orphan。
// presentational — 切换交互走 Playwright（mono 测试分层）。

export interface AlertTab {
  key: string;
  label: string;
  disabled?: boolean;
}

export interface AlertTabRowProps {
  tabs: AlertTab[];
  active: string;
  onChange: (key: string) => void;
}

export function AlertTabRow({ tabs, active, onChange }: AlertTabRowProps) {
  return (
    <View className="flex-row bg-surface border-b border-line-soft">
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <Pressable
            key={t.key}
            onPress={() => onChange(t.key)}
            disabled={t.disabled}
            accessibilityRole="tab"
            accessibilityLabel={t.label}
            accessibilityState={{ selected: on, disabled: !!t.disabled }}
            className="flex-1 items-center pt-md pb-sm"
          >
            <Text
              className={`text-base ${
                t.disabled
                  ? 'text-ink-subtle'
                  : on
                    ? 'font-semibold text-ink'
                    : 'font-medium text-ink-muted'
              }`}
            >
              {t.label}
            </Text>
            <View
              className={`mt-xs h-1 w-6 rounded-full ${on ? 'bg-brand-500' : 'bg-transparent'}`}
            />
          </Pressable>
        );
      })}
    </View>
  );
}
