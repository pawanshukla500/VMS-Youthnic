import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type { RecordingStats } from './watermarkOverlay';

// Recording quality floor: 720p minimum, 1080p target. Bitrate is set for
// legible 1080p packing footage (labels/barcodes must stay readable).
export const MIN_RECORDING_HEIGHT = 720;
// Resolution→bitrate table (PR-13). 4 Mbps target for 1080p / 6 Mbps for
// 2K / 8 Mbps for 4K. Floor 1.15 Mbps so the encoder never falls below the
// MIN_RECORDING_HEIGHT minimum quality line. `pickRecordingBitrate()` is the
// single source of truth — both the MediaRecorder and the upload worker
// call it once the actual output dimensions are known.
export const RECORDING_BITRATE_TABLE = [
  { minPixels: 8_000_000, bps: 8_000_000 }, // 4K target (~30 MB/min)
  { minPixels: 3_500_000, bps: 4_000_000 }, // 2K target (~15 MB/min)
  { minPixels: 2_000_000, bps: 4_000_000 }, // 1080p target (~15 MB/min)
  { minPixels: 900_000,   bps: 2_000_000 }, // 720p floor
];
export const FALLBACK_BITRATE_BPS = 1_150_000;
export function pickRecordingBitrate(width = 2560, height = 1440): number {
  const pixels = (Number(width) || 0) * (Number(height) || 0);
  for (const row of RECORDING_BITRATE_TABLE) {
    if (pixels >= row.minPixels) return row.bps;
  }
  return FALLBACK_BITRATE_BPS;
}
// Legacy alias for callers / tests that still reference the constant.
export const VIDEO_BITRATE_BPS = pickRecordingBitrate();

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
      flyerId?: string | null;
      width?: number;
      height?: number;
      fps?: number;
      videoBitrate?: number;
      // Frame timing of the recording (sent with the upload; lag diagnosis).
      recordingStats?: RecordingStats;
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
      mimeType?: string;
      // Legacy (DB v3): chunks lived inside this record and every append
      // rewrote all of them. New sessions keep this empty and store chunks
      // in `recording_chunks`; old sessions are still read for recovery.
      chunks: BlobPart[];
      startTimestamp: number;
    }
  };
  recording_chunks: {
    key: [string, number];
    value: {
      sessionId: string;
      seq: number;
      blob: Blob;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<VMSDB>>;

export function initDB() {
  if (!dbPromise) {
    dbPromise = openDB<VMSDB>('vms-database', 4, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('recordings')) {
          const store = db.createObjectStore('recordings', { keyPath: 'id' });
          store.createIndex('by-status', 'status');
        }
        if (!db.objectStoreNames.contains('active_recording')) {
          db.createObjectStore('active_recording', { keyPath: 'id' });
        }
        // v4: one small record per 2-second chunk (append = one write).
        if (!db.objectStoreNames.contains('recording_chunks')) {
          db.createObjectStore('recording_chunks', { keyPath: ['sessionId', 'seq'] });
        }
      },
    });
  }
  return dbPromise;
}

// Ask the browser to keep our storage on disk (no silent eviction after a
// crash, reboot, or OS disk-pressure cleanup — critical on Chromebooks and
// shared packing PCs). Returns true when persistent storage is granted.
export async function ensurePersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && await navigator.storage.persisted()) {
      return true;
    }
    if (navigator.storage?.persist) {
      return await navigator.storage.persist();
    }
  } catch {
    // Unsupported or denied — uploads still retry, just without the guarantee.
  }
  return false;
}

// --- Active Recording (Crash Recovery) ---
export async function startRecordingSession(id: string, trackingId: string, stationId: string, packerId: string, orderId?: string, marketplace?: string, mimeType?: string) {
  const db = await initDB();
  await db.put('active_recording', {
    id,
    trackingId,
    stationId,
    packerId,
    orderId,
    marketplace,
    mimeType,
    chunks: [],
    startTimestamp: Date.now()
  });
}

// One write per chunk, whatever the recording length (the old version read
// and rewrote every earlier chunk on each append: O(n^2) disk work).
export async function appendRecordingChunk(id: string, chunk: Blob, seq: number) {
  const db = await initDB();
  await db.put('recording_chunks', { sessionId: id, seq, blob: chunk });
}

function chunkRange(id: string) {
  return IDBKeyRange.bound([id, -Infinity], [id, Infinity]);
}

// Every chunk of a session in order (legacy in-record chunks first).
export async function getRecordingChunks(id: string): Promise<BlobPart[]> {
  const db = await initDB();
  const [meta, rows] = await Promise.all([
    db.get('active_recording', id),
    db.getAll('recording_chunks', chunkRange(id)),
  ]);
  rows.sort((a, b) => a.seq - b.seq);
  return [...(meta?.chunks || []), ...rows.map((row) => row.blob)];
}

// Session details only (no video data since v4) — cheap on every scan.
export async function getActiveRecordings() {
  const db = await initDB();
  return await db.getAll('active_recording');
}

export async function clearActiveRecording(id: string) {
  const db = await initDB();
  const tx = db.transaction(['active_recording', 'recording_chunks'], 'readwrite');
  await Promise.all([
    tx.objectStore('active_recording').delete(id),
    tx.objectStore('recording_chunks').delete(chunkRange(id)),
    tx.done,
  ]);
}

// Chunks whose session record is gone (e.g. storage cleared mid-session).
// Returns how many were removed.
export async function pruneOrphanChunks(): Promise<number> {
  const db = await initDB();
  const active = new Set((await db.getAllKeys('active_recording')).map(String));
  const keys = await db.getAllKeys('recording_chunks');
  const orphans = keys.filter((key) => !active.has(String((key as [string, number])[0])));
  if (orphans.length === 0) return 0;
  const tx = db.transaction('recording_chunks', 'readwrite');
  await Promise.all([...orphans.map((key) => tx.store.delete(key)), tx.done]);
  return orphans.length;
}

// --- General Queue ---
export async function addRecording(recording: { id: string, trackingId: string, stationId: string, packerId: string, blob: Blob, timestamp: number, duration: number, orderId?: string, marketplace?: string, flyerId?: string | null, width?: number, height?: number, fps?: number, videoBitrate?: number, recordingStats?: RecordingStats }) {
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

// Upload guarantee (today or tomorrow): oldest recordings go first so a
// long outage drains in packed order instead of newest-first starvation.
export function sortOldestFirst<T extends { timestamp: number }>(records: T[]): T[] {
  return [...records].sort((a, b) => a.timestamp - b.timestamp);
}

// Recordings older than this are overdue and surfaced loudly in the queue.
export const OVERDUE_AFTER_MS = 24 * 60 * 60 * 1000;

export function countOverdue<T extends { timestamp: number }>(records: T[], now = Date.now()): number {
  return records.filter((r) => now - r.timestamp > OVERDUE_AFTER_MS).length;
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

// Re-queue a failed recording: zero progress, status 'pending', keep
// retryCount. The worker picks it up on its next tick. PR-07's per-row
// "Retry" button calls this.
export async function retryRecording(id: string): Promise<boolean> {
  const db = await initDB();
  const tx = db.transaction('recordings', 'readwrite');
  const store = tx.objectStore('recordings');
  const record = await store.get(id);
  if (!record) return false;
  if (record.status !== 'failed') return false;
  record.status = 'pending';
  record.error = undefined;
  record.uploadProgress = 0;
  await store.put(record);
  await tx.done;
  return true;
}

// Mark a recording as dead: status 'failed' + retryCount >= DEAD_THRESHOLD
// so the worker skips it. PR-07's "Mark as dead" button calls this when
// an upload has been stuck long enough to require admin attention.
export const DEAD_RETRY_THRESHOLD = 20;
export async function markRecordingDead(id: string, reason?: string): Promise<boolean> {
  const db = await initDB();
  const tx = db.transaction('recordings', 'readwrite');
  const store = tx.objectStore('recordings');
  const record = await store.get(id);
  if (!record) return false;
  record.status = 'failed';
  record.retryCount = Math.max(record.retryCount, DEAD_RETRY_THRESHOLD);
  if (reason) record.error = reason;
  await store.put(record);
  await tx.done;
  return true;
}

export async function retryAllFailed(): Promise<number> {
  const db = await initDB();
  const tx = db.transaction('recordings', 'readwrite');
  const store = tx.objectStore('recordings');
  let count = 0;
  let cursor = await store.openCursor();
  while (cursor) {
    const record = cursor.value;
    if (record.status === 'failed' && record.retryCount < DEAD_RETRY_THRESHOLD) {
      record.status = 'pending';
      record.error = undefined;
      record.uploadProgress = 0;
      await cursor.update(record);
      count += 1;
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  return count;
}

export async function clearQueue() {
  const db = await initDB();
  const tx = db.transaction(['recordings', 'active_recording'], 'readwrite');
  await tx.objectStore('recordings').clear();
  await tx.objectStore('active_recording').clear();
  await tx.done;
}
