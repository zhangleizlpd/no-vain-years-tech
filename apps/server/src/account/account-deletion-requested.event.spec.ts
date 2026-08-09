import { describe, it, expect } from 'vitest';
import {
  buildAccountDeletionRequestedEvent,
  ACCOUNT_DELETION_REQUESTED_EVENT_TYPE,
} from './account-deletion-requested.event';

describe('account-deletion-requested.event (零 class — builder 纯函数)', () => {
  it('type constant 遵循 auth.account.deletion-requested 命名 (analyze I1)', () => {
    expect(ACCOUNT_DELETION_REQUESTED_EVENT_TYPE).toBe('auth.account.deletion-requested');
  });

  it('builder: bigint→string / Date→ISO 8601 / freezeAt 与 occurredAt 同值', () => {
    const occurredAt = new Date('2026-05-26T10:00:00Z');
    const freezeUntil = new Date('2026-06-10T10:00:00Z'); // +15d
    const payload = buildAccountDeletionRequestedEvent(9007199254740993n, freezeUntil, occurredAt);
    expect(payload).toEqual({
      accountId: '9007199254740993',
      freezeAt: '2026-05-26T10:00:00.000Z',
      freezeUntil: '2026-06-10T10:00:00.000Z',
      occurredAt: '2026-05-26T10:00:00.000Z',
    });
    // freezeAt 取 occurredAt: 冻结与事件同 tx 同一瞬间。
    expect(payload.freezeAt).toBe(payload.occurredAt);
  });
});
