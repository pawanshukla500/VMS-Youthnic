import { timingSafeEqual } from 'crypto';

function headerString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) {
    return value[0];
  }
  return null;
}

// Constant-time compare for cron / job secrets. Rejects non-strings and
// mismatched lengths without throwing (timingSafeEqual requires equal size).
export function secretsEqual(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type JobAuthResult = 'ok' | 'missing' | 'unauthorized';

export function authorizeJobSecret(
  headers: Record<string, unknown>,
  expected: string | undefined,
  headerName: 'x-cron-secret' | 'x-report-secret'
): JobAuthResult {
  if (!expected) return 'missing';
  const provided = headerString(headers[headerName]);
  const authorization = headerString(headers.authorization) || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  if (secretsEqual(provided, expected) || secretsEqual(bearer, expected)) return 'ok';
  return 'unauthorized';
}

export function jobAuthReply(
  result: JobAuthResult,
  envName: string
): { status: number; body: { error: string } } | null {
  if (result === 'missing') return { status: 503, body: { error: `${envName} is not configured` } };
  if (result === 'unauthorized') return { status: 401, body: { error: 'Unauthorized job request' } };
  return null;
}

export const JOB_RATE_LIMIT = { max: 10, timeWindow: '1 minute' as const };
export const DOWNLOAD_RATE_LIMIT = { max: 30, timeWindow: '1 minute' as const };
export const PLAYBACK_URL_TTL_MS = 10 * 60 * 1000;

// Client Storage paths must live under packing-videos/{orgId}/. The old
// VITE_ORG_ID=default fallback is only valid when this org's id is literally
// "default" — otherwise any packer could overwrite another tenant's pointer.
export function isAcceptableStoragePath(storagePath: unknown, orgId: string): boolean {
  if (typeof storagePath !== 'string' || !orgId || storagePath.includes('..')) return false;
  const expected = `packing-videos/${orgId}/`;
  if (storagePath.startsWith(expected)) return true;
  return orgId === 'default' && storagePath.startsWith('packing-videos/default/');
}
