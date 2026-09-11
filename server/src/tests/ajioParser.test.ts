import { describe, it, expect } from 'vitest';
import { parseCctvMail, parsePackingTime, parseMailDate, stripHtml, allowedMailSenders } from '../ajio/parser';

const MAIL_1 = {
  subject: 'CCTV FOOTAGE REQUIRED||INC00112744229||RT228723195||DV00352060',
  from: 'seller.communication@ajio.com',
  bodyText: `Ticket No:INC00112744229
Hi Team,
Please share the packing footage for the attached list of orders.
This is your ticket ID for future reference: INC00112744229
Incident ID: INC00112744229 Order ID: FN8482808184 Variant: 701963821019 Complaint Type: Wrong Return Reference Value:
RT228723195 Shipment ID: 1241686367 Packing Time:
09-03-2026
11:09:22
Please Note: Share the requested CCTV footage by replying to the original email thread using "Reply all," saving files with only the ORDER ID (no special characters or space) and keeping the subject line unchanged.
Regards,
Team AJIO`,
};

const MAIL_2_HTML = `<div>Ticket No:INC00112507613</div><table><tr><td>Incident ID: INC00112507613</td><td>Order ID: FN3282804773</td><td>Variant: 702340348007</td><td>Complaint Type: Wrong Return</td><td>Reference Value: RT228456896</td><td>Shipment ID: 1237492787</td><td>Packing Time: 8/21/2026 10:53:13 AM</td></tr></table>`;

describe('parseCctvMail', () => {
  it('parses the first real mail (text body, multiline values)', () => {
    const result = parseCctvMail(MAIL_1);
    expect(result.kind).toBe('wfr');
    if (result.kind !== 'wfr') throw new Error('expected wfr');
    expect(result.request.incidentId).toBe('INC00112744229');
    expect(result.request.orderId).toBe('FN8482808184');
    expect(result.request.shipmentId).toBe('1241686367');
    expect(result.request.referenceValue).toBe('RT228723195');
    expect(result.request.variant).toBe('701963821019');
    expect(result.request.complaintType).toBe('Wrong Return');
    expect(result.request.packingTimeMs).toBe(Date.UTC(2026, 2, 9, 11, 9, 22) - 5.5 * 3600 * 1000);
  });

  it('parses the second real mail (HTML body, US date)', () => {
    const result = parseCctvMail({
      subject: 'CCTV FOOTAGE REQUIRED||INC00112507613||RT228456896||DV00352060',
      from: 'seller.communication@ajio.com',
      bodyHtml: MAIL_2_HTML,
    });
    expect(result.kind).toBe('wfr');
    if (result.kind !== 'wfr') throw new Error('expected wfr');
    expect(result.request.incidentId).toBe('INC00112507613');
    expect(result.request.orderId).toBe('FN3282804773');
    expect(result.request.shipmentId).toBe('1237492787');
    expect(result.request.referenceValue).toBe('RT228456896');
    expect(result.request.packingTimeMs).toBe(Date.UTC(2026, 7, 21, 10, 53, 13) - 5.5 * 3600 * 1000);
  });

  it('skips non-WFR mail and wrong senders', () => {
    expect(parseCctvMail({ subject: 'Your invoice is ready', bodyText: 'hi' })).toMatchObject({ kind: 'skip' });
    expect(parseCctvMail({ subject: MAIL_1.subject, from: 'spam@evil.com', bodyText: MAIL_1.bodyText })).toMatchObject({
      kind: 'skip',
      reason: 'unexpected sender',
    });
  });

  it('parses labels wrapped across lines by Gmail table linearization', () => {
    const result = parseCctvMail({
      subject: MAIL_1.subject,
      from: 'seller.communication@ajio.com',
      bodyText: `Ticket No:INC00112744229
Incident ID: INC00112744229 Order ID: FN8482808184 Variant: 701963821019
Complaint Type: Wrong Return Reference
Value: RT228723195 Shipment
ID: 1241686367 Packing
Time: 09-03-2026
11:09:22
Please Note: reply using "Reply all".`,
    });
    expect(result.kind).toBe('wfr');
    if (result.kind !== 'wfr') throw new Error('expected wfr');
    expect(result.request.orderId).toBe('FN8482808184');
    expect(result.request.shipmentId).toBe('1241686367');
    expect(result.request.referenceValue).toBe('RT228723195');
    expect(result.request.packingTimeMs).toBe(Date.UTC(2026, 2, 9, 11, 9, 22) - 5.5 * 3600 * 1000);
  });

  it('skips when no Order ID can be found', () => {
    expect(
      parseCctvMail({ subject: MAIL_1.subject, from: 'seller.communication@ajio.com', bodyText: 'no ids here' })
    ).toMatchObject({ kind: 'skip' });
  });

  it('accepts trial mails from allowlisted senders only', () => {
    const trial = { subject: MAIL_1.subject, from: 'returnorders@vbexports.co.in', bodyText: MAIL_1.bodyText };
    expect(parseCctvMail(trial)).toMatchObject({ kind: 'skip', reason: 'unexpected sender' });
    const result = parseCctvMail(trial, {
      allowedSenders: ['seller.communication@ajio.com', 'returnorders@vbexports.co.in'],
    });
    expect(result.kind).toBe('wfr');
    if (result.kind !== 'wfr') throw new Error('expected wfr');
    expect(result.request.orderId).toBe('FN8482808184');
  });
});

describe('allowedMailSenders', () => {
  it('is Ajio-only by default and merges the test CSV', () => {
    expect(allowedMailSenders({} as any)).toEqual(['seller.communication@ajio.com']);
    expect(
      allowedMailSenders({ AJIO_TEST_SENDERS: 'returnorders@vbexports.co.in, Other@Shop.com ' } as any)
    ).toEqual(['seller.communication@ajio.com', 'returnorders@vbexports.co.in', 'other@shop.com']);
    expect(allowedMailSenders({ AJIO_TEST_SENDERS: 'not-an-address' } as any)).toEqual([
      'seller.communication@ajio.com',
    ]);
  });
});

describe('stripHtml', () => {
  it('reduces tables to spaced text', () => {
    expect(stripHtml('<td>a</td><td>b</td><br>')).toContain('a');
    expect(stripHtml('<td>a</td><td>b</td><br>')).toContain('b');
  });
});

describe('parsePackingTime', () => {
  it('returns null for garbage', () => {
    expect(parsePackingTime(null)).toBeNull();
    expect(parsePackingTime('yesterday')).toBeNull();
  });

  it('reads dotted Indian dates', () => {
    expect(parsePackingTime('09.03.2026 11:09:22')).toBe(
      Date.UTC(2026, 2, 9, 11, 9, 22) - 5.5 * 3600 * 1000
    );
  });
});

describe('parseMailDate', () => {
  it('parses RFC2822 mail dates and rejects garbage', () => {
    expect(parseMailDate('Thu, 10 Sep 2026 20:27:00 +0530')?.toISOString()).toBe('2026-09-10T14:57:00.000Z');
    expect(parseMailDate(null)).toBeNull();
    expect(parseMailDate('not a date')).toBeNull();
  });
});
