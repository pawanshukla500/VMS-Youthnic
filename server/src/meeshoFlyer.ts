import { Pool } from 'pg';
import { randomBytes } from 'crypto';

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

export interface MeeshoSettings {
  configured: boolean;
  username: string;
  hasPassword: boolean;
  passwordMasked: string;
  supplierHubUrl: string;
  updatedAt: string | null;
}

/**
 * Get Meesho settings for an organization (with masked password for UI display).
 */
export async function getMeeshoSettings(
  pool: Pool,
  organizationId: string
): Promise<MeeshoSettings> {
  const res = await pool.query(
    `SELECT username, password, supplier_hub_url, updated_at
     FROM meesho_settings
     WHERE organization_id = $1`,
    [organizationId]
  );

  const row = res.rows[0];
  const username = (row?.username || '').trim();
  const password = (row?.password || '').trim();
  const hasPassword = Boolean(password);
  const configured = Boolean(username && hasPassword);

  return {
    configured,
    username,
    hasPassword,
    passwordMasked: hasPassword ? '••••••••' : '',
    supplierHubUrl: row?.supplier_hub_url || 'https://supplier.meesho.com/panel/v3/new/root/login',
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

/**
 * Save Meesho settings for an organization (preserves existing password if empty or masked).
 */
export async function saveMeeshoSettings(
  pool: Pool,
  organizationId: string,
  settings: { username?: string; password?: string; supplierHubUrl?: string },
  userId?: string
): Promise<{ success: boolean; configured: boolean }> {
  // Check existing password in case caller left it blank or masked
  const currentRes = await pool.query(
    `SELECT password FROM meesho_settings WHERE organization_id = $1`,
    [organizationId]
  );
  const currentPassword = (currentRes.rows[0]?.password || '').trim();

  const username = typeof settings.username === 'string' ? settings.username.trim() : '';
  const incomingPassword = typeof settings.password === 'string' ? settings.password.trim() : '';
  const password = incomingPassword && !incomingPassword.includes('••••')
    ? incomingPassword
    : currentPassword;
  const supplierHubUrl = typeof settings.supplierHubUrl === 'string' && settings.supplierHubUrl.trim()
    ? settings.supplierHubUrl.trim()
    : 'https://supplier.meesho.com/panel/v3/new/root/login';

  await pool.query(
    `INSERT INTO meesho_settings (organization_id, username, password, supplier_hub_url, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (organization_id) DO UPDATE SET
       username = EXCLUDED.username,
       password = EXCLUDED.password,
       supplier_hub_url = EXCLUDED.supplier_hub_url,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [organizationId, username, password, supplierHubUrl, userId || null]
  );

  const configured = Boolean(username && password);
  return { success: true, configured };
}

/**
 * Fetch raw credentials for automated login by the companion desktop app.
 */
export async function getMeeshoCredentials(
  pool: Pool,
  organizationId: string
): Promise<{ configured: boolean; username: string; password: string; supplierHubUrl: string }> {
  const res = await pool.query(
    `SELECT username, password, supplier_hub_url
     FROM meesho_settings
     WHERE organization_id = $1`,
    [organizationId]
  );

  const row = res.rows[0];
  const username = (row?.username || '').trim();
  const password = (row?.password || '').trim();
  const configured = Boolean(username && password);
  const supplierHubUrl = row?.supplier_hub_url || 'https://supplier.meesho.com/panel/v3/new/root/login';

  return {
    configured,
    username,
    password,
    supplierHubUrl
  };
}

export interface MeeshoCompanionTokenInfo {
  token: string;
  organizationId: string;
  orgName: string;
}

/**
 * Retrieve or create a persistent companion token for the organization.
 */
export async function getOrCreateCompanionToken(
  pool: Pool,
  organizationId: string
): Promise<MeeshoCompanionTokenInfo> {
  const res = await pool.query(
    `SELECT ms.companion_token, o.name as org_name
     FROM organizations o
     LEFT JOIN meesho_settings ms ON ms.organization_id = o.id
     WHERE o.id = $1`,
    [organizationId]
  );

  const row = res.rows[0];
  const orgName = row?.org_name || 'Active Organization';
  let token = (row?.companion_token || '').trim();

  if (!token) {
    token = `vms_comp_${randomBytes(24).toString('hex')}`;
    await pool.query(
      `INSERT INTO meesho_settings (organization_id, companion_token, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (organization_id) DO UPDATE SET
         companion_token = EXCLUDED.companion_token,
         updated_at = NOW()`,
      [organizationId, token]
    );
  }

  return { token, organizationId, orgName };
}

/**
 * Regenerate companion token (revoking old token).
 */
export async function regenerateCompanionToken(
  pool: Pool,
  organizationId: string
): Promise<MeeshoCompanionTokenInfo> {
  const token = `vms_comp_${randomBytes(24).toString('hex')}`;
  const res = await pool.query(
    `SELECT name FROM organizations WHERE id = $1`,
    [organizationId]
  );
  const orgName = res.rows[0]?.name || 'Active Organization';

  await pool.query(
    `INSERT INTO meesho_settings (organization_id, companion_token, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (organization_id) DO UPDATE SET
       companion_token = EXCLUDED.companion_token,
       updated_at = NOW()`,
    [organizationId, token]
  );

  return { token, organizationId, orgName };
}

