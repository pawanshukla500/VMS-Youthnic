// Public share links for single packing videos (unit-tested).
//
// "Copy link" in the Video Library hands out /share/<token>: anyone with the
// link can watch THAT one video (e.g. a marketplace dispute desk) without a
// VMS login. The token is 256 random bits; the API behind it only ever
// returns a short-lived signed URL for the linked file plus a few labels, and
// links can be revoked. Deleting the video (manual or retention) deletes its
// links with it (ON DELETE CASCADE).
import { randomBytes } from 'crypto';

const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function newShareToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isShareToken(value: unknown): value is string {
  return typeof value === 'string' && SHARE_TOKEN.test(value);
}

export function buildShareUrl(appBaseUrl: string, token: string): string {
  return `${appBaseUrl.replace(/\/+$/, '')}/share/${token}`;
}

// What a public viewer may see — nothing about operators or other videos.
export function publicVideoView(row: {
  tracking_id?: string | null;
  order_id?: string | null;
  marketplace?: string | null;
  recorded_at?: string | Date | null;
  duration_ms?: number | string | null;
}) {
  const duration = Number(row.duration_ms);
  return {
    trackingId: row.tracking_id || null,
    orderId: row.order_id || null,
    marketplace: row.marketplace || null,
    recordedAt: row.recorded_at ? new Date(row.recorded_at).toISOString() : null,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? Math.round(duration / 1000) : null,
  };
}
