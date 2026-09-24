// Cron/job shared-secret auth (timing-safe).
//
// The /api/jobs/* endpoints authenticate callers with a long random secret
// sent as `x-cron-secret` (or `x-report-secret` for the daily report) or an
// `Authorization: Bearer` value. Plain `!==` string comparison leaks the
// secret byte-by-byte through timing, so every comparison here goes through
// crypto.timingSafeEqual with a length check first.
import { timingSafeEqual } from 'crypto';
import type { FastifyRequest } from 'fastify';

// Constant-time string equality. Returns false (never throws) for
// non-strings and mismatched lengths so callers fail closed.
export function secretsEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function bearerSecret(req: FastifyRequest): string | null {
  const authorization = req.headers.authorization || '';
  return authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : null;
}

// True when the request carries the expected job secret via the custom
// header or a Bearer token. Fails closed when the secret is unconfigured.
export function isJobAuthorized(
  req: FastifyRequest,
  expectedSecret: string | undefined,
  headerName = 'x-cron-secret'
): boolean {
  if (!expectedSecret) return false;
  const headerValue = req.headers[headerName];
  const provided = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return secretsEqual(provided, expectedSecret) || secretsEqual(bearerSecret(req), expectedSecret);
}
