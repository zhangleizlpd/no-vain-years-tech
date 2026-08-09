import { describe, it, expect } from 'vitest';
import {
  buildAccountDeletionCancelledEvent,
  ACCOUNT_DELETION_CANCELLED_EVENT_TYPE,
} from './account-deletion-cancelled.event';

describe('account-deletion-cancelled.event (零 class — builder 纯函数)', () => {
  it('type constant 遵循 auth.account.deletion-cancelled 命名 (analyze I1)', () => {
    expect(ACCOUNT_DELETION_CANCELLED_EVENT_TYPE).toBe('auth.account.deletion-cancelled');
  });

  it('builder: bigint→string / Date→ISO 8601 / cancelledAt 与 occurredAt 同值', () => {
    const occurredAt = new Date('2026-05-26T10:00:00Z');
    const payload = buildAccountDeletionCancelledEvent(9007199254740993n, occurredAt);
    expect(payload).toEqual({
      accountId: '9007199254740993',
      cancelledAt: '2026-05-26T10:00:00.000Z',
      occurredAt: '2026-05-26T10:00:00.000Z',
    });
    // cancelledAt 取 occurredAt: 解冻与事件同 tx 同一瞬间。
    expect(payload.cancelledAt).toBe(payload.occurredAt);
  });
});
