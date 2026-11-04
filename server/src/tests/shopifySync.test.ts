import { describe, expect, it } from 'vitest';
import {
  mapShopifyOrder,
  mapShopifyPhotos,
  shopifyOrderIdentity,
  parseShopifyItems,
} from '../shopify/mappers';
import {
  assertReadOnlySql,
  normalizeShopifyPostgresUrl,
} from '../shopify/source';
import {
  buildAutoRetryStuckQuery,
} from '../videoUploadQueue';

describe('Shopify Mappers', () => {
  it('cleans Shopify order id by stripping leading # and trimming', () => {
    expect(shopifyOrderIdentity('#26YOU6345', null)).toBe('26YOU6345');
    expect(shopifyOrderIdentity('  #26YOU6345  ', null)).toBe('26YOU6345');
    expect(shopifyOrderIdentity('26YOU6345', null)).toBe('26YOU6345');
    expect(shopifyOrderIdentity('26YOU6231-EX-FWD', null)).toBe('26YOU6231-EX-FWD');
    expect(shopifyOrderIdentity('#1001', null)).toBe('1001');
    expect(shopifyOrderIdentity('', 12345)).toBe('12345');
    expect(shopifyOrderIdentity(null, null)).toBe(null);
  });

  it('parses items from array and JSON string', () => {
    const rawArray = [
      { id: 1, sku: 'BT216-Geomi-Rust_S', title: 'Geomi Rust Kurti', quantity: 2, price: 599 },
    ];
    expect(parseShopifyItems(rawArray, '#26YOU6345')).toHaveLength(1);
    expect(parseShopifyItems(JSON.stringify(rawArray), '#26YOU6345')).toHaveLength(1);
    expect(parseShopifyItems('invalid json', '#26YOU6345')).toEqual([]);
    expect(parseShopifyItems(null, '#26YOU6345')).toEqual([]);
  });

  it('maps a Shopify shipment and order into a MarketplaceOrderRecord', () => {
    const row = {
      shipment_id: 101,
      waybill_number: 'DEL1234567890',
      courier: 'Delhivery',
      shipment_status: 'manifested',
      shipment_created_at: '2026-11-04T10:00:00Z',
      shipment_updated_at: '2026-11-04T10:05:00Z',
      order_id: 202,
      shopify_order_name: '#26YOU6345',
      shopify_order_number: 6345,
      sales_channel: 'Online Store',
      order_status: 'unfulfilled',
      total_amount: 1198,
      order_created_at: '2026-11-04T09:30:00Z',
      items: [
        {
          id: 303,
          sku: 'BT216-Geomi-Rust_S',
          title: 'Geomi Rust Kurti - S',
          quantity: 2,
          price: 599,
          imageUrl: 'https://cdn.shopify.com/s/files/1/photo.jpg',
        },
      ],
    };

    const record = mapShopifyOrder(row);
    expect(record).not.toBeNull();
    if (!record) return;

    expect(record.tracking_id).toBe('DEL1234567890');
    expect(record.marketplace).toBe('Shopify');
    expect(record.channel_marketplace).toBe('Shopify');
    expect(record.order_id).toBe('26YOU6345'); // leading # stripped
    expect(record.channel_order_id).toBe('#26YOU6345'); // raw preserved
    expect(record.shipping_company).toBe('Delhivery');
    expect(record.item_count).toBe(1);
    expect(record.total_qty).toBe(2);
    expect(record.is_meesho).toBe(false);
    expect(record.items).toHaveLength(1);
    expect(record.items[0].sku).toBe('BT216-Geomi-Rust_S');
    expect(record.items[0].quantity).toBe(2);
    expect(record.items[0].imageUrl).toBe('https://cdn.shopify.com/s/files/1/photo.jpg');

    // Verify buyer PII is absent
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('customer');
    expect(serialized).not.toContain('phone');
    expect(serialized).not.toContain('address');
  });

  it('maps photos and filters conflicting colors', () => {
    const row = {
      order_id: 202,
      items: [
        {
          sku: 'BT216-Geomi-Rust_S',
          title: 'Geomi Rust Kurti',
          imageUrl: 'https://cdn.shopify.com/s/files/1/rust.jpg',
        },
        {
          sku: 'BT216-Geomi-Rust_M',
          title: 'Geomi Blue Kurti', // conflicting color title vs SKU
          imageUrl: 'https://cdn.shopify.com/s/files/1/blue.jpg',
        },
      ],
    };

    const photos = mapShopifyPhotos(row);
    expect(photos).toHaveLength(1);
    expect(photos[0].sku).toBe('BT216-Geomi-Rust_S');
    expect(photos[0].image_url).toBe('https://cdn.shopify.com/s/files/1/rust.jpg');
    expect(photos[0].marketplace).toBe('Shopify');
  });
});

describe('Shopify Read-Only Security', () => {
  it('allows safe SELECT statements', () => {
    expect(() => assertReadOnlySql('SELECT * FROM "Shipment" WHERE id = 1')).not.toThrow();
    expect(() => assertReadOnlySql('SELECT s.id, count(*) FROM "Shipment" s GROUP BY s.id')).not.toThrow();
  });

  it('rejects forbidden write statements and SQL injection attempts', () => {
    expect(() => assertReadOnlySql('UPDATE "Shipment" SET waybillNumber = null')).toThrow(/Refused: only read/);
    expect(() => assertReadOnlySql('DELETE FROM "Order"')).toThrow(/Refused: only read/);
    expect(() => assertReadOnlySql('DROP TABLE "Order"')).toThrow(/Refused: only read/);
    expect(() => assertReadOnlySql('INSERT INTO "Shipment" VALUES (1)')).toThrow(/Refused: only read/);
    expect(() => assertReadOnlySql('SELECT * FROM "Order"; DROP TABLE "Order"')).toThrow(/Refused: only read/);
    expect(() => assertReadOnlySql('SELECT * FROM "Order" -- comment')).toThrow(/Refused: only read/);
  });

  it('normalizes Shopify Postgres URLs safely', () => {
    const url = normalizeShopifyPostgresUrl('postgresql://pawanshukla:pass@host:5433/shopify?sslmode=require');
    expect(url).toBe('postgresql://pawanshukla:pass@host:5433/shopify?sslmode=require');
    expect(normalizeShopifyPostgresUrl('invalid-url')).toBe(null);
  });
});

describe('Automatic Stuck Upload Retry Query', () => {
  it('builds query scoped to an organization', () => {
    const orgId = '11111111-1111-1111-1111-111111111111';
    const adminId = '22222222-2222-2222-2222-222222222222';
    const query = buildAutoRetryStuckQuery(orgId, adminId);
    expect(query.text).toContain('WHERE ($1::uuid IS NULL OR organization_id = $1::uuid)');
    expect(query.values).toEqual([orgId, adminId]);
  });

  it('builds query for all organizations when organizationId is omitted', () => {
    const query = buildAutoRetryStuckQuery();
    expect(query.text).toContain('WHERE ($1::uuid IS NULL OR organization_id = $1::uuid)');
    expect(query.values).toEqual([null, null]);
  });
});
