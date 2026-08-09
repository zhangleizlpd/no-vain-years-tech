// 027 T011 — last conversationId 本地持久化（SC-002 冷启 reload 当前会话）。
//
// Persist policy（同 core/consent-store.ts 范式）：conversationId 非凭据 → 用普通
// AsyncStorage（非 SecureStore，后者保留给 credentials，见 auth/store.ts）。冷启动
// 时 use-chat 读出 last id → `useConversationControllerMessages` reload 已落库消息
// （SC-002「刷新/重进后该轮问答仍在」）。登出由 auth clearSession 负责；本 store 仅在
// 用户切换/无会话时被覆盖（write-through），不跨账号串话（服务端 accountId scope + 他人
// id → 404 兜底，命中 404 时 hook 清空本地 id）。
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export interface LastConversationState {
  lastConversationId: string | null;
  setLastConversationId: (id: string | null) => void;
}

export const useLastConversationStore = create<LastConversationState>()(
  persist(
    (set) => ({
      lastConversationId: null,
      setLastConversationId: (id) => set({ lastConversationId: id }),
    }),
    {
      name: 'nvy-chat-last-conversation',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
