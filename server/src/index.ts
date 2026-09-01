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
import { authMiddleware } from './middleware/auth';
import { buildPostgresPoolConfig } from './db/poolConfig';
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

const server = fastify({ logger: true });

server.register(cors, {
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : true,
});

server.register(helmet);

server.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute'
});

server.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB limit

const pool = new Pool(buildPostgresPoolConfig());

const uploadsDir = process.env.STORAGE_DIR || path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Health checks
server.get('/health/live', async (request, reply) => {
  return { status: 'OK' };
});

server.get('/health/ready', async (request, reply) => {
  try {
    await pool.query('SELECT 1');
    return { status: 'OK', services: { db: 'OK' } };
  } catch (e) {
    return reply.status(503).send({ status: 'UNAVAILABLE', services: { db: 'FAIL' } });
  }
});

const requireAuth = authMiddleware(pool);

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

async function getFirebaseStorageUsage() {
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

async function ensureRuntimeTables() {
  await pool.query(`ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS order_id VARCHAR(255)`);
  await pool.query(`ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS marketplace VARCHAR(100)`);
  await pool.query(`ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS order_mapping_imported_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS data_retention_until TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS default_station_id UUID REFERENCES stations(id) ON DELETE SET NULL`);

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
      orderId?: string;
      marketplace?: string;
    };
    
    if (!body || !body.id) {
      return reply.status(400).send({ error: 'Missing metadata' });
    }
    
    const { 
      id, trackingId, timestamp, duration, stationId, packerId, 
      storagePath, mimeType, width, height, fps, sizeBytes, orderId, marketplace
    } = body;
    const timestampMs = Number(timestamp);
    const durationSeconds = Number(duration);
    const assetSizeBytes = Number(sizeBytes || 0);
    const normalizedTrackingId = normalizeIdentifier(trackingId) || 'UNKNOWN';

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
      
      // Upsert into recording_sessions
      await pool.query(
        `INSERT INTO recording_sessions (
          id, organization_id, tracking_id, station_id, operator_user_id, 
          started_at, ended_at, duration_ms, status, order_id, marketplace, order_mapping_imported_at, created_at, updated_at
        ) 
        VALUES ($1, $2, $3, $4, $5, to_timestamp($10 / 1000.0), to_timestamp($10 / 1000.0) + INTERVAL '1 second', $6, $7, $8, $9, CASE WHEN $8::text IS NULL AND $9::text IS NULL THEN NULL ELSE NOW() END, to_timestamp($10 / 1000.0), NOW())
        ON CONFLICT (id) DO UPDATE SET
          tracking_id = EXCLUDED.tracking_id,
          station_id = EXCLUDED.station_id,
          operator_user_id = EXCLUDED.operator_user_id,
          started_at = COALESCE(EXCLUDED.started_at, recording_sessions.started_at),
          ended_at = COALESCE(EXCLUDED.ended_at, recording_sessions.ended_at),
          duration_ms = EXCLUDED.duration_ms,
          status = EXCLUDED.status,
          order_id = COALESCE(EXCLUDED.order_id, recording_sessions.order_id),
          marketplace = COALESCE(EXCLUDED.marketplace, recording_sessions.marketplace),
          order_mapping_imported_at = COALESCE(EXCLUDED.order_mapping_imported_at, recording_sessions.order_mapping_imported_at),
          updated_at = NOW()`,
        [
          id, user.organization_id, normalizedTrackingId, stationDbId, user.user_id,
          durationSeconds * 1000, 'completed', resolvedOrderId, resolvedMarketplace, timestampMs
        ]
      );

      await pool.query(
        `INSERT INTO video_assets (
          id, organization_id, recording_session_id,
          storage_provider, storage_bucket, storage_path, mime_type, size_bytes, width, height, fps,
          duration_ms, upload_status, uploaded_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, to_timestamp($14 / 1000.0))
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
          uploaded_at = EXCLUDED.uploaded_at`,
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
      return reply.status(500).send({ 
        error: 'Database error', 
        details: errorMessage.includes('null value in column') ? 'Missing required database fields' : errorMessage 
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
        videos: res.rows.map(row => {
          const uploadStatus = row.upload_status === 'completed' ? 'uploaded' : row.upload_status;

          return {
            id: row.id,
            tracking_id: row.tracking_id,
            order_id: row.order_id,
            marketplace: row.marketplace,
            date: new Date(row.timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
            time: new Date(row.timestamp).toLocaleTimeString('en-US', { hour12: true }),
            duration: new Date(row.duration_ms).toISOString().substr(11, 8),
            packer: row.packer_name || row.packer_email || 'Unknown',
            station: row.station_code || row.station_name || 'Unknown',
            status: uploadStatus,
            url: `/videos/${row.id}`,
            storagePath: row.storage_path,
            videoRetentionUntil: row.retention_until,
            dataRetentionUntil: row.data_retention_until,
            reviewStatus: row.review_status || 'none'
          };
        })
      };
    } catch (err) {
      console.error(err);
      return reply.status(500).send({ error: 'Database error' });
    }
  });

  protectedRoutes.get('/api/stats', async (req, reply) => {
    const user = (req as any).user;
    try {
      const today = new Date();
      today.setHours(0,0,0,0);
      
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
    if (user.role !== 'admin') return reply.status(403).send({ error: 'Admin access required' });
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
    if (user.role !== 'admin') return reply.status(403).send({ error: 'Admin access required' });
    const { name, email, role } = req.body as any;
    try {
      const { getAuth } = require('firebase-admin/auth');
      const userRecord = await getAuth().createUser({
        email,
        emailVerified: true,
        password: 'Welcome@123',
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
          [user.organization_id, userRes.rows[0].id, role || 'packer']
        );
        await client.query('COMMIT');
        return { success: true, uid: userRecord.uid, password: 'Welcome@123' };
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
    if (user.role !== 'admin' && user.role !== 'ADMIN') return reply.status(403).send({ error: 'Admin access required' });
    const { id } = req.params as any;
    try {
      const res = await pool.query('SELECT firebase_uid FROM users WHERE id = $1', [id]);
      if (res.rows.length === 0) return reply.status(404).send({ error: 'User not found' });
      const { getAuth } = require('firebase-admin/auth');
      await getAuth().updateUser(res.rows[0].firebase_uid, { password: 'Welcome@123' });
      return { success: true };
    } catch (e) {
      console.error(e);
      return reply.status(500).send({ error: 'Failed to reset password' });
    }
  });

  protectedRoutes.delete('/api/admin/users/:id', async (req, reply) => {
    const user = (req as any).user;
    if (user.role !== 'admin' && user.role !== 'ADMIN') return reply.status(403).send({ error: 'Admin access required' });
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
    if (user.role !== 'admin') return reply.status(403).send({ error: 'Admin access required' });
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
    if (user.role !== 'admin') return reply.status(403).send({ error: 'Admin access required' });
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
    if (user.role !== 'admin') return reply.status(403).send({ error: 'Admin access required' });
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
        `SELECT rs.id, rs.tracking_id, rs.order_id, rs.marketplace, rs.status, rs.duration_ms, rs.created_at,
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
    if (!user.role || user.role.toLowerCase() !== 'admin') return reply.status(403).send({ error: 'Admin access required' });

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
    await ensureRuntimeTables();
    await repairExistingVideoAssets();
    await server.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

start();
