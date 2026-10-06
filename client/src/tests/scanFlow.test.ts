import { describe, it, expect } from 'vitest';
import {
  normalizeScannedId,
  isDuplicateScan,
  shouldRequireFlyerId,
  isMeeshoMarketplace,
  isLikelyMeeshoShipment,
  isFlyerBarcode,
  isCourierTrackingBarcode,
  classifyBarcode,
  flyerToggleState,
  isKnownNonMeeshoTracking,
  classifyScan
} from '../utils/scanFlow';

describe('normalizeScannedId', () => {
  it('trims scanner-added whitespace', () => {
    expect(normalizeScannedId('  TRACK-123\r\n')).toBe('TRACK-123');
  });

  it('returns empty for blank scans', () => {
    expect(normalizeScannedId('   ')).toBe('');
  });

  it('always stores capitals, whatever the scanner caps-lock state', () => {
    expect(normalizeScannedId('sf4158705460fpl')).toBe('SF4158705460FPL');
    expect(normalizeScannedId('vl0085597228896')).toBe('VL0085597228896');
    expect(normalizeScannedId('Tp4ooeu12345')).toBe('TP4OOEU12345');
  });
});

describe('classifyScan (wrong-scan guard)', () => {
  it('rejects tag / product codes the packers scanned by mistake', () => {
    expect(classifyScan('STGNrPmlYc_001_v')).toMatchObject({ kind: 'invalid', code: 'STGNRPMLYC_001_V' });
    expect(classifyScan('.01')).toMatchObject({ kind: 'invalid' });
    expect(classifyScan('SKD238-TRIPTI-BEIGE_S').kind).toBe('invalid');
    expect(classifyScan('https://meesho.com/x').kind).toBe('invalid');
    expect(classifyScan('ABC 12345678').kind).toBe('invalid');
    expect(classifyScan('').kind).toBe('invalid');
    expect(classifyScan('12345').kind).toBe('invalid');
    expect(classifyScan('ABCDEFGHIJ').kind).toBe('invalid');
    expect(classifyScan('X'.repeat(30) + '1234567890123').kind).toBe('invalid');
  });

  it('accepts every courier AWB format we ship with, in any case', () => {
    for (const awb of [
      'sf4158705460fpl', 'SF4178840390MFO', 'vl0085597228896', 'VL0085617258688',
      'FMPP1234567890', 'MYSP1234567890', 'TBA123456789000', '1490842015571145',
      '14234567890123', 'EE123456789IN', 'D12345678',
    ]) {
      const verdict = classifyScan(awb);
      expect(verdict, awb).toMatchObject({ kind: 'tracking', code: awb.toUpperCase() });
    }
  });

  it('recognises flyer bags and gives a readable reason for junk', () => {
    expect(classifyScan('tp4ooeu1234')).toMatchObject({ kind: 'flyer', code: 'TP4OOEU1234' });
    const bad = classifyScan('STGNrPmlYc_001_v');
    expect(bad.kind === 'invalid' && bad.reason).toContain('"_"');
    const short = classifyScan('.01');
    expect(short.kind === 'invalid' && short.reason).toContain('"."');
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

describe('isLikelyMeeshoShipment', () => {
  it('detects Meesho marketplace name', () => {
    expect(isLikelyMeeshoShipment('SF123456789', 'MEESHO')).toBe(true);
    expect(isLikelyMeeshoShipment(null, 'Tulip Prints - Meesho')).toBe(true);
  });

  it('detects Valmo captive logistics tracking numbers (VL...) even before marketplace resolves', () => {
    expect(isLikelyMeeshoShipment('VL0085617258688', null)).toBe(true);
    expect(isLikelyMeeshoShipment('VL0085621531907', undefined)).toBe(true);
  });

  it('trusts a resolved non-Meesho marketplace over the Valmo prefix', () => {
    expect(isLikelyMeeshoShipment('VL0085617258688', 'Flipkart')).toBe(false);
  });

  it('returns false for non-Meesho orders without Valmo prefix', () => {
    expect(isLikelyMeeshoShipment('SF4178840390MFO', 'Amazon')).toBe(false);
    expect(isLikelyMeeshoShipment('1490842015571145', null)).toBe(false);
    expect(isLikelyMeeshoShipment(null, null)).toBe(false);
  });
});

describe('shouldRequireFlyerId', () => {
  const base = {
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

  it('AUTOMATICALLY requires the flyer for Meesho orders even when manual toggle is OFF', () => {
    expect(shouldRequireFlyerId({ ...base, flyerScanEnabled: false, marketplaceIsMeesho: true })).toBe(true);
  });

  it('requires the flyer when toggle is ON and the marketplace is still unknown', () => {
    expect(shouldRequireFlyerId({ ...base, flyerScanEnabled: true, marketplaceIsMeesho: false, marketplaceKnown: false })).toBe(true);
  });

  it('skips parcels positively known to be non-Meesho when toggle is ON', () => {
    expect(shouldRequireFlyerId({ ...base, flyerScanEnabled: true, marketplaceIsMeesho: false, marketplaceKnown: true })).toBe(false);
  });

  it('skips non-Meesho parcels when manual toggle is OFF', () => {
    expect(shouldRequireFlyerId({ ...base, flyerScanEnabled: false, marketplaceIsMeesho: false, marketplaceKnown: false })).toBe(false);
  });

  it('is idle without a recording session, or once flyer is satisfied or waived', () => {
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

describe('flyerToggleState', () => {
  it('switches ON automatically for a Meesho parcel even when the manual switch is off', () => {
    expect(flyerToggleState({ manualEnabled: false, hasParcel: true, marketplaceKnown: true, isMeesho: true })).toEqual({ on: true, auto: true });
  });

  it('switches OFF automatically for a known non-Meesho parcel even when the manual switch is on', () => {
    expect(flyerToggleState({ manualEnabled: true, hasParcel: true, marketplaceKnown: true, isMeesho: false })).toEqual({ on: false, auto: true });
  });

  it('stays armed (ON, automatic) while waiting for the next parcel', () => {
    expect(flyerToggleState({ manualEnabled: false, hasParcel: false, marketplaceKnown: false, isMeesho: false })).toEqual({ on: true, auto: true });
  });

  it('falls back to the manual switch only for a parcel whose marketplace is unknown', () => {
    expect(flyerToggleState({ manualEnabled: false, hasParcel: true, marketplaceKnown: false, isMeesho: false })).toEqual({ on: false, auto: false });
    expect(flyerToggleState({ manualEnabled: true, hasParcel: true, marketplaceKnown: false, isMeesho: false })).toEqual({ on: true, auto: false });
  });

  it('is fully manual when the organization turned automatic flyer scan off', () => {
    expect(flyerToggleState({ manualEnabled: false, hasParcel: true, marketplaceKnown: true, isMeesho: true, autoEnabled: false })).toEqual({ on: false, auto: false });
    expect(flyerToggleState({ manualEnabled: true, hasParcel: false, marketplaceKnown: false, isMeesho: false, autoEnabled: false })).toEqual({ on: true, auto: false });
  });

  it('treats a Valmo-prefixed parcel as Meesho before the lookup returns', () => {
    expect(flyerToggleState({ manualEnabled: false, hasParcel: true, marketplaceKnown: false, isMeesho: true })).toEqual({ on: true, auto: true });
  });
});

describe('isKnownNonMeeshoTracking', () => {
  it('recognises Flipkart and Myntra AWBs (not copied into VMS) as non-Meesho', () => {
    expect(isKnownNonMeeshoTracking('FMPC6554585455')).toBe(true);
    expect(isKnownNonMeeshoTracking('fmpp4257348507')).toBe(true);
    expect(isKnownNonMeeshoTracking('MYSP1472495046')).toBe(true);
    expect(isKnownNonMeeshoTracking('MYEP1135031932')).toBe(true);
  });

  it('never claims Meesho couriers or short junk', () => {
    expect(isKnownNonMeeshoTracking('VL0085600380655')).toBe(false);
    expect(isKnownNonMeeshoTracking('1490841944808263')).toBe(false);
    expect(isKnownNonMeeshoTracking('SF4178840390MFO')).toBe(false);
    expect(isKnownNonMeeshoTracking('FMP1')).toBe(false);
    expect(isKnownNonMeeshoTracking(null)).toBe(false);
  });
});
