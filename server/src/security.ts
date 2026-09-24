import crypto from 'crypto';

/**
 * Constant-time comparison of two strings (such as API/cron secrets or tokens).
 * Uses SHA-256 hash comparison via crypto.timingSafeEqual to prevent
 * string content timing side-channels and string length timing leaks.
 */
export function timingSafeCompare(
  a: string | undefined | null,
  b: string | undefined | null
): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  if (!a || !b) {
    return false;
  }
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Escapes characters '%', '_', and '\' in user input before inserting into
 * a SQL ILIKE pattern (`%${escapeIlike(input)}%`).
 * Prevents wildcard injection and wildcard-induced full table scan / ReDoS attacks.
 */
export function escapeIlike(input: string): string {
  return input.replace(/[\\%_]/g, '\\$&');
}
