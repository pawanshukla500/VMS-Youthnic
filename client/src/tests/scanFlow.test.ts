import { describe, it, expect } from 'vitest';
import {
  normalizeScannedId,
  isDuplicateScan,
  isMeeshoMarketplace,
  isFlyerBarcode,
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

  it('treats a flyer bag as a wrong scan (flyer scan removed) and gives a readable reason for junk', () => {
    // A habit scan of the bag must never start / stop a recording.
    const flyer = classifyScan('tp4ooeu1234');
    expect(flyer).toMatchObject({ kind: 'invalid', code: 'TP4OOEU1234' });
    expect(flyer.kind === 'invalid' && flyer.reason).toContain('flyer bag');
    expect(classifyScan('PKT99887766').kind).toBe('invalid');
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

describe('flyer bag barcodes (refused as wrong scans)', () => {
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
