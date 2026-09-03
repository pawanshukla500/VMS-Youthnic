// Daily packing report (sent via Resend). Pure builders are unit-tested;
// the endpoint in index.ts only wires DB rows + Resend delivery.

export interface DailyReportDay {
  day: string; // YYYY-MM-DD in Asia/Kolkata
  start: Date; // inclusive (IST midnight as UTC instant)
  end: Date; // exclusive
}

export interface StationRow {
  station: string;
  packed: number;
}

export interface MarketplaceRow {
  marketplace: string;
  packed: number;
}

export interface DailyReportStats {
  day: string;
  totalPacked: number;
  completedVideos: number;
  failedUploads: number;
  operators: number;
  avgDurationSeconds: number;
  mappingsImported: number;
  // Recordings matched/renamed to order IDs by the mapping job today.
  renamedToOrders: number;
  stations: StationRow[];
  marketplaces: MarketplaceRow[];
}

// Packing happens in IST; the server clock may be UTC, so day boundaries
// are computed for Asia/Kolkata explicitly.
export function getReportDay(dateStr?: string): DailyReportDay {
  const istToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const day = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : istToday;
  const start = new Date(`${day}T00:00:00+05:30`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { day, start, end };
}

function esc(value: unknown): string {
  return String(value ?? '-')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rows(title: string, headers: [string, string], items: Array<[string, number]>, emptyHint: string): string {
  const body = items.length === 0
    ? `<tr><td colspan="2" style="padding:12px;color:#666;">${esc(emptyHint)}</td></tr>`
    : items.map(([name, count]) => `<tr><td style="padding:8px 12px;border-top:1px solid #eee;">${esc(name)}</td><td style="padding:8px 12px;border-top:1px solid #eee;text-align:right;"><b>${count}</b></td></tr>`).join('');
  return `<h3 style="margin:20px 0 8px;">${esc(title)}</h3>
<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
<thead><tr><th style="padding:8px 12px;text-align:left;background:#f3f4f6;">${esc(headers[0])}</th><th style="padding:8px 12px;text-align:right;background:#f3f4f6;">${esc(headers[1])}</th></tr></thead>
<tbody>${body}</tbody></table>`;
}

export function buildDailyReportSubject(stats: DailyReportStats): string {
  return `PVMS daily packing report — ${stats.day} (${stats.totalPacked} packed)`;
}

export function buildDailyReportHtml(stats: DailyReportStats): string {
  const summary = [
    ['Packed today', stats.totalPacked],
    ['Videos completed', stats.completedVideos],
    ['Failed uploads', stats.failedUploads],
    ['Active operators', stats.operators],
    ['Avg video (s)', stats.avgDurationSeconds],
    ['Order mappings imported', stats.mappingsImported],
    ['Renamed to orders', stats.renamedToOrders],
  ] as Array<[string, number]>;

  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#111;">
<h2 style="margin:0 0 4px;">Packing report — ${esc(stats.day)}</h2>
<p style="margin:0 0 12px;color:#555;">How much packed today across all stations.</p>
${rows('Summary', ['Metric', 'Count'], summary, 'No activity')}
${rows('By station', ['Station', 'Packed'], stats.stations.map((s) => [s.station, s.packed]), 'No stations recorded')}
${rows('By marketplace', ['Marketplace', 'Packed'], stats.marketplaces.map((m) => [m.marketplace, m.packed]), 'No marketplaces recorded')}
<p style="color:#888;font-size:12px;margin-top:16px;">Renamed to orders = recordings matched to an order ID by the order-mapping import/reconcile today.</p>
</div>`;
}

export function parseReportRecipients(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value.split(',').map((s) => s.trim()).filter((s) => /.+@.+\..+/.test(s));
}
