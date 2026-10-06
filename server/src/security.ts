import { timingSafeEqual } from 'crypto';

function headerString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) {
    return value[0];
  }
  return null;
}

// Constant-time compare for cron / job secrets. Rejects non-strings,
// empty/whitespace secrets, and mismatched lengths without throwing.
export function secretsEqual(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const trimmedExpected = expected.trim();
  const trimmedProvided = provided.trim();
  if (!trimmedExpected || !trimmedProvided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type JobAuthResult = 'ok' | 'missing' | 'unauthorized';

export function authorizeJobSecret(
  headers: Record<string, unknown>,
  expected: string | undefined,
  headerName: 'x-cron-secret' | 'x-report-secret' | 'x-ajio-secret'
): JobAuthResult {
  if (!expected || !expected.trim()) return 'missing';
  const provided = headerString(headers[headerName]) ||
    (headerName === 'x-ajio-secret' ? headerString(headers['x-cron-secret']) : null) ||
    (headerName === 'x-cron-secret' ? headerString(headers['x-ajio-secret']) : null);
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
  if (typeof storagePath !== 'string' || !orgId || !orgId.trim()) return false;
  // Reject path traversal, null bytes, backslashes, URL-encoded traversal, control characters, or excessive length
  if (
    storagePath.length > 512 ||
    storagePath.includes('..') ||
    storagePath.includes('\\') ||
    storagePath.includes('\0') ||
    /%2e/i.test(storagePath) ||
    /[\r\n\t]/.test(storagePath)
  ) {
    return false;
  }
  // Only safe path characters allowed: alphanumeric, dashes, underscores, dots, and slashes
  if (!/^[a-zA-Z0-9_\-\.\/]+$/.test(storagePath)) return false;

  const expected = `packing-videos/${orgId}/`;
  if (storagePath.startsWith(expected)) return true;
  return orgId === 'default' && storagePath.startsWith('packing-videos/default/');
}

const SENSITIVE_ERROR_PATTERNS = [
  /password/i,
  /token/i,
  /secret/i,
  /bearer/i,
  /credential/i,
  /syntax error/i,
  /relation\s+["'].*["']/i,
  /column\s+["'].*["']/i,
  /violates\s+.*constraint/i,
  /duplicate\s+key/i,
  /psql/i,
  /\bpg_/i,
  /\bpostgres/i,
  /\beconnrefused\b/i,
  /\betimedout\b/i,
  /\benotfound\b/i,
  /\b127\.0\.0\.1\b/,
  /\blocalhost\b/i,
  /\bport\s+\d+/i,
  /\b(select|insert|update|delete|drop|alter|truncate)\s+/i,
  /\n\s*at\s+/,
  /node:internal/,
  /[a-zA-Z]:\\[a-zA-Z0-9_\\.-]+/,
  /\/(?:var|home|app|usr|etc)\/[a-zA-Z0-9_\/.-]+/,
];

// Sanitize error messages before sending in API responses to prevent CWE-209
// information leakage (database structure, credentials, stack traces, host paths).
export function sanitizeErrorMessage(err: unknown, fallbackMessage = 'Internal server error'): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!raw || !raw.trim()) return fallbackMessage;

  // Preserved safe operational error patterns
  if (raw.includes('not configured')) {
    const match = raw.match(/([A-Z0-9_]+)\s+is not configured/i) || raw.match(/OMSGuru is not configured/i);
    return match ? match[0] : 'Required service is not configured';
  }
  if (raw.includes('throttled')) {
    return 'Service temporarily throttled';
  }

  // Check for sensitive signatures
  for (const pattern of SENSITIVE_ERROR_PATTERNS) {
    if (pattern.test(raw)) {
      return fallbackMessage;
    }
  }

  // Length and character safety check
  if (raw.length > 120 || /[\r\n<>]/.test(raw)) {
    return fallbackMessage;
  }

  return raw.trim();
}
