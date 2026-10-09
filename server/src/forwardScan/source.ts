// Read-only access to the Forward Scan database.
//
// DATA_SYNC_DATABASE_URL (preferred) or FORWARD_SCAN_DATABASE_URL use Forward
// Scan's own DATABASE_URL format:
//   postgresql://user:pass@host:5433/forward_scan        (production since Oct 2026)
//   sqlite:////forward-scan-data/omsguru_forward_scan.db  (absolute path, legacy)
//   sqlite:///data/omsguru_forward_scan.db               (relative path)
// VMS only ever READS this database: it never writes, deletes or changes
// anything there. Enforced three ways: every statement must pass
// assertReadOnlySql (one plain SELECT), every Postgres read runs in its own
// BEGIN TRANSACTION READ ONLY (Postgres itself rejects a write), and the
// session default is read-only too; the SQLite file is opened readonly +
// query_only and each statement must be one SQLite reports as read-only.
// Forward Scan runs SQLite in WAL mode, so readers never block its scanning
// writes. Connections are opened per sync
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
  // Whether the login COULD write Forward Scan's tables (VMS still never
  // does): true = not a SELECT-only role, shown as a warning on the card.
  canWrite?(): Promise<boolean>;
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

// Words that write, lock, change settings or run code, as whole words outside
// string literals. Column names such as updated_at / offset never match.
const NON_READ_SQL = new RegExp(
  '\\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|COPY|CALL|DO|' +
  'EXECUTE|PREPARE|DEALLOCATE|LOCK|VACUUM|ANALYZE|REINDEX|CLUSTER|REFRESH|COMMENT|SECURITY|SET|RESET|' +
  'BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|ABORT|ATTACH|DETACH|PRAGMA|INTO|NOTIFY|LISTEN|UNLISTEN|' +
  'DISCARD|IMPORT|LOAD|NEXTVAL|SETVAL|SET_CONFIG|DBLINK\\w*|LO_\\w+|\\w*ADVISORY\\w*|PG_TERMINATE_BACKEND|' +
  'PG_CANCEL_BACKEND|PG_RELOAD_CONF|PG_ROTATE_LOGFILE|PG_FILE_WRITE|PG_NOTIFY|PG_STAT_RESET\\w*)\\b',
  'i'
);
const LOCKING_READ = /\bFOR\s+(NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b/i;

// Quoting the simple literal stripper below cannot follow: dollar quotes
// ($$..$$, $tag$..$tag$; $1 placeholders are fine), "quoted identifiers",
// E'..' escape strings and U&'..' unicode strings. VMS's own reads use none.
const UNSUPPORTED_QUOTING = /\$(?!\d)|"|\bE'|U&/i;

// Every statement VMS sends to Forward Scan's database must be ONE plain
// SELECT: no second statement, no comment, nothing that writes, locks or
// changes a setting. Throws before anything is sent.
export function assertReadOnlySql(text: string): void {
  const raw = String(text || '');
  const sql = raw.replace(/'(?:[^']|'')*'/g, "''").trim();
  if (
    UNSUPPORTED_QUOTING.test(raw)
    || !/^SELECT\b/i.test(sql)
    || sql.includes(';')
    || /--|\/\*/.test(sql)
    || NON_READ_SQL.test(sql)
    || LOCKING_READ.test(sql)
  ) {
    throw new Error('Refused: only read (SELECT) statements may be sent to the Forward Scan database');
  }
}

// One Postgres read in its own READ ONLY transaction: Postgres rejects any
// write in it whatever the session settings are, and the statement is
// checked by assertReadOnlySql first.
export async function readOnlyQuery(pool: Pick<Pool, 'connect'>, text: string, values: unknown[] = []): Promise<any[]> {
  assertReadOnlySql(text);
  const client = await pool.connect();
  let failure: Error | undefined;
  // pg-pool drops its own 'error' listener while a client is checked out: a
  // socket closing mid-read (Forward Scan's Postgres restarting) would be an
  // unhandled 'error' event and stop the whole API. Hold one until release.
  const onError = (err: Error) => {
    failure = failure || err;
  };
  client.on('error', onError);
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const res = await client.query(text, values);
    await client.query('COMMIT');
    return res.rows;
  } catch (err) {
    // No ROLLBACK: releasing with the error closes the connection, which
    // ends the transaction (a ROLLBACK would queue behind a timed-out read).
    failure = failure || (err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    client.release(failure);
    // release() has put the pool's own listener back.
    client.removeListener('error', onError);
  }
}

// SQLite: the same allowlist, and SQLite itself must report the prepared
// statement as read-only (better-sqlite3 Statement.readonly).
function prepareRead(db: any, text: string): any {
  assertReadOnlySql(text);
  const stmt = db.prepare(text);
  if (stmt.readonly !== true) {
    throw new Error('Refused: SQLite reports a Forward Scan statement as not read-only');
  }
  return stmt;
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
  const ordersSince = prepareRead(
    db,
    `SELECT ${ORDER_COLUMNS} ${ORDERS_FROM}
     WHERE o.tracking_norm <> ''
       AND ${WINDOW_SQLITE}
     ORDER BY o.id`
  );
  const photosAfter = prepareRead(
    db,
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
      const row = prepareRead(
        db,
        `SELECT ${ORDER_COLUMNS} ${ORDERS_FROM}
         WHERE o.tracking_norm IN (${ids.map(() => '?').join(', ')})
         ORDER BY o.id DESC LIMIT 1`
      ).get(...ids);
      return (row as ForwardScanOrderRow) || null;
    },
    async fetchOrdersByTracking(trackingIds) {
      const ids = [...new Set(trackingIds.filter(Boolean))].slice(0, 500);
      if (ids.length === 0) return [];
      return prepareRead(
        db,
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
  if (profile === 'scan') {
    const pool = sharedScanPools.get(url) || newPool(url, 'scan');
    sharedScanPools.set(url, pool);
    // The shared scan pool stays for the next lookup (its idle timeout
    // closes connections).
    return postgresSource(pool, async () => undefined);
  }
  // The copy's own pool ends with the run.
  const pool = newPool(url, 'sync');
  return postgresSource(pool, () => pool.end());
}

// Forward Scan reads over any pg pool. Nothing here can write: every query
// goes through readOnlyQuery.
export function postgresSource(pool: Pick<Pool, 'connect'>, close: () => Promise<void>): ForwardScanSource {
  return {
    kind: 'postgres',
    async fetchOrdersSince(cutoff) {
      return readOnlyQuery(
        pool,
        `SELECT ${ORDER_COLUMNS} ${ORDERS_FROM}
         WHERE o.tracking_norm <> ''
           AND ${WINDOW_PG}
         ORDER BY o.id`,
        [cutoff]
      );
    },
    async fetchOrderByTracking(trackingIds) {
      const ids = trackingIds.filter(Boolean).slice(0, 10);
      if (ids.length === 0) return null;
      const rows = await readOnlyQuery(
        pool,
        `SELECT ${ORDER_COLUMNS} ${ORDERS_FROM}
         WHERE o.tracking_norm = ANY($1::text[])
         ORDER BY o.id DESC LIMIT 1`,
        [ids]
      );
      return rows[0] || null;
    },
    async fetchOrdersByTracking(trackingIds) {
      const ids = [...new Set(trackingIds.filter(Boolean))].slice(0, 500);
      if (ids.length === 0) return [];
      return readOnlyQuery(
        pool,
        `SELECT ${ORDER_COLUMNS} ${ORDERS_FROM} WHERE o.tracking_norm = ANY($1::text[])`,
        [ids]
      );
    },
    async fetchPhotosAfter(cursor, limit) {
      return readOnlyQuery(
        pool,
        `SELECT sku, title, image_url, marketplace, CAST(updated_at AS TEXT) AS updated_at
         FROM sku_photos
         WHERE image_url <> ''
           AND ($1::timestamp IS NULL OR updated_at > $1::timestamp OR (updated_at = $1::timestamp AND sku > $2))
         ORDER BY updated_at, sku
         LIMIT $3`,
        [cursor.updatedAt, cursor.sku || '', limit]
      );
    },
    async canWrite() {
      const rows = await readOnlyQuery(
        pool,
        `SELECT COALESCE(bool_or(has_table_privilege(t, 'INSERT, UPDATE, DELETE, TRUNCATE')), FALSE) AS can_write
         FROM unnest(ARRAY['oms_orders', 'channels', 'sku_photos']) AS t`
      );
      return Boolean(rows[0]?.can_write);
    },
    close,
  };
}

export function openForwardScanSource(config: ForwardScanSourceConfig, options: OpenOptions = {}): ForwardScanSource {
  return config.kind === 'postgres' ? openPostgres(config.target, options.profile) : openSqlite(config.target, options);
}
