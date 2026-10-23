// Ajio WFR watchdog: run ledger, SLA health, and failure/alert plumbing.
//
// Why this exists: a missed CCTV reply risks an Ajio penalty or account
// suspension, and the Sep-2026 outage proved a dead Gmail grant can fail the
// nightly job silently for days. Three layers back each other up:
//   1. VPS host cron (primary, 4x daily) + in-process safety net (backstop).
//   2. Every invocation records a row in ajio_wfr_runs — the UI and the
//      dead-man's-switch read the ledger, never vibes.
//   3. Any FAILED run, any OAuth->App-Password fallback, and any SLA breach
//      (pending request older than AJIO_WFR_SLA_HOURS) emails the alert list
//      immediately. Quiet otherwise, so alerts stay meaningful.
import type { Pool } from 'pg';
import { runAjioWfrJob, type AjioJobOptions, type AjioJobSummary } from './processor';
import { isGrantError, AJIO_GRANT_ERROR_MARKER } from './gmailApi';
import { sanitizeErrorMessage } from '../security';

export type WfrRunTrigger = 'cron' | 'safety-net' | 'admin' | 'manual';
export type WfrRunStatus = 'success' | 'failed';

export interface RecordedWfrRun {
  summary: AjioJobSummary;
  status: WfrRunStatus;
  error: string | null;
  usedFallback: boolean;
  slaBreached: boolean;
  oldestPendingHours: number | null;
  alertSent: boolean;
}

export interface WfrHealth {
  lastRunAt: string | null;
  lastRunStatus: WfrRunStatus | null;
  lastRunTrigger: WfrRunTrigger | null;
  lastRunUsedFallback: boolean;
  lastError: string | null;
  lastLiveSuccessAt: string | null;
  pendingCount: number;
  oldestPendingHours: number | null;
  slaHours: number;
  slaBreached: boolean;
  stale: boolean;
  alertsConfigured: boolean;
}

// Public text for a dead Gmail grant: sanitizeErrorMessage would blank the
// raw Google message (it names the mailbox), but the operator must still
// learn to reconnect — keeps the marker the Ajio page banner keys on.
export const AJIO_GRANT_REJECTED_PUBLIC = `Gmail access was revoked or expired. Open the Ajio page and click ${AJIO_GRANT_ERROR_MARKER}`;
export const AJIO_WFR_BUSY_MESSAGE = 'Another Ajio WFR run is already in progress';

// Client-facing error for a WFR failure (HTTP bodies + health banner): main's
// CWE-209 sanitizer, except a dead grant keeps a fixed actionable message and
// maps to 503 like a missing config, so cron logs say "reconnect".
export function wfrPublicError(err: unknown, fallback: string): { status: number; message: string } {
  if (isGrantError(err)) return { status: 503, message: AJIO_GRANT_REJECTED_PUBLIC };
  const message = sanitizeErrorMessage(err, fallback);
  return { status: message.includes('not configured') ? 503 : 500, message };
}

const AJIO_WFR_LOCK_KEY = 'ajio-wfr-job';

// One WFR run at a time across every trigger (VPS cron, safety net, admin
// button) and every backend process. The mailbox listing has no read-state
// filter, so two overlapping runs would both find the same not-yet-done
// ledger row and both reply — never acceptable. Session-level advisory lock
// on ONE dedicated connection (lock and unlock must share a session); the
// job itself runs on the pool. Never waits: { ran: false } when busy.
export async function withAjioWfrLock<T>(
  pool: Pool,
  fn: () => Promise<T>
): Promise<{ ran: true; value: T } | { ran: false }> {
  const client = await pool.connect();
  let locked = false;
  let unlockFailed = false;
  try {
    const res = await client.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [AJIO_WFR_LOCK_KEY]);
    locked = res.rows[0]?.locked === true;
    if (!locked) return { ran: false };
    return { ran: true, value: await fn() };
  } finally {
    if (locked) {
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [AJIO_WFR_LOCK_KEY]).catch((err) => {
        unlockFailed = true;
        console.error('[ajio-wfr] advisory unlock failed; dropping the connection to free the lock:', err);
      });
    }
    // A pooled session that still holds the lock would block every future
    // run ("already in progress" forever) — destroy it instead of reusing.
    client.release(unlockFailed ? true : undefined);
  }
}

export function wfrSlaHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AJIO_WFR_SLA_HOURS || '12');
  return Number.isFinite(raw) ? Math.min(72, Math.max(1, Math.floor(raw))) : 12;
}

export function wfrSafetyNetHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AJIO_WFR_INTERVAL_HOURS || '6');
  return Number.isFinite(raw) ? Math.min(24, Math.max(1, Math.floor(raw))) : 6;
}

export const DEFAULT_AJIO_ALERT_EMAIL = 'returnorders@vbexports.co.in';

export function wfrAlertRecipients(
  env: NodeJS.ProcessEnv = process.env,
  customEmails?: string | null
): string[] {
  const raw = (customEmails !== undefined && customEmails !== null && customEmails.trim().length > 0)
    ? customEmails
    : (env.AJIO_ALERT_EMAILS || env.REPORT_TO_EMAILS || DEFAULT_AJIO_ALERT_EMAIL);
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

export function wfrAlertFrom(env: NodeJS.ProcessEnv = process.env): string {
  return (env.REPORT_FROM_EMAIL || '').trim() || 'PVMS Ajio WFR <reports@pkvm.youthnic.shop>';
}

// Alerts need a Resend key AND at least one valid recipient; without either
// the job still runs and records, but nobody is emailed — surfaced on the
// health endpoint + startup log so "quiet" never silently means "deaf".
export function wfrAlertsConfigured(
  env: NodeJS.ProcessEnv = process.env,
  customEmails?: string | null,
  customResendKey?: string | null
): boolean {
  const key = (customResendKey || '').trim() || (env.RESEND_API_KEY || '').trim();
  return Boolean(key) && wfrAlertRecipients(env, customEmails).length > 0;
}

export async function recordWfrRun(
  pool: Pool,
  input: {
    organizationId: string | null;
    trigger: WfrRunTrigger;
    dryRun: boolean;
    status: WfrRunStatus;
    summary: AjioJobSummary;
    usedFallback: boolean;
    error: string | null;
  }
): Promise<void> {
  await pool.query(
    `INSERT INTO ajio_wfr_runs (organization_id, trigger, dry_run, status, checked, replied, missing, failed, used_fallback, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.organizationId,
      input.trigger,
      input.dryRun,
      input.status,
      input.summary.checked,
      input.summary.replied,
      input.summary.missing,
      input.summary.failed,
      input.usedFallback,
      input.error ? input.error.slice(0, 1000) : null,
    ]
  );
}

export interface PendingAge {
  count: number;
  oldestHours: number | null;
}

// Oldest still-open (pending/processing/failed) request per org scope.
// NULL organizationId = global (cron) scope: worst case across orgs.
export async function openRequestAge(
  pool: Pool,
  organizationId: string | null
): Promise<PendingAge> {
  const params: unknown[] = [];
  const where = organizationId ? `WHERE organization_id = $1 AND status IN ('pending','processing','failed')` : `WHERE status IN ('pending','processing','failed')`;
  if (organizationId) params.push(organizationId);
  const res = await pool.query(
    `SELECT COUNT(*) AS count, MIN(requested_at) AS oldest FROM ajio_wfr_requests ${where}`,
    params
  );
  const row = res.rows[0] as { count?: unknown; oldest?: unknown } | undefined;
  const count = Number(row?.count || 0);
  const oldest = row?.oldest ? new Date(row.oldest as string) : null;
  const oldestHours =
    oldest && Number.isFinite(oldest.getTime()) ? (Date.now() - oldest.getTime()) / 3600000 : null;
  return { count, oldestHours };
}

export async function getWfrHealth(
  pool: Pool,
  organizationId: string | null,
  env: NodeJS.ProcessEnv = process.env
): Promise<WfrHealth> {
  let customEmails: string | null = null;
  let customResendKey: string | null = null;
  if (organizationId) {
    try {
      const settRes = await pool.query(
        `SELECT alert_emails, resend_api_key FROM ajio_settings WHERE organization_id = $1`,
        [organizationId]
      );
      if (settRes.rows.length > 0) {
        customEmails = settRes.rows[0].alert_emails;
        customResendKey = settRes.rows[0].resend_api_key;
      }
    } catch {
      // ajio_settings table may not exist yet in tests or migrations
    }
  }
  const slaHours = wfrSlaHours(env);
  const params: unknown[] = [];
  const scope = organizationId ? `WHERE (organization_id = $1 OR organization_id IS NULL)` : ``;
  if (organizationId) params.push(organizationId);
  const lastRes = await pool.query(
    `SELECT status, trigger, error, dry_run, used_fallback, created_at FROM ajio_wfr_runs ${scope} ORDER BY created_at DESC LIMIT 1`,
    params
  );
  const liveRes = await pool.query(
    `SELECT created_at FROM ajio_wfr_runs ${scope ? `${scope} AND` : `WHERE`} status = 'success' AND dry_run = FALSE ORDER BY created_at DESC LIMIT 1`,
    params
  );
  const age = await openRequestAge(pool, organizationId);
  const last = lastRes.rows[0] as
    | { status?: string; trigger?: string; error?: string | null; used_fallback?: boolean; created_at?: string }
    | undefined;
  const liveAt = liveRes.rows[0]?.created_at ? new Date(liveRes.rows[0].created_at as string) : null;
  const stale = !liveAt || Date.now() - liveAt.getTime() > slaHours * 3600000;
  const slaBreached = age.count > 0 && age.oldestHours != null && age.oldestHours > slaHours;
  return {
    lastRunAt: last?.created_at ? new Date(last.created_at as string).toISOString() : null,
    lastRunStatus: last?.status === 'failed' ? 'failed' : last?.status === 'success' ? 'success' : null,
    lastRunTrigger: (last?.trigger as WfrRunTrigger) || null,
    lastRunUsedFallback: last?.used_fallback === true,
    // Global (cron) rows are shared across orgs and the raw text can name a
    // mailbox: sanitized like every other API error. Full text stays in the
    // ledger + alert email.
    lastError: last?.error ? wfrPublicError(last.error, 'Ajio WFR run failed').message : null,
    lastLiveSuccessAt: liveAt && Number.isFinite(liveAt.getTime()) ? liveAt.toISOString() : null,
    pendingCount: age.count,
    oldestPendingHours: age.oldestHours,
    slaHours,
    slaBreached,
    stale,
    alertsConfigured: wfrAlertsConfigured(env, customEmails, customResendKey),
  };
}

// Pure alert copy: unit-tested, no I/O. Loud subjects on purpose — a missed
// CCTV reply can suspend the selling account.
export function buildWfrAlert(input: {
  status: WfrRunStatus;
  trigger: WfrRunTrigger;
  organizationName?: string | null;
  summary: AjioJobSummary;
  error?: string | null;
  usedFallback?: boolean;
  slaBreached?: boolean;
  oldestPendingHours?: number | null;
}): { subject: string; html: string } {
  const org = input.organizationName ? `[${input.organizationName}] ` : '';
  const subject = input.status === 'failed'
    ? `${org}[Ajio WFR FAILED] ${input.trigger} run needs you now`
    : `${org}[Ajio WFR ATTENTION] ${input.usedFallback ? 'Gmail grant dead, fallback sent replies' : 'requests waiting past SLA'}`;
  const row = (k: string, v: string | number) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#555;">${k}</td><td><b>${v}</b></td></tr>`;
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 2000);
  const errors = input.summary.errors.slice(0, 8).map((e) => `<li>${esc(e)}</li>`).join('');
  const warnings = input.summary.warnings.slice(0, 8).map((w) => `<li>${esc(w)}</li>`).join('');
  const html = `
    <h2>Ajio WFR ${input.status === 'failed' ? 'run failed' : 'needs attention'} (${esc(input.trigger)})</h2>
    ${input.error ? `<p><b>Error:</b> ${esc(input.error)}</p>` : ''}
    ${input.usedFallback ? `<p><b>Fallback active:</b> the Gmail OAuth grant is dead, so replies went out over the App Password transport. Reconnect Gmail on the Ajio page — the fallback only covers you while the App Password stays valid.</p>` : ''}
    ${input.slaBreached ? `<p><b>SLA breach:</b> the oldest open request is ${input.oldestPendingHours != null ? input.oldestPendingHours.toFixed(1) : '?'}h old. Ajio penalises late/missing CCTV footage.</p>` : ''}
    <table>${row('Mails checked', input.summary.checked)}${row('Replied', input.summary.replied)}${row('Missing video', input.summary.missing)}${row('Failed rows', input.summary.failed)}${row('Skipped (already done)', input.summary.skipped)}</table>
    ${errors ? `<p><b>Errors:</b></p><ul>${errors}</ul>` : ''}
    ${warnings ? `<p><b>Warnings:</b></p><ul>${warnings}</ul>` : ''}
    <p>Open the Ajio WFR page to inspect the ledger, then ${input.status === 'failed' ? 're-run and ' : ''}reconnect Gmail if the grant is dead.</p>
  `;
  return { subject, html };
}

export interface WfrAlertSender {
  (input: { subject: string; html: string }): Promise<void>;
}

// One recorded invocation shared by the cron endpoint, the admin button,
// and the in-process safety net: run -> record ledger -> alert when loud.
// Alerting never breaks the response: send failures only log.
export async function runRecordedAjioWfrJob(
  pool: Pool,
  input: {
    organizationId?: string;
    organizationName?: string | null;
    dryRun?: boolean;
    limit?: number;
    trigger: WfrRunTrigger;
    alert?: WfrAlertSender | null;
  }
): Promise<RecordedWfrRun> {
  const dryRun = input.dryRun === true;
  let summary: AjioJobSummary;
  let status: WfrRunStatus = 'success';
  let error: string | null = null;
  try {
    summary = await runAjioWfrJob(pool, input.organizationId, { dryRun, limit: input.limit });
  } catch (err) {
    status = 'failed';
    error = err instanceof Error ? err.message : String(err ?? 'Ajio WFR job failed');
    summary = { checked: 0, skipped: 0, matched: 0, uploaded: 0, replied: 0, missing: 0, failed: 0, errors: [error.slice(0, 200)], warnings: [], usedFallback: false };
  }
  const age = await openRequestAge(pool, input.organizationId ?? null).catch(() => ({ count: 0, oldestHours: null }));
  const slaHours = wfrSlaHours();
  const slaBreached = !dryRun && age.count > 0 && age.oldestHours != null && age.oldestHours > slaHours;
  const usedFallback = summary.usedFallback === true;
  try {
    await recordWfrRun(pool, {
      organizationId: input.organizationId ?? null,
      trigger: input.trigger,
      dryRun,
      status,
      summary,
      usedFallback,
      error,
    });
  } catch (recordErr) {
    console.error('[ajio-wfr] run ledger insert failed:', recordErr);
  }
  let alertSent = false;
  const loud = !dryRun && (status === 'failed' || usedFallback || slaBreached);
  if (loud && input.alert) {
    try {
      const { subject, html } = buildWfrAlert({
        status,
        trigger: input.trigger,
        organizationName: input.organizationName,
        summary,
        error,
        usedFallback,
        slaBreached,
        oldestPendingHours: age.oldestHours,
      });
      await input.alert({ subject, html });
      alertSent = true;
    } catch (alertErr) {
      console.error('[ajio-wfr] alert send failed:', alertErr);
    }
  }
  if (status === 'failed') {
    const out = new Error(error || 'Ajio WFR job failed') as Error & { summary?: AjioJobSummary };
    out.summary = summary;
    throw out;
  }
  return { summary, status, error, usedFallback, slaBreached, oldestPendingHours: age.oldestHours, alertSent };
}
