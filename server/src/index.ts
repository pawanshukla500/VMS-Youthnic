import fastify from 'fastify';
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
import { authMiddleware, isAdmin, isManagerOrAdmin, normalizeRole, resolveUserPassword, effectiveCreateRole, canResetPassword } from './middleware/auth';
import { buildPostgresPoolConfig } from './db/poolConfig';
import { buildRecordingSessionUpsert, mappingStatusForRecording, buildMovedStoragePath } from './db/recordingSessions';
import { buildPurgeStatements, buildPurgeCountStatements, purgeRetentionDays } from './db/purge';
import { mapInvoiceToCachedOrder, mapListingToPhoto, attachPhotos, normalizeSkuKey, usesSubOrderIdentity, CachedOrderItem } from './omsguru/mappers';
import { omsguruCredentials } from './omsguru/client';
import { resolveSyncCreds, maskToken, runOMSGuruSync, runOMSGuruOrderPoll, cacheDecision, parseWarehouseIds, lookupOrderByTrackerDetailed, ensurePhotoBootstrap } from './omsguru/sync';
import { createOMSGuruClient } from './omsguru/client';
import { getReportDay, buildDailyReportHtml, buildDailyReportSubject, parseReportRecipients } from './reports/dailyReport';
import { findLatestInstaller, getDesktopDownloadDir, isPublishableDownloadFile, getDesktopPublicDownloadUrl, readLatestReleaseRef, issueDownloadTicket, consumeDownloadTicket } from './downloads';
import { formatVideoRow } from './videos';
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
  if (!raw || !raw.trim()) return true;
  const origins = raw.split(',').map((o) => o.trim()).filter(Boolean);
  return origins.length > 0 ? origins : true;
}

const allowedOrigins = parseAllowedOrigins();

const server = fastify({ logger: true });

server.register(cors, {
  origin: allowedOrigins,
});

server.register(helmet);

server.register(rateLimit, {
  max: 300,
  timeWindow: '1 minute'
});

server.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB limit

const pool = new Pool(buildPostgresPoolConfig());

type OMSGuruSyncResult = {
  organization_id: string;
  photos: number;
  orders: number;
  warehouseId: string | null;
};

type OMSGuruSyncRun = {
  results: OMSGuruSyncResult[];
  failures: number;
};

let omsguruSyncPromise: Promise<OMSGuruSyncRun> | null = null;

// Keep cache refresh automatic even when the external cron host is absent.
// A shared promise prevents an admin click, cron call, and startup run from
// consuming the OMSGuru rate budget concurrently.
function syncAllOMSGuruOrganizations(mode: 'full' | 'orders' = 'full'): Promise<OMSGuruSyncRun> {
  if (omsguruSyncPromise) return omsguruSyncPromise;

  omsguruSyncPromise = (async () => {
    const orgRes = await pool.query(`SELECT id FROM organizations`);
    const results: OMSGuruSyncResult[] = [];
    let failures = 0;

    for (const org of orgRes.rows) {
      const settingsRes = await pool.query(
        `SELECT token, cid, warehouse_id FROM omsguru_settings WHERE organization_id = $1`,
        [org.id]
      );
      let creds;
      try {
        creds = resolveSyncCreds(settingsRes.rows[0] || null, {
          token: process.env.OMSGURU_TOKEN,
          cid: process.env.OMSGURU_CID,
          warehouseId: process.env.OMSGURU_WAREHOUSE_ID,
        });
      } catch {
        continue;
      }

      try {
        if (mode === 'orders') {
          const result = await runOMSGuruOrderPoll(pool, org.id, creds);
          results.push({
            organization_id: org.id,
            photos: 0,
            orders: result.orders,
            warehouseId: creds.warehouseId || null,
          });
        } else {
          const result = await runOMSGuruSync(pool, org.id, creds);
          results.push({ organization_id: org.id, ...result });
        }
      } catch (err) {
        failures += 1;
        console.error(`OMSGuru sync failed for organization ${org.id}:`, err);
      }
    }

    return { results, failures };
  })().finally(() => {
    omsguruSyncPromise = null;
  });

  return omsguruSyncPromise;
}

function scheduleAutomaticOMSGuruSync(): void {
  const configuredHours = Number(process.env.OMSGURU_AUTO_SYNC_INTERVAL_HOURS || '6');
  const intervalHours = Number.isFinite(configuredHours)
    ? Math.min(24, Math.max(1, configuredHours))
    : 6;
  const intervalMs = intervalHours * 60 * 60 * 1000;
  const configuredPollMinutes = Number(process.env.OMSGURU_ORDER_POLL_INTERVAL_MINUTES || '5');
  const pollMinutes = Number.isFinite(configuredPollMinutes)
    ? Math.min(15, Math.max(1, configuredPollMinutes))
    : 5;
  const pollMs = pollMinutes * 60 * 1000;

  const run = async () => {
    try {
      const result = await syncAllOMSGuruOrganizations();
      const [ordersPurged, photosPurged] = await Promise.all([
        pool.query(`DELETE FROM omsguru_order_cache WHERE fetched_at < NOW() - INTERVAL '24 hours'`),
        pool.query(`DELETE FROM omsguru_sku_photos WHERE fetched_at < NOW() - INTERVAL '24 hours'`),
      ]);
      console.log(
        `Automatic OMSGuru sync complete: ${result.results.length} organizations, ` +
        `${result.failures} failures, purged ${ordersPurged.rowCount || 0} orders and ${photosPurged.rowCount || 0} photos`
      );
    } catch (err) {
      console.error('Automatic OMSGuru sync failed:', err);
    }
  };

  const runOrderPoll = async () => {
    try {
      const result = await syncAllOMSGuruOrganizations('orders');
      console.log(`Automatic OMSGuru order poll complete: ${result.results.length} organizations, ${result.failures} failures`);
    } catch (err) {
      console.error('Automatic OMSGuru order poll failed:', err);
    }
  };

  // Let the HTTP server become ready first; subsequent runs keep the 24h
  // cache warm without any operator action.
  setTimeout(() => {
    void run();
    setInterval(() => void run(), intervalMs);
    setInterval(() => void runOrderPoll(), pollMs);
  }, 30_000);
  console.log(`Automatic OMSGuru sync scheduled every ${intervalHours} hour(s); order poll every ${pollMinutes} minute(s)`);
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
server.get('/api/downloads/files/:file', { config: { rateLimit: false } }, async (request, reply) => {
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
server.get('/api/downloads/file', async (request, reply) => {
  const { t } = request.query as { t?: string };
  if (!consumeDownloadTicket(downloadTicketStore, t)) {
    return reply.status(403).send({ error: 'Download link expired — request a fresh one from the packing page Desktop App button.' });
  }
  return sendLatestInstaller(reply, getDesktopDownloadDir());
});

const requireAuth = authMiddleware(pool);

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

server.post('/api/jobs/order-mappings/reconcile', async (req, reply) => {
  const expectedSecret = process.env.ORDER_RECONCILE_SECRET;
  const providedSecret = req.headers['x-cron-secret'];
  const authorization = req.headers.authorization || '';
  const bearerSecret = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;

  if (!expectedSecret) {
    return reply.status(503).send({ error: 'ORDER_RECONCILE_SECRET is not configured' });
  }

  if (providedSecret !== expectedSecret && bearerSecret !== expectedSecret) {
    return reply.status(401).send({ error: 'Unauthorized job request' });
  }

  try {
    const updateRes = await pool.query(
      `UPDATE recording_sessions rs
       SET order_id = mom.order_id,
           marketplace = mom.marketplace,
           order_mapping_imported_at = NOW(),
           updated_at = NOW()
       FROM marketplace_order_mappings mom
       WHERE mom.organization_id = rs.organization_id
         AND mom.tracking_id = rs.tracking_id
         AND (
           rs.order_id IS DISTINCT FROM mom.order_id
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
server.post('/api/jobs/retention-purge', async (req, reply) => {
  const expectedSecret = process.env.ORDER_RECONCILE_SECRET;
  const providedSecret = req.headers['x-cron-secret'];
  const authorization = req.headers.authorization || '';
  const bearerSecret = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;

  if (!expectedSecret) {
    return reply.status(503).send({ error: 'ORDER_RECONCILE_SECRET is not configured' });
  }

  if (providedSecret !== expectedSecret && bearerSecret !== expectedSecret) {
    return reply.status(401).send({ error: 'Unauthorized job request' });
  }

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

// OMSGuru cache sync (same cron secret as reconcile). Pulls channel
// listings (SKU photos) and recent invoices (order lines by AWB) into
// local tables so packing reads never touch the rate-limited API.
server.post('/api/jobs/omsguru-sync', async (req, reply) => {
  const expectedSecret = process.env.ORDER_RECONCILE_SECRET;
  const providedSecret = req.headers['x-cron-secret'];
  const authorization = req.headers.authorization || '';
  const bearerSecret = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;

  if (!expectedSecret) {
    return reply.status(503).send({ error: 'ORDER_RECONCILE_SECRET is not configured' });
  }

  if (providedSecret !== expectedSecret && bearerSecret !== expectedSecret) {
    return reply.status(401).send({ error: 'Unauthorized job request' });
  }

  try {
    const { results, failures } = await syncAllOMSGuruOrganizations();

    if (results.length === 0) {
      return reply.status(failures > 0 ? 502 : 503).send({
        error: failures > 0 ? 'OMSGuru sync failed' : 'OMSGuru is not configured (token / client ID)',
      });
    }

    return { results, failures };
  } catch (err) {
    console.error(err);
    return reply.status(502).send({ error: 'OMSGuru sync failed' });
  }
});

server.post('/api/jobs/daily-report', async (req, reply) => {
  const expectedSecret = process.env.REPORT_JOB_SECRET;
  const providedSecret = req.headers['x-report-secret'];
  const authorization = req.headers.authorization || '';
  const bearerSecret = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;

  if (!expectedSecret) {
    return reply.status(503).send({ error: 'REPORT_JOB_SECRET is not configured' });
  }

  if (providedSecret !== expectedSecret && bearerSecret !== expectedSecret) {
    return reply.status(401).send({ error: 'Unauthorized job request' });
  }

  const query = req.query as any;
  const dryRun = query?.dryRun === '1' || query?.dryRun === 'true';
  const resendKey = process.env.RESEND_API_KEY;
  const recipients = parseReportRecipients(process.env.REPORT_TO_EMAILS);
  const from = process.env.REPORT_FROM_EMAIL || 'PVMS Daily Report <reports@pkvm.youthnic.shop>';

  if (!dryRun && (!resendKey || recipients.length === 0)) {
    return reply.status(503).send({ error: 'Daily report email is not configured (RESEND_API_KEY / REPORT_TO_EMAILS)' });
  }

  try {
    const { day, start, end } = getReportDay(typeof query?.date === 'string' ? query.date : undefined);

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
      pool.query(`SELECT COUNT(*) as count FROM recording_sessions WHERE created_at >= $1 AND created_at < $2`, [start, end]),
      pool.query(`SELECT COUNT(*) as count FROM video_assets WHERE uploaded_at >= $1 AND uploaded_at < $2 AND upload_status IN ('completed', 'uploaded')`, [start, end]),
      pool.query(`SELECT COUNT(*) as count FROM video_assets WHERE created_at >= $1 AND created_at < $2 AND upload_status = 'failed'`, [start, end]),
      pool.query(`SELECT COUNT(DISTINCT operator_user_id) as count FROM recording_sessions WHERE created_at >= $1 AND created_at < $2 AND operator_user_id IS NOT NULL`, [start, end]),
      pool.query(`SELECT AVG(duration_ms) as avg FROM recording_sessions WHERE created_at >= $1 AND created_at < $2`, [start, end]),
      pool.query(`SELECT COUNT(*) as count FROM marketplace_order_mappings WHERE imported_at >= $1 AND imported_at < $2`, [start, end]),
      pool.query(`SELECT COUNT(*) as count FROM recording_sessions WHERE order_mapping_imported_at >= $1 AND order_mapping_imported_at < $2`, [start, end]),
      pool.query(`SELECT items FROM omsguru_order_cache WHERE fetched_at >= $1 - INTERVAL '30 days' LIMIT 5000`, [start]),
      pool.query(
        `SELECT COALESCE(s.code, 'UNKNOWN') as station, COUNT(*) as packed
         FROM recording_sessions rs
         LEFT JOIN stations s ON s.id = rs.station_id
         WHERE rs.created_at >= $1 AND rs.created_at < $2
         GROUP BY s.code
         ORDER BY packed DESC`,
        [start, end]
      ),
      pool.query(
        `SELECT COALESCE(NULLIF(marketplace, ''), 'Unassigned') as marketplace, COUNT(*) as packed
         FROM recording_sessions
         WHERE created_at >= $1 AND created_at < $2
         GROUP BY COALESCE(NULLIF(marketplace, ''), 'Unassigned')
         ORDER BY packed DESC`,
        [start, end]
      ),
    ]);

    // Meesho-style rename: recordings whose order_id matches a known
    // sub-order/item id from recent OMSGuru cache rows.
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
          WHERE created_at >= $1 AND created_at < $2 AND order_id = ANY($3)`,
        [start, end, [...knownSubIds].slice(0, 10000)]
      )
      : { rows: [{ count: 0 }] };

    const stats = {
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
    };

    if (dryRun) {
      return { dryRun: true, stats };
    }

    const resend = new Resend(resendKey as string);
    const { error } = await resend.emails.send({
      from,
      to: recipients,
      subject: buildDailyReportSubject(stats),
      html: buildDailyReportHtml(stats),
    });

    if (error) {
      console.error('Daily report send failed:', error);
      return reply.status(502).send({ error: 'Failed to send daily report' });
    }

    return { sent: true, day, recipients: recipients.length, totalPacked: stats.totalPacked };
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

function csvEscape(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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
    const orderId = isAjioMarketplace(marketplace)
      ? extraInfoOrderId || channelOrderId
      : channelOrderId || extraInfoOrderId;

    if (!trackingId || !orderId || !marketplace) {
      skipped.push({ row: rowNumber, reason: 'tracking_id, order_id, and marketplace are required' });
      return [];
    }

    return [{ trackingId, orderId, marketplace }];
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
  await pool.query(`ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS flyer_id VARCHAR(255)`);
  // video_assets columns the code reads/writes: older production tables were
  // created before some of these existed (no ALTERs ever covered them).
  await pool.query(`ALTER TABLE video_assets ADD COLUMN IF NOT EXISTS duration_ms BIGINT`);
  await pool.query(`ALTER TABLE video_assets ADD COLUMN IF NOT EXISTS review_status VARCHAR(50) DEFAULT 'none'`);
  await pool.query(`ALTER TABLE video_assets ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS default_station_id UUID REFERENCES stations(id) ON DELETE SET NULL`);
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
    
    try {
      const mappingRes = await pool.query(
        `SELECT order_id, marketplace
         FROM marketplace_order_mappings
         WHERE organization_id = $1 AND tracking_id = $2
         LIMIT 1`,
        [user.organization_id, normalizedTrackingId]
      );
      const resolvedOrderId = normalizeIdentifier(orderId) || mappingRes.rows[0]?.order_id || null;
      const resolvedMarketplace = normalizeMarketplace(marketplace) || mappingRes.rows[0]?.marketplace || null;
      let stationDbId: string | null = null;
      if (stationId && UUID_PATTERN.test(stationId)) {
        stationDbId = stationId;
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
      await pool.query(sessionUpsert.text, sessionUpsert.values);

      await pool.query(
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
          retention_until = COALESCE(EXCLUDED.retention_until, video_assets.retention_until)`,
        [
          id, user.organization_id, id,
          'firebase', firebaseStorageBucket || '', storagePath || '', mimeType || 'video/mp4', assetSizeBytes,
          width || 2560, height || 1440, fps || 30,
          durationSeconds * 1000, 'completed', timestampMs
        ]
      );

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
        details: errorMessage,
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
        `SELECT tracking_id, order_id, marketplace, imported_at
         FROM marketplace_order_mappings
         WHERE organization_id = $1 AND tracking_id = $2
         LIMIT 1`,
        [user.organization_id, trackingId]
      );

      return { mapping: res.rows[0] || null };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to resolve order mapping' });
    }
  });

  // Packing-page order context: mapping table first, OMSGuru cache for SKU
  // lines + photos. One call, no per-scan external API.
  protectedRoutes.get<{ Querystring: { trackingId?: string } }>('/api/order-context/resolve', async (req, reply) => {
    const user = (req as any).user;
    const trackingId = normalizeIdentifier(req.query.trackingId);

    if (!trackingId) {
      return reply.status(400).send({ error: 'trackingId is required' });
    }

    try {
      const [mappingRes, cacheRes, settingsRes] = await Promise.all([
        pool.query(
          `SELECT order_id, marketplace
           FROM marketplace_order_mappings
           WHERE organization_id = $1 AND tracking_id = $2
           LIMIT 1`,
          [user.organization_id, trackingId]
        ),
        pool.query(
          `SELECT order_id, marketplace, items, status_id, status, fetched_at
           FROM omsguru_order_cache
           WHERE organization_id = $1 AND tracking_id = $2
             AND fetched_at >= NOW() - INTERVAL '24 hours'
           LIMIT 1`,
          [user.organization_id, trackingId]
        ),
        pool.query(
          `SELECT token, cid, warehouse_id FROM omsguru_settings WHERE organization_id = $1`,
          [user.organization_id]
        ),
      ]);

      const mapping = mappingRes.rows[0] || null;
      let cached = cacheRes.rows[0] || null;

      // Scan-time live fallback: on a stale/missing cache row, ask OMSGuru
      // directly (bounded pages) so the FIRST scan of a parcel resolves in
       // seconds even if the background poll has not reached it yet. Only a
       // completed search is cached as a one-hour negative; rate-limit,
       // deadline, and budget exits are retried on the next scan.
      if (cacheDecision(cached, Date.now()) === 'refresh') {
        try {
          const creds = resolveSyncCreds(settingsRes.rows[0] || null, {
            token: process.env.OMSGURU_TOKEN,
            cid: process.env.OMSGURU_CID,
            warehouseId: process.env.OMSGURU_WAREHOUSE_ID,
          });
          const client = createOMSGuruClient(creds);
          const liveResult = await lookupOrderByTrackerDetailed(
            client,
            parseWarehouseIds(creds.warehouseId),
            trackingId,
            1,
            7,
            10,
            Date.now() + 8000
          );
          if (liveResult.status === 'found' || liveResult.status === 'not_found') {
            const live = liveResult.order;
            await pool.query(
              `INSERT INTO omsguru_order_cache (organization_id, tracking_id, order_id, marketplace, items, status_id, status, fetched_at, status_checked_at)
               VALUES ($1, $2, $3, $4, $5, $6::VARCHAR(20), $7::TEXT, NOW(), CASE WHEN $6 IS NULL AND $7 IS NULL THEN NULL ELSE NOW() END)
               ON CONFLICT (organization_id, tracking_id) DO UPDATE SET
                  order_id = EXCLUDED.order_id, marketplace = EXCLUDED.marketplace,
                  items = EXCLUDED.items, fetched_at = NOW(),
                  status_id = COALESCE(EXCLUDED.status_id, omsguru_order_cache.status_id),
                  status = COALESCE(EXCLUDED.status, omsguru_order_cache.status),
                  status_checked_at = CASE
                    WHEN EXCLUDED.status_id IS NOT NULL OR EXCLUDED.status IS NOT NULL THEN NOW()
                    ELSE omsguru_order_cache.status_checked_at
                  END`,
              [
                user.organization_id,
                trackingId,
                live?.orderId || null,
                live?.marketplace || null,
                JSON.stringify(live?.items || []),
                live?.statusId || null,
                live?.status || null,
              ]
            );
            cached = {
              order_id: live?.orderId || null,
              marketplace: live?.marketplace || null,
              items: live?.items || [],
              status_id: live?.statusId || null,
              status: live?.status || null,
              fetched_at: new Date().toISOString(),
            };
          } else {
            console.warn(`Order lookup ${liveResult.status} for ${trackingId}`, liveResult.error || '');
          }
        } catch (liveErr) {
          // OMSGuru unreachable/unconfigured/throttled: serve mapping/cached
          // data instead of failing the scan.
          console.warn('Order live lookup skipped:', liveErr instanceof Error ? liveErr.message : liveErr);
        }
      }

      // Photo bootstrap: org with zero cached photos gets a background
      // listings sweep on first use (fire-and-forget, guarded per process).
      ensurePhotoBootstrap(pool, user.organization_id, async () =>
        resolveSyncCreds(settingsRes.rows[0] || null, {
          token: process.env.OMSGURU_TOKEN,
          cid: process.env.OMSGURU_CID,
          warehouseId: process.env.OMSGURU_WAREHOUSE_ID,
        })
      );

      const rawItems: CachedOrderItem[] = Array.isArray(cached?.items) ? cached.items : [];
      let items: CachedOrderItem[] = [];
      if (rawItems.length > 0) {
        const skus = [...new Set(rawItems.map((i: any) => String(i?.sku || '')).filter(Boolean))];
        const photoRes = skus.length > 0
          ? await pool.query(
            `SELECT sku, title, image_url FROM omsguru_sku_photos
              WHERE organization_id = $1
                AND REGEXP_REPLACE(UPPER(BTRIM(sku)), '\\s+', ' ', 'g') = ANY($2)
                AND fetched_at >= NOW() - INTERVAL '24 hours'`,
            [user.organization_id, skus.map(normalizeSkuKey)]
          )
          : { rows: [] as any[] };
        const photosBySku = new Map(
          photoRes.rows.map((p: any) => [normalizeSkuKey(p.sku), { sku: p.sku, title: p.title, imageUrl: p.image_url, marketplace: null }])
        );
        items = attachPhotos(
          rawItems.map((i: any) => ({
            sku: String(i?.sku || 'UNKNOWN'),
            title: typeof i?.title === 'string' ? i.title : null,
            quantity: Number.isFinite(Number(i?.quantity)) && Number(i.quantity) > 0 ? Math.floor(Number(i.quantity)) : 1,
             imageUrl: typeof i?.imageUrl === 'string' ? i.imageUrl : null,
             channelOrderId: typeof i?.channelOrderId === 'string' && i.channelOrderId.trim() ? i.channelOrderId.trim() : null,
             subOrderId: typeof i?.subOrderId === 'string' && i.subOrderId.trim() ? i.subOrderId.trim() : null,
          })),
          photosBySku
        );
      }

      const cachedMarketplace = normalizeMarketplace(cached?.marketplace);
      let cachedOrderId = normalizeIdentifier(cached?.order_id);
      // Meesho rename rule: the parcel is identified by the sub-order/item
      // id, not the invoice number. Ajio and others keep invoice identity
      // (Ajio renames come only from the CSV ExtraInfo flow, never here).
      if (usesSubOrderIdentity(cachedMarketplace)) {
        const firstSub = items.map((i) => i.subOrderId).find((s): s is string => Boolean(s));
        if (firstSub) cachedOrderId = firstSub;
      }

      return {
        trackingId,
        orderId: normalizeIdentifier(mapping?.order_id) || cachedOrderId || null,
        marketplace: normalizeMarketplace(mapping?.marketplace) || cachedMarketplace || null,
        statusId: cached?.status_id || null,
        status: cached?.status || null,
        items,
        source: cached ? 'omsguru' : mapping ? 'mapping' : 'none',
      };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Failed to resolve order context' });
    }
  });

  protectedRoutes.post('/api/admin/order-mappings/import', async (req, reply) => {
    const user = (req as any).user;
    let sourceFile = 'manual-import';
    let mimeType = 'application/json';
    let rawImportBuffer: Buffer | null = null;
    let mappings: Array<{ trackingId: string; orderId: string; marketplace: string }> = [];
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
             organization_id, tracking_id, order_id, marketplace, source_file, imported_at
           )
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (organization_id, tracking_id) DO UPDATE SET
             order_id = EXCLUDED.order_id,
             marketplace = EXCLUDED.marketplace,
             source_file = EXCLUDED.source_file,
             imported_at = NOW()`,
          [user.organization_id, mapping.trackingId, mapping.orderId, mapping.marketplace, sourceFile]
        );
      }

      const updateRes = await client.query(
        `UPDATE recording_sessions rs
         SET order_id = mom.order_id,
             marketplace = mom.marketplace,
             order_mapping_imported_at = NOW(),
             updated_at = NOW()
         FROM marketplace_order_mappings mom
         WHERE rs.organization_id = $1
           AND mom.organization_id = rs.organization_id
           AND mom.tracking_id = rs.tracking_id
           AND (
             rs.order_id IS DISTINCT FROM mom.order_id
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

      return {
        imported: mappings.length,
        updatedRecordings: updateRes.rowCount || 0,
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
    try {
      const updateRes = await pool.query(
        `UPDATE recording_sessions rs
         SET order_id = mom.order_id,
             marketplace = mom.marketplace,
             order_mapping_imported_at = NOW(),
             updated_at = NOW()
         FROM marketplace_order_mappings mom
         WHERE rs.organization_id = $1
           AND mom.organization_id = rs.organization_id
           AND mom.tracking_id = rs.tracking_id
           AND (
             rs.order_id IS DISTINCT FROM mom.order_id
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
    const { search, marketplace, limit } = req.query;
    const params: any[] = [user.organization_id];
    let where = 'WHERE organization_id = $1';

    if (search) {
      params.push(`%${search}%`);
      where += ` AND (tracking_id ILIKE $${params.length} OR order_id ILIKE $${params.length})`;
    }

    if (marketplace && marketplace !== 'All Marketplaces') {
      params.push(marketplace);
      where += ` AND LOWER(marketplace) = LOWER($${params.length})`;
    }

    const requestedLimit = limit ? parseInt(limit, 10) : 100;
    params.push(Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100);

    try {
      const [mappingRes, marketplaceRes] = await Promise.all([
        pool.query(
          `SELECT tracking_id, order_id, marketplace, source_file, imported_at
           FROM marketplace_order_mappings
           ${where}
           ORDER BY imported_at DESC
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
    if (!orderId || !marketplace) {
      return reply.status(400).send({ error: 'orderId and marketplace are required' });
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
        JOIN recording_sessions rs ON va.recording_session_id = rs.id
        LEFT JOIN users u ON rs.operator_user_id = u.id
        LEFT JOIN stations s ON rs.station_id = s.id
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
        JOIN recording_sessions rs ON va.recording_session_id = rs.id
        LEFT JOIN users u ON rs.operator_user_id = u.id
        LEFT JOIN stations s ON rs.station_id = s.id
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
      const [photoCountRes, orderCountRes] = await Promise.all([
        pool.query(`SELECT COUNT(*) as count FROM omsguru_sku_photos WHERE organization_id = $1 AND fetched_at >= NOW() - INTERVAL '24 hours'`, [user.organization_id]),
        pool.query(`SELECT COUNT(*) as count FROM omsguru_order_cache WHERE organization_id = $1 AND fetched_at >= NOW() - INTERVAL '24 hours'`, [user.organization_id]),
      ]);
      return {
        configured: Boolean(row.token?.trim() || envConfigured),
        source: row.token?.trim() ? 'settings' : envConfigured ? 'environment' : 'none',
        tokenMasked: maskToken(row.token || ''),
        cid: row.cid || '',
        warehouseId: row.warehouse_id || '',
        updatedAt: row.updated_at || null,
        photosCached: Number(photoCountRes.rows[0]?.count || 0),
        ordersCached24h: Number(orderCountRes.rows[0]?.count || 0),
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
      const message = err instanceof Error ? err.message : 'OMSGuru test failed';
      const status = message.includes('not configured') ? 503 : 502;
      return reply.status(status).send({ ok: false, error: message });
    }
  });

  // Run the OMSGuru sync right now for this org (admin button).
  protectedRoutes.post('/api/admin/omsguru-sync', async (req, reply) => {
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
      const result = await runOMSGuruSync(pool, user.organization_id, creds);
      return { success: true, ...result };
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : 'OMSGuru sync failed';
      const status = message.includes('not configured') ? 503 : 502;
      return reply.status(status).send({ error: message });
    }
  });

  protectedRoutes.get('/api/stats', async (req, reply) => {
    const user = (req as any).user;
    try {
      // Same IST day boundary as the daily email report (server clock may be UTC).
      const { start: today } = getReportDay();
      
      const countRes = await pool.query('SELECT COUNT(*) as count FROM recording_sessions WHERE created_at >= $1 AND organization_id = $2', [today, user.organization_id]);
      const totalRes = await pool.query('SELECT COUNT(*) as count FROM recording_sessions WHERE organization_id = $1', [user.organization_id]);
      const stationsRes = await pool.query('SELECT COUNT(DISTINCT station_id) as count FROM recording_sessions WHERE organization_id = $1', [user.organization_id]);
      const avgRes = await pool.query('SELECT AVG(duration_ms) as avg FROM recording_sessions WHERE organization_id = $1', [user.organization_id]);
      
      const stationAnalyticsRes = await pool.query(`
        SELECT station_id, COUNT(*) as count, AVG(duration_ms) as avg 
        FROM recording_sessions 
        WHERE organization_id = $1 
        GROUP BY station_id
      `, [user.organization_id]);
      const marketplaceAnalyticsRes = await pool.query(`
        SELECT COALESCE(NULLIF(marketplace, ''), 'Unassigned') as marketplace, COUNT(*) as count, AVG(duration_ms) as avg
        FROM recording_sessions
        WHERE organization_id = $1
        GROUP BY COALESCE(NULLIF(marketplace, ''), 'Unassigned')
        ORDER BY count DESC
      `, [user.organization_id]);

      return {
        recordingsToday: parseInt(countRes.rows[0].count),
        videosUploaded: parseInt(totalRes.rows[0].count),
        pendingUploads: 0,
        failedUploads: 0,
        activeStations: parseInt(stationsRes.rows[0].count),
        averageDuration: avgRes.rows[0].avg ? (parseFloat(avgRes.rows[0].avg) / 1000).toFixed(1) : "0",
        stationAnalytics: stationAnalyticsRes.rows.map(row => ({
            station_id: row.station_id || 'UNKNOWN',
            count: parseInt(row.count),
            avg: row.avg ? (parseFloat(row.avg) / 1000).toFixed(1) : "0"
        })),
        marketplaceAnalytics: marketplaceAnalyticsRes.rows.map(row => ({
            marketplace: row.marketplace,
            count: parseInt(row.count),
            avg: row.avg ? (parseFloat(row.avg) / 1000).toFixed(1) : "0"
        }))
      };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Database error' });
    }
  });

  protectedRoutes.put('/api/videos/:id/review', async (req, reply) => {
    const user = (req as any).user;
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
            await file.delete();
          } catch (e) {
            console.warn('Failed to delete from storage:', e);
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
    const { id } = req.params as any;

    if (!UUID_PATTERN.test(id)) {
      return reply.status(400).send({ error: 'Invalid video id' });
    }

    try {
      const videoRes = await pool.query(
        `SELECT va.storage_path, va.mime_type, va.size_bytes, rs.tracking_id, rs.order_id
         FROM video_assets va
         JOIN recording_sessions rs ON va.recording_session_id = rs.id
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

  protectedRoutes.get('/api/videos/report', async (req, reply) => {
    const user = (req as any).user;
    try {
      // Create audit log for export
      await pool.query(`
        INSERT INTO audit_logs (id, organization_id, user_id, action, resource, created_at)
        VALUES (gen_random_uuid(), $1, $2, 'EXPORT', 'VIDEO_REPORT', NOW())
      `, [user.organization_id, user.user_id]);

      const res = await pool.query(`
        SELECT va.*, rs.tracking_id, rs.order_id, rs.marketplace, rs.created_at as timestamp 
        FROM video_assets va
        JOIN recording_sessions rs ON va.recording_session_id = rs.id
        WHERE va.organization_id = $1
        ORDER BY rs.created_at DESC
        LIMIT 10000
      `, [user.organization_id]);
      
      let csv = 'Tracking ID,Order ID,Marketplace,Duration,Timestamp,Status\n';
      res.rows.forEach(row => {
        csv += [
          row.tracking_id,
          row.order_id,
          row.marketplace || 'Unassigned',
          row.duration_ms,
          row.timestamp,
          row.upload_status
        ].map(csvEscape).join(',') + '\n';
      });
      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', 'attachment; filename="vms_report.csv"');
      return csv;
    } catch (err) {
      return reply.status(500).send('Error generating report');
    }
  });

  protectedRoutes.get('/api/admin/overview', async (req, reply) => {
    const user = (req as any).user;
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
    const resolved = resolveUserPassword(requestedPassword);
    if ('error' in resolved) return reply.status(400).send({ error: resolved.error });
    // Privilege guard: managers can only create PACKER accounts (no admins,
    // no managers) — enforced here regardless of what the UI sends.
    const createRole = effectiveCreateRole(user, role);
    try {
      const { getAuth } = require('firebase-admin/auth');
      const userRecord = await getAuth().createUser({
        email,
        emailVerified: true,
        password: resolved.password,
        displayName: name,
        disabled: false,
      });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const userRes = await client.query(
          `INSERT INTO users (firebase_uid, email, name, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id`,
          [userRecord.uid, email, name]
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
         LEFT JOIN organization_members om ON om.user_id = u.id AND om.organization_id = $2
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
      const res = await client.query('SELECT firebase_uid FROM users WHERE id = $1', [id]);
      if (res.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.status(404).send({ error: 'User not found' });
      }
      const firebaseUid = res.rows[0].firebase_uid;
      
      await client.query('DELETE FROM organization_members WHERE user_id = $1 AND organization_id = $2', [id, user.organization_id]);
      await client.query('DELETE FROM users WHERE id = $1', [id]);
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
    try {
      const { getAuth } = require('firebase-admin/auth');
      await getAuth().updateUser(user.uid, { displayName: name });
      await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name, user.user_id]);
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
    return {
      user_id: user.user_id,
      organization_id: user.organization_id,
      role: typeof user.role === 'string' ? user.role.toUpperCase() : user.role,
      station,
    };
  });

  protectedRoutes.get('/api/admin/stations', async (req, reply) => {
    const user = (req as any).user;
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
    try {
      await pool.query(
        `INSERT INTO stations (id, organization_id, code, name, active, created_at) VALUES (gen_random_uuid(), $1, $2, $3, true, NOW())`,
        [user.organization_id, code, name]
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
    try {
      const res = await pool.query(
         `SELECT rs.id, rs.tracking_id, rs.order_id, rs.marketplace, rs.status, rs.duration_ms, rs.created_at, rs.flyer_id,
                u.name as packer_name, u.email as packer_email,
                s.code as station_code,
                va.upload_status, va.review_status
         FROM recording_sessions rs
         LEFT JOIN users u ON rs.operator_user_id = u.id
         LEFT JOIN stations s ON rs.station_id = s.id
         LEFT JOIN video_assets va ON va.recording_session_id = rs.id
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

  protectedRoutes.get('/api/admin/reports', async (req, reply) => {
    const user = (req as any).user;
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
           LEFT JOIN stations s ON rs.station_id = s.id
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
    scheduleAutomaticOMSGuruSync();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

start();
