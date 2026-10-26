// Bulk SKU photo import and export utilities.
//
// Supports:
// 1. Streaming CSV export of all SKU photo links (100k+ rows with constant memory).
// 2. Streaming CSV export of missing SKU photo links (SKUs in orders or catalogue lacking a photo).
// 3. Batch import from CSV or Excel (.xlsx) files with column mapping, URL validation,
//    color mismatch prevention, batch upsert into sku_images (source: manual),
//    and immediate batch propagation to recent marketplace_orders.

import type { Pool, PoolClient } from 'pg';
import type { FastifyReply } from 'fastify';
import ExcelJS from 'exceljs';
import { normalizeSkuKey } from '../omsguru/mappers';
import { normalizeManualImageUrl } from '../forwardScan/mappers';
import { isColorConflicting } from './colorMatch';

export function normalizeHeader(val: string): string {
  return val.toLowerCase().replace(/[^a-z0-9]/g, '');
}

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

export function escapeCsvField(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function parseCsvLine(line: string): string[] {
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
  const isExcel = Buffer.isBuffer(bufferOrText) && (lowerFilename.endsWith('.xlsx') || lowerFilename.endsWith('.xls'));

  if (isExcel) {
    return parseSkuImageWorkbook(bufferOrText as Buffer);
  }

  const text = Buffer.isBuffer(bufferOrText) ? bufferOrText.toString('utf8') : bufferOrText;
  return parseSkuImageCsvText(text);
}

export function parseSkuImageCsvText(csvText: string): ParseImportResult {
  const validRows: SkuImageImportRow[] = [];
  const skipped: SkuImageSkippedRow[] = [];

  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return { validRows: [], skipped: [{ row: 0, reason: 'CSV is empty' }] };
  }

  const rawHeaders: string[] = parseCsvLine(lines[0]);
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

  const seenKeys = new Set<string>();
  const parsedRows: SkuImageImportRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const rowNum = i + 1;
    const cells = parseCsvLine(lines[i]);
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

    // Keep newest row if duplicate in same upload file
    if (!seenKeys.has(skuKey)) {
      seenKeys.add(skuKey);
      parsedRows.push({
        sku: cleanSku,
        skuKey,
        imageUrl: normalizedUrl,
        title: cleanTitle,
      });
    }
  }

  return { validRows: parsedRows, skipped };
}

export async function parseSkuImageWorkbook(buffer: Buffer): Promise<ParseImportResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const worksheet = workbook.worksheets[0];

  if (!worksheet) {
    return { validRows: [], skipped: [{ row: 0, reason: 'Workbook has no worksheets' }] };
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

  const validRows: SkuImageImportRow[] = [];
  const skipped: SkuImageSkippedRow[] = [];
  const seenKeys = new Set<string>();

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

    if (!seenKeys.has(skuKey)) {
      seenKeys.add(skuKey);
      validRows.push({
        sku: cleanSku,
        skuKey,
        imageUrl: normalizedUrl,
        title: cleanTitle,
      });
    }
  });

  return { validRows, skipped };
}

export interface ImportBatchResult {
  importedCount: number;
  ordersUpdatedCount: number;
}

/**
 * Upserts imported SKU image links in batches and propagates them to active marketplace_orders.
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

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    if (batch.length === 0) continue;

    // 1. Batch upsert into sku_images (source: manual)
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');

      // Build parameterized bulk values
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

      // Audit log entry for the batch
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

    // 2. Propagate new images to marketplace_orders
    const skuImageMap = new Map<string, string>();
    for (const r of batch) {
      skuImageMap.set(r.skuKey, r.imageUrl);
    }

    const skuKeysList = Array.from(skuImageMap.keys());
    try {
      const ordersRes = await pool.query(
        `SELECT tracking_id, items
         FROM marketplace_orders
         WHERE organization_id = $1
           AND items::text ILIKE ANY($2::text[])`,
        [organizationId, skuKeysList.map((k) => `%${k}%`)]
      );

      for (const order of ordersRes.rows) {
        let items: any[] = [];
        if (Array.isArray(order.items)) {
          items = order.items;
        } else if (typeof order.items === 'string') {
          try {
            items = JSON.parse(order.items);
          } catch {
            items = [];
          }
        }
        let changed = false;

        for (const item of items) {
          if (!item?.sku) continue;
          const k = normalizeSkuKey(item.sku);
          const newUrl = skuImageMap.get(k);
          if (newUrl && item.imageUrl !== newUrl) {
            item.imageUrl = newUrl;
            changed = true;
          }
        }

        if (changed) {
          await pool.query(
            `UPDATE marketplace_orders SET items = $3, updated_at = NOW()
             WHERE organization_id = $1 AND tracking_id = $2`,
            [organizationId, order.tracking_id, JSON.stringify(items)]
          );
          ordersUpdatedCount++;
        }
      }
    } catch (orderUpdateErr) {
      console.warn('[sku-images] batch order propagation error:', orderUpdateErr);
    }
  }

  return { importedCount, ordersUpdatedCount };
}

/**
 * Streams all existing SKU image links as a CSV file to the Fastify reply stream.
 * Uses keyset pagination to handle 100k+ rows without memory pressure.
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
  reply.raw.write('SKU,Image Link,Title,Source,Marketplace\r\n');

  let lastSkuKey = '';
  const chunkSize = 2000;

  while (true) {
    const res = await pool.query(
      `SELECT sku, sku_key, image_url, title, source, marketplace
       FROM sku_images
       WHERE organization_id = $1
         AND sku_key > $2
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

    reply.raw.write(chunkText);
    lastSkuKey = res.rows[res.rows.length - 1].sku_key;

    if (res.rows.length < chunkSize) break;
  }

  reply.raw.end();
}

/**
 * Streams all SKUs lacking an image link as a CSV file to the Fastify reply stream.
 * Discovers unmapped SKUs from recent marketplace_orders and catalogue listings.
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
  reply.raw.write('SKU,Image Link,Title\r\n');

  // Find all distinct SKUs from recent orders and listings that have NO photo in sku_images
  const missingRes = await pool.query(
    `WITH order_skus AS (
       SELECT DISTINCT
         btrim(elem->>'sku') AS sku,
         btrim(COALESCE(elem->>'title', '')) AS title
       FROM marketplace_orders,
            LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(items) = 'array' THEN items ELSE '[]'::jsonb END) AS elem
       WHERE organization_id = $1
         AND elem->>'sku' IS NOT NULL
         AND btrim(elem->>'sku') <> ''
         AND btrim(elem->>'sku') <> 'UNKNOWN'
     ),
     listing_skus AS (
       SELECT DISTINCT
         btrim(sku_name) AS sku,
         btrim(COALESCE(title, '')) AS title
       FROM omsguru_listings
       WHERE organization_id = $1
         AND (image_url IS NULL OR btrim(image_url) = '')
         AND sku_name IS NOT NULL
         AND btrim(sku_name) <> ''
     ),
     all_candidates AS (
       SELECT sku, title FROM order_skus
       UNION
       SELECT sku, title FROM listing_skus
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
     WHERE UPPER(REGEXP_REPLACE(c.sku, '\\s+', ' ', 'g')) NOT IN (SELECT sku_key FROM existing_photos)
     ORDER BY c.sku ASC`,
    [organizationId]
  );

  let chunkText = '';
  for (const row of missingRes.rows) {
    chunkText += `${escapeCsvField(row.sku)},,${escapeCsvField(row.title)}\r\n`;
    if (chunkText.length > 32768) {
      reply.raw.write(chunkText);
      chunkText = '';
    }
  }

  if (chunkText.length > 0) {
    reply.raw.write(chunkText);
  }

  reply.raw.end();
}
