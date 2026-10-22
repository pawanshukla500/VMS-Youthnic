import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForUploadTask } from '../utils/uploadStallGuard';
import { fetchWithTimeout } from '../utils/uploadTimeout';

afterEach(() => vi.useRealTimers());

describe('resumable video upload stall recovery', () => {
  it('cancels and rejects a Firebase task that stops making progress', async () => {
    vi.useFakeTimers();
    let reportProgress: ((snapshot: { bytesTransferred: number; totalBytes: number }) => void) | undefined;
    const task = {
      subscribe: vi.fn((progress: typeof reportProgress) => {
        reportProgress = progress;
        return vi.fn();
      }),
      cancel: vi.fn(),
    };

    const upload = waitForUploadTask(task, () => undefined, {
      stallTimeoutMs: 5_000,
      checkIntervalMs: 1_000,
    });
    const stalled = expect(upload).rejects.toMatchObject({ code: 'UPLOAD_STALLED' });
    await vi.advanceTimersByTimeAsync(5_000);

    await stalled;
    expect(task.cancel).toHaveBeenCalledTimes(1);
  });

  it('does not classify a slow but advancing upload as stalled', async () => {
    vi.useFakeTimers();
    let reportProgress: ((snapshot: { bytesTransferred: number; totalBytes: number }) => void) | undefined;
    let reportComplete: (() => void) | undefined;
    const task = {
      subscribe: vi.fn((progress: typeof reportProgress, _error: (error: unknown) => void, complete: typeof reportComplete) => {
        reportProgress = progress;
        reportComplete = complete;
        return vi.fn();
      }),
      cancel: vi.fn(),
    };

    const upload = waitForUploadTask(task, () => undefined, {
      stallTimeoutMs: 5_000,
      checkIntervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(4_000);
    reportProgress?.({ bytesTransferred: 1, totalBytes: 10 });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(task.cancel).not.toHaveBeenCalled();
    reportComplete?.();

    await expect(upload).resolves.toBeUndefined();
  });
});

describe('upload API request timeout', () => {
  it('aborts and rejects a fetch that stays pending past its deadline', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => undefined));
    const request = fetchWithTimeout('/api/videos/upload', { method: 'POST' }, 2_000, fetcher);
    const timedOut = expect(request).rejects.toThrow(/timed out/i);
    await Promise.resolve();
    const signal = fetcher.mock.calls[0]?.[1]?.signal;

    await vi.advanceTimersByTimeAsync(2_000);

    await timedOut;
    expect(signal?.aborted).toBe(true);
  });
});
