import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn().mockResolvedValue(undefined),
  deleteItemAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('expo-device', () => ({
  DeviceType: { UNKNOWN: 0, PHONE: 1, TABLET: 2, DESKTOP: 3, TV: 4 },
  modelName: 'iPhone 15 Pro',
  deviceName: 'Michael’s iPhone',
  getDeviceTypeAsync: vi.fn().mockResolvedValue(1), // PHONE
}));

vi.mock('nanoid/non-secure', () => ({
  nanoid: vi.fn(() => 'fixed-nanoid-21-chars'),
}));

import * as Device from 'expo-device';
import { getDeviceHeaders, useDeviceStore } from './device-store';

const CLEAN = { id: null, name: null, type: null };

beforeEach(() => {
  useDeviceStore.setState(CLEAN);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('initial state', () => {
  it('starts with all device fields null', () => {
    const s = useDeviceStore.getState();
    expect(s.id).toBeNull();
    expect(s.name).toBeNull();
    expect(s.type).toBeNull();
  });
});

describe('getOrInitId', () => {
  it('synthesizes a nanoid on first call and persists into state', () => {
    const id = useDeviceStore.getState().getOrInitId();
    expect(id).toBe('fixed-nanoid-21-chars');
    expect(useDeviceStore.getState().id).toBe('fixed-nanoid-21-chars');
  });

  it('returns the same id on subsequent calls without re-rolling', async () => {
    const { nanoid } = await import('nanoid/non-secure');
    const first = useDeviceStore.getState().getOrInitId();
    const second = useDeviceStore.getState().getOrInitId();
    expect(second).toBe(first);
    expect(nanoid).toHaveBeenCalledTimes(1);
  });
});

describe('hydrate — native path', () => {
  // vitest default env is 'node' → typeof window === 'undefined' → isWebEnv()
  // returns false → native branch.
  it('populates name + type from expo-device (PHONE → phone)', async () => {
    await useDeviceStore.getState().hydrate();
    const s = useDeviceStore.getState();
    expect(s.id).toBe('fixed-nanoid-21-chars');
    expect(s.name).toBe('iPhone 15 Pro');
    expect(s.type).toBe('phone');
  });

  it.each([
    [Device.DeviceType.PHONE, 'phone'],
    [Device.DeviceType.TABLET, 'tablet'],
    [Device.DeviceType.DESKTOP, 'desktop'],
    [Device.DeviceType.TV, 'tv'],
    [Device.DeviceType.UNKNOWN, 'unknown'],
  ])('maps DeviceType %i → %s', async (raw, expected) => {
    vi.mocked(Device.getDeviceTypeAsync).mockResolvedValueOnce(raw);
    await useDeviceStore.getState().hydrate();
    expect(useDeviceStore.getState().type).toBe(expected);
  });
});

describe('hydrate — web fallback', () => {
  it('uses navigator.userAgent first token + type=desktop when window/localStorage present', async () => {
    // Stub both window (with localStorage) AND navigator so isWebEnv() flips
    // true within the same test. vitest node env normally has neither.
    vi.stubGlobal('window', {
      localStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    });

    await useDeviceStore.getState().hydrate();
    const s = useDeviceStore.getState();
    expect(s.id).toBe('fixed-nanoid-21-chars');
    expect(s.name).toBe('Web - Mozilla/5.0');
    expect(s.type).toBe('desktop');
  });

  it('caps web name to 100 chars when UA token is pathologically long', async () => {
    vi.stubGlobal('window', {
      localStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    });
    vi.stubGlobal('navigator', { userAgent: 'A'.repeat(500) });
    await useDeviceStore.getState().hydrate();
    expect(useDeviceStore.getState().name?.length).toBeLessThanOrEqual(100);
  });
});

describe('persist partialize', () => {
  it('persists id/name/type, excludes the action functions', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { partialize } = (useDeviceStore as any).persist.getOptions() as {
      partialize: (s: Record<string, unknown>) => Record<string, unknown>;
    };
    const persisted = partialize({
      id: 'd-1',
      name: 'iPhone 15 Pro',
      type: 'phone',
      getOrInitId: () => 'd-1',
      hydrate: () => Promise.resolve(),
      reset: () => undefined,
    });
    expect(persisted).toEqual({ id: 'd-1', name: 'iPhone 15 Pro', type: 'phone' });
    expect(persisted).not.toHaveProperty('getOrInitId');
    expect(persisted).not.toHaveProperty('hydrate');
    expect(persisted).not.toHaveProperty('reset');
  });
});

describe('getDeviceHeaders', () => {
  it('emits only x-device-id when name/type still null (pre-hydrate)', () => {
    useDeviceStore.setState({ id: 'd-1', name: null, type: null });
    expect(getDeviceHeaders()).toEqual({ 'x-device-id': 'd-1' });
  });

  it('emits all three headers once hydrate has populated name + type', () => {
    useDeviceStore.setState({ id: 'd-1', name: 'iPhone 15 Pro', type: 'phone' });
    expect(getDeviceHeaders()).toEqual({
      'x-device-id': 'd-1',
      'x-device-name': encodeURIComponent('iPhone 15 Pro'),
      'x-device-type': 'phone',
    });
  });

  it('encodes unicode device names so headers stay HTTP-safe', () => {
    useDeviceStore.setState({ id: 'd-1', name: '小明的iPhone', type: 'phone' });
    expect(getDeviceHeaders()['x-device-name']).toBe(encodeURIComponent('小明的iPhone'));
  });

  it('synthesizes id when state is fully empty (first cold-start request)', () => {
    useDeviceStore.setState({ id: null, name: null, type: null });
    const headers = getDeviceHeaders();
    expect(headers['x-device-id']).toBe('fixed-nanoid-21-chars');
  });
});
