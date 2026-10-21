// Shared upload-worker host: one Firebase upload worker per tab, usable from
// any page (Packing Station AND Upload Queue).
//
// Before this, the worker lived inside PackingStation — navigating to the
// Upload Queue unmounted it and the whole backlog silently paused while the
// operator watched the progress bars. Pages acquire on mount and release on
// unmount; a short grace period bridges route switches without churning the
// worker (its IndexedDB queue + retry backoff survive).
//
// INIT is (re-)sent by each mounting page, so a worker that survived the
// grace period still gets the current token/org. The worker guards its 15 s
// ticker against double-INIT.

export type UploadWorkerMessageHandler = (e: MessageEvent) => void;

let shared: Worker | null = null;
let owners = 0;
let reapTimer: ReturnType<typeof window.setTimeout> | null = null;
const listeners = new Set<UploadWorkerMessageHandler>();

const REAP_GRACE_MS = 30000;

export function acquireUploadWorker(onMessage: UploadWorkerMessageHandler): Worker {
  if (reapTimer !== null) {
    window.clearTimeout(reapTimer);
    reapTimer = null;
  }
  if (!shared) {
    shared = new Worker(
      new URL('../workers/videoUpload.worker.ts', import.meta.url),
      { type: 'module' }
    );
    shared.onmessage = (e: MessageEvent) => {
      listeners.forEach((fn) => {
        try {
          fn(e);
        } catch {
          // One page's handler must never break the other's.
        }
      });
    };
  }
  listeners.add(onMessage);
  owners += 1;
  return shared;
}

export function releaseUploadWorker(onMessage: UploadWorkerMessageHandler): void {
  listeners.delete(onMessage);
  owners = Math.max(0, owners - 1);
  if (owners === 0 && shared) {
    const worker = shared;
    shared = null;
    // Route switch (Packing <-> Queue) re-acquires within the grace period
    // and keeps this worker; a real tab close lets it die here.
    reapTimer = window.setTimeout(() => {
      worker.terminate();
      reapTimer = null;
    }, REAP_GRACE_MS);
  }
}
