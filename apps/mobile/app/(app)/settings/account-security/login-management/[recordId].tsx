// 「登录设备详情」— login-management/[recordId].tsx (005 US5 client)
//
// 数据源 = list query cache (server 无单设备 GET, FR-C04): useDevices() 复用同一
// query key — 从列表进来命中缓存即时渲染; 深链冷启动则 fallback 重拉。仍缺 → NotFound。
//
// 4 字段 card: 设备名称 / 登录地点 / 登录方式 / 最近活跃(秒级 mono)
// 移除按钮: isCurrent=false 时显示 → 弹 RemoveDeviceSheet (FR-C03)

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { useDevices } from '~/auth/use-devices';
import { formatLastActive } from '~/format/datetime';
import { Card } from '~/settings/primitives';
import RemoveDeviceSheet from '~/settings/login-management/RemoveDeviceSheet';

// ─── Login method label (F5: 已知方式中文, 未知 fallback 原值) ───────────────────

const LOGIN_METHOD_LABEL: Record<string, string> = {
  PHONE_SMS: '快速登录',
  GOOGLE: 'Google 登录',
  APPLE: 'Apple 登录',
  WECHAT: '微信登录',
};

// ─── Primitives ───────────────────────────────────────────────────────────────

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View className="px-md py-md gap-1">
      <Text className="text-xs text-ink-subtle">{label}</Text>
      <Text className={`text-base font-semibold text-ink${mono ? ' font-mono' : ''}`}>{value}</Text>
    </View>
  );
}

function RowDivider() {
  return (
    <View className="flex-row">
      <View style={{ width: 16 }} />
      <View className="flex-1 h-px bg-line-soft" />
    </View>
  );
}

function RemoveButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="移除该设备"
      className="bg-err rounded-md items-center justify-center shadow-cta-err"
      style={{ height: 48 }}
    >
      <Text className="text-base font-semibold text-surface">移除该设备</Text>
    </Pressable>
  );
}

function NotFoundFallback() {
  const router = useRouter();
  return (
    <View className="flex-1 bg-surface-sunken items-center justify-center px-md gap-md">
      <Text className="text-base font-semibold text-ink">该设备不存在或已被移除</Text>
      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="返回"
        className="px-lg py-sm rounded-md bg-brand-500"
      >
        <Text className="text-sm font-medium text-surface">返回</Text>
      </Pressable>
    </View>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LoginManagementDetailPage() {
  const { recordId } = useLocalSearchParams<{ recordId: string }>();
  const [sheetVisible, setSheetVisible] = useState(false);
  const { items, isLoading } = useDevices();

  const item = items.find((x) => x.id === recordId) ?? null;

  // 冷启动重拉中且尚无缓存 → 等待; 拉完仍无 → NotFound。
  if (!item)
    return isLoading ? <View className="flex-1 bg-surface-sunken" /> : <NotFoundFallback />;

  const location = item.location ?? '—';
  const method = LOGIN_METHOD_LABEL[item.loginMethod] ?? item.loginMethod;
  const lastActive = formatLastActive(item.lastActiveAt, 'second');
  const name = item.deviceName ?? '未知设备';

  return (
    <View className="flex-1 bg-surface-sunken">
      <ScrollView className="flex-1" contentContainerClassName="px-md pt-md pb-xl gap-lg">
        <Card>
          <Field label="设备名称" value={name} />
          <RowDivider />
          <Field label="登录地点" value={location} />
          <RowDivider />
          <Field label="登录方式" value={method} />
          <RowDivider />
          <Field label="最近活跃" value={lastActive} mono />
        </Card>

        {!item.isCurrent ? <RemoveButton onPress={() => setSheetVisible(true)} /> : null}
      </ScrollView>

      <RemoveDeviceSheet
        visible={sheetVisible}
        recordId={item.id}
        onClose={() => setSheetVisible(false)}
      />
    </View>
  );
}
