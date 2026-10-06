// Read-only access to the Forward Scan database.
//
// FORWARD_SCAN_DATABASE_URL uses Forward Scan's own DATABASE_URL format:
//   sqlite:////forward-scan-data/omsguru_forward_scan.db  (absolute path)
//   sqlite:///data/omsguru_forward_scan.db               (relative path)
//   postgresql://user:pass@host:5432/db                  (if it moves to Postgres)
// The SQLite file is opened read-only; Forward Scan runs it in WAL mode, so
// readers never block its scanning writes. Connections are opened per sync
// run and closed right after (no long-lived read snapshot pins the WAL).
import { Pool } from 'pg';
import type { ForwardScanOrderRow, ForwardScanPhotoRow } from './mappers';

export type ForwardScanSourceKind = 'sqlite' | 'postgres';

export interface ForwardScanSourceConfig {
  kind: ForwardScanSourceKind;
  target: string;
}

export interface OpenOptions {
  // better-sqlite3 waits on the Node main thread: keep it short so a
  // Forward Scan restart / WAL recovery never stalls VMS requests.
  busyTimeoutMs?: number;
}

export interface PhotoCursor {
  updatedAt: string | null;
  sku: string | null;
}

export interface ForwardScanSource {
  kind: ForwardScanSourceKind;
  // AWBs generated (or first seen) at/after the cutoff, Forward Scan time text.
  fetchOrdersSince(cutoff: string): Promise<ForwardScanOrderRow[]>;
  // Newest row for any of these canonical AWBs (scan-time miss lookup).
  fetchOrderByTracking(trackingIds: string[]): Promise<ForwardScanOrderRow | null>;
  // Photos changed after the cursor, keyset-paged by (updated_at, sku).
  fetchPhotosAfter(cursor: PhotoCursor, limit: number): Promise<ForwardScanPhotoRow[]>;
  close(): Promise<void>;
}

export function parseForwardScanUrl(value: unknown): ForwardScanSourceConfig | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!url) return null;
  if (/^postgres(ql)?:\/\//i.test(url)) return { kind: 'postgres', target: url };
  const sqlite = url.match(/^sqlite:\/\/\/(.+)$/i);
  if (sqlite) {
    // SQLAlchemy form: sqlite:///relative or sqlite:////absolute.
    const path = sqlite[1];
    return { kind: 'sqlite', target: path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : `./${path}` };
  }
  if (/^file:/i.test(url)) return { kind: 'sqlite', target: url.replace(/^file:(\/\/)?/i, '') };
  if (/\.(db|sqlite3?)$/i.test(url)) return { kind: 'sqlite', target: url };
  return null;
}

// Redacted description for logs and the admin status card.
export function describeForwardScanSource(config: ForwardScanSourceConfig | null): string {
  if (!config) return 'not configured';
  if (config.kind === 'sqlite') return `sqlite ${config.target}`;
  try {
    const parsed = new URL(config.target);
    return `postgres ${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}`;
  } catch {
    return 'postgres (unparsable URL)';
  }
}

const ORDER_COLUMNS = `
  o.id AS source_row_id, o.tracking_norm, o.tracking_raw, o.channel_label, o.channel_id, o.company,
  c.marketplace AS channel_marketplace, c.name AS channel_name,
  o.channel_order_id, o.sub_order_ids, o.invoice_id, o.items_json, o.item_count, o.total_qty,
  o.status_text, o.status_group, o.shipping_company, o.order_type,
  CAST(o.order_date AS TEXT) AS order_date,
  CAST(o.awb_generated_at AS TEXT) AS awb_generated_at,
  CAST(o.invoice_date AS TEXT) AS invoice_date,
  CAST(o.sla_date AS TEXT) AS sla_date,
  CAST(o.synced_at AS TEXT) AS synced_at,
  CAST(o.first_seen_at AS TEXT) AS first_seen_at`;

const ORDERS_FROM = `FROM oms_orders o LEFT JOIN channels c ON c.id = o.channel_id`;

function openSqlite(path: string, options: OpenOptions): ForwardScanSource {
  // Loaded lazily: a missing native build must only disable this sync,
  // never stop the API from starting.
  const Database = require('better-sqlite3');
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: options.busyTimeoutMs ?? 1000 });
  try {
    return sqliteSource(db);
  } catch (err) {
    // e.g. Forward Scan schema changed: never leak the handle.
    db.close();
    throw err;
  }
}

function sqliteSource(db: any): ForwardScanSource {
  db.pragma('query_only = ON');
  const ordersSince = db.prepare(
    `SELECT ${ORDER_COLUMNS} ${ORDERS_FROM}
     WHERE o.tracking_norm <> ''
       AND COALESCE(o.awb_generated_at, o.invoice_date, o.first_seen_at) >= ?
     ORDER BY o.id`
  );
  const photosAfter = db.prepare(
    `SELECT sku, title, image_url, marketplace, CAST(updated_at AS TEXT) AS updated_at
     FROM sku_photos
     WHERE image_url <> ''
       AND (? IS NULL OR updated_at > ? OR (updated_at = ? AND sku > ?))
     ORDER BY updated_at, sku
     LIMIT ?`
  );
  return {
    kind: 'sqlite',
    async fetchOrdersSince(cutoff) {
      return ordersSince.all(cutoff) as ForwardScanOrderRow[];
    },
    async fetchOrderByTracking(trackingIds) {
      const ids = trackingIds.filter(Boolean).slice(0, 10);
      if (ids.length === 0) return null;
      const row = db.prepare(
        `SELECT ${ORDER_COLUMNS} ${ORDERS_FROM}
         WHERE o.tracking_norm IN (${ids.map(() => '?').join(', ')})
         ORDER BY o.id DESC LIMIT 1`
      ).get(...ids);
      return (row as ForwardScanOrderRow) || null;
    },
    async fetchPhotosAfter(cursor, limit) {
      const at = cursor.updatedAt;
      return photosAfter.all(at, at, at, cursor.sku || '', limit) as ForwardScanPhotoRow[];
    },
    async close() {
      db.close();
    },
  };
}

function openPostgres(url: string): ForwardScanSource {
  const pool = new Pool({ connectionString: url, max: 2, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000 });
  return {
    kind: 'postgres',
    async fetchOrdersSince(cutoff) {
      const res = await pool.query(
        `SELECT ${ORDER_COLUMNS} ${ORDERS_FROM}
         WHERE o.tracking_norm <> ''
           AND COALESCE(o.awb_generated_at, o.invoice_date, o.first_seen_at) >= $1::timestamp
         ORDER BY o.id`,
        [cutoff]
      );
      return res.rows;
    },
    async fetchOrderByTracking(trackingIds) {
      const ids = trackingIds.filter(Boolean).slice(0, 10);
      if (ids.length === 0) return null;
      const res = await pool.query(
        `SELECT ${ORDER_COLUMNS} ${ORDERS_FROM}
         WHERE o.tracking_norm = ANY($1::text[])
         ORDER BY o.id DESC LIMIT 1`,
        [ids]
      );
      return res.rows[0] || null;
    },
    async fetchPhotosAfter(cursor, limit) {
      const res = await pool.query(
        `SELECT sku, title, image_url, marketplace, CAST(updated_at AS TEXT) AS updated_at
         FROM sku_photos
         WHERE image_url <> ''
           AND ($1::timestamp IS NULL OR updated_at > $1::timestamp OR (updated_at = $1::timestamp AND sku > $2))
         ORDER BY updated_at, sku
         LIMIT $3`,
        [cursor.updatedAt, cursor.sku || '', limit]
      );
      return res.rows;
    },
    async close() {
      await pool.end();
    },
  };
}

export function openForwardScanSource(config: ForwardScanSourceConfig, options: OpenOptions = {}): ForwardScanSource {
  return config.kind === 'postgres' ? openPostgres(config.target) : openSqlite(config.target, options);
}
