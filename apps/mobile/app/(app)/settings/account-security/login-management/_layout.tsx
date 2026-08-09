import { Stack } from 'expo-router';

import { makeHeaderBackOrParent } from '~/ui';

export default function LoginManagementLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        // [recordId] detail falls back to the login-management list on web refresh.
        headerLeft: makeHeaderBackOrParent('/(app)/settings/account-security/login-management'),
      }}
    >
      <Stack.Screen
        name="index"
        // The list's parent is account-security.
        options={{
          title: '登录管理',
          headerLeft: makeHeaderBackOrParent('/(app)/settings/account-security'),
        }}
      />
      <Stack.Screen name="[recordId]" options={{ title: '登录设备详情' }} />
    </Stack>
  );
}
