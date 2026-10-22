import { describe, expect, it } from 'vitest';
import { advanceUploadIdentity, belongsToUploadIdentity, filterOwnedUploadRecords, filterUnscopedUserUploadRecords, getScopedUploadRecords, getUploadIdentityScopeKey, isUploadScopeCurrent, isUploadAttemptCurrent, normalizeUploadWorkerIdentityPatch } from '../utils/uploadOwnership';

describe('upload ownership', () => {
  it('keeps a queue row only for the same normalized email and organization', () => {
    expect(belongsToUploadIdentity(
      { packerId: 'Packer@Example.com', organizationId: 'org-a' },
      { email: 'packer@example.com', organizationId: 'org-a' },
    )).toBe(true);
  });

  it('does not upload or report another signed-in user’s local recording', () => {
    const rows = [
      { id: 'own', packerId: 'packer@example.com', organizationId: 'org-a' },
      { id: 'other', packerId: 'other@example.com', organizationId: 'org-a' },
    ];
    expect(filterOwnedUploadRecords(rows, { email: 'packer@example.com', organizationId: 'org-a' }))
      .toEqual([rows[0]]);
  });

  it('does not move the same user’s recording across organizations', () => {
    expect(belongsToUploadIdentity(
      { packerId: 'packer@example.com', organizationId: 'org-a' },
      { email: 'packer@example.com', organizationId: 'org-b' },
    )).toBe(false);
  });

  it('fails closed for legacy rows with no saved organization', () => {
    expect(belongsToUploadIdentity(
      { packerId: 'packer@example.com' },
      { email: 'packer@example.com', organizationId: 'org-a' },
    )).toBe(false);
  });

  it('keeps unscoped legacy recordings visible only to their saved user without making them upload-eligible', () => {
    const rows = [
      { id: 'legacy-own', packerId: 'packer@example.com' },
      { id: 'legacy-other', packerId: 'other@example.com' },
      { id: 'scoped', packerId: 'packer@example.com', organizationId: 'org-a' },
    ];
    expect(filterUnscopedUserUploadRecords(rows, { email: 'packer@example.com' }))
      .toEqual([rows[0]]);
    expect(filterOwnedUploadRecords(rows, { email: 'packer@example.com', organizationId: 'org-a' }))
      .toEqual([rows[2]]);
  });

  it('fails closed when either side has no user email', () => {
    expect(belongsToUploadIdentity(
      { packerId: 'UNKNOWN_PACKER', organizationId: 'org-a' },
      { email: null, organizationId: 'org-a' },
    )).toBe(false);
  });

  it('preserves explicit empty organization and email values so identity can be cleared', () => {
    expect(normalizeUploadWorkerIdentityPatch({ orgId: '', userEmail: '' })).toEqual({
      organizationId: '',
      email: '',
    });
  });

  it('increments the upload generation only when the owner or organization changes', () => {
    const current = { email: 'packer@example.com', organizationId: 'org-a', generation: 4 };
    expect(advanceUploadIdentity(current, { email: 'PACKER@example.com', organizationId: 'org-a' }))
      .toEqual({ identity: current, changed: false });
    expect(advanceUploadIdentity(current, { email: 'other@example.com', organizationId: 'org-b' }))
      .toEqual({ identity: { email: 'other@example.com', organizationId: 'org-b', generation: 5 }, changed: true });
  });

  it('hides cached queue rows synchronously when user, email, or organization scope changes', () => {
    const oldScope = getUploadIdentityScopeKey('user-a', { email: 'packer@example.com', organizationId: 'org-a' });
    const otherUserScope = getUploadIdentityScopeKey('user-b', { email: 'packer@example.com', organizationId: 'org-a' });
    const otherEmailScope = getUploadIdentityScopeKey('user-a', { email: 'other@example.com', organizationId: 'org-a' });
    const otherOrganizationScope = getUploadIdentityScopeKey('user-a', { email: 'packer@example.com', organizationId: 'org-b' });
    const rows = [{ id: 'private-old-scope' }];

    expect(isUploadScopeCurrent(oldScope, oldScope)).toBe(true);
    expect(getScopedUploadRecords(rows, oldScope, oldScope)).toEqual(rows);
    for (const newScope of [otherUserScope, otherEmailScope, otherOrganizationScope]) {
      expect(isUploadScopeCurrent(oldScope, newScope)).toBe(false);
      expect(getScopedUploadRecords(rows, oldScope, newScope)).toEqual([]);
    }
  });

  it('rejects an upload attempt after the authenticated identity changes', () => {
    const attempt = { email: 'packer@example.com', organizationId: 'org-a', generation: 2 };
    const current = { email: 'packer@example.com', organizationId: 'org-b', generation: 3 };
    expect(isUploadAttemptCurrent(
      attempt, current, 'packer@example.com',
      { packerId: 'packer@example.com', organizationId: 'org-a' },
    )).toBe(false);
    expect(isUploadAttemptCurrent(
      attempt, attempt, 'someone-else@example.com',
      { packerId: 'packer@example.com', organizationId: 'org-a' },
    )).toBe(false);
  });
});
