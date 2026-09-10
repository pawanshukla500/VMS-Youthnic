// Ajio "CCTV FOOTAGE REQUIRED" mail parser (pure, unit-tested).
//
// Real shape (seller.communication@ajio.com):
//   Subject: CCTV FOOTAGE REQUIRED||INC00112744229||RT228723195||DV00352060
//   Body: Ticket No, Order ID, Variant, Complaint Type, Reference Value,
//         Shipment ID, Packing Time (multiline values, HTML or text).
export const AJIO_SENDER = 'seller.communication@ajio.com';

// Trial mails are sent from our own mailbox (same subject, real Order ID)
// so the flow can be validated end-to-end. AJIO_TEST_SENDERS is a CSV of
// extra accepted From addresses; empty in production means Ajio-only.
export function allowedMailSenders(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.AJIO_TEST_SENDERS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes('@'));
  return [...new Set([AJIO_SENDER, ...extra])];
}

export interface AjioWfrRequest {
  incidentId: string;
  ticketNo: string | null;
  orderId: string;
  shipmentId: string | null;
  referenceValue: string | null;
  variant: string | null;
  complaintType: string | null;
  packingTimeMs: number | null;
}

export type AjioParseResult = { kind: 'wfr'; request: AjioWfrRequest } | { kind: 'skip'; reason: string };

const SUBJECT_RE = /CCTV\s+FOOTAGE\s+REQUIRED\s*\|\|\s*([A-Z0-9]+)\s*\|\|\s*([A-Z0-9]+)(?:\s*\|\|\s*([A-Z0-9]+))?/i;

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|table|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ');
}

function field(body: string, label: string): string | null {
  return firstToken(segmentAfter(body, label));
}

// Labels are located first and the value runs until the next known label —
// a plain "capture words" regex would swallow following labels when the mail
// puts several fields on one line (real Ajio mails do exactly that).
const KNOWN_LABELS = [
  'Ticket No',
  'Incident ID',
  'Order ID',
  'Variant',
  'Complaint Type',
  'Reference Value',
  'Shipment ID',
  'Packing Time',
];

function segmentAfter(body: string, label: string): string | null {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = new RegExp(esc(label) + '\\s*:?', 'i').exec(body);
  if (!start || start.index === undefined) return null;
  const rest = body.slice(start.index + start[0].length);
  let cut = rest.length;
  for (const other of KNOWN_LABELS) {
    if (other.toLowerCase() === label.toLowerCase()) continue;
    const next = new RegExp(esc(other) + '\\s*:', 'i').exec(rest);
    if (next && next.index !== undefined && next.index < cut) cut = next.index;
  }
  const value = rest.slice(0, cut).trim();
  return value || null;
}

function firstToken(value: string | null): string | null {
  if (!value) return null;
  const token = value.split(/\s+/)[0];
  return /^[A-Z0-9]+$/i.test(token) ? token : null;
}

// Packing Time arrives as "09-03-2026 11:09:22" (24h) or "8/21/2026 10:53:13 AM"
// (12h) — DD-MM-YYYY or M/D/YYYY, always IST (no DST in India).
export function parsePackingTime(raw: string | null): number | null {
  if (!raw) return null;
  const text = raw.trim();
  let m = /(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(text);
  if (m) {
    let hour = Number(m[4]);
    const ampm = (m[7] || '').toUpperCase();
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    const t = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), hour, Number(m[5]), Number(m[6] || 0)) - 5.5 * 3600 * 1000;
    return Number.isFinite(t) ? t : null;
  }
  m = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(text);
  if (m) {
    let hour = Number(m[4]);
    const ampm = (m[7] || '').toUpperCase();
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    const t = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), hour, Number(m[5]), Number(m[6] || 0)) - 5.5 * 3600 * 1000;
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function packingTimeRaw(body: string): string | null {
  const match = /Packing Time\s*:?\s*([\s\S]{0,40}?)(?=Please Note|Regards|$)/i.exec(body);
  return match ? match[1].trim() : null;
}

export function parseCctvMail(
  input: {
    subject: string;
    bodyText?: string | null;
    bodyHtml?: string | null;
    from?: string | null;
  },
  opts?: { allowedSenders?: string[] }
): AjioParseResult {
  const subject = input.subject || '';
  const subjectMatch = SUBJECT_RE.exec(subject);
  if (!subjectMatch) return { kind: 'skip', reason: 'subject is not a CCTV footage request' };
  const allowed = (opts?.allowedSenders || [AJIO_SENDER]).map((s) => s.toLowerCase());
  if (input.from && !allowed.some((sender) => input.from!.toLowerCase().includes(sender))) {
    return { kind: 'skip', reason: 'unexpected sender' };
  }
  const body = (input.bodyText && input.bodyText.trim()) || stripHtml(input.bodyHtml || '');
  const orderId = field(body, 'Order ID');
  if (!orderId) return { kind: 'skip', reason: 'no Order ID in body' };
  return {
    kind: 'wfr',
    request: {
      incidentId: subjectMatch[1],
      ticketNo: field(body, 'Ticket No') || subjectMatch[1],
      orderId,
      shipmentId: field(body, 'Shipment ID'),
      referenceValue: field(body, 'Reference Value') || subjectMatch[2] || null,
      variant: field(body, 'Variant'),
      complaintType: (() => {
        const segment = segmentAfter(body, 'Complaint Type');
        return segment ? segment.trim() : null;
      })(),
      packingTimeMs: parsePackingTime(packingTimeRaw(body)),
    },
  };
}
