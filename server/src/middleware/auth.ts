import { FastifyRequest, FastifyReply } from 'fastify';
import { getAuth } from 'firebase-admin/auth';
import { Pool } from 'pg';
import { randomBytes } from 'crypto';

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

export function canLinkStation(
  caller: { role?: unknown } | null | undefined,
  targetRole: unknown
): boolean {
  if (isAdmin(caller)) return true;
  if (!isManagerRole((caller as any)?.role)) return false;
  return isPackerRole(targetRole);
}

// Storage rules bind packing-videos/{orgId}/** to request.auth.token.orgId.
// Write only when the ID token is missing/stale so /api/me stays cheap.
export async function ensureOrgCustomClaims(
  uid: string,
  organizationId: string,
  role: string,
  tokenOrgId: unknown,
  tokenOrgRole: unknown
): Promise<boolean> {
  const nextRole = normalizeRole(role);
  if (tokenOrgId === organizationId && tokenOrgRole === nextRole) return false;
  try {
    const record = await getAuth().getUser(uid);
    const existing = record.customClaims || {};
    if (existing.orgId === organizationId && existing.orgRole === nextRole) return false;
    await getAuth().setCustomUserClaims(uid, { ...existing, orgId: organizationId, orgRole: nextRole });
    return true;
  } catch (err) {
    console.warn('Custom claim sync skipped:', err instanceof Error ? err.message : err);
    return false;
  }
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
  if (provided.length > 256) {
    return { error: 'Password must not exceed 256 characters.' };
  }
  return { password: provided };
}

// Companion (Meesho link-up desktop app) tokens are NOT user logins: they
// carry their own COMPANION role and may only reach the endpoints the app
// uses — never the rest of the API (they used to act as ADMIN).
const COMPANION_ROUTES = new Set([
  'GET /api/meesho/companion-auth/check',
  'GET /api/meesho/credentials',
  'GET /api/meesho/flyer-queue',
  'POST /api/meesho/flyer-queue/link',
]);

export function companionRouteAllowed(method: unknown, url: unknown): boolean {
  if (typeof method !== 'string' || typeof url !== 'string') return false;
  const path = url.split('?')[0].replace(/\/+$/, '');
  return COMPANION_ROUTES.has(`${method.toUpperCase()} ${path}`);
}

export function isCompanion(user: any): boolean {
  return Boolean(user?.isCompanion);
}

export const authMiddleware = (pool: Pool) => async (request: FastifyRequest, reply: FastifyReply) => {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split('Bearer ')[1]?.trim();
  if (!token) {
    return reply.status(401).send({ error: 'Unauthorized: Empty token provided' });
  }

  // Support persistent Companion App tokens (e.g. Meesho Flyer Companion)
  if (token.startsWith('vms_comp_')) {
    if (!companionRouteAllowed(request.method, request.url)) {
      return reply.status(403).send({ error: 'Forbidden: companion app token cannot access this endpoint' });
    }
    try {
      const compRes = await pool.query(
        `SELECT ms.organization_id, o.name as org_name
         FROM meesho_settings ms
         JOIN organizations o ON ms.organization_id = o.id
         WHERE ms.companion_token = $1
         LIMIT 1`,
        [token]
      );
      if (compRes.rows.length === 0) {
        return reply.status(401).send({ error: 'Unauthorized: Invalid or revoked companion token' });
      }
      const row = compRes.rows[0];
      (request as any).user = {
        uid: `companion-${row.organization_id}`,
        user_id: `companion-${row.organization_id}`,
        organization_id: row.organization_id,
        role: 'COMPANION',
        orgName: row.org_name,
        isCompanion: true
      };
      return;
    } catch (compErr) {
      console.error('Failed to verify companion token:', compErr);
      return reply.status(500).send({ error: 'Internal error verifying companion token' });
    }
  }

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
      // Hostinger / production must never auto-create an ADMIN org just
      // because AUTO_PROVISION_USERS leaked into the compose env.
      if (process.env.AUTO_PROVISION_USERS !== 'true' || process.env.NODE_ENV === 'production') {
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
      role = normalizeRole(res.rows[0].role);
    }

    (request as any).user = {
      uid: firebaseUid,
      user_id,
      organization_id,
      role,
      tokenOrgId: (decodedToken as { orgId?: unknown }).orgId ?? null,
      tokenOrgRole: (decodedToken as { orgRole?: unknown }).orgRole ?? null,
    };

  } catch (error) {
    console.error('Auth verification failed:', error);
    return reply.status(401).send({ error: 'Unauthorized: Invalid token' });
  }
};
