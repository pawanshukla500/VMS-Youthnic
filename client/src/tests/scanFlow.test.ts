import { describe, it, expect } from 'vitest';
import { normalizeScannedId, isDuplicateScan } from '../utils/scanFlow';

describe('normalizeScannedId', () => {
  it('trims scanner-added whitespace', () => {
    expect(normalizeScannedId('  TRACK-123\r\n')).toBe('TRACK-123');
  });

  it('returns empty for blank scans', () => {
    expect(normalizeScannedId('   ')).toBe('');
  });
});

describe('isDuplicateScan', () => {
  it('ignores a re-scan of the parcel being recorded', () => {
    expect(isDuplicateScan('TRACK-1', 'TRACK-1')).toBe(true);
  });

  it('starts a new session for a different parcel', () => {
    expect(isDuplicateScan('TRACK-1', 'TRACK-2')).toBe(false);
  });

  it('never treats a missing id as a duplicate', () => {
    expect(isDuplicateScan(null, 'TRACK-2')).toBe(false);
    expect(isDuplicateScan('TRACK-1', '')).toBe(false);
  });
});
