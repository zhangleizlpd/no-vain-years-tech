import { useEffect, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import type { AlertResponseFrequency } from '@nvy/api-client';

import { Button, SafeAreaView } from '~/ui';
import { colors } from '~/theme';
import { ALERT_COPY } from './alert-copy';
import { AlertIcon } from './alert-icon';

// 提醒频率 sheet（021 屏 7a / FR-M02，mockup FrequencySheet 翻 RN）：三档单选（标题+副文
// +选中 ✓）+ 完成提交。打开时以草稿值 seed 本地选中态，完成才回写（取消不污染草稿）。
// Modal 体例镜像 group-management 动作面板。presentational，交互走 Playwright。

const COPY = ALERT_COPY.sheet;
const FREQUENCIES = ['ONCE_DELETE', 'ONCE_DISABLE', 'DAILY'] as const;

export interface FrequencySheetProps {
  visible: boolean;
  value: AlertResponseFrequency;
  onConfirm: (value: AlertResponseFrequency) => void;
  onClose: () => void;
}

export function FrequencySheet({ visible, value, onConfirm, onClose }: FrequencySheetProps) {
  const [selected, setSelected] = useState<AlertResponseFrequency>(value);

  // 每次打开重新以草稿值 seed（上次取消的残留不带入）。
  useEffect(() => {
    if (visible) setSelected(value);
  }, [visible, value]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-modal-overlay">
        <Pressable onPress={onClose} accessibilityLabel={COPY.close} className="absolute inset-0" />
        <SafeAreaView edges={['bottom']} className="bg-surface rounded-t-lg">
          <Text className="text-lg font-semibold text-ink px-md pt-lg pb-xs">
            {COPY.frequencyTitle}
          </Text>
          {FREQUENCIES.map((f, i) => (
            <Pressable
              key={f}
              onPress={() => setSelected(f)}
              accessibilityRole="radio"
              accessibilityState={{ selected: selected === f }}
              accessibilityLabel={ALERT_COPY.frequency[f].title}
              className={`flex-row items-center gap-md px-md py-md ${
                i > 0 ? 'border-t border-line-soft' : ''
              }`}
            >
              <View className="flex-1">
                <Text className="text-base font-medium text-ink">
                  {ALERT_COPY.frequency[f].title}
                </Text>
                <Text className="text-xs text-ink-subtle mt-xs">{ALERT_COPY.frequency[f].sub}</Text>
              </View>
              {selected === f ? (
                <AlertIcon name="check" color={colors.brand[500]} size={20} />
              ) : null}
            </Pressable>
          ))}
          <View className="px-md py-md">
            <Button label={COPY.done} onPress={() => onConfirm(selected)} />
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
