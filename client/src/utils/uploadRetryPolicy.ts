export type UploadQueueStatus = 'pending' | 'uploading' | 'failed' | 'completed';

const RETRY_DELAYS_MS = [
  15_000,
  30_000,
  60_000,
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
  20 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  4 * 60 * 60_000,
  6 * 60 * 60_000,
] as const;

export const MAX_RETRY_DELAY_MS = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
export const UPLOAD_LEASE_MS = 10 * 60_000;

export interface UploadClaimState {
  status: UploadQueueStatus | 'completed';
  retryCount: number;
  uploadProgress: number;
  nextRetryAt?: number;
  uploadLeaseUntil?: number;
  uploadLeaseGeneration?: number;
  error?: string;
}

export interface UploadLeaseState {
  status: UploadQueueStatus | 'completed';
  uploadLeaseUntil?: number;
  uploadLeaseGeneration?: number;
}

export function ownsUploadLease(record: UploadLeaseState, generation: number, now = Date.now()): boolean {
  return Number.isSafeInteger(generation)
    && Number.isSafeInteger(record.uploadLeaseGeneration)
    && record.uploadLeaseGeneration === generation
    && record.status === 'uploading'
    && Number.isFinite(record.uploadLeaseUntil)
    && Number(record.uploadLeaseUntil) > now;
}

function nextUploadLeaseGeneration(current?: number): number {
  const generation = Number.isSafeInteger(current) && Number(current) >= 0 ? Number(current) : 0;
  if (generation >= Number.MAX_SAFE_INTEGER) throw new Error('Upload lease generation exhausted');
  return generation + 1;
}

export function isUsableVideoBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob && value.size > 0;
}

export type UploadClaimPlan = {
  kind: 'claim' | 'blocked' | 'retry-scheduled';
  changes: Partial<UploadClaimState>;
};

/** Pure state transition used inside an IndexedDB readwrite claim transaction. */
export function planUploadClaim(record: UploadClaimState, now = Date.now()): UploadClaimPlan {
  if (record.status === 'completed') return { kind: 'blocked', changes: {} };

  if (record.status === 'uploading') {
    if (Number.isFinite(record.uploadLeaseUntil) && Number(record.uploadLeaseUntil) > now) {
      return { kind: 'blocked', changes: {} };
    }
    const retry = getNextRetryState(record.retryCount || 0, now);
    return {
      kind: 'retry-scheduled',
      changes: {
        status: 'failed',
        retryCount: retry.retryCount,
        uploadLeaseUntil: undefined,
        nextRetryAt: retry.nextRetryAt,
        error: 'Previous upload was interrupted; retry scheduled',
      },
    };
  }

  if (record.status === 'failed' && Number.isFinite(record.nextRetryAt) && Number(record.nextRetryAt) > now) {
    return { kind: 'blocked', changes: {} };
  }

  return {
    kind: 'claim',
    changes: {
      status: 'uploading',
      uploadProgress: 0,
      uploadLeaseUntil: now + UPLOAD_LEASE_MS,
      uploadLeaseGeneration: nextUploadLeaseGeneration(record.uploadLeaseGeneration),
      nextRetryAt: undefined,
    },
  };
}

/** Delay for the next automatic retry. Retries keep running indefinitely. */
export function getRetryDelayMs(retryCount: number): number {
  const attemptIndex = Math.max(0, Math.floor(Number(retryCount) || 0) - 1);
  return RETRY_DELAYS_MS[Math.min(attemptIndex, RETRY_DELAYS_MS.length - 1)];
}

export function getNextRetryState(retryCount: number, now = Date.now()): { retryCount: number; nextRetryAt: number } {
  const nextCount = Math.max(0, Math.floor(Number(retryCount) || 0)) + 1;
  return { retryCount: nextCount, nextRetryAt: now + getRetryDelayMs(nextCount) };
}

export function planUploadFailure(record: UploadClaimState, error: string, now = Date.now()): Partial<UploadClaimState> {
  const retry = getNextRetryState(record.retryCount || 0, now);
  return {
    status: 'failed',
    retryCount: retry.retryCount,
    nextRetryAt: retry.nextRetryAt,
    uploadLeaseUntil: undefined,
    error,
  };
}

export interface RetryQueueRecordState {
  status: UploadQueueStatus | 'completed';
  retryCount: number;
  uploadProgress: number;
  nextRetryAt?: number;
  uploadLeaseUntil?: number;
  uploadLeaseGeneration?: number;
  error?: string;
}

export interface AdminRetryCommandState extends RetryQueueRecordState {
  blob?: unknown;
  lastAppliedRetryCommandId?: string;
}

export type AdminRetryRecord<T extends RetryQueueRecordState> = Omit<
  T,
  'status' | 'retryCount' | 'uploadProgress' | 'nextRetryAt' | 'uploadLeaseUntil' | 'error'
> & {
  status: 'pending';
  retryCount: 0;
  uploadProgress: 0;
  nextRetryAt?: undefined;
  uploadLeaseUntil?: undefined;
  error?: undefined;
};

/** Reset metadata for an admin-requested retry without touching the local blob. */
export function resetForAdminRetry<T extends RetryQueueRecordState>(record: T): AdminRetryRecord<T> | null {
  if (record.status === 'completed') return null;
  return {
    ...record,
    status: 'pending',
    retryCount: 0,
    uploadProgress: 0,
    nextRetryAt: undefined,
    uploadLeaseUntil: undefined,
    error: undefined,
  };
}

/** Apply a retry command only once even when server delivery is retried after an ack timeout. */
export function planAdminRetryCommand(record: AdminRetryCommandState, commandId: string, now = Date.now()): {
  available: boolean;
  applied: boolean;
  changes: Partial<AdminRetryCommandState>;
} {
  if (record.status === 'completed') return { available: false, applied: false, changes: {} };
  if (!isUsableVideoBlob(record.blob)) return { available: false, applied: false, changes: {} };
  if (record.status === 'uploading' && Number.isFinite(record.uploadLeaseUntil) && Number(record.uploadLeaseUntil) > now) {
    return { available: true, applied: false, changes: {} };
  }
  if (record.lastAppliedRetryCommandId === commandId) return { available: true, applied: false, changes: {} };
  return {
    available: true,
    applied: true,
    changes: {
      status: 'pending',
      retryCount: 0,
      uploadProgress: 0,
      nextRetryAt: undefined,
      uploadLeaseUntil: undefined,
      error: undefined,
      lastAppliedRetryCommandId: commandId,
    },
  };
}

/** Whether a local row is eligible for another automatic attempt right now. */
export function shouldAutoRetry(
  status: UploadQueueStatus,
  _retryCount: number,
  nextRetryAt?: number,
  now = Date.now(),
  uploadLeaseUntil?: number,
): boolean {
  if (status === 'completed') return false;
  if (status === 'uploading') {
    // Legacy uploading rows have no lease and are recovered transactionally.
    return !Number.isFinite(uploadLeaseUntil) || Number(uploadLeaseUntil) <= now;
  }
  if (status === 'pending') return true;
  // Legacy failed rows have no persisted deadline and are eligible immediately.
  return !Number.isFinite(nextRetryAt) || Number(nextRetryAt) <= now;
}
