import { describe, expect, it } from 'vitest';

import { cancelDeletionPath, remainingFreezeDays } from './freeze-interception';

// 403 ACCOUNT_IN_FREEZE_PERIOD 的识别由 canonical 层 isFreezePeriod 负责（测见
// src/core/api/errors.spec.ts）；本文件只测 004 专属的天数计算 + 撤销路由构造。
describe('remainingFreezeDays (ceil((freezeUntil-now)/天), 下限 0)', () => {
  const now = new Date('2026-05-26T00:00:00Z');

  it('counts exact whole days', () => {
    expect(remainingFreezeDays('2026-06-10T00:00:00Z', now)).toBe(15);
  });

  it('ceils a partial day up (14d + 1h → 15)', () => {
    expect(remainingFreezeDays('2026-06-09T01:00:00Z', now)).toBe(15);
  });

  it('ceils less than a day up to 1', () => {
    expect(remainingFreezeDays('2026-05-26T01:00:00Z', now)).toBe(1);
  });

  it('clamps to 0 at the boundary (freezeUntil === now)', () => {
    expect(remainingFreezeDays('2026-05-26T00:00:00Z', now)).toBe(0);
  });

  it('clamps to 0 when freezeUntil is in the past', () => {
    expect(remainingFreezeDays('2026-05-20T00:00:00Z', now)).toBe(0);
  });
});

describe('cancelDeletionPath (撤销分支路由)', () => {
  it('builds the cancel-deletion href with the phone percent-encoded', () => {
    expect(cancelDeletionPath('+8613800138000')).toBe('/cancel-deletion?phone=%2B8613800138000');
  });

  it('round-trips through decodeURIComponent', () => {
    const phone = '+8613800138000';
    const query = cancelDeletionPath(phone).replace('/cancel-deletion?phone=', '');
    expect(decodeURIComponent(query)).toBe(phone);
  });
});
