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
  // 'scan' = short Postgres limits + one shared pool (scan-time lookups).
  profile?: SourceProfile;
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

// Postgres URL as node-pg wants it: SQLAlchemy's driver suffix
// (postgresql+psycopg2://) dropped, and any ?options=… removed so the URL can
// never switch off the read-only session settings below.
function normalizePostgresUrl(url: string): string | null {
  try {
    const parsed = new URL(url.replace(/^postgres(?:ql)?(?:\+[A-Za-z0-9_]+)?:/i, 'postgresql:'));
    if (!parsed.hostname) return null;
    parsed.searchParams.delete('options');
    return parsed.toString();
  } catch {
    return null;
  }
}

export function parseForwardScanUrl(value: unknown): ForwardScanSourceConfig | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!url) return null;
  if (/^postgres(ql)?(\+[A-Za-z0-9_]+)?:\/\//i.test(url)) {
    const target = normalizePostgresUrl(url);
    return target ? { kind: 'postgres', target } : null;
  }
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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Inside the VMS container "localhost" is the container itself, never the
// VPS, so a URL copied from the host (localhost:5433) could never connect.
// DATA_SYNC_LOCALHOST_ALIAS (compose: host.docker.internal) points it at the
// VPS instead, the way Forward Scan's own container reaches its Postgres.
function withLocalhostAlias(config: ForwardScanSourceConfig, alias: string | undefined): ForwardScanSourceConfig {
  const host = (alias || '').trim();
  if (config.kind !== 'postgres' || !host) return config;
  try {
    const parsed = new URL(config.target);
    if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return config;
    parsed.hostname = host;
    return { kind: 'postgres', target: parsed.toString() };
  } catch {
    return config;
  }
}

// Which env var supplies the source: DATA_SYNC_DATABASE_URL wins when it
// holds a usable URL (Forward Scan moved to PostgreSQL in Oct 2026), else the
// older FORWARD_SCAN_DATABASE_URL (SQLite file mount).
export function resolveDataSyncSource(env: Record<string, string | undefined>): {
  config: ForwardScanSourceConfig | null;
  envName: 'DATA_SYNC_DATABASE_URL' | 'FORWARD_SCAN_DATABASE_URL' | null;
  error?: string;
} {
  const raw = (env.DATA_SYNC_DATABASE_URL || '').trim();
  if (raw) {
    const preferred = parseForwardScanUrl(raw);
    if (preferred) {
      return { config: withLocalhostAlias(preferred, env.DATA_SYNC_LOCALHOST_ALIAS), envName: 'DATA_SYNC_DATABASE_URL' };
    }
    // Never fall back to the (frozen) SQLite file behind a typo: the copy
    // would "succeed" with stale data. Stop and say why instead.
    return {
      config: null,
      envName: 'DATA_SYNC_DATABASE_URL',
      error: 'DATA_SYNC_DATABASE_URL is set but is not a usable postgresql:// URL',
    };
  }
  const legacy = parseForwardScanUrl(env.FORWARD_SCAN_DATABASE_URL);
  if (legacy) return { config: legacy, envName: 'FORWARD_SCAN_DATABASE_URL' };
  return { config: null, envName: null };
}

// Connection settings for Forward Scan's Postgres: VMS only ever reads it
// (read-only transactions enforced by the server), never waits long, and
// shows up by name in pg_stat_activity.
export type SourceProfile = 'sync' | 'scan';

export function postgresSourceOptions(url: string, profile: SourceProfile = 'sync') {
  // Scan-time lookups sit inside a packer's request: give up fast.
  const scan = profile === 'scan';
  const statementMs = scan ? 2_000 : 30_000;
  return {
    connectionString: url,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: scan ? 1_500 : 5_000,
    application_name: scan ? 'vms-data-sync-scan' : 'vms-data-sync',
    options: `-c default_transaction_read_only=on -c statement_timeout=${statementMs} -c DateStyle=ISO`,
    query_timeout: statementMs + 500,
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

// Forward Scan writes only to PostgreSQL since 7 Oct 2026: its SQLite file
// is frozen, so a copy from it "succeeds" with old orders. Shown on the
// admin status card (and in the startup log) until the source is fixed.
export function forwardScanSourceWarning(config: ForwardScanSourceConfig | null): string | null {
  if (config?.kind !== 'sqlite') return null;
  return 'Reading Forward Scan\'s old SQLite file, which stopped updating when Forward Scan moved to PostgreSQL. ' +
    'Set DATA_SYNC_DATABASE_URL to Forward Scan\'s PostgreSQL URL.';
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

// Same rows as COALESCE(awb_generated_at, invoice_date, first_seen_at) >= cutoff,
// written so the awb_generated_at index can serve it (Forward Scan keeps 1.5
// years of orders in Postgres; the COALESCE form scanned all of them).
const WINDOW_SQLITE = `(o.awb_generated_at >= @cutoff
  OR (o.awb_generated_at IS NULL AND COALESCE(o.invoice_date, o.first_seen_at) >= @cutoff))`;
const WINDOW_PG = `(o.awb_generated_at >= $1::timestamp
  OR (o.awb_generated_at IS NULL AND COALESCE(o.invoice_date, o.first_seen_at) >= $1::timestamp))`;

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
       AND ${WINDOW_SQLITE}
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
      return ordersSince.all({ cutoff }) as ForwardScanOrderRow[];
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

// Scan-time lookups share one small pool per URL (connections close after
// 10 s idle); the 5-minute copy opens and ends its own pool per run.
const sharedScanPools = new Map<string, Pool>();

function newPool(url: string, profile: SourceProfile): Pool {
  const pool = new Pool(postgresSourceOptions(url, profile));
  // An idle client dropping (DB restart) must not crash the API.
  pool.on('error', (err) => console.warn('[data-sync] Forward Scan Postgres connection error:', err.message));
  return pool;
}

function openPostgres(url: string, profile: SourceProfile = 'sync'): ForwardScanSource {
  let pool: Pool;
  let shared = false;
  if (profile === 'scan') {
    shared = true;
    pool = sharedScanPools.get(url) || newPool(url, 'scan');
    sharedScanPools.set(url, pool);
  } else {
    pool = newPool(url, 'sync');
  }
  return {
    kind: 'postgres',
    async fetchOrdersSince(cutoff) {
      const res = await pool.query(
        `SELECT ${ORDER_COLUMNS} ${ORDERS_FROM}
         WHERE o.tracking_norm <> ''
           AND ${WINDOW_PG}
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
      // The shared scan pool stays for the next lookup (its idle timeout
      // closes connections); the copy's own pool ends with the run.
      if (!shared) await pool.end();
    },
  };
}

export function openForwardScanSource(config: ForwardScanSourceConfig, options: OpenOptions = {}): ForwardScanSource {
  return config.kind === 'postgres' ? openPostgres(config.target, options.profile) : openSqlite(config.target, options);
}
