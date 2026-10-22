import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const runtimeSchema = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');
const migrationPath = join(__dirname, '..', 'db', 'migrations', '004_video_identifier_columns_text.sql');

describe('recording identifier storage capacity', () => {
  it('uses unbounded text identifiers for new runtime tables', () => {
    const table = runtimeSchema.match(/CREATE TABLE IF NOT EXISTS recording_sessions \(([\s\S]*?)\n    \)/i)?.[1];
    expect(table).toBeDefined();
    expect(table).toMatch(/\btracking_id\s+TEXT\b/i);
    expect(table).toMatch(/\border_id\s+TEXT\b/i);
  });

  it('upgrades existing runtime tables without narrowing or dropping identifiers', () => {
    expect(runtimeSchema).toMatch(/ALTER TABLE recording_sessions ALTER COLUMN tracking_id TYPE TEXT/i);
    expect(runtimeSchema).toMatch(/ALTER TABLE recording_sessions ALTER COLUMN order_id TYPE TEXT/i);
  });

  it('terminates the guarded PostgreSQL DO block as a complete statement', () => {
    const upgrade = runtimeSchema.split('Shipment and order identifiers')[1]?.split('await pool.query(`')[1];
    expect(upgrade).toMatch(/\bEND;\s*\$\$;/i);
  });

  it('ships a non-destructive SQL migration for existing databases', () => {
    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).toMatch(/ALTER TABLE recording_sessions[\s\S]*ALTER COLUMN tracking_id TYPE TEXT/i);
    expect(migration).toMatch(/ALTER TABLE recording_sessions[\s\S]*ALTER COLUMN order_id TYPE TEXT/i);
    expect(migration).not.toMatch(/\b(DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
  });
});
