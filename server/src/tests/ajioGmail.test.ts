import { describe, it, expect } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import {
  gmailOAuthConfigured,
  gmailRedirectUri,
  buildGmailAuthUrl,
  createConnectState,
  consumeConnectState,
  decodeBase64Url,
  encodeBase64Url,
  gmailHeaderValue,
  extractEmailAddresses,
  extractGmailBody,
  gmailMessageToMail,
  buildReplyMime,
  DEFAULT_GMAIL_REDIRECT_URI,
} from '../ajio/gmailApi';

const b64url = (s: string) =>
  Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('gmailOAuthConfigured', () => {
  it('needs client id plus secret', () => {
    expect(
      gmailOAuthConfigured({ AJIO_GMAIL_OAUTH_CLIENT_ID: 'id', AJIO_GMAIL_OAUTH_CLIENT_SECRET: 'sec' } as any)
    ).toMatchObject({ clientId: 'id', clientSecret: 'sec' });
    expect(gmailOAuthConfigured({} as any)).toBeNull();
    expect(gmailOAuthConfigured({ AJIO_GMAIL_OAUTH_CLIENT_ID: 'id' } as any)).toBeNull();
  });
});

describe('gmailRedirectUri', () => {
  it('defaults to the registered production callback', () => {
    expect(gmailRedirectUri({} as any)).toBe(DEFAULT_GMAIL_REDIRECT_URI);
    expect(gmailRedirectUri({} as any)).toBe('https://vms.youthnic.shop/api/admin/ajio-gmail/callback');
  });

  it('honours an explicit override', () => {
    expect(gmailRedirectUri({ AJIO_GMAIL_REDIRECT_URI: 'https://dev.local/cb/' } as any)).toBe(
      'https://dev.local/cb'
    );
  });
});

describe('buildGmailAuthUrl', () => {
  it('requests offline access with both Gmail scopes and the state', () => {
    const client = new OAuth2Client('test-id', 'test-secret', DEFAULT_GMAIL_REDIRECT_URI);
    const url = new URL(buildGmailAuthUrl(client, 'state-123'));
    expect(url.hostname).toBe('accounts.google.com');
    expect(url.searchParams.get('client_id')).toBe('test-id');
    expect(url.searchParams.get('redirect_uri')).toBe(DEFAULT_GMAIL_REDIRECT_URI);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('scope') || '').toContain('gmail.readonly');
    expect(url.searchParams.get('scope') || '').toContain('gmail.send');
  });
});

describe('connect state', () => {
  it('round-trips once, then is gone', () => {
    const state = createConnectState('org-1');
    expect(consumeConnectState(state)).toBe('org-1');
    expect(consumeConnectState(state)).toBeNull();
  });

  it('rejects unknown and expired states', () => {
    expect(consumeConnectState('nope')).toBeNull();
    expect(consumeConnectState(createConnectState('org-2', -1))).toBeNull();
  });
});

describe('base64url helpers', () => {
  it('round-trips unicode without padding', () => {
    const raw = 'Order Müller FN8482808184 ✓';
    const encoded = encodeBase64Url(raw);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(decodeBase64Url(encoded)).toBe(raw);
  });
});

describe('gmailHeaderValue + extractEmailAddresses', () => {
  const headers = [
    { name: 'Subject', value: 'CCTV FOOTAGE REQUIRED||INC1||RT1' },
    { name: 'FROM', value: '"Ajio Seller" <seller.communication@ajio.com>' },
  ];

  it('matches header names case-insensitively', () => {
    expect(gmailHeaderValue(headers, 'subject')).toContain('CCTV');
    expect(gmailHeaderValue(headers, 'from')).toContain('ajio.com');
    expect(gmailHeaderValue(headers, 'Message-ID')).toBe('');
  });

  it('strips display names down to bare addresses', () => {
    expect(extractEmailAddresses('"Ajio Seller" <seller.communication@ajio.com>, cc@shop.com')).toEqual([
      'seller.communication@ajio.com',
      'cc@shop.com',
    ]);
    expect(extractEmailAddresses('no-address-here')).toEqual([]);
  });
});

describe('extractGmailBody', () => {
  const plain = 'Order ID: FN8482808184';
  const html = '<div>Order ID: FN8482808184</div>';
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/html', body: { data: b64url(html) } },
      { mimeType: 'text/plain', body: { data: b64url(plain) } },
    ],
  };

  it('prefers the plain part even when it comes second', () => {
    const { text } = extractGmailBody(payload);
    expect(text).toBe(plain);
  });

  it('falls back to html when no plain part exists', () => {
    const { text, html: htmlOut } = extractGmailBody({
      mimeType: 'multipart/mixed',
      parts: [{ mimeType: 'text/html', body: { data: b64url(html) } }],
    });
    expect(text).toBe('');
    expect(htmlOut).toContain('FN8482808184');
  });

  it('walks nested multiparts', () => {
    const { text } = extractGmailBody({
      mimeType: 'multipart/mixed',
      parts: [{ mimeType: 'multipart/related', parts: [{ mimeType: 'text/plain', body: { data: b64url(plain) } }] }],
    });
    expect(text).toBe(plain);
  });
});

describe('gmailMessageToMail', () => {
  it('maps a Gmail full message onto the CctvMail contract', () => {
    const mail = gmailMessageToMail({
      id: 'msg-1',
      threadId: 'thread-1',
      payload: {
        mimeType: 'multipart/alternative',
        headers: [
          { name: 'Subject', value: 'CCTV FOOTAGE REQUIRED||INC1||RT1' },
          { name: 'From', value: 'seller.communication@ajio.com' },
          { name: 'To', value: 'returnorders@vbexports.co.in, other@vbexports.co.in' },
          { name: 'Cc', value: 'boss@vbexports.co.in' },
          { name: 'Date', value: 'Thu, 10 Sep 2026 10:00:00 +0530' },
          { name: 'Message-ID', value: '<abc123@mail.gmail.com>' },
        ],
        parts: [{ mimeType: 'text/plain', body: { data: b64url('Order ID: FN8482808184') } }],
      },
    });
    expect(mail.uid).toBe('msg-1');
    expect(mail.threadId).toBe('thread-1');
    expect(mail.messageId).toBe('<abc123@mail.gmail.com>');
    expect(mail.subject).toContain('CCTV FOOTAGE REQUIRED');
    expect(mail.from).toBe('seller.communication@ajio.com');
    expect(mail.toAddrs).toEqual(['returnorders@vbexports.co.in', 'other@vbexports.co.in']);
    expect(mail.ccAddrs).toEqual(['boss@vbexports.co.in']);
    expect(mail.bodyText).toContain('FN8482808184');
  });
});

describe('buildReplyMime', () => {
  it('keeps threading headers and the unchanged subject', () => {
    const mime = buildReplyMime({
      from: 'returnorders@vbexports.co.in',
      to: ['seller.communication@ajio.com'],
      cc: ['boss@vbexports.co.in'],
      subject: 'CCTV FOOTAGE REQUIRED||INC1||RT1',
      textBody: 'Hi Team,',
      inReplyTo: '<abc123@mail.gmail.com>',
    });
    expect(mime).toContain('From: returnorders@vbexports.co.in');
    expect(mime).toContain('To: seller.communication@ajio.com');
    expect(mime).toContain('Cc: boss@vbexports.co.in');
    expect(mime).toContain('Subject: CCTV FOOTAGE REQUIRED||INC1||RT1');
    expect(mime).toContain('In-Reply-To: <abc123@mail.gmail.com>');
    expect(mime).toContain('References: <abc123@mail.gmail.com>');
  });

  it('omits empty Cc and missing threading headers', () => {
    const mime = buildReplyMime({
      from: 'a@b.com',
      to: ['c@d.com'],
      cc: [],
      subject: 's',
      textBody: 'b',
      inReplyTo: null,
    });
    expect(mime).not.toContain('Cc:');
    expect(mime).not.toContain('In-Reply-To:');
  });
});
