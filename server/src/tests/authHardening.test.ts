import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { secretsEqual, isJobAuthorized, syncOrgClaims } from '../middleware/auth';

const staleToken = (claims: Record<string, unknown>): DecodedIdToken =>
  claims as unknown as DecodedIdToken;

const setCustomUserClaims = vi.fn();

vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    verifyIdToken: vi.fn(async () => ({ uid: 'user123' })),
    setCustomUserClaims,
  }),
}));

describe('cron/job secret comparison', () => {
  it('accepts an exact match', () => {
    expect(secretsEqual('s3cr3t-value', 's3cr3t-value')).toBe(true);
  });

  it('rejects a same-length mismatch', () => {
    expect(secretsEqual('s3cr3t-value', 's3cr3t-valuf')).toBe(false);
  });

  it('rejects a different-length secret without leaking length timing', () => {
    expect(secretsEqual('short', 'a-much-longer-secret')).toBe(false);
  });

  it('fails closed on missing or non-string input', () => {
    expect(secretsEqual('', 's3cr3t-value')).toBe(false);
    expect(secretsEqual('s3cr3t-value', '')).toBe(false);
    expect(secretsEqual(undefined, 's3cr3t-value')).toBe(false);
    expect(secretsEqual('s3cr3t-value', undefined)).toBe(false);
    expect(secretsEqual(null, null)).toBe(false);
  });

  it('authorizes via either the header secret or the bearer secret', () => {
    expect(isJobAuthorized('cron-secret', 'wrong', 'cron-secret')).toBe(true);
    expect(isJobAuthorized('wrong', 'cron-secret', 'cron-secret')).toBe(true);
    expect(isJobAuthorized('wrong', 'also-wrong!', 'cron-secret')).toBe(false);
    expect(isJobAuthorized('cron-secret', 'cron-secret', undefined)).toBe(false);
  });
});

describe('syncOrgClaims (Firebase custom claims for Storage rules)', () => {
  beforeEach(() => {
    setCustomUserClaims.mockClear();
    setCustomUserClaims.mockResolvedValue(undefined);
  });

  it('skips the Admin SDK write when the token already carries current claims', async () => {
    await syncOrgClaims(staleToken({ organization_id: 'org1', role: 'PACKER' }), 'user123', 'org1', 'packer');
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it('writes normalized claims when the token is stale', async () => {
    await syncOrgClaims(staleToken({ organization_id: 'org-old', role: 'PACKER' }), 'user123', 'org1', 'packer');
    expect(setCustomUserClaims).toHaveBeenCalledWith('user123', {
      organization_id: 'org1',
      role: 'PACKER',
    });
  });

  it('writes claims when the token has none yet (pre-rollover)', async () => {
    await syncOrgClaims(staleToken({}), 'user123', 'org1', 'ADMIN');
    expect(setCustomUserClaims).toHaveBeenCalledWith('user123', {
      organization_id: 'org1',
      role: 'ADMIN',
    });
  });

  it('never throws when the Admin SDK write fails', async () => {
    setCustomUserClaims.mockRejectedValueOnce(new Error('iam unavailable'));
    await expect(
      syncOrgClaims(staleToken({}), 'user123', 'org1', 'PACKER')
    ).resolves.toBeUndefined();
  });
});
