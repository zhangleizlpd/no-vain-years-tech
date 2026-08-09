import { describe, expect, it } from 'vitest';

import { formatLastActive } from './datetime';

describe('formatLastActive', () => {
  it('minute granularity → YYYY.MM.DD HH:mm (no seconds)', () => {
    expect(formatLastActive('2026-05-29T14:05:09Z', 'minute')).toBe('2026.05.29 14:05');
  });

  it('second granularity → appends :ss', () => {
    expect(formatLastActive('2026-05-29T14:05:09Z', 'second')).toBe('2026.05.29 14:05:09');
  });

  it('renders in UTC — timezone-invariant (midnight UTC not shifted by local TZ)', () => {
    // If this used local time, a non-UTC test runner would shift the date/hour.
    expect(formatLastActive('2026-01-01T00:00:00Z', 'minute')).toBe('2026.01.01 00:00');
    expect(formatLastActive('2026-01-01T00:00:00Z', 'second')).toBe('2026.01.01 00:00:00');
  });

  it('zero-pads month / day / hour / minute / second', () => {
    expect(formatLastActive('2026-03-07T03:08:02Z', 'minute')).toBe('2026.03.07 03:08');
    expect(formatLastActive('2026-03-07T03:08:02Z', 'second')).toBe('2026.03.07 03:08:02');
  });

  it('handles cross-year boundary (last second of the year)', () => {
    expect(formatLastActive('2025-12-31T23:59:59Z', 'minute')).toBe('2025.12.31 23:59');
    expect(formatLastActive('2025-12-31T23:59:59Z', 'second')).toBe('2025.12.31 23:59:59');
  });
});
