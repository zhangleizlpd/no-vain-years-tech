import { Pressable, Text, View } from 'react-native';

import { Button, SafeAreaView } from '~/ui';
import { colors } from '~/theme';
import { ALERT_COPY } from './alert-copy';
import { AlertIcon } from './alert-icon';
import { CheckCircle } from './check-circle';

// 底栏两态（021 屏 1/1b / FR-M01·M05，mockup AlertScreens ActionFooter/DeleteFooter 翻 RN；
// 屏 5 多选删复用同组件）。常态：选择删除（竖排 icon+label）+ 主按钮；多选态：全选 +
// 删除（未勾 disabled → err-soft 洗白，勾后 err 实色）。presentational，交互走 Playwright。

const COPY = ALERT_COPY.listScreen;

export interface AlertActionFooterProps {
  /** 主按钮文案（屏 1「添加预警」/ 屏 5「新建预警」）。 */
  mainLabel: string;
  onMain: () => void;
  /** 进入多选删除模式（列表空时 disabled）。 */
  onSelectDelete: () => void;
  selectDeleteDisabled?: boolean;
}

/** 常态底栏：选择删除 + 主按钮。 */
export function AlertActionFooter({
  mainLabel,
  onMain,
  onSelectDelete,
  selectDeleteDisabled = false,
}: AlertActionFooterProps) {
  return (
    <SafeAreaView edges={['bottom']} className="bg-surface border-t border-line">
      <View className="flex-row items-center gap-md px-md py-sm">
        <Pressable
          onPress={onSelectDelete}
          disabled={selectDeleteDisabled}
          accessibilityRole="button"
          accessibilityLabel={COPY.selectDelete}
          className={`items-center gap-xs px-sm ${selectDeleteDisabled ? 'opacity-40' : ''}`}
        >
          <AlertIcon name="trash" color={colors.ink.muted} size={20} />
          <Text className="text-xs text-ink-muted">{COPY.selectDelete}</Text>
        </Pressable>
        <View className="flex-1">
          <Button label={mainLabel} onPress={onMain} />
        </View>
      </View>
    </SafeAreaView>
  );
}

export interface AlertDeleteFooterProps {
  allChecked: boolean;
  anyChecked: boolean;
  onToggleAll: () => void;
  onDelete: () => void;
}

/** 多选态底栏：全选 + 删除（未勾 disabled）。 */
export function AlertDeleteFooter({
  allChecked,
  anyChecked,
  onToggleAll,
  onDelete,
}: AlertDeleteFooterProps) {
  return (
    <SafeAreaView edges={['bottom']} className="bg-surface border-t border-line">
      <View className="flex-row items-center px-md py-md">
        <Pressable
          onPress={onToggleAll}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: allChecked }}
          accessibilityLabel={COPY.selectAll}
          className="flex-row items-center gap-sm"
        >
          <CheckCircle checked={allChecked} />
          <Text className="text-base text-ink">{COPY.selectAll}</Text>
        </Pressable>
        <View className="flex-1" />
        <Pressable
          onPress={onDelete}
          disabled={!anyChecked}
          accessibilityRole="button"
          accessibilityLabel={COPY.delete}
          accessibilityState={{ disabled: !anyChecked }}
          className={`rounded-md px-xl py-sm ${anyChecked ? 'bg-err' : 'bg-err-soft'}`}
        >
          <Text className={`text-base font-semibold ${anyChecked ? 'text-surface' : 'text-err'}`}>
            {COPY.delete}
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
