import { ref, uploadBytesResumable } from 'firebase/storage';
import { storage, auth } from '../utils/firebase';
import { getPendingRecordings, updateRecordingStatus, updateRecordingProgress, deleteRecording, incrementRetryCount } from '../utils/videoQueue';

let isRunning = false;
let config = { apiUrl: '', orgId: '', token: '' };
const lastAttemptTimes = new Map<string, number>();
const CONCURRENCY_LIMIT = 3;
const DEFAULT_ORG_PATH = 'default';
const UNKNOWN_PATH_SEGMENT = 'unknown';
const UNASSIGNED_MARKETPLACE_PATH = 'unassigned';

function safePathSegment(value: unknown, fallback = UNKNOWN_PATH_SEGMENT) {
  const segment = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return segment.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function resolveOrderMapping(trackingId: string) {
  if (!config.apiUrl || !config.token || !trackingId || trackingId === 'UNKNOWN') {
    return { orderId: null, marketplace: null };
  }

  try {
    const response = await fetch(`${config.apiUrl}/api/order-mappings/resolve?trackingId=${encodeURIComponent(trackingId)}`, {
      headers: { 'Authorization': `Bearer ${config.token}` }
    });

    if (!response.ok) return { orderId: null, marketplace: null };

    const data = await response.json();
    return {
      orderId: data?.mapping?.order_id || null,
      marketplace: data?.mapping?.marketplace || null
    };
  } catch (err) {
    console.warn('Order mapping resolution skipped:', err);
    return { orderId: null, marketplace: null };
  }
}

self.onmessage = async (e) => {
  const { type, payload } = e.data;
  
  if (type === 'INIT') {
    config = { ...config, ...payload };
    await auth.authStateReady();
    processQueue();
    setInterval(processQueue, 15000); // Check queue every 15s
  } else if (type === 'UPDATE_AUTH') {
    config.token = payload.token || config.token;
  } else if (type === 'PROCESS_QUEUE') {
    config.token = payload.token || config.token;
    await auth.authStateReady();
    processQueue();
  }
};

async function processQueue() {
  if (isRunning) return;
  if (!navigator.onLine) return;

  
  isRunning = true;

  try {
    const pending = await getPendingRecordings();
    const now = Date.now();
    
    const toProcess = pending.filter(record => {
      if (record.status === 'failed') {
        const lastAttempt = lastAttemptTimes.get(record.id) || 0;
        const retryCount = record.retryCount || 0;
        const backoffTable = [5000, 15000, 30000, 60000, 120000, 300000];
        const delay = backoffTable[Math.min(retryCount, backoffTable.length - 1)];
        if (now - lastAttempt < delay) {
          return false;
        }
      }
      return true;
    });

    const activeUploads = new Set<Promise<void>>();

    for (const record of toProcess) {
      while (activeUploads.size >= CONCURRENCY_LIMIT) {
        await Promise.race(activeUploads);
      }

      const uploadPromise = (async () => {
        try {
          lastAttemptTimes.set(record.id, now);
          await updateRecordingStatus(record.id, 'uploading');
          await updateRecordingProgress(record.id, 0);
          postMessage({ type: 'UPLOAD_PROGRESS', payload: { id: record.id, progress: 0 } });

          if (!config.apiUrl) {
            throw new Error('Upload API URL is not configured');
          }
          
          const ext = record.blob.type.includes('mp4') ? 'mp4' : 'webm';
          const orgPath = safePathSegment(config.orgId, DEFAULT_ORG_PATH);
          const mapping = await resolveOrderMapping(record.trackingId);
          const orderId = record.orderId || mapping.orderId || null;
          const marketplace = record.marketplace || mapping.marketplace || null;
          const marketplacePath = safePathSegment(marketplace, UNASSIGNED_MARKETPLACE_PATH);
          const orderPath = safePathSegment(orderId || record.trackingId);
          const recordingDate = new Date(record.timestamp);
          const storagePath = `packing-videos/${orgPath}/${recordingDate.getFullYear()}/${recordingDate.getMonth() + 1}/${recordingDate.getDate()}/${orderPath}/${record.id}.${ext}`;
          const storageRef = ref(storage, storagePath);
          
          // Upload to Firebase Storage
          const uploadTask = uploadBytesResumable(storageRef, record.blob, {
            contentType: record.blob.type || 'video/mp4',
            customMetadata: {
              organizationId: orgPath,
              recordingSessionId: record.id,
              trackingId: record.trackingId,
              orderId: orderId || '',
              marketplace: marketplace || 'Unassigned',
              stationId: record.stationId || 'UNKNOWN',
              operatorUid: record.packerId || 'UNKNOWN'
            }
          });

          let lastProgress = -1;
          await new Promise<void>((resolve, reject) => {
            uploadTask.on(
              'state_changed',
              async (snapshot) => {
                const progress = snapshot.totalBytes
                  ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100)
                  : 0;

                if (progress !== lastProgress) {
                  lastProgress = progress;
                  await updateRecordingProgress(record.id, progress);
                  postMessage({ type: 'UPLOAD_PROGRESS', payload: { id: record.id, progress } });
                }
              },
              (error) => {
                // Enhance error with more context for Firebase storage errors
                const enhancedError = new Error(
                  `Firebase storage upload failed: ${error.message || String(error)}`
                );
                (enhancedError as any).originalError = error;
                (enhancedError as any).isStorageError = true;
                reject(enhancedError);
              },
              () => resolve()
            );
          });
          await updateRecordingProgress(record.id, 100);
          postMessage({ type: 'UPLOAD_PROGRESS', payload: { id: record.id, progress: 100 } });
          
          // Notify Backend
          const response = await fetch(`${config.apiUrl}/api/videos/upload`, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.token}`
            },
            body: JSON.stringify({
              id: record.id,
              trackingId: record.trackingId,
              orderId,
              marketplace,
              timestamp: record.timestamp,
              duration: record.duration,
              stationId: record.stationId,
              packerId: record.packerId,
              organizationId: orgPath,
              storagePath: storagePath,
              mimeType: record.blob.type || 'video/mp4',
              sizeBytes: record.blob.size,
              width: 2560,
              height: 1440,
              fps: 30
            })
          });

          if (!response.ok) {
            const errText = await response.text().catch(() => 'No error text');
            if (response.status === 401 || response.status === 403) {
              postMessage({ type: 'AUTH_REQUIRED', payload: { id: record.id, status: response.status } });
            }
            throw new Error(`Backend metadata status ${response.status}: ${errText.substring(0, 150)}`);
          }

          await deleteRecording(record.id);
          postMessage({ type: 'UPLOAD_SUCCESS', payload: { id: record.id, trackingId: record.trackingId } });

        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          console.error('Failed to upload recording:', record.id, errorMessage, err);
          
          // Check if this is a Firebase storage quota error or authentication error
          const isStorageError = (err as any)?.isStorageError;
          const isAuthError = errorMessage.includes('permission') || errorMessage.includes('unauthenticated') || errorMessage.includes('auth');
          
          // For storage quota or auth errors, we might want to retry with backoff
          await incrementRetryCount(record.id);
          await updateRecordingStatus(record.id, 'failed', errorMessage);
          postMessage({ type: 'UPLOAD_ERROR', payload: { id: record.id, error: errorMessage } });
        }
      })();
      
      activeUploads.add(uploadPromise);
      uploadPromise.finally(() => activeUploads.delete(uploadPromise));
    }
    
    await Promise.all(activeUploads);
  } catch (err) {
    console.error('Queue processing error:', err);
  } finally {
    isRunning = false;
  }
}
