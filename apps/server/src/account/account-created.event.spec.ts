import { describe, it, expect } from 'vitest';
import { buildAccountCreatedEvent, ACCOUNT_CREATED_EVENT_TYPE } from './account-created.event';

describe('account-created.event (R-VO 后零 class — builder 纯函数)', () => {
  it('type constant matches namespaced format', () => {
    expect(ACCOUNT_CREATED_EVENT_TYPE).toBe('auth.account.created');
  });

  it('buildAccountCreatedEvent() converts BigInt to string + Date to ISO 8601', () => {
    const createdAt = new Date('2026-05-17T10:00:00Z');
    const payload = buildAccountCreatedEvent(9007199254740993n, '+8613800138000', createdAt);
    expect(payload).toEqual({
      accountId: '9007199254740993',
      phone: '+8613800138000',
      createdAt: '2026-05-17T10:00:00.000Z',
    });
  });
});
