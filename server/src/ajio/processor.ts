// Ajio WFR job orchestration: mailbox -> parse -> match video -> Drive ->
// reply. Runs from POST /api/jobs/ajio-wfr (daily 1 AM IST via the VPS host cron).
// Transports come from env (mailboxConfigured/driveConfigured); without them
// the job refuses with a clear error instead of half-working.
import type { Pool } from 'pg';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getStorage } from 'firebase-admin/storage';
import { parseCctvMail, allowedMailSenders, parseMailDate } from './parser';
import { sanitizeDriveFilename, buildReplySubject, buildReplyBody, buildReplyHtmlBody } from './template';
import { GmailMailbox, mailboxConfigured, type CctvMail, type CctvMailbox } from './mailbox';
import { GmailApiMailbox, getGmailTokens, gmailOAuthConfigured, isGrantError } from './gmailApi';
import { driveConfigured, createServiceAccountAuth, uploadVideoToDrive } from './drive';

export interface AjioJobOptions {
  dryRun?: boolean;
  limit?: number;
}

export interface AjioJobSummary {
  checked: number;
  skipped: number;
  matched: number;
  uploaded: number;
  replied: number;
  missing: number;
  failed: number;
  errors: string[];
  warnings: string[];
  // True when the OAuth grant died mid-flight and the App Password transport
  // covered this run. Callers alert on it: the fallback only holds while the
  // App Password stays valid, so a human must still reconnect Gmail.
  // Optional so older literal builders keep compiling; absent means false.
  usedFallback?: boolean;
}

export interface VideoCandidate {
  id: string;
  tracking_id: string | null;
  order_id: string | null;
  marketplace: string | null;
  created_at: string | Date | null;
  has_video: boolean;
  storage_path: string | null;
}

// Pick the evidence video: must have an uploaded file; prefer the session
// closest after the mail's packing time, else the newest session. Pure and
// unit-tested — a wrong pick loses a real dispute.
export function pickBestVideo(
  candidates: VideoCandidate[],
  packingTimeMs: number | null
): VideoCandidate | null {
  const withVideo = candidates.filter((c) => c.has_video && c.storage_path);
  if (withVideo.length === 0) return null;
  const anchor = packingTimeMs && Number.isFinite(packingTimeMs) ? packingTimeMs : null;
  // Tier 0: at/after packing time (closest first), or newest when the packing
  // time is unknown. Tier 1: before packing time (most recent first). Tier 2:
  // no usable timestamp at all.
  const rank = (c: VideoCandidate): [number, number] => {
    const created = c.created_at ? new Date(c.created_at).getTime() : NaN;
    if (!Number.isFinite(created)) return [2, 0];
    if (anchor === null) return [0, -created];
    if (created >= anchor) return [0, created - anchor];
    return [1, -created];
  };
  const ranked = withVideo.map((c) => ({ c, rank: rank(c) }));
  ranked.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]);
  return ranked[0]?.c || null;
}

export async function findVideoCandidates(
  pool: Pool,
  organizationId: string,
  keys: { orderId: string | null; shipmentId: string | null; referenceValue: string | null }
): Promise<VideoCandidate[]> {
  const base = [keys.orderId, keys.shipmentId, keys.referenceValue].filter(
    (v): v is string => typeof v === 'string' && v.trim().length > 0
  );
  if (base.length === 0) return [];
  // Case/space-insensitive throughout: packing scans, mail text, and import
  // sheets disagree on both.
  const normalizedBase = base.map((v) => v.trim().toUpperCase());
  // Resolve through the order-import bookkeeping: the mail's Order ID may map
  // to the tracking ID scanned at packing (or vice versa), so a session filed
  // under either identifier still matches.
  const expanded = [...normalizedBase];
  const mapRes = await pool.query(
    `SELECT tracking_id, order_id FROM marketplace_order_mappings
     WHERE organization_id = $1
       AND (UPPER(BTRIM(tracking_id)) = ANY($2) OR UPPER(BTRIM(order_id)) = ANY($2))`,
    [organizationId, normalizedBase]
  );
  for (const row of mapRes.rows as { tracking_id?: unknown; order_id?: unknown }[]) {
    for (const value of [row.tracking_id, row.order_id]) {
      if (typeof value === 'string' && value.trim().length > 0) {
        const norm = value.trim().toUpperCase();
        if (!expanded.includes(norm)) expanded.push(norm);
      }
    }
  }
  const res = await pool.query(
    `SELECT rs.id, rs.tracking_id, rs.order_id, rs.marketplace, rs.created_at,
            (va.id IS NOT NULL) AS has_video, va.storage_path
     FROM recording_sessions rs
     LEFT JOIN video_assets va ON va.recording_session_id = rs.id
     WHERE rs.organization_id = $1
       AND (UPPER(BTRIM(COALESCE(rs.order_id, ''))) = ANY($2)
         OR UPPER(BTRIM(COALESCE(rs.tracking_id, ''))) = ANY($2))
     ORDER BY rs.created_at DESC
     LIMIT 10`,
    [organizationId, expanded]
  );
  return res.rows as VideoCandidate[];
}

function formatPackingTimeText(packingTimeMs: number | null): string | null {
  if (!packingTimeMs || !Number.isFinite(packingTimeMs)) return null;
  const d = new Date(packingTimeMs + 5.5 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} IST`;
}

// Mark-as-read is cosmetic (the ledger, not the Seen flag, dedupes runs), so
// its failure must never fail a row whose reply already went out. Warnings
// surface in the job result without failing it. Exported for unit tests.
export async function safeMarkReplied(
  mailbox: Pick<CctvMailbox, 'markReplied'>,
  mail: Pick<CctvMail, 'uid' | 'subject'>,
  summary: AjioJobSummary
): Promise<void> {
  try {
    await mailbox.markReplied(mail.uid);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (summary.warnings.length < 20) {
      summary.warnings.push(`${mail.subject.slice(0, 60)}: mark-read failed (reply was sent): ${message.slice(0, 160)}`);
    }
  }
}

async function processOrganization(
  pool: Pool,
  organizationId: string,
  opts: Required<AjioJobOptions>,
  mailbox: CctvMailbox,
  allowedSenders: string[],
  drive: { folderId: string; upload: (input: { filePath: string; fileName: string; mimeType: string; fileSizeBytes: number }) => Promise<{ fileId: string; webViewLink: string }> },
  summary: AjioJobSummary
): Promise<void> {
  const mails = await mailbox.listCctvRequests(opts.limit);
  for (const mail of mails) {
    summary.checked += 1;
    try {
      const parsed = parseCctvMail(
        { subject: mail.subject, bodyText: mail.bodyText, from: mail.from },
        { allowedSenders }
      );
      if (parsed.kind === 'skip') {
        summary.skipped += 1;
        continue;
      }
      const req = parsed.request;
      const existing = await pool.query(
        `SELECT id, status, drive_link, drive_file_id FROM ajio_wfr_requests WHERE organization_id = $1 AND incident_id = $2`,
        [organizationId, req.incidentId]
      );
      if (existing.rows[0]?.status === 'done') {
        summary.skipped += 1;
        continue;
      }
      // Requested reflects Ajio's mail date (stable across runs); rows first
      // written before this heal on the next pass via the upsert below.
      const mailDate = parseMailDate(mail.date);
      await pool.query(
        `INSERT INTO ajio_wfr_requests (organization_id, incident_id, order_id, shipment_id, reference_value, packing_time, mail_message_id, requested_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()), 'pending')
         ON CONFLICT (organization_id, incident_id) DO UPDATE SET
           order_id = EXCLUDED.order_id, shipment_id = EXCLUDED.shipment_id,
           reference_value = EXCLUDED.reference_value, packing_time = EXCLUDED.packing_time,
           mail_message_id = EXCLUDED.mail_message_id,
           requested_at = COALESCE($8, ajio_wfr_requests.requested_at),
           status = 'pending', error = NULL`,
        [
          organizationId, req.incidentId, req.orderId, req.shipmentId, req.referenceValue,
          req.packingTimeMs ? new Date(req.packingTimeMs) : null, mail.messageId, mailDate,
        ]
      );

      const candidates = await findVideoCandidates(pool, organizationId, {
        orderId: req.orderId,
        shipmentId: req.shipmentId,
        referenceValue: req.referenceValue,
      });
      const best = pickBestVideo(candidates, req.packingTimeMs);
      if (!best) {
        summary.missing += 1;
        await pool.query(
          `UPDATE ajio_wfr_requests SET status = 'missing', error = 'No uploaded video found for this order' WHERE organization_id = $1 AND incident_id = $2`,
          [organizationId, req.incidentId]
        );
        continue;
      }
      summary.matched += 1;
      if (opts.dryRun) continue;

      const fileName = sanitizeDriveFilename(req.orderId);
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajio-wfr-'));
      const tmpPath = path.join(tmpDir, fileName);
      try {
        // A previous attempt may have uploaded before failing at the send
        // step — reuse its Drive link instead of stacking duplicates.
        const priorLink = typeof existing.rows[0]?.drive_link === 'string' ? existing.rows[0].drive_link : '';
        const priorFile = typeof existing.rows[0]?.drive_file_id === 'string' ? existing.rows[0].drive_file_id : null;
        let fileId: string | null = priorFile;
        let webViewLink = priorLink;
        if (!webViewLink) {
          const bucketName = (process.env.FIREBASE_STORAGE_BUCKET || '').trim();
          if (!bucketName) throw new Error('FIREBASE_STORAGE_BUCKET is not configured');
          if (!best.storage_path) throw new Error('Matched video has no storage file');
          await getStorage().bucket(bucketName).file(best.storage_path).download({ destination: tmpPath });
          const stat = fs.statSync(tmpPath);
          const uploaded = await drive.upload({
            filePath: tmpPath,
            fileName,
            mimeType: 'video/mp4',
            fileSizeBytes: stat.size,
          });
          summary.uploaded += 1;
          fileId = uploaded.fileId;
          webViewLink = uploaded.webViewLink;
        }
        const replyCtx = {
          incidentId: req.incidentId,
          orderId: req.orderId,
          shipmentId: req.shipmentId,
          referenceValue: req.referenceValue,
          packingTimeText: formatPackingTimeText(req.packingTimeMs),
          driveLink: webViewLink,
          fileName,
          senderName: 'Youthnic Packing (VMS)',
        };
        const textBody = buildReplyBody(replyCtx);
        const receipt = await mailbox.replyAll(mail, buildReplySubject(mail.subject), textBody, buildReplyHtmlBody(replyCtx));
        await safeMarkReplied(mailbox, mail, summary);
        summary.replied += 1;
        await pool.query(
          `UPDATE ajio_wfr_requests SET status = 'done', recording_session_id = $3, drive_file_id = $4, drive_link = $5, error = NULL,
             reply_message_id = $6, reply_to = $7, reply_subject = $8, reply_body = $9, replied_at = COALESCE($10, NOW())
           WHERE organization_id = $1 AND incident_id = $2`,
          [
            organizationId, req.incidentId, best.id, fileId, webViewLink,
            receipt?.providerMessageId || null,
            (receipt?.toAddrs || []).join(', ') || null,
            receipt?.subject || buildReplySubject(mail.subject),
            textBody,
            receipt?.sentAt || null,
          ]
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (err) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      if (summary.errors.length < 20) summary.errors.push(`${mail.subject.slice(0, 60)}: ${message.slice(0, 200)}`);
      try {
        const parsed = parseCctvMail(
          { subject: mail.subject, bodyText: mail.bodyText, from: mail.from },
          { allowedSenders }
        );
        const incidentId = parsed.kind === 'wfr' ? parsed.request.incidentId : mail.subject.slice(0, 80);
        await pool.query(
          `INSERT INTO ajio_wfr_requests (organization_id, incident_id, status, error)
           VALUES ($1, $2, 'failed', $3)
           ON CONFLICT (organization_id, incident_id) DO UPDATE SET status = 'failed', error = EXCLUDED.error`,
          [organizationId, incidentId, message.slice(0, 500)]
        );
      } catch {
        // Never let bookkeeping break the loop.
      }
    }
  }
}

// Transport per org: connected Gmail OAuth tokens win (one-click connect on
// the Ajio page, never expires on Internal clients); otherwise the legacy
// App Password transport. Null means this org cannot read mail at all.
async function selectMailbox(
  pool: Pool,
  organizationId: string,
  allowedSenders: string[]
): Promise<CctvMailbox | null> {
  const oauth = gmailOAuthConfigured();
  if (oauth) {
    const tokens = await getGmailTokens(pool, organizationId).catch(() => null);
    if (tokens?.refreshToken) {
      const address = tokens.email || (process.env.AJIO_GMAIL_ADDRESS || '').trim();
      return new GmailApiMailbox({ pool, organizationId, oauth, address, allowedSenders });
    }
  }
  const appPasswordConfig = mailboxConfigured();
  if (appPasswordConfig) return new GmailMailbox(appPasswordConfig);
  return null;
}

export async function runAjioWfrJob(
  pool: Pool,
  organizationId: string | undefined,
  opts: AjioJobOptions = {}
): Promise<AjioJobSummary> {
  const summary: AjioJobSummary = { checked: 0, skipped: 0, matched: 0, uploaded: 0, replied: 0, missing: 0, failed: 0, errors: [], warnings: [], usedFallback: false };
  const full: Required<AjioJobOptions> = { dryRun: opts.dryRun === true, limit: Math.max(1, Math.min(opts.limit || 10, 50)) };
  const driveConfig = driveConfigured();
  if (!driveConfig) {
    throw new Error('Ajio drive is not configured (AJIO_GDRIVE_SA_JSON, AJIO_GDRIVE_FOLDER_ID)');
  }
  const auth = createServiceAccountAuth(driveConfig.serviceAccountJson);
  const drive = {
    folderId: driveConfig.folderId,
    upload: (input: { filePath: string; fileName: string; mimeType: string; fileSizeBytes: number }) =>
      uploadVideoToDrive(auth, driveConfig, input),
  };
  const orgRes = organizationId
    ? { rows: [{ id: organizationId }] }
    : await pool.query(`SELECT id FROM organizations`);
  const allowedSenders = allowedMailSenders();
  for (const org of orgRes.rows) {
    const checkedBefore = summary.checked;
    try {
      const mailbox = await selectMailbox(pool, org.id, allowedSenders);
      if (!mailbox) {
        throw new Error('Ajio Gmail is not connected (connect Gmail on the Ajio page, or set AJIO_GMAIL_ADDRESS + AJIO_GMAIL_APP_PASSWORD)');
      }
      await processOrganization(pool, org.id, full, mailbox, allowedSenders, drive, summary);
    } catch (err) {
      // Dead OAuth grant (the Sep-2026 outage): the primary transport was
      // OAuth, nothing was processed yet, and the App Password transport is
      // configured — cover the run instead of failing it. The warning +
      // usedFallback flag make sure a human still reconnects Gmail.
      const untouched = summary.checked === checkedBefore;
      if (untouched && isGrantError(err)) {
        const tokens = await getGmailTokens(pool, org.id).catch(() => null);
        const appPasswordConfig = mailboxConfigured();
        if (tokens?.refreshToken && appPasswordConfig) {
          const detail = err instanceof Error ? err.message : String(err);
          summary.warnings.push(
            `Gmail OAuth grant rejected (${detail.slice(0, 120)}) — replies for this run went out over the App Password transport. Reconnect Gmail on the Ajio page`
          );
          summary.usedFallback = true;
          await processOrganization(pool, org.id, full, new GmailMailbox(appPasswordConfig), allowedSenders, drive, summary);
          continue;
        }
      }
      throw err;
    }
  }
  return summary;
}

export type { CctvMail };
