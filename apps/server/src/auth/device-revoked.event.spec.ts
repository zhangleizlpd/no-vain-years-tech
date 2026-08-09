import { describe, it, expect } from 'vitest';
import { DEVICE_REVOKED_EVENT_TYPE, buildDeviceRevokedEvent } from './device-revoked.event';

describe('device-revoked.event', () => {
  it('event-type = auth.device.revoked (<producer-ctx>.<aggregate>.<action>)', () => {
    expect(DEVICE_REVOKED_EVENT_TYPE).toBe('auth.device.revoked');
  });

  it('builder: bigint/Date → 序列化 payload, revokedAt === occurredAt (同 tx now)', () => {
    const occurredAt = new Date('2026-05-26T08:00:00.000Z');
    const payload = buildDeviceRevokedEvent(42n, 1001n, 'dev-abc', occurredAt);
    expect(payload).toEqual({
      accountId: '42',
      recordId: '1001',
      deviceId: 'dev-abc',
      revokedAt: '2026-05-26T08:00:00.000Z',
      occurredAt: '2026-05-26T08:00:00.000Z',
    });
  });
});
