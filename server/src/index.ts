import fastify, { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { Resend } from 'resend';
import { authMiddleware, isAdmin, isManagerOrAdmin, isCompanion, normalizeRole, resolveUserPassword, effectiveCreateRole, canResetPassword, canLinkStation, ensureOrgCustomClaims } from './middleware/auth';
import { authorizeJobSecret, jobAuthReply, JOB_RATE_LIMIT, DOWNLOAD_RATE_LIMIT, PLAYBACK_URL_TTL_MS, isAcceptableStoragePath, sanitizeErrorMessage } from './security';
import { buildPostgresPoolConfig } from './db/poolConfig';
import { buildRecordingSessionUpsert, mappingStatusForRecording, buildMovedStoragePath } from './db/recordingSessions';
import { buildPurgeStatements, buildPurgeCountStatements, purgeRetentionDays, runRetentionPurge } from './db/purge';
import { normalizeTracker } from './omsguru/mappers';
import { resolveSyncCreds, maskToken } from './omsguru/sync';
import { createOMSGuruClient } from './omsguru/client';
import { clampInt, currentNightlyWindowStart, nextNightlyRunAt, skuStyleKey } from './omsguru/skuImages';
import { runSkuImageSync, SkuImageSyncResult, SkuImageSyncTrigger } from './omsguru/skuImageSync';
import {
  isMeeshoText,
  mergeItemImages,
  normalizeManualImageUrl,
  normalizeSkuKey,
  orderIdentity,
  recordingOrderId,
  trackingCandidates,
  marketplaceFromChannelLabel,
  normalizeForwardScanTracking,
  isLookupTracking,
  parseExcludedMarketplaces,
  MarketplaceOrderItem,
} from './forwardScan/mappers';
import { describeForwardScanSource, openForwardScanSource, parseForwardScanUrl } from './forwardScan/source';
import {
  copyOneForwardScanOrder,
  lookupForwardScanOrderDates,
  resolveTargetOrganizations,
  TargetOrganizations,
  retentionDaysFrom,
  runForwardScanSync,
  syncIntervalSecondsFrom,
  ForwardScanSyncResult,
} from './forwardScan/sync';
import { getReportDay, buildDailyReportHtml, buildDailyReportSubject, parseReportRecipients, StationRow, MarketplaceRow } from './reports/dailyReport';
import { isAjioRenameOrderId } from './ajio/orderIds';
import {
  runRecordedAjioWfrJob,
  getWfrHealth,
  wfrAlertRecipients,
  wfrAlertFrom,
  wfrAlertsConfigured,
  wfrSafetyNetHours,
  wfrPublicError,
  withAjioWfrLock,
  AJIO_WFR_BUSY_MESSAGE,
} from './ajio/watchdog';
import {
  gmailOAuthConfigured,
  createGmailOAuthClient,
  buildGmailAuthUrl,
  createConnectState,
  consumeConnectState,
  exchangeGmailCode,
  fetchGmailProfile,
  saveGmailTokens,
  getGmailTokens,
  deleteGmailTokens,
  gmailAppOrigin,
  gmailScopesSufficient,
} from './ajio/gmailApi';
import { parseReportDayRange, buildVideosReportWhere, buildVideosReportWorkbook, resolveAppBaseUrl, REPORT_MAX_ROWS } from './videoReport';
import { findLatestInstaller, getDesktopDownloadDir, isPublishableDownloadFile, getDesktopPublicDownloadUrl, readLatestReleaseRef, issueDownloadTicket, consumeDownloadTicket } from './downloads';
import { formatVideoRow } from './videos';
import { buildShareUrl, isShareToken, newShareToken, publicVideoView } from './videoShare';
import {
  getMeeshoFlyerQueue,
  updateMeeshoFlyerStatus,
  fixSwappedFlyerBarcodes,
  exportMeeshoFlyerCsv,
  getMeeshoSettings,
  saveMeeshoSettings,
  getMeeshoCredentials,
  getAutoFlyerScan,
  setAutoFlyerScan,
  getOrCreateCompanionToken,
  regenerateCompanionToken
} from './meeshoFlyer';
import dotenv from 'dotenv';

dotenv.config();

let firebaseStorageBucket = process.env.FIREBASE_STORAGE_BUCKET;

// Initialize Firebase Admin (Using application default credentials or explicit config in production)
if (!getApps().length) {
  try {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (serviceAccountJson) {
      const serviceAccount = JSON.parse(serviceAccountJson);
      firebaseStorageBucket = firebaseStorageBucket || `${serviceAccount.project_id}.firebasestorage.app`;
      initializeApp({
        credential: cert(serviceAccount),
        storageBucket: firebaseStorageBucket
      });
    } else {
      initializeApp(firebaseStorageBucket ? { storageBucket: firebaseStorageBucket } : undefined);
    }
  } catch (e) {
    console.error('Failed to initialize Firebase Admin SDK', e);
  }
}

// Validate Firebase Storage bucket configuration on startup
async function validateFirebaseStorageBucket() {
  if (!firebaseStorageBucket) {
    console.warn('WARNING: FIREBASE_STORAGE_BUCKET is not configured. Video uploads will fail.');
    return;
  }
  
  try {
    const bucket = getStorage().bucket(firebaseStorageBucket);
    const [exists] = await bucket.exists();
    if (!exists) {
      console.error(`ERROR: Firebase Storage bucket "${firebaseStorageBucket}" does not exist or is not accessible.`);
      console.error('Please create the bucket or check FIREBASE_STORAGE_BUCKET and FIREBASE_SERVICE_ACCOUNT_JSON configuration.');
    } else {
      console.log(`Firebase Storage bucket "${firebaseStorageBucket}" is accessible.`);
      
      // Check CORS configuration
      const [metadata] = await bucket.getMetadata();
      if (!metadata.cors || metadata.cors.length === 0) {
        console.warn('WARNING: Firebase Storage bucket has no CORS configuration. Browser uploads will fail.');
        console.warn('Run "npm run configure:storage-cors" to configure CORS for browser uploads.');
      } else {
        console.log('Firebase Storage bucket CORS configuration:', JSON.stringify(metadata.cors, null, 2));
      }
    }
  } catch (error) {
    console.error('Failed to validate Firebase Storage bucket:', error);
  }
}

function parseAllowedOrigins(): string[] | true {
  const raw = process.env.ALLOWED_ORIGINS;
  const isProd = process.env.NODE_ENV === 'production';
  if (!raw || !raw.trim()) {
    if (isProd) {
      throw new Error('ALLOWED_ORIGINS must be set in production (comma-separated origins).');
    }
    console.warn('[cors] ALLOWED_ORIGINS is empty in dev; allowing all origins.');
    return true;
  }
  const origins = raw.split(',').map((o) => o.trim()).filter(Boolean);
  if (origins.length === 0) {
    if (isProd) throw new Error('ALLOWED_ORIGINS parsed to zero origins in production.');
    console.warn('[cors] ALLOWED_ORIGINS parsed to zero origins; allowing all origins.');
    return true;
  }
  return origins;
}

const allowedOrigins = parseAllowedOrigins();

// trustProxy: Traefik sits in front on Hostinger. Without this, rate
// limits and audit IPs key off the proxy hop instead of the client.
const server = fastify({ logger: true, trustProxy: true });

// Strip internal error details before they reach the client. 4xx errors
// (validation, auth, bad-request) keep their messages because they describe
// the client's mistake and are safe to surface. 5xx errors (database, upstream,
// filesystem, configuration) are replaced with a generic message in
// production; the real error is still logged server-side. Dev still gets
// the full message via `details` so local debugging stays useful.
server.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
  const statusCode = typeof err.statusCode === 'number' && Number.isFinite(err.statusCode) ? err.statusCode : 500;
  const isProd = process.env.NODE_ENV === 'production';
  const isSafe = statusCode >= 400 && statusCode < 500;
  req.log.error({ err }, 'request error');
  return reply.status(statusCode).send({
    error: isProd && !isSafe ? 'Internal Server Error' : err.message || 'Internal Server Error',
    ...(isProd ? {} : { details: err.stack })
  });
});

server.register(cors, {
  origin: allowedOrigins,
  credentials: false,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
});

server.register(helmet, {
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' },
  hsts: { maxAge: 31536000, includeSubDomains: true },
});

server.register(rateLimit, {
  max: 300,
  timeWindow: '1 minute'
});

server.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB limit

const pool = new Pool(buildPostgresPoolConfig());

// Order data comes from the Forward Scan database (same VPS), not from the
// OMSGuru API: Forward Scan already syncs OMSGuru for dispatch scanning, so
// VMS copies its last FORWARD_SCAN_RETENTION_DAYS (3) of AWBs + SKU photos
// and spends none of the shared OMSGuru budget (no auto-sync, no per-scan
// live lookups).
const forwardScanConfig = parseForwardScanUrl(process.env.FORWARD_SCAN_DATABASE_URL);
const forwardScanRetentionDays = retentionDaysFrom(process.env.FORWARD_SCAN_RETENTION_DAYS);
const forwardScanIntervalSeconds = syncIntervalSecondsFrom(process.env.FORWARD_SCAN_SYNC_INTERVAL_SECONDS);
// Not copied at all (default Flipkart, Myntra Youthnic, Myntra PPMP); set
// FORWARD_SCAN_EXCLUDE_MARKETPLACES=none to copy every marketplace.
const forwardScanExcludedMarketplaces = parseExcludedMarketplaces(process.env.FORWARD_SCAN_EXCLUDE_MARKETPLACES);
let forwardScanSyncPromise: Promise<ForwardScanSyncResult> | null = null;
let forwardScanLookupWarnedAt = 0;
let forwardScanTargets: { value: TargetOrganizations; at: number } | null = null;

function openConfiguredForwardScanSource() {
  if (!forwardScanConfig) {
    throw new Error('Forward Scan database is not configured (FORWARD_SCAN_DATABASE_URL)');
  }
  return openForwardScanSource(forwardScanConfig, { busyTimeoutMs: 1000 });
}

// Scan-time single-AWB reads sit in a packer's request: wait even less.
function openForwardScanSourceForScan() {
  if (!forwardScanConfig) {
    throw new Error('Forward Scan database is not configured (FORWARD_SCAN_DATABASE_URL)');
  }
  return openForwardScanSource(forwardScanConfig, { busyTimeoutMs: 250 });
}

// Which organizations receive the copy (cached for a minute). Every path —
// timer, admin button, scan-time miss — uses this one answer, so Forward
// Scan's orders never reach another tenant (see pickTargetOrganizations).
async function forwardScanTargetOrganizations(): Promise<TargetOrganizations> {
  if (forwardScanTargets && Date.now() - forwardScanTargets.at < 60_000) return forwardScanTargets.value;
  const value = await resolveTargetOrganizations(pool, process.env.FORWARD_SCAN_ORG_IDS);
  forwardScanTargets = { value, at: Date.now() };
  return value;
}

async function receivesForwardScanCopy(organizationId: string): Promise<boolean> {
  if (!forwardScanConfig) return false;
  return (await forwardScanTargetOrganizations()).ids.includes(organizationId);
}

// One flight at a time: the timer, the cron job and the admin button share
// it, so two copies never race on the same rows.
function syncFromForwardScan(): Promise<ForwardScanSyncResult> {
  if (forwardScanSyncPromise) return forwardScanSyncPromise;

  forwardScanSyncPromise = (async () => {
    const targets = await forwardScanTargetOrganizations();
    if (targets.ids.length === 0) {
      return { ok: false, ordersRead: 0, cutoff: '', durationMs: 0, results: [], error: `No organization receives the copy: ${targets.reason}` };
    }
    return runForwardScanSync(pool, openConfiguredForwardScanSource, {
      organizationIds: targets.ids,
      excludedMarketplaces: forwardScanExcludedMarketplaces,
      retentionDays: forwardScanRetentionDays,
      sourceLabel: describeForwardScanSource(forwardScanConfig),
    });
  })().finally(() => {
    forwardScanSyncPromise = null;
  });

  return forwardScanSyncPromise;
}

function scheduleForwardScanSync(): void {
  if (!forwardScanConfig) {
    console.warn('Forward Scan order copy disabled: FORWARD_SCAN_DATABASE_URL is not set');
    return;
  }
  let lastError = '';
  const run = async () => {
    try {
      const result = await syncFromForwardScan();
      if (!result.ok) {
        // Log a failure once, not every interval while it persists.
        if (result.error !== lastError) console.error('Forward Scan order copy failed:', result.error);
        lastError = result.error || 'unknown error';
        return;
      }
      if (lastError) console.log('Forward Scan order copy recovered');
      lastError = '';
      const written = result.results.reduce((sum, r) => sum + r.ordersWritten, 0);
      const photos = result.results.reduce((sum, r) => sum + r.photosWritten, 0);
      const purged = result.results.reduce((sum, r) => sum + r.purged, 0);
      if (written || photos || purged) {
        console.log(
          `Forward Scan order copy: ${result.ordersRead} orders in window, ${written} written, ` +
          `${photos} photos, ${purged} purged (${result.durationMs} ms)`
        );
      }
    } catch (err) {
      console.error('Forward Scan order copy failed:', err);
    }
  };

  setTimeout(() => {
    void run();
    setInterval(() => void run(), forwardScanIntervalSeconds * 1000);
  }, 15_000);
  console.log(
    `Forward Scan order copy every ${forwardScanIntervalSeconds}s from ${describeForwardScanSource(forwardScanConfig)} ` +
    `(last ${forwardScanRetentionDays} days)`
  );
}

// Nightly SKU photo sync from OMSGuru listings (orders still come from the
// Forward Scan copy). One flight at a time: the night timer, the cron job
// endpoint and the admin button share it. See omsguru/skuImageSync.ts.
const skuImageSyncConfig = {
  enabled: String(process.env.SKU_IMAGE_SYNC_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
  hourIst: clampInt(process.env.SKU_IMAGE_SYNC_HOUR_IST, 2, 0, 23),
  maxMinutes: clampInt(process.env.SKU_IMAGE_SYNC_MAX_MINUTES, 60, 5, 180),
  // Calls of every 5-minute window left untouched for Forward Scan.
  reserve: clampInt(process.env.SKU_IMAGE_SYNC_RESERVE, 25, 0, 55),
  fullRefreshDays: clampInt(process.env.SKU_IMAGE_SYNC_FULL_REFRESH_DAYS, 30, 0, 365),
};

interface SkuImageSyncRun {
  trigger: SkuImageSyncTrigger;
  startedAt: string;
  deadlineAt: string;
  results: SkuImageSyncResult[];
  done: boolean;
  error?: string;
}
let skuImageSyncCurrent: SkuImageSyncRun | null = null;
let skuImageSyncPromise: Promise<SkuImageSyncRun> | null = null;

async function omsguruCredsFor(organizationId: string) {
  const settingsRes = await pool.query(
    `SELECT token, cid, warehouse_id FROM omsguru_settings WHERE organization_id = $1`,
    [organizationId]
  );
  return resolveSyncCreds(settingsRes.rows[0] || null, {
    token: process.env.OMSGURU_TOKEN,
    cid: process.env.OMSGURU_CID,
    warehouseId: process.env.OMSGURU_WAREHOUSE_ID,
  });
}

// null = a run is already going (callers answer 409).
function startSkuImageSync(trigger: SkuImageSyncTrigger, minutes: number): Promise<SkuImageSyncRun> | null {
  if (skuImageSyncPromise) return null;
  const startedAt = Date.now();
  const run: SkuImageSyncRun = {
    trigger,
    startedAt: new Date(startedAt).toISOString(),
    deadlineAt: new Date(startedAt + minutes * 60_000).toISOString(),
    results: [],
    done: false,
  };
  skuImageSyncCurrent = run;
  skuImageSyncPromise = (async () => {
    try {
      // Same single business as the order copy (FORWARD_SCAN_ORG_IDS).
      const targets = await forwardScanTargetOrganizations();
      if (targets.ids.length === 0) {
        run.error = `No organization to sync: ${targets.reason}`;
        return run;
      }
      for (const organizationId of targets.ids) {
        let creds;
        try {
          creds = await omsguruCredsFor(organizationId);
        } catch (err) {
          run.error = sanitizeErrorMessage(err, 'OMSGuru is not configured');
          continue;
        }
        const result = await runSkuImageSync(pool, {
          organizationId,
          creds,
          deadlineMs: startedAt + minutes * 60_000,
          reserve: skuImageSyncConfig.reserve,
          fullRefreshDays: skuImageSyncConfig.fullRefreshDays,
          excludedMarketplaces: forwardScanExcludedMarketplaces,
          trigger,
        });
        run.results.push(result);
        console.log(
          `[sku-images] ${trigger} run: ${result.listingsStored} listings stored, ${result.imagesWritten} photos updated, ` +
          `${result.channelsCompleted}/${result.channelsTotal} channels up to date, ${result.calls} OMSGuru calls, ` +
          `stopped by ${result.stoppedBy}${result.error ? ` (${result.error})` : ''}`
        );
      }
      return run;
    } catch (err) {
      run.error = sanitizeErrorMessage(err, 'SKU photo sync failed');
      console.error('[sku-images] run failed:', err);
      return run;
    } finally {
      run.done = true;
      skuImageSyncPromise = null;
    }
  })();
  return skuImageSyncPromise;
}

function scheduleSkuImageSync(): void {
  if (!skuImageSyncConfig.enabled) {
    console.log('[sku-images] nightly OMSGuru photo sync disabled (SKU_IMAGE_SYNC_ENABLED=false)');
    return;
  }
  const { hourIst, maxMinutes } = skuImageSyncConfig;
  const label = `${String(hourIst).padStart(2, '0')}:00 IST for up to ${maxMinutes} min`;

  const armNext = () => {
    const delay = nextNightlyRunAt(Date.now(), hourIst) - Date.now();
    setTimeout(() => {
      if (!startSkuImageSync('nightly', maxMinutes)) console.warn('[sku-images] nightly run skipped: a run is already going');
      armNext();
    }, delay);
  };

  void (async () => {
    // A crash or deploy mid-run leaves its ledger row 'running'.
    await pool.query(
      `UPDATE sku_image_sync_runs SET status = 'interrupted', finished_at = COALESCE(finished_at, NOW())
       WHERE status = 'running'`
    ).catch(() => undefined);
    // Restarted inside tonight's window without a nightly run yet: use the
    // rest of the window instead of skipping a night.
    const windowStart = currentNightlyWindowStart(Date.now(), hourIst, maxMinutes);
    if (windowStart !== null) {
      const ran = await pool.query(
        `SELECT 1 FROM sku_image_sync_runs WHERE trigger = 'nightly' AND started_at >= $1 LIMIT 1`,
        [new Date(windowStart).toISOString()]
      ).catch(() => ({ rowCount: 1 }));
      const minutesLeft = Math.floor((windowStart + maxMinutes * 60_000 - Date.now()) / 60_000);
      if (!ran.rowCount && minutesLeft >= 5) {
        console.log(`[sku-images] catching up tonight's run (${minutesLeft} min left in the window)`);
        startSkuImageSync('nightly', minutesLeft);
      }
    }
  })();

  armNext();
  console.log(`[sku-images] nightly OMSGuru photo sync at ${label}, keeping ${skuImageSyncConfig.reserve} of every 60 calls for Forward Scan`);
}

function scheduleRetentionPurge(): void {
  // PR-14: deterministic weekly schedule — every Sunday at 20:00 IST.
  // Override env vars: RETENTION_PURGE_DAY_OF_WEEK (0=Sun..6=Sat),
  // RETENTION_PURGE_HOUR_IST (0..23), RETENTION_PURGE_INTERVAL_MINUTES
  // (legacy hourly backstop, default 1440 = daily; 0 disables the
  // deterministic run so only the interval-tick fires).
  const configuredDay = Number(process.env.RETENTION_PURGE_DAY_OF_WEEK);
  const configuredHour = Number(process.env.RETENTION_PURGE_HOUR_IST);
  const configuredIntervalMin = Number(process.env.RETENTION_PURGE_INTERVAL_MINUTES || '0');
  const dayOfWeek = Number.isFinite(configuredDay)
    ? Math.min(6, Math.max(0, Math.floor(configuredDay)))
    : 0; // Sunday
  const hourIst = Number.isFinite(configuredHour)
    ? Math.min(23, Math.max(0, Math.floor(configuredHour)))
    : 20; // 8 PM
  const istOffsetMs = 5.5 * 60 * 60 * 1000;

  const run = async () => {
    try {
      const bucket = firebaseStorageBucket ? getStorage().bucket(firebaseStorageBucket) : null;
      const orgs = await pool.query<{ id: string }>(
        `SELECT id FROM organizations WHERE active = TRUE`
      );
      let totalVideos = 0, totalSessions = 0, totalOrphaned = 0, totalFailures = 0;
      for (const row of orgs.rows) {
        const result = await runRetentionPurge(pool, bucket, { organizationId: row.id });
        totalVideos += result.videosDeleted;
        totalSessions += result.sessionsDeleted;
        totalOrphaned += result.videosOrphaned;
        totalFailures += result.failures;
      }
      console.log(
        `[retention] purge complete across ${orgs.rows.length} orgs: videos ${totalVideos} deleted, ${totalOrphaned} queued, sessions ${totalSessions} deleted, ${totalFailures} failures`
      );
      // Audit log so every deterministic Sunday run shows up in the trail.
      try {
        await pool.query(
          `INSERT INTO audit_logs (id, organization_id, user_id, action, resource, metadata, created_at)
           VALUES (gen_random_uuid(), NULL, NULL, 'RETENTION_PURGE', 'retention-schedule', $1::jsonb, NOW())`,
          [JSON.stringify({
            scheduled_day_of_week: dayOfWeek,
            scheduled_hour_ist: hourIst,
            orgs: orgs.rows.length,
            videos_deleted: totalVideos,
            videos_orphaned: totalOrphaned,
            sessions_deleted: totalSessions,
            failures: totalFailures,
            ts: new Date().toISOString()
          })]
        );
      } catch (auditErr) {
        console.warn('[retention] audit log insert failed:', auditErr);
      }
    } catch (err) {
      console.error('[retention] purge failed:', err);
    }
  };

  // Compute ms until the next deterministic tick in IST. We need a single
  // server-local "now" that the user reads in their log timezone.
  const msUntilNext = () => {
    const nowUtcMs = Date.now();
    const nowIstMs = new Date(nowUtcMs + istOffsetMs);
    const currentIstDayOfWeek = nowIstMs.getUTCDay();
    let daysAhead = (dayOfWeek - currentIstDayOfWeek + 7) % 7;
    let targetIst = new Date(nowIstMs.getTime());
    if (daysAhead === 0) {
      targetIst.setUTCHours(hourIst, 0, 0, 0);
      if (targetIst.getTime() <= nowIstMs.getTime()) {
        daysAhead = 7;
      }
    }
    targetIst.setUTCDate(targetIst.getUTCDate() + daysAhead);
    targetIst.setUTCHours(hourIst, 0, 0, 0);
    return targetIst.getTime() - nowIstMs.getTime();
  };

  const scheduleDeterministic = () => {
    const ms = msUntilNext();
    setTimeout(() => {
      void run();
      setInterval(() => void run(), 7 * 24 * 60 * 60 * 1000);
      console.log(
        `[retention] deterministic weekly schedule armed (day-of-week=${dayOfWeek} = ${
          ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dayOfWeek]
        }, ${hourIst.toString().padStart(2, '0')}:00 IST)`
      );
    }, ms);
  };

  if (configuredIntervalMin > 0) {
    // Legacy hourly backstop, default 1440 (daily) so the deterministic
    // Sunday run is the primary schedule and this is a safety net.
    const intervalMs = configuredIntervalMin * 60 * 1000;
    setTimeout(() => { void run(); }, 90_000);
    setInterval(() => void run(), intervalMs);
    console.log(`[retention] hourly backstop scheduled every ${configuredIntervalMin} minute(s)`);
  } else {
    setTimeout(() => { void run(); }, 90_000);
  }
  scheduleDeterministic();
}

// Ajio WFR alert delivery (Resend). Null when unconfigured — the job still
// runs and records, it just can't email. AJIO_ALERT_EMAILS overrides the
// daily-report list so CCTV alerts can page a different (louder) audience.
function wfrAlertSender(): ((input: { subject: string; html: string }) => Promise<void>) | null {
  const key = (process.env.RESEND_API_KEY || '').trim();
  const recipients = wfrAlertRecipients();
  if (!key || recipients.length === 0) return null;
  const resend = new Resend(key);
  const from = wfrAlertFrom();
  return async ({ subject, html }: { subject: string; html: string }) => {
    const { error } = await resend.emails.send({ from, to: recipients, subject, html });
    if (error) throw new Error(`Resend rejected the alert: ${JSON.stringify(error).slice(0, 200)}`);
  };
}

let ajioSafetyPromise: Promise<void> | null = null;

// In-process safety net for the Ajio WFR job: if the VPS host cron ever
// misses (cron daemon down, deploy gap, secret rotation), this still sweeps
// every AJIO_WFR_INTERVAL_HOURS (default 6). It never double-sends with the
// cron or the admin button: all three share one Postgres advisory lock
// (withAjioWfrLock), and the net stands down whenever any trigger recently
// succeeded. The ledger backs that up — 'done' is sticky, Drive links are
// reused — so an overlap could only ever duplicate work, never replies.
function scheduleAjioWfrSafetyNet(): void {
  const hours = wfrSafetyNetHours();
  const intervalMs = hours * 3600 * 1000;
  const run = async () => {
    if (ajioSafetyPromise) return;
    ajioSafetyPromise = (async () => {
      try {
        const outcome = await withAjioWfrLock(pool, async () => {
          const windowHours = Math.max(1, hours - 1);
          const recentRes = await pool.query(
            `SELECT id FROM ajio_wfr_runs WHERE status = 'success' AND dry_run = FALSE AND created_at > NOW() - make_interval(hours => $1) LIMIT 1`,
            [windowHours]
          );
          if (recentRes.rows.length > 0) return; // primary schedule covered this window
          console.log('[ajio-wfr] safety net starting (no recent successful run)');
          await runRecordedAjioWfrJob(pool, {
            limit: 50,
            trigger: 'safety-net',
            alert: wfrAlertSender(),
          });
        });
        if (!outcome.ran) console.log('[ajio-wfr] safety net skipped (a run is already in progress)');
      } catch (err) {
        console.error('[ajio-wfr] safety net run failed:', err);
      }
    })().finally(() => {
      ajioSafetyPromise = null;
    });
    await ajioSafetyPromise;
  };
  setTimeout(() => {
    void run();
    setInterval(() => void run(), intervalMs);
  }, 5 * 60 * 1000);
  console.log(`[ajio-wfr] safety net scheduled every ${hours} hour(s)`);
  if (!wfrAlertsConfigured()) {
    console.warn('[ajio-wfr] failure alerts are OFF: set RESEND_API_KEY and AJIO_ALERT_EMAILS (or REPORT_TO_EMAILS)');
  }
}

const uploadsDir = process.env.STORAGE_DIR || path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Health checks (excluded from rate limiting: Traefik polls these)
server.get('/health/live', { config: { rateLimit: false } }, async (request, reply) => {
  return { status: 'OK' };
});

server.get('/health/ready', { config: { rateLimit: false } }, async (request, reply) => {
  try {
    await pool.query('SELECT 1');
    return { status: 'OK', services: { db: 'OK' } };
  } catch (e) {
    return reply.status(503).send({ status: 'UNAVAILABLE', services: { db: 'FAIL' } });
  }
});

// Desktop app installer publishing dir (see protected /api/downloads/*
// routes below + the public updater feed). Newest *.exe wins.

// Auto-update feed for the installed desktop app (electron-updater generic
// provider polls <base>/latest.yml). PUBLIC on purpose: the updater runs
// without a user session and these files carry no secrets (same installer
// bytes as the login-gated button below). Strict allowlist: only .exe /
// latest.yml / .blockmap, never dotfiles, never sub-paths.
server.get('/api/downloads/files/:file', { config: { rateLimit: DOWNLOAD_RATE_LIMIT } }, async (request, reply) => {
  const { file } = request.params as { file: string };
  if (!isPublishableDownloadFile(file)) {
    return reply.status(404).send({ error: 'Not found' });
  }
  const full = path.join(getDesktopDownloadDir(), path.basename(file));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    return reply.status(404).send({ error: 'Not found' });
  }
  const lower = file.toLowerCase();
  reply.header('Content-Type', lower.endsWith('.yml') ? 'text/yaml; charset=utf-8' : 'application/octet-stream');
  reply.header('Content-Length', String(stat.size));
  if (lower.endsWith('.exe')) {
    reply.header('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
  }
  return reply.send(fs.createReadStream(full));
});

// Ticketed installer download (public route, ticket-gated): the packing page
// button mints a single-use 60s ticket (login required) and navigates here,
// because a plain browser navigation cannot send the login token. Same file
// serving as the Bearer-token /latest route above.
server.get('/api/downloads/file', { config: { rateLimit: DOWNLOAD_RATE_LIMIT } }, async (request, reply) => {
  const { t } = request.query as { t?: string };
  if (!consumeDownloadTicket(downloadTicketStore, t)) {
    return reply.status(403).send({ error: 'Download link expired — request a fresh one from the packing page Desktop App button.' });
  }
  return sendLatestInstaller(reply, getDesktopDownloadDir());
});

// Public view of ONE shared video (no login). Returns a short-lived signed
// URL for that file and a few labels — never anything else from VMS.
const PUBLIC_VIDEO_RATE_LIMIT = { max: 60, timeWindow: '1 minute' as const };
server.get<{ Params: { token: string } }>('/api/public/videos/:token', { config: { rateLimit: PUBLIC_VIDEO_RATE_LIMIT } }, async (req, reply) => {
  reply.header('Cache-Control', 'no-store');
  reply.header('X-Robots-Tag', 'noindex, nofollow');
  const { token } = req.params;
  if (!isShareToken(token)) return reply.status(404).send({ error: 'This link is not valid' });
  try {
    const res = await pool.query(
      `SELECT vsl.id AS link_id, va.storage_path, va.mime_type, va.duration_ms,
              rs.tracking_id, rs.order_id, rs.marketplace, rs.created_at AS recorded_at
       FROM video_share_links vsl
       JOIN video_assets va ON va.id = vsl.video_asset_id AND va.organization_id = vsl.organization_id
       LEFT JOIN recording_sessions rs ON rs.id = va.recording_session_id AND rs.organization_id = va.organization_id
       WHERE vsl.token = $1 AND vsl.revoked_at IS NULL
       LIMIT 1`,
      [token]
    );
    const row = res.rows[0];
    if (!row || !row.storage_path) {
      return reply.status(404).send({ error: 'This video link has been removed or the video no longer exists' });
    }
    const file = getStorage().bucket(firebaseStorageBucket).file(row.storage_path);
    const [exists] = await file.exists();
    if (!exists) return reply.status(404).send({ error: 'This video is no longer available' });
    const expires = Date.now() + PLAYBACK_URL_TTL_MS;
    const [url] = await file.getSignedUrl({ action: 'read', expires });
    await pool.query(
      `UPDATE video_share_links SET view_count = view_count + 1, last_viewed_at = NOW() WHERE id = $1`,
      [row.link_id]
    );
    return {
      url,
      expiresAt: new Date(expires).toISOString(),
      mimeType: row.mime_type || 'video/mp4',
      video: publicVideoView(row),
    };
  } catch (err) {
    req.log.error(err, 'Failed to open shared video');
    return reply.status(500).send({ error: 'Could not load the video, please try again' });
  }
});

// Direct download route for Meesho Flyer Link-up desktop companion app
const MEESHO_LINKUP_VERSION = '1.0.4';
server.get('/api/downloads/meesho-linkup', { config: { rateLimit: DOWNLOAD_RATE_LIMIT } }, async (request, reply) => {
  const query = request.query as { portable?: string };
  const isPortable = query?.portable === 'true' || query?.portable === '1';
  const filename = isPortable
    ? `Meesho-Flyer-Linkup-Portable-${MEESHO_LINKUP_VERSION}-x64.exe`
    : `Meesho-Flyer-Linkup-Setup-${MEESHO_LINKUP_VERSION}-x64.exe`;
  const dir = getDesktopDownloadDir();
  const localPath = path.join(dir, filename);
  if (fs.existsSync(localPath)) {
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(fs.createReadStream(localPath));
  }
  return reply.redirect(`https://github.com/pawanshukla500/VMS-Youthnic/releases/download/meesho-v${MEESHO_LINKUP_VERSION}/${filename}`);
});

const requireAuth = authMiddleware(pool);

// Ajio WFR (wrong-fulfilment CCTV) job: reads seller.communication@ajio.com
// mails, matches each order to its packing video, uploads the video to the
// shared Google Drive folder, and replies on the thread. Triggered 4x daily
// by the VPS host cron (/etc/cron.d/pvms-ajio-wfr, installed by the deploy
// workflow from scripts/vps/) plus an in-process safety net; the GitHub
// workflow is manual-only. Every invocation is recorded in ajio_wfr_runs and
// failures / fallbacks / SLA breaches email the alert list immediately —
// a missed CCTV reply risks an Ajio penalty, so this endpoint is loud.
// ?dryRun=1 parses + matches without uploading or replying (recorded, never
// alerts); ?limit=N caps mails per run. 409 = another run holds the lock
// (the VPS cron script logs that as a skip, not a failure).
server.post('/api/jobs/ajio-wfr', { config: { rateLimit: JOB_RATE_LIMIT } }, async (req, reply) => {
  const denied = jobAuthReply(
    authorizeJobSecret(req.headers as Record<string, unknown>, process.env.AJIO_WFR_SECRET, 'x-cron-secret'),
    'AJIO_WFR_SECRET'
  );
  if (denied) return reply.status(denied.status).send(denied.body);

  try {
    const query = (req.query || {}) as { dryRun?: string; limit?: string; organizationId?: string };
    const outcome = await withAjioWfrLock(pool, () =>
      runRecordedAjioWfrJob(pool, {
        organizationId: query.organizationId,
        dryRun: query.dryRun === '1',
        limit: query.limit ? Number(query.limit) : undefined,
        trigger: 'cron',
        alert: wfrAlertSender(),
      })
    );
    if (!outcome.ran) return reply.status(409).send({ error: AJIO_WFR_BUSY_MESSAGE, running: true });
    const recorded = outcome.value;
    return {
      ...recorded.summary,
      usedFallback: recorded.usedFallback,
      slaBreached: recorded.slaBreached,
      alertSent: recorded.alertSent,
    };
  } catch (err) {
    // Already recorded in ajio_wfr_runs and already alerted when loud.
    console.error(err);
    const failure = wfrPublicError(err, 'Ajio WFR job failed');
    return reply.status(failure.status).send({ error: failure.message });
  }
});

// Gmail OAuth callback (public: Google redirects the browser here, so no
// Bearer header is possible — the one-shot state binds the grant to the org
// that started it). Success and failure both land back on the Ajio page.
server.get('/api/admin/ajio-gmail/callback', async (req, reply) => {
  const fail = (reason: string) =>
    reply.redirect(`${gmailAppOrigin()}/ajio-wfr?gmail=error&reason=${encodeURIComponent(reason)}`);
  try {
    const query = (req.query || {}) as { code?: string; state?: string; error?: string };
    if (query.error) return fail('access-denied');
    const organizationId = consumeConnectState(String(query.state || ''));
    if (!organizationId || !query.code) return fail('bad-state');
    const oauth = gmailOAuthConfigured();
    if (!oauth) return fail('not-configured');
    const client = createGmailOAuthClient(oauth);
    const tokens = await exchangeGmailCode(client, String(query.code));
    if (!tokens.refreshToken) return fail('no-refresh-token');
    const profile = await fetchGmailProfile(tokens.accessToken as string);
    await saveGmailTokens(pool, organizationId, {
      email: profile.email,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken || null,
      accessExpiry: tokens.accessExpiry,
      scopes: tokens.scopes,
    });
    return reply.redirect(`${gmailAppOrigin()}/ajio-wfr?gmail=connected`);
  } catch (err) {
    console.error(err);
    return fail('exchange-failed');
  }
});

// Single-use desktop-download tickets (ticket string -> expiry epoch ms).
// Single Node process by deployment; a restart just invalidates outstanding
// 60s tickets and the button mints a fresh one.
const downloadTicketStore = new Map<string, number>();

// Shared installer serving: fast public CDN redirect, else stream the local
// copy. Used by the Bearer-token route, the public ticket route, and nothing
// else (the updater feed serves allowlisted static files directly).
async function sendLatestInstaller(reply: any, dir: string) {
  const publicUrl = getDesktopPublicDownloadUrl(dir);
  if (publicUrl) return reply.redirect(publicUrl);
  const latest = findLatestInstaller(dir);
  if (!latest) {
    return reply.status(404).send({ error: 'No desktop installer published yet' });
  }
  reply.header('Content-Type', 'application/octet-stream');
  reply.header('Content-Disposition', `attachment; filename="${latest.file}"`);
  reply.header('Content-Length', String(latest.sizeBytes));
  return reply.send(fs.createReadStream(path.join(dir, latest.file)));
}

server.post('/api/jobs/order-mappings/reconcile', { config: { rateLimit: JOB_RATE_LIMIT } }, async (req, reply) => {
  const denied = jobAuthReply(
    authorizeJobSecret(req.headers as Record<string, unknown>, process.env.ORDER_RECONCILE_SECRET, 'x-cron-secret'),
    'ORDER_RECONCILE_SECRET'
  );
  if (denied) return reply.status(denied.status).send(denied.body);

  try {
    const updateRes = await pool.query(
      `UPDATE recording_sessions rs
       SET order_id = CASE WHEN mom.rename_order THEN mom.order_id ELSE rs.order_id END,
           marketplace = mom.marketplace,
           order_mapping_imported_at = NOW(),
           updated_at = NOW()
       FROM marketplace_order_mappings mom
       WHERE mom.organization_id = rs.organization_id
         AND mom.tracking_id = rs.tracking_id
         AND (
           (mom.rename_order AND rs.order_id IS DISTINCT FROM mom.order_id)
           OR rs.marketplace IS DISTINCT FROM mom.marketplace
         )`
    );

    await pool.query(
      `INSERT INTO audit_logs (organization_id, user_id, action, resource, created_at)
       SELECT DISTINCT rs.organization_id, NULL, 'JOB_RECONCILE', 'ORDER_MAPPINGS', NOW()
       FROM recording_sessions rs
       JOIN marketplace_order_mappings mom
         ON mom.organization_id = rs.organization_id
        AND mom.tracking_id = rs.tracking_id
       WHERE rs.order_mapping_imported_at >= NOW() - INTERVAL '2 minutes'`
    );

    await pool.query(
      `UPDATE recording_sessions rs
       SET data_retention_until = CASE
         WHEN mrp.data_retention_days IS NULL THEN NULL
         ELSE rs.created_at + (mrp.data_retention_days * INTERVAL '1 day')
       END,
       updated_at = NOW()
       FROM marketplace_retention_policies mrp
       WHERE mrp.organization_id = rs.organization_id
         AND LOWER(mrp.marketplace) = LOWER(COALESCE(NULLIF(rs.marketplace, ''), 'Unassigned'))`
    );

    await pool.query(
      `UPDATE video_assets va
       SET retention_until = CASE
         WHEN mrp.video_retention_days IS NULL THEN NULL
         ELSE rs.created_at + (mrp.video_retention_days * INTERVAL '1 day')
       END
       FROM recording_sessions rs
       JOIN marketplace_retention_policies mrp
         ON mrp.organization_id = rs.organization_id
        AND LOWER(mrp.marketplace) = LOWER(COALESCE(NULLIF(rs.marketplace, ''), 'Unassigned'))
       WHERE va.recording_session_id = rs.id`
    );

    return { updatedRecordings: updateRes.rowCount || 0 };
  } catch (err) {
    console.error(err);
    return reply.status(500).send({ error: 'Failed to run order mapping reconcile job' });
  }
});

// Retention purge for import bookkeeping (same cron secret as reconcile).
// Keeps SQL lean: mappings/audit age out, stale raw files get nulled.
server.post('/api/jobs/retention-purge', { config: { rateLimit: JOB_RATE_LIMIT } }, async (req, reply) => {
  const denied = jobAuthReply(
    authorizeJobSecret(req.headers as Record<string, unknown>, process.env.ORDER_RECONCILE_SECRET, 'x-cron-secret'),
    'ORDER_RECONCILE_SECRET'
  );
  if (denied) return reply.status(denied.status).send(denied.body);

  const query = req.query as any;
  const dryRun = query?.dryRun === '1' || query?.dryRun === 'true';
  const mappingDays = purgeRetentionDays(process.env.MAPPING_RETENTION_DAYS, 30);
  const auditDays = purgeRetentionDays(process.env.AUDIT_RETENTION_DAYS, 90);

  try {
    const counts: Record<string, number> = {};
    const statements = dryRun
      ? buildPurgeCountStatements(mappingDays, auditDays)
      : buildPurgeStatements(mappingDays, auditDays);
    for (const statement of statements) {
      const res = await pool.query(statement.text, statement.values);
      counts[statement.key] = dryRun ? Number(res.rows[0]?.count || 0) : res.rowCount || 0;
    }
    return { dryRun, mappingDays, auditDays, [dryRun ? 'wouldDelete' : 'deleted']: counts };
  } catch (err) {
    console.error(err);
    return reply.status(500).send({ error: 'Failed to run retention purge' });
  }
});

// Immediate Forward Scan order copy (same cron secret as reconcile). The
// old /api/jobs/omsguru-sync path stays as an alias so existing crons keep
// working — they now copy from the Forward Scan database instead of
// spending OMSGuru API calls.
async function forwardScanSyncJob(req: FastifyRequest, reply: FastifyReply) {
  const denied = jobAuthReply(
    authorizeJobSecret(req.headers as Record<string, unknown>, process.env.ORDER_RECONCILE_SECRET, 'x-cron-secret'),
    'ORDER_RECONCILE_SECRET'
  );
  if (denied) return reply.status(denied.status).send(denied.body);
  if (!forwardScanConfig) {
    return reply.status(503).send({ error: 'Forward Scan database is not configured (FORWARD_SCAN_DATABASE_URL)' });
  }

  try {
    const result = await syncFromForwardScan();
    if (!result.ok) return reply.status(502).send(result);
    return result;
  } catch (err) {
    console.error(err);
    return reply.status(502).send({ error: 'Forward Scan order copy failed' });
  }
}
// Nightly SKU photo sweep on demand (same cron secret). Starts in the
// background and answers at once; 409 while a run is going.
server.post('/api/jobs/sku-image-sync', { config: { rateLimit: JOB_RATE_LIMIT } }, async (req, reply) => {
  const denied = jobAuthReply(
    authorizeJobSecret(req.headers as Record<string, unknown>, process.env.ORDER_RECONCILE_SECRET, 'x-cron-secret'),
    'ORDER_RECONCILE_SECRET'
  );
  if (denied) return reply.status(denied.status).send(denied.body);
  const minutes = clampInt((req.query as any)?.minutes, skuImageSyncConfig.maxMinutes, 1, skuImageSyncConfig.maxMinutes);
  if (!startSkuImageSync('job', minutes)) {
    return reply.status(409).send({ error: 'A SKU photo sync is already running' });
  }
  return reply.status(202).send({ started: true, minutes, deadlineAt: skuImageSyncCurrent?.deadlineAt });
});
server.post('/api/jobs/forward-scan-sync', { config: { rateLimit: JOB_RATE_LIMIT } }, forwardScanSyncJob);
server.post('/api/jobs/omsguru-sync', { config: { rateLimit: JOB_RATE_LIMIT } }, forwardScanSyncJob);

server.post('/api/jobs/daily-report', { config: { rateLimit: JOB_RATE_LIMIT } }, async (req, reply) => {
  const denied = jobAuthReply(
    authorizeJobSecret(req.headers as Record<string, unknown>, process.env.REPORT_JOB_SECRET, 'x-report-secret'),
    'REPORT_JOB_SECRET'
  );
  if (denied) return reply.status(denied.status).send(denied.body);

  const query = req.query as any;
  const dryRun = query?.dryRun === '1' || query?.dryRun === 'true';
  const singleOrgFilter = typeof query?.organizationId === 'string' && query.organizationId.length > 0
    ? query.organizationId
    : null;
  const resendKey = process.env.RESEND_API_KEY;
  const recipients = parseReportRecipients(process.env.REPORT_TO_EMAILS);
  const from = process.env.REPORT_FROM_EMAIL || 'PVMS Daily Report <reports@pkvm.youthnic.shop>';

  if (!dryRun && (!resendKey || recipients.length === 0)) {
    return reply.status(503).send({ error: 'Daily report email is not configured (RESEND_API_KEY / REPORT_TO_EMAILS)' });
  }

  try {
    const { day, start, end } = getReportDay(typeof query?.date === 'string' ? query.date : undefined);

    // Tenant scoping: iterate every active organization and run the
    // aggregations scoped to that org's rows. A single cron-secret endpoint
    // that aggregates cross-tenant data is a latent bug if the secret ever
    // leaks or if this endpoint is ever wrapped in a user-facing view.
    const orgsRes = singleOrgFilter
      ? await pool.query<{ id: string; name: string }>(
          `SELECT id, name FROM organizations WHERE active = TRUE AND id = $1`,
          [singleOrgFilter]
        )
      : await pool.query<{ id: string; name: string }>(
          `SELECT id, name FROM organizations WHERE active = TRUE`
        );

    if (orgsRes.rows.length === 0) {
      return reply.status(404).send({ error: 'No active organizations to report on' });
    }

    const perOrg: Array<{
      organizationId: string;
      organizationName: string;
      stats: {
        day: string;
        totalPacked: number;
        completedVideos: number;
        failedUploads: number;
        operators: number;
        avgDurationSeconds: number;
        mappingsImported: number;
        renamedToOrders: number;
        renamedBySubItem: number;
        stations: StationRow[];
        marketplaces: MarketplaceRow[];
      };
    }> = [];

    for (const org of orgsRes.rows) {
      const orgId = org.id;
      const [
        totalRes,
        completedRes,
        failedRes,
        operatorsRes,
        avgRes,
        mappingsRes,
        renamedRes,
        subItemsRes,
        stationsRes,
        marketplacesRes,
      ] = await Promise.all([
        pool.query(`SELECT COUNT(*) as count FROM recording_sessions WHERE created_at >= $1 AND created_at < $2 AND organization_id = $3`, [start, end, orgId]),
        pool.query(`SELECT COUNT(*) as count FROM video_assets WHERE uploaded_at >= $1 AND uploaded_at < $2 AND upload_status IN ('completed', 'uploaded') AND organization_id = $3`, [start, end, orgId]),
        pool.query(`SELECT COUNT(*) as count FROM video_assets WHERE created_at >= $1 AND created_at < $2 AND upload_status = 'failed' AND organization_id = $3`, [start, end, orgId]),
        pool.query(`SELECT COUNT(DISTINCT operator_user_id) as count FROM recording_sessions WHERE created_at >= $1 AND created_at < $2 AND operator_user_id IS NOT NULL AND organization_id = $3`, [start, end, orgId]),
        pool.query(`SELECT AVG(duration_ms) as avg FROM recording_sessions WHERE created_at >= $1 AND created_at < $2 AND organization_id = $3`, [start, end, orgId]),
        pool.query(`SELECT COUNT(*) as count FROM marketplace_order_mappings WHERE imported_at >= $1 AND imported_at < $2 AND organization_id = $3`, [start, end, orgId]),
        pool.query(`SELECT COUNT(*) as count FROM recording_sessions WHERE order_mapping_imported_at >= $1 AND order_mapping_imported_at < $2 AND organization_id = $3`, [start, end, orgId]),
        pool.query(`SELECT items FROM marketplace_orders WHERE COALESCE(awb_generated_at, created_at) >= $1 - INTERVAL '30 days' AND organization_id = $2 AND is_meesho LIMIT 5000`, [start, orgId]),
        pool.query(
          `SELECT COALESCE(s.code, 'UNKNOWN') as station, COUNT(*) as packed
           FROM recording_sessions rs
           LEFT JOIN stations s ON s.id = rs.station_id AND s.organization_id = rs.organization_id
           WHERE rs.created_at >= $1 AND rs.created_at < $2 AND rs.organization_id = $3
           GROUP BY s.code
           ORDER BY packed DESC`,
          [start, end, orgId]
        ),
        pool.query(
          `SELECT COALESCE(NULLIF(marketplace, ''), 'Unassigned') as marketplace, COUNT(*) as packed
           FROM recording_sessions
           WHERE created_at >= $1 AND created_at < $2 AND organization_id = $3
           GROUP BY COALESCE(NULLIF(marketplace, ''), 'Unassigned')
           ORDER BY packed DESC`,
          [start, end, orgId]
        ),
      ]);

      // Meesho-style rename: recordings whose order_id matches a known
      // sub-order/item id from THIS ORG'S synced Meesho orders.
      const knownSubIds = new Set<string>();
      for (const row of subItemsRes.rows) {
        const items = Array.isArray(row.items) ? row.items : [];
        for (const item of items) {
          if (typeof item?.subOrderId === 'string' && item.subOrderId.trim()) {
            knownSubIds.add(item.subOrderId.trim());
          }
        }
      }
      const renamedBySubItemRes = knownSubIds.size > 0
        ? await pool.query(
          `SELECT COUNT(*) as count FROM recording_sessions
            WHERE created_at >= $1 AND created_at < $2 AND organization_id = $3 AND order_id = ANY($4)`,
          [start, end, orgId, [...knownSubIds].slice(0, 10000)]
        )
        : { rows: [{ count: 0 }] };

      perOrg.push({
        organizationId: orgId,
        organizationName: org.name,
        stats: {
          day,
          totalPacked: Number(totalRes.rows[0]?.count || 0),
          completedVideos: Number(completedRes.rows[0]?.count || 0),
          failedUploads: Number(failedRes.rows[0]?.count || 0),
          operators: Number(operatorsRes.rows[0]?.count || 0),
          avgDurationSeconds: avgRes.rows[0]?.avg ? Number((Number(avgRes.rows[0].avg) / 1000).toFixed(1)) : 0,
          mappingsImported: Number(mappingsRes.rows[0]?.count || 0),
          renamedToOrders: Number(renamedRes.rows[0]?.count || 0),
          renamedBySubItem: Number(renamedBySubItemRes.rows[0]?.count || 0),
          stations: stationsRes.rows.map((r: any) => ({ station: r.station, packed: Number(r.packed) })),
          marketplaces: marketplacesRes.rows.map((r: any) => ({ marketplace: r.marketplace, packed: Number(r.packed) })),
        }
      });
    }

    if (dryRun) {
      return { dryRun: true, day, organizations: perOrg };
    }

    const resend = new Resend(resendKey as string);
    let sent = 0;
    for (const org of perOrg) {
      const subject = `[${org.organizationName}] ${buildDailyReportSubject(org.stats)}`;
      const html = buildDailyReportHtml(org.stats);
      const { error } = await resend.emails.send({
        from,
        to: recipients,
        subject,
        html,
      });
      if (error) {
        console.error(`Daily report send failed for org ${org.organizationName}:`, error);
        continue;
      }
      sent += 1;
    }

    return { sent, day, organizations: perOrg.length, totalPacked: perOrg.reduce((acc, o) => acc + o.stats.totalPacked, 0) };
  } catch (err) {
    console.error(err);
    return reply.status(500).send({ error: 'Failed to build daily report' });
  }
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVIEW_STATUSES = new Set(['none', 'disputed', 'resolved']);
const ORDER_MAPPING_HEADER_ALIASES = {
  trackingId: new Set(['trackingid', 'tracking', 'trackingnumber', 'trackingno', 'awb', 'airwaybill', 'shipmenttracker', 'shipmenttrackingid', 'shipmenttrackingnumber']),
  orderId: new Set(['orderid', 'order', 'ordernumber', 'orderno', 'marketplaceorderid', 'channelorderid']),
  marketplace: new Set(['marketplace', 'market', 'channel', 'channelname', 'platform', 'saleschannel']),
  extraInfo: new Set(['extrainfo'])
};

function safeDownloadName(value: unknown, fallback: string) {
  const name = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function normalizeIdentifier(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim().replace(/^[`']+/, '').trim();
  return normalized || null;
}

function normalizeMarketplace(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim().replace(/^[`']+/, '').replace(/\s+/g, ' ');
  const normalized = raw.includes(' - ') ? raw.split(' - ').pop()?.trim() || raw : raw;
  return normalized || null;
}

const SYNCED_ORDER_COLUMNS = `tracking_id, marketplace, channel_marketplace, channel_name, is_meesho,
  order_id, channel_order_id, invoice_id, items, status, status_group, source, manual_override, synced_at`;

// Synced (Forward Scan or hand-entered) order for one scanned barcode.
async function findSyncedOrder(organizationId: string, trackingId: string): Promise<any | null> {
  if (!isLookupTracking(trackingId)) return null;
  const res = await pool.query(
    `SELECT ${SYNCED_ORDER_COLUMNS}
     FROM marketplace_orders
     WHERE organization_id = $1 AND tracking_id = ANY($2::text[])
     ORDER BY updated_at DESC
     LIMIT 1`,
    [organizationId, trackingCandidates(trackingId, [normalizeTracker(trackingId)])]
  );
  return res.rows[0] || null;
}

// Synced order for a scan; on a miss (AWB newer than the last copy run, or
// older than the 3-day window) read just that AWB from the Forward Scan
// database — still no OMSGuru call. Used by the packing page, the upload
// worker's mapping lookup and the video metadata fallback.
async function findOrCopySyncedOrder(organizationId: string, trackingId: string): Promise<any | null> {
  const found = await findSyncedOrder(organizationId, trackingId);
  if (found || !isLookupTracking(trackingId) || !await receivesForwardScanCopy(organizationId)) return found;
  try {
    const copied = await copyOneForwardScanOrder(
      pool,
      organizationId,
      openForwardScanSourceForScan,
      trackingCandidates(trackingId, [normalizeTracker(trackingId)]),
      forwardScanExcludedMarketplaces
    );
    return copied ? { ...copied, source: 'forward-scan', manual_override: false, synced_at: new Date().toISOString() } : null;
  } catch (err) {
    // Forward Scan unreachable: callers fall back to mapping-only data.
    // Warn at most once a minute instead of on every scan.
    if (Date.now() - forwardScanLookupWarnedAt > 60_000) {
      forwardScanLookupWarnedAt = Date.now();
      console.warn('Forward Scan order lookup skipped:', err instanceof Error ? err.message : err);
    }
    return null;
  }
}

// Order Imports acknowledgement: stamp each uploaded AWB with its real order
// date — from the synced copy, else straight from Forward Scan (its 7 days).
async function fillMappingOrderDates(organizationId: string, trackingIds: string[]): Promise<number> {
  const ids = [...new Set(trackingIds.filter(isLookupTracking))];
  if (ids.length === 0) return 0;
  const fromCopy = await pool.query(
    `UPDATE marketplace_order_mappings mom
     SET order_date = COALESCE(mo.order_date, mo.awb_generated_at)
     FROM marketplace_orders mo
     WHERE mom.organization_id = $1 AND mo.organization_id = mom.organization_id
       AND mom.tracking_id = ANY($2::text[])
       AND mo.tracking_id = UPPER(BTRIM(mom.tracking_id))
       AND COALESCE(mo.order_date, mo.awb_generated_at) IS NOT NULL
       AND mom.order_date IS DISTINCT FROM COALESCE(mo.order_date, mo.awb_generated_at)`,
    [organizationId, ids]
  );
  let dated = fromCopy.rowCount ?? 0;
  try {
    dated += await fillMappingOrderDatesFromForwardScan(organizationId, ids);
  } catch (err) {
    console.warn('Forward Scan order dates for import skipped:', err instanceof Error ? err.message : err);
  }
  return dated;
}

async function fillMappingOrderDatesFromForwardScan(organizationId: string, ids: string[]): Promise<number> {
  let dated = 0;
  if (!(await receivesForwardScanCopy(organizationId))) return dated;
  const missing = await pool.query(
    `SELECT tracking_id FROM marketplace_order_mappings
     WHERE organization_id = $1 AND tracking_id = ANY($2::text[]) AND order_date IS NULL`,
    [organizationId, ids]
  );
  const byCanonical = new Map<string, string[]>();
  for (const row of missing.rows) {
    const canonical = normalizeForwardScanTracking(row.tracking_id);
    if (!canonical) continue;
    byCanonical.set(canonical, [...(byCanonical.get(canonical) || []), row.tracking_id]);
  }
  if (byCanonical.size === 0) return dated;
  const found = await lookupForwardScanOrderDates(openConfiguredForwardScanSource, [...byCanonical.keys()], forwardScanExcludedMarketplaces);
  const rows = [...found.entries()].flatMap(([canonical, info]) =>
    (byCanonical.get(canonical) || []).map((tracking_id) => ({ tracking_id, order_date: info.orderDate }))
  );
  if (rows.length > 0) {
    const res = await pool.query(
      `UPDATE marketplace_order_mappings mom
       SET order_date = r.order_date
       FROM jsonb_to_recordset($2::jsonb) AS r(tracking_id TEXT, order_date TIMESTAMPTZ)
       WHERE mom.organization_id = $1 AND mom.tracking_id = r.tracking_id`,
      [organizationId, JSON.stringify(rows)]
    );
    dated += res.rowCount ?? 0;
  }
  return dated;
}

// Order lines with their photo (manual SKU link > line image > catalogue >
// same style in another size). The style expression matches skuStyleKey
// and the idx_sku_images_org_style expression index.
async function resolveItemImages(organizationId: string, rawItems: unknown) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  const keys = [...new Set(items.map((item: any) => normalizeSkuKey(item?.sku)).filter((key) => key && key !== 'UNKNOWN'))];
  const styles = [...new Set(keys.map(skuStyleKey).filter(Boolean))];
  const imageRes = keys.length > 0
    ? await pool.query(
      `SELECT sku_key, title, image_url, source FROM sku_images
       WHERE organization_id = $1
         AND (sku_key = ANY($2::text[]) OR regexp_replace(sku_key, '_[^_]*$', '') = ANY($3::text[]))
       ORDER BY (sku_key = ANY($2::text[])) DESC
       LIMIT 500`,
      [organizationId, keys, styles]
    )
    : { rows: [] as any[] };
  return mergeItemImages(items, imageRes.rows);
}

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findHeaderIndex(headers: string[], aliases: Set<string>, preferLast = false) {
  const indexes = headers
    .map((header, index) => aliases.has(header) ? index : -1)
    .filter((index) => index >= 0);
  if (indexes.length === 0) return -1;
  return preferLast ? indexes[indexes.length - 1] : indexes[0];
}

function isAjioMarketplace(marketplace: string | null) {
  return Boolean(marketplace && marketplace.toLowerCase().includes('ajio'));
}

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  cells.push(current.trim());
  return cells;
}

function buildOrderMappingsFromRows(rows: any[], skipped: Array<{ row: number; reason: string }>) {
  return rows.flatMap((row, index) => {
    const rowNumber = Number(row?.rowNumber || index + 1);
    const trackingId = normalizeIdentifier(row?.trackingId ?? row?.tracking_id ?? row?.tracking ?? row?.trackingNumber ?? row?.shipmentTracker ?? row?.shipment_tracker);
    const marketplace = normalizeMarketplace(row?.marketplace ?? row?.market_place ?? row?.channel ?? row?.channelName ?? row?.channel_name ?? row?.platform);
    const channelOrderId = normalizeIdentifier(row?.orderId ?? row?.order_id ?? row?.order ?? row?.orderNumber ?? row?.channelOrderId ?? row?.channel_order_id);
    const extraInfoOrderId = normalizeIdentifier(row?.extraInfo ?? row?.extra_info);
    const ajio = isAjioMarketplace(marketplace);
    const orderId = ajio
      ? extraInfoOrderId || channelOrderId
      : channelOrderId || extraInfoOrderId;

    if (!trackingId || !orderId || !marketplace) {
      skipped.push({ row: rowNumber, reason: 'tracking_id, order_id, and marketplace are required' });
      return [];
    }

    // Ajio videos are renamed only to FN.../EX... customer order numbers;
    // other Ajio rows are acknowledged (marketplace + order date) as-is.
    const renameOrder = !ajio || isAjioRenameOrderId(orderId);
    return [{ trackingId, orderId, marketplace, renameOrder }];
  });
}

function parseOrderMappingRows(body: any) {
  const skipped: Array<{ row: number; reason: string }> = [];
  let rows: any[] = [];

  if (Array.isArray(body?.rows)) {
    rows = body.rows;
  } else if (typeof body?.csv === 'string') {
    const lines = body.csv
      .split(/\r?\n/)
      .map((line: string) => line.trim())
      .filter(Boolean);

    if (lines.length > 0) {
      const headers = parseCsvLine(lines[0]).map(normalizeHeader);
      const trackingIndex = findHeaderIndex(headers, ORDER_MAPPING_HEADER_ALIASES.trackingId);
      const orderIndex = findHeaderIndex(headers, ORDER_MAPPING_HEADER_ALIASES.orderId);
      const marketplaceIndex = findHeaderIndex(headers, ORDER_MAPPING_HEADER_ALIASES.marketplace);
      const extraInfoIndex = findHeaderIndex(headers, ORDER_MAPPING_HEADER_ALIASES.extraInfo, true);

      rows = lines.slice(1).map((line: string, index: number) => {
        const cells = parseCsvLine(line);
        return {
          rowNumber: index + 2,
          trackingId: trackingIndex >= 0 ? cells[trackingIndex] : '',
          orderId: orderIndex >= 0 ? cells[orderIndex] : '',
          marketplace: marketplaceIndex >= 0 ? cells[marketplaceIndex] : '',
          extraInfo: extraInfoIndex >= 0 ? cells[extraInfoIndex] : ''
        };
      });
    }
  }

  const mappings = buildOrderMappingsFromRows(rows, skipped);

  return { mappings, skipped };
}

function excelCellText(cell: ExcelJS.Cell) {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if ('text' in value && value.text !== undefined) return String(value.text);
    if ('result' in value && value.result !== undefined) return String(value.result);
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((item: any) => item.text || '').join('');
    }
    if (cell.text) return cell.text;
  }
  return String(value);
}

async function parseOrderMappingWorkbook(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const worksheet = workbook.worksheets[0];
  const skipped: Array<{ row: number; reason: string }> = [];

  if (!worksheet) {
    return { mappings: [], skipped: [{ row: 0, reason: 'Workbook has no worksheets' }] };
  }

  const headerRow = worksheet.getRow(1);
  const headers = new Map<number, string>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers.set(colNumber, normalizeHeader(excelCellText(cell)));
  });

  const orderedHeaders = [...headers.entries()];
  const trackingColumn = orderedHeaders.find(([, header]) => ORDER_MAPPING_HEADER_ALIASES.trackingId.has(header))?.[0];
  const orderColumn = orderedHeaders.find(([, header]) => ORDER_MAPPING_HEADER_ALIASES.orderId.has(header))?.[0];
  const marketplaceColumn = orderedHeaders.find(([, header]) => ORDER_MAPPING_HEADER_ALIASES.marketplace.has(header))?.[0];
  const extraInfoColumn = orderedHeaders.filter(([, header]) => ORDER_MAPPING_HEADER_ALIASES.extraInfo.has(header)).pop()?.[0];

  if (!trackingColumn || !orderColumn || !marketplaceColumn) {
    return {
      mappings: [],
      skipped: [{
        row: 1,
        reason: 'Required headers not found. Need Shipment Tracker, Channel Order Id, and Channel Name.'
      }]
    };
  }

  const rows: any[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    rows.push({
      rowNumber,
      trackingId: excelCellText(row.getCell(trackingColumn)),
      orderId: excelCellText(row.getCell(orderColumn)),
      marketplace: excelCellText(row.getCell(marketplaceColumn)),
      extraInfo: extraInfoColumn ? excelCellText(row.getCell(extraInfoColumn)) : ''
    });
  });

  return { mappings: buildOrderMappingsFromRows(rows, skipped), skipped };
}

interface StorageUsage {
  status: string;
  bucket: string | null;
  fileCount: number;
  bytes: number;
  formatted: string;
  error?: string;
}

// Stale-while-revalidate cache: a full bucket listing pages through every
// object, so at 1000+ videos/day/station it must not run per request.
// Overview polls every 30s and system-health every 15s; recompute at most
// every 10 minutes and serve the last known value meanwhile.
let storageUsageCache: { at: number; value: StorageUsage } | null = null;
let storageUsageRefresh: Promise<StorageUsage> | null = null;
const STORAGE_USAGE_TTL_MS = 10 * 60 * 1000;

async function computeFirebaseStorageUsage(): Promise<StorageUsage> {
  try {
    const bucket = getStorage().bucket(firebaseStorageBucket);
    const [files] = await bucket.getFiles({ prefix: 'packing-videos/' });
    const bytes = files.reduce((sum, file) => sum + Number(file.metadata.size || 0), 0);

    return {
      status: 'OK',
      bucket: bucket.name,
      fileCount: files.length,
      bytes,
      formatted: formatBytes(bytes)
    };
  } catch (err) {
    return {
      status: 'FAIL',
      bucket: firebaseStorageBucket || null,
      fileCount: 0,
      bytes: 0,
      formatted: '0 B',
      error: err instanceof Error ? err.message : 'Unable to read Firebase Storage'
    };
  }
}

async function getFirebaseStorageUsage(): Promise<StorageUsage> {
  const now = Date.now();
  if (storageUsageCache && now - storageUsageCache.at < STORAGE_USAGE_TTL_MS) {
    return storageUsageCache.value;
  }
  if (storageUsageCache) {
    // Serve stale immediately; refresh in the background once.
    if (!storageUsageRefresh) {
      storageUsageRefresh = computeFirebaseStorageUsage()
        .then((value) => {
          storageUsageCache = { at: Date.now(), value };
          return value;
        })
        .catch((err) => {
          console.warn('Background storage usage refresh failed:', err instanceof Error ? err.message : err);
          return storageUsageCache?.value ?? computeFirebaseStorageUsageFallback();
        })
        .finally(() => {
          storageUsageRefresh = null;
        });
    }
    return storageUsageCache.value;
  }
  const value = await computeFirebaseStorageUsage();
  storageUsageCache = { at: Date.now(), value };
  return value;
}

function computeFirebaseStorageUsageFallback(): StorageUsage {
  return {
    status: 'FAIL',
    bucket: firebaseStorageBucket || null,
    fileCount: 0,
    bytes: 0,
    formatted: '0 B',
    error: 'Unable to read Firebase Storage'
  };
}

async function ensureRuntimeTables() {
  await pool.query(`ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS order_id VARCHAR(255)`);
  await pool.query(`ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS marketplace VARCHAR(100)`);
  await pool.query(`ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS order_mapping_imported_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS data_retention_until TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS flyer_id VARCHAR(255)`);
  await pool.query(`ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS flyer_linked_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS flyer_link_status VARCHAR(50) DEFAULT 'PENDING'`);
  await pool.query(`ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS flyer_link_remark TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recording_sessions_flyer_queue ON recording_sessions (organization_id, flyer_link_status) WHERE flyer_id IS NOT NULL`);
  // video_assets columns the code reads/writes: older production tables were
  // created before some of these existed (no ALTERs ever covered them).
  await pool.query(`ALTER TABLE video_assets ADD COLUMN IF NOT EXISTS duration_ms BIGINT`);
  await pool.query(`ALTER TABLE video_assets ADD COLUMN IF NOT EXISTS review_status VARCHAR(50) DEFAULT 'none'`);
  await pool.query(`ALTER TABLE video_assets ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS default_station_id UUID REFERENCES stations(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE`);
  await pool.query(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS metadata JSONB`);
  // Roles were written mixed-case by different code paths ('admin' vs
  // 'ADMIN'); checks are case-insensitive but storage stays canonical.
  await pool.query(`UPDATE organization_members SET role = UPPER(role) WHERE role <> UPPER(role)`);

  // OMSGuru cache: SKU photos + recent order lines for the packing page.
  // Synced by the cron job; packing reads locally (never per-scan API).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS omsguru_sku_photos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      sku VARCHAR(255) NOT NULL,
      title TEXT,
      image_url TEXT NOT NULL,
      marketplace VARCHAR(255),
      fetched_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(organization_id, sku)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS omsguru_order_cache (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      tracking_id VARCHAR(255) NOT NULL,
      order_id VARCHAR(255),
      marketplace VARCHAR(255),
      items JSONB NOT NULL DEFAULT '[]',
      fetched_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(organization_id, tracking_id)
    )
  `);
  await pool.query(`ALTER TABLE omsguru_order_cache ADD COLUMN IF NOT EXISTS status_id VARCHAR(20)`);
  await pool.query(`ALTER TABLE omsguru_order_cache ADD COLUMN IF NOT EXISTS status TEXT`);
  await pool.query(`ALTER TABLE omsguru_order_cache ADD COLUMN IF NOT EXISTS status_checked_at TIMESTAMPTZ DEFAULT NOW()`);
  // PR-115: provenance for cache refreshes. NULL = auto-poll, otherwise
  // the user_id who forced the live refresh (admin test, sync button,
  // resolve-from-packing-page). Helps admins distinguish cache rows that
  // drifted naturally from those touched manually.
  await pool.query(`ALTER TABLE omsguru_order_cache ADD COLUMN IF NOT EXISTS last_refreshed_by UUID REFERENCES users(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE omsguru_order_cache ADD COLUMN IF NOT EXISTS last_refresh_source VARCHAR(50)`);

  // OMSGuru poll cursors: list endpoints paginate oldest-first, so each feed
  // remembers its high-water last_id and only reads what is new.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS omsguru_poll_state (
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      warehouse_id VARCHAR(50) NOT NULL DEFAULT '',
      feed VARCHAR(50) NOT NULL,
      last_id BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (organization_id, warehouse_id, feed)
    )
  `);

  // Marketplace-wise order copy from the Forward Scan database (last 3 days
  // by AWB date) plus hand-entered orders/corrections. One row per AWB;
  // tracking_id is Forward Scan's canonical tracking_norm. No buyer PII.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketplace_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      tracking_id VARCHAR(255) NOT NULL,
      tracking_raw TEXT,
      marketplace TEXT,
      channel_marketplace TEXT,
      channel_name TEXT,
      channel_id INTEGER,
      company TEXT,
      is_meesho BOOLEAN NOT NULL DEFAULT FALSE,
      order_id TEXT,
      channel_order_id TEXT,
      sub_order_ids TEXT,
      invoice_id TEXT,
      items JSONB NOT NULL DEFAULT '[]',
      item_count INTEGER NOT NULL DEFAULT 0,
      total_qty INTEGER NOT NULL DEFAULT 0,
      status TEXT,
      status_group TEXT,
      shipping_company TEXT,
      order_type TEXT,
      order_date TIMESTAMPTZ,
      awb_generated_at TIMESTAMPTZ,
      sla_date TIMESTAMPTZ,
      source VARCHAR(20) NOT NULL DEFAULT 'forward-scan',
      source_row_id BIGINT,
      source_synced_at TIMESTAMPTZ,
      source_hash VARCHAR(64),
      manual_override BOOLEAN NOT NULL DEFAULT FALSE,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (organization_id, tracking_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_marketplace_orders_org_awb ON marketplace_orders(organization_id, awb_generated_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_marketplace_orders_org_marketplace ON marketplace_orders(organization_id, marketplace, awb_generated_at DESC)`);

  // SKU photo links: Forward Scan catalogue rows and hand-entered links are
  // separate rows (source), so the copy never overwrites a manual link.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sku_images (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      sku TEXT NOT NULL,
      sku_key VARCHAR(255) NOT NULL,
      title TEXT,
      image_url TEXT NOT NULL,
      marketplace TEXT,
      source VARCHAR(20) NOT NULL DEFAULT 'forward-scan',
      source_updated_at TIMESTAMPTZ,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (organization_id, sku_key, source)
    )
  `);
  // Same style + colour in another size (skuStyleKey): scan-time fallback.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sku_images_org_style ON sku_images (organization_id, (regexp_replace(sku_key, '_[^_]*$', '')))`);

  // Nightly OMSGuru listing sweep (omsguru/skuImageSync.ts): raw listings
  // (oms_sku_id links a master SKU's channel names), one cursor per
  // channel, and a run ledger for the admin card.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS omsguru_listings (
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      channel_id BIGINT NOT NULL,
      listing_row_id BIGINT NOT NULL,
      sku_name TEXT NOT NULL,
      sku_key VARCHAR(255) NOT NULL,
      match_key VARCHAR(255) NOT NULL,
      oms_sku_id VARCHAR(64),
      title TEXT,
      image_url TEXT,
      marketplace TEXT,
      seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (organization_id, channel_id, listing_row_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_omsguru_listings_org_oms_sku ON omsguru_listings (organization_id, oms_sku_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS omsguru_listing_sync_state (
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      channel_id BIGINT NOT NULL,
      channel_name TEXT,
      last_id BIGINT NOT NULL DEFAULT 0,
      pass_started_at TIMESTAMPTZ,
      pass_completed_at TIMESTAMPTZ,
      caught_up_at TIMESTAMPTZ,
      pages_read INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (organization_id, channel_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sku_image_sync_runs (
      id BIGSERIAL PRIMARY KEY,
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      trigger VARCHAR(20) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'running',
      stopped_by VARCHAR(20),
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      calls INT NOT NULL DEFAULT 0,
      listings_seen INT NOT NULL DEFAULT 0,
      listings_stored INT NOT NULL DEFAULT 0,
      images_written INT NOT NULL DEFAULT 0,
      channels_completed INT NOT NULL DEFAULT 0,
      channels_total INT NOT NULL DEFAULT 0,
      error TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sku_image_sync_runs_org_started ON sku_image_sync_runs (organization_id, started_at DESC)`);

  // Keep the photos the old OMSGuru listing sweep already collected (it no
  // longer runs); Forward Scan rows are looked up alongside them.
  await pool.query(`
    INSERT INTO sku_images (organization_id, sku, sku_key, title, image_url, marketplace, source)
    SELECT DISTINCT ON (organization_id, REGEXP_REPLACE(UPPER(BTRIM(sku)), '\\s+', ' ', 'g'))
           organization_id, sku, REGEXP_REPLACE(UPPER(BTRIM(sku)), '\\s+', ' ', 'g'), title, image_url, marketplace, 'omsguru'
    FROM omsguru_sku_photos
    WHERE organization_id IS NOT NULL AND BTRIM(sku) <> '' AND image_url <> ''
    ORDER BY organization_id, REGEXP_REPLACE(UPPER(BTRIM(sku)), '\\s+', ' ', 'g'), fetched_at DESC
    ON CONFLICT (organization_id, sku_key, source) DO NOTHING
  `);

  // Public share links for single videos ("Copy link" in the Video Library).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_share_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      video_asset_id UUID NOT NULL REFERENCES video_assets(id) ON DELETE CASCADE,
      token VARCHAR(64) NOT NULL UNIQUE,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ,
      view_count INTEGER NOT NULL DEFAULT 0,
      last_viewed_at TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_video_share_links_video ON video_share_links(organization_id, video_asset_id) WHERE revoked_at IS NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS forward_scan_sync_state (
      organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      photo_cursor_at TEXT,
      photo_cursor_sku TEXT,
      last_run_at TIMESTAMPTZ,
      last_success_at TIMESTAMPTZ,
      last_error TEXT,
      last_orders_seen INTEGER NOT NULL DEFAULT 0,
      last_orders_written INTEGER NOT NULL DEFAULT 0,
      last_photos_written INTEGER NOT NULL DEFAULT 0,
      last_purged INTEGER NOT NULL DEFAULT 0,
      last_duration_ms INTEGER,
      source TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Ajio WFR (wrong-fulfilment CCTV) requests: one row per incident per org
  // so a dispute is never replied twice. Videos attach by order id.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ajio_wfr_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      incident_id VARCHAR(100) NOT NULL,
      order_id VARCHAR(100),
      shipment_id VARCHAR(100),
      reference_value VARCHAR(100),
      packing_time TIMESTAMPTZ,
      recording_session_id UUID REFERENCES recording_sessions(id) ON DELETE SET NULL,
      drive_file_id TEXT,
      drive_link TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      error TEXT,
      mail_message_id TEXT,
      requested_at TIMESTAMPTZ DEFAULT NOW(),
      replied_at TIMESTAMPTZ,
      reply_message_id TEXT,
      reply_to TEXT,
      reply_subject TEXT,
      reply_body TEXT,
      UNIQUE(organization_id, incident_id)
    )
  `);
  await pool.query(`ALTER TABLE ajio_wfr_requests ADD COLUMN IF NOT EXISTS reply_message_id TEXT`);
  await pool.query(`ALTER TABLE ajio_wfr_requests ADD COLUMN IF NOT EXISTS reply_to TEXT`);
  await pool.query(`ALTER TABLE ajio_wfr_requests ADD COLUMN IF NOT EXISTS reply_subject TEXT`);
  await pool.query(`ALTER TABLE ajio_wfr_requests ADD COLUMN IF NOT EXISTS reply_body TEXT`);

  // Ajio Gmail OAuth tokens: one connected mailbox per org (refresh token is
  // long-lived on Internal clients). Row presence = "Gmail connected".
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ajio_gmail_tokens (
      organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      email TEXT NOT NULL DEFAULT '',
      refresh_token TEXT NOT NULL DEFAULT '',
      access_token TEXT,
      access_expiry TIMESTAMPTZ,
      scopes TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Ajio WFR run ledger: one row per invocation (per org when scoped). The
  // safety net skips when a recent live success exists, the health endpoint
  // and the UI banner read the latest row, and failure alerts fire from it.
  // A missed CCTV reply risks an Ajio penalty, so this table is the
  // dead-man's-switch — never the absence of a cron log.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ajio_wfr_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      trigger VARCHAR(30) NOT NULL DEFAULT 'cron',
      dry_run BOOLEAN NOT NULL DEFAULT FALSE,
      status VARCHAR(20) NOT NULL,
      checked INT NOT NULL DEFAULT 0,
      replied INT NOT NULL DEFAULT 0,
      missing INT NOT NULL DEFAULT 0,
      failed INT NOT NULL DEFAULT 0,
      used_fallback BOOLEAN NOT NULL DEFAULT FALSE,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ajio_wfr_runs_org_created ON ajio_wfr_runs (organization_id, created_at DESC)`);

  // OMSGuru credentials per org (rotatable from the admin UI); env fallback.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS omsguru_settings (
      organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      token TEXT NOT NULL DEFAULT '',
      cid TEXT NOT NULL DEFAULT '',
      warehouse_id VARCHAR(50) NOT NULL DEFAULT '',
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Meesho supplier portal login credentials per org (for automatic desktop login)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meesho_settings (
      organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      username TEXT NOT NULL DEFAULT '',
      password TEXT NOT NULL DEFAULT '',
      supplier_hub_url TEXT NOT NULL DEFAULT 'https://supplier.meesho.com/panel/v3/new/root/login',
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE meesho_settings ADD COLUMN IF NOT EXISTS companion_token VARCHAR(255)`);
  // Packing page: Meesho parcels switch flyer-bag scanning ON automatically.
  await pool.query(`ALTER TABLE meesho_settings ADD COLUMN IF NOT EXISTS auto_flyer_scan BOOLEAN NOT NULL DEFAULT TRUE`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_meesho_settings_companion_token ON meesho_settings(companion_token)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      action VARCHAR(100) NOT NULL,
      resource VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketplace_order_mappings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      tracking_id VARCHAR(255) NOT NULL,
      order_id VARCHAR(255) NOT NULL,
      marketplace VARCHAR(100) NOT NULL,
      source_file VARCHAR(255),
      imported_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(organization_id, tracking_id)
    )
  `);
  // Ajio rows without an FN/EX order number are acknowledged but never
  // rename the video; order_date comes from the synced order (Forward Scan).
  await pool.query(`ALTER TABLE marketplace_order_mappings ADD COLUMN IF NOT EXISTS rename_order BOOLEAN NOT NULL DEFAULT TRUE`);
  await pool.query(`ALTER TABLE marketplace_order_mappings ADD COLUMN IF NOT EXISTS order_date TIMESTAMPTZ`);
  // Ajio rows imported before the rule existed: same check as
  // isAjioRenameOrderId (letters+digits), so they stop renaming videos to
  // plain channel ids. Idempotent; touches only still-TRUE non-FN/EX rows.
  await pool.query(`
    UPDATE marketplace_order_mappings SET rename_order = FALSE
    WHERE rename_order AND LOWER(marketplace) LIKE '%ajio%'
      AND BTRIM(order_id) !~* '^[A-Z]{2,4}[0-9]{6,}$'
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_import_batches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      source_file VARCHAR(255),
      mime_type VARCHAR(255),
      raw_file BYTEA,
      imported_rows INTEGER DEFAULT 0,
      skipped_rows INTEGER DEFAULT 0,
      status VARCHAR(50) DEFAULT 'processing',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      raw_purged_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketplace_retention_policies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      marketplace VARCHAR(100) NOT NULL,
      video_retention_days INTEGER,
      data_retention_days INTEGER,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(organization_id, marketplace)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS recording_sessions (
      id UUID PRIMARY KEY,
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      tracking_id VARCHAR(255),
      order_id VARCHAR(255),
      marketplace VARCHAR(100),
      flyer_id VARCHAR(255),
      order_mapping_imported_at TIMESTAMPTZ,
      station_id UUID REFERENCES stations(id) ON DELETE SET NULL,
      operator_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      duration_ms BIGINT,
      
      status VARCHAR(50),
      data_retention_until TIMESTAMPTZ,
      
      camera_device_id TEXT,
      camera_label TEXT,
      
      requested_width INTEGER,
      requested_height INTEGER,
      actual_width INTEGER,
      actual_height INTEGER,
      actual_fps NUMERIC,
      
      mime_type VARCHAR(100),
      video_bitrate INTEGER,
      
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_assets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      recording_session_id UUID REFERENCES recording_sessions(id) ON DELETE CASCADE,
      
      storage_provider VARCHAR(50) DEFAULT 'firebase',
      storage_bucket TEXT,
      storage_path TEXT,
      
      mime_type VARCHAR(100),
      size_bytes BIGINT,
      
      width INTEGER,
      height INTEGER,
      fps NUMERIC,
      duration_ms BIGINT,
      
      upload_status VARCHAR(50),
      
      uploaded_at TIMESTAMPTZ,
      verified_at TIMESTAMPTZ,
      
      retention_until TIMESTAMPTZ,
      legal_hold BOOLEAN DEFAULT FALSE,
      review_status VARCHAR(50) DEFAULT 'none',
      
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recording_sessions_order_id ON recording_sessions(organization_id, order_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recording_sessions_marketplace ON recording_sessions(organization_id, marketplace)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recording_sessions_data_retention ON recording_sessions(organization_id, data_retention_until)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_marketplace_order_mappings_marketplace ON marketplace_order_mappings(organization_id, marketplace)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_marketplace_order_mappings_order_id ON marketplace_order_mappings(organization_id, order_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_video_assets_retention_until ON video_assets(organization_id, retention_until)`);

  // PR-115: query-shape composite indexes. See migrations/003_* for the
  // rationale per index. ensureRuntimeTables() is idempotent so the same
  // statements appear in both the migration file and this block — running
  // migrate.ts first then the runtime apply keeps them in sync.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_video_assets_org_status_uploaded ON video_assets(organization_id, upload_status, uploaded_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_video_assets_org_created ON video_assets(organization_id, created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recording_sessions_org_station_created ON recording_sessions(organization_id, station_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recording_sessions_org_operator_created ON recording_sessions(organization_id, operator_user_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recording_sessions_org_tracking ON recording_sessions(organization_id, tracking_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_marketplace_order_mappings_org_imported ON marketplace_order_mappings(organization_id, imported_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_omsguru_order_cache_org_status_checked ON omsguru_order_cache(organization_id, status_checked_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_omsguru_sku_photos_org_sku ON omsguru_sku_photos(organization_id, sku)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ajio_wfr_requests_org_status_requested ON ajio_wfr_requests(organization_id, status, requested_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created ON audit_logs(organization_id, created_at DESC)`);

  // pending_storage_deletions: durable retry queue for Storage deletes that
  // failed during retention purge. Swept on every run.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_storage_deletions (
      id SERIAL PRIMARY KEY,
      storage_path TEXT NOT NULL,
      video_asset_id UUID,
      last_error TEXT,
      attempts INT DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_attempt_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pending_storage_deletions_storage_path ON pending_storage_deletions(storage_path)`);
}

async function applyRetentionPoliciesForOrganization(
  queryable: { query: (text: string, params?: any[]) => Promise<any> },
  organizationId: string,
  recordingId?: string
) {
  const params: any[] = [organizationId];
  const recordingFilter = recordingId ? ` AND rs.id = $${params.push(recordingId)}` : '';

  await queryable.query(
    `UPDATE recording_sessions rs
     SET data_retention_until = CASE
       WHEN mrp.data_retention_days IS NULL THEN NULL
       ELSE rs.created_at + (mrp.data_retention_days * INTERVAL '1 day')
     END,
     updated_at = NOW()
     FROM marketplace_retention_policies mrp
     WHERE rs.organization_id = $1
       AND mrp.organization_id = rs.organization_id
       AND LOWER(mrp.marketplace) = LOWER(COALESCE(NULLIF(rs.marketplace, ''), 'Unassigned'))
       ${recordingFilter}`,
    params
  );

  await queryable.query(
    `UPDATE video_assets va
     SET retention_until = CASE
       WHEN mrp.video_retention_days IS NULL THEN NULL
       ELSE rs.created_at + (mrp.video_retention_days * INTERVAL '1 day')
     END
     FROM recording_sessions rs
     JOIN marketplace_retention_policies mrp
       ON mrp.organization_id = rs.organization_id
      AND LOWER(mrp.marketplace) = LOWER(COALESCE(NULLIF(rs.marketplace, ''), 'Unassigned'))
     WHERE va.recording_session_id = rs.id
       AND va.organization_id = $1
       ${recordingFilter}`,
    params
  );
}

async function repairExistingVideoAssets() {
  await pool.query(`
    UPDATE video_assets va
    SET recording_session_id = rs.id
    FROM recording_sessions rs
    WHERE va.recording_session_id IS NULL
      AND va.id = rs.id
      AND va.organization_id = rs.organization_id
  `);

  if (firebaseStorageBucket) {
    await pool.query(
      `UPDATE video_assets
       SET storage_bucket = COALESCE(storage_bucket, $1)
       WHERE storage_path IS NOT NULL AND storage_path <> ''`,
      [firebaseStorageBucket]
    );
  }

  try {
    const assetsRes = await pool.query(
      `SELECT id, storage_path
       FROM video_assets
       WHERE storage_path IS NOT NULL
         AND storage_path <> ''
         AND (size_bytes IS NULL OR size_bytes = 0)
       LIMIT 500`
    );

    if (assetsRes.rows.length === 0) return;

    const bucket = getStorage().bucket(firebaseStorageBucket);
    for (const asset of assetsRes.rows) {
      const file = bucket.file(asset.storage_path);
      const [exists] = await file.exists();
      if (!exists) continue;

      const [metadata] = await file.getMetadata();
      await pool.query(
        `UPDATE video_assets
         SET size_bytes = COALESCE($2, size_bytes),
             mime_type = COALESCE($3, mime_type),
             storage_bucket = COALESCE(storage_bucket, $4)
         WHERE id = $1`,
        [
          asset.id,
          metadata.size ? Number(metadata.size) : null,
          metadata.contentType || null,
          bucket.name
        ]
      );
    }
  } catch (err) {
    console.warn('Video asset storage metadata repair skipped:', err);
  }
}

server.register(async (protectedRoutes) => {
  protectedRoutes.addHook('onRequest', requireAuth);

  // Single-use download tickets (see downloads.ts). A plain browser
  // navigation carries no login token, so the packing page button mints a
  // 60s ticket here and navigates with it on the public /file route below.

  // Desktop installer download: login required. The packing page button
  // fetches this with the user's Bearer token, so only signed-in staff can
  // download. Publish by dropping the built PVMS-Packing-Setup-*.exe into
  // DESKTOP_DOWNLOAD_DIR (default <server-cwd>/downloads); newest file wins.
  protectedRoutes.get('/api/downloads/info', async () => {
    const latest = findLatestInstaller(getDesktopDownloadDir());
    if (!latest) return { available: false };
    return { available: true, ...latest };
  });

  protectedRoutes.get('/api/downloads/latest', async (request, reply) => {
    return sendLatestInstaller(reply, getDesktopDownloadDir());
  });

  // Ticket minting for the packing page button (login-gated). The button
  // navigates to /api/downloads/file?t=<ticket> so the browser streams the
  // file with normal progress — no token header, no memory buffering.
  protectedRoutes.post('/api/downloads/ticket', async (request, reply) => {
    const dir = getDesktopDownloadDir();
    if (!readLatestReleaseRef(dir) && !findLatestInstaller(dir)) {
      return reply.status(404).send({ error: 'No desktop installer published yet' });
    }
    return issueDownloadTicket(downloadTicketStore);
  });

  protectedRoutes.post('/api/videos/upload', async (req, reply) => {
    const user = (req as any).user;
    
    const body = req.body as {
      id: string;
      trackingId: string;
      timestamp: number;
      duration: number;
      stationId: string;
      packerId: string;
      storagePath: string;
      mimeType: string;
      width: number;
      height: number;
      fps: number;
      sizeBytes?: number;
      videoBitrate?: number;
      orderId?: string;
      marketplace?: string;
      flyerId?: string;
    };
    
    if (!body || !body.id) {
      return reply.status(400).send({ error: 'Missing metadata' });
    }
    
    const {
      id, trackingId, timestamp, duration, stationId, packerId,
      storagePath, mimeType, width, height, fps, sizeBytes, videoBitrate, orderId, marketplace, flyerId
    } = body;
    const timestampMs = Number(timestamp);
    const durationSeconds = Number(duration);
    const assetSizeBytes = Number(sizeBytes || 0);
    const assetBitrate = Number(videoBitrate);
    const normalizedTrackingId = normalizeIdentifier(trackingId) || 'UNKNOWN';
    const normalizedFlyerId = typeof flyerId === 'string' && flyerId.trim() ? flyerId.trim().slice(0, 64) : null;

    if (!UUID_PATTERN.test(id)) {
      return reply.status(400).send({ error: 'Invalid recording id' });
    }

    if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
      return reply.status(400).send({ error: 'Invalid recording timestamp' });
    }

    if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
      return reply.status(400).send({ error: 'Invalid recording duration' });
    }

    // Cross-tenant storage path guard: the bytes went through the user's
    // Firebase token so they cannot upload into another org's prefix, but the
    // DB pointer is created server-side and must be rejected otherwise.
    if (!isAcceptableStoragePath(storagePath, user.organization_id)) {
      return reply.status(400).send({ error: 'storagePath must be inside this organization' });
    }

    // Quality floor and size ceiling match the client recorder (AGENTS.md).
    // Coerce to Number() because a JSON string ("480") would otherwise
    // bypass Number.isFinite and slip past the floor check.
    const sizeBytesNum = Number(assetSizeBytes);
    if (!Number.isFinite(sizeBytesNum) || sizeBytesNum <= 0 || sizeBytesNum > 500 * 1024 * 1024) {
      return reply.status(400).send({ error: 'sizeBytes must be 1..524288000' });
    }
    const heightNum = Number(height);
    if (Number.isFinite(heightNum) && heightNum > 0 && heightNum < 720) {
      return reply.status(400).send({ error: 'height below MIN_RECORDING_HEIGHT (720)' });
    }
    
    try {
      const mappingRes = await pool.query(
        `SELECT order_id, marketplace, rename_order
         FROM marketplace_order_mappings
         WHERE organization_id = $1 AND tracking_id = $2
         LIMIT 1`,
        [user.organization_id, normalizedTrackingId]
      );
      // No Order Imports mapping: fall back to the Forward Scan copy so the
      // recording still gets its marketplace (retention) and order id.
      const synced = !mappingRes.rows[0] && normalizedTrackingId !== 'UNKNOWN'
        ? await findOrCopySyncedOrder(user.organization_id, normalizedTrackingId)
        : null;
      const mappingOrderId = mappingRes.rows[0]?.rename_order === false ? null : mappingRes.rows[0]?.order_id;
      const resolvedOrderId = normalizeIdentifier(orderId) || mappingOrderId || (synced ? recordingOrderId(synced) : null) || null;
      const resolvedMarketplace = normalizeMarketplace(marketplace) || mappingRes.rows[0]?.marketplace || synced?.marketplace || null;
      let stationDbId: string | null = null;
      if (stationId && UUID_PATTERN.test(stationId)) {
        const stationRes = await pool.query(
          'SELECT id FROM stations WHERE organization_id = $1 AND id = $2 LIMIT 1',
          [user.organization_id, stationId]
        );
        stationDbId = stationRes.rows[0]?.id || null;
      } else if (stationId && stationId !== 'UNKNOWN') {
        const stationRes = await pool.query(
          'SELECT id FROM stations WHERE organization_id = $1 AND code = $2 LIMIT 1',
          [user.organization_id, stationId]
        );
        stationDbId = stationRes.rows[0]?.id || null;
      }
      
      // Upsert into recording_sessions (column/expression counts locked by
      // buildRecordingSessionUpsert + unit test — see db/recordingSessions.ts)
      const sessionUpsert = buildRecordingSessionUpsert({
        id,
        organizationId: user.organization_id,
        trackingId: normalizedTrackingId,
        stationId: stationDbId,
        operatorUserId: user.user_id,
        durationMs: durationSeconds * 1000,
        status: 'completed',
        orderId: resolvedOrderId,
        marketplace: resolvedMarketplace,
        flyerId: normalizedFlyerId,
        timestampMs,
        width: width || 1920,
        height: height || 1080,
        fps: fps || 30,
        mimeType: mimeType || 'video/mp4',
        videoBitrate: Number.isFinite(assetBitrate) ? assetBitrate : null,
        orderMappingImportedAtMs: resolvedOrderId || resolvedMarketplace ? Date.now() : null,
      });
      const sessionRes = await pool.query(sessionUpsert.text, sessionUpsert.values);
      if ((sessionRes.rowCount ?? 0) === 0) {
        return reply.status(409).send({ error: 'Recording already exists in another organization' });
      }

      const assetRes = await pool.query(
        `INSERT INTO video_assets (
          id, organization_id, recording_session_id,
          storage_provider, storage_bucket, storage_path, mime_type, size_bytes, 
          width, height, fps, duration_ms, upload_status, uploaded_at,
          verified_at, retention_until
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, to_timestamp($14 / 1000.0), NULL, NULL)
         ON CONFLICT (id) DO UPDATE SET
          recording_session_id = EXCLUDED.recording_session_id,
          storage_provider = EXCLUDED.storage_provider,
          storage_bucket = EXCLUDED.storage_bucket,
          storage_path = EXCLUDED.storage_path,
          mime_type = EXCLUDED.mime_type,
          size_bytes = EXCLUDED.size_bytes,
          width = EXCLUDED.width,
          height = EXCLUDED.height,
          fps = EXCLUDED.fps,
          duration_ms = EXCLUDED.duration_ms,
          upload_status = EXCLUDED.upload_status,
          uploaded_at = EXCLUDED.uploaded_at,
          verified_at = COALESCE(EXCLUDED.verified_at, video_assets.verified_at),
          retention_until = COALESCE(EXCLUDED.retention_until, video_assets.retention_until)
         WHERE video_assets.organization_id = EXCLUDED.organization_id`,
        [
          id, user.organization_id, id,
          'firebase', firebaseStorageBucket || '', storagePath || '', mimeType || 'video/mp4', assetSizeBytes,
          width || 1920, height || 1080, fps || 30,
          durationSeconds * 1000, 'completed', timestampMs
        ]
      );
      if ((assetRes.rowCount ?? 0) === 0) {
        return reply.status(409).send({ error: 'Video already exists in another organization' });
      }

      await applyRetentionPoliciesForOrganization(pool, user.organization_id, id);

    } catch (dbErr) {
      console.error('DB Insert Error:', dbErr);
      const errorMessage = dbErr instanceof Error ? dbErr.message : 'Unknown database error';
      console.error('Video upload metadata insert failed:', errorMessage);
      
      // Extract more specific error information
      const isUniqueViolation = errorMessage.includes('unique constraint') || errorMessage.includes('duplicate key');
      const isForeignKeyViolation = errorMessage.includes('foreign key constraint');
      const isNullViolation = errorMessage.includes('null value in column') || errorMessage.includes("column \"");
      
      return reply.status(500).send({ 
        error: isUniqueViolation ? 'Duplicate entry' : isForeignKeyViolation ? 'Invalid reference' : isNullViolation ? 'Missing required field' : 'Database error',
        code: isUniqueViolation ? 'UNIQUE_VIOLATION' : isForeignKeyViolation ? 'FOREIGN_KEY_VIOLATION' : isNullViolation ? 'NULL_VIOLATION' : 'DB_ERROR'
      });
    }

    return { success: true, id };
  });

  protectedRoutes.get<{ Querystring: { trackingId?: string } }>('/api/order-mappings/resolve', async (req, reply) => {
    const user = (req as any).user;
    const trackingId = normalizeIdentifier(req.query.trackingId);

    if (!trackingId) {
      return reply.status(400).send({ error: 'trackingId is required' });
    }

    try {
      const res = await pool.query(
        `SELECT tracking_id, order_id, marketplace, imported_at, rename_order
         FROM marketplace_order_mappings
         WHERE organization_id = $1 AND tracking_id = $2
         LIMIT 1`,
        [user.organization_id, trackingId]
      );
      if (res.rows[0]) {
        const row = res.rows[0];
        // Acknowledged-only Ajio rows file the video under Ajio, no rename.
        return { mapping: { ...row, order_id: row.rename_order === false ? null : row.order_id }, source: 'mapping' };
      }

      // The upload worker names/files each video from this answer: without
      // an Order Imports row, use the synced Forward Scan order.
      const synced = await findOrCopySyncedOrder(user.organization_id, trackingId);
      if (!synced) return { mapping: null };
      return {
        mapping: {
          tracking_id: synced.tracking_id,
          order_id: recordingOrderId(synced),
          marketplace: synced.marketplace,
          imported_at: synced.synced_at,
        },
        source: 'synced',
      };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to resolve order mapping' });
    }
  });

  // Packing-page order context: Order Imports mapping first, then the
  // Forward Scan copy for marketplace, SKU lines and photos. An AWB the
  // copy has not reached yet is read straight from the Forward Scan
  // database (local DB read) — the packing page never calls OMSGuru.
  protectedRoutes.get<{ Querystring: { trackingId?: string } }>('/api/order-context/resolve', async (req, reply) => {
    const user = (req as any).user;
    const trackingId = normalizeIdentifier(req.query.trackingId);

    if (!trackingId) {
      return reply.status(400).send({ error: 'trackingId is required' });
    }

    if (!isLookupTracking(trackingId)) {
      return reply.status(400).send({ error: 'trackingId is too long' });
    }
    const candidates = trackingCandidates(trackingId, [normalizeTracker(trackingId)]);

    try {
      const [mappingRes, order] = await Promise.all([
        pool.query(
          `SELECT order_id, marketplace, rename_order
           FROM marketplace_order_mappings
           WHERE organization_id = $1 AND tracking_id = ANY($2::text[])
           LIMIT 1`,
          [user.organization_id, candidates]
        ),
        findOrCopySyncedOrder(user.organization_id, trackingId),
      ]);

      const mapping = mappingRes.rows[0] || null;
      const items = order ? await resolveItemImages(user.organization_id, order.items) : [];
      const mappingMarketplace = normalizeMarketplace(mapping?.marketplace);
      const marketplace = mappingMarketplace || order?.marketplace || null;

      return {
        trackingId,
        orderId: (mapping?.rename_order !== false ? normalizeIdentifier(mapping?.order_id) : null) || order?.order_id || null,
        marketplace,
        channel: order?.channel_name || null,
        // Drives the packing page's Meesho flyer toggle: on for Meesho,
        // off for every other known marketplace.
        isMeesho: mappingMarketplace ? isMeeshoText(mappingMarketplace) : Boolean(order?.is_meesho),
        statusId: null,
        status: order?.status || null,
        statusGroup: order?.status_group || null,
        items,
        source: order
          ? (order.source === 'manual' || order.manual_override ? 'manual' : 'forward-scan')
          : mapping ? 'mapping' : 'none',
      };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to resolve order context' });
    }
  });

  protectedRoutes.post('/api/admin/order-mappings/import', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    let sourceFile = 'manual-import';
    let mimeType = 'application/json';
    let rawImportBuffer: Buffer | null = null;
    let mappings: Array<{ trackingId: string; orderId: string; marketplace: string; renameOrder: boolean }> = [];
    let skipped: Array<{ row: number; reason: string }> = [];

    if ((req as any).isMultipart?.()) {
      const uploadedFile = await (req as any).file();
      if (!uploadedFile) {
        return reply.status(400).send({ error: 'No import file uploaded' });
      }

      sourceFile = normalizeIdentifier(uploadedFile.filename) || 'uploaded-file';
      mimeType = uploadedFile.mimetype || 'application/octet-stream';
      const fileBuffer = await uploadedFile.toBuffer();
      rawImportBuffer = fileBuffer;
      const lowerFilename = sourceFile.toLowerCase();

      if (lowerFilename.endsWith('.xlsx')) {
        ({ mappings, skipped } = await parseOrderMappingWorkbook(fileBuffer));
      } else if (lowerFilename.endsWith('.csv') || uploadedFile.mimetype === 'text/csv') {
        ({ mappings, skipped } = parseOrderMappingRows({ csv: fileBuffer.toString('utf8') }));
      } else {
        return reply.status(400).send({ error: 'Unsupported import file. Upload CSV or Excel XLSX.' });
      }
    } else {
      const body = req.body as any;
      sourceFile = normalizeIdentifier(body?.sourceFile) || 'manual-import';
      rawImportBuffer = Buffer.from(JSON.stringify(body || {}), 'utf8');
      ({ mappings, skipped } = parseOrderMappingRows(body));
    }

    if (mappings.length === 0) {
      return reply.status(400).send({ error: 'No valid order mappings found', skipped });
    }

    if (mappings.length > 20000) {
      return reply.status(400).send({ error: 'Too many rows. Split imports into files of 20,000 rows or fewer.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const batchRes = await client.query(
        `INSERT INTO order_import_batches (
           organization_id, user_id, source_file, mime_type, raw_file, imported_rows, skipped_rows, status, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing', NOW())
         RETURNING id`,
        [
          user.organization_id,
          user.user_id,
          sourceFile,
          mimeType,
          rawImportBuffer,
          mappings.length,
          skipped.length
        ]
      );
      const importBatchId = batchRes.rows[0].id;

      for (const mapping of mappings) {
        await client.query(
          `INSERT INTO marketplace_order_mappings (
             organization_id, tracking_id, order_id, marketplace, source_file, rename_order, imported_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (organization_id, tracking_id) DO UPDATE SET
             order_id = EXCLUDED.order_id,
             marketplace = EXCLUDED.marketplace,
             source_file = EXCLUDED.source_file,
             rename_order = EXCLUDED.rename_order,
             imported_at = NOW()`,
          [user.organization_id, mapping.trackingId, mapping.orderId, mapping.marketplace, sourceFile, mapping.renameOrder]
        );
      }

      const updateRes = await client.query(
        `UPDATE recording_sessions rs
         SET order_id = CASE WHEN mom.rename_order THEN mom.order_id ELSE rs.order_id END,
             marketplace = mom.marketplace,
             order_mapping_imported_at = NOW(),
             updated_at = NOW()
         FROM marketplace_order_mappings mom
         WHERE rs.organization_id = $1
           AND mom.organization_id = rs.organization_id
           AND mom.tracking_id = rs.tracking_id
           AND (
             (mom.rename_order AND rs.order_id IS DISTINCT FROM mom.order_id)
             OR rs.marketplace IS DISTINCT FROM mom.marketplace
           )`,
        [user.organization_id]
      );

      await client.query(
        `INSERT INTO audit_logs (organization_id, user_id, action, resource, created_at)
         VALUES ($1, $2, 'IMPORT', 'ORDER_MAPPINGS', NOW())`,
        [user.organization_id, user.user_id]
      );

      await applyRetentionPoliciesForOrganization(client, user.organization_id);

      await client.query(
        `UPDATE order_import_batches
         SET raw_file = NULL,
             raw_purged_at = NOW(),
             status = 'processed'
         WHERE id = $1`,
        [importBatchId]
      );

      await client.query('COMMIT');

      // Acknowledge the uploaded orders with their real order date (synced
      // copy first, then Forward Scan for AWBs outside the 3-day window).
      const datedOrders = await fillMappingOrderDates(user.organization_id, mappings.map((m) => m.trackingId)).catch((err) => {
        console.warn('Order date lookup for import skipped:', err instanceof Error ? err.message : err);
        return 0;
      });

      return {
        imported: mappings.length,
        updatedRecordings: updateRes.rowCount || 0,
        notRenamed: mappings.filter((m) => !m.renameOrder).length,
        datedOrders,
        skipped
      };
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      return reply.status(500).send({ error: 'Failed to import order mappings' });
    } finally {
      client.release();
    }
  });

  protectedRoutes.post('/api/admin/order-mappings/reconcile', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    try {
      const updateRes = await pool.query(
        `UPDATE recording_sessions rs
         SET order_id = CASE WHEN mom.rename_order THEN mom.order_id ELSE rs.order_id END,
             marketplace = mom.marketplace,
             order_mapping_imported_at = NOW(),
             updated_at = NOW()
         FROM marketplace_order_mappings mom
         WHERE rs.organization_id = $1
           AND mom.organization_id = rs.organization_id
           AND mom.tracking_id = rs.tracking_id
           AND (
             (mom.rename_order AND rs.order_id IS DISTINCT FROM mom.order_id)
             OR rs.marketplace IS DISTINCT FROM mom.marketplace
           )`,
        [user.organization_id]
      );

      await pool.query(
        `INSERT INTO audit_logs (organization_id, user_id, action, resource, created_at)
         VALUES ($1, $2, 'RECONCILE', 'ORDER_MAPPINGS', NOW())`,
        [user.organization_id, user.user_id]
      );

      await applyRetentionPoliciesForOrganization(pool, user.organization_id);

      return { updatedRecordings: updateRes.rowCount || 0 };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to reconcile order mappings' });
    }
  });

  protectedRoutes.get<{ Querystring: { search?: string; marketplace?: string; limit?: string } }>('/api/admin/order-mappings', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const { search, marketplace, limit } = req.query;
    const params: any[] = [user.organization_id];
    let where = 'WHERE mom.organization_id = $1';

    if (search) {
      params.push(`%${search}%`);
      where += ` AND (mom.tracking_id ILIKE $${params.length} OR mom.order_id ILIKE $${params.length})`;
    }

    if (marketplace && marketplace !== 'All Marketplaces') {
      params.push(marketplace);
      where += ` AND LOWER(mom.marketplace) = LOWER($${params.length})`;
    }

    const requestedLimit = limit ? parseInt(limit, 10) : 100;
    params.push(Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100);

    try {
      const [mappingRes, marketplaceRes] = await Promise.all([
        pool.query(
          `SELECT mom.tracking_id, mom.order_id, mom.marketplace, mom.source_file, mom.imported_at,
                  mom.rename_order, mom.order_date,
                  rs.id AS recording_id, rs.order_id AS recording_order_id, rs.created_at AS recorded_at
           FROM marketplace_order_mappings mom
           LEFT JOIN LATERAL (
             SELECT id, order_id, created_at FROM recording_sessions r
             WHERE r.organization_id = mom.organization_id AND r.tracking_id = mom.tracking_id
             ORDER BY r.created_at DESC
             LIMIT 1
           ) rs ON TRUE
           ${where}
           ORDER BY mom.imported_at DESC
           LIMIT $${params.length}`,
          params
        ),
        pool.query(
          `SELECT marketplace, COUNT(*) as count
           FROM marketplace_order_mappings
           WHERE organization_id = $1
           GROUP BY marketplace
           ORDER BY marketplace`,
          [user.organization_id]
        )
      ]);

      return {
        mappings: mappingRes.rows,
        marketplaces: marketplaceRes.rows
      };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to load order mappings' });
    }
  });

  // Recordings that never matched an order mapping (no rename, file sitting
  // outside its marketplace/order folder). Remap them by hand here.
  protectedRoutes.get<{ Querystring: { search?: string; stage?: string; limit?: string } }>('/api/admin/recordings/unmapped', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const { search, stage, limit } = req.query;
    const params: any[] = [user.organization_id];
    let where = `WHERE rs.organization_id = $1
      AND (NULLIF(rs.order_id, '') IS NULL OR NULLIF(rs.marketplace, '') IS NULL)`;

    if (search) {
      params.push(`%${search}%`);
      where += ` AND (rs.tracking_id ILIKE $${params.length} OR rs.order_id ILIKE $${params.length})`;
    }

    const requestedLimit = limit ? parseInt(limit, 10) : 100;
    params.push(Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100);

    try {
      const res = await pool.query(
        `SELECT rs.id, rs.tracking_id, rs.order_id, rs.marketplace, rs.created_at,
                va.storage_path
         FROM recording_sessions rs
         LEFT JOIN video_assets va ON va.recording_session_id = rs.id
         ${where}
         ORDER BY rs.created_at DESC
         LIMIT $${params.length}`,
        params
      );

      let rows = res.rows.map((row: any) => ({ ...row, ...mappingStatusForRecording(row) }));
      if (stage === 'renamed') rows = rows.filter((r: any) => r.renamed && !r.moved);
      else if (stage === 'unrenamed') rows = rows.filter((r: any) => !r.renamed);

      return { recordings: rows };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to load unmapped recordings' });
    }
  });

  // Manually assign order + marketplace, then move the file into the
  // marketplace/order folder to match.
  protectedRoutes.put('/api/admin/recordings/:id/mapping', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const { id } = req.params as any;
    const body = req.body as any;

    if (!UUID_PATTERN.test(id)) {
      return reply.status(400).send({ error: 'Invalid recording id' });
    }

    const orderId = normalizeIdentifier(body?.orderId);
    const marketplace = normalizeMarketplace(body?.marketplace);
    if (!orderId || !marketplace || orderId.length > 100 || marketplace.length > 100) {
      return reply.status(400).send({ error: 'Valid orderId and marketplace are required (max 100 characters each)' });
    }

    try {
      const existing = await pool.query(
        `SELECT rs.id, va.storage_path
         FROM recording_sessions rs
         LEFT JOIN video_assets va ON va.recording_session_id = rs.id
         WHERE rs.id = $1 AND rs.organization_id = $2`,
        [id, user.organization_id]
      );
      if (existing.rows.length === 0) {
        return reply.status(404).send({ error: 'Recording not found' });
      }

      await pool.query(
        `UPDATE recording_sessions
         SET order_id = $1, marketplace = $2, order_mapping_imported_at = NOW(), updated_at = NOW()
         WHERE id = $3 AND organization_id = $4`,
        [orderId, marketplace, id, user.organization_id]
      );

      // Move the file into its marketplace/order folder (non-fatal: the DB
      // rename always wins; a failed move just leaves the old path).
      let moved = false;
      let moveError: string | null = null;
      const newPath = buildMovedStoragePath(existing.rows[0]?.storage_path || null, orderId);
      if (newPath && firebaseStorageBucket) {
        try {
          const bucket = getStorage().bucket(firebaseStorageBucket);
          await bucket.file(existing.rows[0].storage_path).move(newPath);
          await pool.query(
            `UPDATE video_assets SET storage_path = $1 WHERE recording_session_id = $2 AND organization_id = $3`,
            [newPath, id, user.organization_id]
          );
          moved = true;
        } catch (moveErr) {
          moveError = moveErr instanceof Error ? moveErr.message : String(moveErr);
          console.warn('Recording file move failed:', moveError);
        }
      }

      await applyRetentionPoliciesForOrganization(pool, user.organization_id, id);

      await pool.query(
        `INSERT INTO audit_logs (organization_id, user_id, action, resource, created_at)
         VALUES ($1, $2, 'UPDATE', 'RECORDING_MAPPING', NOW())`,
        [user.organization_id, user.user_id]
      );

      return { success: true, moved, moveError };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to update recording mapping' });
    }
  });

  protectedRoutes.get('/api/admin/retention-policies', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });

    try {
      const res = await pool.query(
        `WITH marketplaces AS (
           SELECT COALESCE(NULLIF(marketplace, ''), 'Unassigned') as marketplace
           FROM recording_sessions
           WHERE organization_id = $1
           UNION
           SELECT marketplace
           FROM marketplace_order_mappings
           WHERE organization_id = $1
           UNION
           SELECT marketplace
           FROM marketplace_retention_policies
           WHERE organization_id = $1
         )
         SELECT m.marketplace,
                mrp.video_retention_days,
                mrp.data_retention_days,
                mrp.updated_at,
                COUNT(DISTINCT rs.id) as recordings,
                COUNT(DISTINCT va.id) as videos
         FROM marketplaces m
         LEFT JOIN marketplace_retention_policies mrp
           ON mrp.organization_id = $1
          AND LOWER(mrp.marketplace) = LOWER(m.marketplace)
         LEFT JOIN recording_sessions rs
           ON rs.organization_id = $1
          AND LOWER(COALESCE(NULLIF(rs.marketplace, ''), 'Unassigned')) = LOWER(m.marketplace)
         LEFT JOIN video_assets va
           ON va.recording_session_id = rs.id
         WHERE m.marketplace IS NOT NULL AND m.marketplace <> ''
         GROUP BY m.marketplace, mrp.video_retention_days, mrp.data_retention_days, mrp.updated_at
         ORDER BY m.marketplace`,
        [user.organization_id]
      );

      return { policies: res.rows };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to load retention policies' });
    }
  });

  protectedRoutes.put('/api/admin/retention-policies', async (req, reply) => {
    const user = (req as any).user;
    if (!isAdmin(user)) return reply.status(403).send({ error: 'Admin access required' });
    const body = req.body as any;
    const marketplace = normalizeMarketplace(body?.marketplace);
    const videoRetentionDays = body?.videoRetentionDays === null || body?.videoRetentionDays === ''
      ? null
      : Number(body?.videoRetentionDays);
    const dataRetentionDays = body?.dataRetentionDays === null || body?.dataRetentionDays === ''
      ? null
      : Number(body?.dataRetentionDays);

    if (!marketplace) {
      return reply.status(400).send({ error: 'Marketplace is required' });
    }

    const validDayValue = (value: number | null) => value === null || (Number.isInteger(value) && value >= 1 && value <= 3650);
    if (!validDayValue(videoRetentionDays) || !validDayValue(dataRetentionDays)) {
      return reply.status(400).send({ error: 'Retention days must be blank or an integer from 1 to 3650' });
    }

    try {
      await pool.query(
        `INSERT INTO marketplace_retention_policies (
           organization_id, marketplace, video_retention_days, data_retention_days, updated_by, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (organization_id, marketplace) DO UPDATE SET
           video_retention_days = EXCLUDED.video_retention_days,
           data_retention_days = EXCLUDED.data_retention_days,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
        [user.organization_id, marketplace, videoRetentionDays, dataRetentionDays, user.user_id]
      );

      await applyRetentionPoliciesForOrganization(pool, user.organization_id);

      await pool.query(
        `INSERT INTO audit_logs (organization_id, user_id, action, resource, created_at)
         VALUES ($1, $2, 'UPDATE', 'RETENTION_POLICY', NOW())`,
        [user.organization_id, user.user_id]
      );

      return { success: true };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to update retention policy' });
    }
  });

  protectedRoutes.get<{ Querystring: { search?: string, station?: string, reviewStatus?: string, marketplace?: string, page?: string, limit?: string } }>('/api/videos', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const { search, station, reviewStatus, marketplace, page, limit } = req.query;
    try {
      let baseWhere = `WHERE va.organization_id = $1`;
      const params: any[] = [user.organization_id];
      
      if (search) {
        params.push(`%${search}%`);
        baseWhere += ` AND (rs.tracking_id ILIKE $${params.length} OR rs.order_id ILIKE $${params.length} OR rs.marketplace ILIKE $${params.length} OR u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`;
      }
      
      if (reviewStatus && reviewStatus !== 'All Statuses') {
        const normalizedStatus = reviewStatus.toLowerCase();
        if (normalizedStatus === 'disputed' || normalizedStatus === 'resolved') {
            params.push(normalizedStatus);
            baseWhere += ` AND (va.review_status = $${params.length})`;
        } else if (normalizedStatus === 'uploaded') {
            baseWhere += ` AND (va.upload_status = 'uploaded' OR va.upload_status = 'completed')`;
        } else if (normalizedStatus === 'uploading' || normalizedStatus === 'failed') {
            params.push(normalizedStatus);
            baseWhere += ` AND (va.upload_status = $${params.length})`;
        }
      }
      
      if (station && station !== 'All Stations') {
          params.push(station);
          baseWhere += UUID_PATTERN.test(station)
            ? ` AND (rs.station_id = $${params.length})`
            : ` AND (s.code = $${params.length})`;
      }

      if (marketplace && marketplace !== 'All Marketplaces') {
        if (marketplace === 'Unassigned') {
          baseWhere += ` AND (rs.marketplace IS NULL OR rs.marketplace = '')`;
        } else {
          params.push(marketplace);
          baseWhere += ` AND LOWER(rs.marketplace) = LOWER($${params.length})`;
        }
      }
      
      const countQuery = `
        SELECT COUNT(*) as total
        FROM video_assets va
        JOIN recording_sessions rs ON va.recording_session_id = rs.id AND rs.organization_id = va.organization_id
        LEFT JOIN users u ON rs.operator_user_id = u.id
        LEFT JOIN stations s ON rs.station_id = s.id AND s.organization_id = va.organization_id
        ${baseWhere}
      `;
      const countRes = await pool.query(countQuery, params);
      const total = parseInt(countRes.rows[0].total);
      const marketplaceRes = await pool.query(
        `SELECT COALESCE(NULLIF(marketplace, ''), 'Unassigned') as marketplace, COUNT(*) as count
         FROM recording_sessions
         WHERE organization_id = $1
         GROUP BY COALESCE(NULLIF(marketplace, ''), 'Unassigned')
         ORDER BY marketplace`,
        [user.organization_id]
      );

      let query = `
        SELECT
          va.*,
          rs.tracking_id,
          rs.order_id,
          rs.marketplace,
          rs.flyer_id,
          rs.data_retention_until,
          rs.created_at as timestamp,
          u.name as packer_name,
          u.email as packer_email,
          s.code as station_code,
          s.name as station_name
        FROM video_assets va
        JOIN recording_sessions rs ON va.recording_session_id = rs.id AND rs.organization_id = va.organization_id
        LEFT JOIN users u ON rs.operator_user_id = u.id
        LEFT JOIN stations s ON rs.station_id = s.id AND s.organization_id = va.organization_id
        ${baseWhere}
        ORDER BY rs.created_at DESC
      `;
      
      const requestedLimit = limit ? parseInt(limit, 10) : 50;
      const requestedPage = page ? parseInt(page, 10) : 1;
      const parsedLimit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
      const parsedPage = Number.isFinite(requestedPage) ? Math.max(requestedPage, 1) : 1;
      const offset = (parsedPage - 1) * parsedLimit;
      
      params.push(parsedLimit);
      query += ` LIMIT $${params.length}`;
      params.push(offset);
      query += ` OFFSET $${params.length}`;
      
      const res = await pool.query(query, params);
      
      return {
        total,
        marketplaces: marketplaceRes.rows,
        videos: res.rows.map(formatVideoRow),
      };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Database error' });
    }
  });

  // OMSGuru connection settings (admin only — token rotates monthly).
  protectedRoutes.get('/api/admin/omsguru-settings', async (req, reply) => {
    const user = (req as any).user;
    if (!isAdmin(user)) return reply.status(403).send({ error: 'Admin access required' });
    try {
      const res = await pool.query(
        `SELECT token, cid, warehouse_id, updated_at FROM omsguru_settings WHERE organization_id = $1`,
        [user.organization_id]
      );
      const row = res.rows[0] || { token: '', cid: '', warehouse_id: '', updated_at: null };
      const envConfigured = Boolean((process.env.OMSGURU_TOKEN || '').trim() && (process.env.OMSGURU_CID || '').trim());
      return {
        configured: Boolean(row.token?.trim() || envConfigured),
        source: row.token?.trim() ? 'settings' : envConfigured ? 'environment' : 'none',
        tokenMasked: maskToken(row.token || ''),
        cid: row.cid || '',
        warehouseId: row.warehouse_id || '',
        updatedAt: row.updated_at || null,
      };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to load OMSGuru settings' });
    }
  });

  protectedRoutes.put('/api/admin/omsguru-settings', async (req, reply) => {
    const user = (req as any).user;
    if (!isAdmin(user)) return reply.status(403).send({ error: 'Admin access required' });
    const body = req.body as any;
    try {
      const current = await pool.query(
        `SELECT token FROM omsguru_settings WHERE organization_id = $1`,
        [user.organization_id]
      );
      // Empty token keeps the stored one (lets admins rotate CID/warehouse
      // without retyping the secret).
      const token = typeof body?.token === 'string' && body.token.trim()
        ? body.token.trim()
        : current.rows[0]?.token || '';
      const cid = typeof body?.cid === 'string' ? body.cid.trim() : current.rows[0]?.cid || '';
      const warehouseId = typeof body?.warehouseId === 'string' ? body.warehouseId.trim() : current.rows[0]?.warehouse_id || '';

      await pool.query(
        `INSERT INTO omsguru_settings (organization_id, token, cid, warehouse_id, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (organization_id) DO UPDATE SET
           token = EXCLUDED.token, cid = EXCLUDED.cid,
           warehouse_id = EXCLUDED.warehouse_id,
           updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [user.organization_id, token, cid, warehouseId, user.user_id]
      );

      return { success: true, configured: Boolean(token) };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to save OMSGuru settings' });
    }
  });

  // Live OMSGuru connectivity probe (1 cheap call): answers "is the API
  // live or not" without running a full sync.
  // Ajio WFR request ledger: every CCTV mail + its processing status for the
  // packing desk (VMS status page). Admin-only; packers never see disputes.
  protectedRoutes.get('/api/admin/ajio-wfr', async (req, reply) => {
    const user = (req as any).user;
    if (!isAdmin(user)) return reply.status(403).send({ error: 'Admin access required' });
    try {
      const { status } = (req.query || {}) as { status?: string };
      const allowed = ['pending', 'processing', 'done', 'missing', 'failed'];
      const params: any[] = [user.organization_id];
      let where = `WHERE organization_id = $1`;
      if (status && allowed.includes(status)) {
        params.push(status);
        where += ` AND status = $${params.length}`;
      }
      const [rowsRes, countRes] = await Promise.all([
        pool.query(
          `SELECT id, incident_id, order_id, shipment_id, reference_value, packing_time,
                  recording_session_id, drive_file_id, drive_link, status, error,
                  mail_message_id, requested_at, replied_at,
                  reply_message_id, reply_to, reply_subject
           FROM ajio_wfr_requests ${where}
           ORDER BY requested_at DESC
           LIMIT 100`,
          params
        ),
        pool.query(
          `SELECT status, COUNT(*) as count FROM ajio_wfr_requests WHERE organization_id = $1 GROUP BY status`,
          [user.organization_id]
        ),
      ]);
      const summary: Record<string, number> = {};
      for (const row of countRes.rows) summary[String(row.status)] = Number(row.count);
      return { summary, requests: rowsRes.rows };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to load Ajio requests' });
    }
  });

  // Run the Ajio WFR job right now for this org (admin button / demo).
  // { dryRun: true } parses + matches without uploading or replying.
  // Recorded and alerting like every other trigger (dry runs record silently).
  protectedRoutes.post('/api/admin/ajio-wfr/run', async (req, reply) => {
    const user = (req as any).user;
    if (!isAdmin(user)) return reply.status(403).send({ error: 'Admin access required' });
    try {
      const body = (req.body || {}) as { dryRun?: boolean; limit?: number };
      const orgRes = await pool.query(`SELECT name FROM organizations WHERE id = $1`, [user.organization_id]).catch(() => ({ rows: [] }));
      const outcome = await withAjioWfrLock(pool, () =>
        runRecordedAjioWfrJob(pool, {
          organizationId: user.organization_id,
          organizationName: (orgRes.rows[0] as { name?: string } | undefined)?.name || null,
          dryRun: body.dryRun === true,
          limit: body.limit,
          trigger: 'admin',
          alert: wfrAlertSender(),
        })
      );
      if (!outcome.ran) return reply.status(409).send({ error: AJIO_WFR_BUSY_MESSAGE, running: true });
      const recorded = outcome.value;
      return {
        ...recorded.summary,
        usedFallback: recorded.usedFallback,
        slaBreached: recorded.slaBreached,
        alertSent: recorded.alertSent,
      };
    } catch (err) {
      console.error(err);
      const failure = wfrPublicError(err, 'Ajio run failed');
      return reply.status(failure.status).send({ error: failure.message });
    }
  });

  // Ajio WFR health for the admin banner + dead-man's-switch: last run, last
  // live success, open-request age vs SLA. Cheap queries, no Gmail calls.
  protectedRoutes.get('/api/admin/ajio-wfr/health', async (req, reply) => {
    const user = (req as any).user;
    if (!isAdmin(user)) return reply.status(403).send({ error: 'Admin access required' });
    try {
      return await getWfrHealth(pool, user.organization_id);
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to load WFR health' });
    }
  });

  // Gmail OAuth connect URL for this org (admin mints it, browser follows it;
  // the callback binds the grant back via one-shot state).
  protectedRoutes.get('/api/admin/ajio-gmail/auth-url', async (req, reply) => {
    const user = (req as any).user;
    if (!isAdmin(user)) return reply.status(403).send({ error: 'Admin access required' });
    const oauth = gmailOAuthConfigured();
    if (!oauth) return { configured: false, url: null };
    const state = createConnectState(user.organization_id);
    return { configured: true, url: buildGmailAuthUrl(createGmailOAuthClient(oauth), state) };
  });

  // Gmail connection status for this org (no secrets leave the server).
  // needsReconnect goes true when the stored grant predates the modify scope
  // (mark-as-read 403s) — the user just clicks Connect again to re-consent.
  protectedRoutes.get('/api/admin/ajio-gmail/status', async (req, reply) => {
    const user = (req as any).user;
    if (!isAdmin(user)) return reply.status(403).send({ error: 'Admin access required' });
    try {
      const tokens = await getGmailTokens(pool, user.organization_id);
      if (!tokens?.refreshToken) return { connected: false, email: null, needsReconnect: false };
      return {
        connected: true,
        email: tokens.email || null,
        needsReconnect: !gmailScopesSufficient(tokens.scopes),
      };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to load Gmail status' });
    }
  });

  // Disconnect the org's Gmail (deletes stored tokens; Google-side access can
  // also be revoked at myaccount.google.com/permissions any time).
  protectedRoutes.post('/api/admin/ajio-gmail/disconnect', async (req, reply) => {
    const user = (req as any).user;
    if (!isAdmin(user)) return reply.status(403).send({ error: 'Admin access required' });
    try {
      await deleteGmailTokens(pool, user.organization_id);
      return { ok: true };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to disconnect Gmail' });
    }
  });

  protectedRoutes.post('/api/admin/omsguru-test', async (req, reply) => {
    const user = (req as any).user;
    if (!isAdmin(user)) return reply.status(403).send({ error: 'Admin access required' });
    try {
      const settingsRes = await pool.query(
        `SELECT token, cid, warehouse_id FROM omsguru_settings WHERE organization_id = $1`,
        [user.organization_id]
      );
      const creds = resolveSyncCreds(settingsRes.rows[0] || null, {
        token: process.env.OMSGURU_TOKEN,
        cid: process.env.OMSGURU_CID,
        warehouseId: process.env.OMSGURU_WAREHOUSE_ID,
      });
      const client = createOMSGuruClient(creds);
      const channels = await client.listActiveChannels();
      const warehouses = await client.listWarehouses().catch(() => []);
      return { ok: true, channels: channels.length, warehouses: warehouses.length };
    } catch (err) {
      console.error(err);
      const message = sanitizeErrorMessage(err, 'OMSGuru test failed');
      const status = message.includes('not configured') ? 503 : 502;
      return reply.status(status).send({ ok: false, error: message });
    }
  });

  // Nightly OMSGuru SKU photo sync: status card (Synced Orders page).
  protectedRoutes.get('/api/admin/sku-images/sync-status', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const org = user.organization_id;
    try {
      const [channelRes, listingRes, runRes, imageRes, coverageRes, targets] = await Promise.all([
        pool.query(
          `SELECT s.channel_id, s.channel_name, s.pass_started_at, s.pass_completed_at, s.caught_up_at,
                  s.pages_read, s.updated_at,
                  (SELECT COUNT(*)::int FROM omsguru_listings l
                   WHERE l.organization_id = s.organization_id AND l.channel_id = s.channel_id) AS listings
           FROM omsguru_listing_sync_state s
           WHERE s.organization_id = $1
           ORDER BY s.channel_name`,
          [org]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS listings, COUNT(*) FILTER (WHERE image_url IS NOT NULL)::int AS with_image
           FROM omsguru_listings WHERE organization_id = $1`,
          [org]
        ),
        pool.query(
          `SELECT trigger, status, stopped_by, started_at, finished_at, calls, listings_seen, listings_stored,
                  images_written, channels_completed, channels_total, error
           FROM sku_image_sync_runs WHERE organization_id = $1
           ORDER BY started_at DESC LIMIT 7`,
          [org]
        ),
        pool.query(`SELECT source, COUNT(*)::int AS count FROM sku_images WHERE organization_id = $1 GROUP BY source`, [org]),
        // How many SKUs in the copied orders (last few days) have a photo.
        pool.query(
          `WITH skus AS (
             SELECT DISTINCT regexp_replace(UPPER(BTRIM(item->>'sku')), '\\s+', ' ', 'g') AS key
             FROM marketplace_orders mo,
                  jsonb_array_elements(CASE WHEN jsonb_typeof(mo.items) = 'array' THEN mo.items ELSE '[]'::jsonb END) item
             WHERE mo.organization_id = $1
           )
           SELECT COUNT(*)::int AS skus,
                  COUNT(*) FILTER (WHERE EXISTS (
                    SELECT 1 FROM sku_images si WHERE si.organization_id = $1 AND si.sku_key = skus.key))::int AS exact,
                  COUNT(*) FILTER (WHERE EXISTS (
                    SELECT 1 FROM sku_images si WHERE si.organization_id = $1
                      AND (si.sku_key = skus.key
                        OR regexp_replace(si.sku_key, '_[^_]*$', '') = regexp_replace(skus.key, '_[^_]*$', ''))))::int AS with_style
           FROM skus WHERE key <> '' AND key <> 'UNKNOWN'`,
          [org]
        ),
        forwardScanTargetOrganizations(),
      ]);
      let configured = true;
      try {
        await omsguruCredsFor(org);
      } catch {
        configured = false;
      }
      const skuImages: Record<string, number> = {};
      for (const row of imageRes.rows) skuImages[String(row.source)] = Number(row.count);
      const channels = channelRes.rows.map((row: any) => ({
        channelId: Number(row.channel_id),
        channelName: row.channel_name,
        listings: Number(row.listings || 0),
        pagesRead: Number(row.pages_read || 0),
        passStartedAt: row.pass_started_at,
        passCompletedAt: row.pass_completed_at,
        caughtUpAt: row.caught_up_at,
        updatedAt: row.updated_at,
      }));
      const running = skuImageSyncCurrent && !skuImageSyncCurrent.done
        ? { trigger: skuImageSyncCurrent.trigger, startedAt: skuImageSyncCurrent.startedAt, deadlineAt: skuImageSyncCurrent.deadlineAt }
        : null;
      const coverage = coverageRes.rows[0] || {};
      return {
        enabled: skuImageSyncConfig.enabled,
        configured,
        receivesSync: targets.ids.includes(org),
        hourIst: skuImageSyncConfig.hourIst,
        maxMinutes: skuImageSyncConfig.maxMinutes,
        reserve: skuImageSyncConfig.reserve,
        fullRefreshDays: skuImageSyncConfig.fullRefreshDays,
        nextRunAt: skuImageSyncConfig.enabled
          ? new Date(nextNightlyRunAt(Date.now(), skuImageSyncConfig.hourIst)).toISOString()
          : null,
        running,
        firstPassComplete: channels.length > 0 && channels.every((c) => Boolean(c.passCompletedAt)),
        channels,
        listings: Number(listingRes.rows[0]?.listings || 0),
        listingsWithImage: Number(listingRes.rows[0]?.with_image || 0),
        skuImages,
        orderSkus: {
          total: Number(coverage.skus || 0),
          exact: Number(coverage.exact || 0),
          withStyle: Number(coverage.with_style || 0),
        },
        runs: runRes.rows.map((row: any) => ({
          trigger: row.trigger,
          status: row.status,
          stoppedBy: row.stopped_by,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          calls: Number(row.calls || 0),
          listingsSeen: Number(row.listings_seen || 0),
          listingsStored: Number(row.listings_stored || 0),
          imagesWritten: Number(row.images_written || 0),
          channelsCompleted: Number(row.channels_completed || 0),
          channelsTotal: Number(row.channels_total || 0),
          error: row.error ? sanitizeErrorMessage(new Error(row.error), 'Sync error') : null,
        })),
      };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to load SKU photo sync status' });
    }
  });

  // Run the sweep now (admin only). Shares the nightly lock and budget rules,
  // so a daytime run still leaves Forward Scan its reserve.
  protectedRoutes.post('/api/admin/sku-images/sync', { config: { rateLimit: JOB_RATE_LIMIT } }, async (req, reply) => {
    const user = (req as any).user;
    if (!isAdmin(user)) return reply.status(403).send({ error: 'Admin access required' });
    const targets = await forwardScanTargetOrganizations();
    if (!targets.ids.includes(user.organization_id)) {
      return reply.status(409).send({ error: 'This organization does not receive the order copy (see FORWARD_SCAN_ORG_IDS)' });
    }
    try {
      await omsguruCredsFor(user.organization_id);
    } catch {
      return reply.status(503).send({ error: 'OMSGuru is not configured (token / client ID)' });
    }
    const minutes = clampInt((req.body as any)?.minutes, Math.min(15, skuImageSyncConfig.maxMinutes), 1, skuImageSyncConfig.maxMinutes);
    if (!startSkuImageSync('admin', minutes)) {
      return reply.status(409).send({ error: 'A SKU photo sync is already running' });
    }
    return reply.status(202).send({ started: true, minutes, deadlineAt: skuImageSyncCurrent?.deadlineAt });
  });

  // Forward Scan order copy: status card (Settings + Synced Orders page).
  protectedRoutes.get('/api/admin/forward-scan/status', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    try {
      const [stateRes, marketplaceRes, imageRes] = await Promise.all([
        pool.query(`SELECT * FROM forward_scan_sync_state WHERE organization_id = $1`, [user.organization_id]),
        pool.query(
          `SELECT COALESCE(NULLIF(marketplace, ''), 'Unassigned') AS marketplace,
                  BOOL_OR(is_meesho) AS is_meesho,
                  COUNT(*)::int AS orders,
                  COUNT(*) FILTER (WHERE source = 'manual' OR manual_override)::int AS manual,
                  MAX(awb_generated_at) AS latest_awb_at
           FROM marketplace_orders
           WHERE organization_id = $1
           GROUP BY 1
           ORDER BY orders DESC`,
          [user.organization_id]
        ),
        pool.query(
          `SELECT source, COUNT(*)::int AS count FROM sku_images WHERE organization_id = $1 GROUP BY source`,
          [user.organization_id]
        ),
      ]);
      const state = stateRes.rows[0] || null;
      const targets = forwardScanConfig ? await forwardScanTargetOrganizations() : null;
      const receivesCopy = Boolean(targets?.ids.includes(user.organization_id));
      const skuImages: Record<string, number> = {};
      for (const row of imageRes.rows) skuImages[String(row.source)] = Number(row.count);
      const marketplaces = marketplaceRes.rows.map((row: any) => ({
        marketplace: row.marketplace,
        isMeesho: Boolean(row.is_meesho),
        orders: Number(row.orders),
        manual: Number(row.manual),
        latestAwbAt: row.latest_awb_at,
      }));
      return {
        configured: Boolean(forwardScanConfig),
        source: describeForwardScanSource(forwardScanConfig),
        receivesCopy,
        // Generic reason only — never another tenant's details.
        notReceivingReason: !forwardScanConfig
          ? 'FORWARD_SCAN_DATABASE_URL is not set'
          : receivesCopy ? null : targets?.reason || 'this organization is not in FORWARD_SCAN_ORG_IDS',
        retentionDays: forwardScanRetentionDays,
        intervalSeconds: forwardScanIntervalSeconds,
        excludedMarketplaces: forwardScanExcludedMarketplaces,
        lastRunAt: state?.last_run_at || null,
        lastSuccessAt: state?.last_success_at || null,
        lastError: state?.last_error || null,
        lastOrdersSeen: Number(state?.last_orders_seen || 0),
        lastOrdersWritten: Number(state?.last_orders_written || 0),
        lastPhotosWritten: Number(state?.last_photos_written || 0),
        lastPurged: Number(state?.last_purged || 0),
        lastDurationMs: state?.last_duration_ms ?? null,
        totalOrders: marketplaces.reduce((sum, m) => sum + m.orders, 0),
        marketplaces,
        skuImages,
      };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to load Forward Scan status' });
    }
  });

  // Copy from Forward Scan right now (no OMSGuru calls). Admin-only like
  // the old OMSGuru sync button; the copy also runs by itself every 2 min.
  protectedRoutes.post('/api/admin/forward-scan/sync', { config: { rateLimit: JOB_RATE_LIMIT } }, async (req, reply) => {
    const user = (req as any).user;
    if (!isAdmin(user)) return reply.status(403).send({ error: 'Admin access required' });
    if (!forwardScanConfig) {
      return reply.status(503).send({ error: 'Forward Scan database is not configured (FORWARD_SCAN_DATABASE_URL)' });
    }
    if (!await receivesForwardScanCopy(user.organization_id)) {
      return reply.status(409).send({ error: 'This organization does not receive the Forward Scan copy (see FORWARD_SCAN_ORG_IDS)' });
    }
    try {
      const run = await syncFromForwardScan();
      // Only this org's numbers leave the server.
      const mine = run.results.find((r) => r.organizationId === user.organization_id) || null;
      const error = mine ? mine.error : 'Forward Scan order copy did not run for this organization';
      const body = {
        ok: !error,
        ordersRead: run.ordersRead,
        cutoff: run.cutoff,
        durationMs: run.durationMs,
        ordersWritten: mine?.ordersWritten || 0,
        photosWritten: mine?.photosWritten || 0,
        purged: mine?.purged || 0,
        skippedManual: mine?.skippedManual || 0,
        ...(error ? { error } : {}),
      };
      return error ? reply.status(502).send(body) : body;
    } catch (err) {
      console.error(err);
      return reply.status(502).send({ error: sanitizeErrorMessage(err, 'Forward Scan order copy failed') });
    }
  });

  // Marketplace-wise synced orders (last 3 days) for review / manual fixes.
  protectedRoutes.get<{ Querystring: { search?: string; marketplace?: string; meesho?: string; source?: string; limit?: string; offset?: string } }>('/api/synced-orders', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const { search, marketplace, meesho, source } = req.query;
    const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit) || 50)));
    const offset = Math.min(100_000, Math.max(0, Math.floor(Number(req.query.offset) || 0)));
    const params: any[] = [user.organization_id];
    let where = 'WHERE organization_id = $1';

    if (marketplace && marketplace !== 'all') {
      params.push(marketplace);
      where += ` AND COALESCE(NULLIF(marketplace, ''), 'Unassigned') = $${params.length}`;
    }
    if (meesho === '1') where += ' AND is_meesho';
    if (meesho === '0') where += ' AND NOT is_meesho';
    if (source === 'manual') where += ` AND (source = 'manual' OR manual_override)`;
    if (search && search.trim()) {
      params.push(`%${search.trim()}%`);
      const p = `$${params.length}`;
      where += ` AND (tracking_id ILIKE ${p} OR order_id ILIKE ${p} OR channel_order_id ILIKE ${p} OR invoice_id ILIKE ${p} OR items::text ILIKE ${p})`;
    }

    try {
      const [rowsRes, countRes] = await Promise.all([
        pool.query(
          `SELECT tracking_id, tracking_raw, marketplace, channel_marketplace, channel_name, is_meesho,
                  order_id, channel_order_id, sub_order_ids, invoice_id, items, item_count, total_qty,
                  status, status_group, shipping_company, order_type, awb_generated_at,
                  source, manual_override, synced_at, updated_at
           FROM marketplace_orders
           ${where}
           ORDER BY COALESCE(awb_generated_at, created_at) DESC, tracking_id
           LIMIT ${limit} OFFSET ${offset}`,
          params
        ),
        pool.query(`SELECT COUNT(*)::int AS count FROM marketplace_orders ${where}`, params),
      ]);
      // One photo query for the whole page.
      const keys = [...new Set(rowsRes.rows.flatMap((row: any) =>
        (Array.isArray(row.items) ? row.items : []).map((item: any) => normalizeSkuKey(item?.sku)).filter(Boolean)
      ))];
      const imageRes = keys.length > 0
        ? await pool.query(
          `SELECT sku_key, title, image_url, source FROM sku_images WHERE organization_id = $1 AND sku_key = ANY($2::text[])`,
          [user.organization_id, keys]
        )
        : { rows: [] as any[] };
      return {
        total: Number(countRes.rows[0]?.count || 0),
        limit,
        offset,
        orders: rowsRes.rows.map((row: any) => ({
          ...row,
          isManual: row.source === 'manual' || Boolean(row.manual_override),
          items: mergeItemImages(row.items, imageRes.rows),
        })),
      };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to load synced orders' });
    }
  });

  // Hand-entered order or correction (marketplace / order id / SKU lines /
  // photo links). Marked manual so the Forward Scan copy never overwrites it.
  protectedRoutes.put('/api/synced-orders', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const body = (req.body || {}) as any;
    const trackingRaw = normalizeIdentifier(body.trackingId);
    if (trackingRaw && !isLookupTracking(trackingRaw)) return reply.status(400).send({ error: 'trackingId is too long' });
    const trackingId = normalizeForwardScanTracking(trackingRaw);
    if (!trackingRaw || !trackingId) return reply.status(400).send({ error: 'trackingId is required' });
    const marketplace = marketplaceFromChannelLabel(typeof body.marketplace === 'string' ? body.marketplace.slice(0, 255) : null);
    const orderId = normalizeIdentifier(typeof body.orderId === 'string' ? body.orderId.slice(0, 255) : body.orderId);
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length > 50) return reply.status(400).send({ error: 'At most 50 SKU lines per order' });

    const items: MarketplaceOrderItem[] = [];
    for (const raw of rawItems) {
      const sku = typeof raw?.sku === 'string' ? raw.sku.trim().slice(0, 255) : '';
      if (!sku) continue;
      const imageInput = typeof raw?.imageUrl === 'string' ? raw.imageUrl.trim() : '';
      const imageUrl = imageInput ? normalizeManualImageUrl(imageInput) : null;
      if (imageInput && !imageUrl) {
        return reply.status(400).send({ error: `Image link for ${sku} must be a valid http(s) URL` });
      }
      const quantity = Number(raw?.quantity);
      items.push({
        sku,
        title: typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 300) : null,
        quantity: Number.isFinite(quantity) && quantity > 0 ? Math.min(999, Math.floor(quantity)) : 1,
        imageUrl,
        channelOrderId: typeof raw?.channelOrderId === 'string' && raw.channelOrderId.trim() ? raw.channelOrderId.trim().slice(0, 255) : null,
        subOrderId: typeof raw?.subOrderId === 'string' && raw.subOrderId.trim() ? raw.subOrderId.trim().slice(0, 255) : null,
        status: null,
      });
    }
    if (!marketplace && !orderId && items.length === 0) {
      return reply.status(400).send({ error: 'Enter a marketplace, an order id or at least one SKU' });
    }
    // A named marketplace decides Meesho; the checkbox only covers rows
    // entered without one (a corrected "Flipkart" must not stay Meesho).
    const isMeesho = marketplace ? isMeeshoText(marketplace) : body.isMeesho === true;
    const identity = orderId || orderIdentity({ is_meesho: isMeesho, items, sub_order_ids: null, channel_order_id: null, invoice_id: null });
    const totalQty = items.reduce((sum, item) => sum + item.quantity, 0);

    try {
      const res = await pool.query(
        `INSERT INTO marketplace_orders (
            organization_id, tracking_id, tracking_raw, marketplace, channel_name, is_meesho,
            order_id, channel_order_id, items, item_count, total_qty, source, manual_override,
            updated_by, awb_generated_at, synced_at, updated_at
          )
         VALUES ($1, $2, $3, $4, $4, $5, $6, $6, $7::jsonb, $8, $9, 'manual', TRUE, $10, NOW(), NOW(), NOW())
         ON CONFLICT (organization_id, tracking_id) DO UPDATE SET
           marketplace = EXCLUDED.marketplace,
           is_meesho = EXCLUDED.is_meesho,
           order_id = EXCLUDED.order_id,
           items = EXCLUDED.items,
           item_count = EXCLUDED.item_count,
           total_qty = EXCLUDED.total_qty,
           manual_override = TRUE,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()
         RETURNING tracking_id, source, manual_override`,
        [user.organization_id, trackingId, trackingRaw, marketplace, isMeesho, identity, JSON.stringify(items), items.length, totalQty, user.user_id || null]
      );

      // Photo links typed here also become the SKU's manual photo, so the
      // next order of the same SKU shows it too.
      let imagesSaved = 0;
      // Only links the editor typed or changed (saveSkuImage) — never the
      // catalogue photo the form was merely displaying.
      const rememberSkus = new Set(
        rawItems
          .filter((raw: any) => raw?.saveSkuImage === true && typeof raw?.sku === 'string')
          .map((raw: any) => normalizeSkuKey(raw.sku.trim().slice(0, 255)))
      );
      for (const item of items) {
        if (!item.imageUrl || !rememberSkus.has(normalizeSkuKey(item.sku))) continue;
        await pool.query(
          `INSERT INTO sku_images (organization_id, sku, sku_key, title, image_url, marketplace, source, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7, NOW())
           ON CONFLICT (organization_id, sku_key, source) DO UPDATE SET
             sku = EXCLUDED.sku, title = COALESCE(EXCLUDED.title, sku_images.title),
             image_url = EXCLUDED.image_url, marketplace = COALESCE(EXCLUDED.marketplace, sku_images.marketplace),
             updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
          [user.organization_id, item.sku, normalizeSkuKey(item.sku), item.title, item.imageUrl, marketplace, user.user_id || null]
        );
        imagesSaved += 1;
      }

      await pool.query(
        `INSERT INTO audit_logs (id, organization_id, user_id, action, resource, metadata, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'SYNCED_ORDER_EDIT', $3, $4::jsonb, NOW())`,
        [user.organization_id, user.user_id || null, trackingId, JSON.stringify({ marketplace, orderId: identity, skus: items.map((i) => i.sku), imagesSaved })]
      );
      return { success: true, trackingId, source: res.rows[0]?.source, imagesSaved };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to save order' });
    }
  });

  // Undo a manual entry: hand-made rows are deleted, corrected Forward Scan
  // rows go back to the copied data (re-read from Forward Scan right away).
  protectedRoutes.post('/api/synced-orders/revert', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const rawTracking = normalizeIdentifier((req.body as any)?.trackingId);
    if (rawTracking && !isLookupTracking(rawTracking)) return reply.status(400).send({ error: 'trackingId is too long' });
    const trackingId = normalizeForwardScanTracking(rawTracking);
    if (!trackingId) return reply.status(400).send({ error: 'trackingId is required' });
    try {
      const deleted = await pool.query(
        `DELETE FROM marketplace_orders WHERE organization_id = $1 AND tracking_id = $2 AND source = 'manual' RETURNING tracking_id`,
        [user.organization_id, trackingId]
      );
      const reverted = deleted.rowCount
        ? { rowCount: 0 }
        : await pool.query(
          `UPDATE marketplace_orders
             SET manual_override = FALSE, source_hash = NULL, updated_by = $3, updated_at = NOW()
           WHERE organization_id = $1 AND tracking_id = $2 AND source = 'forward-scan'`,
          [user.organization_id, trackingId, user.user_id || null]
        );
      if (!deleted.rowCount && !reverted.rowCount) return reply.status(404).send({ error: 'Order not found' });

      let refreshed = false;
      if (await receivesForwardScanCopy(user.organization_id)) {
        refreshed = Boolean(await copyOneForwardScanOrder(pool, user.organization_id, openConfiguredForwardScanSource, [trackingId], forwardScanExcludedMarketplaces).catch(() => null));
      }
      await pool.query(
        `INSERT INTO audit_logs (id, organization_id, user_id, action, resource, metadata, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'SYNCED_ORDER_REVERT', $3, $4::jsonb, NOW())`,
        [user.organization_id, user.user_id || null, trackingId, JSON.stringify({ deletedManual: Boolean(deleted.rowCount), refreshed })]
      );
      return { success: true, deletedManual: Boolean(deleted.rowCount), refreshed };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to revert order' });
    }
  });

  // SKU photo links: Forward Scan catalogue + hand-entered links.
  protectedRoutes.get<{ Querystring: { search?: string; source?: string; limit?: string; offset?: string } }>('/api/sku-images', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const { search, source } = req.query;
    const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit) || 50)));
    const offset = Math.min(100_000, Math.max(0, Math.floor(Number(req.query.offset) || 0)));
    const params: any[] = [user.organization_id];
    let where = 'WHERE organization_id = $1';
    if (source && ['manual', 'forward-scan', 'omsguru'].includes(source)) {
      params.push(source);
      where += ` AND source = $${params.length}`;
    }
    if (search && search.trim()) {
      params.push(`%${search.trim()}%`);
      where += ` AND (sku ILIKE $${params.length} OR title ILIKE $${params.length})`;
    }
    try {
      const [rowsRes, countRes] = await Promise.all([
        pool.query(
          `SELECT sku, sku_key, title, image_url, marketplace, source, updated_at
           FROM sku_images ${where}
           ORDER BY (source = 'manual') DESC, updated_at DESC, sku_key
           LIMIT ${limit} OFFSET ${offset}`,
          params
        ),
        pool.query(`SELECT COUNT(*)::int AS count FROM sku_images ${where}`, params),
      ]);
      return { total: Number(countRes.rows[0]?.count || 0), limit, offset, images: rowsRes.rows };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to load SKU images' });
    }
  });

  protectedRoutes.put('/api/sku-images', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const body = (req.body || {}) as any;
    const sku = typeof body.sku === 'string' ? body.sku.trim().slice(0, 255) : '';
    const imageUrl = normalizeManualImageUrl(body.imageUrl);
    if (!sku) return reply.status(400).send({ error: 'sku is required' });
    if (!imageUrl) return reply.status(400).send({ error: 'imageUrl must be a valid http(s) URL' });
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 300) : null;
    const marketplace = marketplaceFromChannelLabel(body.marketplace);
    try {
      await pool.query(
        `INSERT INTO sku_images (organization_id, sku, sku_key, title, image_url, marketplace, source, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7, NOW())
         ON CONFLICT (organization_id, sku_key, source) DO UPDATE SET
           sku = EXCLUDED.sku, title = COALESCE(EXCLUDED.title, sku_images.title),
           image_url = EXCLUDED.image_url, marketplace = COALESCE(EXCLUDED.marketplace, sku_images.marketplace),
           updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [user.organization_id, sku, normalizeSkuKey(sku), title, imageUrl, marketplace, user.user_id || null]
      );
      await pool.query(
        `INSERT INTO audit_logs (id, organization_id, user_id, action, resource, metadata, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'SKU_IMAGE_SET', $3, $4::jsonb, NOW())`,
        [user.organization_id, user.user_id || null, sku, JSON.stringify({ imageUrl })]
      );
      return { success: true, sku, skuKey: normalizeSkuKey(sku), imageUrl };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to save SKU image' });
    }
  });

  // Removes only the hand-entered link; the Forward Scan photo (if any)
  // shows again.
  protectedRoutes.delete<{ Querystring: { sku?: string } }>('/api/sku-images', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const skuKey = normalizeSkuKey(req.query.sku);
    if (!skuKey) return reply.status(400).send({ error: 'sku is required' });
    try {
      const res = await pool.query(
        `DELETE FROM sku_images WHERE organization_id = $1 AND sku_key = $2 AND source = 'manual'`,
        [user.organization_id, skuKey]
      );
      if (!res.rowCount) return reply.status(404).send({ error: 'No manual image for this SKU' });
      await pool.query(
        `INSERT INTO audit_logs (id, organization_id, user_id, action, resource, metadata, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'SKU_IMAGE_DELETE', $3, $4::jsonb, NOW())`,
        [user.organization_id, user.user_id || null, skuKey, JSON.stringify({})]
      );
      return { success: true };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to delete SKU image' });
    }
  });

  // Run the retention purge right now (admin button + cron fallback).
  protectedRoutes.post('/api/admin/retention-purge', async (req, reply) => {
    const user = (req as any).user;
    if (!isAdmin(user)) return reply.status(403).send({ error: 'Admin access required' });
    try {
      const query = req.query as { limit?: string };
      const limit = Math.max(1, Math.min(2000, Number(query.limit) || 200));
      const bucket = firebaseStorageBucket ? getStorage().bucket(firebaseStorageBucket) : null;
      // Scoped to the calling admin's org so a single admin cannot reach
      // into another org's expired data through this endpoint.
      const result = await runRetentionPurge(pool, bucket, {
        organizationId: user.organization_id,
        limit
      });
      try {
        await pool.query(
          `INSERT INTO audit_logs (id, organization_id, user_id, action, resource, metadata, created_at)
           VALUES (gen_random_uuid(), $1, $2, 'RETENTION_PURGE', 'retention', $3::jsonb, NOW())`,
          [user.organization_id, user.user_id, JSON.stringify(result)]
        );
      } catch (auditErr) {
        // Audit log failure is non-fatal — the purge already succeeded.
        console.warn('[retention] audit log insert failed:', auditErr);
      }
      return { success: true, ...result };
    } catch (err) {
      console.error('[retention] manual purge failed:', err);
      return reply.status(500).send({ error: 'Retention purge failed' });
    }
  });

  // Dry-run snapshot of what would be purged, for the admin dashboard.
  protectedRoutes.get('/api/admin/retention-purge/preview', async (req, reply) => {
    const user = (req as any).user;
    if (!isAdmin(user)) return reply.status(403).send({ error: 'Admin access required' });
    try {
      // pending_storage_deletions is keyed by storage_path, so we scope by
      // joining the live video_assets (or surviving path segments) to the
      // caller's organization. Anything not resolvable to a tenant is
      // excluded from the count.
      const [videos, sessions, pending] = await Promise.all([
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text as count FROM video_assets
           WHERE retention_until IS NOT NULL
             AND retention_until < NOW()
             AND COALESCE(legal_hold, FALSE) = FALSE
             AND organization_id = $1`,
          [user.organization_id]
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text as count FROM recording_sessions
           WHERE data_retention_until IS NOT NULL
             AND data_retention_until < NOW()
             AND COALESCE(legal_hold, FALSE) = FALSE
             AND organization_id = $1`,
          [user.organization_id]
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text as count
             FROM pending_storage_deletions psd
             LEFT JOIN video_assets va ON va.id = psd.video_asset_id
            WHERE va.organization_id = $1
               OR psd.storage_path LIKE $2`,
          [user.organization_id, `packing-videos/${user.organization_id}/%`]
        ),
      ]);
      return {
        videos: Number(videos.rows[0]?.count ?? 0),
        sessions: Number(sessions.rows[0]?.count ?? 0),
        pendingDeletions: Number(pending.rows[0]?.count ?? 0),
      };
    } catch (err) {
      console.error('[retention] preview failed:', err);
      return reply.status(500).send({ error: 'Retention preview failed' });
    }
  });

  protectedRoutes.get('/api/stats', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    try {
      // Same IST day boundary as the daily email report (server clock may be UTC).
      const { start: today } = getReportDay();
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const [
        countRes,
        totalRes,
        stationsRes,
        avgRes,
        failedCountRes,
        stationAnalyticsRes,
        marketplaceAnalyticsRes,
        packerLeaderboardRes,
        hourlyTrendRes,
        dailyTrendRes,
        recentActivityRes,
        stationStatusRes,
      ] = await Promise.all([
        pool.query('SELECT COUNT(*) as count FROM recording_sessions WHERE created_at >= $1 AND organization_id = $2', [today, user.organization_id]),
        pool.query('SELECT COUNT(*) as count FROM recording_sessions WHERE organization_id = $1', [user.organization_id]),
        pool.query("SELECT COUNT(DISTINCT station_id) as count FROM recording_sessions WHERE organization_id = $1 AND created_at >= $2", [user.organization_id, since24h]),
        pool.query('SELECT AVG(duration_ms) as avg FROM recording_sessions WHERE organization_id = $1', [user.organization_id]),
        pool.query("SELECT COUNT(*) as count FROM video_assets WHERE organization_id = $1 AND upload_status = 'failed'", [user.organization_id]),
        // LEFT JOIN with stations so the dashboard shows station code/name,
        // never the raw UUID. A deleted station becomes "(deleted)".
        pool.query(`
          SELECT rs.station_id,
                 COALESCE(NULLIF(s.code, ''), '(no code)') as station_code,
                 COALESCE(NULLIF(s.name, ''), NULLIF(s.code, ''), '(unnamed)') as station_name,
                 COUNT(*) as count,
                 AVG(rs.duration_ms) as avg,
                 MAX(rs.created_at) as last_activity
          FROM recording_sessions rs
          LEFT JOIN stations s
            ON s.id = rs.station_id AND s.organization_id = rs.organization_id
          WHERE rs.organization_id = $1
          GROUP BY rs.station_id, s.code, s.name
          ORDER BY count DESC
          LIMIT 25
        `, [user.organization_id]),
        pool.query(`
          SELECT COALESCE(NULLIF(marketplace, ''), 'Unassigned') as marketplace, COUNT(*) as count, AVG(duration_ms) as avg
          FROM recording_sessions
          WHERE organization_id = $1
          GROUP BY COALESCE(NULLIF(marketplace, ''), 'Unassigned')
          ORDER BY count DESC
        `, [user.organization_id]),
        // Top packers this week (joins auth.users for the human name).
        pool.query(`
          SELECT u.id as user_id,
                 COALESCE(NULLIF(u.name, ''), u.email, 'Unknown packer') as packer_name,
                 COUNT(*) as count,
                 AVG(rs.duration_ms) as avg_duration_ms
          FROM recording_sessions rs
          LEFT JOIN organization_members om
            ON om.user_id = rs.operator_user_id AND om.organization_id = rs.organization_id
          LEFT JOIN users u
            ON u.id = om.user_id
          WHERE rs.organization_id = $1
            AND rs.created_at >= NOW() - INTERVAL '7 days'
          GROUP BY u.id, u.name, u.email
          HAVING COUNT(*) > 0
          ORDER BY count DESC
          LIMIT 5
        `, [user.organization_id]),
        // Hourly trend for the last 24h (kept for backward compat).
        pool.query(`
          SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Kolkata') as hour,
                 COUNT(*) as count
          FROM recording_sessions
          WHERE organization_id = $1
            AND created_at >= $2
          GROUP BY 1
          ORDER BY 1
        `, [user.organization_id, since24h]),
        // Daily trend for the last 30 days (IST calendar days) for the dashboard chart.
        pool.query(`
          SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date as day,
                 COUNT(*) as count
          FROM recording_sessions
          WHERE organization_id = $1
            AND created_at >= $2
          GROUP BY 1
          ORDER BY 1
        `, [user.organization_id, since30d]),
        // Recent activity for the live feed.
        pool.query(`
          SELECT rs.id, rs.tracking_id, rs.marketplace, rs.duration_ms, rs.created_at,
                 COALESCE(NULLIF(s.code, ''), '(deleted)') as station_code,
                 COALESCE(NULLIF(u.name, ''), u.email, '(unknown)') as packer_name,
                 va.upload_status
          FROM recording_sessions rs
          LEFT JOIN stations s
            ON s.id = rs.station_id AND s.organization_id = rs.organization_id
          LEFT JOIN organization_members om
            ON om.user_id = rs.operator_user_id AND om.organization_id = rs.organization_id
          LEFT JOIN users u
            ON u.id = om.user_id
          LEFT JOIN video_assets va
            ON va.recording_session_id = rs.id
          WHERE rs.organization_id = $1
          ORDER BY rs.created_at DESC
          LIMIT 8
        `, [user.organization_id]),
        // Per-station last-heartbeat so we can flag "idle" / "active".
        pool.query(`
          SELECT s.id, s.code, s.name,
                 MAX(rs.created_at) as last_activity,
                 COUNT(rs.id) as packings_today
          FROM stations s
          LEFT JOIN recording_sessions rs
            ON rs.station_id = s.id
           AND rs.organization_id = s.organization_id
           AND rs.created_at >= $2
          WHERE s.organization_id = $1 AND s.active = TRUE
          GROUP BY s.id, s.code, s.name
          ORDER BY s.code
        `, [user.organization_id, today]),
      ]);

      const hourlyByHour = new Map<string, number>();
      for (const row of hourlyTrendRes.rows) {
        hourlyByHour.set(String(row.hour), parseInt(row.count));
      }
      const hourlyTrend: Array<{ hour: number; count: number; label: string }> = [];
      for (let h = 0; h < 24; h += 1) {
        const count = hourlyByHour.get(String(h)) || 0;
        const label = `${String(h).padStart(2, '0')}:00`;
        hourlyTrend.push({ hour: h, count, label });
      }

      // IST calendar days for the last 30 days (inclusive of today), zero-filled.
      const dailyByDay = new Map<string, number>();
      for (const row of dailyTrendRes.rows) {
        const day = row.day instanceof Date
          ? row.day.toISOString().slice(0, 10)
          : String(row.day).slice(0, 10);
        dailyByDay.set(day, parseInt(row.count, 10));
      }
      const dailyTrend: Array<{ date: string; count: number; label: string; fullLabel: string }> = [];
      const istTodayStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
      const [istY, istM, istD] = istTodayStr.split('-').map(Number);
      const shortFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
      const longFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
      for (let d = 29; d >= 0; d -= 1) {
        const dayDate = new Date(Date.UTC(istY, istM - 1, istD - d));
        const iso = dayDate.toISOString().slice(0, 10);
        dailyTrend.push({
          date: iso,
          count: dailyByDay.get(iso) || 0,
          label: shortFmt.format(dayDate),
          fullLabel: longFmt.format(dayDate),
        });
      }

      return {
        recordingsToday: parseInt(countRes.rows[0].count),
        videosUploaded: parseInt(totalRes.rows[0].count),
        pendingUploads: 0,
        failedUploads: parseInt(failedCountRes.rows[0].count),
        activeStations: parseInt(stationsRes.rows[0].count),
        averageDuration: avgRes.rows[0].avg ? (parseFloat(avgRes.rows[0].avg) / 1000).toFixed(1) : "0",
        stationAnalytics: stationAnalyticsRes.rows.map(row => ({
            station_id: row.station_id,
            station_code: row.station_code,
            station_name: row.station_name,
            count: parseInt(row.count),
            avg: row.avg ? (parseFloat(row.avg) / 1000).toFixed(1) : "0",
            last_activity: row.last_activity,
        })),
        marketplaceAnalytics: marketplaceAnalyticsRes.rows.map(row => ({
            marketplace: row.marketplace,
            count: parseInt(row.count),
            avg: row.avg ? (parseFloat(row.avg) / 1000).toFixed(1) : "0"
        })),
        packerLeaderboard: packerLeaderboardRes.rows.map(row => ({
            user_id: row.user_id,
            packer_name: row.packer_name,
            count: parseInt(row.count),
            avg_duration_seconds: row.avg_duration_ms ? parseFloat((parseFloat(row.avg_duration_ms) / 1000).toFixed(1)) : 0,
        })),
        hourlyTrend,
        dailyTrend,
        recentActivity: recentActivityRes.rows.map(row => ({
            id: row.id,
            tracking_id: row.tracking_id,
            marketplace: row.marketplace || 'Unassigned',
            duration_seconds: row.duration_ms ? parseFloat((parseFloat(row.duration_ms) / 1000).toFixed(1)) : 0,
            created_at: row.created_at,
            station_code: row.station_code,
            packer_name: row.packer_name,
            upload_status: row.upload_status || 'pending',
        })),
        stationStatus: stationStatusRes.rows.map(row => {
          const lastActivity = row.last_activity ? new Date(row.last_activity) : null;
          const minutesSince = lastActivity ? Math.floor((Date.now() - lastActivity.getTime()) / 60000) : null;
          return {
            id: row.id,
            code: row.code,
            name: row.name,
            last_activity: row.last_activity,
            minutes_since_activity: minutesSince,
            packings_today: parseInt(row.packings_today),
            status: minutesSince == null ? 'idle' : minutesSince < 5 ? 'active' : minutesSince < 60 ? 'slow' : 'idle',
          };
        }),
      };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Database error' });
    }
  });

  protectedRoutes.put('/api/videos/:id/review', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const { id } = req.params as any;
    const { status } = req.body as any;
    const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : '';

    if (!UUID_PATTERN.test(id)) {
      return reply.status(400).send({ error: 'Invalid video id' });
    }

    if (!REVIEW_STATUSES.has(normalizedStatus)) {
      return reply.status(400).send({ error: 'Invalid review status' });
    }

    try {
      const updateRes = await pool.query(
        'UPDATE video_assets SET review_status = $1 WHERE id = $2 AND organization_id = $3',
        [normalizedStatus, id, user.organization_id]
      );
      if (updateRes.rowCount === 0) {
        return reply.status(404).send({ error: 'Video not found' });
      }
      return { success: true };
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to update review status' });
    }
  });

  protectedRoutes.delete('/api/videos/:id', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const { id } = req.params as any;

    if (!UUID_PATTERN.test(id)) {
      return reply.status(400).send({ error: 'Invalid video id' });
    }

    try {
      const videoRes = await pool.query(
        `SELECT storage_path FROM video_assets WHERE id = $1 AND organization_id = $2`,
        [id, user.organization_id]
      );

      if (videoRes.rowCount !== null && videoRes.rowCount > 0) {
        const video = videoRes.rows[0];
        if (video.storage_path) {
          try {
            const file = getStorage().bucket(firebaseStorageBucket).file(video.storage_path);
            await file.delete({ ignoreNotFound: true });
          } catch (e) {
            // Storage delete failed: do NOT lose the row silently. Queue
            // a durable retry (the same pending_storage_deletions table
            // used by retention purge) so a future sweep cleans up.
            console.warn(`Failed to delete ${video.storage_path} from storage, queuing retry:`, e);
            try {
              await pool.query(
                `INSERT INTO pending_storage_deletions (storage_path, video_asset_id, last_error)
                 VALUES ($1, $2, $3)`,
                [video.storage_path, id, String((e as Error)?.message ?? e).slice(0, 500)]
              );
            } catch (queueErr) {
              console.error('Failed to queue storage delete retry:', queueErr);
            }
          }
        }
      }

      await pool.query(
        `DELETE FROM recording_sessions WHERE id = $1 AND organization_id = $2`,
        [id, user.organization_id]
      );

      return { success: true };
    } catch (err) {
      console.error('Failed to delete video', err);
      return reply.status(500).send({ error: 'Failed to delete video' });
    }
  });

  protectedRoutes.get('/api/videos/:id/download', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const { id } = req.params as any;

    if (!UUID_PATTERN.test(id)) {
      return reply.status(400).send({ error: 'Invalid video id' });
    }

    try {
      const videoRes = await pool.query(
        `SELECT va.storage_path, va.mime_type, va.size_bytes, rs.tracking_id, rs.order_id
         FROM video_assets va
         JOIN recording_sessions rs ON va.recording_session_id = rs.id AND rs.organization_id = va.organization_id
         WHERE va.id = $1 AND va.organization_id = $2`,
        [id, user.organization_id]
      );

      if (!videoRes.rowCount || videoRes.rowCount === 0) {
        return reply.status(404).send({ error: 'Video not found' });
      }

      const video = videoRes.rows[0];
      if (!video.storage_path) {
        return reply.status(404).send({ error: 'Video storage path missing' });
      }

      const file = getStorage().bucket(firebaseStorageBucket).file(video.storage_path);
      const [exists] = await file.exists();
      if (!exists) {
        return reply.status(404).send({ error: 'Video file not found in storage' });
      }

      const [metadata] = await file.getMetadata();
      const filename = `${safeDownloadName(video.order_id || video.tracking_id, id)}.mp4`;
      const size = metadata.size || video.size_bytes;

      reply.header('Content-Type', video.mime_type || metadata.contentType || 'video/mp4');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      if (size) {
        reply.header('Content-Length', String(size));
      }

      return reply.send(file.createReadStream());
    } catch (err) {
      req.log.error(err, 'Failed to download video');
      return reply.status(500).send({ error: 'Failed to download video' });
    }
  });

  // Short-lived signed URL for in-app playback. Never expose the long-lived
  // Firebase download token; public sharing goes through /share/<token>.
  protectedRoutes.get('/api/videos/:id/playback', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const { id } = req.params as any;

    if (!UUID_PATTERN.test(id)) {
      return reply.status(400).send({ error: 'Invalid video id' });
    }

    try {
      const videoRes = await pool.query(
        `SELECT va.storage_path
         FROM video_assets va
         WHERE va.id = $1 AND va.organization_id = $2`,
        [id, user.organization_id]
      );
      if (!videoRes.rowCount || videoRes.rowCount === 0) {
        return reply.status(404).send({ error: 'Video not found' });
      }
      const storagePath = videoRes.rows[0].storage_path;
      if (!storagePath) {
        return reply.status(404).send({ error: 'Video storage path missing' });
      }
      const file = getStorage().bucket(firebaseStorageBucket).file(storagePath);
      const [exists] = await file.exists();
      if (!exists) {
        return reply.status(404).send({ error: 'Video file not found in storage' });
      }
      const expires = Date.now() + PLAYBACK_URL_TTL_MS;
      const [url] = await file.getSignedUrl({ action: 'read', expires });
      return { url, expiresAt: new Date(expires).toISOString() };
    } catch (err) {
      req.log.error(err, 'Failed to mint playback URL');
      return reply.status(500).send({ error: 'Failed to load video' });
    }
  });

  // Public share link for one video: status / create-or-reuse / revoke.
  async function findOwnedVideo(organizationId: string, id: string): Promise<boolean> {
    const res = await pool.query(`SELECT 1 FROM video_assets WHERE id = $1 AND organization_id = $2`, [id, organizationId]);
    return (res.rowCount ?? 0) > 0;
  }

  function shareBaseUrl(req: FastifyRequest): string {
    return resolveAppBaseUrl((req.headers || {}) as any, process.env.ALLOWED_ORIGINS || '');
  }

  protectedRoutes.get('/api/videos/:id/share', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const { id } = req.params as any;
    if (!UUID_PATTERN.test(id)) return reply.status(400).send({ error: 'Invalid video id' });
    try {
      const res = await pool.query(
        `SELECT token, created_at, view_count, last_viewed_at FROM video_share_links
         WHERE organization_id = $1 AND video_asset_id = $2 AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [user.organization_id, id]
      );
      const link = res.rows[0];
      if (!link) return { active: false };
      return {
        active: true,
        url: buildShareUrl(shareBaseUrl(req), link.token),
        createdAt: link.created_at,
        viewCount: Number(link.view_count || 0),
        lastViewedAt: link.last_viewed_at,
      };
    } catch (err) {
      req.log.error(err, 'Failed to load share link');
      return reply.status(500).send({ error: 'Failed to load share link' });
    }
  });

  protectedRoutes.post('/api/videos/:id/share', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const { id } = req.params as any;
    if (!UUID_PATTERN.test(id)) return reply.status(400).send({ error: 'Invalid video id' });
    try {
      if (!(await findOwnedVideo(user.organization_id, id))) return reply.status(404).send({ error: 'Video not found' });
      // One live link per video: copying again returns the same URL.
      const existing = await pool.query(
        `SELECT token FROM video_share_links
         WHERE organization_id = $1 AND video_asset_id = $2 AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [user.organization_id, id]
      );
      let token = existing.rows[0]?.token as string | undefined;
      if (!token) {
        token = newShareToken();
        await pool.query(
          `INSERT INTO video_share_links (organization_id, video_asset_id, token, created_by)
           VALUES ($1, $2, $3, $4)`,
          [user.organization_id, id, token, user.user_id || null]
        );
        await pool.query(
          `INSERT INTO audit_logs (id, organization_id, user_id, action, resource, metadata, created_at)
           VALUES (gen_random_uuid(), $1, $2, 'VIDEO_SHARE_CREATE', $3, $4::jsonb, NOW())`,
          [user.organization_id, user.user_id || null, id, JSON.stringify({})]
        );
      }
      return { active: true, url: buildShareUrl(shareBaseUrl(req), token) };
    } catch (err) {
      req.log.error(err, 'Failed to create share link');
      return reply.status(500).send({ error: 'Failed to create share link' });
    }
  });

  protectedRoutes.delete('/api/videos/:id/share', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const { id } = req.params as any;
    if (!UUID_PATTERN.test(id)) return reply.status(400).send({ error: 'Invalid video id' });
    try {
      const res = await pool.query(
        `UPDATE video_share_links SET revoked_at = NOW()
         WHERE organization_id = $1 AND video_asset_id = $2 AND revoked_at IS NULL`,
        [user.organization_id, id]
      );
      await pool.query(
        `INSERT INTO audit_logs (id, organization_id, user_id, action, resource, metadata, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'VIDEO_SHARE_REVOKE', $3, $4::jsonb, NOW())`,
        [user.organization_id, user.user_id || null, id, JSON.stringify({ revoked: res.rowCount ?? 0 })]
      );
      return { success: true, revoked: res.rowCount ?? 0 };
    } catch (err) {
      req.log.error(err, 'Failed to revoke share link');
      return reply.status(500).send({ error: 'Failed to revoke share link' });
    }
  });

  protectedRoutes.get<{ Querystring: { search?: string, station?: string, reviewStatus?: string, marketplace?: string, from?: string, to?: string } }>('/api/videos/report', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const { search, station, reviewStatus, marketplace, from, to } = req.query;
    const range = parseReportDayRange(from, to);
    if ('error' in range) {
      return reply.status(400).send({ error: range.error });
    }
    try {
      // Create audit log for export
      await pool.query(`
        INSERT INTO audit_logs (id, organization_id, user_id, action, resource, created_at)
        VALUES (gen_random_uuid(), $1, $2, 'EXPORT', 'VIDEO_REPORT', NOW())
      `, [user.organization_id, user.user_id]);

      const params: any[] = [user.organization_id];
      const where = buildVideosReportWhere(
        { search, station, marketplace, reviewStatus, startUtc: range.startUtc, endUtc: range.endUtc },
        params
      );
      const res = await pool.query(`
        SELECT va.id, rs.tracking_id, rs.order_id, rs.marketplace, rs.flyer_id,
               rs.created_at as timestamp, va.duration_ms,
               u.name as packer_name, u.email as packer_email,
               s.code as station_code, s.name as station_name,
               va.upload_status, va.review_status
        FROM video_assets va
        JOIN recording_sessions rs ON va.recording_session_id = rs.id AND rs.organization_id = va.organization_id
        LEFT JOIN users u ON rs.operator_user_id = u.id
        LEFT JOIN stations s ON rs.station_id = s.id AND s.organization_id = va.organization_id
        ${where}
        ORDER BY rs.created_at DESC
        LIMIT ${REPORT_MAX_ROWS}
      `, params);

      const workbook = buildVideosReportWorkbook(
        res.rows,
        resolveAppBaseUrl((req.headers || {}) as any, process.env.ALLOWED_ORIGINS || '')
      );
      const buffer = await workbook.xlsx.writeBuffer();
      const filename = `vms-videos-${range.fromKey}_to_${range.toKey}.xlsx`;
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      reply.header('Content-Length', String(buffer.byteLength));
      return reply.send(Buffer.from(buffer));
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to generate report' });
    }
  });

  protectedRoutes.get('/api/admin/overview', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const [
        usersRes,
        stationsRes,
        videosRes,
        todayRes,
        storageDbRes,
        avgDurationRes,
        failedRes,
        orderMappingsRes,
        marketplaceRecordingsRes,
        recentRes,
        firebaseStorage
      ] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) as count
           FROM organization_members
           WHERE organization_id = $1`,
          [user.organization_id]
        ),
        pool.query(
          `SELECT COUNT(*) as total,
                  COUNT(*) FILTER (WHERE active = true) as active
           FROM stations
           WHERE organization_id = $1`,
          [user.organization_id]
        ),
        pool.query('SELECT COUNT(*) as count FROM video_assets WHERE organization_id = $1', [user.organization_id]),
        pool.query(
          'SELECT COUNT(*) as count FROM recording_sessions WHERE organization_id = $1 AND created_at >= $2',
          [user.organization_id, today]
        ),
        pool.query('SELECT COALESCE(SUM(size_bytes), 0) as bytes FROM video_assets WHERE organization_id = $1', [user.organization_id]),
        pool.query('SELECT AVG(duration_ms) as avg FROM recording_sessions WHERE organization_id = $1', [user.organization_id]),
        pool.query(
          `SELECT COUNT(*) as count
           FROM video_assets
           WHERE organization_id = $1 AND upload_status = 'failed'`,
          [user.organization_id]
        ),
        pool.query(
          `SELECT COUNT(*) as count
           FROM marketplace_order_mappings
           WHERE organization_id = $1`,
          [user.organization_id]
        ),
        pool.query(
          `SELECT COUNT(DISTINCT marketplace) as count
           FROM recording_sessions
           WHERE organization_id = $1 AND marketplace IS NOT NULL AND marketplace <> ''`,
          [user.organization_id]
        ),
        pool.query(
          `SELECT rs.tracking_id, rs.order_id, rs.marketplace, rs.status, rs.created_at, va.upload_status
           FROM recording_sessions rs
           LEFT JOIN video_assets va ON va.recording_session_id = rs.id
           WHERE rs.organization_id = $1
           ORDER BY rs.created_at DESC
           LIMIT 8`,
          [user.organization_id]
        ),
        getFirebaseStorageUsage()
      ]);

      const databaseStorageBytes = Number(storageDbRes.rows[0].bytes || 0);

      return {
        organizationId: user.organization_id,
        users: Number(usersRes.rows[0].count || 0),
        stations: {
          total: Number(stationsRes.rows[0].total || 0),
          active: Number(stationsRes.rows[0].active || 0)
        },
        videos: Number(videosRes.rows[0].count || 0),
        orderMappings: Number(orderMappingsRes.rows[0].count || 0),
        marketplacesWithRecordings: Number(marketplaceRecordingsRes.rows[0].count || 0),
        recordingsToday: Number(todayRes.rows[0].count || 0),
        failedUploads: Number(failedRes.rows[0].count || 0),
        averageDurationSeconds: avgDurationRes.rows[0].avg
          ? Number((Number(avgDurationRes.rows[0].avg) / 1000).toFixed(1))
          : 0,
        storage: {
          databaseBytes: databaseStorageBytes,
          databaseFormatted: formatBytes(databaseStorageBytes),
          firebase: firebaseStorage
        },
        recentActivity: recentRes.rows
      };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to load admin overview' });
    }
  });

  protectedRoutes.get('/api/admin/system-health', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const startedAt = Date.now();
    try {
      await pool.query('SELECT 1');
      
      let authStatus = 'FAIL';
      try {
        const { getAuth } = require('firebase-admin/auth');
        await getAuth().listUsers(1);
        authStatus = 'OK';
      } catch (err) {
        console.error('Auth Check Failed', err);
      }

      const [latestRecordingRes, pendingVideoRes, firebaseStorage] = await Promise.all([
        pool.query(
          `SELECT created_at
           FROM recording_sessions
           WHERE organization_id = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [user.organization_id]
        ),
        pool.query(
          `SELECT COUNT(*) as count
           FROM video_assets
           WHERE organization_id = $1 AND upload_status IN ('pending', 'uploading', 'failed')`,
          [user.organization_id]
        ),
        getFirebaseStorageUsage()
      ]);

      const allOk = firebaseStorage.status === 'OK' && authStatus === 'OK';

      return {
        status: allOk ? 'OK' : 'DEGRADED',
        checkedAt: new Date().toISOString(),
        responseMs: Date.now() - startedAt,
        services: {
          api: 'OK',
          database: 'OK',
          authentication: authStatus,
          firebaseStorage: firebaseStorage.status
        },
        firebaseStorage,
        pendingOrFailedUploads: Number(pendingVideoRes.rows[0].count || 0),
        latestRecordingAt: latestRecordingRes.rows[0]?.created_at || null
      };
    } catch (err) {
      console.error(err);
      return reply.status(503).send({
        status: 'UNAVAILABLE',
        checkedAt: new Date().toISOString(),
        services: { api: 'OK', database: 'FAIL', authentication: 'UNKNOWN', firebaseStorage: 'UNKNOWN' }
      });
    }
  });

  protectedRoutes.get('/api/admin/users', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    try {
      const res = await pool.query(
        `SELECT u.id, u.name, u.email, om.role, om.default_station_id, u.created_at,
                MAX(rs.created_at) as last_activity_at,
                COUNT(rs.id) as recordings
         FROM organization_members om
         JOIN users u ON u.id = om.user_id
         LEFT JOIN recording_sessions rs ON rs.operator_user_id = u.id AND rs.organization_id = om.organization_id
         WHERE om.organization_id = $1
         GROUP BY u.id, u.name, u.email, om.role, om.default_station_id, u.created_at
         ORDER BY u.created_at DESC`,
        [user.organization_id]
      );

      return { users: res.rows };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to load users' });
    }
  });

  protectedRoutes.post('/api/admin/users', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const { name, email, role, password: requestedPassword } = req.body as any;
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return reply.status(400).send({ error: 'Valid email is required' });
    }
    if (typeof name !== 'string' || !name.trim()) {
      return reply.status(400).send({ error: 'Name is required' });
    }
    const resolved = resolveUserPassword(requestedPassword);
    if ('error' in resolved) return reply.status(400).send({ error: resolved.error });
    // Privilege guard: managers can only create PACKER accounts (no admins,
    // no managers) — enforced here regardless of what the UI sends.
    const createRole = effectiveCreateRole(user, role);
    try {
      const { getAuth } = require('firebase-admin/auth');
      const userRecord = await getAuth().createUser({
        email: email.trim(),
        emailVerified: true,
        password: resolved.password,
        displayName: name.trim(),
        disabled: false,
      });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const userRes = await client.query(
          `INSERT INTO users (firebase_uid, email, name, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id`,
          [userRecord.uid, email.trim(), name.trim()]
        );
        await client.query(
          `INSERT INTO organization_members (organization_id, user_id, role, created_at) VALUES ($1, $2, $3, NOW())`,
          [user.organization_id, userRes.rows[0].id, createRole]
        );
        await client.query('COMMIT');
        return { success: true, uid: userRecord.uid, password: resolved.password };
      } catch (e) {
        await client.query('ROLLBACK');
        await getAuth().deleteUser(userRecord.uid);
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      console.error(e);
      return reply.status(500).send({ error: 'Failed to create user' });
    }
  });
  protectedRoutes.post('/api/admin/users/:id/reset-password', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const { id } = req.params as any;
    const resolved = resolveUserPassword((req.body as any)?.password);
    if ('error' in resolved) return reply.status(400).send({ error: resolved.error });
    try {
      const res = await pool.query(
        `SELECT u.firebase_uid, om.role AS member_role
         FROM users u
         INNER JOIN organization_members om ON om.user_id = u.id AND om.organization_id = $2
         WHERE u.id = $1`,
        [id, user.organization_id]
      );
      if (res.rows.length === 0) return reply.status(404).send({ error: 'User not found' });
      // Privilege guard: managers may only reset PACKER passwords — never
      // admins, managers, or outside-org accounts.
      if (!canResetPassword(user, res.rows[0].member_role)) {
        return reply.status(403).send({ error: 'Managers can only reset packer passwords' });
      }
      const { getAuth } = require('firebase-admin/auth');
      await getAuth().updateUser(res.rows[0].firebase_uid, { password: resolved.password });
      // Old sessions stop working immediately.
      await getAuth().revokeRefreshTokens(res.rows[0].firebase_uid);
      return { success: true, password: resolved.password };
    } catch (e) {
      console.error(e);
      return reply.status(500).send({ error: 'Failed to reset password' });
    }
  });

  protectedRoutes.delete('/api/admin/users/:id', async (req, reply) => {
    const user = (req as any).user;
    if (!isAdmin(user)) return reply.status(403).send({ error: 'Admin access required' });
    const { id } = req.params as any;
    // Don't allow user to delete themselves
    if (id === user.user_id) return reply.status(400).send({ error: 'Cannot delete yourself' });
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `SELECT u.firebase_uid
         FROM users u
         INNER JOIN organization_members om ON om.user_id = u.id AND om.organization_id = $2
         WHERE u.id = $1
         FOR UPDATE`,
        [id, user.organization_id]
      );
      if (res.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.status(404).send({ error: 'User not found' });
      }
      const firebaseUid = res.rows[0].firebase_uid;
      
      await client.query('DELETE FROM organization_members WHERE user_id = $1 AND organization_id = $2', [id, user.organization_id]);
      const leftover = await client.query(
        'SELECT 1 FROM organization_members WHERE user_id = $1 LIMIT 1',
        [id]
      );
      if (leftover.rows.length === 0) {
        await client.query('DELETE FROM users WHERE id = $1', [id]);
      }
      await client.query('COMMIT');
      
      const { getAuth } = require('firebase-admin/auth');
      await getAuth().deleteUser(firebaseUid).catch((err: any) => console.error("Firebase delete fail:", err));
      
      return { success: true };
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(e);
      return reply.status(500).send({ error: 'Failed to delete user' });
    } finally {
      client.release();
    }
  });

  protectedRoutes.put('/api/admin/users/:id/station', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const { id } = req.params as any; 
    const { stationId } = req.body as any;
    try {
      const memberRes = await pool.query(
        `SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2 LIMIT 1`,
        [id, user.organization_id]
      );
      if (memberRes.rows.length === 0) {
        return reply.status(404).send({ error: 'User not found' });
      }
      if (!canLinkStation(user, memberRes.rows[0].role)) {
        return reply.status(403).send({ error: 'Managers can only link stations for packer accounts' });
      }
      if (stationId) {
        const stationRes = await pool.query(
          `SELECT id FROM stations WHERE id = $1 AND organization_id = $2 LIMIT 1`,
          [stationId, user.organization_id]
        );
        if (stationRes.rows.length === 0) {
          return reply.status(400).send({ error: 'Station not found in this organization' });
        }
      }
      await pool.query(
        `UPDATE organization_members SET default_station_id = $1 WHERE user_id = $2 AND organization_id = $3`,
        [stationId || null, id, user.organization_id]
      );
      return { success: true };
    } catch (e) {
      return reply.status(500).send({ error: 'Failed to link station' });
    }
  });

  protectedRoutes.put('/api/users/me', async (req, reply) => {
    const user = (req as any).user;
    const { name } = req.body as any;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
      return reply.status(400).send({ error: 'Name is required (max 100 characters)' });
    }
    const sanitizedName = name.trim();
    try {
      const { getAuth } = require('firebase-admin/auth');
      await getAuth().updateUser(user.uid, { displayName: sanitizedName });
      await pool.query('UPDATE users SET name = $1 WHERE id = $2', [sanitizedName, user.user_id]);
      return { success: true };
    } catch (e) {
      return reply.status(500).send({ error: 'Failed to update name' });
    }
  });

  // Identity for client-side UI gating (server still enforces everything).
  protectedRoutes.get('/api/me', async (req, reply) => {
    const user = (req as any).user;
    // Default packing station assigned by the admin (Users page). Resolved
    // here so packing PCs learn it at login without extra admin-only calls.
    let station: { id: string; code: string; name: string | null } | null = null;
    try {
      const stationRes = await pool.query(
        `SELECT s.id, s.code, s.name
         FROM organization_members om
         JOIN stations s ON s.id = om.default_station_id AND s.organization_id = om.organization_id
         WHERE om.user_id = $1 AND om.organization_id = $2
         LIMIT 1`,
        [user.user_id, user.organization_id]
      );
      const row = stationRes.rows[0];
      if (row && row.code) station = { id: row.id, code: row.code, name: row.name || null };
    } catch (err) {
      console.warn('Station lookup for /api/me skipped:', err instanceof Error ? err.message : err);
    }
    // Packing preferences every role needs (no credentials).
    let autoFlyerScan = true;
    try {
      autoFlyerScan = await getAutoFlyerScan(pool, user.organization_id);
    } catch (err) {
      console.warn('Packing preference lookup for /api/me skipped:', err instanceof Error ? err.message : err);
    }
    let claimsUpdated = false;
    try {
      claimsUpdated = await ensureOrgCustomClaims(
        user.uid,
        user.organization_id,
        user.role,
        user.tokenOrgId,
        user.tokenOrgRole
      );
    } catch (err) {
      console.warn('Custom claim sync skipped:', err instanceof Error ? err.message : err);
    }
    return {
      user_id: user.user_id,
      organization_id: user.organization_id,
      role: normalizeRole(user.role),
      station,
      packing: { autoFlyerScan },
      claimsUpdated,
    };
  });

  protectedRoutes.get('/api/admin/stations', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    try {
      const res = await pool.query(
        `SELECT s.id, s.code, s.name, w.location, s.active, s.created_at,
                COUNT(rs.id) as recordings,
                COUNT(rs.id) / GREATEST(EXTRACT(EPOCH FROM (NOW() - s.created_at)) / 86400, 1.0) as daily_average,
                MAX(rs.created_at) as last_recording_at
         FROM stations s
         LEFT JOIN warehouses w ON s.warehouse_id = w.id
         LEFT JOIN recording_sessions rs ON rs.station_id = s.id AND rs.organization_id = s.organization_id
         WHERE s.organization_id = $1
         GROUP BY s.id, s.code, s.name, w.location, s.active, s.created_at
         ORDER BY s.code ASC`,
        [user.organization_id]
      );

      return { stations: res.rows };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to load stations' });
    }
  });

  protectedRoutes.post('/api/admin/stations', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const { code, name } = req.body as any;
    if (typeof code !== 'string' || !code.trim() || code.trim().length > 50) {
      return reply.status(400).send({ error: 'Station code is required (max 50 characters)' });
    }
    const sanitizedCode = code.trim().toUpperCase();
    const sanitizedName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : sanitizedCode;
    try {
      await pool.query(
        `INSERT INTO stations (id, organization_id, code, name, active, created_at) VALUES (gen_random_uuid(), $1, $2, $3, true, NOW())`,
        [user.organization_id, sanitizedCode, sanitizedName]
      );
      return { success: true };
    } catch (e) {
      return reply.status(500).send({ error: 'Failed to create station' });
    }
  });

  protectedRoutes.delete('/api/admin/stations/:id', async (req, reply) => {
    const user = (req as any).user;
    if (!isAdmin(user)) return reply.status(403).send({ error: 'Admin access required' });
    const { id } = req.params as any;
    try {
      await pool.query(
        `UPDATE stations SET active = false WHERE id = $1 AND organization_id = $2`,
        [id, user.organization_id]
      );
      return { success: true };
    } catch (e) {
      return reply.status(500).send({ error: 'Failed to delete station' });
    }
  });

  protectedRoutes.get('/api/admin/scan-history', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    try {
      const res = await pool.query(
         `SELECT rs.id, rs.tracking_id, rs.order_id, rs.marketplace, rs.status, rs.duration_ms, rs.created_at, rs.flyer_id,
                u.name as packer_name, u.email as packer_email,
                s.code as station_code,
                va.upload_status, va.review_status
         FROM recording_sessions rs
         LEFT JOIN users u ON rs.operator_user_id = u.id
         LEFT JOIN stations s ON rs.station_id = s.id AND s.organization_id = rs.organization_id
         LEFT JOIN video_assets va ON va.recording_session_id = rs.id AND va.organization_id = rs.organization_id
         WHERE rs.organization_id = $1
         ORDER BY rs.created_at DESC
         LIMIT 100`,
        [user.organization_id]
      );

      return { scans: res.rows };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to load scan history' });
    }
  });

  // --- Meesho Flyer Link-up Queue & Automation Endpoints ---

  protectedRoutes.get('/api/meesho/flyer-queue', async (req, reply) => {
    const user = (req as any).user;
    if (!isCompanion(user) && !isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const { status, limit, from } = req.query as any || {};
    try {
      const result = await getMeeshoFlyerQueue(pool, user.organization_id, { status, limit, fromDate: from });
      return result;
    } catch (err) {
      console.error('Failed to get Meesho flyer queue', err);
      return reply.status(500).send({ error: 'Failed to fetch Meesho flyer queue' });
    }
  });

  protectedRoutes.post('/api/meesho/flyer-queue/link', async (req, reply) => {
    const user = (req as any).user;
    if (!isCompanion(user) && !isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const body = req.body as any || {};
    const updates = Array.isArray(body.items) ? body.items : [body];
    try {
      const result = await updateMeeshoFlyerStatus(pool, user.organization_id, updates);
      return { success: true, updatedCount: result.updatedCount };
    } catch (err) {
      console.error('Failed to update Meesho flyer status', err);
      return reply.status(500).send({ error: 'Failed to update Meesho flyer status' });
    }
  });

  protectedRoutes.post('/api/meesho/flyer-queue/fix-swapped', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    try {
      const result = await fixSwappedFlyerBarcodes(pool, user.organization_id);
      return { success: true, fixedCount: result.fixedCount, fixedRows: result.fixedRows };
    } catch (err) {
      console.error('Failed to fix swapped flyer barcodes', err);
      return reply.status(500).send({ error: 'Failed to fix swapped flyer barcodes' });
    }
  });

  protectedRoutes.get('/api/meesho/flyer-queue/export', async (req, reply) => {
    const user = (req as any).user;
    const { status, from } = req.query as any || {};
    try {
      const csv = await exportMeeshoFlyerCsv(pool, user.organization_id, { status, fromDate: from });
      const dateStr = new Date().toISOString().slice(0, 10);
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="meesho-flyer-scans-${dateStr}.csv"`);
      return reply.send(csv);
    } catch (err) {
      console.error('Failed to export Meesho flyer CSV', err);
      return reply.status(500).send({ error: 'Failed to export Meesho flyer CSV' });
    }
  });

  protectedRoutes.get('/api/meesho/settings', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    try {
      const settings = await getMeeshoSettings(pool, user.organization_id);
      return settings;
    } catch (err) {
      console.error('Failed to get Meesho settings', err);
      return reply.status(500).send({ error: 'Failed to fetch Meesho settings' });
    }
  });

  protectedRoutes.put('/api/meesho/settings', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const body = req.body as any || {};
    try {
      const result = await saveMeeshoSettings(pool, user.organization_id, body, user.user_id);
      return result;
    } catch (err) {
      console.error('Failed to save Meesho settings', err);
      return reply.status(500).send({ error: 'Failed to save Meesho settings' });
    }
  });

  // Packing page automation switch (Meesho Flyer page). Packers read it via
  // /api/me; changing it is a manager decision like the rest of the page.
  protectedRoutes.put('/api/meesho/auto-flyer-scan', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    const enabled = (req.body as any)?.enabled;
    if (typeof enabled !== 'boolean') return reply.status(400).send({ error: 'enabled must be true or false' });
    try {
      await setAutoFlyerScan(pool, user.organization_id, enabled, user.user_id);
      await pool.query(
        `INSERT INTO audit_logs (id, organization_id, user_id, action, resource, metadata, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'MEESHO_AUTO_FLYER_SCAN', 'meesho_settings', $3::jsonb, NOW())`,
        [user.organization_id, user.user_id || null, JSON.stringify({ enabled })]
      );
      return { success: true, autoFlyerScan: enabled };
    } catch (err) {
      console.error('Failed to save automatic flyer scan', err);
      return reply.status(500).send({ error: 'Failed to save automatic flyer scan' });
    }
  });

  // Plaintext Meesho seller login: only the paired companion app (auto-login)
  // or an admin — never packers or managers browsing the API.
  protectedRoutes.get('/api/meesho/credentials', async (req, reply) => {
    const user = (req as any).user;
    if (!isCompanion(user) && !isAdmin(user)) return reply.status(403).send({ error: 'Admin access required' });
    try {
      const creds = await getMeeshoCredentials(pool, user.organization_id);
      return creds;
    } catch (err) {
      console.error('Failed to get Meesho credentials', err);
      return reply.status(500).send({ error: 'Failed to fetch Meesho credentials' });
    }
  });

  // The pairing key grants the companion's API access: managers+ only.
  protectedRoutes.get('/api/meesho/companion-token', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    try {
      const info = await getOrCreateCompanionToken(pool, user.organization_id);
      return {
        ...info,
        vmsUrl: `https://${process.env.APP_DOMAIN || 'vms.youthnic.shop'}`
      };
    } catch (err) {
      console.error('Failed to get or create companion token', err);
      return reply.status(500).send({ error: 'Failed to generate companion token' });
    }
  });

  protectedRoutes.post('/api/meesho/companion-token/regenerate', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    try {
      const info = await regenerateCompanionToken(pool, user.organization_id);
      return {
        ...info,
        vmsUrl: `https://${process.env.APP_DOMAIN || 'vms.youthnic.shop'}`
      };
    } catch (err) {
      console.error('Failed to regenerate companion token', err);
      return reply.status(500).send({ error: 'Failed to regenerate companion token' });
    }
  });

  protectedRoutes.get('/api/meesho/companion-auth/check', async (req, reply) => {
    const user = (req as any).user;
    return {
      authenticated: true,
      organizationId: user.organization_id,
      orgName: user.orgName || user.org_name || 'Active Organization',
      isCompanion: Boolean(user.isCompanion)
    };
  });


  protectedRoutes.get('/api/admin/reports', async (req, reply) => {
    const user = (req as any).user;
    if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
    try {
      const [statusRes, stationRes, marketplaceRes, reviewRes] = await Promise.all([
        pool.query(
          `SELECT upload_status, COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as bytes
           FROM video_assets
           WHERE organization_id = $1
           GROUP BY upload_status
           ORDER BY upload_status`,
          [user.organization_id]
        ),
        pool.query(
          `SELECT COALESCE(s.code, 'UNKNOWN') as station, COUNT(rs.id) as count, AVG(rs.duration_ms) as avg_duration_ms
           FROM recording_sessions rs
           LEFT JOIN stations s ON rs.station_id = s.id AND s.organization_id = rs.organization_id
           WHERE rs.organization_id = $1
           GROUP BY COALESCE(s.code, 'UNKNOWN')
           ORDER BY count DESC`,
          [user.organization_id]
        ),
        pool.query(
          `SELECT COALESCE(NULLIF(marketplace, ''), 'Unassigned') as marketplace, COUNT(rs.id) as count, AVG(rs.duration_ms) as avg_duration_ms
           FROM recording_sessions rs
           WHERE rs.organization_id = $1
           GROUP BY COALESCE(NULLIF(marketplace, ''), 'Unassigned')
           ORDER BY count DESC`,
          [user.organization_id]
        ),
        pool.query(
          `SELECT review_status, COUNT(*) as count
           FROM video_assets
           WHERE organization_id = $1
           GROUP BY review_status
           ORDER BY review_status`,
          [user.organization_id]
        )
      ]);

      return {
        uploadStatus: statusRes.rows,
        stationPerformance: stationRes.rows,
        marketplacePerformance: marketplaceRes.rows,
        reviewStatus: reviewRes.rows
      };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to load reports' });
    }
  });

  protectedRoutes.post('/api/admin/clear-data', async (req, reply) => {
    const user = (req as any).user;
    if (!isAdmin(user)) return reply.status(403).send({ error: 'Admin access required' });

    try {
      // Truncate tables for the organization (using DELETE for safety since TRUNCATE affects all orgs)
      await pool.query(`DELETE FROM video_assets WHERE organization_id = $1`, [user.organization_id]);
      await pool.query(`DELETE FROM recording_sessions WHERE organization_id = $1`, [user.organization_id]);
      await pool.query(`DELETE FROM marketplace_order_mappings WHERE organization_id = $1`, [user.organization_id]);
      await pool.query(`DELETE FROM order_import_batches WHERE organization_id = $1`, [user.organization_id]);

      // Note: We delete Firebase storage files asynchronously to prevent timeout issues
      // when there are thousands of files. The DB will be wiped, which gives the user a fresh UI start.
      try {
        const bucket = getStorage().bucket(process.env.FIREBASE_STORAGE_BUCKET);
        // This runs in the background
        bucket.deleteFiles({ prefix: `packing-videos/${user.organization_id}/` }).catch(e => console.error('Background storage deletion failed:', e));
      } catch (err) {
        console.warn('Failed to start storage deletion', err);
      }
      
      await pool.query(
        `INSERT INTO audit_logs (id, organization_id, user_id, action, resource, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'WIPE_DATA', 'ALL', NOW())`,
        [user.organization_id, user.user_id]
      );

      return { success: true };
    } catch (err) {
      console.error('Failed to clear data', err);
      return reply.status(500).send({ error: 'Failed to clear data' });
    }
  });

});

const port = process.env.PORT ? parseInt(process.env.PORT) : 8080;
async function start() {
  try {
    console.log('Effective CORS origins:', allowedOrigins === true ? 'ALL (ALLOWED_ORIGINS unset)' : allowedOrigins.join(', '));
    await ensureRuntimeTables();
    await repairExistingVideoAssets();
    await validateFirebaseStorageBucket();
    await server.listen({ port, host: '0.0.0.0' });
    scheduleForwardScanSync();
    scheduleSkuImageSync();
    scheduleRetentionPurge();
    scheduleAjioWfrSafetyNet();
    installGracefulShutdown();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

// Graceful shutdown: drain in-flight HTTP, end DB pool, then exit.
// Triggered by SIGTERM (Hostinger / Docker stop) and SIGINT (Ctrl-C in dev).
let shuttingDown = false;
function installGracefulShutdown(): void {
  const handler = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      console.warn(`[shutdown] received ${signal} again, forcing exit`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}, draining...`);
    const drainTimeout = setTimeout(() => {
      console.error('[shutdown] drain timeout exceeded, forcing exit');
      process.exit(1);
    }, 30_000);
    drainTimeout.unref();
    server.close()
      .then(() => pool.end().catch((err) => console.error('[shutdown] pool.end error:', err)))
      .then(() => {
        console.log('[shutdown] clean exit');
        process.exit(0);
      })
      .catch((err) => {
        console.error('[shutdown] error during drain:', err);
        process.exit(1);
      });
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}

start();
