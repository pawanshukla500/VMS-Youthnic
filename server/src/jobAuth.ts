import { timingSafeEqual } from 'crypto';

// Job routes compare a shared secret from a header or Bearer token.
// Length is checked first so timingSafeEqual never throws, and a mismatch
// does not leak the secret length through a variable-time string compare.
export function jobSecretMatches(expected: string | undefined, ...provided: unknown[]): boolean {
  if (!expected) return false;
  const expectedBuf = Buffer.from(expected);
  if (expectedBuf.length === 0) return false;
  return provided.some((value) => {
    if (typeof value !== 'string' || value.length === 0) return false;
    const got = Buffer.from(value);
    if (got.length !== expectedBuf.length) return false;
    return timingSafeEqual(got, expectedBuf);
  });
}
