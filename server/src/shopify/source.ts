// Read-only access to the Shopify PostgreSQL database.
//
// SHOPIFY_DATABASE_URL connects to the remote Shopify database:
//   postgresql://user:pass@host:5433/shopify?sslmode=require
//
// VMS only ever READS this database: it never writes, deletes, or changes
// anything there. Enforced multiple ways:
// 1. Every statement must pass assertReadOnlySql (one plain SELECT only, no DDL/DML).
// 2. Every read runs inside BEGIN TRANSACTION READ ONLY.
// 3. The session connection sets default_transaction_read_only=on.
// 4. Timeouts: statement_timeout=30s, connectionTimeoutMillis=5s.
// 5. SSL: remote database uses self-signed SSL cert, so rejectUnauthorized: false is set.
import { Pool } from 'pg';

export interface ShopifyItemRow {
  id?: number | string | null;
  sku?: string | null;
  title?: string | null;
  quantity?: number | string | null;
  price?: number | string | null;
  imageUrl?: string | null;
  variantTitle?: string | null;
}

export interface ShopifyOrderRow {
  shipment_id?: number | string | null;
  waybill_number?: string | null;
  courier?: string | null;
  shipment_status?: string | null;
  tracking_status?: string | null;
  shipment_created_at?: string | Date | null;
  shipment_updated_at?: string | Date | null;
  order_id?: number | string | null;
  shopify_order_id?: string | null;
  shopify_order_name?: string | null;
  shopify_order_number?: number | string | null;
  sales_channel?: string | null;
  order_status?: string | null;
  total_amount?: number | string | null;
  payment_method?: string | null;
  order_created_at?: string | Date | null;
  order_updated_at?: string | Date | null;
  items?: ShopifyItemRow[] | string | null;
}

export interface ShopifySource {
  fetchOrdersSince(cutoff: string): Promise<ShopifyOrderRow[]>;
  fetchOrderByTracking(trackingIds: string[]): Promise<ShopifyOrderRow | null>;
  fetchOrdersByTracking(trackingIds: string[]): Promise<ShopifyOrderRow[]>;
  canWrite?(): Promise<boolean>;
  close(): Promise<void>;
}

// Words that write, lock, change settings or run code, outside string literals.
const NON_READ_SQL = new RegExp(
  '\\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|COPY|CALL|DO|' +
  'EXECUTE|PREPARE|DEALLOCATE|LOCK|VACUUM|ANALYZE|REINDEX|CLUSTER|REFRESH|COMMENT|SECURITY|SET|RESET|' +
  'BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|ABORT|ATTACH|DETACH|PRAGMA|INTO|NOTIFY|LISTEN|UNLISTEN|' +
  'DISCARD|IMPORT|LOAD|NEXTVAL|SETVAL|SET_CONFIG|DBLINK\\w*|LO_\\w+|\\w*ADVISORY\\w*|PG_TERMINATE_BACKEND|' +
  'PG_CANCEL_BACKEND|PG_RELOAD_CONF|PG_ROTATE_LOGFILE|PG_FILE_WRITE|PG_NOTIFY|PG_STAT_RESET\\w*)\\b',
  'i'
);
const LOCKING_READ = /\bFOR\s+(NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b/i;
const UNSUPPORTED_QUOTING = /\$(?!\d)|\bE'|U&/i;

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
    throw new Error('Refused: only read (SELECT) statements may be sent to the Shopify database');
  }
}

export async function readOnlyQuery<T = any>(pool: Pick<Pool, 'connect'>, text: string, values: unknown[] = []): Promise<T[]> {
  assertReadOnlySql(text);
  const client = await pool.connect();
  let failure: Error | undefined;
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
    failure = failure || (err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    client.release(failure);
    client.removeListener('error', onError);
  }
}

export function normalizeShopifyPostgresUrl(url: string): string | null {
  try {
    const parsed = new URL(url.replace(/^postgres(?:ql)?(?:\+[A-Za-z0-9_]+)?:/i, 'postgresql:'));
    if (!parsed.hostname) return null;
    parsed.searchParams.delete('options');
    return parsed.toString();
  } catch {
    return null;
  }
}

export function shopifySslConfig(url: string) {
  try {
    const parsed = new URL(url.replace(/^postgres(?:ql)?(?:\+[A-Za-z0-9_]+)?:/i, 'postgresql:'));
    const sslMode = parsed.searchParams.get('sslmode')?.toLowerCase();
    const rejectUnauthorized = process.env.SHOPIFY_SSL_REJECT_UNAUTHORIZED === 'false' || sslMode === 'no-verify'
      ? false
      : true;
    const ca = process.env.SHOPIFY_SSL_CA_CERT;
    return {
      rejectUnauthorized,
      ...(ca ? { ca } : {}),
    };
  } catch {
    return { rejectUnauthorized: process.env.SHOPIFY_SSL_REJECT_UNAUTHORIZED !== 'false' };
  }
}

export function shopifyPostgresOptions(url: string, profile: 'sync' | 'scan' = 'sync') {
  const isScan = profile === 'scan';
  const statementMs = isScan ? 2_000 : 30_000;
  return {
    connectionString: url,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: isScan ? 1_500 : 5_000,
    application_name: isScan ? 'vms-shopify-scan' : 'vms-shopify-sync',
    options: `-c default_transaction_read_only=on -c statement_timeout=${statementMs} -c DateStyle=ISO`,
    query_timeout: statementMs + 500,
    ssl: shopifySslConfig(url),
  };
}

export function describeShopifySource(url: string | null | undefined): string {
  if (!url) return 'not configured';
  try {
    const parsed = new URL(url);
    return `shopify postgres ${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}`;
  } catch {
    return 'shopify postgres (unparsable URL)';
  }
}

const SHOPIFY_SELECT_QUERY = `
  SELECT 
    s.id AS shipment_id,
    s."waybillNumber" AS waybill_number,
    s.courier AS courier,
    s.status::text AS shipment_status,
    s."trackingStatus" AS tracking_status,
    s."createdAt" AS shipment_created_at,
    s."updatedAt" AS shipment_updated_at,
    o.id AS order_id,
    o."shopifyOrderId" AS shopify_order_id,
    o."shopifyOrderName" AS shopify_order_name,
    o."shopifyOrderNumber" AS shopify_order_number,
    o."salesChannel" AS sales_channel,
    o.status::text AS order_status,
    o."totalAmount" AS total_amount,
    o."paymentMethod" AS payment_method,
    o."createdAt" AS order_created_at,
    o."updatedAt" AS order_updated_at,
    COALESCE(
      json_agg(
        json_build_object(
          'id', oi.id,
          'sku', oi.sku,
          'title', oi.title,
          'quantity', oi.quantity,
          'price', oi.price,
          'imageUrl', oi."imageUrl",
          'variantTitle', oi."variantTitle"
        ) ORDER BY oi.id
      ) FILTER (WHERE oi.id IS NOT NULL),
      '[]'::json
    ) AS items
  FROM "Shipment" s
  JOIN "Order" o ON s."orderId" = o.id
  LEFT JOIN "OrderItem" oi ON oi."orderId" = o.id`;

export function createShopifySource(pool: Pick<Pool, 'connect'>, close: () => Promise<void>): ShopifySource {
  return {
    async fetchOrdersSince(cutoff: string): Promise<ShopifyOrderRow[]> {
      return readOnlyQuery(
        pool,
        `${SHOPIFY_SELECT_QUERY}
         WHERE s."waybillNumber" IS NOT NULL AND btrim(s."waybillNumber") <> ''
           AND (s."createdAt" >= $1::timestamp OR s."updatedAt" >= $1::timestamp OR o."createdAt" >= $1::timestamp OR o."updatedAt" >= $1::timestamp)
         GROUP BY s.id, o.id
         ORDER BY s.id ASC`,
        [cutoff]
      );
    },

    async fetchOrderByTracking(trackingIds: string[]): Promise<ShopifyOrderRow | null> {
      const ids = trackingIds.filter(Boolean).slice(0, 10);
      if (ids.length === 0) return null;
      const rows = await readOnlyQuery<ShopifyOrderRow>(
        pool,
        `${SHOPIFY_SELECT_QUERY}
         WHERE (upper(btrim(s."waybillNumber")) = ANY($1::text[])
            OR regexp_replace(upper(btrim(s."waybillNumber")), '\\s*\\([^()]*\\)\\s*', '', 'g') = ANY($1::text[]))
         GROUP BY s.id, o.id
         ORDER BY s.id DESC
         LIMIT 1`,
        [ids]
      );
      return rows[0] || null;
    },

    async fetchOrdersByTracking(trackingIds: string[]): Promise<ShopifyOrderRow[]> {
      const ids = [...new Set(trackingIds.filter(Boolean))].slice(0, 500);
      if (ids.length === 0) return [];
      return readOnlyQuery<ShopifyOrderRow>(
        pool,
        `${SHOPIFY_SELECT_QUERY}
         WHERE (upper(btrim(s."waybillNumber")) = ANY($1::text[])
            OR regexp_replace(upper(btrim(s."waybillNumber")), '\\s*\\([^()]*\\)\\s*', '', 'g') = ANY($1::text[]))
         GROUP BY s.id, o.id
         ORDER BY s.id ASC`,
        [ids]
      );
    },

    async canWrite(): Promise<boolean> {
      const rows = await readOnlyQuery(
        pool,
        `SELECT COALESCE(bool_or(has_table_privilege(t, 'INSERT, UPDATE, DELETE, TRUNCATE')), FALSE) AS can_write
         FROM unnest(ARRAY['"Order"', '"OrderItem"', '"Shipment"']) AS t`
      );
      return Boolean(rows[0]?.can_write);
    },

    close,
  };
}

const sharedShopifyScanPools = new Map<string, Pool>();

export function openShopifySource(rawUrl: string, profile: 'sync' | 'scan' = 'sync'): ShopifySource {
  const url = normalizeShopifyPostgresUrl(rawUrl);
  if (!url) throw new Error('Invalid SHOPIFY_DATABASE_URL');
  if (profile === 'scan') {
    const existing = sharedShopifyScanPools.get(url);
    const pool = existing || new Pool(shopifyPostgresOptions(url, 'scan'));
    if (!existing) {
      pool.on('error', (err) => console.warn('[shopify-sync] pool error:', err.message));
      sharedShopifyScanPools.set(url, pool);
    }
    return createShopifySource(pool, async () => undefined);
  }
  const pool = new Pool(shopifyPostgresOptions(url, 'sync'));
  pool.on('error', (err) => console.warn('[shopify-sync] pool error:', err.message));
  return createShopifySource(pool, () => pool.end());
}
