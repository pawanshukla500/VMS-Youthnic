import { describe, it, expect } from 'vitest';
import { buildReplyAllRecipients, extractMailText, mailboxConfigured } from '../ajio/mailbox';

describe('buildReplyAllRecipients', () => {
  it('replies to sender plus original To/Cc minus ourselves', () => {
    const result = buildReplyAllRecipients(
      {
        from: 'seller.communication@ajio.com',
        toAddrs: ['nidhi@shop.com', 'seller.communication@ajio.com'],
        ccAddrs: ['boss@shop.com', 'nidhi@shop.com'],
      },
      'nidhi@shop.com'
    );
    expect(result.to).toEqual(['seller.communication@ajio.com']);
    expect(result.cc).toEqual(['boss@shop.com']);
  });

  it('throws nothing when only we remain (caller guards empty)', () => {
    expect(buildReplyAllRecipients({ from: '  ', toAddrs: [], ccAddrs: [] }, 'me@shop.com')).toEqual({ to: [], cc: [] });
  });

  it('promotes Cc when a self-sent trial leaves To empty', () => {
    expect(
      buildReplyAllRecipients(
        {
          from: 'returnorders@vbexports.co.in',
          toAddrs: ['returnorders@vbexports.co.in'],
          ccAddrs: ['seller.communication@ajio.com'],
        },
        'returnorders@vbexports.co.in'
      )
    ).toEqual({ to: ['seller.communication@ajio.com'], cc: [] });
  });
});

describe('extractMailText', () => {
  const raw = [
    'From: seller.communication@ajio.com',
    'Content-Type: multipart/alternative; boundary="XYZ"',
    '',
    '--XYZ',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Order ID: FN8482808184=0D=0Aand more',
    '--XYZ',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('<div>Order ID: FN8482808184</div>').toString('base64'),
    '--XYZ--',
    '',
  ].join('\r\n');

  it('prefers the plain part and decodes quoted-printable', () => {
    const { text } = extractMailText(raw);
    expect(text).toContain('Order ID: FN8482808184');
    expect(text).toContain('and more');
  });

  it('falls back to the base64 html part', () => {
    const htmlOnly = raw.split('--XYZ')[2] || '';
    const { text, html } = extractMailText(`Content-Type: multipart/alternative; boundary="XYZ"\r\n\r\n--XYZ${htmlOnly}--XYZ--\r\n`);
    expect(text).toBe('');
    expect(html).toContain('Order ID: FN8482808184');
  });
});

describe('mailboxConfigured', () => {
  it('needs address plus app password', () => {
    expect(mailboxConfigured({ AJIO_GMAIL_ADDRESS: 'a@b.com', AJIO_GMAIL_APP_PASSWORD: 'xxxx xxxx' } as any)).toMatchObject({
      address: 'a@b.com',
    });
    expect(mailboxConfigured({} as any)).toBeNull();
    expect(mailboxConfigured({ AJIO_GMAIL_ADDRESS: 'a@b.com' } as any)).toBeNull();
  });
});
