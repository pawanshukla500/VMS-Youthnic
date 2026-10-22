export interface UploadProgressSnapshot {
  bytesTransferred: number;
  totalBytes: number;
}

export interface ResumableUploadTaskAdapter {
  subscribe(
    onProgress: (snapshot: UploadProgressSnapshot) => void,
    onError: (error: unknown) => void,
    onComplete: () => void,
  ): (() => void) | void;
  cancel(): void;
}

export const DEFAULT_UPLOAD_STALL_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_UPLOAD_STALL_CHECK_INTERVAL_MS = 15_000;

export interface UploadStallOptions {
  stallTimeoutMs?: number;
  checkIntervalMs?: number;
}

/** Resolve a resumable upload when complete; cancel it if bytes stop advancing. */
export function waitForUploadTask(
  task: ResumableUploadTaskAdapter,
  onProgress: (snapshot: UploadProgressSnapshot) => void,
  options: UploadStallOptions = {},
): Promise<void> {
  const stallTimeoutMs = Math.max(1, options.stallTimeoutMs ?? DEFAULT_UPLOAD_STALL_TIMEOUT_MS);
  const checkIntervalMs = Math.max(1, Math.min(
    options.checkIntervalMs ?? DEFAULT_UPLOAD_STALL_CHECK_INTERVAL_MS,
    stallTimeoutMs,
  ));

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let lastBytesTransferred: number | undefined;
    let lastProgressAt = Date.now();
    let unsubscribe: (() => void) | undefined;

    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearInterval(stallCheck);
      unsubscribe?.();
      if (error !== undefined) reject(error);
      else resolve();
    };

    const stallCheck = setInterval(() => {
      if (Date.now() - lastProgressAt < stallTimeoutMs) return;
      const error = Object.assign(
        new Error(`Firebase upload made no progress for ${Math.ceil(stallTimeoutMs / 1000)} seconds`),
        { code: 'UPLOAD_STALLED' },
      );
      finish(error);
      try { task.cancel(); } catch { /* preserve the timeout as the useful error */ }
    }, checkIntervalMs);

    try {
      unsubscribe = task.subscribe(
        (snapshot) => {
          if (snapshot.bytesTransferred !== lastBytesTransferred) {
            lastBytesTransferred = snapshot.bytesTransferred;
            lastProgressAt = Date.now();
          }
          try {
            onProgress(snapshot);
          } catch (error) {
            finish(error);
            try { task.cancel(); } catch { /* the observer error remains primary */ }
          }
        },
        (error) => finish(error),
        () => finish(),
      ) || undefined;
      if (settled) unsubscribe?.();
    } catch (error) {
      finish(error);
    }
  });
}
