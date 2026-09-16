// 083 T016 — 交易账户数据面的自动重读触发（plan §D14 / FR-008）：App 回前台 + 屏重新聚焦。
//
// 下拉重读是第三个触发点，由各屏的 `RefreshControl` 接同一个 `refetch`。三者只重读本系统数据，
// 不触发券商同步。
//
// 🚨 入参只收**引用稳定的 `refetch`**，依赖也只放它（Guardrail 15）：🚫 整个 `useQuery` 结果对象进依赖
//    —— 它每次 render 都是新 identity ⇒ effect 反复重挂 ⇒ 自激请求风暴。
// 🚨 🚫 改 react-query 全局 `focusManager` / `refetchOnWindowFocus`（影响全 App 查询）。
import { useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useFocusEffect } from 'expo-router';

/**
 * `AppState` 由非 `active` 变为 `active` ⇒ 调 `refetch`（切后台再回来）。O(1)。
 * web 上 react-native-web 以 `visibilitychange` 驱动 `AppState`；不可用时 `addEventListener` 不返回订阅。
 */
export function useRefetchOnForeground(refetch: () => void): void {
  useEffect(() => {
    let previous: AppStateStatus = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      if (previous !== 'active' && next === 'active') refetch();
      previous = next;
    });
    return () => subscription?.remove();
  }, [refetch]);
}

/**
 * 屏**重新**聚焦 ⇒ 调 `refetch`（如从详情返回，下层屏未卸载）。O(1)。
 * 📌 跳过挂载时那一次聚焦：挂载本身已由 react-query 发起首个请求，再调会让一次进入命中两次。
 */
export function useRefetchOnFocus(refetch: () => void): void {
  const mountedFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (mountedFocus.current) {
        mountedFocus.current = false;
        return;
      }
      refetch();
    }, [refetch]),
  );
}
