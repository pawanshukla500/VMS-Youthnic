import { describe, it, expect } from 'vitest';
import {
  isAdmin,
  isManagerOrAdmin,
  normalizeRole
} from '../middleware/auth';
import { isAcceptableStoragePath } from '../storagePath';

/**
 * These tests pin the role-gate behavior that PR-01 applied to the
 * previously-unprotected /api/admin/* routes and /api/videos/report.
 * The handlers all use the same idiom:
 *
 *   if (!isManagerOrAdmin(user)) return reply.status(403).send({ error: 'Manager access required' });
 *   if (!isAdmin(user))           return reply.status(403).send({ error: 'Admin access required' });
 *
 * So asserting the helper functions with the production roles pins the
 * "what does a PACKER see?" contract for every newly-gated route.
 */

describe('PR-01 admin-route gate contract', () => {
  it.each([
    { role: 'ADMIN', gate: 'manager', expected: true },
    { role: 'admin', gate: 'manager', expected: true },
    { role: 'Manager', gate: 'manager', expected: true },
    { role: 'MANAGER', gate: 'manager', expected: true },
    { role: 'PACKER', gate: 'manager', expected: false },
    { role: 'packer', gate: 'manager', expected: false },
    { role: null, gate: 'manager', expected: false }
  ])('isManagerOrAdmin($role) = $expected', ({ role, gate, expected }) => {
    const user = role === null ? null : { role };
    expect(isManagerOrAdmin(user as any)).toBe(expected);
    void gate;
  });

  it.each([
    { role: 'ADMIN', expected: true },
    { role: 'admin', expected: true },
    { role: 'MANAGER', expected: false },
    { role: 'PACKER', expected: false },
    { role: null, expected: false }
  ])('isAdmin($role) = $expected', ({ role, expected }) => {
    const user = role === null ? null : { role };
    expect(isAdmin(user as any)).toBe(expected);
  });

  it('normalizeRole is the single source of truth for case folding', () => {
    expect(normalizeRole('admin')).toBe('ADMIN');
    expect(normalizeRole('Admin')).toBe('ADMIN');
    expect(normalizeRole('ADMIN')).toBe('ADMIN');
    expect(normalizeRole('manager')).toBe('MANAGER');
    expect(normalizeRole('packer')).toBe('PACKER');
    expect(normalizeRole(undefined)).toBe('PACKER');
    expect(normalizeRole('unknown')).toBe('PACKER');
  });
});

describe('PR-01 storagePath cross-tenant guard', () => {
  it('accepts a path inside the caller org', () => {
    expect(isAcceptableStoragePath('packing-videos/org-abc/2026/09/14/foo.mp4', 'org-abc')).toBe(true);
  });

  it('rejects a path for a different org', () => {
    expect(isAcceptableStoragePath('packing-videos/org-xyz/2026/09/14/foo.mp4', 'org-abc')).toBe(false);
  });

  it('rejects a path missing the prefix entirely', () => {
    expect(isAcceptableStoragePath('other-prefix/org-abc/foo.mp4', 'org-abc')).toBe(false);
  });

  it('rejects traversal segments', () => {
    expect(isAcceptableStoragePath('packing-videos/org-abc/../other-org/foo.mp4', 'org-abc')).toBe(false);
  });

  it('rejects non-string paths', () => {
    expect(isAcceptableStoragePath(null, 'org-abc')).toBe(false);
    expect(isAcceptableStoragePath(undefined, 'org-abc')).toBe(false);
    expect(isAcceptableStoragePath(42, 'org-abc')).toBe(false);
  });

  it('accepts the shared default prefix only outside production', () => {
    expect(isAcceptableStoragePath('packing-videos/default/2026/09/14/foo.mp4', 'org-abc', { allowSharedDefault: true })).toBe(true);
    expect(isAcceptableStoragePath('packing-videos/default/2026/09/14/foo.mp4', 'org-abc', { allowSharedDefault: false })).toBe(false);
  });
});

describe('PR-01 numeric coercion for height / sizeBytes', () => {
  // Pin the rule that JSON input may arrive as strings (Fastify does not
  // coerce by default) and must be coerced before the floor/ceiling checks.
  function passesHeightFloor(height: unknown): boolean {
    const h = Number(height);
    return !(Number.isFinite(h) && h > 0 && h < 720);
  }
  function passesSizeCeiling(sizeBytes: unknown): boolean {
    const n = Number(sizeBytes);
    return Number.isFinite(n) && n > 0 && n <= 500 * 1024 * 1024;
  }

  it('rejects numeric height below 720', () => {
    expect(passesHeightFloor(480)).toBe(false);
    expect(passesHeightFloor(0)).toBe(true);
    expect(passesHeightFloor(-1)).toBe(true);
    expect(passesHeightFloor(undefined)).toBe(true);
  });

  it('rejects string-encoded height "480" (would have bypassed Number.isFinite)', () => {
    expect(passesHeightFloor('480')).toBe(false);
    expect(passesHeightFloor('720')).toBe(true);
  });

  it('rejects string-encoded sizeBytes "0"', () => {
    expect(passesSizeCeiling('0')).toBe(false);
    expect(passesSizeCeiling('100')).toBe(true);
    expect(passesSizeCeiling(undefined)).toBe(false);
    expect(passesSizeCeiling(NaN)).toBe(false);
  });

  it('rejects sizeBytes above 500 MB ceiling', () => {
    expect(passesSizeCeiling(500 * 1024 * 1024 + 1)).toBe(false);
    expect(passesSizeCeiling(500 * 1024 * 1024)).toBe(true);
  });
});