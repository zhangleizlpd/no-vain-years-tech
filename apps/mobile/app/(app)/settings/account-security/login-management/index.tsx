// 「登录管理」设备列表 — login-management/index.tsx (005 US5 client)
//
// 自上而下:
//   • 副标题「已登录的设备 N」
//   • Card 列表: device row × N (图标 / 名+本机徽标 / 时间·地点 / chevron)
//   • loading: skeleton + spinner / error: ErrorRow + 重试 / empty: 提示
//
// 单页拉取 (size=100, FR-C01/DC5) — PoC 设备数 < 10, 无分页 CTA。
// 数据真相源 = server (Orval), 行渲染降级口径 per FR-C02。

import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { DeviceListItem } from '@nvy/api-client';

import { useDevices } from '~/auth/use-devices';
import { formatLastActive } from '~/format/datetime';
import { Card } from '~/settings/primitives';
import { DeviceIcon, type DeviceKind } from '~/settings/login-management/DeviceIcon';
import { colors } from '~/theme';
import { ErrorRow } from '~/ui';

// ─── Glyph ───────────────────────────────────────────────────────────────────

function ChevronRight({ color = colors.ink.subtle, size = 18 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M9 6 L15 12 L9 18"
        stroke={color}
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

// ─── 「本机」徽标 — identity 语义蓝灰, 与 destructive err 红区分 ──────────────────

function CurrentBadge() {
  return (
    <View className="bg-brand-soft px-2 py-0.5 rounded-xs">
      <Text className="font-semibold text-brand-600 tracking-wider" style={{ fontSize: 10 }}>
        本机
      </Text>
    </View>
  );
}

// ─── Device row ───────────────────────────────────────────────────────────────

function DeviceRow({ item, onPress }: { item: DeviceListItem; onPress: () => void }) {
  const name = item.deviceName ?? '未知设备';
  const lastActive = formatLastActive(item.lastActiveAt, 'minute');
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`设备 ${name}${item.isCurrent ? '（本机）' : ''}`}
      className="flex-row items-center px-md gap-md"
      style={{ minHeight: 68 }}
    >
      <View className="items-center justify-center" style={{ width: 28, height: 28 }}>
        <DeviceIcon kind={item.deviceType as DeviceKind} size={26} />
      </View>
      <View className="flex-1 gap-1" style={{ paddingVertical: 12 }}>
        <View className="flex-row items-center gap-2">
          <Text className="text-base font-semibold text-ink">{name}</Text>
          {item.isCurrent ? <CurrentBadge /> : null}
        </View>
        <Text className="text-xs text-ink-muted">
          {lastActive} · {item.location ?? '—'}
        </Text>
      </View>
      <ChevronRight />
    </Pressable>
  );
}

function RowDivider() {
  // 左缩进与图标右缘对齐: px-md(16) + icon(28) + gap-md(16) = 60
  return (
    <View className="flex-row">
      <View style={{ width: 60 }} />
      <View className="flex-1 h-px bg-line-soft" />
    </View>
  );
}

function Subtitle({ count }: { count: number }) {
  return <Text className="text-xs text-ink-muted px-md pt-md pb-sm">已登录的设备 {count}</Text>;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LoginManagementListPage() {
  const router = useRouter();
  const { items, isLoading, isError, refetch } = useDevices();

  if (isLoading) {
    return (
      <View className="flex-1 bg-surface-sunken">
        <View className="px-md pt-md pb-sm">
          <View className="bg-line-soft rounded-xs" style={{ width: 120, height: 12 }} />
        </View>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
          <Text className="text-xs text-ink-subtle mt-sm">加载中…</Text>
        </View>
      </View>
    );
  }

  if (isError) {
    return (
      <View className="flex-1 bg-surface-sunken">
        <View className="p-md gap-md">
          <ErrorRow text="网络错误，请重试" />
          <Pressable
            onPress={refetch}
            accessibilityRole="button"
            accessibilityLabel="重试加载设备列表"
            className="self-start px-md py-xs rounded-xs border border-line-strong"
          >
            <Text className="text-sm font-medium text-ink">重试</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-surface-sunken">
      <Subtitle count={items.length} />
      <ScrollView className="flex-1" contentContainerClassName="px-md pb-xl gap-md">
        {items.length === 0 ? (
          <Text className="text-sm text-ink-subtle text-center pt-xl">暂无登录设备</Text>
        ) : (
          <Card>
            {items.map((item, i) => (
              <View key={item.id}>
                {i > 0 ? <RowDivider /> : null}
                <DeviceRow
                  item={item}
                  onPress={() =>
                    router.push(`/(app)/settings/account-security/login-management/${item.id}`)
                  }
                />
              </View>
            ))}
          </Card>
        )}
      </ScrollView>
    </View>
  );
}
