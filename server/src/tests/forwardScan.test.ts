import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  dedupeByTracking,
  forwardScanTimeToIso,
  isMeeshoText,
  mapForwardScanOrder,
  mapForwardScanPhoto,
  marketplaceFromChannelLabel,
  mergeItemImages,
  normalizeForwardScanTracking,
  normalizeManualImageUrl,
  isLookupTracking,
  isExcludedMarketplace,
  parseExcludedMarketplaces,
  orderIdentity,
  recordingOrderId,
  toForwardScanTime,
  trackingCandidates,
} from '../forwardScan/mappers';
import { describeForwardScanSource, openForwardScanSource, parseForwardScanUrl } from '../forwardScan/source';
import {
  copyOneForwardScanOrder,
  lookupForwardScanOrderDates,
  parseOrganizationIds,
  pickTargetOrganizations,
  retentionDaysFrom,
  runForwardScanSync,
  photoReadStart,
  selectChangedOrders,
  syncIntervalSecondsFrom,
} from '../forwardScan/sync';

const ORG = '11111111-1111-4111-8111-111111111111';

const meeshoRow = {
  source_row_id: 7,
  tracking_norm: 'VL0085600380655',
  tracking_raw: 'VL0085600380655',
  channel_label: 'Tulip Prints - Meesho',
  channel_id: 17970,
  company: 'Tulip Prints',
  channel_marketplace: 'Meesho',
  channel_name: 'Tulip Prints - Meesho',
  channel_order_id: '337427494817171264',
  sub_order_ids: '337427494817171264_1',
  invoice_id: 'yqcue2744828',
  items_json: '[{"sku": "B110-Lavanya-Mehendi_XL", "qty": 1, "sub_order_id": "337427494817171264_1", "status": "Ready to ship", "amount": 316.0}]',
  item_count: 1,
  total_qty: 1,
  status_text: 'Ready to ship',
  status_group: 'OPEN',
  shipping_company: 'Valmo',
  order_type: 'PREPAID',
  order_date: '2026-10-05 04:00:00.000000',
  awb_generated_at: '2026-10-05 05:36:10.000000',
  invoice_date: '2026-10-05 05:36:10.000000',
  sla_date: null,
  synced_at: '2026-10-05 08:54:05.603022',
  first_seen_at: '2026-10-05 08:54:05.603022',
};

const flipkartRow = {
  ...meeshoRow,
  source_row_id: 8,
  tracking_norm: 'FMPC6554585455',
  tracking_raw: 'FMPC6554585455',
  channel_label: 'ETHNIC JUNCTION - Flipkart',
  channel_id: 17040,
  company: 'ETHNIC JUNCTION',
  channel_marketplace: 'Flipkart',
  channel_name: 'ETHNIC JUNCTION - Flipkart',
  channel_order_id: 'OD338778483273869100',
  sub_order_ids: '338778483273869100',
  invoice_id: 'NUAD9YB270001845',
  items_json: '[{"sku": "SKD102-Tulsi-Grey_M", "qty": 2, "sub_order_id": "338778483273869100", "status": "Ready to ship"}]',
  total_qty: 2,
};

describe('Forward Scan mappers', () => {
  it('normalizes AWBs exactly like Forward Scan tracking_norm', () => {
    expect(normalizeForwardScanTracking('MYEP1135031932 ( EK_E2E )')).toBe('MYEP1135031932');
    expect(normalizeForwardScanTracking(' fmpc 6554585455 ')).toBe('FMPC6554585455');
    expect(normalizeForwardScanTracking('--AB/12_')).toBe('AB/12');
    expect(normalizeForwardScanTracking(null)).toBe('');
  });

  it('names marketplaces the VMS way and spots Meesho', () => {
    expect(marketplaceFromChannelLabel('Tulip Prints - Meesho')).toBe('Meesho');
    expect(marketplaceFromChannelLabel('VB EXPORT - Myntra PPMP')).toBe('Myntra PPMP');
    expect(marketplaceFromChannelLabel('Shopify')).toBe('Shopify');
    expect(isMeeshoText('MEESHO')).toBe(true);
    expect(isMeeshoText('Flipkart')).toBe(false);
  });

  it('reads Forward Scan naive-UTC timestamps', () => {
    expect(forwardScanTimeToIso('2026-10-03 05:36:10.000000')).toBe('2026-10-03T05:36:10.000Z');
    expect(forwardScanTimeToIso('2026-10-03T05:36:10+0530')).toBe('2026-10-03T00:06:10.000Z');
    expect(forwardScanTimeToIso('not a date')).toBeNull();
    expect(toForwardScanTime(new Date('2026-10-03T05:36:10.123Z'))).toBe('2026-10-03 05:36:10');
  });

  it('maps a Meesho row with sub-order identity and no buyer data', () => {
    const record = mapForwardScanOrder({ ...meeshoRow, buyer_name: 'Secret Person' } as any)!;
    expect(record.tracking_id).toBe('VL0085600380655');
    expect(record.marketplace).toBe('Meesho');
    expect(record.is_meesho).toBe(true);
    expect(record.order_id).toBe('337427494817171264_1');
    expect(record.items).toEqual([{
      sku: 'B110-Lavanya-Mehendi_XL',
      title: null,
      quantity: 1,
      imageUrl: null,
      channelOrderId: '337427494817171264',
      subOrderId: '337427494817171264_1',
      status: 'Ready to ship',
    }]);
    expect(record.awb_generated_at).toBe('2026-10-05T05:36:10.000Z');
    expect(JSON.stringify(record)).not.toContain('Secret Person');
  });

  it('keeps channel order identity for other marketplaces and never renames Ajio recordings', () => {
    const record = mapForwardScanOrder(flipkartRow)!;
    expect(record.is_meesho).toBe(false);
    expect(record.marketplace).toBe('Flipkart');
    expect(record.order_id).toBe('OD338778483273869100');
    expect(recordingOrderId(record)).toBe('OD338778483273869100');
    expect(recordingOrderId({ order_id: '1248722659', marketplace: 'Ajio B2C Dropship' })).toBeNull();
    expect(orderIdentity({ is_meesho: true, items: [], sub_order_ids: 'A_1,B_2', channel_order_id: 'A', invoice_id: null })).toBe('A_1');
  });

  it('drops rows without an AWB and hashes content deterministically', () => {
    expect(mapForwardScanOrder({ ...meeshoRow, tracking_norm: '', tracking_raw: '' })).toBeNull();
    const a = mapForwardScanOrder(meeshoRow)!;
    const b = mapForwardScanOrder({ ...meeshoRow, synced_at: '2026-10-06 01:00:00.000000' })!;
    const c = mapForwardScanOrder({ ...meeshoRow, status_text: 'Shipped', status_group: 'SHIPPED' })!;
    expect(a.source_hash).toBe(b.source_hash);
    expect(a.source_hash).not.toBe(c.source_hash);
  });

  it('dedupes an AWB to the newest source row', () => {
    const older = mapForwardScanOrder({ ...meeshoRow, source_row_id: 1, status_text: 'Packed' })!;
    const newer = mapForwardScanOrder({ ...meeshoRow, source_row_id: 9 })!;
    expect(dedupeByTracking([newer, older])).toEqual([newer]);
  });

  it('prefers manual photo links, then line images, then the catalogue', () => {
    const items = [
      { sku: 'sku-a', quantity: 1, imageUrl: 'https://line/a.jpg' },
      { sku: 'SKU-B', quantity: 2, imageUrl: null },
      { sku: 'SKU-C', quantity: 1 },
    ];
    const merged = mergeItemImages(items, [
      { sku_key: 'SKU-A', title: null, image_url: 'https://manual/a.jpg', source: 'manual' },
      { sku_key: 'SKU-B', title: 'Kurti B', image_url: 'https://old/b.jpg', source: 'omsguru' },
      { sku_key: 'SKU-B', title: 'Kurti B', image_url: 'https://fs/b.jpg', source: 'forward-scan' },
    ]);
    expect(merged.map((i) => i.imageUrl)).toEqual(['https://manual/a.jpg', 'https://fs/b.jpg', null]);
    expect(merged[1]).toMatchObject({ title: 'Kurti B', quantity: 2 });
  });

  it('rejects automated photos that conflict with the SKU color', () => {
    const items = [
      { sku: 'BT216-Geomi-Rust_S', quantity: 1, imageUrl: 'https://cdn/BT216-Geomi-Navy.jpg' },
      { sku: 'BT216-Geomi-Navy_M', quantity: 1, imageUrl: null },
    ];
    const merged = mergeItemImages(items, [
      { sku_key: 'BT216-GEOMI-RUST_S', title: 'Geomi Rust Kurta', image_url: 'https://cdn/BT216-Geomi-Navy.jpg', source: 'omsguru' },
      { sku_key: 'BT216-GEOMI-NAVY_M', title: 'Geomi Navy Kurta', image_url: 'https://cdn/BT216-Geomi-Navy.jpg', source: 'omsguru' },
    ]);
    expect(merged[0].imageUrl).toBeNull();
    expect(merged[1].imageUrl).toBe('https://cdn/BT216-Geomi-Navy.jpg');
  });

  it('accepts only http(s) manual image links', () => {
    expect(normalizeManualImageUrl('http://cdn.example/x.jpg')).toBe('https://cdn.example/x.jpg');
    expect(normalizeManualImageUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeManualImageUrl('data:image/png;base64,AAA')).toBeNull();
    expect(normalizeManualImageUrl('')).toBeNull();
  });

  it('maps catalogue photos with a normalized key', () => {
    expect(mapForwardScanPhoto({ sku: ' a1-1001 ', image_url: '//img/x.jpg', marketplace: 'Meesho', updated_at: '2026-10-03 15:16:09.561530' }))
      .toEqual({ sku: 'a1-1001', sku_key: 'A1-1001', title: null, image_url: 'https://img/x.jpg', marketplace: 'Meesho', source_updated_at: '2026-10-03T15:16:09.561Z' });
    expect(mapForwardScanPhoto({ sku: 'X', image_url: '' })).toBeNull();
  });

  it('caps junk input before the suffix regex runs', () => {
    const junk = '('.repeat(200_000);
    const started = Date.now();
    expect(normalizeForwardScanTracking(junk)).toBe('');
    expect(trackingCandidates(junk).every((c) => c.length <= 128)).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
    expect(isLookupTracking('VL0085600380655')).toBe(true);
    expect(isLookupTracking('x'.repeat(129))).toBe(false);
    expect(isLookupTracking('  ')).toBe(false);
  });

  it('builds unique lookup candidates for a scan', () => {
    expect(trackingCandidates('fmpc6554585455', ['FMPC6554585455'])).toEqual(['fmpc6554585455', 'FMPC6554585455']);
  });
});

describe('Forward Scan config', () => {
  it('parses Forward Scan DATABASE_URL forms', () => {
    expect(parseForwardScanUrl('sqlite:////forward-scan-data/omsguru_forward_scan.db')).toEqual({ kind: 'sqlite', target: '/forward-scan-data/omsguru_forward_scan.db' });
    expect(parseForwardScanUrl('sqlite:///data/omsguru_forward_scan.db')).toEqual({ kind: 'sqlite', target: './data/omsguru_forward_scan.db' });
    expect(parseForwardScanUrl('postgresql://u:p@db:5432/fs')).toEqual({ kind: 'postgres', target: 'postgresql://u:p@db:5432/fs' });
    expect(parseForwardScanUrl('')).toBeNull();
    expect(parseForwardScanUrl('mysql://x')).toBeNull();
  });

  it('never prints database passwords', () => {
    expect(describeForwardScanSource(parseForwardScanUrl('postgresql://u:secret@db:5432/fs'))).toBe('postgres db:5432/fs');
    expect(describeForwardScanSource(null)).toBe('not configured');
  });

  it('clamps retention, interval and org pinning', () => {
    expect(retentionDaysFrom(undefined)).toBe(3);
    expect(retentionDaysFrom('0')).toBe(3);
    expect(retentionDaysFrom('90')).toBe(30);
    expect(syncIntervalSecondsFrom('5')).toBe(30);
    expect(syncIntervalSecondsFrom(undefined)).toBe(300);
    expect(syncIntervalSecondsFrom('')).toBe(300);
    expect(parseOrganizationIds(`${ORG}, nope`)).toEqual([ORG]);
  });

  it("never fans one business's orders out to other tenants", () => {
    const OTHER = '22222222-2222-4222-8222-222222222222';
    expect(pickTargetOrganizations([ORG], '')).toEqual({ ids: [ORG], reason: null });
    const several = pickTargetOrganizations([ORG, OTHER], '');
    expect(several.ids).toEqual([]);
    expect(several.reason).toMatch(/FORWARD_SCAN_ORG_IDS/);
    expect(pickTargetOrganizations([ORG, OTHER], OTHER)).toEqual({ ids: [OTHER], reason: null });
    // Pinned but inactive / unknown org: nobody.
    expect(pickTargetOrganizations([ORG], OTHER).ids).toEqual([]);
  });
});

describe('marketplace exclusion', () => {
  it('copies all marketplaces by default (empty exclusion list)', () => {
    const excluded = parseExcludedMarketplaces(undefined);
    expect(excluded).toEqual([]);
    expect(isExcludedMarketplace({ marketplace: 'Flipkart', channel_marketplace: 'Flipkart' }, excluded)).toBe(false);
    expect(isExcludedMarketplace({ marketplace: 'Myntra Youthnic', channel_marketplace: 'Myntra PPMP' }, excluded)).toBe(false);
    expect(isExcludedMarketplace({ marketplace: 'Myntra PPMP HN', channel_marketplace: 'Myntra PPMP' }, excluded)).toBe(false);
    expect(isExcludedMarketplace({ marketplace: 'Meesho', channel_marketplace: 'Meesho' }, excluded)).toBe(false);
    expect(isExcludedMarketplace({ marketplace: 'Ajio B2C Dropship', channel_marketplace: 'Ajio Api' }, excluded)).toBe(false);
  });

  it('can be customised or switched off', () => {
    expect(parseExcludedMarketplaces('none')).toEqual([]);
    expect(parseExcludedMarketplaces('  ')).toEqual([]);
    expect(parseExcludedMarketplaces('Flipkart, Myntra Youthnic, Myntra PPMP')).toEqual(['flipkart', 'myntra youthnic', 'myntra ppmp']);
    expect(parseExcludedMarketplaces('Amazon Flex, Shopify')).toEqual(['amazon flex', 'shopify']);
  });
});

describe('photoReadStart', () => {
  it('re-reads five minutes behind the saved cursor', () => {
    expect(photoReadStart({ updatedAt: '2026-10-03 15:16:09.561530', sku: 'X' })).toEqual({ updatedAt: '2026-10-03 15:11:09', sku: '' });
    expect(photoReadStart({ updatedAt: null, sku: null })).toEqual({ updatedAt: null, sku: null });
  });
});

describe('selectChangedOrders', () => {
  it('writes new and changed rows, skips unchanged and manual ones', () => {
    const a = mapForwardScanOrder(meeshoRow)!;
    const b = mapForwardScanOrder(flipkartRow)!;
    const c = mapForwardScanOrder({ ...flipkartRow, tracking_norm: 'NEW1', tracking_raw: 'NEW1' })!;
    const existing = new Map([
      [a.tracking_id, { source_hash: a.source_hash, source: 'forward-scan', manual_override: false }],
      [b.tracking_id, { source_hash: b.source_hash, source: 'forward-scan', manual_override: true }],
    ]);
    const { changed, skippedManual } = selectChangedOrders([a, b, c], existing);
    expect(changed.map((r) => r.tracking_id)).toEqual(['NEW1']);
    expect(skippedManual).toBe(1);
  });
});

// --- Real SQLite file shaped like Forward Scan's schema --------------------

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function forwardScanDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-copy-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'omsguru_forward_scan.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE channels (id INTEGER PRIMARY KEY, name VARCHAR(200), marketplace VARCHAR(120));
    CREATE TABLE oms_orders (
      id INTEGER PRIMARY KEY, oms_key VARCHAR(300), channel_label VARCHAR(200), channel_id INTEGER, company VARCHAR(120),
      warehouse VARCHAR(64), channel_order_id VARCHAR(120), sub_order_ids TEXT, invoice_id VARCHAR(120),
      invoice_date DATETIME, order_date DATETIME, sla_date DATETIME, shipment_date DATETIME,
      tracking_raw VARCHAR(120), tracking_norm VARCHAR(120), shipping_company VARCHAR(120), order_type VARCHAR(40),
      buyer_name VARCHAR(200), buyer_city VARCHAR(120), item_count INTEGER, total_qty INTEGER, items_json TEXT,
      status_text VARCHAR(200), status_group VARCHAR(20), source VARCHAR(20), first_seen_at DATETIME, synced_at DATETIME,
      awb_generated_at DATETIME
    );
    CREATE TABLE sku_photos (sku VARCHAR(120) PRIMARY KEY, title VARCHAR(300), image_url TEXT, marketplace VARCHAR(120), updated_at DATETIME);
  `);
  db.prepare(`INSERT INTO channels VALUES (17970, 'Tulip Prints - Meesho', 'Meesho'), (17040, 'ETHNIC JUNCTION - Flipkart', 'Flipkart')`).run();
  const insert = db.prepare(`INSERT INTO oms_orders (id, channel_label, channel_id, company, channel_order_id, sub_order_ids, invoice_id,
      tracking_raw, tracking_norm, buyer_name, item_count, total_qty, items_json, status_text, status_group, first_seen_at, synced_at, awb_generated_at)
    VALUES (@id, @channel_label, @channel_id, @company, @channel_order_id, @sub_order_ids, @invoice_id,
      @tracking_raw, @tracking_norm, 'Buyer Name', 1, 1, @items_json, @status_text, @status_group, @at, @at, @at)`);
  insert.run({ ...meeshoRow, id: 1, at: '2026-10-05 05:36:10.000000' });
  insert.run({ ...flipkartRow, id: 2, at: '2026-10-05 06:00:00.000000' });
  // Outside the 3-day window: never copied.
  insert.run({ ...flipkartRow, id: 3, tracking_norm: 'OLD1', tracking_raw: 'OLD1', at: '2026-09-20 06:00:00.000000' });
  db.prepare(`INSERT INTO sku_photos VALUES ('B110-LAVANYA-MEHENDI_XL', 'Lavanya kurti', 'https://cdn/meesho.jpg', 'Meesho', '2026-10-03 15:16:09.561530')`).run();
  db.prepare(`INSERT INTO sku_photos VALUES ('SKD102-TULSI-GREY_M', 'Tulsi', 'http://cdn/fk.jpg', 'Flipkart', '2026-10-03 15:16:09.561530')`).run();
  db.close();
  return file;
}

function fakePool() {
  const queries: Array<{ text: string; params: any[] }> = [];
  const state: Record<string, any> = {};
  const orders = new Map<string, any>();
  const photos: any[] = [];
  return {
    queries,
    state,
    orders,
    photos,
    async query(text: string, params: any[] = []) {
      queries.push({ text, params });
      if (text.includes('INSERT INTO marketplace_orders')) {
        const rows = JSON.parse(params[1]);
        let rowCount = 0;
        for (const row of rows) {
          const current = orders.get(row.tracking_id);
          if (current && (current.source !== 'forward-scan' || current.manual_override)) continue;
          orders.set(row.tracking_id, { ...row, source: 'forward-scan', manual_override: false });
          rowCount += 1;
        }
        return { rows: [], rowCount };
      }
      if (text.includes('SELECT tracking_id, source_hash, source, manual_override FROM marketplace_orders')) {
        return { rows: [...orders.values()], rowCount: orders.size };
      }
      if (text.includes('INSERT INTO sku_images')) {
        // Mirrors the upsert's "only changed rows" WHERE clause.
        let rowCount = 0;
        for (const row of JSON.parse(params[1])) {
          const index = photos.findIndex((p) => p.sku_key === row.sku_key);
          if (index >= 0 && photos[index].image_url === row.image_url && photos[index].sku === row.sku) continue;
          if (index >= 0) photos[index] = row; else photos.push(row);
          rowCount += 1;
        }
        return { rows: [], rowCount };
      }
      if (text.includes('FROM forward_scan_sync_state')) {
        return { rows: state.cursor ? [state.cursor] : [] };
      }
      if (text.includes('INSERT INTO forward_scan_sync_state')) {
        state.lastOk = params[3];
        state.lastError = params[4];
        if (params[1]) state.cursor = { photo_cursor_at: params[1], photo_cursor_sku: params[2] };
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('DELETE FROM marketplace_orders')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

describe('runForwardScanSync against a Forward Scan SQLite file', () => {
  const now = new Date('2026-10-06T12:00:00Z');

  it('copies the 3-day window marketplace-wise and resumes photos from the cursor', async () => {
    const file = forwardScanDb();
    const config = parseForwardScanUrl(`sqlite:///${file.replace(/\\/g, '/')}`)!;
    const pool = fakePool();
    const open = () => openForwardScanSource(config);

    const first = await runForwardScanSync(pool as any, open, { organizationIds: [ORG], retentionDays: 3, sourceLabel: 'test', now });
    expect(first.ok).toBe(true);
    expect(first.ordersRead).toBe(2);
    expect(first.results[0]).toMatchObject({ ordersWritten: 2, photosWritten: 2 });
    expect(pool.orders.get('VL0085600380655')).toMatchObject({ marketplace: 'Meesho', is_meesho: true, order_id: '337427494817171264_1' });
    expect(pool.orders.get('FMPC6554585455')).toMatchObject({ marketplace: 'Flipkart', is_meesho: false });
    expect(pool.orders.has('OLD1')).toBe(false);
    expect(JSON.stringify([...pool.orders.values()])).not.toContain('Buyer Name');
    expect(pool.photos.find((p) => p.sku_key === 'SKD102-TULSI-GREY_M')?.image_url).toBe('https://cdn/fk.jpg');
    expect(pool.state.cursor.photo_cursor_at).toBe('2026-10-03 15:16:09.561530');

    // Nothing changed: no order or photo writes on the next run.
    const second = await runForwardScanSync(pool as any, open, { organizationIds: [ORG], retentionDays: 3, sourceLabel: 'test', now });
    expect(second.results[0]).toMatchObject({ ordersWritten: 0, photosWritten: 0 });
  });

  it('never copies excluded marketplaces and purges their old rows when exclusions are configured', async () => {
    const file = forwardScanDb();
    const config = parseForwardScanUrl(`sqlite:///${file.replace(/\\/g, '/')}`)!;
    const pool = fakePool();
    const result = await runForwardScanSync(pool as any, () => openForwardScanSource(config), {
      organizationIds: [ORG], retentionDays: 3, sourceLabel: 'test', now, excludedMarketplaces: parseExcludedMarketplaces('Flipkart, Myntra Youthnic, Myntra PPMP'),
    });
    expect(result.ok).toBe(true);
    expect(result.ordersRead).toBe(1);
    expect(pool.orders.has('VL0085600380655')).toBe(true);
    expect(pool.orders.has('FMPC6554585455')).toBe(false);
    const purge = pool.queries.find((q) => q.text.includes("source = 'forward-scan' AND manual_override = FALSE"));
    expect(purge?.params[1]).toEqual(['flipkart', 'myntra youthnic', 'myntra ppmp']);
    expect(await copyOneForwardScanOrder(pool as any, ORG, () => openForwardScanSource(config), ['FMPC6554585455'], ['flipkart'])).toBeNull();
  });

  it('finds order dates for uploaded AWBs straight from Forward Scan', async () => {
    const file = forwardScanDb();
    const config = parseForwardScanUrl(`sqlite:///${file.replace(/\\/g, '/')}`)!;
    const dates = await lookupForwardScanOrderDates(() => openForwardScanSource(config), ['VL0085600380655', 'OLD1', 'MISSING']);
    expect(dates.get('VL0085600380655')?.orderDate).toBe('2026-10-05T05:36:10.000Z');
    expect(dates.get('OLD1')?.orderDate).toBe('2026-09-20T06:00:00.000Z');
    expect(dates.has('MISSING')).toBe(false);
  });

  it('copies one missed AWB on demand', async () => {
    const file = forwardScanDb();
    const config = parseForwardScanUrl(`sqlite:///${file.replace(/\\/g, '/')}`)!;
    const pool = fakePool();
    const record = await copyOneForwardScanOrder(pool as any, ORG, () => openForwardScanSource(config), ['FMPC6554585455']);
    expect(record).toMatchObject({ tracking_id: 'FMPC6554585455', marketplace: 'Flipkart' });
    expect(pool.orders.has('FMPC6554585455')).toBe(true);
    expect(await copyOneForwardScanOrder(pool as any, ORG, () => openForwardScanSource(config), ['NOPE'])).toBeNull();
  });

  it('records a failure and keeps existing rows when the database is missing', async () => {
    const pool = fakePool();
    const config = parseForwardScanUrl('sqlite:////definitely/missing/forward_scan.db')!;
    const result = await runForwardScanSync(pool as any, () => openForwardScanSource(config), { organizationIds: [ORG], retentionDays: 3, sourceLabel: 'test', now });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(pool.state.lastOk).toBe(false);
    expect(pool.queries.some((q) => q.text.includes('DELETE FROM marketplace_orders'))).toBe(false);
  });
});
