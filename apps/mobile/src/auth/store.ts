// Zustand v5 auth store with expo-secure-store persistence.
//
// Persist policy:
//   accountId / refreshToken / displayName / phone → SecureStore (Keychain/Keystore on
//   native, localStorage on web). Survives app restarts.
//   accessToken → in-memory only. Re-derived via refreshTokenFlow on cold start.
//
// displayName is persisted to avoid AuthGate flicker on rehydrate (US12).

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';
import * as SecureStore from 'expo-secure-store';

// Remote profile fetching moved to apps/mobile/lib/api/use-me.ts (React
// Query hook) per PR-5c. The store no longer owns network I/O; it just
// holds the auth tokens + the persisted denormalized profile snapshot
// (displayName / phone / accountId) for AuthGate cold-start.

// Platform-aware secure storage (per plan D12). On native we go through
// expo-secure-store (Keychain on iOS, Keystore on Android). On web,
// expo-secure-store ships an empty stub (ExpoSecureStore.web.ts = `export
// default {}`) — fall back to window.localStorage directly so AuthGate /
// persist rehydration work for Expo Web (Playwright T040).
//
// We probe via `typeof window` rather than `Platform.OS === 'web'` to keep
// the auth module UI-platform-neutral (no react-native dep).
const isWebEnv = typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const secureStorage: StateStorage = isWebEnv
  ? {
      getItem: async (key) => window.localStorage.getItem(key),
      setItem: async (key, value) => {
        window.localStorage.setItem(key, value);
      },
      removeItem: async (key) => {
        window.localStorage.removeItem(key);
      },
    }
  : {
      getItem: (key) => SecureStore.getItemAsync(key),
      setItem: (key, value) => SecureStore.setItemAsync(key, value),
      removeItem: (key) => SecureStore.deleteItemAsync(key),
    };

export interface Session {
  accountId: string;
  accessToken: string;
  refreshToken: string;
}

export interface AuthState {
  accountId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  displayName: string | null;
  phone: string | null;
  isAuthenticated: boolean;
  setSession: (session: Session) => void;
  setAccessToken: (token: string) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accountId: null,
      accessToken: null,
      refreshToken: null,
      displayName: null,
      phone: null,
      isAuthenticated: false,

      setSession: ({ accountId, accessToken, refreshToken }) =>
        set({ accountId, accessToken, refreshToken, isAuthenticated: true }),

      setAccessToken: (token) => set({ accessToken: token }),

      clearSession: () =>
        set({
          accountId: null,
          accessToken: null,
          refreshToken: null,
          displayName: null,
          phone: null,
          isAuthenticated: false,
        }),
    }),
    {
      name: 'nvy-auth',
      storage: createJSONStorage(() => secureStorage),
      // accessToken intentionally omitted — refreshed on cold start (US12).
      partialize: (state) => ({
        accountId: state.accountId,
        refreshToken: state.refreshToken,
        displayName: state.displayName,
        phone: state.phone,
      }),
      onRehydrateStorage: () => (rehydratedState) => {
        if (rehydratedState?.refreshToken && rehydratedState.accountId !== null) {
          useAuthStore.setState({ isAuthenticated: true });
        }
      },
    },
  ),
);
