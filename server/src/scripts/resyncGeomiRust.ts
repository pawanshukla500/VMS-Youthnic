import { Pool } from 'pg';
import dotenv from 'dotenv';
import { buildPostgresPoolConfig } from '../db/poolConfig';
import { resolveSyncCreds } from '../omsguru/sync';
import { resyncSingleSkuImage } from '../omsguru/skuImageSync';
import { isColorConflicting } from '../omsguru/colorMatch';

dotenv.config();

const pool = new Pool(buildPostgresPoolConfig());

async function run() {
  console.log('=== Step 1: Connecting to Database ===');
  const orgsRes = await pool.query(`SELECT id, name FROM organizations ORDER BY created_at ASC`);
  console.log(`Found ${orgsRes.rows.length} organization(s):`, orgsRes.rows.map((o) => `${o.name} (${o.id})`));

  if (orgsRes.rows.length === 0) {
    console.error('No organization found');
    process.exit(1);
  }

  const organizationId = orgsRes.rows[0].id;

  console.log('\n=== Step 2: Inspect Current sku_images for BT216 ===');
  const currentImagesRes = await pool.query(
    `SELECT id, sku, sku_key, title, image_url, source, marketplace, updated_at
     FROM sku_images
     WHERE organization_id = $1 AND (sku_key ILIKE '%BT216%' OR sku ILIKE '%BT216%')
     ORDER BY sku_key, source`,
    [organizationId]
  );
  console.log(`Current sku_images for BT216 (${currentImagesRes.rows.length} rows):`);
  for (const row of currentImagesRes.rows) {
    const isConflict = isColorConflicting(row.sku, row.title, row.image_url);
    console.log(`  - [${row.source}] ${row.sku_key} => ${row.image_url} (conflict: ${isConflict})`);
  }

  console.log('\n=== Step 3: Inspect Existing omsguru_listings for BT216 ===');
  const listingsRes = await pool.query(
    `SELECT listing_row_id, channel_id, sku_name, sku_key, match_key, oms_sku_id, title, image_url, marketplace
     FROM omsguru_listings
     WHERE organization_id = $1 AND (sku_name ILIKE '%BT216%' OR sku_key ILIKE '%BT216%')
     ORDER BY sku_name`,
    [organizationId]
  );
  console.log(`Found ${listingsRes.rows.length} existing listing(s) for BT216:`);
  for (const row of listingsRes.rows) {
    const isConflict = isColorConflicting(row.sku_name, row.title, row.image_url);
    console.log(`  - Ch:${row.channel_id} | ${row.sku_name} | oms_id:${row.oms_sku_id} => ${row.image_url} (conflict: ${isConflict})`);
  }

  console.log('\n=== Step 4: Loading OMSGuru Credentials ===');
  const credsRow = await pool.query(
    `SELECT token, cid, warehouse_id FROM omsguru_settings WHERE organization_id = $1`,
    [organizationId]
  );
  let creds = null;
  try {
    creds = resolveSyncCreds(credsRow.rows[0] || null, {
      token: process.env.OMSGURU_TOKEN,
      cid: process.env.OMSGURU_CID,
      warehouseId: process.env.OMSGURU_WAREHOUSE_ID,
    });
    console.log(`OMSGuru credentials resolved (CID: ${creds.cid}, Token: ${creds.token.slice(0, 4)}...${creds.token.slice(-4)})`);
  } catch (err) {
    console.warn('OMSGuru credentials not configured:', err instanceof Error ? err.message : err);
  }

  const targetSku = (process.env.TARGET_SKU || 'BT216-Geomi-Rust_S').trim();
  const skusToSync =
    targetSku.toUpperCase().includes('GEOMI-RUST')
      ? [
          'BT216-Geomi-Rust_S',
          'BT216-Geomi-Rust_M',
          'BT216-Geomi-Rust_L',
          'BT216-Geomi-Rust_XL',
          'BT216-Geomi-Rust_2XL',
          'BT216-Geomi-Rust_XXL',
        ]
      : [targetSku];

  console.log(`\n=== Step 5: Executing resyncSingleSkuImage for SKU(s): ${skusToSync.join(', ')} ===`);
  for (const sku of skusToSync) {
    const res = await resyncSingleSkuImage(pool, organizationId, sku, creds);
    console.log(`Result for ${sku}:`, JSON.stringify(res, null, 2));
  }

  console.log('\n=== Step 6: Verifying final state in sku_images ===');
  const finalImagesRes = await pool.query(
    `SELECT id, sku, sku_key, title, image_url, source, marketplace, updated_at
     FROM sku_images
     WHERE organization_id = $1 AND (sku_key ILIKE '%BT216%' OR sku ILIKE '%BT216%')
     ORDER BY sku_key, source`,
    [organizationId]
  );
  for (const row of finalImagesRes.rows) {
    const isConflict = isColorConflicting(row.sku, row.title, row.image_url);
    console.log(`  - [${row.source}] ${row.sku_key} => ${row.image_url} (conflict: ${isConflict})`);
  }

  console.log('\n=== Step 7: Verifying recent orders containing BT216-Geomi-Rust_S ===');
  const finalOrdersRes = await pool.query(
    `SELECT tracking_id, marketplace, items
     FROM marketplace_orders
     WHERE organization_id = $1 AND items::text ILIKE '%BT216-Geomi-Rust%'
     ORDER BY COALESCE(awb_generated_at, created_at) DESC
     LIMIT 10`,
    [organizationId]
  );
  for (const o of finalOrdersRes.rows) {
    const items = Array.isArray(o.items) ? o.items : [];
    for (const item of items) {
      if (typeof item.sku === 'string' && item.sku.toLowerCase().includes('bt216-geomi-rust')) {
        console.log(`  - Order ${o.tracking_id} (${o.marketplace}): ${item.sku} => imageUrl="${item.imageUrl}"`);
      }
    }
  }

  await pool.end();
  console.log('\n=== All Done ===');
}

run().catch((err) => {
  console.error('Fatal error in resyncGeomiRust:', err);
  process.exit(1);
});
