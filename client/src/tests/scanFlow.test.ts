import { describe, it, expect } from 'vitest';
import { normalizeScannedId, isDuplicateScan, shouldRequireFlyerId, isMeeshoMarketplace } from '../utils/scanFlow';

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

describe('isMeeshoMarketplace', () => {
  it('matches Meesho marketplace names case-insensitively', () => {
    expect(isMeeshoMarketplace('Tulip Prints - Meesho')).toBe(true);
    expect(isMeeshoMarketplace('MEESHO')).toBe(true);
  });

  it('rejects other marketplaces and empty values', () => {
    expect(isMeeshoMarketplace('Ajio B2C Dropship')).toBe(false);
    expect(isMeeshoMarketplace(null)).toBe(false);
    expect(isMeeshoMarketplace(undefined)).toBe(false);
    expect(isMeeshoMarketplace('')).toBe(false);
  });
});

describe('shouldRequireFlyerId', () => {  const base = {
    flyerScanEnabled: true,
    isRecording: true,
    flyerId: null,
    flyerWaived: false,
    marketplaceIsMeesho: true,
    marketplaceKnown: true,
  };

  it('requires the flyer for Meesho sessions with none captured', () => {
    expect(shouldRequireFlyerId(base)).toBe(true);
  });

  it('requires the flyer when the marketplace is still unknown', () => {
    expect(shouldRequireFlyerId({ ...base, marketplaceIsMeesho: false, marketplaceKnown: false })).toBe(true);
  });

  it('skips parcels positively known to be non-Meesho', () => {
    expect(shouldRequireFlyerId({ ...base, marketplaceIsMeesho: false, marketplaceKnown: true })).toBe(false);
  });

  it('is idle without the toggle, without a session, or once satisfied', () => {
    expect(shouldRequireFlyerId({ ...base, flyerScanEnabled: false })).toBe(false);
    expect(shouldRequireFlyerId({ ...base, isRecording: false })).toBe(false);
    expect(shouldRequireFlyerId({ ...base, flyerId: 'FLY-1' })).toBe(false);
    expect(shouldRequireFlyerId({ ...base, flyerWaived: true })).toBe(false);
  });
});
