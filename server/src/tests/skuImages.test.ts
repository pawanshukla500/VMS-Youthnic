import { describe, it, expect } from 'vitest';
import {
  budgetWaitMs,
  clampInt,
  currentNightlyWindowStart,
  listingMatchKey,
  mapListingRow,
  minCallIntervalMs,
  nextListingCursor,
  nextNightlyRunAt,
  orderChannelsForSync,
  planChannelPass,
  safeText,
  skuStyleKey,
} from '../omsguru/skuImages';
import {
  isAuthFailure,
  runSkuImageSync,
  ListingClient,
  REBUILD_SKU_IMAGES_SQL,
  PURGE_ORPHAN_SKU_IMAGES_SQL,
  auditAndReconcileSkuImages,
} from '../omsguru/skuImageSync';
import { OMSGuruThrottledError } from '../omsguru/client';
import { mergeItemImages } from '../forwardScan/mappers';

describe('SKU matching keys', () => {
  it('strips channel tags seen live (AI, AI1, AI2, N, INF, NEW)', () => {
    expect(listingMatchKey('T86-COFFEE-RED_XL_AI1')).toBe('T86-COFFEE-RED_XL');
    expect(listingMatchKey('BT174-SEHZADI-MEHENDI_M_AI')).toBe('BT174-SEHZADI-MEHENDI_M');
    expect(listingMatchKey('T86-COFFEE-RUST_M_N')).toBe('T86-COFFEE-RUST_M');
    expect(listingMatchKey('EJ1201-16001_INF_NEW')).toBe('EJ1201-16001');
    expect(listingMatchKey('SKD238-TRIPTI-BEIGE_AI2_S')).toBe('SKD238-TRIPTI-BEIGE_S');
    // Hyphen segments and sizes are never touched.
    expect(listingMatchKey('B161-KISHORI-BOTTLE GREEN_L')).toBe('B161-KISHORI-BOTTLE GREEN_L');
    expect(listingMatchKey('AI-NEW-KURTA_M')).toBe('AI-NEW-KURTA_M');
  });

  it('style key drops only the last _segment (size)', () => {
    expect(skuStyleKey('SKD238-TRIPTI-BEIGE_S')).toBe('SKD238-TRIPTI-BEIGE');
    expect(skuStyleKey('EJ4001-CREPE-1194-BEIGE_2_FREE SIZE')).toBe('EJ4001-CREPE-1194-BEIGE_2');
    expect(skuStyleKey('EJ1201-CHITRA-MAROON')).toBe('EJ1201-CHITRA-MAROON');
  });

  it('maps a live-shaped listing and rejects junk', () => {
    expect(mapListingRow({
      id: '54082215', channel_company_id: '17970', listing_id: '3366785_Free Size',
      sku_name: 'EJ2400-1001_Free Size', title: "Trendy Banarasi Silk  Women's Sarees Free Size",
      img_url: 'https://images.meesho.com/images/products/3366785/1.jpg', oms_sku_id: '21591335',
    })).toEqual({
      listing_row_id: 54082215,
      sku_name: 'EJ2400-1001_Free Size',
      sku_key: 'EJ2400-1001_FREE SIZE',
      match_key: 'EJ2400-1001_FREE SIZE',
      oms_sku_id: '21591335',
      title: "Trendy Banarasi Silk  Women's Sarees Free Size",
      image_url: 'https://images.meesho.com/images/products/3366785/1.jpg',
    });
    expect(mapListingRow({ id: 'x', sku_name: 'A' })).toBeNull();
    expect(mapListingRow({ id: 5, sku_name: '  ' })).toBeNull();
    expect(mapListingRow({ id: 5, sku_name: 'A'.repeat(300) })).toBeNull();
    // Only https photos are kept; oms id "0" means none.
    expect(mapListingRow({ id: 6, sku_name: 'A_M', img_url: 'javascript:alert(1)', oms_sku_id: '0' }))
      .toMatchObject({ image_url: null, oms_sku_id: null });
    expect(mapListingRow({ id: 7, sku_name: 'A_M', img_url: '//cdn.x/a.jpg' })?.image_url).toBe('https://cdn.x/a.jpg');
  });

  it('cleans text Postgres jsonb would reject and drops placeholder oms ids', () => {
    expect(safeText('Kurti\u0000 Set', 50)).toBe('Kurti  Set');
    expect(safeText('Saree \ud83d', 50)).toBe('Saree');
    // Cut by code points: an emoji is never split in half.
    expect(safeText('ab😀cd', 3)).toBe('ab😀');
    const row = mapListingRow({ id: 9, sku_name: 'X_M\u0000', title: 'T\u0000itle', img_url: 'https://cdn/x.jpg', oms_sku_id: '-1' });
    expect(row).toMatchObject({ sku_name: 'X_M', title: 'T itle', oms_sku_id: null });
    expect(mapListingRow({ id: 10, sku_name: 'Y_M', oms_sku_id: 'NA' })?.oms_sku_id).toBeNull();
    expect(mapListingRow({ id: 11, sku_name: 'Y_M', oms_sku_id: 21591335 })?.oms_sku_id).toBe('21591335');
    expect(JSON.stringify(row)).not.toContain('\\u0000');
  });

  it('call spacing keeps the reserve even without rate headers', () => {
    expect(minCallIntervalMs(25)).toBe(8572);
    expect(minCallIntervalMs(0)).toBe(5000);
    expect(minCallIntervalMs(80)).toBe(300_000);
  });

  it('tells auth failures (stop the run) from channel errors (skip one)', () => {
    expect(isAuthFailure(new Error('OMSGuru /order_api/list_channel_listings failed: HTTP 401'))).toBe(true);
    expect(isAuthFailure(new Error('OMSGuru is not configured (token / client ID)'))).toBe(true);
    expect(isAuthFailure(new Error('OMSGuru /order_api/list_channel_listings failed: HTTP 500'))).toBe(false);
    expect(isAuthFailure(new Error('OMSGuru /order_api/list_channel_listings failed: Invalid channel'))).toBe(false);
  });

  it('rebuild is linear and skips placeholder-sized oms groups', () => {
    expect(REBUILD_SKU_IMAGES_SQL).toContain('HAVING COUNT(*) BETWEEN 2 AND 50');
    expect(REBUILD_SKU_IMAGES_SQL).toMatch(/DISTINCT ON \(p\.oms_sku_id,/);
    expect(REBUILD_SKU_IMAGES_SQL).toContain('g.style_key = regexp_replace(s.match_key');
    expect(PURGE_ORPHAN_SKU_IMAGES_SQL).toContain('DELETE FROM sku_images');
    // Unchanged rows never reach the INSERT.
    expect(REBUILD_SKU_IMAGES_SQL).toMatch(/LEFT JOIN sku_images e[\s\S]*WHERE e\.sku_key IS NULL/);
  });

  it('cursor is the highest id on the page', () => {
    expect(nextListingCursor([{ id: '10' }, { id: '42' }, { id: 'bad' }], 5)).toBe(42);
    expect(nextListingCursor([], 7)).toBe(7);
  });
});

describe('channel order and passes', () => {
  const channels = [
    { id: 17040, name: 'ETHNIC JUNCTION - Flipkart', channel: 'Flipkart' },
    { id: 22475, name: 'VB EXPORT - Amazon FBA', channel: 'Amazon FBA' },
    { id: 59585, name: 'VB EXPORT - Ajio B2C Dropship', channel: 'Ajio Api' },
    { id: 17970, name: 'Tulip Prints - Meesho', channel: 'Meesho' },
    { id: 51680, name: 'ETHNIC JUNCTION - Myntra Youthnic', channel: 'Myntra PPMP' },
    { id: 22489, name: 'ETHNIC JUNCTION - Flipkart FBA', channel: 'Flipkart Advantage' },
  ];

  it('walks packed channels first, uncopied next, fulfilled-by-marketplace last', () => {
    const ordered = orderChannelsForSync(channels, ['Flipkart', 'Myntra Youthnic', 'Myntra PPMP']);
    expect(ordered.map((c) => c.id)).toEqual([17970, 59585, 17040, 51680, 22475, 22489]);
  });

  it('resumes a pass, keeps a finished cursor, refreshes after N days', () => {
    const now = Date.parse('2026-10-06T21:00:00Z');
    expect(planChannelPass(null, now, 30)).toEqual({ lastId: 0, newPass: true });
    expect(planChannelPass({ last_id: '900', pass_started_at: null, pass_completed_at: null }, now, 30))
      .toEqual({ lastId: 0, newPass: true });
    expect(planChannelPass({ last_id: '900', pass_started_at: '2026-10-05T20:30:00Z', pass_completed_at: null }, now, 30))
      .toEqual({ lastId: 900, newPass: false });
    expect(planChannelPass({ last_id: '900', pass_started_at: '2026-08-01T20:30:00Z', pass_completed_at: null }, now, 30))
      .toEqual({ lastId: 0, newPass: true });
    expect(planChannelPass({ last_id: 900, pass_started_at: '2026-09-01T20:30:00Z', pass_completed_at: '2026-09-20T21:00:00Z' }, now, 30))
      .toEqual({ lastId: 900, newPass: false });
    expect(planChannelPass({ last_id: 900, pass_started_at: '2026-08-01T20:30:00Z', pass_completed_at: '2026-09-01T21:00:00Z' }, now, 30))
      .toEqual({ lastId: 0, newPass: true });
    expect(planChannelPass({ last_id: 900, pass_started_at: '2026-01-01T00:00:00Z', pass_completed_at: '2026-01-02T00:00:00Z' }, now, 0))
      .toEqual({ lastId: 900, newPass: false });
  });
});

describe('budget and night window', () => {
  it('waits for the window reset when the reserve is reached', () => {
    const now = 1_000_000;
    expect(budgetWaitMs(null, 25, now)).toBe(0);
    expect(budgetWaitMs({ remaining: 40, resetAtMs: now + 60_000, seenAtMs: now }, 25, now)).toBe(0);
    expect(budgetWaitMs({ remaining: 25, resetAtMs: now + 60_000, seenAtMs: now }, 25, now)).toBe(61_000);
    expect(budgetWaitMs({ remaining: 3, resetAtMs: now - 1, seenAtMs: now - 10 }, 25, now)).toBe(0);
    // No reset header: assume a 5-minute window from the reading.
    expect(budgetWaitMs({ remaining: 0, resetAtMs: null, seenAtMs: now }, 25, now)).toBe(301_000);
    expect(budgetWaitMs({ remaining: 0, resetAtMs: now + 5000, seenAtMs: now }, 0, now)).toBe(0);
  });

  it('schedules 02:00 IST and detects a restart inside the window', () => {
    // 2026-10-06 20:00 UTC = 01:30 IST on the 7th -> 02:00 IST = 20:30 UTC.
    const before = Date.parse('2026-10-06T20:00:00Z');
    expect(new Date(nextNightlyRunAt(before, 2)).toISOString()).toBe('2026-10-06T20:30:00.000Z');
    const inside = Date.parse('2026-10-06T20:45:00Z');
    expect(new Date(nextNightlyRunAt(inside, 2)).toISOString()).toBe('2026-10-07T20:30:00.000Z');
    expect(new Date(currentNightlyWindowStart(inside, 2, 60)!).toISOString()).toBe('2026-10-06T20:30:00.000Z');
    expect(currentNightlyWindowStart(Date.parse('2026-10-06T21:31:00Z'), 2, 60)).toBeNull();
    expect(currentNightlyWindowStart(before, 2, 60)).toBeNull();
  });

  it('clamps env numbers', () => {
    expect(clampInt(undefined, 60, 5, 180)).toBe(60);
    expect(clampInt('', 60, 5, 180)).toBe(60);
    expect(clampInt('abc', 60, 5, 180)).toBe(60);
    expect(clampInt('2', 60, 5, 180)).toBe(5);
    expect(clampInt('999', 60, 5, 180)).toBe(180);
    expect(clampInt('0', 2, 0, 23)).toBe(0);
  });
});

describe('style fallback on the packing page', () => {
  it('uses a same-style photo only when the exact SKU has none, and says so', () => {
    const merged = mergeItemImages(
      [
        { sku: 'SKD238-Tripti-Beige_M', quantity: 2 },
        { sku: 'B161-Kishori-Green_L', quantity: 1 },
        { sku: 'UNKNOWN', quantity: 1 },
      ],
      [
        { sku_key: 'SKD238-TRIPTI-BEIGE_S', title: 'Tripti', image_url: 'https://cdn/s.jpg', source: 'omsguru' },
        { sku_key: 'SKD238-TRIPTI-BEIGE_XL', title: 'Tripti', image_url: 'https://cdn/xl.jpg', source: 'forward-scan' },
        { sku_key: 'B161-KISHORI-GREEN_L', title: 'Kishori', image_url: 'https://cdn/l.jpg', source: 'omsguru' },
        { sku_key: 'B161-KISHORI-GREEN_M', title: 'Kishori', image_url: 'https://cdn/m.jpg', source: 'manual' },
      ]
    );
    expect(merged[0]).toMatchObject({ imageUrl: 'https://cdn/xl.jpg', imageMatch: 'style', title: 'Tripti', quantity: 2 });
    expect(merged[1]).toMatchObject({ imageUrl: 'https://cdn/l.jpg', imageMatch: 'exact' });
    expect(merged[2]).toMatchObject({ imageUrl: null, imageMatch: null });
  });
});

// Fake pool: records statements, keeps the per-channel cursor state.
function fakePool(options: { rejectUpsert?: (rows: any[]) => boolean } = {}) {
  const calls: { sql: string; params: any[] }[] = [];
  const state = new Map<number, any>();
  let nextRunId = 1;
  const query = async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/INSERT INTO omsguru_listings/.test(sql) && options.rejectUpsert?.(JSON.parse(params[3]))) {
        throw new Error('unsupported Unicode escape sequence');
      }
      if (/INSERT INTO sku_image_sync_runs/.test(sql)) return { rows: [{ id: nextRunId++ }], rowCount: 1 };
      if (/SELECT channel_id, last_id/.test(sql)) return { rows: [...state.values()], rowCount: state.size };
      if (/INSERT INTO omsguru_listing_sync_state/.test(sql)) {
        state.set(params[1], { channel_id: params[1], last_id: params[3], pass_started_at: 'now', pass_completed_at: null });
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE omsguru_listing_sync_state SET\s+channel_name/.test(sql)) {
        const row = state.get(params[1]);
        row.last_id = params[3];
        if (params[4]) row.pass_completed_at = row.pass_completed_at || 'now';
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE omsguru_listing_sync_state SET last_error/.test(sql)) {
        const row = state.get(params[1]);
        if (row) row.last_error = params[2];
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO sku_images/.test(sql)) return { rows: [], rowCount: 7 };
      return { rows: [], rowCount: 0 };
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => undefined }),
  } as any;
  return { pool, calls, state };
}

function page(fromId: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: String(fromId + i), sku_name: `SKU-${fromId + i}_M`, img_url: `https://cdn/${fromId + i}.jpg`, oms_sku_id: String(fromId + i),
  }));
}

describe('runSkuImageSync', () => {
  const base = {
    organizationId: 'org-1',
    creds: { token: 't', cid: 'c' },
    reserve: 25,
    fullRefreshDays: 30,
    excludedMarketplaces: ['Flipkart'],
    trigger: 'nightly' as const,
    minIntervalMs: 0,
    rateSnapshot: () => null,
  };

  it('walks every page, saves the cursor, then only reads new listings next night', async () => {
    const { pool, calls, state } = fakePool();
    const pages: Record<string, any[]> = { '0': page(1, 100), '100': page(101, 100), '200': page(201, 30) };
    const client: ListingClient = {
      listActiveChannels: async () => [{ id: 17970, name: 'Tulip Prints - Meesho', channel: 'Meesho' }],
      listListingsPage: async (_ch, lastId) => pages[String(lastId)] || [],
    };
    let t = 0;
    const result = await runSkuImageSync(pool, { ...base, client, deadlineMs: 1e12, now: () => t++, sleep: async () => undefined });
    expect(result).toMatchObject({ ok: true, stoppedBy: 'done', listingsSeen: 230, listingsStored: 230, channelsCompleted: 1, imagesWritten: 7 });
    expect(state.get(17970)).toMatchObject({ last_id: 230, pass_completed_at: 'now' });
    // Full pass finished: listings not seen in it are pruned.
    expect(calls.some((c) => /DELETE FROM omsguru_listings/.test(c.sql))).toBe(true);
    // Listing rows carry the channel marketplace label.
    expect(calls.find((c) => /INSERT INTO omsguru_listings/.test(c.sql))?.params[2]).toBe('Meesho');

    // Next night: resumes at 230, one empty page, no prune.
    const before = calls.length;
    pages['230'] = [];
    const again = await runSkuImageSync(pool, { ...base, client, deadlineMs: 1e12, now: () => t++, sleep: async () => undefined });
    expect(again).toMatchObject({ ok: true, listingsSeen: 0, channelsCompleted: 1, calls: 2 });
    expect(calls.slice(before).some((c) => /DELETE FROM omsguru_listings/.test(c.sql))).toBe(false);
  });

  it('stops at the deadline and resumes from the saved cursor', async () => {
    const { pool, state } = fakePool();
    const client: ListingClient = {
      listActiveChannels: async () => [{ id: 1, name: 'X - Meesho', channel: 'Meesho' }],
      listListingsPage: async (_ch, lastId) => page(lastId + 1, 100),
    };
    let t = 0;
    const result = await runSkuImageSync(pool, {
      ...base, client, minIntervalMs: 10, deadlineMs: 45, now: () => t, sleep: async (ms) => { t += ms; },
    });
    expect(result.stoppedBy).toBe('deadline');
    expect(result.ok).toBe(true);
    expect(state.get(1).pass_completed_at).toBeNull();
    expect(state.get(1).last_id).toBe(result.listingsSeen);
    // Photos found so far are still published.
    expect(result.imagesWritten).toBe(7);
  });

  it('takes turns so a small channel finishes while a big one is still walking', async () => {
    const { pool, state } = fakePool();
    const big = 17970;
    const small = 59585;
    const client: ListingClient = {
      listActiveChannels: async () => [
        { id: big, name: 'Tulip Prints - Meesho', channel: 'Meesho' },
        { id: small, name: 'VB EXPORT - Ajio B2C Dropship', channel: 'Ajio Api' },
      ],
      // Big channel never ends tonight; small one has a single short page.
      listListingsPage: async (ch, lastId) => (ch === big ? page(lastId + 1, 100) : lastId === 0 ? page(1_000_000, 40) : []),
    };
    let t = 0;
    const result = await runSkuImageSync(pool, {
      ...base, client, minIntervalMs: 1, deadlineMs: 30, now: () => t, sleep: async (ms) => { t += ms; },
    });
    expect(result.stoppedBy).toBe('deadline');
    expect(state.get(small)).toMatchObject({ pass_completed_at: 'now', last_id: 1_000_039 });
    expect(state.get(big).pass_completed_at).toBeNull();
    expect(result.channelsCompleted).toBe(1);
  });

  it('skips a failing channel for the night and still finishes the others', async () => {
    const { pool, state, calls } = fakePool();
    const client: ListingClient = {
      listActiveChannels: async () => [
        { id: 1, name: 'X - Meesho', channel: 'Meesho' },
        { id: 2, name: 'X - Ajio', channel: 'Ajio Api' },
      ],
      listListingsPage: async (ch, lastId) => {
        if (ch === 1) throw new Error('OMSGuru /order_api/list_channel_listings failed: HTTP 500');
        return lastId === 0 ? page(10, 5) : [];
      },
    };
    let t = 0;
    const result = await runSkuImageSync(pool, { ...base, client, deadlineMs: 1e12, now: () => t++, sleep: async () => undefined });
    expect(result).toMatchObject({ ok: true, channelErrors: 1, channelsCompleted: 1, listingsStored: 5 });
    expect(state.get(1).last_error).toContain('HTTP 500');
    expect(state.get(2).pass_completed_at).toBe('now');
    const ledger = calls.find((c) => /UPDATE sku_image_sync_runs/.test(c.sql));
    expect(ledger?.params[1]).toBe('partial');
    expect(String(ledger?.params[9])).toContain('X - Meesho');
  });

  it('skips only the rows Postgres rejects, not the page', async () => {
    const { pool, state } = fakePool({ rejectUpsert: (rows) => rows.length > 1 || rows[0].sku_key === 'SKU-12_M' });
    const client: ListingClient = {
      listActiveChannels: async () => [{ id: 1, name: 'X - Meesho', channel: 'Meesho' }],
      listListingsPage: async (_ch, lastId) => (lastId === 0 ? page(10, 5) : []),
    };
    let t = 0;
    const result = await runSkuImageSync(pool, { ...base, client, deadlineMs: 1e12, now: () => t++, sleep: async () => undefined });
    expect(result).toMatchObject({ ok: true, listingsStored: 4, rowsSkipped: 1 });
    expect(state.get(1)).toMatchObject({ last_id: 14, pass_completed_at: 'now' });
  });

  it('stops the run when the database rejects every row', async () => {
    const { pool } = fakePool({ rejectUpsert: () => true });
    const client: ListingClient = {
      listActiveChannels: async () => [{ id: 1, name: 'X - Meesho', channel: 'Meesho' }],
      listListingsPage: async () => page(10, 3),
    };
    let t = 0;
    const result = await runSkuImageSync(pool, { ...base, client, deadlineMs: 1e12, now: () => t++, sleep: async () => undefined });
    expect(result).toMatchObject({ ok: false, stoppedBy: 'error', listingsStored: 0 });
  });

  it('a short page is not the end: the walk goes on until an empty page', async () => {
    const { pool, state } = fakePool();
    const pages: Record<string, any[]> = { '0': page(1, 60), '60': page(61, 100), '160': [] };
    const client: ListingClient = {
      listActiveChannels: async () => [{ id: 1, name: 'X - Meesho', channel: 'Meesho' }],
      listListingsPage: async (_ch, lastId) => pages[String(lastId)] || [],
    };
    let t = 0;
    const result = await runSkuImageSync(pool, { ...base, client, deadlineMs: 1e12, now: () => t++, sleep: async () => undefined });
    expect(result.listingsSeen).toBe(160);
    expect(state.get(1)).toMatchObject({ last_id: 160, pass_completed_at: 'now' });
  });

  it('steps aside while the shared budget is at the reserve', async () => {
    const { pool } = fakePool();
    const slept: number[] = [];
    let t = 1_000;
    const client: ListingClient = {
      listActiveChannels: async () => [{ id: 1, name: 'X - Meesho', channel: 'Meesho' }],
      listListingsPage: async () => [],
    };
    await runSkuImageSync(pool, {
      ...base, client, deadlineMs: 10_000_000, now: () => t,
      sleep: async (ms) => { slept.push(ms); t += ms; },
      rateSnapshot: () => ({ limit: 60, remaining: 20, resetAtMs: 61_000, seenAtMs: 1_000 }),
    });
    expect(slept[0]).toBe(61_000);
  });

  it('pauses on throttling and records hard errors in the ledger', async () => {
    const { pool, calls } = fakePool();
    let n = 0;
    const client: ListingClient = {
      listActiveChannels: async () => [{ id: 1, name: 'X - Meesho', channel: 'Meesho' }],
      listListingsPage: async () => {
        n += 1;
        if (n === 1) throw new OMSGuruThrottledError('throttled', 10);
        throw new Error('OMSGuru /order_api/list_channel_listings failed: HTTP 401');
      },
    };
    let t = 0;
    const slept: number[] = [];
    const result = await runSkuImageSync(pool, {
      ...base, client, deadlineMs: 1e12, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; },
    });
    expect(slept).toContain(60_000);
    expect(result).toMatchObject({ ok: false, stoppedBy: 'error' });
    const ledger = calls.find((c) => /UPDATE sku_image_sync_runs/.test(c.sql));
    expect(ledger?.params[1]).toBe('error');
    expect(String(ledger?.params[9])).toContain('HTTP 401');
  });
});

describe('auditAndReconcileSkuImages', () => {
  it('purges conflicting sku_images and clears conflicting order item photos', async () => {
    const executedQueries: { sql: string; params?: any[] }[] = [];
    const pool = {
      query: async (sql: string, params?: any[]) => {
        executedQueries.push({ sql, params });
        if (/SELECT [\s\S]* FROM sku_images/i.test(sql)) {
          return {
            rows: [
              {
                id: 'img-1',
                sku: 'BT216-Geomi-Rust_S',
                sku_key: 'BT216-GEOMI-RUST_S',
                title: 'Geomi Navy Kurta',
                image_url: 'https://cdn/BT216-Geomi-Navy.jpg',
                source: 'omsguru',
              },
              {
                id: 'img-2',
                sku: 'BT216-Geomi-Rust_M',
                sku_key: 'BT216-GEOMI-RUST_M',
                title: 'Geomi Rust Kurta',
                image_url: 'https://cdn/BT216-Geomi-Rust.jpg',
                source: 'omsguru',
              },
            ],
            rowCount: 2,
          };
        }
        if (/SELECT [\s\S]* FROM marketplace_orders/i.test(sql)) {
          return {
            rows: [
              {
                tracking_id: 'TRACK-1',
                items: [
                  {
                    sku: 'BT216-Geomi-Rust_S',
                    name: 'Geomi Rust Kurta',
                    imageUrl: 'https://cdn/BT216-Geomi-Navy.jpg',
                    quantity: 1,
                  },
                  {
                    sku: 'BT216-Geomi-Navy_S',
                    name: 'Geomi Navy Kurta',
                    imageUrl: 'https://cdn/BT216-Geomi-Navy.jpg',
                    quantity: 1,
                  },
                ],
              },
            ],
            rowCount: 1,
          };
        }
        if (/DELETE FROM sku_images/i.test(sql)) {
          return { rows: [], rowCount: 1 };
        }
        if (/UPDATE marketplace_orders/i.test(sql)) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as any;

    const res = await auditAndReconcileSkuImages(pool, 'org-1');
    expect(res.purgedMismatches).toBe(1);
    expect(res.ordersScanned).toBe(1);
    expect(res.orderItemsAudited).toBe(2);
    expect(res.orderImagesCorrected).toBe(1);

    const delCall = executedQueries.find((q) => /DELETE FROM sku_images/.test(q.sql));
    expect(delCall?.params).toEqual(['org-1', ['img-1']]);

    const updateCall = executedQueries.find((q) => /UPDATE marketplace_orders/.test(q.sql));
    expect(updateCall).toBeDefined();
    const updatedItems = JSON.parse(updateCall?.params?.[2]);
    expect(updatedItems[0].imageUrl).toBeUndefined();
    expect(updatedItems[1].imageUrl).toBe('https://cdn/BT216-Geomi-Navy.jpg');
  });
});

