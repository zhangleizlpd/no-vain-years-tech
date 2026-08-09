// Device-management wrappers (005 US5 client). Thin facades over the Orval
// hooks, mirroring useCancelDeletion / logoutAll: import from @nvy/api-client,
// no navigation (caller / screen state machine drives that, FR-C05).
//
// List is single-page (size=100, FR-C01 / DC5) — PoC accounts have < 10 devices,
// so no "load more" pagination. The list query key is re-exported so the device
// detail screen can read the cached list (server has no GET /devices/{id}, FR-C04).

import {
  getDeviceManagementControllerListQueryKey,
  useDeviceManagementControllerList,
  useDeviceManagementControllerRevoke,
  type DeviceListItem,
} from '@nvy/api-client';
import { useQueryClient } from '@tanstack/react-query';

export const deviceListQueryKey = getDeviceManagementControllerListQueryKey;

// Active login devices for the bearer account (single page, size=100).
export function useDevices(): {
  items: DeviceListItem[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const query = useDeviceManagementControllerList({ axios: { params: { size: 100 } } });
  return {
    items: query.data?.data.items ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}

// Revoke one device (remote logout). On success, invalidate the list so the row
// disappears on refetch. Does NOT navigate — the RemoveDeviceSheet state machine
// closes itself + router.back() (FR-C05).
export function useRevokeDevice() {
  const queryClient = useQueryClient();
  return useDeviceManagementControllerRevoke({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: deviceListQueryKey() });
      },
    },
  });
}
