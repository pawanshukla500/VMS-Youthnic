import { describe, it, expect } from 'vitest';
import { assertReadOnlySql, postgresSource, readOnlyQuery } from '../forwardScan/source';
import { buildExpiredOrdersDelete, EXPIRED_ORDER_SQL, purgeExpiredOrders } from '../forwardScan/sync';

const ORG = '00000000-0000-4000-8000-0000000000aa';

// Fake pg pool: records every statement each client runs.
function fakePool(opts: { fail?: RegExp } = {}) {
  const statements: string[] = [];
  const released: Array<unknown> = [];
  let connects = 0;
  const pool = {
    connect: async () => {
      connects += 1;
      return {
        query: async (text: string) => {
          statements.push(text.trim());
          if (opts.fail && opts.fail.test(text) && !/^(BEGIN|ROLLBACK)/.test(text.trim())) throw new Error('boom');
          return { rows: [{ ok: 1 }] };
        },
        release: (err?: unknown) => { released.push(err); },
      };
    },
  };
  return { pool: pool as any, statements, released, connects: () => connects };
}

describe('Forward Scan database is read-only to VMS', () => {
  it('refuses anything that is not one plain SELECT', () => {
    const refused = [
      'INSERT INTO oms_orders (id) VALUES (1)',
      "UPDATE oms_orders SET status_text = 'x'",
      'DELETE FROM oms_orders',
      'delete from oms_orders',
      'TRUNCATE oms_orders',
      'DROP TABLE oms_orders',
      'ALTER TABLE oms_orders ADD COLUMN x INT',
      'CREATE TABLE x (id INT)',
      'GRANT ALL ON oms_orders TO public',
      'SELECT 1; DELETE FROM oms_orders',
      'WITH gone AS (DELETE FROM oms_orders RETURNING id) SELECT * FROM gone',
      'SELECT * INTO copy_of_orders FROM oms_orders',
      'SELECT * FROM oms_orders FOR UPDATE',
      'SELECT * FROM oms_orders FOR NO KEY UPDATE',
      'SELECT * FROM oms_orders FOR SHARE',
      "SELECT nextval('oms_orders_id_seq')",
      "SELECT set_config('default_transaction_read_only', 'off', false)",
      'SELECT pg_advisory_lock(1)',
      'SELECT 1 -- ; DELETE',
      'SELECT 1 /* DELETE */',
      'SET default_transaction_read_only = off',
      'BEGIN READ WRITE',
      'COPY oms_orders TO STDOUT',
      'VACUUM oms_orders',
      'PRAGMA query_only = OFF',
      '',
    ];
    for (const sql of refused) expect(() => assertReadOnlySql(sql), sql).toThrow(/only read/);
  });

  it('accepts real reads, including column names like updated_at and words inside string literals', () => {
    assertReadOnlySql(`SELECT sku, CAST(updated_at AS TEXT) AS updated_at FROM sku_photos WHERE image_url <> '' LIMIT $3`);
    assertReadOnlySql(`SELECT o.id FROM oms_orders o WHERE o.status_text = 'DELETE requested; DROP TABLE x'`);
    assertReadOnlySql('  select 1');
  });

  it('runs every read inside its own READ ONLY transaction', async () => {
    const { pool, statements, released } = fakePool();
    const rows = await readOnlyQuery(pool, 'SELECT 1 AS ok', []);
    expect(rows).toEqual([{ ok: 1 }]);
    expect(statements).toEqual(['BEGIN TRANSACTION READ ONLY', 'SELECT 1 AS ok', 'COMMIT']);
    expect(released).toEqual([undefined]);
  });

  it('a refused statement never reaches the database', async () => {
    const { pool, connects } = fakePool();
    await expect(readOnlyQuery(pool, 'DELETE FROM oms_orders', [])).rejects.toThrow(/only read/);
    expect(connects()).toBe(0);
  });

  it('a failed read rolls back and drops the connection', async () => {
    const { pool, statements, released } = fakePool({ fail: /SELECT/ });
    await expect(readOnlyQuery(pool, 'SELECT 1', [])).rejects.toThrow('boom');
    expect(statements).toEqual(['BEGIN TRANSACTION READ ONLY', 'SELECT 1', 'ROLLBACK']);
    expect(released[0]).toBeInstanceOf(Error);
  });

  it('every Forward Scan read (orders, one AWB, many AWBs, photos) is a guarded READ ONLY transaction', async () => {
    const { pool, statements } = fakePool();
    const source = postgresSource(pool, async () => undefined);
    await source.fetchOrdersSince('2026-10-06 00:00:00');
    await source.fetchOrderByTracking(['AWB1']);
    await source.fetchOrdersByTracking(['AWB1', 'AWB2']);
    await source.fetchPhotosAfter({ updatedAt: null, sku: null }, 100);
    const reads = statements.filter((s) => s.startsWith('SELECT'));
    expect(reads).toHaveLength(4);
    expect(statements.filter((s) => s === 'BEGIN TRANSACTION READ ONLY')).toHaveLength(4);
    expect(statements.filter((s) => s === 'COMMIT')).toHaveLength(4);
    for (const sql of reads) expect(() => assertReadOnlySql(sql)).not.toThrow();
  });
});

describe('copied orders are kept 72 hours', () => {
  it('ages a Forward Scan row by AWB date (or first copy), never by later changes', () => {
    expect(EXPIRED_ORDER_SQL).toContain('COALESCE(awb_generated_at, created_at)');
    expect(EXPIRED_ORDER_SQL).toContain("CASE WHEN manual_override OR source <> 'forward-scan' THEN updated_at END");
    expect(EXPIRED_ORDER_SQL).toMatch(/\) < \$2$/);
    const del = buildExpiredOrdersDelete(ORG, new Date('2026-10-06T21:30:00Z'));
    expect(del.text).toBe(`DELETE FROM marketplace_orders WHERE organization_id = $1 AND ${EXPIRED_ORDER_SQL}`);
    expect(del.values).toEqual([ORG, '2026-10-06T21:30:00.000Z']);
  });

  it('nightly clean-up purges every organization 72 h back and vacuums the table', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.startsWith('SELECT DISTINCT organization_id')) return { rows: [{ organization_id: ORG }, { organization_id: 'org-b' }] };
        if (text.startsWith('DELETE')) return { rowCount: values?.[0] === ORG ? 7 : 2, rows: [] };
        return { rows: [] };
      },
    };
    const now = new Date('2026-10-09T21:30:00Z'); // 03:00 IST
    const result = await purgeExpiredOrders(pool as any, { retentionDays: 3, now });
    expect(result.cutoff).toBe('2026-10-06T21:30:00.000Z');
    expect(result.purged).toBe(9);
    expect(result.byOrganization).toEqual({ [ORG]: 7, 'org-b': 2 });
    expect(result.vacuumed).toBe(true);
    expect(calls.at(-1)?.text).toBe('VACUUM (ANALYZE) marketplace_orders');
    // Only VMS's own table is written.
    for (const c of calls) expect(c.text).not.toMatch(/oms_orders|sku_photos|channels/);
  });

  it('a VACUUM that cannot run never fails the clean-up', async () => {
    const pool = {
      query: async (text: string) => {
        if (text.startsWith('SELECT DISTINCT')) return { rows: [] };
        if (text.startsWith('VACUUM')) throw new Error('must be owner of table marketplace_orders');
        return { rows: [] };
      },
    };
    const result = await purgeExpiredOrders(pool as any, { retentionDays: 3 });
    expect(result).toMatchObject({ purged: 0, vacuumed: false });
  });
});
