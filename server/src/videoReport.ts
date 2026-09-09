// Video Library xlsx export builders (pure, unit-tested).
//
// The old CSV export showed raw millisecond durations and JS Date strings.
// This builds a proper workbook: typed columns, whole seconds, IST
// datetimes, clickable video links, styled header, frozen panes, autofilter.
// Filter SQL mirrors the /api/videos list handler (kept in sync by hand;
// the list route is intentionally untouched).
import ExcelJS from 'exceljs';

export const REPORT_MAX_ROWS = 5000;
export const REPORT_MAX_RANGE_DAYS = 366;
// Asia/Kolkata has no DST, so the IST offset is a fixed constant.
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

export interface VideoReportFilters {
  search?: string;
  station?: string;
  marketplace?: string;
  reviewStatus?: string;
  from?: string;
  to?: string;
}

export interface VideoReportRow {
  id: unknown;
  tracking_id: unknown;
  order_id: unknown;
  marketplace: unknown;
  flyer_id: unknown;
  timestamp: unknown;
  duration_ms: unknown;
  packer_name: unknown;
  packer_email: unknown;
  station_code: unknown;
  station_name: unknown;
  upload_status: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function istDayKey(timeMs: number): { key: string; y: number; m: number; d: number } {
  const d = new Date(timeMs + IST_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return { key: `${y}-${pad(m)}-${pad(day)}`, y, m, d: day };
}

function parseDay(value: string): { y: number; m: number; d: number } | null {
  const match = DAY_RE.exec(value.trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Reject impossible calendar dates (e.g. month 13 already covered, Feb 30).
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return { y, m, d };
}

export function parseReportDayRange(
  from: string | undefined,
  to: string | undefined,
  nowMs = Date.now()
): { startUtc: Date; endUtc: Date; fromKey: string; toKey: string } | { error: string } {
  const todayKey = istDayKey(nowMs).key;
  const fromKey = from && from.trim() ? from.trim() : shiftDayKey(todayKey, -6);
  const toKey = to && to.trim() ? to.trim() : todayKey;
  const fromDay = parseDay(fromKey);
  const toDay = parseDay(toKey);
  if (!fromDay || !toDay) return { error: 'Dates must be YYYY-MM-DD' };
  const startUtc = new Date(Date.UTC(fromDay.y, fromDay.m - 1, fromDay.d) - IST_OFFSET_MS);
  const endUtc = new Date(Date.UTC(toDay.y, toDay.m - 1, toDay.d) + 24 * 3600 * 1000 - IST_OFFSET_MS);
  if (startUtc.getTime() >= endUtc.getTime()) return { error: 'From date must be on or before To date' };
  if ((endUtc.getTime() - startUtc.getTime()) / (24 * 3600 * 1000) > REPORT_MAX_RANGE_DAYS) {
    return { error: `Date range is limited to ${REPORT_MAX_RANGE_DAYS} days` };
  }
  return { startUtc, endUtc, fromKey, toKey };
}

function shiftDayKey(key: string, deltaDays: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + deltaDays * 24 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function buildVideosReportWhere(
  filters: VideoReportFilters & { startUtc: Date; endUtc: Date },
  params: any[]
): string {
  let where = `WHERE va.organization_id = $1`;
  const { search, station, marketplace, reviewStatus } = filters;

  if (search) {
    params.push(`%${search}%`);
    where += ` AND (rs.tracking_id ILIKE $${params.length} OR rs.order_id ILIKE $${params.length} OR rs.marketplace ILIKE $${params.length} OR u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`;
  }

  if (reviewStatus && reviewStatus !== 'All Statuses') {
    const normalizedStatus = reviewStatus.toLowerCase();
    if (normalizedStatus === 'disputed' || normalizedStatus === 'resolved') {
      params.push(normalizedStatus);
      where += ` AND (va.review_status = $${params.length})`;
    } else if (normalizedStatus === 'uploaded') {
      where += ` AND (va.upload_status = 'uploaded' OR va.upload_status = 'completed')`;
    } else if (normalizedStatus === 'uploading' || normalizedStatus === 'failed') {
      params.push(normalizedStatus);
      where += ` AND (va.upload_status = $${params.length})`;
    }
  }

  if (station && station !== 'All Stations') {
    params.push(station);
    where += UUID_RE.test(station)
      ? ` AND (rs.station_id = $${params.length})`
      : ` AND (s.code = $${params.length})`;
  }

  if (marketplace && marketplace !== 'All Marketplaces') {
    if (marketplace === 'Unassigned') {
      where += ` AND (rs.marketplace IS NULL OR rs.marketplace = '')`;
    } else {
      params.push(marketplace);
      where += ` AND LOWER(rs.marketplace) = LOWER($${params.length})`;
    }
  }

  params.push(filters.startUtc, filters.endUtc);
  where += ` AND (rs.created_at >= $${params.length - 1} AND rs.created_at < $${params.length})`;
  return where;
}

const IST_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatIstDateTime(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const t = value instanceof Date ? value.getTime() : new Date(value as any).getTime();
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + IST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  const h24 = d.getUTCHours();
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${pad(d.getUTCDate())} ${IST_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(h12)}:${pad(d.getUTCMinutes())} ${ampm}`;
}

export function durationSeconds(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 1000);
}

export function normalizeReportStatus(uploadStatus: unknown): string {
  if (uploadStatus === 'completed') return 'uploaded';
  return typeof uploadStatus === 'string' && uploadStatus ? uploadStatus : '';
}

export function resolveAppBaseUrl(
  headers: { referer?: string; origin?: string; host?: string },
  allowedOrigins: string
): string {
  const fromUrl = (value: string | undefined): string | null => {
    if (!value) return null;
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
    } catch {
      // Not a URL — try the next source.
    }
    return null;
  };
  const configured = allowedOrigins
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .find((s) => /^https?:\/\//.test(s));
  return fromUrl(headers.referer) || fromUrl(headers.origin) || configured || (headers.host ? `https://${headers.host}` : '');
}

export function buildVideosReportWorkbook(rows: VideoReportRow[], appBaseUrl: string): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PVMS';
  workbook.created = new Date();
  const ws = workbook.addWorksheet('Videos', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Tracking ID', key: 'trackingId', width: 18 },
    { header: 'Order ID', key: 'orderId', width: 24 },
    { header: 'Marketplace', key: 'marketplace', width: 20 },
    { header: 'Flyer ID', key: 'flyerId', width: 18 },
    { header: 'Date & Time (IST)', key: 'dateTime', width: 24 },
    { header: 'Duration (sec)', key: 'durationSec', width: 15 },
    { header: 'Packer', key: 'packer', width: 24 },
    { header: 'Station', key: 'station', width: 14 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Video Link', key: 'videoLink', width: 16 },
  ];
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  ws.autoFilter = { from: 'A1', to: 'J1' };

  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id : '';
    ws.addRow({
      trackingId: typeof row.tracking_id === 'string' && row.tracking_id ? row.tracking_id : 'UNKNOWN',
      orderId: typeof row.order_id === 'string' && row.order_id ? row.order_id : '',
      marketplace: typeof row.marketplace === 'string' && row.marketplace ? row.marketplace : 'Unassigned',
      flyerId: typeof row.flyer_id === 'string' ? row.flyer_id : '',
      dateTime: formatIstDateTime(row.timestamp),
      durationSec: durationSeconds(row.duration_ms),
      packer: (typeof row.packer_name === 'string' && row.packer_name) || (typeof row.packer_email === 'string' && row.packer_email) || 'Unknown',
      station: (typeof row.station_code === 'string' && row.station_code) || (typeof row.station_name === 'string' && row.station_name) || 'Unknown',
      status: normalizeReportStatus(row.upload_status),
      videoLink: appBaseUrl && id ? { text: 'Open video', hyperlink: `${appBaseUrl}/api/videos/${id}/download` } : '',
    });
  }
  return workbook;
}
