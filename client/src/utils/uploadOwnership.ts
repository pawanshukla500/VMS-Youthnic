export interface UploadOwnership {
  packerId?: string | null;
  organizationId?: string | null;
}

export interface UploadIdentity {
  email?: string | null;
  organizationId?: string | null;
}

export function getUploadIdentityScopeKey(userId: string | null | undefined, identity: UploadIdentity): string {
  return JSON.stringify([normalized(userId), normalized(identity.email), normalized(identity.organizationId)]);
}

export function isUploadScopeCurrent(loadedScopeKey: string, currentScopeKey: string): boolean {
  return loadedScopeKey !== '' && loadedScopeKey === currentScopeKey;
}

export function getScopedUploadRecords<T>(records: T[], loadedScopeKey: string, currentScopeKey: string): T[] {
  return isUploadScopeCurrent(loadedScopeKey, currentScopeKey) ? records : [];
}

export interface UploadIdentitySnapshot {
  email: string;
  organizationId: string;
  generation: number;
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function belongsToUploadIdentity(record: UploadOwnership, identity: UploadIdentity): boolean {
  const ownerEmail = normalized(record.packerId);
  const currentEmail = normalized(identity.email);
  if (!ownerEmail || ownerEmail === 'unknown_packer' || !currentEmail || ownerEmail !== currentEmail) {
    return false;
  }

  const recordOrganization = normalized(record.organizationId);
  if (!recordOrganization) return false;
  const currentOrganization = normalized(identity.organizationId);
  return Boolean(currentOrganization) && recordOrganization === currentOrganization;
}

export function filterOwnedUploadRecords<T extends UploadOwnership>(records: T[], identity: UploadIdentity): T[] {
  return records.filter((record) => belongsToUploadIdentity(record, identity));
}

export function filterUnscopedUserUploadRecords<T extends UploadOwnership>(records: T[], identity: UploadIdentity): T[] {
  const currentEmail = normalized(identity.email);
  if (!currentEmail) return [];
  return records.filter((record) => {
    const ownerEmail = normalized(record.packerId);
    return ownerEmail !== ''
      && ownerEmail !== 'unknown_packer'
      && ownerEmail === currentEmail
      && !normalized(record.organizationId);
  });
}

export function normalizeUploadWorkerIdentityPatch(payload: { orgId?: unknown; userEmail?: unknown }): {
  email?: string;
  organizationId?: string;
} {
  return {
    ...(typeof payload.userEmail === 'string' ? { email: payload.userEmail } : {}),
    ...(typeof payload.orgId === 'string' ? { organizationId: payload.orgId } : {}),
  };
}

export function advanceUploadIdentity(
  current: UploadIdentitySnapshot,
  patch: { email?: unknown; organizationId?: unknown },
): { identity: UploadIdentitySnapshot; changed: boolean } {
  const email = patch.email === undefined ? current.email : normalized(patch.email);
  const organizationId = patch.organizationId === undefined
    ? current.organizationId
    : normalized(patch.organizationId);
  const changed = email !== current.email || organizationId !== current.organizationId;
  return {
    identity: changed ? { email, organizationId, generation: current.generation + 1 } : current,
    changed,
  };
}

export function isUploadAttemptCurrent(
  attempt: UploadIdentitySnapshot,
  current: UploadIdentitySnapshot,
  authenticatedEmail: string | null | undefined,
  record: UploadOwnership,
): boolean {
  return attempt.generation === current.generation
    && attempt.email === current.email
    && attempt.organizationId === current.organizationId
    && belongsToUploadIdentity(record, {
      email: attempt.email,
      organizationId: attempt.organizationId,
    })
    && normalized(authenticatedEmail) === attempt.email;
}
