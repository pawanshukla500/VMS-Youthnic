import { FastifyRequest, FastifyReply } from 'fastify';
import { DecodedIdToken, getAuth } from 'firebase-admin/auth';
import { Pool } from 'pg';
import { randomBytes, timingSafeEqual } from 'crypto';

// Roles are stored inconsistently across write paths ('ADMIN' vs 'admin',
// 'PACKER' vs 'packer'), so every authorization check must be
// case-insensitive and every write must normalize to uppercase.
export function isAdminRole(role: unknown): boolean {
  return typeof role === 'string' && role.toLowerCase() === 'admin';
}

export function isManagerRole(role: unknown): boolean {
  return typeof role === 'string' && role.toLowerCase() === 'manager';
}

export function isPackerRole(role: unknown): boolean {
  return typeof role === 'string' && role.toLowerCase() === 'packer';
}

export function isAdmin(user: { role?: unknown } | null | undefined): boolean {
  return !!user && isAdminRole((user as any).role);
}

// Packing Manager: everything except user control and system settings.
export function isManagerOrAdmin(user: { role?: unknown } | null | undefined): boolean {
  if (!user) return false;
  const role = (user as any).role;
  return isAdminRole(role) || isManagerRole(role);
}

// Manager delegation boundaries (server-enforced, never trust the UI):
// a manager may only ever create PACKER accounts, and may only reset
// passwords of PACKER accounts. Admins are unrestricted.
export function effectiveCreateRole(
  caller: { role?: unknown } | null | undefined,
  requested: unknown
): 'ADMIN' | 'MANAGER' | 'PACKER' {
  if (isAdmin(caller)) return normalizeRole(requested);
  return 'PACKER';
}

export function canResetPassword(
  caller: { role?: unknown } | null | undefined,
  targetRole: unknown
): boolean {
  if (isAdmin(caller)) return true;
  if (!isManagerRole((caller as any)?.role)) return false;
  // Strict packer check (NOT the normalizeRole default): unknown or missing
  // target roles fail closed.
  return isPackerRole(targetRole);
}

export function normalizeRole(role: unknown): 'ADMIN' | 'MANAGER' | 'PACKER' {
  if (isAdminRole(role)) return 'ADMIN';
  if (isManagerRole(role)) return 'MANAGER';
  return 'PACKER';
}

// Admin-set passwords: explicit value wins (Firebase floor: 6 chars),
// otherwise a random 12-char temp password. Never hardcode one — every
// packing account sharing 'Welcome@123' was a standing breach.
export function resolveUserPassword(provided: unknown): { password: string } | { error: string } {
  if (provided === undefined || provided === null || provided === '') {
    return { password: randomBytes(9).toString('base64url') };
  }
  if (typeof provided !== 'string' || provided.length < 6) {
    return { error: 'Password must be at least 6 characters.' };
  }
  return { password: provided };
}

// Compare a presented cron/job secret against the configured value without
// leaking prefix information through response timing. Plain `!==` returns
// after the first differing byte, so an attacker measuring 401 latency can
// brute-force the secret one character at a time. timingSafeEqual always
// compares every byte; different lengths fail closed before comparing.
export function secretsEqual(presented: unknown, expected: unknown): boolean {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (!presented || !expected) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Cron/job endpoints accept the secret via either channel; exactly one must
// match. Kept as a helper so all five job routes share the same semantics.
export function isJobAuthorized(
  headerSecret: unknown,
  bearerSecret: unknown,
  expectedSecret: unknown
): boolean {
  return secretsEqual(headerSecret, expectedSecret) || secretsEqual(bearerSecret, expectedSecret);
}

// Mirror the PostgreSQL membership onto Firebase custom claims so Firebase
// Storage rules can enforce per-org isolation (`packing-videos/{orgId}/…`)
// without a server round-trip. Best-effort by design: claims only take
// effect on the next ID-token refresh anyway, so a slow/failed write must
// never fail the request it rode along with. Skips the write when the
// token already carries the current values to avoid an Admin SDK call on
// every authenticated request.
export async function syncOrgClaims(
  decodedToken: DecodedIdToken,
  firebaseUid: string,
  organizationId: string,
  role: unknown
): Promise<void> {
  try {
    const normalizedRole = normalizeRole(role);
    const token = decodedToken as DecodedIdToken & { organization_id?: unknown; role?: unknown };
    if (token.organization_id === organizationId && token.role === normalizedRole) return;
    const auth = getAuth();
    if (typeof (auth as any)?.setCustomUserClaims !== 'function') return;
    await (auth as any).setCustomUserClaims(firebaseUid, {
      organization_id: organizationId,
      role: normalizedRole,
    });
  } catch {
    // Claims are a defense-in-depth layer; the request itself is already
    // authorized via verifyIdToken + organization_members above.
  }
}

export const authMiddleware = (pool: Pool) => async (request: FastifyRequest, reply: FastifyReply) => {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await getAuth().verifyIdToken(token);
    const firebaseUid = decodedToken.uid;

    // Look up the user in PostgreSQL
    const res = await pool.query(
      `SELECT u.id as user_id, om.organization_id, om.role
       FROM users u
       LEFT JOIN organization_members om ON u.id = om.user_id
       WHERE u.firebase_uid = $1 LIMIT 1`,
      [firebaseUid]
    );

    let user_id;
    let organization_id;
    let role;

    if (res.rows.length === 0 || !res.rows[0].organization_id) {
      if (process.env.AUTO_PROVISION_USERS !== 'true') {
        return reply.status(403).send({ error: 'User does not belong to any organization' });
      }

      // Optional development-only first login provisioning.
      try {
        const orgRes = await pool.query(
          `INSERT INTO organizations (id, name, created_at)
           VALUES (gen_random_uuid(), $1, NOW())
           RETURNING id`,
          ['Default Organization']
        );
        const defaultOrgId = orgRes.rows[0]?.id;
        if (!defaultOrgId) {
          throw new Error('Failed to create default organization');
        }

        const userRes = await pool.query(
          `INSERT INTO users (id, firebase_uid, email, name, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, NOW())
           ON CONFLICT (firebase_uid)
           DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
           RETURNING id`,
          [firebaseUid, decodedToken.email || 'unknown@example.com', decodedToken.name || 'Unknown User']
        );
        const actualUserId = userRes.rows[0]?.id;
        if (!actualUserId) {
          throw new Error('Failed to create user');
        }
        
        await pool.query(
          'INSERT INTO organization_members (organization_id, user_id, role, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (organization_id, user_id) DO NOTHING',
          [defaultOrgId, actualUserId, 'ADMIN']
        );
        
        user_id = actualUserId;
        organization_id = defaultOrgId;
        role = 'ADMIN';
      } catch (provisionErr) {
        console.error('Failed to auto-provision user:', provisionErr);
        return reply.status(403).send({ error: 'User does not belong to any organization' });
      }
    } else {
      user_id = res.rows[0].user_id;
      organization_id = res.rows[0].organization_id;
      role = res.rows[0].role;
    }

    (request as any).user = {
      uid: firebaseUid,
      user_id,
      organization_id,
      role
    };

    // Best-effort: keep Firebase custom claims in sync so Storage rules can
    // enforce org isolation. Never fails the request (see syncOrgClaims).
    await syncOrgClaims(decodedToken, firebaseUid, organization_id, role);

  } catch (error) {
    console.error('Auth verification failed:', error);
    return reply.status(401).send({ error: 'Unauthorized: Invalid token' });
  }
};
