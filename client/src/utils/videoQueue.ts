import { openDB, DBSchema, IDBPDatabase } from 'idb';

export interface VMSDB extends DBSchema {
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
      retryCount: number;
      uploadProgress: number;
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
    dbPromise = openDB<VMSDB>('vms-database', 3, {
      upgrade(db, oldVersion) {
        if (!db.objectStoreNames.contains('recordings')) {
          const store = db.createObjectStore('recordings', { keyPath: 'id' });
          store.createIndex('by-status', 'status');
        }
        if (!db.objectStoreNames.contains('active_recording')) {
          db.createObjectStore('active_recording', { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

// --- Active Recording (Crash Recovery) ---
export async function startRecordingSession(id: string, trackingId: string, stationId: string, packerId: string, orderId?: string, marketplace?: string) {
  const db = await initDB();
  await db.put('active_recording', {
    id,
    trackingId,
    stationId,
    packerId,
    orderId,
    marketplace,
    chunks: [],
    startTimestamp: Date.now()
  });
}

export async function appendRecordingChunk(id: string, chunk: BlobPart) {
  const db = await initDB();
  const tx = db.transaction('active_recording', 'readwrite');
  const store = tx.objectStore('active_recording');
  let record = await store.get(id);
  if (!record) return; // Session might have been cleared
  
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
    status: 'pending',
    retryCount: 0,
    uploadProgress: 0
  });
}

export async function getAllRecordings() {
  const db = await initDB();
  return await db.getAll('recordings');
}

export async function getPendingRecordings() {
  const db = await initDB();
  const allPending = await db.getAllFromIndex('recordings', 'by-status', 'pending');
  const allUploading = await db.getAllFromIndex('recordings', 'by-status', 'uploading');
  const allFailed = await db.getAllFromIndex('recordings', 'by-status', 'failed');
  return [...allPending, ...allUploading, ...allFailed];
}

export async function incrementRetryCount(id: string) {
  const db = await initDB();
  const tx = db.transaction('recordings', 'readwrite');
  const store = tx.objectStore('recordings');
  const record = await store.get(id);
  if (record) {
    record.retryCount = (record.retryCount || 0) + 1;
    await store.put(record);
  }
  await tx.done;
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
    if (status === 'pending') {
      record.uploadProgress = 0;
    } else if (status === 'completed') {
      record.uploadProgress = 100;
    } else if (status === 'uploading') {
      record.uploadProgress = record.uploadProgress || 0;
    }
    await store.put(record);
  }
  await tx.done;
}

export async function updateRecordingProgress(id: string, uploadProgress: number) {
  const db = await initDB();
  const tx = db.transaction('recordings', 'readwrite');
  const store = tx.objectStore('recordings');
  const record = await store.get(id);
  if (record) {
    record.uploadProgress = Math.min(100, Math.max(0, Math.round(uploadProgress)));
    await store.put(record);
  }
  await tx.done;
}

export async function deleteRecording(id: string) {
  const db = await initDB();
  await db.delete('recordings', id);
}

export async function clearQueue() {
  const db = await initDB();
  const tx = db.transaction(['recordings', 'active_recording'], 'readwrite');
  await tx.objectStore('recordings').clear();
  await tx.objectStore('active_recording').clear();
  await tx.done;
}
