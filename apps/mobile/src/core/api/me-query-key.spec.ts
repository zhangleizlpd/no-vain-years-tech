import { describe, expect, it, vi } from 'vitest';

// Mock the Orval-generated base key so this stays a pure unit (no axios/api-client
// entry resolution). meQueryKey only appends the account discriminator.
vi.mock('@nvy/api-client', () => ({
  getAccountProfileControllerGetProfileQueryKey: vi.fn(() => ['/api/v1/accounts/me']),
}));

import { meQueryKey } from './me-query-key';

describe('meQueryKey', () => {
  it('appends accountId so each account addresses its own /me cache slot', () => {
    expect(meQueryKey('42')).toEqual(['/api/v1/accounts/me', '42']);
  });

  it('two accounts resolve to distinct keys (no cross-account cache bleed)', () => {
    expect(meQueryKey('1')).not.toEqual(meQueryKey('2'));
  });

  it('null accountId (pre-login) yields a stable, distinct key', () => {
    expect(meQueryKey(null)).toEqual(['/api/v1/accounts/me', null]);
  });
});
