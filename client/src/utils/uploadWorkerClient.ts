import { getApiBaseUrl } from './apiBase';

type WorkerMessage = { type?: string; data?: unknown };
type Listener = (message: WorkerMessage) => void;

let worker: Worker | null = null;
let started = false;
const listeners = new Set<Listener>();

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/videoUpload.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      listeners.forEach((listener) => listener(event.data));
    };
  }
  return worker;
}

export function subscribeUploadWorker(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// One worker for the signed-in session. INIT starts the 15s poll; later
// org/token changes must not INIT again or a second interval is scheduled.
export function configureUploadWorker(payload: { apiUrl?: string; orgId?: string; token?: string }): void {
  const active = ensureWorker();
  if (!started) {
    started = true;
    active.postMessage({
      type: 'INIT',
      payload: {
        apiUrl: payload.apiUrl || getApiBaseUrl(),
        orgId: payload.orgId,
        token: payload.token,
      },
    });
    return;
  }
  if (payload.token) active.postMessage({ type: 'UPDATE_AUTH', payload: { token: payload.token } });
  if (payload.orgId) active.postMessage({ type: 'UPDATE_ORG', payload: { orgId: payload.orgId } });
}

export function kickUploadQueue(token?: string): void {
  if (!worker) return;
  worker.postMessage({ type: 'PROCESS_QUEUE', payload: token ? { token } : {} });
}

export function stopUploadWorker(): void {
  worker?.terminate();
  worker = null;
  started = false;
}
