import { Stack } from 'expo-router';

import { makeHeaderBackOrParent } from '~/ui';

export default function SettingsLayout() {
  return (
    <Stack screenOptions={{ headerShown: true }}>
      <Stack.Screen
        name="index"
        options={{
          title: '设置',
          // On web refresh the stack has no history beneath /settings → fall back
          // to the profile tab (where the settings entry lives).
          headerLeft: makeHeaderBackOrParent('/(app)/(tabs)/profile'),
        }}
      />
      {/* account-security has its own nested Stack — disable outer header to avoid double header */}
      <Stack.Screen name="account-security" options={{ headerShown: false }} />
      <Stack.Screen
        name="chat-custom-instructions"
        options={{
          title: '自定义指令',
          headerLeft: makeHeaderBackOrParent('/(app)/settings'),
        }}
      />
      <Stack.Screen
        name="stock-market"
        options={{
          title: '证券市场',
          headerLeft: makeHeaderBackOrParent('/(app)/settings'),
        }}
      />
      <Stack.Screen
        name="broker-accounts"
        options={{
          title: '股票账户',
          headerLeft: makeHeaderBackOrParent('/(app)/settings'),
        }}
      />
      <Stack.Screen
        name="broker-accounts/bind"
        options={{
          title: '绑定券商',
          headerLeft: makeHeaderBackOrParent('/(app)/settings/broker-accounts'),
        }}
      />
    </Stack>
  );
}
