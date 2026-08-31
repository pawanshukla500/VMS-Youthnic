import fs from 'fs';

const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/vms';

function sslConfigFromEnv() {
  const sslMode = (process.env.PGSSL_MODE || process.env.PGSSLMODE || '').toLowerCase();
  const caPath = process.env.PGSSL_CA_CERT_PATH;
  const caCert = process.env.PGSSL_CA_CERT;

  if (sslMode === 'disable' || sslMode === 'false') {
    return false;
  }

  if (caCert || caPath) {
    return {
      rejectUnauthorized: true,
      ca: caCert || fs.readFileSync(caPath as string, 'utf8')
    };
  }

  if (sslMode === 'require' || sslMode === 'true') {
    return { rejectUnauthorized: false };
  }

  if (sslMode === 'verify-full') {
    return { rejectUnauthorized: true };
  }

  return undefined;
}

export function buildPostgresPoolConfig() {
  const ssl = sslConfigFromEnv();

  return {
    connectionString: process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 10000),
    ...(ssl !== undefined ? { ssl } : {})
  };
}
