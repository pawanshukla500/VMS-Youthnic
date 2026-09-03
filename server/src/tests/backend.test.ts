import { describe, it, expect, vi } from 'vitest';
import { authMiddleware, isAdmin, isAdminRole, normalizeRole } from '../middleware/auth';

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
    expect(normalizeRole('packer')).toBe('PACKER');
    expect(normalizeRole('')).toBe('PACKER');
    expect(normalizeRole(undefined)).toBe('PACKER');
    expect(normalizeRole('superuser')).toBe('PACKER');
  });
});
