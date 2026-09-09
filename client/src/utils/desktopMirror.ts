// Desktop-only local disk mirror of finished recordings.
//
// The web upload pipeline (IndexedDB queue + worker + Firebase Storage) runs
// UNCHANGED inside the desktop app. This module adds a filesystem copy under
// the OS user-data dir as a second source of truth:
//   - mirrorRecordingToDisk: called right after every IndexedDB save.
//   - reconcileDesktopMirror: on boot, re-imports disk files missing from
//     IndexedDB (eviction/crash), then prunes uploaded copies.
//   - pruneDesktopMirror: deletes disk copies whose queue rows are gone
//     (upload finished and cleared from IndexedDB).
//   - setDesktopUploadActive: heartbeat that holds OS sleep + tray state
//     while recording or uploads are pending (background uploading).
// Every function is a safe no-op on the web build.
import { getAllRecordings, addRecording } from './videoQueue';
import { getDesktopApi } from './desktop';
import type { DesktopRecordingMeta } from '../types/desktop';

function extForMime(mimeType: string): string {
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
}

export async function mirrorRecordingToDisk(id: string, blob: Blob, meta: DesktopRecordingMeta): Promise<boolean> {
  const api = getDesktopApi();
  if (!api) return false;
  try {
    const data = await blob.arrayBuffer();
    await api.saveRecording(id, extForMime(blob.type || meta.mimeType), data, meta);
    return true;
  } catch (err) {
    // Never break the queue: IndexedDB still holds the video, uploads retry
    // from there, and the next boot reconcile retries the mirror.
    console.warn('Desktop disk mirror failed (video still safe in local queue):', err instanceof Error ? err.message : err);
    return false;
  }
}

export async function reconcileDesktopMirror(): Promise<{ restored: number; pruned: number }> {
  const api = getDesktopApi();
  if (!api) return { restored: 0, pruned: 0 };
  let restored = 0;
  try {
    const [disk, records] = await Promise.all([api.listRecordings(), getAllRecordings()]);
    const known = new Set(records.map((r) => r.id));
    for (const entry of disk) {
      if (known.has(entry.id)) continue;
      try {
        const file = await api.readRecording(entry.id);
        const mimeType = file.meta?.mimeType || (file.ext === 'mp4' ? 'video/mp4' : 'video/webm');
        const blob = new Blob([file.data], { type: mimeType });
        const meta = file.meta;
        await addRecording({
          id: file.id,
          trackingId: meta?.trackingId || 'UNKNOWN',
          stationId: meta?.stationId || 'UNKNOWN',
          packerId: meta?.packerId || 'UNKNOWN_PACKER',
          orderId: meta?.orderId || undefined,
          marketplace: meta?.marketplace || undefined,
          flyerId: meta?.flyerId || undefined,
          blob,
          timestamp: meta?.timestamp || entry.mtimeMs,
          duration: meta?.duration || 0,
        });
        restored += 1;
        known.add(entry.id);
      } catch (err) {
        console.warn(`Desktop mirror restore skipped for ${entry.id}:`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.warn('Desktop mirror reconcile skipped:', err instanceof Error ? err.message : err);
  }
  const pruned = await pruneDesktopMirror();
  return { restored, pruned };
}

let lastPruneAt = 0;

export async function pruneDesktopMirror(): Promise<number> {
  const api = getDesktopApi();
  if (!api) return 0;
  const now = Date.now();
  // Upload-success bursts fire per recording; one sweep covers them all.
  if (now - lastPruneAt < 20_000) return 0;
  lastPruneAt = now;
  let pruned = 0;
  try {
    const [disk, records] = await Promise.all([api.listRecordings(), getAllRecordings()]);
    const known = new Set(records.map((r) => r.id));
    for (const entry of disk) {
      if (known.has(entry.id)) continue;
      try {
        await api.deleteRecording(entry.id);
        pruned += 1;
      } catch {
        // Locked or vanished; next sweep retries.
      }
    }
  } catch (err) {
    console.warn('Desktop mirror prune skipped:', err instanceof Error ? err.message : err);
  }
  return pruned;
}

// Heartbeat while true: the main process holds an OS sleep blocker and
// releases it ~75s after the last heartbeat (page idle / crash = auto-off).
let holdTimer: ReturnType<typeof setInterval> | null = null;
let holdWanted = false;

export function setDesktopUploadActive(active: boolean): void {
  const api = getDesktopApi();
  if (!api) return;
  holdWanted = active;
  try {
    api.setUploadActive(active);
  } catch {
    // Signalling must never disturb packing.
  }
  if (active && holdTimer === null) {
    holdTimer = setInterval(() => {
      if (!holdWanted) return;
      try {
        getDesktopApi()?.setUploadActive(true);
      } catch {
        // Next beat retries.
      }
    }, 25_000);
  } else if (!active && holdTimer !== null) {
    clearInterval(holdTimer);
    holdTimer = null;
  }
}
