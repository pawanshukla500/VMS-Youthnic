import { describe, expect, it } from 'vitest';
import { getNextRetryState, getRetryDelayMs, ownsUploadLease, planAdminRetryCommand, planUploadClaim, planUploadFailure, resetForAdminRetry, shouldAutoRetry, UPLOAD_LEASE_MS } from '../utils/uploadRetryPolicy';

describe('automatic video upload retry policy', () => {
  it('backs off exponentially and caps the delay at six hours', () => {
    expect(getRetryDelayMs(1)).toBe(15_000);
    expect(getRetryDelayMs(2)).toBe(30_000);
    expect(getRetryDelayMs(3)).toBe(60_000);
    expect(getRetryDelayMs(20)).toBe(6 * 60 * 60 * 1000);
  });

  it('persists the next retry deadline with the incremented retry count', () => {
    expect(getNextRetryState(0, 1_000)).toEqual({ retryCount: 1, nextRetryAt: 16_000 });
    expect(getNextRetryState(20, 1_000)).toEqual({ retryCount: 21, nextRetryAt: 21_601_000 });
  });

  it('continues retrying after the old dead-letter threshold when due', () => {
    const now = 1_800_000_000_000;
    expect(shouldAutoRetry('failed', 20, now - 1, now)).toBe(true);
  });

  it('waits until the persisted next retry time', () => {
    const now = 1_800_000_000_000;
    expect(shouldAutoRetry('failed', 4, now + 1, now)).toBe(false);
    expect(shouldAutoRetry('failed', 4, undefined, now)).toBe(true);
  });

  it('does not retry an upload with a live lease and makes an expired lease eligible for recovery', () => {
    const now = 1_800_000_000_000;
    expect(shouldAutoRetry('uploading', 0, undefined, now, now + 1)).toBe(false);
    expect(shouldAutoRetry('uploading', 0, undefined, now, now - 1)).toBe(true);
    expect(shouldAutoRetry('uploading', 0, undefined, now)).toBe(true);
  });

  it('schedules exponential backoff after recovering a crashed upload', () => {
    const now = 1_800_000_000_000;
    expect(planUploadClaim({
      status: 'uploading', retryCount: 1, uploadProgress: 51,
      uploadLeaseUntil: now - 1, error: 'old attempt',
    }, now)).toEqual({
      kind: 'retry-scheduled',
      changes: {
        status: 'failed', retryCount: 2,
        uploadLeaseUntil: undefined, nextRetryAt: now + 30_000,
        error: 'Previous upload was interrupted; retry scheduled',
      },
    });
  });

  it('atomically claims a due pending row with a bounded upload lease', () => {
    const now = 1_800_000_000_000;
    expect(planUploadClaim({ status: 'pending', retryCount: 0, uploadProgress: 0 }, now)).toEqual({
      kind: 'claim',
      changes: {
        status: 'uploading', uploadProgress: 0,
        uploadLeaseUntil: now + UPLOAD_LEASE_MS, uploadLeaseGeneration: 1, nextRetryAt: undefined,
      },
    });
  });

  it('commits a caught upload failure and its retry deadline in one state transition', () => {
    const now = 1_800_000_000_000;
    expect(planUploadFailure({
      status: 'uploading', retryCount: 3, uploadProgress: 72, uploadLeaseUntil: now + 50_000,
    }, 'network failure', now)).toEqual({
      status: 'failed', retryCount: 4, nextRetryAt: now + 2 * 60_000,
      uploadLeaseUntil: undefined, error: 'network failure',
    });
  });

  it('resets a remote-retry row but preserves its local video bytes', () => {
    const blob = { marker: 'video-bytes' };
    const retried = resetForAdminRetry({
      id: 'recording-id', status: 'failed' as const, retryCount: 25, nextRetryAt: 9_000,
      uploadProgress: 77, error: 'offline', blob,
    });
    expect(retried).toMatchObject({ status: 'pending', retryCount: 0, uploadProgress: 0, blob });
    expect(retried?.error).toBeUndefined();
    expect(retried?.nextRetryAt).toBeUndefined();
    expect(resetForAdminRetry({ status: 'completed' as const, retryCount: 0, uploadProgress: 100 })).toBeNull();
  });

  it('does not reset backoff when the same admin command is delivered again', () => {
    const record = {
      status: 'failed' as const, retryCount: 5, uploadProgress: 63, nextRetryAt: 9_000,
      uploadLeaseUntil: 10_000, error: 'network', lastAppliedRetryCommandId: 'command-a',
      blob: new Blob(['video-bytes'], { type: 'video/webm' }),
    };
    expect(planAdminRetryCommand(record, 'command-a')).toEqual({
      available: true, applied: false, changes: {},
    });
  });

  it('applies a new admin command once while preserving local video bytes', () => {
    const record = {
      status: 'failed' as const, retryCount: 5, uploadProgress: 63, nextRetryAt: 9_000,
      uploadLeaseUntil: 10_000, error: 'network', lastAppliedRetryCommandId: 'command-a',
      blob: new Blob(['video-bytes'], { type: 'video/webm' }),
    };
    expect(planAdminRetryCommand(record, 'command-b')).toEqual({
      available: true,
      applied: true,
      changes: {
        status: 'pending', retryCount: 0, uploadProgress: 0,
        nextRetryAt: undefined, uploadLeaseUntil: undefined, error: undefined,
        lastAppliedRetryCommandId: 'command-b',
      },
    });
  });

  it('does not reset an upload while another active lease is still valid', () => {
    const now = 1_800_000_000_000;
    expect(planAdminRetryCommand({
      status: 'uploading', retryCount: 3, uploadProgress: 65,
      uploadLeaseUntil: now + 60_000,
      blob: new Blob(['video-bytes'], { type: 'video/webm' }),
    }, 'command-a', now)).toEqual({
      available: true, applied: false, changes: {},
    });
  });

  it('does not retry a completed recording', () => {
    expect(shouldAutoRetry('completed', 0, undefined, 100)).toBe(false);
  });

  it('fences a resumed upload attempt after a newer lease generation takes ownership', () => {
    const now = 1_800_000_000_000;
    const current = { status: 'uploading' as const, uploadLeaseUntil: now + 1_000, uploadLeaseGeneration: 2 };
    expect(ownsUploadLease(current, 1, now)).toBe(false);
    expect(ownsUploadLease(current, 2, now)).toBe(true);
    expect(ownsUploadLease({ ...current, uploadLeaseUntil: now }, 2, now)).toBe(false);
  });

  it('reports an admin retry unavailable when the source row has no usable video bytes', () => {
    expect(planAdminRetryCommand({
      status: 'failed', retryCount: 4, uploadProgress: 0, blob: undefined,
    }, 'command-a')).toEqual({ available: false, applied: false, changes: {} });
    expect(planAdminRetryCommand({
      status: 'failed', retryCount: 4, uploadProgress: 0, blob: new Blob([]),
    }, 'command-b')).toEqual({ available: false, applied: false, changes: {} });
  });
});
