// Gmail API transport for Ajio WFR mails (OAuth 2.0, Workspace Internal app).
//
// The mailbox owner clicks "Connect Gmail" once on the Ajio page; the auth
// code is exchanged for a long-lived refresh token stored per organization
// (ajio_gmail_tokens). Internal-type clients never expire and skip
// verification. The App Password transport (mailbox.ts) stays as the fallback
// for orgs without connected tokens.
//
// Google calls go through plain REST (same style as drive.ts) so every unit
// stays fetch-mockable; google-auth-library only mints URLs and tokens.
import { randomBytes } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import type { Pool } from 'pg';
import { AJIO_SENDER, stripHtml } from './parser';
import {
  buildReplyAllRecipients,
  type CctvMail,
  type CctvMailbox,
  type CctvOriginal,
  type ReplyReceipt,
} from './mailbox';

// gmail.modify is the single superset scope the job needs: read + send +
// label changes (mark-as-read). readonly+send looked sufficient but modify
// calls 403 without it — grants from before this change must reconnect.
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

// True when a stored grant covers read + send + modify (either the single
// modify scope or the legacy readonly+send pair — the pair still can't mark
// read, so only modify counts as sufficient).
export function gmailScopesSufficient(scopes: string | null | undefined): boolean {
  const list = (scopes || '').split(/\s+/);
  return list.includes('https://www.googleapis.com/auth/gmail.modify');
}

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';

// Must byte-match an Authorized redirect URI on the OAuth client, or Google
// refuses the exchange. Override only for non-production environments.
export const DEFAULT_GMAIL_REDIRECT_URI =
  'https://vms.youthnic.shop/api/admin/ajio-gmail/callback';

export function gmailRedirectUri(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.AJIO_GMAIL_REDIRECT_URI || '').trim();
  if (override) return override.replace(/\/+$/, '');
  return DEFAULT_GMAIL_REDIRECT_URI;
}

export function gmailAppOrigin(env: NodeJS.ProcessEnv = process.env): string {
  try {
    return new URL(gmailRedirectUri(env)).origin;
  } catch {
    return 'https://vms.youthnic.shop';
  }
}

export interface GmailOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export function gmailOAuthConfigured(env: NodeJS.ProcessEnv = process.env): GmailOAuthConfig | null {
  const clientId = (env.AJIO_GMAIL_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = (env.AJIO_GMAIL_OAUTH_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function createGmailOAuthClient(
  config: GmailOAuthConfig,
  env: NodeJS.ProcessEnv = process.env
): OAuth2Client {
  return new OAuth2Client(config.clientId, config.clientSecret, gmailRedirectUri(env));
}

export function buildGmailAuthUrl(client: OAuth2Client, state: string): string {
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_SCOPES,
    state,
  });
}

// One-shot connect states (state -> organization). Single Node process by
// deployment, same tradeoff as the desktop-download tickets: a restart only
// invalidates outstanding <10min connect attempts.
const connectStates = new Map<string, { organizationId: string; expiresAt: number }>();

export function createConnectState(organizationId: string, ttlMs = 10 * 60 * 1000): string {
  const state = randomBytes(32).toString('hex');
  connectStates.set(state, { organizationId, expiresAt: Date.now() + ttlMs });
  return state;
}

export function consumeConnectState(state: string): string | null {
  const key = String(state || '');
  const entry = connectStates.get(key);
  if (entry) connectStates.delete(key);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.organizationId;
}

export interface StoredGmailTokens {
  email: string;
  refreshToken: string;
  accessToken: string | null;
  accessExpiry: string | null;
  scopes: string | null;
}

export async function saveGmailTokens(
  pool: Pool,
  organizationId: string,
  tokens: StoredGmailTokens
): Promise<void> {
  await pool.query(
    `INSERT INTO ajio_gmail_tokens (organization_id, email, refresh_token, access_token, access_expiry, scopes, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (organization_id) DO UPDATE SET
       email = EXCLUDED.email, refresh_token = EXCLUDED.refresh_token,
       access_token = EXCLUDED.access_token, access_expiry = EXCLUDED.access_expiry,
       scopes = EXCLUDED.scopes, updated_at = NOW()`,
    [organizationId, tokens.email, tokens.refreshToken, tokens.accessToken, tokens.accessExpiry, tokens.scopes]
  );
}

export async function getGmailTokens(pool: Pool, organizationId: string): Promise<StoredGmailTokens | null> {
  const res = await pool.query(
    `SELECT email, refresh_token, access_token, access_expiry, scopes
     FROM ajio_gmail_tokens WHERE organization_id = $1`,
    [organizationId]
  );
  const row = res.rows[0] as
    | { email?: string; refresh_token?: string; access_token?: string | null; access_expiry?: string | Date | null; scopes?: string | null }
    | undefined;
  if (!row || !row.refresh_token) return null;
  return {
    email: row.email || '',
    refreshToken: row.refresh_token,
    accessToken: row.access_token || null,
    accessExpiry: row.access_expiry ? new Date(row.access_expiry).toISOString() : null,
    scopes: row.scopes || null,
  };
}

export async function deleteGmailTokens(pool: Pool, organizationId: string): Promise<void> {
  await pool.query(`DELETE FROM ajio_gmail_tokens WHERE organization_id = $1`, [organizationId]);
}

export async function exchangeGmailCode(
  client: OAuth2Client,
  code: string
): Promise<{ refreshToken: string | null | undefined; accessToken: string | null | undefined; accessExpiry: string | null; scopes: string | null }> {
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token) throw new Error('Google returned no access token');
  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    accessExpiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    scopes: Array.isArray(tokens.scope) ? tokens.scope.join(' ') : tokens.scope || null,
  };
}

export async function fetchGmailProfile(
  accessToken: string,
  fetchFn: typeof fetch = fetch
): Promise<{ email: string }> {
  const res = await fetchFn(`${GMAIL_API_BASE}/users/me/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail profile lookup failed (${res.status})`);
  const data = (await res.json()) as { emailAddress?: string };
  if (!data.emailAddress) throw new Error('Gmail profile has no address');
  return { email: data.emailAddress };
}

// --- Gmail payload decoding (pure, unit-tested) ---

export function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

export function encodeBase64Url(raw: string): string {
  return Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailPayload {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPayload[];
}

export function gmailHeaderValue(headers: GmailHeader[] | undefined, name: string): string {
  const found = (headers || []).find((h) => (h.name || '').toLowerCase() === name.toLowerCase());
  return found?.value || '';
}

// Header values carry display names ("Seller" <a@b.com>, ...); the parser and
// reply-all logic only want bare addresses.
export function extractEmailAddresses(value: string): string[] {
  const matches = String(value || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
  return matches || [];
}

// Walk nested multiparts; first text/plain wins for parsing, first text/html
// is kept so the parser's HTML fallback still applies. Pure and unit-tested.
export function extractGmailBody(payload: GmailPayload | null | undefined): { text: string; html: string } {
  let text = '';
  let html = '';
  const visit = (part: GmailPayload | null | undefined): void => {
    if (!part) return;
    const mime = (part.mimeType || '').toLowerCase();
    const data = part.body?.data;
    if (mime.startsWith('text/plain') && !text && data) text = decodeBase64Url(data);
    else if (mime.startsWith('text/html') && !html && data) html = decodeBase64Url(data);
    for (const sub of part.parts || []) visit(sub);
  };
  visit(payload);
  return { text: text.trim(), html };
}

export function gmailMessageToMail(detail: {
  id?: string;
  threadId?: string;
  payload?: GmailPayload;
}): CctvMail {
  const headers = detail.payload?.headers || [];
  const { text, html } = extractGmailBody(detail.payload);
  return {
    uid: detail.id || '',
    threadId: detail.threadId || null,
    messageId: gmailHeaderValue(headers, 'Message-ID') || null,
    subject: gmailHeaderValue(headers, 'Subject'),
    from: extractEmailAddresses(gmailHeaderValue(headers, 'From'))[0] || '',
    toAddrs: extractEmailAddresses(gmailHeaderValue(headers, 'To')),
    ccAddrs: extractEmailAddresses(gmailHeaderValue(headers, 'Cc')),
    date: gmailHeaderValue(headers, 'Date') || null,
    bodyText: text || stripHtml(html),
  };
}

// Minimal RFC822 for a same-thread reply: unchanged subject plus
// In-Reply-To/References so Gmail (and Ajio) thread it. With an HTML twin it
// becomes multipart/alternative (plain first, HTML second); without, the
// original single-part text. Pure, unit-tested.
export function buildReplyMime(input: {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  textBody: string;
  htmlBody?: string | null;
  inReplyTo: string | null;
}): string {
  const head = [
    `From: ${input.from}`,
    `To: ${input.to.join(', ')}`,
    ...(input.cc.length > 0 ? [`Cc: ${input.cc.join(', ')}`] : []),
    `Subject: ${input.subject}`,
    'MIME-Version: 1.0',
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`] : []),
  ];
  if (!input.htmlBody) {
    return [...head, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 7bit', '', input.textBody].join('\r\n');
  }
  const boundary = `vms_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return [
    ...head,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    input.textBody,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    input.htmlBody,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

// CCTV requests from Ajio plus any trial senders. No read-state filter by
// default: an opened (read) trial mail must still validate, and the ledger
// already dedupes (done rows skip, missing/failed rows retry — a
// late-uploaded video heals itself on the next run). unreadOnly narrows to
// fresh mail for the unread-first pass. Pure and unit-tested.
export function buildCctvQuery(allowedSenders: string[], unreadOnly = false): string {
  const senders = allowedSenders.filter((s) => s.includes('@'));
  const fromScope = senders.length > 1 ? `from:{${senders.join(' ')}}` : `from:${senders[0] || AJIO_SENDER}`;
  return `${fromScope} subject:"CCTV FOOTAGE REQUIRED"${unreadOnly ? ' is:unread' : ''}`;
}

// The sent message as Gmail holds it: recipients, subject, send timestamp.
// Pure and unit-tested — this is the dispute-proof record filed per reply.
export function sentMessageToReceipt(detail: {
  id?: string;
  threadId?: string;
  internalDate?: string;
  payload?: GmailPayload;
}): ReplyReceipt {
  const headers = detail.payload?.headers || [];
  const internalMs = detail.internalDate ? Number(detail.internalDate) : NaN;
  return {
    providerMessageId: detail.id || null,
    threadId: detail.threadId || null,
    toAddrs: extractEmailAddresses(gmailHeaderValue(headers, 'To')),
    subject: gmailHeaderValue(headers, 'Subject') || null,
    sentAt: Number.isFinite(internalMs) && internalMs > 0 ? new Date(internalMs) : null,
  };
}

// --- Gmail API mailbox (same CctvMailbox contract as the IMAP transport) ---

export interface GmailApiMailboxDeps {
  pool: Pool;
  organizationId: string;
  oauth: GmailOAuthConfig;
  address: string;
  allowedSenders: string[];
  fetchFn?: typeof fetch;
}

export class GmailApiMailbox implements CctvMailbox {
  constructor(private readonly deps: GmailApiMailboxDeps) {}

  private fetchFn(): typeof fetch {
    return this.deps.fetchFn || fetch;
  }

  private async accessToken(forceRefresh: boolean): Promise<string> {
    const stored = await getGmailTokens(this.deps.pool, this.deps.organizationId);
    if (!stored?.refreshToken) {
      throw new Error('Gmail is not connected for this organization (open the Ajio page and click Connect Gmail)');
    }
    const fresh =
      !forceRefresh &&
      !!stored.accessToken &&
      !!stored.accessExpiry &&
      Date.parse(stored.accessExpiry) - Date.now() > 60000;
    if (fresh && stored.accessToken) return stored.accessToken;
    const client = createGmailOAuthClient(this.deps.oauth);
    client.setCredentials({ refresh_token: stored.refreshToken });
    let credentials;
    try {
      ({ credentials } = await client.refreshAccessToken());
    } catch (err) {
      // Google rejects dead grants (revoked access, rotated password,
      // tester-mode expiry, …) with terse codes like `invalid_grant` that
      // tell the nightly cron nothing. Translate once, loudly.
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Gmail grant for ${stored.email || 'the connected mailbox'} was rejected by Google (${detail}). Open the Ajio page and click Connect Gmail again`
      );
    }
    if (!credentials.access_token) {
      throw new Error('Gmail token refresh failed (open the Ajio page and reconnect Gmail)');
    }
    await saveGmailTokens(this.deps.pool, this.deps.organizationId, {
      email: stored.email,
      refreshToken: stored.refreshToken,
      accessToken: credentials.access_token,
      accessExpiry: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null,
      scopes: stored.scopes,
    });
    return credentials.access_token;
  }

  // One transparent retry on 401 (token revoked/rotated elsewhere): refresh
  // once, then fail loudly so the ledger shows it instead of half-working.
  private async api(path: string, init: RequestInit = {}): Promise<any> {
    const call = async (token: string) =>
      this.fetchFn()(`${GMAIL_API_BASE}${path}`, {
        ...init,
        headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
      });
    let res = await call(await this.accessToken(false));
    if (res.status === 401) res = await call(await this.accessToken(true));
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gmail API ${res.status} on ${path.split('?')[0]}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  async listCctvRequests(limit = 10): Promise<CctvMail[]> {
    const take = Math.max(1, Math.min(limit, 50));
    const senders = this.deps.allowedSenders.length > 0 ? this.deps.allowedSenders : [AJIO_SENDER];
    // Fresh disputes first, then already-read mail (retries + opened trials):
    // Gmail returns newest-first, so a deep backlog would otherwise starve
    // new arrivals outside the window.
    const seen = new Set<string>();
    const mails: CctvMail[] = [];
    for (const unreadOnly of [true, false]) {
      if (mails.length >= take) break;
      const q = buildCctvQuery(senders, unreadOnly);
      const list = await this.api(`/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${take}`);
      const ids = ((list.messages || []) as { id?: string }[])
        .map((m) => m.id || '')
        .filter((id) => id && !seen.has(id));
      for (const id of ids) {
        if (mails.length >= take) break;
        seen.add(id);
        const detail = await this.api(`/users/me/messages/${encodeURIComponent(id)}?format=full`);
        const mail = gmailMessageToMail(detail);
        if (mail.uid) mails.push(mail);
      }
    }
    return mails;
  }

  async markReplied(uid: string): Promise<void> {
    await this.api(`/users/me/messages/${encodeURIComponent(uid)}/modify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
    });
  }

  async replyAll(original: CctvOriginal, subject: string, textBody: string, htmlBody?: string | null): Promise<ReplyReceipt | null> {
    if (!this.deps.address) throw new Error('Connected Gmail address is unknown (reconnect Gmail on the Ajio page)');
    const { to, cc } = buildReplyAllRecipients(original, this.deps.address);
    if (to.length === 0) {
      throw new Error(
        `No reply recipients on the original mail (from=${original.from || '?'}, to=${(original.toAddrs || []).length}, cc=${(original.ccAddrs || []).length})`
      );
    }
    const raw = encodeBase64Url(
      buildReplyMime({
        from: this.deps.address,
        to,
        cc,
        subject,
        textBody,
        htmlBody: htmlBody || null,
        inReplyTo: original.messageId,
      })
    );
    const payload: Record<string, unknown> = { raw };
    if (original.threadId) payload.threadId = original.threadId;
    const sendRes = (await this.api('/users/me/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })) as { id?: string; threadId?: string };
    // File the sent message itself as proof (recipients, timestamp).
    // Best-effort: the reply already went out, so a fetch miss here must
    // never fail the row.
    try {
      if (sendRes.id) {
        const detail = await this.api(`/users/me/messages/${encodeURIComponent(sendRes.id)}?format=full`);
        return sentMessageToReceipt(detail);
      }
    } catch (err) {
      console.error('Ajio sent-proof fetch failed (non-fatal):', err instanceof Error ? err.message : err);
    }
    return {
      providerMessageId: sendRes.id || null,
      threadId: (sendRes.threadId || original.threadId) || null,
      toAddrs: to,
      subject,
      sentAt: null,
    };
  }
}
