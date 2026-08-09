// Zustand v5 privacy-consent store with AsyncStorage persistence (022 FR-011).
//
// Persist policy (plan D8): the consent marker is NOT a secret — plain
// AsyncStorage, not SecureStore (which is reserved for credentials, see
// auth/store.ts). Uninstall/reinstall wipes it → the privacy screen shows
// again, which is the compliance-correct behavior.
//
// `privacyConsentAt` is an ISO timestamp (null = never consented). Stored as
// a timestamp rather than a boolean so a future privacy-policy revision can
// compare against a policy-updated-at and re-prompt.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export interface ConsentState {
  privacyConsentAt: string | null;
  grantConsent: () => void;
}

export const useConsentStore = create<ConsentState>()(
  persist(
    (set) => ({
      privacyConsentAt: null,

      grantConsent: () => set({ privacyConsentAt: new Date().toISOString() }),
    }),
    {
      name: 'nvy-consent',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
