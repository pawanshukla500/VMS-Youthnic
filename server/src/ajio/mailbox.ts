// Gmail transport for Ajio WFR mails (IMAP read + SMTP reply).
//
// Auth is a Gmail App Password (2-Step Verification on the mailbox, then a
// 16-character app password) — no Google Cloud project, no OAuth consent
// screen, nothing to expire. Drive API access is intentionally NOT done here
// (App Passwords cannot touch Drive); see drive.ts (Service Account).
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { AJIO_SENDER, stripHtml } from './parser';

export interface MailboxConfig {
  address: string;
  appPassword: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}

export function mailboxConfigured(env: NodeJS.ProcessEnv = process.env): MailboxConfig | null {
  const address = (env.AJIO_GMAIL_ADDRESS || '').trim();
  const appPassword = (env.AJIO_GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!address || !appPassword) return null;
  return {
    address,
    appPassword,
    imapHost: (env.AJIO_IMAP_HOST || 'imap.gmail.com').trim() || 'imap.gmail.com',
    imapPort: Number(env.AJIO_IMAP_PORT || 993) || 993,
    smtpHost: (env.AJIO_SMTP_HOST || 'smtp.gmail.com').trim() || 'smtp.gmail.com',
    smtpPort: Number(env.AJIO_SMTP_PORT || 465) || 465,
  };
}

export interface CctvMail {
  uid: number;
  messageId: string | null;
  subject: string;
  from: string;
  toAddrs: string[];
  ccAddrs: string[];
  date: string | null;
  bodyText: string;
}

// Reply-all recipients: original sender first, then original To/Cc minus
// ourselves, de-duplicated. Pure so the addressing rule is unit-tested.
export function buildReplyAllRecipients(
  original: Pick<CctvMail, 'from' | 'toAddrs' | 'ccAddrs'>,
  selfAddress: string
): { to: string[]; cc: string[] } {
  const self = selfAddress.trim().toLowerCase();
  const seen = new Set<string>([self]);
  const to: string[] = [];
  const cc: string[] = [];
  const push = (list: string[], addr: unknown) => {
    if (typeof addr !== 'string') return;
    const clean = addr.trim();
    if (!clean || !clean.includes('@') || seen.has(clean.toLowerCase())) return;
    seen.add(clean.toLowerCase());
    list.push(clean);
  };
  push(to, original.from);
  for (const addr of original.toAddrs || []) push(to, addr);
  for (const addr of original.ccAddrs || []) push(cc, addr);
  return { to, cc };
}

// Minimal RFC822 text extraction from a raw source fetch: finds the first
// text/plain part (else text/html, stripped), decoding base64 and
// quoted-printable. Pure and unit-tested — no MIME library needed.
export function extractMailText(source: string): { text: string; html: string } {
  const normalized = source.replace(/\r\n/g, '\n');
  const parts = normalized.split(/^--.+$/m).slice(1);
  const decode = (body: string, encoding: string): string => {
    const enc = encoding.trim().toLowerCase();
    if (enc === 'base64') {
      try {
        return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
      } catch {
        return body;
      }
    }
    if (enc === 'quoted-printable' || enc === 'quotedprintable') {
      return body
        .replace(/=\n/g, '')
        .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
    return body;
  };
  let text = '';
  let html = '';
  const candidates = parts.length > 0 ? parts : [normalized];
  for (const part of candidates) {
    const splitAt = part.search(/\n\n/);
    const headers = (splitAt >= 0 ? part.slice(0, splitAt) : '').toLowerCase();
    const body = splitAt >= 0 ? part.slice(splitAt + 2) : part;
    const encMatch = /content-transfer-encoding\s*:\s*([^\s;]+)/i.exec(headers);
    const decoded = decode(body, encMatch ? encMatch[1] : '7bit');
    if (/content-type\s*:[^\n]*text\/plain/i.test(headers)) {
      if (!text) text = decoded.trim();
    } else if (/content-type\s*:[^\n]*text\/html/i.test(headers)) {
      if (!html) html = decoded;
    }
  }
  if (!text && !html && parts.length === 0) {
    const splitAt = normalized.search(/\n\n/);
    text = (splitAt >= 0 ? normalized.slice(splitAt + 2) : normalized).trim();
  }
  return { text: text.trim(), html };
}

function addrList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const entry of values) {
    if (typeof entry === 'string') {
      if (entry.includes('@')) out.push(entry);
    } else if (entry && typeof entry === 'object') {
      const address = (entry as { address?: unknown }).address;
      if (typeof address === 'string' && address.includes('@')) out.push(address);
    }
  }
  return out;
}

function firstString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export class GmailMailbox {
  constructor(private readonly config: MailboxConfig) {}

  private async connect(): Promise<ImapFlow> {
    const client = new ImapFlow({
      host: this.config.imapHost,
      port: this.config.imapPort,
      secure: true,
      auth: { user: this.config.address, pass: this.config.appPassword },
      logger: false,
    });
    await client.connect();
    return client;
  }

  async listCctvRequests(limit = 10): Promise<CctvMail[]> {
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search(
          { seen: false, from: AJIO_SENDER, subject: 'CCTV FOOTAGE REQUIRED' },
          { uid: true }
        );
        const mails: CctvMail[] = [];
        const take = (uids || []).slice(-Math.max(1, Math.min(limit, 50)));
        for (const uid of take) {
          const fetched: any = await client.fetchOne(String(uid), { envelope: true, source: true }, { uid: true });
          if (!fetched) continue;
          const envelope = fetched.envelope || {};
          const { text, html } = extractMailText(String(fetched.source || ''));
          mails.push({
            uid: Number(uid),
            messageId: firstString(envelope.messageId) || null,
            subject: firstString(envelope.subject),
            from: addrList(envelope.from)[0] || '',
            toAddrs: addrList(envelope.to),
            ccAddrs: addrList(envelope.cc),
            date: firstString(envelope.date) || null,
            bodyText: text || stripHtml(html),
          });
        }
        return mails;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async markReplied(uid: number): Promise<void> {
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async replyAll(
    original: Pick<CctvMail, 'from' | 'toAddrs' | 'ccAddrs' | 'subject' | 'messageId'>,
    subject: string,
    textBody: string
  ): Promise<void> {
    const { to, cc } = buildReplyAllRecipients(original, this.config.address);
    if (to.length === 0) throw new Error('No reply recipients found on the original mail');
    const transporter = nodemailer.createTransport({
      host: this.config.smtpHost,
      port: this.config.smtpPort,
      secure: this.config.smtpPort === 465,
      auth: { user: this.config.address, pass: this.config.appPassword },
    });
    await transporter.sendMail({
      from: this.config.address,
      to: to.join(', '),
      cc: cc.length > 0 ? cc.join(', ') : undefined,
      subject,
      text: textBody,
      inReplyTo: original.messageId || undefined,
      references: original.messageId || undefined,
    });
  }
}
