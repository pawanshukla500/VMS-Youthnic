import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureOrgCustomClaims } from '../middleware/auth';

const mockGetUser = vi.fn();
const mockSetCustomUserClaims = vi.fn();

vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    getUser: mockGetUser,
    setCustomUserClaims: mockSetCustomUserClaims,
  }),
}));

describe('ensureOrgCustomClaims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets custom claims when user record in Firebase has no claims', async () => {
    mockGetUser.mockResolvedValueOnce({
      customClaims: {},
    });
    mockSetCustomUserClaims.mockResolvedValueOnce(undefined);

    const updated = await ensureOrgCustomClaims(
      'uid-123',
      'org-abc',
      'PACKER',
      null, // tokenOrgId is missing
      null
    );

    expect(mockSetCustomUserClaims).toHaveBeenCalledWith('uid-123', {
      orgId: 'org-abc',
      orgRole: 'PACKER',
    });
    expect(updated).toBe(true);
  });

  it('returns true to trigger client token refresh when claims exist in Auth DB but client token is missing orgId', async () => {
    mockGetUser.mockResolvedValueOnce({
      customClaims: { orgId: 'org-abc', orgRole: 'PACKER' },
    });

    const updated = await ensureOrgCustomClaims(
      'uid-123',
      'org-abc',
      'PACKER',
      null, // client token was minted before claims were synced
      null
    );

    // Should NOT write again to Auth DB since it already matches
    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
    // But MUST return true so client knows to force-refresh ID token
    expect(updated).toBe(true);
  });

  it('returns false when both Firebase Auth DB and client token already match', async () => {
    mockGetUser.mockResolvedValueOnce({
      customClaims: { orgId: 'org-abc', orgRole: 'PACKER' },
    });

    const updated = await ensureOrgCustomClaims(
      'uid-123',
      'org-abc',
      'PACKER',
      'org-abc',
      'PACKER'
    );

    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
    expect(updated).toBe(false);
  });

  it('updates claims and returns true when role changes', async () => {
    mockGetUser.mockResolvedValueOnce({
      customClaims: { orgId: 'org-abc', orgRole: 'PACKER' },
    });
    mockSetCustomUserClaims.mockResolvedValueOnce(undefined);

    const updated = await ensureOrgCustomClaims(
      'uid-123',
      'org-abc',
      'MANAGER',
      'org-abc',
      'PACKER'
    );

    expect(mockSetCustomUserClaims).toHaveBeenCalledWith('uid-123', {
      orgId: 'org-abc',
      orgRole: 'MANAGER',
    });
    expect(updated).toBe(true);
  });
});
