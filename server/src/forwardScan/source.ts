// Read-only access to the Forward Scan database.
//
// DATA_SYNC_DATABASE_URL (preferred) or FORWARD_SCAN_DATABASE_URL use Forward
// Scan's own DATABASE_URL format:
//   postgresql://user:pass@host:5433/forward_scan        (production since Oct 2026)
//   sqlite:////forward-scan-data/omsguru_forward_scan.db  (absolute path, legacy)
//   sqlite:///data/omsguru_forward_scan.db               (relative path)
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
  // All rows for up to 500 canonical AWBs (Order Imports order dates).
  fetchOrdersByTracking(trackingIds: string[]): Promise<ForwardScanOrderRow[]>;
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

// Which env var supplies the source: DATA_SYNC_DATABASE_URL wins when it
// holds a usable URL (Forward Scan moved to PostgreSQL in Oct 2026), else the
// older FORWARD_SCAN_DATABASE_URL (SQLite file mount).
export function resolveDataSyncSource(env: Record<string, string | undefined>): {
  config: ForwardScanSourceConfig | null;
  envName: 'DATA_SYNC_DATABASE_URL' | 'FORWARD_SCAN_DATABASE_URL' | null;
} {
  const preferred = parseForwardScanUrl(env.DATA_SYNC_DATABASE_URL);
  if (preferred) return { config: preferred, envName: 'DATA_SYNC_DATABASE_URL' };
  const legacy = parseForwardScanUrl(env.FORWARD_SCAN_DATABASE_URL);
  if (legacy) return { config: legacy, envName: 'FORWARD_SCAN_DATABASE_URL' };
  return { config: null, envName: null };
}

// Connection settings for Forward Scan's Postgres: VMS only ever reads it
// (read-only transactions enforced by the server), never waits long, and
// shows up by name in pg_stat_activity.
export function postgresSourceOptions(url: string) {
  return {
    connectionString: url,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'vms-data-sync',
    options: '-c default_transaction_read_only=on -c statement_timeout=30000',
    query_timeout: 35_000,
  };
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
    async fetchOrdersByTracking(trackingIds) {
      const ids = [...new Set(trackingIds.filter(Boolean))].slice(0, 500);
      if (ids.length === 0) return [];
      return db.prepare(
        `SELECT ${ORDER_COLUMNS} ${ORDERS_FROM}
         WHERE o.tracking_norm IN (${ids.map(() => '?').join(', ')})`
      ).all(...ids) as ForwardScanOrderRow[];
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
  const pool = new Pool(postgresSourceOptions(url));
  // An idle client dropping (DB restart) must not crash the API.
  pool.on('error', (err) => console.warn('[data-sync] Forward Scan Postgres connection error:', err.message));
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
    async fetchOrdersByTracking(trackingIds) {
      const ids = [...new Set(trackingIds.filter(Boolean))].slice(0, 500);
      if (ids.length === 0) return [];
      const res = await pool.query(
        `SELECT ${ORDER_COLUMNS} ${ORDERS_FROM} WHERE o.tracking_norm = ANY($1::text[])`,
        [ids]
      );
      return res.rows;
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
