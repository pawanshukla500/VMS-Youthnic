import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { getApiBaseUrl } from '../utils/apiBase';
import { acquireUploadWorker, releaseUploadWorker } from '../utils/uploadWorkerHost';
import { getOrCreateUploadDeviceId } from '../utils/uploadDevice';

// App-wide owner of the Firebase upload worker: ANY signed-in user on ANY
// page drains their pending queue. Pages keep their own listeners for UI
// updates; this manager guarantees the worker exists, is configured with the
// real org, and stays authed (token refresh + reconnect kicks).
export default function UploadWorkerManager() {
  const { currentUser, organizationId } = useAuth();
  const workerRef = useRef<Worker | null>(null);
  const orgIdRef = useRef(organizationId || '');

  useEffect(() => {
    orgIdRef.current = organizationId || '';
  }, [organizationId]);

  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    let worker: Worker;
    const userEmail = currentUser.email || '';

    const sendFreshIdentity = async (type: 'UPDATE_AUTH' | 'PROCESS_QUEUE') => {
      try {
        const token = await currentUser.getIdToken(true);
        if (cancelled) return;
        worker.postMessage({ type, payload: { token, orgId: orgIdRef.current, userEmail } });
      } catch {
        // The queue remains local; the next auth refresh/reconnect retries.
      }
    };

    const onWorkerMessage = (e: MessageEvent) => {
      const type = (e as MessageEvent & { data?: { type?: string } }).data?.type;
      if (type === 'AUTH_REQUIRED') {
        void sendFreshIdentity('UPDATE_AUTH');
        void sendFreshIdentity('PROCESS_QUEUE');
      }
    };
    worker = acquireUploadWorker(onWorkerMessage);
    workerRef.current = worker;
    currentUser.getIdToken().then((token) => {
      if (cancelled) return;
      worker.postMessage({
        type: 'INIT',
        payload: {
          apiUrl: getApiBaseUrl(),
          orgId: orgIdRef.current,
          token,
          deviceId: getOrCreateUploadDeviceId(),
          userEmail,
        },
      });
    }).catch(() => undefined);

    const refreshInterval = window.setInterval(() => {
      void sendFreshIdentity('UPDATE_AUTH');
    }, 10 * 60 * 1000);
    const kickQueue = () => { void sendFreshIdentity('PROCESS_QUEUE'); };
    window.addEventListener('online', kickQueue);
    return () => {
      cancelled = true;
      window.clearInterval(refreshInterval);
      window.removeEventListener('online', kickQueue);
      // Clear the long-lived worker identity before releasing it. In-flight
      // resumable tasks are cancelled, and no old-org token survives sign-out.
      worker.postMessage({ type: 'RESET_IDENTITY' });
      releaseUploadWorker(onWorkerMessage);
      if (workerRef.current === worker) workerRef.current = null;
    };
  }, [currentUser]);

  // Push the resolved organization on every auth/org transition, including
  // an explicit empty value when membership is unavailable or being cleared.
  useEffect(() => {
    if (!currentUser || !workerRef.current) return;
    let cancelled = false;
    const worker = workerRef.current;
    const userEmail = currentUser.email || '';
    const orgId = organizationId || '';
    currentUser.getIdToken(true).then((token) => {
      if (cancelled) return;
      worker.postMessage({ type: 'UPDATE_ORG', payload: { orgId, token, userEmail } });
    }).catch(() => {
      if (cancelled) return;
      worker.postMessage({ type: 'UPDATE_ORG', payload: { orgId, userEmail } });
    });
    return () => { cancelled = true; };
  }, [currentUser, organizationId]);

  return null;
}
