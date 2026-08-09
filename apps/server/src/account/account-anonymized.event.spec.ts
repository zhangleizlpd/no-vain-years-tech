import { describe, it, expect } from 'vitest';
import {
  buildAccountAnonymizedEvent,
  ACCOUNT_ANONYMIZED_EVENT_TYPE,
} from './account-anonymized.event';

describe('account-anonymized.event (零 class — builder 纯函数)', () => {
  it('type constant 遵循 account.account.anonymized 命名 (analyze I1: account 自产)', () => {
    expect(ACCOUNT_ANONYMIZED_EVENT_TYPE).toBe('account.account.anonymized');
  });

  it('builder: bigint→string / Date→ISO 8601 / anonymizedAt 与 occurredAt 同值', () => {
    const occurredAt = new Date('2026-05-26T10:00:00Z');
    const payload = buildAccountAnonymizedEvent(9007199254740993n, occurredAt);
    expect(payload).toEqual({
      accountId: '9007199254740993',
      anonymizedAt: '2026-05-26T10:00:00.000Z',
      occurredAt: '2026-05-26T10:00:00.000Z',
    });
    expect(payload.anonymizedAt).toBe(payload.occurredAt);
  });
});
