import { describe, it, expect } from 'vitest';
import { sanitizeDriveFilename, buildReplySubject, buildReplyBody } from '../ajio/template';

describe('sanitizeDriveFilename', () => {
  it('names the file by order id only', () => {
    expect(sanitizeDriveFilename('FN8482808184')).toBe('FN8482808184.mp4');
    expect(sanitizeDriveFilename('  FN/8482 808184 ')).toBe('FN_8482_808184.mp4');
    expect(sanitizeDriveFilename('')).toBe('packing-video.mp4');
  });
});

describe('buildReplySubject', () => {
  it('keeps the subject line exactly unchanged', () => {
    const subject = 'CCTV FOOTAGE REQUIRED||INC00112744229||RT228723195||DV00352060';
    expect(buildReplySubject(subject)).toBe(subject);
  });
});

describe('buildReplyBody', () => {
  it('covers every template field Ajio asked for', () => {
    const body = buildReplyBody({
      incidentId: 'INC00112744229',
      orderId: 'FN8482808184',
      shipmentId: '1241686367',
      referenceValue: 'RT228723195',
      packingTimeText: '09-03-2026 11:09:22 IST',
      driveLink: 'https://drive.google.com/file/d/abc/view',
      fileName: 'FN8482808184.mp4',
      senderName: 'Youthnic Packing (VMS)',
    });
    for (const needle of [
      'INC00112744229',
      'FN8482808184',
      '1241686367',
      'RT228723195',
      'https://drive.google.com/file/d/abc/view',
      'FN8482808184.mp4',
      'subject line has been kept unchanged',
    ]) {
      expect(body).toContain(needle);
    }
  });
});
