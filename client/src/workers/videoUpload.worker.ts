import { ref, uploadBytesResumable } from 'firebase/storage';
import { storage, auth } from '../utils/firebase';
import { getPendingRecordings, claimRecordingForUpload, updateRecordingOrganization, isRecordingUploadLeaseCurrent, releaseRecordingUploadClaim, updateRecordingProgress, deleteRecording, markRecordingFailed, forceRetryRecording, autoResumeFailedRecordings, VIDEO_BITRATE_BPS, sortOldestFirst } from '../utils/videoQueue';
import { shouldAutoRetry } from '../utils/uploadRetryPolicy';
import { createUploadAttemptToken } from '../utils/uploadDevice';
import { advanceUploadIdentity, filterOwnedUploadRecords, filterUnscopedUserUploadRecords, isUploadAttemptCurrent, normalizeUploadWorkerIdentityPatch } from '../utils/uploadOwnership';
import { waitForUploadTask } from '../utils/uploadStallGuard';
import { fetchWithTimeout } from '../utils/uploadTimeout';
import { getApiBaseUrl, normalizeApiBaseUrl } from '../utils/apiBase';

let isRunning = false;
let queueRequestedWhileRunning = false;
let config = { apiUrl: '', orgId: '', token: '', deviceId: '', userEmail: '' };
let identityGeneration = 0;
const activeUploadTasks = new Map<string, ReturnType<typeof uploadBytesResumable>>();
const activeUploadAttemptFences = new Map<string, { generation: number; token: string }>();
const lastQueueStatusSentAt = new Map<string, number>();
const lastQueueStatusFingerprint = new Map<string, string>();
let queueTelemetryRunning = false;
let lastQueueTelemetryWarningAt = 0;
const CONCURRENCY_LIMIT = 3;
const QUEUE_SYNC_INTERVAL_MS = 15_000;
const QUEUE_STATUS_HEARTBEAT_MS = 60_000;
const QUEUE_SYNC_BATCH_SIZE = 200;
const UNKNOWN_PATH_SEGMENT = 'unknown';
const UNASSIGNED_MARKETPLACE_PATH = 'unassigned';

function updateWorkerIdentity(payload: { orgId?: unknown; userEmail?: unknown }): boolean {
  const current = { email: config.userEmail, organizationId: config.orgId, generation: identityGeneration };
  const updated = advanceUploadIdentity(current, normalizeUploadWorkerIdentityPatch(payload));
  if (updated.changed) {
    identityGeneration = updated.identity.generation;
    activeUploadAttemptFences.clear();
    for (const task of activeUploadTasks.values()) task.cancel();
    lastQueueStatusSentAt.clear();
    lastQueueStatusFingerprint.clear();
  }
  config.userEmail = updated.identity.email;
  config.orgId = updated.identity.organizationId;
  return updated.changed;
}

function isUploadIdentityCurrent(
  generation: number,
  jobConfig: typeof config,
  record: { packerId?: string | null; organizationId?: string | null },
): boolean {
  return isUploadAttemptCurrent(
    { email: jobConfig.userEmail, organizationId: jobConfig.orgId, generation },
    { email: config.userEmail, organizationId: config.orgId, generation: identityGeneration },
    auth.currentUser?.email,
    record,
  );
}

function safePathSegment(value: unknown, fallback = UNKNOWN_PATH_SEGMENT) {
  const segment = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return segment.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function isCorsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('CORS') || 
         message.includes('cors') || 
         message.includes('cross-origin') ||
         message.includes('Access-Control-Allow-Origin') ||
         message.includes('network error') ||
         message.includes('Failed to fetch');
}

function isStorageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('storage') || 
         message.includes('Firebase storage') ||
         isCorsError(error);
}

// Storage contentType must be a bare MIME (rules match `video/.*` and GCS
// playback keys off it). MediaRecorder gives 'video/mp4;codecs=...' — the
// codec params stay on the recorded blob, never in the metadata.
function baseMimeType(value: unknown): string {
  const raw = typeof value === 'string' ? value.split(';')[0].trim() : '';
  return raw || 'video/mp4';
}

// Firebase permission-denied on Storage means the ID token lacks the orgId
// custom claim (first login after /api/me set it). Refreshing the token
// once heals it — the page does that on AUTH_REQUIRED.
function isPermissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /permission|unauthorized|unauthenticated|storage\/unauthorized|storage\/unauthenticated/i.test(message);
}

async function resolveOrderMapping(trackingId: string, requestConfig = config) {
  if (!requestConfig.apiUrl || !requestConfig.token || !trackingId || trackingId === 'UNKNOWN') {
    return { orderId: null, marketplace: null };
  }

  // 1. Query order-context first (covers Forward Scan copy + Order Imports with photos)
  try {
    const response = await fetchWithTimeout(`${requestConfig.apiUrl}/api/order-context/resolve?trackingId=${encodeURIComponent(trackingId)}`, {
      headers: { 'Authorization': `Bearer ${requestConfig.token}` }
    }, 8_000);

    if (response.ok) {
      const data = await response.json();
      if (data?.orderId || data?.marketplace) {
        return {
          orderId: data.orderId || null,
          marketplace: data.marketplace || null
        };
      }
    }
  } catch {
    // Fall through to order-mappings
  }

  // 2. Fall back to order-mappings table
  try {
    const response = await fetchWithTimeout(`${requestConfig.apiUrl}/api/order-mappings/resolve?trackingId=${encodeURIComponent(trackingId)}`, {
      headers: { 'Authorization': `Bearer ${requestConfig.token}` }
    }, 6_000);

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
    const { orgId, userEmail, ...rest } = payload;
    config = { ...config, ...rest };
    updateWorkerIdentity({ orgId, userEmail });
    if (typeof rest.token === 'string') config.token = rest.token;
    config.apiUrl = normalizeApiBaseUrl(config.apiUrl) || getApiBaseUrl();
    await auth.authStateReady();
    if (config.orgId) {
      try {
        await autoResumeFailedRecordings(config.userEmail, config.orgId);
      } catch (err) {
        console.warn('Auto-resuming failed recordings on worker INIT skipped:', err);
      }
    }
    processQueue();
    void syncQueueTelemetry();
    // INIT re-runs on every page mount (the host re-sends it); without this
    // guard each remount stacked another 15 s ticker on the same worker.
    const scope = self as unknown as {
      __vmsUploadTick?: ReturnType<typeof setInterval>;
      __vmsUploadTelemetryTick?: ReturnType<typeof setInterval>;
    };
    if (!scope.__vmsUploadTick) {
      scope.__vmsUploadTick = setInterval(processQueue, 15000);
    }
    if (!scope.__vmsUploadTelemetryTick) {
      scope.__vmsUploadTelemetryTick = setInterval(() => void syncQueueTelemetry(), QUEUE_SYNC_INTERVAL_MS);
    }
  } else if (type === 'UPDATE_AUTH') {
    const identityChanged = updateWorkerIdentity(payload);
    if (typeof payload.token === 'string') config.token = payload.token;
    else if (identityChanged) config.token = '';
    void syncQueueTelemetry();
  } else if (type === 'UPDATE_ORG') {
    const identityChanged = updateWorkerIdentity(payload);
    if (typeof payload.token === 'string') config.token = payload.token;
    else if (identityChanged) config.token = '';
    if (config.orgId) {
      try {
        await autoResumeFailedRecordings(config.userEmail, config.orgId);
      } catch (err) {
        console.warn('Auto-resuming failed recordings on worker UPDATE_ORG skipped:', err);
      }
    }
    processQueue();
    void syncQueueTelemetry();
  } else if (type === 'PROCESS_QUEUE') {
    const identityChanged = updateWorkerIdentity(payload);
    if (typeof payload.token === 'string') config.token = payload.token;
    else if (identityChanged) config.token = '';
    config.apiUrl = normalizeApiBaseUrl(config.apiUrl) || getApiBaseUrl();
    await auth.authStateReady();
    if (config.orgId) {
      try {
        await autoResumeFailedRecordings(config.userEmail, config.orgId);
      } catch (err) {
        console.warn('Auto-resuming failed recordings on worker PROCESS_QUEUE skipped:', err);
      }
    }
    processQueue();
    void syncQueueTelemetry();
  } else if (type === 'RESET_IDENTITY') {
    updateWorkerIdentity({ orgId: '', userEmail: '' });
    activeUploadAttemptFences.clear();
    config.token = '';
  }
};

async function fetchQueueApi(url: string, init: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init, 12_000);
}

async function syncQueueTelemetry() {
  if (queueTelemetryRunning || !navigator.onLine || !config.apiUrl || !config.orgId || !config.token || !config.deviceId || !config.userEmail) return;
  queueTelemetryRunning = true;
  const syncConfig = { ...config };
  const syncGeneration = identityGeneration;
  try {
    const now = Date.now();
    const queue = filterOwnedUploadRecords(await getPendingRecordings(), {
      email: syncConfig.userEmail,
      organizationId: syncConfig.orgId,
    });
    const activeIds = new Set(queue.map((record) => record.id));
    for (const [id, sentAt] of lastQueueStatusSentAt) {
      if (!activeIds.has(id) && now - sentAt > 24 * 60 * 60 * 1000) {
        lastQueueStatusSentAt.delete(id);
        lastQueueStatusFingerprint.delete(id);
      }
    }

    const due = queue.filter((record) => {
      const fingerprint = `${record.status}:${record.retryCount}:${Math.floor(record.uploadProgress / 10)}:${record.error || ''}`;
      return lastQueueStatusFingerprint.get(record.id) !== fingerprint
        || now - (lastQueueStatusSentAt.get(record.id) || 0) >= QUEUE_STATUS_HEARTBEAT_MS;
    });
    const batches: typeof queue[] = [];
    for (let i = 0; i < due.length; i += QUEUE_SYNC_BATCH_SIZE) {
      batches.push(due.slice(i, i + QUEUE_SYNC_BATCH_SIZE));
    }
    if (batches.length === 0) batches.push([]);

    for (const batch of batches) {
      if (!isUploadIdentityCurrent(syncGeneration, syncConfig, {
        packerId: syncConfig.userEmail,
        organizationId: syncConfig.orgId,
      })) break;
      const response = await fetchQueueApi(`${syncConfig.apiUrl}/api/video-upload-queue/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${syncConfig.token}`,
        },
        body: JSON.stringify({
          deviceId: syncConfig.deviceId,
          recordings: batch.map((record) => {
            const attemptFence = activeUploadAttemptFences.get(record.id);
            return {
              id: record.id,
              trackingId: record.trackingId,
              status: record.status,
              retryCount: record.retryCount,
              uploadProgress: record.uploadProgress,
              sizeBytes: record.blob?.size || 0,
              timestamp: record.timestamp,
              orderId: record.orderId || null,
              marketplace: record.marketplace || null,
              error: record.error || null,
              ...(attemptFence && attemptFence.generation === record.uploadLeaseGeneration
                ? {
                    uploadAttemptGeneration: attemptFence.generation,
                    uploadAttemptToken: attemptFence.token,
                  }
                : {}),
            };
          }),
        }),
      });
      if (response.status === 401 || response.status === 403) {
        if (isUploadIdentityCurrent(syncGeneration, syncConfig, {
          packerId: syncConfig.userEmail,
          organizationId: syncConfig.orgId,
        })) {
          postMessage({ type: 'AUTH_REQUIRED', payload: { reason: 'upload-queue-sync', status: response.status } });
        }
        break;
      }
      if (!response.ok) throw new Error(`queue status HTTP ${response.status}`);
      const result = await response.json() as { commands?: Array<{ commandId?: string; recordingId?: string }> };
      if (!isUploadIdentityCurrent(syncGeneration, syncConfig, {
        packerId: syncConfig.userEmail,
        organizationId: syncConfig.orgId,
      })) break;
      for (const record of batch) {
        lastQueueStatusSentAt.set(record.id, now);
        lastQueueStatusFingerprint.set(
          record.id,
          `${record.status}:${record.retryCount}:${Math.floor(record.uploadProgress / 10)}:${record.error || ''}`,
        );
      }
      let requeued = false;
      for (const command of result.commands || []) {
        if (!isUploadIdentityCurrent(syncGeneration, syncConfig, {
          packerId: syncConfig.userEmail,
          organizationId: syncConfig.orgId,
        })) break;
        if (!command.commandId || !command.recordingId) continue;
        let available = false;
        try {
          available = await forceRetryRecording(command.recordingId, command.commandId);
        } catch {
          // Leave the delivery lease to expire; a transient IndexedDB error
          // must not be mistaken for a permanently missing local recording.
          continue;
        }
        const ack = await fetchQueueApi(`${syncConfig.apiUrl}/api/video-upload-queue/commands/ack`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${syncConfig.token}`,
          },
          body: JSON.stringify({
            commandId: command.commandId,
            deviceId: syncConfig.deviceId,
            result: available ? 'accepted' : 'unavailable',
            error: available ? null : 'Recording bytes are not available in this browser profile. Retry must run on the original device while its local queue is present.',
          }),
        });
        if (!ack.ok) {
          if (ack.status === 401 || ack.status === 403) {
            if (isUploadIdentityCurrent(syncGeneration, syncConfig, {
              packerId: syncConfig.userEmail,
              organizationId: syncConfig.orgId,
            })) {
              postMessage({ type: 'AUTH_REQUIRED', payload: { reason: 'upload-retry-ack', status: ack.status } });
            }
          }
          continue;
        }
        if (available) requeued = true;
      }
      if (requeued) void processQueue();
    }
  } catch (error) {
    const now = Date.now();
    if (now - lastQueueTelemetryWarningAt >= 60_000) {
      lastQueueTelemetryWarningAt = now;
      console.warn('Upload queue status sync will retry:', error instanceof Error ? error.message : String(error));
    }
  } finally {
    queueTelemetryRunning = false;
  }
}

async function processQueue() {
  // Web Locks serialize normal tabs. IndexedDB per-record leases still protect
  // uploads when Web Locks are unavailable or the lock API fails.
  const locker = (navigator as unknown as { locks?: { request: (...args: any[]) => Promise<boolean | null> } }).locks;
  if (locker?.request) {
    try {
      await locker.request('vms-upload-queue', { ifAvailable: true }, async (lock: unknown) => {
        if (!lock) return false;
        await drainQueue();
        return true;
      });
      return;
    } catch {
      // Lock API hiccup must never stall uploads: fall through and drain.
    }
  }
  await drainQueue();
}

async function drainQueue() {
  if (isRunning) {
    queueRequestedWhileRunning = true;
    return;
  }
  if (!navigator.onLine) return;

  isRunning = true;

  try {
    let hasMore = true;
    while (hasMore && navigator.onLine) {
      queueRequestedWhileRunning = false;
      if (!config.orgId || !config.userEmail) break;

      // Auto-adopt any unscoped recordings for this user only if provably belonging to this tenant
      try {
        const rawPending = await getPendingRecordings();
        const unscoped = filterUnscopedUserUploadRecords(rawPending, { email: config.userEmail });
        for (const rec of unscoped) {
          const mapping = await resolveOrderMapping(rec.trackingId);
          if (mapping) {
            rec.organizationId = config.orgId;
            rec.orderId = mapping.orderId;
            rec.marketplace = mapping.marketplace;
            await updateRecordingOrganization(rec.id, config.orgId);
          }
        }
      } catch {
        // Continue even if adoption probe fails
      }

      const pending = filterOwnedUploadRecords(await getPendingRecordings(), {
        email: config.userEmail,
        organizationId: config.orgId,
      });
      const now = Date.now();

      // Oldest first: guarantees packed order drains fairly after an outage.
      const byAge = sortOldestFirst(pending);
      const toProcess = byAge.filter((record) =>
        shouldAutoRetry(record.status, record.retryCount || 0, record.nextRetryAt, now, record.uploadLeaseUntil)
      );

      if (toProcess.length === 0) {
        hasMore = false;
        break;
      }

      const activeUploads = new Set<Promise<void>>();
      const slotLimit = toProcess.length > 100 ? 6 : toProcess.length > 20 ? 4 : CONCURRENCY_LIMIT;

      for (const record of toProcess) {
      while (activeUploads.size >= slotLimit) {
        await Promise.race(activeUploads);
      }

      const jobConfig = { ...config };
      const jobGeneration = identityGeneration;
      const uploadPromise = (async () => {
        let attemptGeneration: number | null = null;
        let attemptToken: string | null = null;
        try {
          if (!isUploadIdentityCurrent(jobGeneration, jobConfig, record)) return;
          attemptGeneration = await claimRecordingForUpload(record.id);
          if (attemptGeneration === null) return;
          const leaseGeneration = attemptGeneration;
          postMessage({ type: 'UPLOAD_PROGRESS', payload: { id: record.id, progress: 0 } });

          if (!jobConfig.apiUrl) {
            throw new Error('Upload API URL is not configured');
          }
          
          const ext = record.blob.type.includes('mp4') ? 'mp4' : 'webm';
          // Bare MIME for Storage metadata + backend row (no codec params).
          const baseMime = baseMimeType(record.blob.type);
          const orgPath = safePathSegment(jobConfig.orgId);
          if (!jobConfig.orgId || orgPath === UNKNOWN_PATH_SEGMENT || orgPath.toLowerCase() === 'default') {
            throw new Error('Organization is not resolved — sign in again before uploading');
          }
          // Capitals always (videos queued by older builds may be lowercase).
          const trackingId = (record.trackingId || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
          const mapping = await resolveOrderMapping(trackingId, jobConfig);
          const orderId = record.orderId || mapping.orderId || null;
          const marketplace = record.marketplace || mapping.marketplace || null;
          const marketplacePath = safePathSegment(marketplace, UNASSIGNED_MARKETPLACE_PATH);
          const orderPath = safePathSegment(orderId || trackingId);
          const recordingDate = new Date(record.timestamp);
          const storagePath = `packing-videos/${orgPath}/${recordingDate.getFullYear()}/${recordingDate.getMonth() + 1}/${recordingDate.getDate()}/${orderPath}/${record.id}.${ext}`;
          const storageRef = ref(storage, storagePath);
          if (!isUploadIdentityCurrent(jobGeneration, jobConfig, record)) {
            await releaseRecordingUploadClaim(record.id, leaseGeneration);
            return;
          }
          if (!await isRecordingUploadLeaseCurrent(record.id, leaseGeneration)) return;

          attemptToken = createUploadAttemptToken();
          const attemptRegistration = await fetchQueueApi(`${jobConfig.apiUrl}/api/video-upload-queue/attempt`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${jobConfig.token}`,
            },
            body: JSON.stringify({
              deviceId: jobConfig.deviceId,
              uploadAttemptGeneration: leaseGeneration,
              uploadAttemptToken: attemptToken,
              recording: {
                id: record.id,
                trackingId,
                status: 'uploading',
                retryCount: record.retryCount || 0,
                uploadProgress: 0,
                sizeBytes: record.blob.size,
                timestamp: record.timestamp,
                orderId,
                marketplace,
                error: null,
              },
            }),
          });
          if (!attemptRegistration.ok) {
            if (attemptRegistration.status === 401 || attemptRegistration.status === 403) {
              postMessage({ type: 'AUTH_REQUIRED', payload: { id: record.id, status: attemptRegistration.status, reason: 'attempt-auth' } });
            }
            const errorText = await attemptRegistration.text().catch(() => 'No error text');
            throw new Error(`Upload attempt registration HTTP ${attemptRegistration.status}: ${errorText.slice(0, 200)}`);
          }
          const registeredAttempt = await attemptRegistration.json() as { uploadAttemptGeneration?: unknown };
          if (registeredAttempt.uploadAttemptGeneration !== leaseGeneration) {
            throw new Error('Server did not confirm this upload attempt generation');
          }
          if (!isUploadIdentityCurrent(jobGeneration, jobConfig, record)) {
            await releaseRecordingUploadClaim(record.id, leaseGeneration);
            return;
          }
          if (!await isRecordingUploadLeaseCurrent(record.id, leaseGeneration)) return;
          activeUploadAttemptFences.set(record.id, { generation: leaseGeneration, token: attemptToken });

          const uploadTask = uploadBytesResumable(storageRef, record.blob, {
            contentType: baseMime,
            customMetadata: {
              organizationId: orgPath,
              recordingSessionId: record.id,
              trackingId,
              orderId: orderId || '',
              marketplace: marketplace || 'Unassigned',
              stationId: record.stationId || 'UNKNOWN',
              operatorUid: record.packerId || 'UNKNOWN',
            }
          });
          activeUploadTasks.set(record.id, uploadTask);

          let lastProgress = -1;
          let lastHeartbeat = Date.now();
          const leaseHeartbeatTimer = setInterval(() => {
            void updateRecordingProgress(record.id, lastProgress >= 0 ? lastProgress : 0, leaseGeneration).then((stillOwnsLease) => {
              if (!stillOwnsLease) uploadTask.cancel();
            }).catch(() => uploadTask.cancel());
          }, 30_000);

          try {
            await waitForUploadTask({
              subscribe: (onProgress, onError, onComplete) =>
                uploadTask.on('state_changed', onProgress, (error) => {
                  const enhancedError = new Error(
                    `Firebase storage upload failed: ${error instanceof Error ? error.message : String(error)}`
                  );
                  (enhancedError as any).originalError = error;
                  (enhancedError as any).isStorageError = true;
                  (enhancedError as any).isCorsError = isCorsError(error);
                  onError(enhancedError);
                }, onComplete),
              cancel: () => { uploadTask.cancel(); },
            }, (snapshot) => {
                const progress = snapshot.totalBytes
                  ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100)
                  : 0;
                const now = Date.now();
                const shouldHeartbeat = progress !== lastProgress || (now - lastHeartbeat >= 15_000);

                if (shouldHeartbeat) {
                  lastProgress = progress;
                  lastHeartbeat = now;
                  void updateRecordingProgress(record.id, progress, leaseGeneration).then((stillOwnsLease) => {
                    if (!stillOwnsLease) uploadTask.cancel();
                  }).catch(() => uploadTask.cancel());
                  postMessage({ type: 'UPLOAD_PROGRESS', payload: { id: record.id, progress } });
                }
              });
          } finally {
            clearInterval(leaseHeartbeatTimer);
          }
          if (!await updateRecordingProgress(record.id, 100, leaseGeneration)) return;
          postMessage({ type: 'UPLOAD_PROGRESS', payload: { id: record.id, progress: 100 } });
          if (!isUploadIdentityCurrent(jobGeneration, jobConfig, record)) {
            throw new Error('Account or organization changed during upload; retrying under the original identity');
          }
          if (!await isRecordingUploadLeaseCurrent(record.id, leaseGeneration)) return;
          if (!attemptToken) throw new Error('Upload attempt token is missing');
          
          const response = await fetchWithTimeout(`${jobConfig.apiUrl}/api/videos/upload`, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${jobConfig.token}`
            },
            body: JSON.stringify({
              id: record.id,
              deviceId: jobConfig.deviceId,
              uploadAttemptGeneration: leaseGeneration,
              uploadAttemptToken: attemptToken,
              trackingId,
              orderId,
              marketplace,
              timestamp: record.timestamp,
              duration: record.duration,
              stationId: record.stationId,
              packerId: record.packerId,
              organizationId: orgPath,
              storagePath: storagePath,
              mimeType: baseMime,
              sizeBytes: record.blob.size,
              width: record.width || 1920,
              height: record.height || 1080,
              fps: record.fps || 30,
              videoBitrate: record.videoBitrate || VIDEO_BITRATE_BPS,
              recordingStats: record.recordingStats || null
            })
          }, 60_000);

          if (!response.ok) {
            const errText = await response.text().catch(() => 'No error text');
            console.error('Backend metadata response:', response.status, errText);
            if (response.status === 401 || response.status === 403) {
              postMessage({ type: 'AUTH_REQUIRED', payload: { id: record.id, status: response.status } });
            }
            
            let errorDetails = errText;
            try {
              const errorData = JSON.parse(errText);
              errorDetails = errorData.details || errorData.error || errText;
            } catch (e) {
            }
            
            throw new Error(`Backend metadata status ${response.status}: ${errorDetails.substring(0, 200)}`);
          }

          if (!isUploadIdentityCurrent(jobGeneration, jobConfig, record)) {
            await releaseRecordingUploadClaim(record.id, leaseGeneration);
            return;
          }
          if (!await deleteRecording(record.id, leaseGeneration)) return;
          lastQueueStatusSentAt.delete(record.id);
          lastQueueStatusFingerprint.delete(record.id);
          postMessage({ type: 'UPLOAD_SUCCESS', payload: { id: record.id, trackingId: record.trackingId } });

        } catch (err) {
          if (attemptGeneration === null) return;
          if (!isUploadIdentityCurrent(jobGeneration, jobConfig, record)) {
            await releaseRecordingUploadClaim(record.id, attemptGeneration);
            return;
          }
          const errorMessage = err instanceof Error ? err.message : String(err);
          console.error('Failed to upload recording:', record.id, errorMessage, err);
          
          const isStorageError = (err as any)?.isStorageError;
          const isCorsError = (err as any)?.isCorsError;
          const isAuthError = errorMessage.includes('permission') || errorMessage.includes('unauthenticated') || errorMessage.includes('auth');

          // Storage permission-denied = stale ID token without the orgId
          // custom claim. Nudge the page to force-refresh the token (it
          // carries the claim after /api/me) and retry on the next tick.
          if (isPermissionError(err) || (isStorageError && isAuthError)) {
            postMessage({ type: 'AUTH_REQUIRED', payload: { id: record.id, reason: 'storage-permission' } });
          }

          let finalErrorMessage = errorMessage;
          if (isCorsError) {
            finalErrorMessage = `CORS error: Firebase Storage bucket CORS not configured. Run 'npm run configure:storage-cors' on the server to fix this. Original: ${errorMessage}`;
            console.error('CORS ERROR DETECTED: Firebase Storage bucket needs CORS configuration. Run: npm run configure:storage-cors');
          }
          
          if (!await markRecordingFailed(record.id, finalErrorMessage, attemptGeneration)) return;
          postMessage({ type: 'UPLOAD_ERROR', payload: { id: record.id, error: finalErrorMessage } });
        } finally {
          activeUploadTasks.delete(record.id);
          activeUploadAttemptFences.delete(record.id);
        }
      })();
      
      activeUploads.add(uploadPromise);
      uploadPromise.finally(() => activeUploads.delete(uploadPromise));
    }
    
      await Promise.all(activeUploads);
    }
  } catch (err) {
    console.error('Queue processing error:', err);
  } finally {
    isRunning = false;
    if (queueRequestedWhileRunning && navigator.onLine) {
      queueRequestedWhileRunning = false;
      setTimeout(() => void processQueue(), 50);
    }
  }
}