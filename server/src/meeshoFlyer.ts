import { Pool } from 'pg';

export interface MeeshoFlyerQueueItem {
  id: string;
  trackingId: string;
  flyerId: string;
  orderId: string | null;
  marketplace: string | null;
  status: 'PENDING' | 'LINKED' | 'FAILED' | string;
  linkedAt: string | null;
  remark: string | null;
  createdAt: string;
  packerName: string | null;
  stationCode: string | null;
}

export interface MeeshoFlyerStats {
  totalScans: number;
  pendingCount: number;
  linkedCount: number;
  failedCount: number;
}

export interface MeeshoFlyerLinkUpdate {
  trackingId?: string;
  flyerId?: string;
  id?: string;
  status: 'LINKED' | 'FAILED' | 'PENDING';
  remark?: string;
}

/**
 * Fetch queue items for Meesho Transparent Packaging flyer link-up.
 */
export async function getMeeshoFlyerQueue(
  pool: Pool,
  organizationId: string,
  options: { status?: string; limit?: number } = {}
): Promise<{ items: MeeshoFlyerQueueItem[]; stats: MeeshoFlyerStats }> {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  const statusFilter = (options.status || 'ALL').toUpperCase();

  const queryParams: unknown[] = [organizationId];
  let filterClause = '';

  if (statusFilter === 'PENDING') {
    filterClause = `AND COALESCE(rs.flyer_link_status, 'PENDING') = 'PENDING'`;
  } else if (statusFilter === 'LINKED') {
    filterClause = `AND rs.flyer_link_status = 'LINKED'`;
  } else if (statusFilter === 'FAILED') {
    filterClause = `AND rs.flyer_link_status = 'FAILED'`;
  }

  queryParams.push(limit);

  const [itemsRes, statsRes] = await Promise.all([
    pool.query(
      `SELECT rs.id, rs.tracking_id, rs.flyer_id, rs.order_id, rs.marketplace,
              COALESCE(rs.flyer_link_status, 'PENDING') as flyer_link_status,
              rs.flyer_linked_at, rs.flyer_link_remark, rs.created_at,
              COALESCE(u.name, u.email) as packer_name,
              s.code as station_code
       FROM recording_sessions rs
       LEFT JOIN users u ON rs.operator_user_id = u.id
       LEFT JOIN stations s ON rs.station_id = s.id AND s.organization_id = rs.organization_id
       WHERE rs.organization_id = $1
         AND rs.flyer_id IS NOT NULL
         AND rs.flyer_id <> ''
         ${filterClause}
       ORDER BY rs.created_at DESC
       LIMIT $2`,
      queryParams
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE flyer_id IS NOT NULL AND flyer_id <> '') as total_scans,
         COUNT(*) FILTER (WHERE flyer_id IS NOT NULL AND flyer_id <> '' AND COALESCE(flyer_link_status, 'PENDING') = 'PENDING') as pending_count,
         COUNT(*) FILTER (WHERE flyer_id IS NOT NULL AND flyer_id <> '' AND flyer_link_status = 'LINKED') as linked_count,
         COUNT(*) FILTER (WHERE flyer_id IS NOT NULL AND flyer_id <> '' AND flyer_link_status = 'FAILED') as failed_count
       FROM recording_sessions
       WHERE organization_id = $1`,
      [organizationId]
    )
  ]);

  const items: MeeshoFlyerQueueItem[] = itemsRes.rows.map((r: any) => ({
    id: r.id,
    trackingId: r.tracking_id,
    flyerId: r.flyer_id,
    orderId: r.order_id || null,
    marketplace: r.marketplace || null,
    status: r.flyer_link_status || 'PENDING',
    linkedAt: r.flyer_linked_at ? new Date(r.flyer_linked_at).toISOString() : null,
    remark: r.flyer_link_remark || null,
    createdAt: new Date(r.created_at).toISOString(),
    packerName: r.packer_name || null,
    stationCode: r.station_code || null
  }));

  const statsRow = statsRes.rows[0] || {};
  const stats: MeeshoFlyerStats = {
    totalScans: Number(statsRow.total_scans || 0),
    pendingCount: Number(statsRow.pending_count || 0),
    linkedCount: Number(statsRow.linked_count || 0),
    failedCount: Number(statsRow.failed_count || 0)
  };

  return { items, stats };
}

/**
 * Update link status for a batch of flyer scans.
 */
export async function updateMeeshoFlyerStatus(
  pool: Pool,
  organizationId: string,
  updates: MeeshoFlyerLinkUpdate[]
): Promise<{ updatedCount: number }> {
  if (!Array.isArray(updates) || updates.length === 0) {
    return { updatedCount: 0 };
  }

  let updatedCount = 0;
  for (const update of updates) {
    const status = (update.status || 'LINKED').toUpperCase();
    const remark = typeof update.remark === 'string' ? update.remark.trim().slice(0, 500) : null;
    const linkedAtExpr = status === 'LINKED' ? 'NOW()' : 'NULL';

    if (update.id) {
      const res = await pool.query(
        `UPDATE recording_sessions
         SET flyer_link_status = $1,
             flyer_linked_at = ${linkedAtExpr},
             flyer_link_remark = $2,
             updated_at = NOW()
         WHERE id = $3 AND organization_id = $4`,
        [status, remark, update.id, organizationId]
      );
      updatedCount += res.rowCount || 0;
    } else if (update.trackingId) {
      const res = await pool.query(
        `UPDATE recording_sessions
         SET flyer_link_status = $1,
             flyer_linked_at = ${linkedAtExpr},
             flyer_link_remark = $2,
             updated_at = NOW()
         WHERE tracking_id = $3 AND organization_id = $4`,
        [status, remark, update.trackingId.trim(), organizationId]
      );
      updatedCount += res.rowCount || 0;
    } else if (update.flyerId) {
      const res = await pool.query(
        `UPDATE recording_sessions
         SET flyer_link_status = $1,
             flyer_linked_at = ${linkedAtExpr},
             flyer_link_remark = $2,
             updated_at = NOW()
         WHERE flyer_id = $3 AND organization_id = $4`,
        [status, remark, update.flyerId.trim(), organizationId]
      );
      updatedCount += res.rowCount || 0;
    }
  }

  return { updatedCount };
}

/**
 * Automatically repairs historical rows where the operator scanned the Flyer ID first
 * (stored in tracking_id) and the Tracking AWB second (stored in flyer_id).
 */
export async function fixSwappedFlyerBarcodes(
  pool: Pool,
  organizationId: string
): Promise<{ fixedCount: number; fixedRows: Array<{ id: string; oldTracking: string; newTracking: string }> }> {
  // Matches tracking_id starting with 'TP' (Meesho Transparent Packaging)
  // and flyer_id starting with 'VL' (Valmo), 'SF' (Shadowfax), or 10+ digits numeric AWB.
  const res = await pool.query(
    `UPDATE recording_sessions
     SET tracking_id = flyer_id,
         flyer_id = tracking_id,
         updated_at = NOW()
     WHERE organization_id = $1
       AND tracking_id ILIKE 'TP%'
       AND (flyer_id ILIKE 'VL%' OR flyer_id ILIKE 'SF%' OR flyer_id ~ '^[0-9]{10,}$')
     RETURNING id, tracking_id as new_tracking, flyer_id as old_tracking`,
    [organizationId]
  );

  const fixedRows = res.rows.map((r: any) => ({
    id: r.id,
    oldTracking: r.old_tracking,
    newTracking: r.new_tracking
  }));

  return { fixedCount: fixedRows.length, fixedRows };
}

/**
 * Export CSV of Meesho Tracking ID <-> Flyer ID pairs.
 */
export async function exportMeeshoFlyerCsv(
  pool: Pool,
  organizationId: string,
  options: { status?: string } = {}
): Promise<string> {
  const { items } = await getMeeshoFlyerQueue(pool, organizationId, { status: options.status, limit: 500 });

  const headers = ['Tracking ID', 'Flyer ID', 'Order ID', 'Marketplace', 'Status', 'Date Time', 'Remark'];
  const lines: string[] = [headers.join(',')];

  for (const item of items) {
    const row = [
      escapeCsv(item.trackingId),
      escapeCsv(item.flyerId),
      escapeCsv(item.orderId || ''),
      escapeCsv(item.marketplace || 'Meesho'),
      escapeCsv(item.status),
      escapeCsv(item.createdAt),
      escapeCsv(item.remark || '')
    ];
    lines.push(row.join(','));
  }

  return lines.join('\r\n');
}

function escapeCsv(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}
