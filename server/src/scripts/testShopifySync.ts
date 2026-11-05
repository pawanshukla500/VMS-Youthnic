import { Pool } from 'pg';
import dotenv from 'dotenv';
import { buildPostgresPoolConfig } from '../db/poolConfig';
import { openConfiguredShopifySource, runShopifySync } from '../shopify/sync';

dotenv.config();

const pool = new Pool(buildPostgresPoolConfig());

async function run() {
  console.log('=== Step 1: Checking Shopify Environment Configuration ===');
  const shopifyUrl = process.env.SHOPIFY_DATABASE_URL;
  const rejectUnauthorized = process.env.SHOPIFY_SSL_REJECT_UNAUTHORIZED;

  console.log(`SHOPIFY_SSL_REJECT_UNAUTHORIZED: ${rejectUnauthorized ?? '(unset)'}`);
  if (!shopifyUrl) {
    console.error('SHOPIFY_DATABASE_URL is not set!');
    process.exit(1);
  }

  // Mask password
  const maskedUrl = shopifyUrl.replace(/:([^:@]+)@/, ':***@');
  console.log(`SHOPIFY_DATABASE_URL: ${maskedUrl}`);

  console.log('\n=== Step 2: Testing Remote Shopify Database Connection ===');
  const source = openConfiguredShopifySource('sync');
  if (!source) {
    console.error('Failed to open Shopify source');
    process.exit(1);
  }

  const cutoff = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  console.log(`Fetching orders since ${cutoff}...`);

  try {
    const rawOrders = await source.fetchOrdersSince(cutoff);
    console.log(`Connection successful! Fetched ${rawOrders.length} order(s) from Shopify database.`);
    if (rawOrders.length > 0) {
      const sample = rawOrders[0];
      console.log('Sample order:', {
        shipment_id: sample.shipment_id,
        waybill_number: sample.waybill_number,
        courier: sample.courier,
        order_name: sample.shopify_order_name,
        created_at: sample.order_created_at
      });
    }
  } catch (err: any) {
    console.error('Failed to query remote Shopify database:', err.message || err);
    process.exit(1);
  } finally {
    if (source.close) {
      await source.close();
    }
  }

  console.log('\n=== Step 3: Running Full Shopify Sync ===');
  const orgsRes = await pool.query(`SELECT id, name FROM organizations ORDER BY created_at ASC`);
  const orgIds = orgsRes.rows.map((o) => o.id);
  console.log(`Target Organization IDs (${orgIds.length}):`, orgIds);

  const result = await runShopifySync(pool, () => openConfiguredShopifySource('sync'), {
    organizationIds: orgIds,
    retentionDays: 3,
    sourceLabel: 'shopify:postgresql',
  });

  console.log('Sync result ok:', result.ok);
  console.log('Orders read:', result.ordersRead);
  console.log('Duration ms:', result.durationMs);
  if (result.error) {
    console.error('Sync error:', result.error);
  }
  for (const r of result.results) {
    console.log(`  - Org ${r.organizationId}: seen=${r.ordersSeen}, written=${r.ordersWritten}, photos=${r.photosWritten}, error=${r.error || 'none'}`);
  }

  console.log('\n=== Step 4: Inspecting Local shopify_sync_state ===');
  const stateRes = await pool.query(`SELECT * FROM shopify_sync_state`);
  for (const row of stateRes.rows) {
    console.log('shopify_sync_state:', {
      organization_id: row.organization_id,
      last_run_at: row.last_run_at,
      last_error: row.last_error,
      last_seen: row.last_seen,
      last_written: row.last_written,
      last_photos: row.last_photos,
      last_purged: row.last_purged
    });
  }

  await pool.end();
}

run()
  .then(() => {
    console.log('\nTest completed successfully.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nFatal error in test script:', err);
    process.exit(1);
  });
