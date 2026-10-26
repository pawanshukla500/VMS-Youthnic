import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';
import {
  escapeCsvField,
  parseCsvLine,
  parseSkuImageCsvText,
  parseSkuImageWorkbook,
  importSkuImagesInBatches,
} from '../omsguru/skuImageBulk';

describe('skuImageBulk CSV helpers', () => {
  it('escapes CSV fields with commas, quotes, and newlines', () => {
    expect(escapeCsvField('simple')).toBe('simple');
    expect(escapeCsvField('hello, world')).toBe('"hello, world"');
    expect(escapeCsvField('hello "world"')).toBe('"hello ""world"""');
    expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  it('parses CSV lines correctly with quotes and delimiters', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(parseCsvLine('"hello, world",b,"c""d"')).toEqual(['hello, world', 'b', 'c"d']);
    expect(parseCsvLine('  spaced , " quoted " ')).toEqual(['spaced', 'quoted']);
  });
});

describe('parseSkuImageCsvText', () => {
  it('parses valid CSV with SKU, Image Link, Title', () => {
    const csv = `SKU,Image Link,Title
BT216-Geomi-Rust_S,https://cdn.example.com/rust.jpg,Geomi Rust Kurta
BT218-Cat-Pink_M,http://cdn.example.com/pink.png,Cat Pink Kurta`;

    const res = parseSkuImageCsvText(csv);
    expect(res.validRows).toHaveLength(2);
    expect(res.skipped).toHaveLength(0);
    expect(res.validRows[0]).toEqual({
      sku: 'BT216-Geomi-Rust_S',
      skuKey: 'BT216-GEOMI-RUST_S',
      imageUrl: 'https://cdn.example.com/rust.jpg',
      title: 'Geomi Rust Kurta',
    });
  });

  it('recognizes header aliases like item_sku, photo_link, product_name', () => {
    const csv = `Item SKU,Photo Link,Product Name
SKD100-Blue_L,https://cdn.example.com/blue.jpg,Blue Suit`;

    const res = parseSkuImageCsvText(csv);
    expect(res.validRows).toHaveLength(1);
    expect(res.validRows[0].sku).toBe('SKD100-Blue_L');
    expect(res.validRows[0].imageUrl).toBe('https://cdn.example.com/blue.jpg');
    expect(res.validRows[0].title).toBe('Blue Suit');
  });

  it('returns skipped error when required headers are missing', () => {
    const csv = `Item Number,Description
12345,Some product`;

    const res = parseSkuImageCsvText(csv);
    expect(res.validRows).toHaveLength(0);
    expect(res.skipped[0].reason).toContain('Required columns missing');
  });

  it('skips invalid URLs, empty SKUs, and color conflicts', () => {
    const csv = `SKU,Image Link,Title
,https://cdn.example.com/x.jpg,Empty SKU
SKU1,,Empty Link
SKU2,ftp://invalid.com/x.jpg,Invalid Protocol
BT216-Geomi-Rust_S,https://cdn.example.com/BT216-Geomi-Navy.jpg,Geomi Navy Kurta`;

    const res = parseSkuImageCsvText(csv);
    expect(res.validRows).toHaveLength(0);
    expect(res.skipped).toHaveLength(4);
    expect(res.skipped[0].reason).toBe('Empty SKU');
    expect(res.skipped[1].reason).toBe('Empty Image Link');
    expect(res.skipped[2].reason).toContain('Invalid Image Link');
    expect(res.skipped[3].reason).toContain('Color conflict');
  });
});

describe('parseSkuImageWorkbook', () => {
  it('parses valid Excel sheet with headers', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('SKU Photos');
    sheet.addRow(['SKU', 'Image Link', 'Title']);
    sheet.addRow(['BT216-Geomi-Rust_S', 'https://cdn.example.com/rust.jpg', 'Geomi Rust Kurta']);

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const res = await parseSkuImageWorkbook(buffer);

    expect(res.validRows).toHaveLength(1);
    expect(res.validRows[0].sku).toBe('BT216-Geomi-Rust_S');
    expect(res.validRows[0].imageUrl).toBe('https://cdn.example.com/rust.jpg');
    expect(res.skipped).toHaveLength(0);
  });
});

describe('importSkuImagesInBatches', () => {
  it('inserts into sku_images and updates matching marketplace_orders', async () => {
    const executedQueries: { sql: string; params?: any[] }[] = [];
    const pool = {
      connect: async () => ({
        query: async (sql: string, params?: any[]) => {
          executedQueries.push({ sql, params });
          return { rows: [], rowCount: 1 };
        },
        release: () => {},
      }),
      query: async (sql: string, params?: any[]) => {
        executedQueries.push({ sql, params });
        if (/FROM marketplace_orders/i.test(sql) && /SELECT/i.test(sql)) {
          return {
            rows: [
              {
                tracking_id: 'TRACK-100',
                items: [{ sku: 'BT216-Geomi-Rust_S', imageUrl: 'https://old.cdn/old.jpg' }],
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
    } as any;

    const rows = [
      {
        sku: 'BT216-Geomi-Rust_S',
        skuKey: 'BT216-GEOMI-RUST_S',
        imageUrl: 'https://cdn.example.com/rust.jpg',
        title: 'Rust Kurta',
      },
    ];

    const result = await importSkuImagesInBatches(pool, 'org-1', 'user-1', rows, 250);
    expect(result.importedCount).toBe(1);
    expect(result.ordersUpdatedCount).toBe(1);

    const insertCall = executedQueries.find((q) => /INSERT INTO sku_images/i.test(q.sql));
    expect(insertCall).toBeDefined();

    const updateCall = executedQueries.find((q) => /UPDATE marketplace_orders/i.test(q.sql));
    expect(updateCall).toBeDefined();
    const updatedItems = JSON.parse(updateCall?.params?.[2]);
    expect(updatedItems[0].imageUrl).toBe('https://cdn.example.com/rust.jpg');
  });
});
