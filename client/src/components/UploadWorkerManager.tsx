import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { getApiBaseUrl } from '../utils/apiBase';
import { acquireUploadWorker, releaseUploadWorker } from '../utils/uploadWorkerHost';

// App-wide owner of the Firebase upload worker: ANY signed-in user on ANY
// page drains their pending queue. Pages keep their own listeners for UI
// updates; this manager guarantees the worker exists, is configured with the
// real org, and stays authed (token refresh + reconnect kicks).
export default function UploadWorkerManager() {
  const { currentUser, organizationId } = useAuth();
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    if (!currentUser) return;
    const onWorkerMessage = (e: MessageEvent) => {
      const type = (e as MessageEvent & { data?: { type?: string } }).data?.type;
      if (type === 'AUTH_REQUIRED') {
        currentUser.getIdToken(true).then((token) => {
          workerRef.current?.postMessage({
            type: 'UPDATE_AUTH',
            payload: { token, orgId: organizationId || undefined },
          });
        }).catch(() => undefined);
      }
    };
    const worker = acquireUploadWorker(onWorkerMessage);
    workerRef.current = worker;
    currentUser.getIdToken().then((token) => {
      worker.postMessage({
        type: 'INIT',
        payload: {
          apiUrl: getApiBaseUrl(),
          orgId: organizationId || (import.meta as any).env?.VITE_ORG_ID,
          token,
        },
      });
    }).catch(() => undefined);

    const kickQueue = () => {
      currentUser.getIdToken(true).then((token) => {
        workerRef.current?.postMessage({
          type: 'PROCESS_QUEUE',
          payload: { token, orgId: organizationId || undefined },
        });
      }).catch(() => undefined);
    };
    // Firebase ID tokens live ~1 h: stay ahead of expiry so uploads never
    // stall on a PC left open all day.
    const refreshInterval = window.setInterval(() => {
      currentUser.getIdToken(true).then((token) => {
        workerRef.current?.postMessage({
          type: 'UPDATE_AUTH',
          payload: { token, orgId: organizationId || undefined },
        });
      }).catch(() => undefined);
    }, 10 * 60 * 1000);
    // Back online after an outage: drain immediately, don't wait for the tick.
    window.addEventListener('online', kickQueue);
    return () => {
      window.clearInterval(refreshInterval);
      window.removeEventListener('online', kickQueue);
      releaseUploadWorker(onWorkerMessage);
      workerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  // Same org fix as the pages: the real org UUID resolves via /api/me after
  // INIT, so push it (with a freshly stamped token) the moment it is known.
  useEffect(() => {
    if (!currentUser || !workerRef.current || !organizationId) return;
    currentUser.getIdToken(true).then((token) => {
      workerRef.current?.postMessage({ type: 'UPDATE_ORG', payload: { orgId: organizationId, token } });
    }).catch(() => {
      workerRef.current?.postMessage({ type: 'UPDATE_ORG', payload: { orgId: organizationId } });
    });
  }, [currentUser, organizationId]);

  return null;
}
