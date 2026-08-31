import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { buildPostgresPoolConfig } from './poolConfig';

dotenv.config();

const pool = new Pool(buildPostgresPoolConfig());

async function runMigrations() {
  const client = await pool.connect();
  try {
    console.log('Starting migrations...');
    await client.query('BEGIN');
    
    // Create migrations table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    
    const { rows } = await client.query('SELECT name FROM migrations');
    const executedMigrations = new Set(rows.map(r => r.name));
    
    for (const file of files) {
      if (!executedMigrations.has(file)) {
        console.log(`Executing migration: ${file}`);
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await client.query(sql);
        await client.query('INSERT INTO migrations (name) VALUES ($1)', [file]);
        console.log(`Completed migration: ${file}`);
      }
    }
    
    await client.query('COMMIT');
    console.log('All migrations executed successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    client.release();
    pool.end();
  }
}

runMigrations();
