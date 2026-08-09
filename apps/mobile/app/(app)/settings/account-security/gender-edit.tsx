// 设置性别选择页（008 US1，active 功能页 —— 非占位）。**非 RHF / 无保存按钮**：4 行选项
// （男/女/非二元/保密），点任一行即调 PATCH /me/gender 持久化 + 自动 router.back()（plan D6）。
// 当前 gender 行右侧 brand-500 对勾。失败留屏显错不返回（analyze F2）。复用 ~/settings/primitives
// 的 Card/Divider；选项行（含对勾）就地自建，不抽 ~/ui / 不改 primitives（plan D10）。
import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useMe } from '~/core/api/use-me';
import { ErrorRow, SafeAreaView, Spinner } from '~/ui';
import { Card, Divider } from '~/settings/primitives';
import { GENDER_OPTIONS, GENDER_LABELS, type Gender } from '~/settings/gender';
import { useGenderEdit } from '~/settings/use-gender-edit';

export default function GenderEditScreen() {
  // 进页 GET /me 读当前 gender 预选 —— 数据就绪后再渲染选项（避免 null→值的对勾闪烁）。
  const { data: profile, isLoading } = useMe();

  if (isLoading || !profile) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <View className="flex-1 items-center justify-center bg-surface-sunken">
          <Spinner size={16} tone="muted" />
        </View>
      </SafeAreaView>
    );
  }

  return <GenderPicker current={(profile.gender ?? null) as Gender | null} />;
}

function GenderPicker({ current }: { current: Gender | null }) {
  const router = useRouter();
  const { select, state, errorToast } = useGenderEdit();
  const submitting = state === 'submitting';

  // 仅 success 时返回；失败留屏显错（tap-to-select 无保存按钮的错误态，analyze F2）。
  useEffect(() => {
    if (state === 'success') router.back();
  }, [state, router]);

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View className="flex-1 bg-surface-sunken px-md pt-md gap-sm">
        <Card>
          {GENDER_OPTIONS.map((g, i) => (
            <View key={g}>
              {i > 0 ? <Divider /> : null}
              <GenderOptionRow
                label={GENDER_LABELS[g]}
                selected={current === g}
                disabled={submitting}
                onPress={() => void select(g)}
              />
            </View>
          ))}
        </Card>
        {errorToast ? <ErrorRow text={errorToast} /> : null}
      </View>
    </SafeAreaView>
  );
}

interface GenderOptionRowProps {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}

// 单用选项行 + brand-500 对勾（plan D10：Row primitive 是 chevron 语义无对勾，就地自建）。
function GenderOptionRow({ label, selected, disabled, onPress }: GenderOptionRowProps) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled: !!disabled }}
      className={`flex-row items-center px-md ${disabled ? 'opacity-50' : ''}`}
      style={{ height: 52 }}
    >
      <Text className="flex-1 text-base text-ink">{label}</Text>
      {selected ? (
        <Text className="text-base text-brand-500" accessibilityLabel="已选中">
          ✓
        </Text>
      ) : null}
    </Pressable>
  );
}
