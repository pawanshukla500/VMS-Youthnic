import { Pool } from 'pg';
import { randomBytes } from 'crypto';

export interface MeeshoFlyerQueueItem {
  id: string;
  trackingId: string;
  flyerId: string;
  orderId: string | null;
  marketplace: string | null;
  status: 'PENDING' | 'LINKED' | 'FAILED' | 'SKIPPED' | string;
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
  // Flyer saved with the video but never sent to Meesho (link-up off / day skipped).
  skippedCount: number;
}

export interface MeeshoFlyerLinkUpdate {
  trackingId?: string;
  flyerId?: string;
  id?: string;
  status: 'LINKED' | 'FAILED' | 'PENDING' | 'SKIPPED';
  remark?: string;
}

// ---------------------------------------------------------------------------
// Flyer link-up switch (admin, Settings). Flyer scans are ALWAYS saved with the
// video; this only decides whether the companion app links them on Meesho.
//   enabled = false      -> new flyer scans are stored as SKIPPED (never sent);
//                           scans already waiting stay PENDING and go out once
//                           link-up is turned back on.
//   skip_date = today    -> today's flyer scans (IST) are SKIPPED, including the
//                           ones already waiting; tomorrow link-up resumes by
//                           itself. "Resume today" re-queues what the skip held.
// ---------------------------------------------------------------------------

export const FLYER_LINK_STATUSES = ['PENDING', 'LINKED', 'FAILED', 'SKIPPED'] as const;

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

// YYYY-MM-DD of the IST calendar day containing `ms`.
export function istDateString(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export interface FlyerLinkupState {
  enabled: boolean;
  skipDate: string | null;
  skippedToday: boolean;
  // Companion links flyers right now.
  active: boolean;
  today: string;
  changedAt: string | null;
}

export function flyerLinkupState(
  row: { flyer_linkup_enabled?: boolean | null; flyer_linkup_skip_date?: string | Date | null; flyer_linkup_changed_at?: string | Date | null } | null | undefined,
  nowMs: number = Date.now()
): FlyerLinkupState {
  const today = istDateString(nowMs);
  const raw = row?.flyer_linkup_skip_date;
  // pg returns DATE as a JS Date at local midnight unless parsed as text.
  const skipDate = raw instanceof Date
    ? `${raw.getFullYear()}-${String(raw.getMonth() + 1).padStart(2, '0')}-${String(raw.getDate()).padStart(2, '0')}`
    : typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
  const enabled = row?.flyer_linkup_enabled !== false;
  const skippedToday = skipDate === today;
  return {
    enabled,
    skipDate,
    skippedToday,
    active: enabled && !skippedToday,
    today,
    changedAt: row?.flyer_linkup_changed_at ? new Date(row.flyer_linkup_changed_at).toISOString() : null,
  };
}

// Why a flyer scanned at `recordedAtMs` must not be linked (null = link it).
// OFF only holds flyers recorded after it was switched off: a recording made
// while ON and (re-)uploaded later keeps waiting for link-up as promised.
export function flyerSkipReason(state: FlyerLinkupState, recordedAtMs: number): { remark: string; skippedDay: string | null } | null {
  if (!state.enabled) {
    const offSince = state.changedAt ? Date.parse(state.changedAt) : NaN;
    if (Number.isFinite(offSince) && recordedAtMs < offSince) return null;
    return { remark: 'Link-up was off: flyer saved with the video only', skippedDay: null };
  }
  const day = istDateString(recordedAtMs);
  if (state.skipDate && state.skipDate === day) {
    return { remark: `Link-up skipped for ${day}: flyer saved with the video only`, skippedDay: day };
  }
  return null;
}

export async function getFlyerLinkup(pool: Pool, organizationId: string): Promise<FlyerLinkupState> {
  const res = await pool.query(
    `SELECT flyer_linkup_enabled, flyer_linkup_skip_date::text AS flyer_linkup_skip_date, flyer_linkup_changed_at
     FROM meesho_settings WHERE organization_id = $1`,
    [organizationId]
  );
  return flyerLinkupState(res.rows[0]);
}

export async function setFlyerLinkup(
  pool: Pool,
  organizationId: string,
  change: { enabled?: boolean; skipToday?: boolean },
  userId?: string | null
): Promise<{ state: FlyerLinkupState; skipped: number; requeued: number }> {
  const today = istDateString(Date.now());
  const client = await pool.connect();
  let skipped = 0;
  let requeued = 0;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO meesho_settings (organization_id, flyer_linkup_enabled, flyer_linkup_skip_date, flyer_linkup_changed_at, flyer_linkup_changed_by, updated_at)
       VALUES ($1, COALESCE($2::boolean, TRUE), CASE WHEN $3::boolean THEN $4::date ELSE NULL END, NOW(), $5, NOW())
       ON CONFLICT (organization_id) DO UPDATE SET
         flyer_linkup_enabled = COALESCE($2::boolean, meesho_settings.flyer_linkup_enabled),
         flyer_linkup_skip_date = CASE
           WHEN $3::boolean IS NULL THEN meesho_settings.flyer_linkup_skip_date
           WHEN $3::boolean THEN $4::date
           ELSE NULL END,
         flyer_linkup_changed_at = NOW(),
         flyer_linkup_changed_by = $5,
         updated_at = NOW()`,
      [organizationId, typeof change.enabled === 'boolean' ? change.enabled : null,
        typeof change.skipToday === 'boolean' ? change.skipToday : null, today, userId || null]
    );
    if (change.skipToday === true) {
      // Skip the whole day: today's waiting scans are held too.
      const res = await client.query(
        `UPDATE recording_sessions
         SET flyer_link_status = 'SKIPPED', flyer_link_skipped_day = $2::date,
             flyer_link_remark = $3, updated_at = NOW()
         WHERE organization_id = $1
           AND flyer_id IS NOT NULL AND flyer_id <> ''
           AND COALESCE(flyer_link_status, 'PENDING') = 'PENDING'
           AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date`,
        [organizationId, today, `Link-up skipped for ${today}: flyer saved with the video only`]
      );
      skipped = res.rowCount ?? 0;
    } else if (change.skipToday === false) {
      // Resume today: only what today's skip held goes back in the queue.
      const res = await client.query(
        `UPDATE recording_sessions
         SET flyer_link_status = 'PENDING', flyer_link_skipped_day = NULL,
             flyer_link_remark = NULL, updated_at = NOW()
         WHERE organization_id = $1
           AND flyer_link_status = 'SKIPPED'
           AND flyer_link_skipped_day = $2::date`,
        [organizationId, today]
      );
      requeued = res.rowCount ?? 0;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return { state: await getFlyerLinkup(pool, organizationId), skipped, requeued };
}

// Called when a recording with a flyer is saved: hold it back when link-up is
// off or its day is skipped (the flyer stays stored either way). Never
// touches a flyer that is already linked or failed.
export async function holdFlyerIfLinkupOff(
  pool: Pool,
  organizationId: string,
  sessionId: string,
  recordedAtMs: number
): Promise<boolean> {
  const reason = flyerSkipReason(await getFlyerLinkup(pool, organizationId), recordedAtMs);
  if (!reason) return false;
  const res = await pool.query(
    `UPDATE recording_sessions
     SET flyer_link_status = 'SKIPPED', flyer_link_skipped_day = $3::date,
         flyer_link_remark = $4, updated_at = NOW()
     WHERE id = $1 AND organization_id = $2
       AND flyer_id IS NOT NULL AND flyer_id <> ''
       AND COALESCE(flyer_link_status, 'PENDING') = 'PENDING'`,
    [sessionId, organizationId, reason.skippedDay, reason.remark]
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Fetch queue items for Meesho Transparent Packaging flyer link-up.
 */
export function normalizeQueueDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return trimmed;
}

export async function getMeeshoFlyerQueue(
  pool: Pool,
  organizationId: string,
  options: { status?: string; limit?: number; fromDate?: string } = {}
): Promise<{ items: MeeshoFlyerQueueItem[]; stats: MeeshoFlyerStats }> {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  const statusFilter = (options.status || 'ALL').toUpperCase();
  // Cutoff so the desktop link-up starts from a given scan day (e.g.
  // 2026-10-05) and never chews through older backlog rows.
  const fromDate = normalizeQueueDate(options.fromDate);

  const queryParams: unknown[] = [organizationId];
  let filterClause = '';

  if (statusFilter === 'PENDING') {
    filterClause = `AND COALESCE(rs.flyer_link_status, 'PENDING') = 'PENDING'`;
  } else if (statusFilter === 'LINKED') {
    filterClause = `AND rs.flyer_link_status = 'LINKED'`;
  } else if (statusFilter === 'FAILED') {
    filterClause = `AND rs.flyer_link_status = 'FAILED'`;
  } else if (statusFilter === 'SKIPPED') {
    filterClause = `AND rs.flyer_link_status = 'SKIPPED'`;
  }

  queryParams.push(limit);

  let dateClause = '';
  let statsDateClause = '';
  const statsParams: unknown[] = [organizationId];
  if (fromDate) {
    queryParams.push(fromDate);
    dateClause = `AND rs.created_at >= $${queryParams.length}::date`;
    statsParams.push(fromDate);
    statsDateClause = `AND created_at >= $${statsParams.length}::date`;
  }

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
         ${dateClause}
       ORDER BY rs.created_at DESC
       LIMIT $2`,
      queryParams
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE flyer_id IS NOT NULL AND flyer_id <> '') as total_scans,
         COUNT(*) FILTER (WHERE flyer_id IS NOT NULL AND flyer_id <> '' AND COALESCE(flyer_link_status, 'PENDING') = 'PENDING') as pending_count,
         COUNT(*) FILTER (WHERE flyer_id IS NOT NULL AND flyer_id <> '' AND flyer_link_status = 'LINKED') as linked_count,
         COUNT(*) FILTER (WHERE flyer_id IS NOT NULL AND flyer_id <> '' AND flyer_link_status = 'FAILED') as failed_count,
         COUNT(*) FILTER (WHERE flyer_id IS NOT NULL AND flyer_id <> '' AND flyer_link_status = 'SKIPPED') as skipped_count
       FROM recording_sessions
       WHERE organization_id = $1
       ${statsDateClause}`,
      statsParams
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
    failedCount: Number(statsRow.failed_count || 0),
    skippedCount: Number(statsRow.skipped_count || 0)
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
    const status = String(update.status || 'LINKED').toUpperCase();
    if (!(FLYER_LINK_STATUSES as readonly string[]).includes(status)) continue;
    const remark = typeof update.remark === 'string' ? update.remark.trim().slice(0, 500) : null;
    const linkedAtExpr = status === 'LINKED' ? 'NOW()' : 'NULL';

    if (update.id) {
      const res = await pool.query(
        `UPDATE recording_sessions
         SET flyer_link_status = $1,
             flyer_linked_at = ${linkedAtExpr},
             flyer_link_remark = $2,
             flyer_link_skipped_day = CASE WHEN $1 = 'SKIPPED' THEN flyer_link_skipped_day ELSE NULL END,
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
  options: { status?: string; fromDate?: string } = {}
): Promise<string> {
  const { items } = await getMeeshoFlyerQueue(pool, organizationId, { status: options.status, limit: 500, fromDate: options.fromDate });

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
  // Packing page: Meesho parcels switch flyer-bag scanning ON by themselves.
  autoFlyerScan: boolean;
  // Companion link-up on Meesho (admin switch + skip-today).
  flyerLinkup: FlyerLinkupState;
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
    `SELECT username, password, supplier_hub_url, auto_flyer_scan, updated_at,
            flyer_linkup_enabled, flyer_linkup_skip_date::text AS flyer_linkup_skip_date, flyer_linkup_changed_at
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
    autoFlyerScan: row?.auto_flyer_scan !== false,
    flyerLinkup: flyerLinkupState(row),
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

/**
 * Packing preference only (safe for every role, no credentials). Defaults
 * to ON when the organization never saved Meesho settings.
 */
export async function getAutoFlyerScan(pool: Pool, organizationId: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT auto_flyer_scan FROM meesho_settings WHERE organization_id = $1`,
    [organizationId]
  );
  return res.rows[0]?.auto_flyer_scan !== false;
}

/**
 * Turn automatic flyer scan on/off without touching saved credentials.
 */
export async function setAutoFlyerScan(
  pool: Pool,
  organizationId: string,
  enabled: boolean,
  userId?: string
): Promise<boolean> {
  await pool.query(
    `INSERT INTO meesho_settings (organization_id, auto_flyer_scan, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (organization_id) DO UPDATE SET
       auto_flyer_scan = EXCLUDED.auto_flyer_scan,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [organizationId, enabled, userId || null]
  );
  return enabled;
}

/**
 * Save Meesho settings for an organization (preserves existing password if empty or masked).
 */
export async function saveMeeshoSettings(
  pool: Pool,
  organizationId: string,
  settings: { username?: string; password?: string; supplierHubUrl?: string; autoFlyerScan?: boolean },
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
  // Omitted -> keep the stored value (credential-only saves never flip it).
  const autoFlyerScan = typeof settings.autoFlyerScan === 'boolean' ? settings.autoFlyerScan : null;

  await pool.query(
    `INSERT INTO meesho_settings (organization_id, username, password, supplier_hub_url, auto_flyer_scan, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, COALESCE($5::boolean, TRUE), $6, NOW())
     ON CONFLICT (organization_id) DO UPDATE SET
       username = EXCLUDED.username,
       password = EXCLUDED.password,
       supplier_hub_url = EXCLUDED.supplier_hub_url,
       auto_flyer_scan = COALESCE($5::boolean, meesho_settings.auto_flyer_scan),
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [organizationId, username, password, supplierHubUrl, autoFlyerScan, userId || null]
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

