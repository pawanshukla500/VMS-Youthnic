// Nightly SKU photo sync from OMSGuru channel listings — pure helpers
// (unit-tested). The runner lives in skuImageSync.ts.
//
// Why VMS walks the listings itself: Forward Scan's photo job reads only
// the first 10 pages per channel, and listing pages are ASCENDING by id, so
// it keeps re-reading the oldest ~1,000 SKUs and never reaches new styles
// (live check, Oct 2026: 5 of 1,124 order SKUs had a photo). VMS walks every
// page once, remembers a cursor per channel, and afterwards only reads the
// listings added since — inside a one-hour night window, leaving part of
// the shared 60 calls / 5 min budget to Forward Scan.
//
// Order lines carry the master SKU (invoice `sku_code`); listings carry the
// channel SKU (`sku_name` = invoice `listing_sku`). They are usually equal;
// channels add tags (T86-Coffee-Red_XL_AI1, EJ1201-16001_INF_New,
// SKD238-Tripti-Beige_AI2_S) and size spellings (2XL vs XXL). Listings of
// one master SKU share `oms_sku_id`, which links those aliases exactly.
import { normalizeImageUrl, normalizeSkuKey } from './mappers';
export { isColorConflicting, extractColorFamilies } from './colorMatch';

export const LISTING_PAGE_SIZE = 100;
export const MAX_SKU_KEY_LENGTH = 255;

export interface ListingRow {
  listing_row_id: number;
  sku_name: string;
  sku_key: string;
  match_key: string;
  oms_sku_id: string | null;
  title: string | null;
  image_url: string | null;
}

// Marketplace tags channels append to the master SKU, as whole `_` tokens.
const CHANNEL_TAG = /_(?:AI\d*|N|NEW|INF)(?=_|$)/g;

export function listingMatchKey(skuKey: string): string {
  let key = skuKey;
  for (let i = 0; i < 4; i += 1) {
    const next = key.replace(CHANNEL_TAG, '');
    if (next === key) break;
    key = next;
  }
  return key || skuKey;
}

// Same style + colour, any size: "SKD238-TRIPTI-BEIGE_S" -> "SKD238-TRIPTI-BEIGE".
// Must equal the SQL expression regexp_replace(sku_key, '_[^_]*$', '').
export function skuStyleKey(skuKey: string): string {
  return skuKey.replace(/_[^_]*$/, '');
}

// Postgres jsonb rejects \u0000 and lone surrogates; one such title would
// otherwise fail its page every night. Cut by code points, not UTF-16 units.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function safeText(value: string, maxChars: number): string {
  const cleaned = value.replace(CONTROL_CHARS, ' ').replace(LONE_SURROGATE, '').trim();
  const chars = Array.from(cleaned);
  return chars.length > maxChars ? chars.slice(0, maxChars).join('').trim() : cleaned;
}

function clean(value: unknown, maxChars = 500): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const text = safeText(value, maxChars);
  return text || null;
}

export function mapListingRow(listing: any): ListingRow | null {
  const id = Number(listing?.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const skuName = clean(listing?.sku_name, 1000) || clean(listing?.sku_code, 1000) || clean(listing?.sku, 1000);
  if (!skuName) return null;
  const skuKey = normalizeSkuKey(skuName);
  if (!skuKey || skuKey.length > MAX_SKU_KEY_LENGTH) return null;
  const omsSkuId = clean(listing?.oms_sku_id, 64);
  const imageUrl = normalizeImageUrl(listing?.img_url || listing?.image_url || listing?.image);
  return {
    listing_row_id: id,
    sku_name: skuName,
    sku_key: skuKey,
    match_key: listingMatchKey(skuKey),
    // Only real ids link listings ("0" / "-1" / "NA" style placeholders do not).
    oms_sku_id: omsSkuId && /^[1-9]\d*$/.test(omsSkuId) ? omsSkuId : null,
    title: clean(listing?.title) || clean(listing?.name) || null,
    image_url: imageUrl && /^https:\/\//i.test(imageUrl) && imageUrl.length <= 2000 && !/[\s\u0000]/.test(imageUrl) ? imageUrl : null,
  };
}

// Highest listing id on a page = the next cursor (pages are ascending).
export function nextListingCursor(page: any[], current: number): number {
  let max = current;
  for (const row of page) {
    const id = Number(row?.id);
    if (Number.isSafeInteger(id) && id > max) max = id;
  }
  return max;
}

export interface ChannelInfo {
  id: number;
  name: string;
  channel: string;
}

// Turn order: channels VMS packs first (Meesho, Ajio, Amazon...), then
// channels whose orders are not copied (their listings still name the
// master SKUs), fulfilled-by-marketplace channels last.
export function orderChannelsForSync(channels: ChannelInfo[], excludedMarketplaces: string[]): ChannelInfo[] {
  const excluded = new Set(excludedMarketplaces.map((m) => m.trim().toLowerCase()).filter(Boolean));
  const rank = (c: ChannelInfo) => {
    const label = `${c.name} ${c.channel}`.toLowerCase();
    if (/\bfba\b|advantage/.test(label)) return 2;
    const right = (c.name.split(' - ').pop() || '').trim().toLowerCase();
    if (excluded.has(right) || excluded.has(c.channel.trim().toLowerCase())) return 1;
    if (label.includes('meesho')) return -1;
    return 0;
  };
  return [...channels].sort((a, b) => rank(a) - rank(b) || a.id - b.id);
}

export interface ChannelCursorState {
  last_id: number | string | null;
  pass_started_at: string | Date | null;
  pass_completed_at: string | Date | null;
}

// Where a channel resumes tonight. A finished pass keeps its cursor (only
// new listings are read); a pass older than fullRefreshDays starts over
// from the first listing to pick up changed photos (0 = never). If an open
// pass has been running longer than fullRefreshDays, it also rolls over to 0.
export function planChannelPass(
  state: ChannelCursorState | null,
  nowMs: number,
  fullRefreshDays: number
): { lastId: number; newPass: boolean } {
  // Every new pass starts at the first listing (pages are ascending).
  if (!state || !state.pass_started_at) return { lastId: 0, newPass: true };
  const completedAt = state.pass_completed_at ? new Date(state.pass_completed_at).getTime() : NaN;
  const startedAt = state.pass_started_at ? new Date(state.pass_started_at).getTime() : NaN;

  if (fullRefreshDays > 0) {
    if (Number.isFinite(completedAt) && nowMs - completedAt >= fullRefreshDays * 86_400_000) {
      return { lastId: 0, newPass: true };
    }
    if (!Number.isFinite(completedAt) && Number.isFinite(startedAt) && nowMs - startedAt >= fullRefreshDays * 86_400_000) {
      return { lastId: 0, newPass: true };
    }
  }

  return { lastId: Math.max(0, Number(state.last_id) || 0), newPass: false };
}

// How long to wait before the next call so at least `reserve` calls of the
// current 5-minute window stay with Forward Scan. 0 = go now.
export function budgetWaitMs(
  snapshot: { remaining: number; resetAtMs: number | null; seenAtMs: number } | null,
  reserve: number,
  nowMs: number
): number {
  if (!snapshot || reserve <= 0) return 0;
  if (snapshot.remaining > reserve) return 0;
  const resetAt = snapshot.resetAtMs && snapshot.resetAtMs > snapshot.seenAtMs
    ? snapshot.resetAtMs
    : snapshot.seenAtMs + 5 * 60_000;
  // Window already rolled over since the reading: try again.
  if (resetAt <= nowMs) return 0;
  return resetAt - nowMs + 1000;
}

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

// Next start of the nightly window (hourIst:00 IST) after nowMs.
export function nextNightlyRunAt(nowMs: number, hourIst: number): number {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const target = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hourIst, 0, 0, 0) - IST_OFFSET_MS;
  return target > nowMs ? target : target + 86_400_000;
}

// Start of tonight's window if nowMs falls inside it, else null (lets a
// restart during the window catch up instead of skipping a night).
export function currentNightlyWindowStart(nowMs: number, hourIst: number, minutes: number): number | null {
  const next = nextNightlyRunAt(nowMs, hourIst);
  const start = next - 86_400_000;
  return nowMs >= start && nowMs < start + minutes * 60_000 ? start : null;
}

// Fixed spacing between calls so the reserve also holds when OMSGuru stops
// sending X-OMS-Remaining: 60 - reserve calls per 5-minute window at most
// (25 reserved -> one call every ~8.6 s).
export function minCallIntervalMs(reserve: number): number {
  return Math.max(5000, Math.ceil(300_000 / Math.max(1, 60 - Math.max(0, reserve))));
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
