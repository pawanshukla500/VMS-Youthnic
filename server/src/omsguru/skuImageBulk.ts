// Bulk SKU photo import and export utilities.
//
// Supports:
// 1. Streaming CSV export of all SKU photo links (100k+ rows with constant memory,
//    deduplicated by sku_key with manual > omsguru > forward-scan priority,
//    and formula-injection sanitized).
// 2. Streaming CSV export of missing SKU photo links (SKUs in orders or catalogue lacking a photo).
// 3. Robust RFC 4180 CSV / Excel (.xlsx) parsing supporting quoted multiline fields.
// 4. Batch import with URL validation, color conflict prevention, atomic marketplace_orders
//    propagation without race conditions, and resilient partial batch handling.

import type { Pool, PoolClient } from 'pg';
import type { FastifyReply } from 'fastify';
import ExcelJS from 'exceljs';
import { normalizeSkuKey } from '../omsguru/mappers';
import { normalizeManualImageUrl } from '../forwardScan/mappers';
import { isColorConflicting } from './colorMatch';

export const SKU_IMAGE_HEADER_ALIASES = {
  sku: new Set([
    'sku',
    'skuname',
    'sku_name',
    'itemsku',
    'item_sku',
    'productsku',
    'product_sku',
    'mastersku',
    'master_sku',
    'channelsku',
    'channel_sku',
  ]),
  imageUrl: new Set([
    'imagelink',
    'image_link',
    'imageurl',
    'image_url',
    'photolink',
    'photo_link',
    'photo',
    'image',
    'url',
    'link',
    'photourl',
    'photo_url',
  ]),
  title: new Set([
    'title',
    'producttitle',
    'product_title',
    'itemtitle',
    'item_title',
    'name',
    'productname',
    'product_name',
    'description',
  ]),
};

export function normalizeHeader(val: string): string {
  return val.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Escapes a value for RFC 4180 CSV compliance and neutralizes formula injection
 * (e.g. leading =, +, -, @, \t, \r which spreadsheet software could execute).
 */
export function escapeCsvField(val: unknown): string {
  if (val === null || val === undefined) return '';
  let str = String(val);

  // CSV Formula Injection mitigation (CWE-1236)
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }

  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Parses full CSV text into a 2D array of string cells according to RFC 4180.
 * Accurately preserves quoted multiline fields containing newlines.
 * Aborts early without materializing excess records if maxRecords is exceeded.
 */
export function parseCsvRecords(csvText: string, maxRecords: number = 50001): string[][] {
  const records: string[][] = [];
  let currentRecord: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    const next = csvText[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        currentCell += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      currentRecord.push(currentCell.trim());
      currentCell = '';
    } else if ((ch === '\r' || ch === '\n') && !inQuotes) {
      if (ch === '\r' && next === '\n') {
        i++; // handle CRLF
      }
      currentRecord.push(currentCell.trim());
      currentCell = '';
      if (currentRecord.some((c) => c.length > 0)) {
        records.push(currentRecord);
        if (records.length > maxRecords) {
          throw new Error(`Upload exceeds maximum allowed limit of ${maxRecords - 1} data rows`);
        }
      }
      currentRecord = [];
    } else {
      currentCell += ch;
    }
  }

  if (currentCell.length > 0 || currentRecord.length > 0) {
    currentRecord.push(currentCell.trim());
    if (currentRecord.some((c) => c.length > 0)) {
      records.push(currentRecord);
      if (records.length > maxRecords) {
        throw new Error(`Upload exceeds maximum allowed limit of ${maxRecords - 1} data rows`);
      }
    }
  }

  return records;
}

export function parseCsvLine(line: string): string[] {
  const records = parseCsvRecords(line);
  return records[0] || [];
}

function findHeaderIndex(headers: string[], aliases: Set<string>): number {
  return headers.findIndex((h) => aliases.has(h));
}

function excelCellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if ('text' in value && value.text !== undefined) return String(value.text);
    if ('result' in value && value.result !== undefined) return String(value.result);
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((item: any) => item.text || '').join('');
    }
    if ((cell as any).text) return (cell as any).text;
  }
  return String(value);
}

export interface SkuImageImportRow {
  sku: string;
  skuKey: string;
  imageUrl: string;
  title: string | null;
}

export interface SkuImageSkippedRow {
  row: number;
  sku?: string;
  reason: string;
}

export interface ParseImportResult {
  validRows: SkuImageImportRow[];
  skipped: SkuImageSkippedRow[];
}

/**
 * Parses raw CSV text or an Excel workbook buffer into sanitized SKU image import rows.
 */
export async function parseSkuImageImport(
  bufferOrText: Buffer | string,
  filename?: string
): Promise<ParseImportResult> {
  const lowerFilename = (filename || '').toLowerCase();
  if (lowerFilename.endsWith('.xls') && !lowerFilename.endsWith('.xlsx')) {
    return {
      validRows: [],
      skipped: [{ row: 0, reason: 'Legacy .xls format is not supported. Please save as .xlsx or .csv.' }],
    };
  }

  const isExcel = Buffer.isBuffer(bufferOrText) && lowerFilename.endsWith('.xlsx');

  if (isExcel) {
    return parseSkuImageWorkbook(bufferOrText as Buffer);
  }

  const text = Buffer.isBuffer(bufferOrText) ? bufferOrText.toString('utf8') : bufferOrText;
  return parseSkuImageCsvText(text);
}

export function parseSkuImageCsvText(csvText: string): ParseImportResult {
  const skipped: SkuImageSkippedRow[] = [];

  const records = parseCsvRecords(csvText);
  if (records.length === 0) {
    return { validRows: [], skipped: [{ row: 0, reason: 'CSV is empty' }] };
  }

  const rawHeaders: string[] = records[0];
  const headers: string[] = rawHeaders.map((h) => normalizeHeader(h));

  const skuIndex = findHeaderIndex(headers, SKU_IMAGE_HEADER_ALIASES.sku);
  const imageIndex = findHeaderIndex(headers, SKU_IMAGE_HEADER_ALIASES.imageUrl);
  const titleIndex = findHeaderIndex(headers, SKU_IMAGE_HEADER_ALIASES.title);

  if (skuIndex === -1 || imageIndex === -1) {
    return {
      validRows: [],
      skipped: [
        {
          row: 1,
          reason: `Required columns missing. Expected at least "SKU" and "Image Link" (found: ${rawHeaders.join(', ') || 'none'}).`,
        },
      ],
    };
  }

  const seenRows = new Map<string, SkuImageImportRow>();

  for (let i = 1; i < records.length; i++) {
    const rowNum = i + 1;
    const cells = records[i];
    const rawSku = cells[skuIndex] || '';
    const rawImage = cells[imageIndex] || '';
    const rawTitle = titleIndex >= 0 ? cells[titleIndex] || '' : '';

    const cleanSku = rawSku.trim().slice(0, 255);
    if (!cleanSku) {
      skipped.push({ row: rowNum, reason: 'Empty SKU' });
      continue;
    }

    const skuKey = normalizeSkuKey(cleanSku);
    if (!skuKey) {
      skipped.push({ row: rowNum, sku: cleanSku, reason: 'Invalid SKU' });
      continue;
    }

    const cleanImage = rawImage.trim();
    if (!cleanImage) {
      skipped.push({ row: rowNum, sku: cleanSku, reason: 'Empty Image Link' });
      continue;
    }

    const normalizedUrl = normalizeManualImageUrl(cleanImage);
    if (!normalizedUrl) {
      skipped.push({
        row: rowNum,
        sku: cleanSku,
        reason: 'Invalid Image Link (must start with http:// or https://)',
      });
      continue;
    }

    const cleanTitle = rawTitle.trim() ? rawTitle.trim().slice(0, 300) : null;

    if (isColorConflicting(cleanSku, cleanTitle, normalizedUrl)) {
      skipped.push({
        row: rowNum,
        sku: cleanSku,
        reason: 'Color conflict: image or title conflicts with SKU color',
      });
      continue;
    }

    // Keep the latest row if duplicate in same upload file
    seenRows.set(skuKey, {
      sku: cleanSku,
      skuKey,
      imageUrl: normalizedUrl,
      title: cleanTitle,
    });
  }

  return { validRows: Array.from(seenRows.values()), skipped };
}

export async function parseSkuImageWorkbook(buffer: Buffer): Promise<ParseImportResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const worksheet = workbook.worksheets[0];

  if (!worksheet) {
    return { validRows: [], skipped: [{ row: 0, reason: 'Workbook has no worksheets' }] };
  }

  if (worksheet.rowCount > 50001) {
    throw new Error('Upload exceeds maximum allowed limit of 50,000 rows');
  }

  const headerRow = worksheet.getRow(1);
  const headers = new Map<number, string>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers.set(colNumber, normalizeHeader(excelCellText(cell)));
  });

  const orderedHeaders = [...headers.entries()];
  const skuColumn = orderedHeaders.find(([, header]) => SKU_IMAGE_HEADER_ALIASES.sku.has(header))?.[0];
  const imageColumn = orderedHeaders.find(([, header]) => SKU_IMAGE_HEADER_ALIASES.imageUrl.has(header))?.[0];
  const titleColumn = orderedHeaders.find(([, header]) => SKU_IMAGE_HEADER_ALIASES.title.has(header))?.[0];

  if (!skuColumn || !imageColumn) {
    return {
      validRows: [],
      skipped: [
        {
          row: 1,
          reason: 'Required columns missing. Expected at least "SKU" and "Image Link".',
        },
      ],
    };
  }

  const skipped: SkuImageSkippedRow[] = [];
  const seenRows = new Map<string, SkuImageImportRow>();

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;

    const rawSku = excelCellText(row.getCell(skuColumn));
    const rawImage = excelCellText(row.getCell(imageColumn));
    const rawTitle = titleColumn ? excelCellText(row.getCell(titleColumn)) : '';

    const cleanSku = rawSku.trim().slice(0, 255);
    if (!cleanSku) {
      skipped.push({ row: rowNumber, reason: 'Empty SKU' });
      return;
    }

    const skuKey = normalizeSkuKey(cleanSku);
    if (!skuKey) {
      skipped.push({ row: rowNumber, sku: cleanSku, reason: 'Invalid SKU' });
      return;
    }

    const cleanImage = rawImage.trim();
    if (!cleanImage) {
      skipped.push({ row: rowNumber, sku: cleanSku, reason: 'Empty Image Link' });
      return;
    }

    const normalizedUrl = normalizeManualImageUrl(cleanImage);
    if (!normalizedUrl) {
      skipped.push({
        row: rowNumber,
        sku: cleanSku,
        reason: 'Invalid Image Link (must start with http:// or https://)',
      });
      return;
    }

    const cleanTitle = rawTitle.trim() ? rawTitle.trim().slice(0, 300) : null;

    if (isColorConflicting(cleanSku, cleanTitle, normalizedUrl)) {
      skipped.push({
        row: rowNumber,
        sku: cleanSku,
        reason: 'Color conflict: image or title conflicts with SKU color',
      });
      return;
    }

    seenRows.set(skuKey, {
      sku: cleanSku,
      skuKey,
      imageUrl: normalizedUrl,
      title: cleanTitle,
    });
  });

  return { validRows: Array.from(seenRows.values()), skipped };
}

export interface ImportBatchResult {
  importedCount: number;
  ordersUpdatedCount: number;
  batchErrors: Array<{ batch: number; error: string }>;
}

/**
 * Upserts imported SKU image links in batches and propagates them to active marketplace_orders.
 * Uses atomic jsonb operations to avoid race conditions with concurrent order syncs.
 */
export async function importSkuImagesInBatches(
  pool: Pool,
  organizationId: string,
  userId: string | null,
  rows: SkuImageImportRow[],
  batchSize = 250
): Promise<ImportBatchResult> {
  let importedCount = 0;
  let ordersUpdatedCount = 0;
  const batchErrors: Array<{ batch: number; error: string }> = [];

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    if (batch.length === 0) continue;
    const batchNumber = Math.floor(i / batchSize) + 1;

    try {
      // 1. Batch upsert into sku_images (source: manual)
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');

        const valueTuples: string[] = [];
        const params: any[] = [organizationId, userId];
        let pIdx = 3;

        for (const row of batch) {
          valueTuples.push(`($1, $${pIdx}, $${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, 'manual', $2, NOW())`);
          params.push(row.sku, row.skuKey, row.title, row.imageUrl);
          pIdx += 4;
        }

        await client.query(
          `INSERT INTO sku_images (organization_id, sku, sku_key, title, image_url, source, updated_by, updated_at)
           VALUES ${valueTuples.join(', ')}
           ON CONFLICT (organization_id, sku_key, source) DO UPDATE SET
             sku = EXCLUDED.sku,
             title = COALESCE(EXCLUDED.title, sku_images.title),
             image_url = EXCLUDED.image_url,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()`,
          params
        );

        await client.query(
          `INSERT INTO audit_logs (id, organization_id, user_id, action, resource, metadata, created_at)
           VALUES (gen_random_uuid(), $1, $2, 'SKU_IMAGE_BULK_IMPORT', 'sku_images', $3::jsonb, NOW())`,
          [
            organizationId,
            userId,
            JSON.stringify({
              count: batch.length,
              batchStart: i + 1,
              batchEnd: i + batch.length,
            }),
          ]
        );

        await client.query('COMMIT');
        importedCount += batch.length;
      } catch (batchErr) {
        await client.query('ROLLBACK');
        throw batchErr;
      } finally {
        client.release();
      }

      // 2. Batch update matching marketplace_orders in a single query
      // Map batch SKUs by normalized skuKey to handle casing and space variations
      const skuMap = new Map<string, string>();
      for (const item of batch) {
        skuMap.set(item.skuKey, item.imageUrl);
      }
      const mappingJson = JSON.stringify(
        Array.from(skuMap.entries()).map(([skuKey, imageUrl]) => ({ skuKey, imageUrl }))
      );

      try {
        const updateRes = await pool.query(
          `UPDATE marketplace_orders o
           SET items = (
             SELECT jsonb_agg(
               CASE
                 WHEN u."imageUrl" IS NOT NULL AND (elem->>'imageUrl' IS DISTINCT FROM u."imageUrl")
                 THEN jsonb_set(elem, '{imageUrl}', to_jsonb(u."imageUrl"::text))
                 ELSE elem
               END
             )
             FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END
             ) elem
             LEFT JOIN jsonb_to_recordset($2::jsonb) AS u("skuKey" text, "imageUrl" text)
               ON UPPER(REGEXP_REPLACE(btrim(elem->>'sku'), '\\s+', ' ', 'g')) = u."skuKey"
           ),
           updated_at = NOW()
           WHERE o.organization_id = $1
             AND COALESCE(o.awb_generated_at, o.created_at) >= NOW() - INTERVAL '14 days'
             AND EXISTS (
               SELECT 1
               FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END
               ) elem
               JOIN jsonb_to_recordset($2::jsonb) AS u("skuKey" text, "imageUrl" text)
                 ON UPPER(REGEXP_REPLACE(btrim(elem->>'sku'), '\\s+', ' ', 'g')) = u."skuKey"
             )`,
          [organizationId, mappingJson]
        );
        ordersUpdatedCount += updateRes.rowCount ?? 0;
      } catch (orderUpdateErr) {
        console.warn(`[sku-images] failed to batch propagate images to marketplace_orders:`, orderUpdateErr);
        batchErrors.push({
          batch: batchNumber,
          error: `Order update failed: ${orderUpdateErr instanceof Error ? orderUpdateErr.message : String(orderUpdateErr)}`,
        });
      }
    } catch (batchErr) {
      console.error(`[sku-images] batch ${batchNumber} failed:`, batchErr);
      batchErrors.push({
        batch: batchNumber,
        error: batchErr instanceof Error ? batchErr.message : String(batchErr),
      });
    }
  }

  return { importedCount, ordersUpdatedCount, batchErrors };
}

/**
 * Helper to write chunks to response stream while respecting backpressure (drain event)
 * and avoiding hung promises if the client disconnects prematurely.
 */
async function writeChunkWithBackpressure(reply: FastifyReply, chunk: string): Promise<boolean> {
  if (reply.raw.destroyed || reply.raw.writableEnded) return false;
  const canContinue = reply.raw.write(chunk);
  if (!canContinue) {
    await new Promise<void>((resolve) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        reply.raw.removeListener('drain', onDrain);
        reply.raw.removeListener('close', onClose);
        reply.raw.removeListener('error', onClose);
      };
      reply.raw.once('drain', onDrain);
      reply.raw.once('close', onClose);
      reply.raw.once('error', onClose);
    });
  }
  return !reply.raw.destroyed && !reply.raw.writableEnded;
}

/**
 * Streams all existing SKU image links as a CSV file to the Fastify reply stream.
 * Deduplicates rows by sku_key prioritizing manual > omsguru > forward-scan,
 * uses keyset pagination to handle 100k+ rows without memory pressure,
 * and respects stream backpressure and client disconnects.
 */
export async function streamAllSkuImagesCsv(
  pool: Pool,
  organizationId: string,
  reply: FastifyReply
): Promise<void> {
  const dateStr = new Date().toISOString().slice(0, 10);
  reply.raw.setHeader('Content-Type', 'text/csv; charset=utf-8');
  reply.raw.setHeader('Content-Disposition', `attachment; filename="sku-photos-all-${dateStr}.csv"`);
  reply.raw.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  // Header row matching user request: SKU, Image Link, Title
  const headerOk = await writeChunkWithBackpressure(reply, 'SKU,Image Link,Title,Source,Marketplace\r\n');
  if (!headerOk) return;

  let lastSkuKey = '';
  const chunkSize = 2000;

  while (true) {
    if (reply.raw.destroyed || reply.raw.writableEnded) break;

    const res = await pool.query(
      `WITH deduped AS (
         SELECT DISTINCT ON (sku_key)
           sku,
           sku_key,
           image_url,
           title,
           source,
           marketplace
         FROM sku_images
         WHERE organization_id = $1
           AND image_url IS NOT NULL
           AND btrim(image_url) <> ''
         ORDER BY
           sku_key ASC,
           CASE source
             WHEN 'manual' THEN 1
             WHEN 'omsguru' THEN 2
             ELSE 3
           END ASC,
           updated_at DESC
       )
       SELECT sku, sku_key, image_url, title, source, marketplace
       FROM deduped
       WHERE sku_key > $2
       ORDER BY sku_key ASC
       LIMIT ${chunkSize}`,
      [organizationId, lastSkuKey]
    );

    if (res.rows.length === 0) break;

    let chunkText = '';
    for (const row of res.rows) {
      chunkText +=
        `${escapeCsvField(row.sku)},` +
        `${escapeCsvField(row.image_url)},` +
        `${escapeCsvField(row.title)},` +
        `${escapeCsvField(row.source)},` +
        `${escapeCsvField(row.marketplace)}\r\n`;
    }

    const chunkOk = await writeChunkWithBackpressure(reply, chunkText);
    if (!chunkOk) break;

    lastSkuKey = res.rows[res.rows.length - 1].sku_key;

    if (res.rows.length < chunkSize) break;
  }

  if (!reply.raw.destroyed && !reply.raw.writableEnded) {
    reply.raw.end();
  }
}

/**
 * Streams all SKUs lacking an image link as a CSV file to the Fastify reply stream.
 * Discovers unmapped SKUs from recent marketplace_orders and catalogue listings
 * using keyset pagination, strict SKU deduplication, and backpressure handling.
 */
export async function streamMissingSkuImagesCsv(
  pool: Pool,
  organizationId: string,
  reply: FastifyReply
): Promise<void> {
  const dateStr = new Date().toISOString().slice(0, 10);
  reply.raw.setHeader('Content-Type', 'text/csv; charset=utf-8');
  reply.raw.setHeader('Content-Disposition', `attachment; filename="sku-photos-missing-${dateStr}.csv"`);
  reply.raw.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  // Header row matching user request: SKU, Image Link, Title
  const headerOk = await writeChunkWithBackpressure(reply, 'SKU,Image Link,Title\r\n');
  if (!headerOk) return;

  let lastSku = '';
  const chunkSize = 2000;

  while (true) {
    if (reply.raw.destroyed || reply.raw.writableEnded) break;

    const res = await pool.query(
      `WITH order_skus AS (
         SELECT DISTINCT ON (UPPER(REGEXP_REPLACE(btrim(elem->>'sku'), '\\s+', ' ', 'g')))
           btrim(elem->>'sku') AS sku,
           UPPER(REGEXP_REPLACE(btrim(elem->>'sku'), '\\s+', ' ', 'g')) AS sku_key,
           btrim(COALESCE(elem->>'title', '')) AS title
         FROM marketplace_orders,
              LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(items) = 'array' THEN items ELSE '[]'::jsonb END) AS elem
         WHERE organization_id = $1
           AND elem->>'sku' IS NOT NULL
           AND btrim(elem->>'sku') <> ''
           AND btrim(elem->>'sku') <> 'UNKNOWN'
         ORDER BY UPPER(REGEXP_REPLACE(btrim(elem->>'sku'), '\\s+', ' ', 'g')), (elem->>'title' IS NOT NULL) DESC
       ),
       listing_skus AS (
         SELECT DISTINCT ON (UPPER(REGEXP_REPLACE(btrim(sku_name), '\\s+', ' ', 'g')))
           btrim(sku_name) AS sku,
           UPPER(REGEXP_REPLACE(btrim(sku_name), '\\s+', ' ', 'g')) AS sku_key,
           btrim(COALESCE(title, '')) AS title
         FROM omsguru_listings
         WHERE organization_id = $1
           AND (image_url IS NULL OR btrim(image_url) = '')
           AND sku_name IS NOT NULL
           AND btrim(sku_name) <> ''
         ORDER BY UPPER(REGEXP_REPLACE(btrim(sku_name), '\\s+', ' ', 'g')), (title IS NOT NULL) DESC
       ),
       all_candidates AS (
         SELECT DISTINCT ON (sku_key) sku, sku_key, title
         FROM (
           SELECT sku, sku_key, title FROM order_skus
           UNION ALL
           SELECT sku, sku_key, title FROM listing_skus
         ) sub
         ORDER BY sku_key, (title <> '') DESC
       ),
       existing_photos AS (
         SELECT sku_key
         FROM sku_images
         WHERE organization_id = $1
           AND image_url IS NOT NULL
           AND btrim(image_url) <> ''
       )
       SELECT c.sku, c.title
       FROM all_candidates c
       WHERE c.sku_key NOT IN (SELECT sku_key FROM existing_photos)
         AND c.sku > $2
       ORDER BY c.sku ASC
       LIMIT ${chunkSize}`,
      [organizationId, lastSku]
    );

    if (res.rows.length === 0) break;

    let chunkText = '';
    for (const row of res.rows) {
      chunkText += `${escapeCsvField(row.sku)},,${escapeCsvField(row.title)}\r\n`;
    }

    const chunkOk = await writeChunkWithBackpressure(reply, chunkText);
    if (!chunkOk) break;

    lastSku = res.rows[res.rows.length - 1].sku;

    if (res.rows.length < chunkSize) break;
  }

  if (!reply.raw.destroyed && !reply.raw.writableEnded) {
    reply.raw.end();
  }
}
