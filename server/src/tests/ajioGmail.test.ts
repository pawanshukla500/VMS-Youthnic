import { describe, it, expect, vi, afterEach } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import {
  GmailApiMailbox,
  GMAIL_SCOPES,
  gmailOAuthConfigured,
  gmailRedirectUri,
  buildGmailAuthUrl,
  gmailScopesSufficient,
  buildCctvQuery,
  createConnectState,
  consumeConnectState,
  decodeBase64Url,
  encodeBase64Url,
  gmailHeaderValue,
  extractEmailAddresses,
  extractGmailBody,
  gmailMessageToMail,
  sentMessageToReceipt,
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

describe('sentMessageToReceipt', () => {
  it('files recipients, subject, and send time from the sent message', () => {
    const receipt = sentMessageToReceipt({
      id: 'sent-1',
      threadId: 'thread-1',
      internalDate: '1789055520000',
      payload: {
        headers: [
          { name: 'To', value: 'seller.communication@ajio.com' },
          { name: 'Subject', value: 'CCTV FOOTAGE REQUIRED||INC1' },
        ],
      },
    });
    expect(receipt).toMatchObject({
      providerMessageId: 'sent-1',
      threadId: 'thread-1',
      toAddrs: ['seller.communication@ajio.com'],
      subject: 'CCTV FOOTAGE REQUIRED||INC1',
    });
    expect(receipt.sentAt?.toISOString()).toBe(new Date(1789055520000).toISOString());
  });

  it('tolerates a bare send response', () => {
    expect(sentMessageToReceipt({ id: 'sent-2' })).toMatchObject({
      providerMessageId: 'sent-2',
      toAddrs: [],
      subject: null,
      sentAt: null,
    });
  });
});

describe('buildGmailAuthUrl', () => {
  it('requests offline access with the modify scope and the state', () => {
    const client = new OAuth2Client('test-id', 'test-secret', DEFAULT_GMAIL_REDIRECT_URI);
    const url = new URL(buildGmailAuthUrl(client, 'state-123'));
    expect(url.hostname).toBe('accounts.google.com');
    expect(url.searchParams.get('client_id')).toBe('test-id');
    expect(url.searchParams.get('redirect_uri')).toBe(DEFAULT_GMAIL_REDIRECT_URI);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('state-123');
    // Single superset scope: read + send + label changes (mark-as-read).
    expect(url.searchParams.get('scope') || '').toContain('gmail.modify');
  });
});

describe('gmailScopesSufficient', () => {
  it('needs the modify scope (readonly+send 403s on mark-as-read)', () => {
    expect(gmailScopesSufficient('https://www.googleapis.com/auth/gmail.modify')).toBe(true);
    expect(
      gmailScopesSufficient(
        'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'
      )
    ).toBe(false);
    expect(gmailScopesSufficient(null)).toBe(false);
    expect(gmailScopesSufficient('')).toBe(false);
  });
});

describe('buildCctvQuery', () => {
  it('scopes to Ajio alone by default', () => {
    expect(buildCctvQuery(['seller.communication@ajio.com'])).toBe(
      'from:seller.communication@ajio.com subject:"CCTV FOOTAGE REQUIRED"'
    );
  });

  it('ORs trial senders into the from-scope', () => {
    expect(buildCctvQuery(['seller.communication@ajio.com', 'returnorders@vbexports.co.in'])).toBe(
      'from:{seller.communication@ajio.com returnorders@vbexports.co.in} subject:"CCTV FOOTAGE REQUIRED"'
    );
  });

  it('never filters by read state (opened trials must validate)', () => {
    expect(buildCctvQuery(['seller.communication@ajio.com'])).not.toContain('unread');
    expect(buildCctvQuery([])).toContain('from:seller.communication@ajio.com');
  });

  it('narrows to fresh mail for the unread-first pass', () => {
    expect(buildCctvQuery(['seller.communication@ajio.com'], true)).toBe(
      'from:seller.communication@ajio.com subject:"CCTV FOOTAGE REQUIRED" is:unread'
    );
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

  it('builds multipart/alternative when an HTML twin is provided', () => {
    const mime = buildReplyMime({
      from: 'a@b.com',
      to: ['c@d.com'],
      cc: [],
      subject: 's',
      textBody: 'plain part',
      htmlBody: '<p>html part</p>',
      inReplyTo: '<id@mail>',
    });
    expect(mime).toContain('multipart/alternative');
    expect(mime).toContain('plain part');
    expect(mime).toContain('<p>html part</p>');
    expect(mime).toContain('In-Reply-To: <id@mail>');
  });
});

describe('GmailApiMailbox token refresh', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps a Google-rejected grant to a reconnect action', async () => {
    const pool = {
      query: async () => ({
        rows: [
          {
            email: 'seller@mailbox.com',
            refresh_token: 'dead-grant',
            access_token: null,
            access_expiry: null,
            scopes: GMAIL_SCOPES.join(' '),
          },
        ],
      }),
    } as any;
    vi.spyOn(OAuth2Client.prototype, 'refreshAccessToken').mockRejectedValue(new Error('invalid_grant'));
    const mailbox = new GmailApiMailbox({
      pool,
      organizationId: 'org-1',
      oauth: { clientId: 'id', clientSecret: 'sec' },
      address: 'seller@mailbox.com',
      allowedSenders: [],
    });
    await expect(mailbox.listCctvRequests(1)).rejects.toThrow(/Connect Gmail again/);
    await expect(mailbox.listCctvRequests(1)).rejects.toThrow(/invalid_grant/);
  });
});
