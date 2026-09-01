import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { storage, auth } from './firebase';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { authFetch } from './authFetch';

interface VMSDB extends DBSchema {
  recordings: {
    key: string;
    value: {
      id: string;
      trackingId: string;
      blob: Blob;
      timestamp: number;
      duration: number;
      stationId: string;
      packerId: string;
      orderId?: string;
      marketplace?: string;
      status: 'pending' | 'uploading' | 'completed' | 'failed';
      error?: string;
    };
    indexes: { 'by-status': string };
  };
  active_recording: {
    key: string;
    value: {
      id: string;
      trackingId: string;
      stationId: string;
      packerId: string;
      orderId?: string;
      marketplace?: string;
      chunks: BlobPart[];
      startTimestamp: number;
    }
  };
}

let dbPromise: Promise<IDBPDatabase<VMSDB>>;

export function initDB() {
  if (!dbPromise) {
    dbPromise = openDB<VMSDB>('vms-database', 4, {
      upgrade(db, oldVersion) {
        if (!db.objectStoreNames.contains('recordings')) {
          const store = db.createObjectStore('recordings', { keyPath: 'id' });
          store.createIndex('by-status', 'status');
        }
        if (!db.objectStoreNames.contains('active_recording')) {
          db.createObjectStore('active_recording', { keyPath: 'id' });
        }
        // Version 4: Add error field to recordings for better error tracking
        // Note: The upgrade callback runs in a version-change transaction, so we can access the store directly
        if (oldVersion < 4 && db.objectStoreNames.contains('recordings')) {
          // No action needed - IndexedDB automatically allows new fields to be added to existing object stores
          // The error field will be available for all records once the version upgrade completes
        }
      },
    });
  }
  return dbPromise;
}

// --- Active Recording (Crash Recovery) ---
export async function appendChunkToActiveRecording(id: string, trackingId: string, stationId: string, packerId: string, chunk: BlobPart, startTimestamp: number) {
  const db = await initDB();
  const tx = db.transaction('active_recording', 'readwrite');
  const store = tx.objectStore('active_recording');
  let record = await store.get(id);
  if (!record) {
    record = { id, trackingId, stationId, packerId, chunks: [], startTimestamp };
  }
  record.chunks.push(chunk);
  await store.put(record);
  await tx.done;
}

export async function getActiveRecordings() {
  const db = await initDB();
  return await db.getAll('active_recording');
}

export async function clearActiveRecording(id: string) {
  const db = await initDB();
  await db.delete('active_recording', id);
}

// --- General Queue ---
export async function addRecording(recording: { id: string, trackingId: string, stationId: string, packerId: string, blob: Blob, timestamp: number, duration: number, orderId?: string, marketplace?: string }) {
  const db = await initDB();
  await db.put('recordings', {
    ...recording,
    status: 'pending'
  });
}

export async function getPendingRecordings() {
  const db = await initDB();
  return await db.getAllFromIndex('recordings', 'by-status', 'pending');
}

export async function getProcessableRecordings() {
  const db = await initDB();
  const pending = await db.getAllFromIndex('recordings', 'by-status', 'pending');
  const failed = await db.getAllFromIndex('recordings', 'by-status', 'failed');
  return [...pending, ...failed];
}

export async function getAllRecordings() {
  const db = await initDB();
  return await db.getAll('recordings');
}

export async function updateRecordingStatus(id: string, status: 'pending' | 'uploading' | 'completed' | 'failed', errorText?: string) {
  const db = await initDB();
  const tx = db.transaction('recordings', 'readwrite');
  const store = tx.objectStore('recordings');
  const record = await store.get(id);
  if (record) {
    record.status = status;
    if (errorText !== undefined) {
      record.error = errorText;
    }
    await store.put(record);
  }
  await tx.done;
}

export async function deleteRecording(id: string) {
  const db = await initDB();
  await db.delete('recordings', id);
}

function safePathSegment(value: unknown, fallback = 'unknown') {
  const segment = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return segment.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export async function processQueue() {
  if (!navigator.onLine) return;

  // Ensure Firebase auth is ready before processing
  try {
    await auth.authStateReady();
  } catch (authError) {
    console.error('Firebase auth not ready:', authError);
    return;
  }

  const processable = await getProcessableRecordings();
  const API_URL = import.meta.env.VITE_API_URL;
  if (!API_URL) throw new Error('VITE_API_URL is missing in environment variables');
  const orgId = import.meta.env.VITE_ORG_ID;
  if (!orgId) throw new Error('VITE_ORG_ID is missing in environment variables');

  for (const record of processable) {
    try {
      await updateRecordingStatus(record.id, 'uploading');
      
      const ext = record.blob.type.includes('mp4') ? 'mp4' : 'webm';
      const recordingDate = new Date(record.timestamp);
      const storagePath = `packing-videos/${safePathSegment(orgId, 'default')}/${safePathSegment(record.marketplace, 'unassigned')}/${recordingDate.getFullYear()}/${recordingDate.getMonth() + 1}/${recordingDate.getDate()}/${safePathSegment(record.orderId || record.trackingId)}/${record.id}.${ext}`;
      const storageRef = ref(storage, storagePath);
      
      const uploadTask = uploadBytesResumable(storageRef, record.blob, {
        contentType: record.blob.type || 'video/mp4',
        customMetadata: {
          organizationId: orgId,
          recordingSessionId: record.id,
          trackingId: record.trackingId,
          orderId: record.orderId || '',
          marketplace: record.marketplace || 'Unassigned',
          stationId: record.stationId || 'UNKNOWN',
          operatorUid: record.packerId || 'UNKNOWN'
        }
      });

      await new Promise<void>((resolve, reject) => {
        uploadTask.on('state_changed', 
          (snapshot) => {
            const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
            // Can be dispatched to UI later
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
          () => {
            resolve();
          }
        );
      });

      // After successful Firebase upload, insert metadata into Postgres backend
      const response = await authFetch(`${API_URL}/api/videos/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: record.id,
          trackingId: record.trackingId,
          orderId: record.orderId,
          marketplace: record.marketplace,
          timestamp: record.timestamp,
          duration: record.duration,
          stationId: record.stationId,
          packerId: record.packerId,
          organizationId: orgId,
          storagePath: storagePath,
          mimeType: record.blob.type,
          width: 2560, // Fixed 2K since we request 2K
          height: 1440,
          fps: 30
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => 'No error text');
        console.error('Backend metadata response:', response.status, errText);
        
        // Extract error details if available
        let errorDetails = errText;
        try {
          const errorData = JSON.parse(errText);
          errorDetails = errorData.details || errorData.error || errText;
        } catch (e) {
          // Not JSON, use as-is
        }
        
        // We uploaded to Firebase but metadata failed. Keep as failed so we can retry metadata later,
        // or let it be handled by a reconciliation cron. For now, mark failed to retry.
        throw new Error(`Metadata POST failed with status: ${response.status}: ${errorDetails.substring(0, 200)}`);
      }
      
      await updateRecordingStatus(record.id, 'completed');
      console.log(`Successfully uploaded ${record.id}`);
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Failed to upload ${record.id}`, errorMessage, error);
      
      // Check if this is a Firebase storage quota error or authentication error
      const isStorageError = (error as any)?.isStorageError;
      const isAuthError = errorMessage.includes('permission') || errorMessage.includes('unauthenticated') || errorMessage.includes('auth');
      
      // For storage quota or auth errors, we might want to retry with backoff
      // For now, mark as failed and the caller can retry
      await updateRecordingStatus(record.id, 'failed', errorMessage);
    }
  }
}
