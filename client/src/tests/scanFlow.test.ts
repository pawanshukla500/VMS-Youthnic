import { describe, it, expect } from 'vitest';
import {
  normalizeScannedId,
  isDuplicateScan,
  shouldRequireFlyerId,
  isMeeshoMarketplace,
  isFlyerBarcode,
  isCourierTrackingBarcode,
  classifyBarcode
} from '../utils/scanFlow';

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

describe('barcode classification', () => {
  it('correctly identifies Meesho transparent packaging flyer barcodes', () => {
    expect(isFlyerBarcode('TP4OOEU08339990')).toBe(true);
    expect(isFlyerBarcode('TP4OOEU08339989')).toBe(true);
    expect(isFlyerBarcode('TP10OEU08338897')).toBe(true);
    expect(isFlyerBarcode('tp4ooeu08339990')).toBe(true);
    expect(isFlyerBarcode('PKT99887766')).toBe(true);
    expect(isFlyerBarcode('FLY123456')).toBe(true);

    // Courier tracking IDs should NOT match flyer
    expect(isFlyerBarcode('VL0085617258688')).toBe(false);
    expect(isFlyerBarcode('SF4178840390MFO')).toBe(false);
    expect(isFlyerBarcode('1490842015571145')).toBe(false);
    expect(isFlyerBarcode(null)).toBe(false);
    expect(isFlyerBarcode('')).toBe(false);
    expect(isFlyerBarcode('TP')).toBe(false); // too short
  });

  it('correctly identifies courier tracking numbers (Valmo, Shadowfax, Delhivery, etc.)', () => {
    // Valmo
    expect(isCourierTrackingBarcode('VL0085617258688')).toBe(true);
    expect(isCourierTrackingBarcode('VL0085621531907')).toBe(true);
    // Shadowfax
    expect(isCourierTrackingBarcode('SF4178840390MFO')).toBe(true);
    expect(isCourierTrackingBarcode('SF4184553296FPL')).toBe(true);
    // Pure numeric AWBs (Delhivery, Express, etc.)
    expect(isCourierTrackingBarcode('1490842015571145')).toBe(true);
    expect(isCourierTrackingBarcode('1490842015521035')).toBe(true);
    // Flipkart / Amazon
    expect(isCourierTrackingBarcode('FMPC123456789')).toBe(true);
    expect(isCourierTrackingBarcode('TBA123456789012')).toBe(true);

    // Flyer barcodes should NOT match courier
    expect(isCourierTrackingBarcode('TP4OOEU08339990')).toBe(false);
    expect(isCourierTrackingBarcode(null)).toBe(false);
    expect(isCourierTrackingBarcode('')).toBe(false);
  });

  it('classifies barcodes into flyer, tracking, or unknown', () => {
    expect(classifyBarcode('TP4OOEU08339990')).toBe('flyer');
    expect(classifyBarcode('VL0085617258688')).toBe('tracking');
    expect(classifyBarcode('SF4178840390MFO')).toBe('tracking');
    expect(classifyBarcode('CUSTOM-LABEL')).toBe('unknown');
  });
});
