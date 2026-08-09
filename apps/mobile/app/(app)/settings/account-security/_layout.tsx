import { Stack } from 'expo-router';

import { makeHeaderBackOrParent } from '~/ui';

export default function AccountSecurityLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        // Edit screens (bio / name / gender / delete) fall back one level up to
        // the account-security index on web refresh.
        headerLeft: makeHeaderBackOrParent('/(app)/settings/account-security'),
      }}
    >
      <Stack.Screen
        name="index"
        // The index's parent is the settings root, not itself.
        options={{ title: '账号与安全', headerLeft: makeHeaderBackOrParent('/(app)/settings') }}
      />
      <Stack.Screen name="bio-edit" options={{ title: '个人简介' }} />
      <Stack.Screen name="name-edit" options={{ title: '设置昵称' }} />
      <Stack.Screen name="gender-edit" options={{ title: '设置性别' }} />
      <Stack.Screen name="delete-account" options={{ title: '注销账号' }} />
      <Stack.Screen name="wechat-unbind" options={{ title: '账号解绑' }} />
      {/* login-management 子树自带 Stack header (登录管理 / 登录设备详情),
          父级不再渲染,否则路由名 header 会叠在中文 header 上形成双标题。 */}
      <Stack.Screen name="login-management" options={{ headerShown: false }} />
    </Stack>
  );
}
