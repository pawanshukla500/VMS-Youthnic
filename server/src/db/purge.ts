// Retention purge for import bookkeeping (unit-tested).
//
// Raw upload bytes are already nulled immediately after each import; this
// job ages out what accumulates anyway:
//  1. marketplace_order_mappings older than N days — recordings are renamed
//     at import/reconcile time, so old mappings only bloat the table.
//  2. audit_logs older than M days.
//  3. Any order_import_batches.raw_file that survived a crashed import
//     (backstop: older than 1 hour gets nulled).
// Interval params are bound (never interpolated) — safe from injection.

export interface PurgeStatement {
  key: 'mappings' | 'audit' | 'rawFiles' | 'omsguruOrders' | 'omsguruPhotos';
  text: string;
  values: unknown[];
}

export function buildPurgeStatements(mappingRetentionDays: number, auditRetentionDays: number): PurgeStatement[] {
  const mappings = Math.max(1, Math.floor(mappingRetentionDays));
  const audit = Math.max(1, Math.floor(auditRetentionDays));

  return [
    {
      key: 'mappings',
      text: `DELETE FROM marketplace_order_mappings WHERE imported_at < NOW() - ($1 * INTERVAL '1 day')`,
      values: [mappings],
    },
    {
      key: 'audit',
      text: `DELETE FROM audit_logs WHERE created_at < NOW() - ($1 * INTERVAL '1 day')`,
      values: [audit],
    },
    {
      key: 'rawFiles',
      text: `UPDATE order_import_batches
             SET raw_file = NULL, raw_purged_at = NOW()
             WHERE raw_file IS NOT NULL AND created_at < NOW() - INTERVAL '1 hour'`,
      values: [],
    },
    {
      key: 'omsguruOrders',
      text: `DELETE FROM omsguru_order_cache WHERE fetched_at < NOW() - INTERVAL '24 hours'`,
      values: [],
    },
    {
      key: 'omsguruPhotos',
      text: `DELETE FROM omsguru_sku_photos WHERE fetched_at < NOW() - INTERVAL '30 days'`,
      values: [],
    },
  ];
}

// Read-only previews for ?dryRun=1 (same WHERE clauses, COUNT instead).
export function buildPurgeCountStatements(mappingRetentionDays: number, auditRetentionDays: number): PurgeStatement[] {
  const mappings = Math.max(1, Math.floor(mappingRetentionDays));
  const audit = Math.max(1, Math.floor(auditRetentionDays));

  return [
    {
      key: 'mappings',
      text: `SELECT COUNT(*) as count FROM marketplace_order_mappings WHERE imported_at < NOW() - ($1 * INTERVAL '1 day')`,
      values: [mappings],
    },
    {
      key: 'audit',
      text: `SELECT COUNT(*) as count FROM audit_logs WHERE created_at < NOW() - ($1 * INTERVAL '1 day')`,
      values: [audit],
    },
    {
      key: 'rawFiles',
      text: `SELECT COUNT(*) as count FROM order_import_batches WHERE raw_file IS NOT NULL AND created_at < NOW() - INTERVAL '1 hour'`,
      values: [],
    },
    {
      key: 'omsguruOrders',
      text: `SELECT COUNT(*) as count FROM omsguru_order_cache WHERE fetched_at < NOW() - INTERVAL '24 hours'`,
      values: [],
    },
    {
      key: 'omsguruPhotos',
      text: `SELECT COUNT(*) as count FROM omsguru_sku_photos WHERE fetched_at < NOW() - INTERVAL '30 days'`,
      values: [],
    },
  ];
}

export function purgeRetentionDays(value: unknown, fallback: number): number {
  const days = Number(value);
  return Number.isFinite(days) && days >= 1 ? Math.floor(days) : fallback;
}
