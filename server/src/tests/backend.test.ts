import { describe, it, expect, vi } from 'vitest';
import { authMiddleware, isAdmin, isAdminRole, isManagerOrAdmin, normalizeRole, resolveUserPassword, effectiveCreateRole, canResetPassword } from '../middleware/auth';
import { escapeLikePattern } from '../videoReport';

// Mock DB pool
const mockQuery = vi.fn();
const mockPool = {
  query: mockQuery
};

// Mock Firebase Admin
vi.mock('firebase-admin/auth', () => {
  return {
    getAuth: () => ({
      verifyIdToken: vi.fn(async (token) => {
        if (token === 'valid-token') {
          return { uid: 'user123' };
        }
        if (token === 'valid-token-other-org') {
          return { uid: 'user456' };
        }
        throw new Error('Invalid token');
      })
    })
  };
});

describe('Backend Security & Multi-tenancy Tests', () => {
  
  it('Auth Middleware blocks unauthenticated requests', async () => {
    const middleware = authMiddleware(mockPool as any);
    const mockReply = { status: vi.fn().mockReturnThis(), send: vi.fn() };
    const mockReq = { headers: {} };
    
    await middleware(mockReq as any, mockReply as any);
    
    expect(mockReply.status).toHaveBeenCalledWith(401);
    expect(mockReply.send).toHaveBeenCalledWith({ error: 'Unauthorized: No token provided' });
  });

  it('Auth Middleware blocks invalid tokens', async () => {
    const middleware = authMiddleware(mockPool as any);
    const mockReply = { status: vi.fn().mockReturnThis(), send: vi.fn() };
    const mockReq = { headers: { authorization: 'Bearer invalid-token' } };
    
    await middleware(mockReq as any, mockReply as any);
    
    expect(mockReply.status).toHaveBeenCalledWith(401);
    expect(mockReply.send).toHaveBeenCalledWith({ error: 'Unauthorized: Invalid token' });
  });

  it('Organization Scoping: Assigns correct organization_id to user', async () => {
    const middleware = authMiddleware(mockPool as any);
    const mockReply = { status: vi.fn().mockReturnThis(), send: vi.fn() };
    const mockReq: any = { headers: { authorization: 'Bearer valid-token' } };
    
    mockQuery.mockResolvedValueOnce({
      rows: [{ user_id: 'u1', organization_id: 'org1', role: 'PACKER' }]
    });

    await middleware(mockReq, mockReply as any);
    
    expect(mockReq.user.organization_id).toBe('org1');
    expect(mockReq.user.user_id).toBe('u1');
    expect(mockReq.user.role).toBe('PACKER');
  });

  it('Cross-tenant Blocking: Valid token but missing DB membership blocks access', async () => {
    const middleware = authMiddleware(mockPool as any);
    const mockReply = { status: vi.fn().mockReturnThis(), send: vi.fn() };
    const mockReq: any = { headers: { authorization: 'Bearer valid-token' } };
    
    // Simulate user not found in this organization's membership table
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await middleware(mockReq, mockReply as any);
    
    expect(mockReply.status).toHaveBeenCalledWith(403);
    expect(mockReply.send).toHaveBeenCalledWith({ error: 'User does not belong to any organization' });
  });
});

describe('Admin role checks (case-insensitive)', () => {
  // Regression: roles are written as ADMIN/PACKER by some paths and
  // admin/packer by others (client user form). Strict 'admin' comparisons
  // locked every admin out of delete/user/station endpoints (403).
  it.each(['admin', 'ADMIN', 'Admin'])('isAdmin accepts %s', (role) => {
    expect(isAdminRole(role)).toBe(true);
    expect(isAdmin({ role })).toBe(true);
  });

  it.each(['packer', 'PACKER', '', null, undefined])('isAdmin rejects %s', (role) => {
    expect(isAdminRole(role)).toBe(false);
    expect(isAdmin({ role })).toBe(false);
  });

  it('normalizeRole uppercases and defaults to PACKER', () => {
    expect(normalizeRole('admin')).toBe('ADMIN');
    expect(normalizeRole('ADMIN')).toBe('ADMIN');
    expect(normalizeRole('manager')).toBe('MANAGER');
    expect(normalizeRole('MANAGER')).toBe('MANAGER');
    expect(normalizeRole('packer')).toBe('PACKER');
    expect(normalizeRole('')).toBe('PACKER');
    expect(normalizeRole(undefined)).toBe('PACKER');
    expect(normalizeRole('superuser')).toBe('PACKER');
  });

  it('manager has admin-area access but is not admin', () => {
    expect(isManagerOrAdmin({ role: 'MANAGER' })).toBe(true);
    expect(isManagerOrAdmin({ role: 'manager' })).toBe(true);
    expect(isManagerOrAdmin({ role: 'ADMIN' })).toBe(true);
    expect(isManagerOrAdmin({ role: 'PACKER' })).toBe(false);
    expect(isManagerOrAdmin(null)).toBe(false);
    expect(isAdmin({ role: 'MANAGER' })).toBe(false);
  });
});

describe('manager delegation boundaries', () => {
  it('managers can only ever create PACKER accounts', () => {
    expect(effectiveCreateRole({ role: 'MANAGER' }, 'admin')).toBe('PACKER');
    expect(effectiveCreateRole({ role: 'manager' }, 'manager')).toBe('PACKER');
    expect(effectiveCreateRole({ role: 'MANAGER' }, 'packer')).toBe('PACKER');
    expect(effectiveCreateRole({ role: 'PACKER' }, 'admin')).toBe('PACKER');
    expect(effectiveCreateRole(null, 'admin')).toBe('PACKER');
  });

  it('admins keep full role choice on create', () => {
    expect(effectiveCreateRole({ role: 'ADMIN' }, 'manager')).toBe('MANAGER');
    expect(effectiveCreateRole({ role: 'admin' }, 'ADMIN')).toBe('ADMIN');
    expect(effectiveCreateRole({ role: 'ADMIN' }, 'nonsense')).toBe('PACKER');
  });

  it('managers can only reset packer passwords', () => {
    expect(canResetPassword({ role: 'MANAGER' }, 'PACKER')).toBe(true);
    expect(canResetPassword({ role: 'manager' }, 'packer')).toBe(true);
    expect(canResetPassword({ role: 'MANAGER' }, 'MANAGER')).toBe(false);
    expect(canResetPassword({ role: 'MANAGER' }, 'ADMIN')).toBe(false);
    expect(canResetPassword({ role: 'MANAGER' }, null)).toBe(false);
    expect(canResetPassword({ role: 'PACKER' }, 'PACKER')).toBe(false);
  });

  it('admins can reset anyone', () => {
    expect(canResetPassword({ role: 'ADMIN' }, 'PACKER')).toBe(true);
    expect(canResetPassword({ role: 'ADMIN' }, 'ADMIN')).toBe(true);
  });
});

describe('resolveUserPassword', () => {
  it('accepts an explicit password of 6+ chars', () => {
    expect(resolveUserPassword('packer-2026')).toEqual({ password: 'packer-2026' });
  });

  it('rejects short passwords', () => {
    expect(resolveUserPassword('abc')).toEqual({ error: 'Password must be at least 6 characters.' });
  });

  it('generates a random password when omitted', () => {
    const a = resolveUserPassword(undefined);
    const b = resolveUserPassword('');
    if (!('password' in a) || !('password' in b)) throw new Error('expected generated passwords');
    expect(a.password.length).toBeGreaterThanOrEqual(12);
    expect(b.password).not.toBe(a.password);
  });
});

describe('escapeLikePattern', () => {
  it('escapes %, _, and \\ in like search patterns', () => {
    expect(escapeLikePattern('100%_real\\test')).toBe('100\\%\\_real\\\\test');
    expect(escapeLikePattern('normal-string')).toBe('normal-string');
  });
});
