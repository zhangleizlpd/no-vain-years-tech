// Device identity store (per 05-22-mono-meta-frontend-gap-audit.md A3).
//
// One persistent id per install + best-effort name/type from expo-device
// (native) or navigator.userAgent (web). Consumed by the axios interceptor
// (apps/mobile/src/core/api/setup.ts) to inject x-device-id / x-device-name /
// x-device-type on every API call — feeds server-side device-bound flows
// (异地登录提醒 / 设备列表 / refresh-token jti 白名单 per ADR-0037).
//
// id is synthesized lazily via `getOrInitId()` so the very first cold-start
// API call still carries x-device-id (don't wait on async expo-device probe).

import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
// nanoid/non-secure: this id is a device fingerprint, not a security secret —
// avoids depending on the crypto polyfill being loaded yet (pre-_layout race).
import { nanoid } from 'nanoid/non-secure';
import { create } from 'zustand';
import type { StateStorage } from 'zustand/middleware';
import { createJSONStorage, persist } from 'zustand/middleware';

export type DeviceType = 'phone' | 'tablet' | 'desktop' | 'tv' | 'unknown';

export interface DeviceState {
  id: string | null;
  name: string | null;
  type: DeviceType | null;
  getOrInitId: () => string;
  hydrate: () => Promise<void>;
  reset: () => void;
}

// Probe is a function (not a module-load const) so tests can stub
// window/navigator via vi.stubGlobal before each case without resetModules.
const isWebEnv = (): boolean =>
  typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const deviceStorage: StateStorage = {
  getItem: async (key) => {
    if (isWebEnv()) return window.localStorage.getItem(key);
    return SecureStore.getItemAsync(key);
  },
  setItem: async (key, value) => {
    if (isWebEnv()) {
      window.localStorage.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
  removeItem: async (key) => {
    if (isWebEnv()) {
      window.localStorage.removeItem(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};

const mapDeviceType = (raw: Device.DeviceType | undefined): DeviceType => {
  switch (raw) {
    case Device.DeviceType.PHONE:
      return 'phone';
    case Device.DeviceType.TABLET:
      return 'tablet';
    case Device.DeviceType.DESKTOP:
      return 'desktop';
    case Device.DeviceType.TV:
      return 'tv';
    default:
      return 'unknown';
  }
};

const detectWebName = (): string => {
  if (typeof navigator === 'undefined') return 'Web - unknown';
  const ua = navigator.userAgent ?? '';
  // First UA token (e.g. "Mozilla/5.0") gives coarse browser family without
  // version-string noise; intentional fingerprinting limited to device class.
  const token = ua.split(' ')[0] ?? 'unknown';
  return `Web - ${token}`.slice(0, 100);
};

// HTTP header values must be ASCII; encodeURIComponent keeps unicode device
// names (e.g. 中文型号) intact + server-side decodable. 200-char cap is
// belt-and-braces — modelName rarely > 50.
const safeHeaderValue = (raw: string, maxLen = 200): string =>
  encodeURIComponent(raw).slice(0, maxLen);

export const useDeviceStore = create<DeviceState>()(
  persist(
    (set, get) => ({
      id: null,
      name: null,
      type: null,

      getOrInitId: () => {
        const existing = get().id;
        if (existing) return existing;
        const id = nanoid(21);
        set({ id });
        return id;
      },

      hydrate: async () => {
        if (!get().id) set({ id: nanoid(21) });

        if (isWebEnv()) {
          if (!get().name) set({ name: detectWebName() });
          if (!get().type) set({ type: 'desktop' });
          return;
        }

        // Native: expo-device. modelName falls back to deviceName then a
        // sentinel — never null so x-device-name is always set on native.
        const name = Device.modelName ?? Device.deviceName ?? 'Unknown device';
        const type = mapDeviceType(await Device.getDeviceTypeAsync());
        set({ name, type });
      },

      reset: () => set({ id: null, name: null, type: null }),
    }),
    {
      name: 'nvy-device',
      storage: createJSONStorage(() => deviceStorage),
      partialize: (s) => ({ id: s.id, name: s.name, type: s.type }),
    },
  ),
);

/**
 * Build the x-device-* header set for axios injection.
 *
 * Always emits `x-device-id` (synthesized on first read if persist hasn't
 * rehydrated yet). Emits `x-device-name` / `x-device-type` only if hydrate
 * has populated them — avoids sending empty / 'unknown' strings on the very
 * first cold-start request.
 */
export const getDeviceHeaders = (): Record<string, string> => {
  const store = useDeviceStore.getState();
  const headers: Record<string, string> = { 'x-device-id': store.getOrInitId() };
  if (store.name) headers['x-device-name'] = safeHeaderValue(store.name);
  if (store.type) headers['x-device-type'] = store.type;
  return headers;
};
