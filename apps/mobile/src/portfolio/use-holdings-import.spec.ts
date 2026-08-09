import { describe, expect, it, vi } from 'vitest';

// Mock api-client + expo-document-picker so the real axios / native picker chain never loads
// (mirrors use-profile-image-upload.spec). These mocks only keep the module importable —
// the tests below cover the pure helpers (selection / upload path is e2e + device-manual).
vi.mock('@nvy/api-client', () => ({
  useHoldingsImportControllerImport: vi.fn(),
  getHoldingsControllerListQueryKey: vi.fn(() => ['/api/v1/portfolio/holdings']),
}));
vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }));

import { asOfFromFilename, importedCounts, mapImportError } from './use-holdings-import';
import { HOLDINGS_COPY } from './holdings-copy';

const ERR = HOLDINGS_COPY.screen.import.errors;

describe('asOfFromFilename', () => {
  it('extracts YYYYMMDD from the sync-tool filename shape', () => {
    expect(asOfFromFilename('股票账户_20260606.xlsx')).toBe('2026-06-06');
  });

  it('returns undefined when no 8-digit run is present (server defaults to today)', () => {
    expect(asOfFromFilename('持仓.xlsx')).toBeUndefined();
  });

  it('rejects an out-of-range month/day so random digits are not mistaken for a date', () => {
    expect(asOfFromFilename('export_20269932.xlsx')).toBeUndefined();
  });
});

describe('importedCounts', () => {
  it('sums imported rows per section and total skipped across sections', () => {
    const summary = {
      asOf: '2026-06-06',
      holdings: { imported: 2, skipped: [{ row: 3, reason: 'x' }], warnings: [] },
      closed: { imported: 1, skipped: [], warnings: [] },
      trades: { imported: 23, skipped: [{ row: 5, reason: 'y' }], warnings: [] },
    };
    expect(importedCounts(summary)).toEqual({ holdings: 2, closed: 1, trades: 23, skipped: 2 });
  });
});

describe('mapImportError', () => {
  it.each([
    [413, ERR.tooLarge],
    [422, ERR.invalid],
    [400, ERR.invalid],
    [429, ERR.rateLimit],
    [401, ERR.auth],
    [500, ERR.network],
  ])('maps axios %i → friendly copy', (status, expected) => {
    expect(mapImportError({ isAxiosError: true, response: { status } })).toBe(expected);
  });

  it('maps a network error (no status) → network copy', () => {
    expect(mapImportError({ isAxiosError: true })).toBe(ERR.network);
  });

  it('falls back to unknown for non-axios errors', () => {
    expect(mapImportError(new Error('boom'))).toBe(ERR.unknown);
  });
});
