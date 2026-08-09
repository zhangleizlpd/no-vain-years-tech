// 032 T014 — last ideation sessionId 本地持久化（冷启 reload 当前澄清会话）。
// 同 chat/last-conversation-store 范式：sessionId 非凭据 → 普通 AsyncStorage（非 SecureStore）。
// 冷启动 use-ideation-session 读出 last id → useSessionControllerGet reload 已落库 turns。
// 登出由 auth clearSession 负责；本 store 仅在用户切换/无会话时被覆盖（write-through），
// 不跨账号串话（服务端 accountId scope + 他人 id → 404 兜底，命中 404 时 hook 清空本地 id）。
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export interface LastSessionState {
  lastSessionId: string | null;
  setLastSessionId: (id: string | null) => void;
}

export const useLastSessionStore = create<LastSessionState>()(
  persist(
    (set) => ({
      lastSessionId: null,
      setLastSessionId: (id) => set({ lastSessionId: id }),
    }),
    {
      name: 'nvy-ideation-last-session',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
