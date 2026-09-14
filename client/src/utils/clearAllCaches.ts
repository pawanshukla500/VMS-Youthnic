// Comprehensive cache + storage cleanup for the PVMS SPA.
// Why this exists: every PR shipped last week kept the previous user's
// state visible in another tab / next session because logout only called
// Firebase signOut(). localStorage keys, sessionStorage, IndexedDB
// queue rows, SWR caches, and the browser's Cache Storage API all kept
// their data intact. This module wipes every layer the SPA owns and
// uses BroadcastChannel + storage events so other tabs sync.

const FIREBASE_AUTH_INDEX_KEY = 'firebase:authUser:';
const FIREBASE_AUTH_SESSION_PREFIX = 'firebase:session:';
const FIREBASE_AUTH_PREFIX = 'firebase:';
const PVMS_PREFIX = 'pvms:';
const KEEP_SESSION_COOKIES = true;

let cachedBroadcast: BroadcastChannel | null = null;
function getBroadcast(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return null;
  }
  if (!cachedBroadcast) {
    try {
      cachedBroadcast = new BroadcastChannel('pvms:cache');
    } catch {
      cachedBroadcast = null;
    }
  }
  return cachedBroadcast;
}

export const PVMS_CACHE_CHANNEL = 'pvms:cache';

export interface PvmsCacheMessage {
  kind: 'logout' | 'station-change' | 'role-change' | 'fresh-session';
  originTabId: string;
  ts: number;
}

const TAB_ID =
  (() => {
    if (typeof window === 'undefined') return 'server';
    try {
      const k = 'pvms:tab-id';
      let id = sessionStorage.getItem(k);
      if (!id) {
        id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        sessionStorage.setItem(k, id);
      }
      return id;
    } catch {
      return `srv-${Math.random().toString(36).slice(2, 8)}`;
    }
  })();

export function getTabId(): string {
  return TAB_ID;
}

// Receive cache messages from other tabs and re-dispatch on `window` so
// SWR's `mutate(() => true, undefined)` listeners + any tab-scoped
// query invalidation can react without each app wiring its own listener.
export function installCacheMessageBridge(onMessage: (msg: PvmsCacheMessage) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const bc = getBroadcast();
  const storageHandler = (e: StorageEvent) => {
    if (e.key !== 'pvms:cache:broadcast' || !e.newValue) return;
    try {
      const msg = JSON.parse(e.newValue) as PvmsCacheMessage;
      if (msg.originTabId === TAB_ID) return;
      onMessage(msg);
    } catch {
      // Ignore — payload wasn't ours.
    }
  };
  const bcHandler = (e: MessageEvent<PvmsCacheMessage>) => {
    if (!e.data || e.data.originTabId === TAB_ID) return;
    onMessage(e.data);
  };
  if (bc) bc.addEventListener('message', bcHandler);
  window.addEventListener('storage', storageHandler);
  return () => {
    if (bc) bc.removeEventListener('message', bcHandler);
    window.removeEventListener('storage', storageHandler);
  };
}

export function broadcastCacheMessage(msg: Omit<PvmsCacheMessage, 'originTabId' | 'ts'>) {
  const payload: PvmsCacheMessage = { ...msg, originTabId: TAB_ID, ts: Date.now() };
  const bc = getBroadcast();
  if (bc) {
    try {
      bc.postMessage(payload);
    } catch {
      // BroadcastChannel can throw in detached iframes.
    }
  }
  // Fallback path: storage event fires across tabs of the same origin.
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem('pvms:cache:broadcast', JSON.stringify(payload));
      // Clear after the storage event has been observed. Short timeout
      // is enough — other tabs listen synchronously.
      setTimeout(() => {
        try { localStorage.removeItem('pvms:cache:broadcast'); } catch { /* ignore */ }
      }, 500);
    } catch {
      // Ignore quota or privacy-mode failures.
    }
  }
}

// Clean every SPA-owned key in localStorage EXCEPT Firebase Auth itself
// (signOut() handles its own persistence; clearing mid-session would
// re-prompt for credentials).
function clearLocalStorage(keepFirebaseAuth: boolean) {
  if (typeof localStorage === 'undefined') return;
  const keep = new Set<string>();
  if (keepFirebaseAuth) {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (
        k &&
        (k.startsWith(FIREBASE_AUTH_INDEX_KEY) ||
          k.startsWith(FIREBASE_AUTH_SESSION_PREFIX) ||
          k.startsWith(FIREBASE_AUTH_PREFIX) ||
          k === 'pvms:tab-id')
      ) {
        keep.add(k);
      }
    }
  }
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (keep.has(k)) continue;
    toRemove.push(k);
  }
  for (const k of toRemove) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
}

function clearSessionStorage() {
  if (typeof sessionStorage === 'undefined') return;
  // Don't blow away pvms:tab-id — it determines "did THIS tab send this
  // message" in the broadcast bridge. Clear everything else.
  const keep = new Set(['pvms:tab-id']);
  const toRemove: string[] = [];
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const k = sessionStorage.key(i);
    if (!k || keep.has(k)) continue;
    toRemove.push(k);
  }
  for (const k of toRemove) {
    try { sessionStorage.removeItem(k); } catch { /* ignore */ }
  }
}

// Close + delete any IndexedDB that the PVMS app owns. We deliberately
// do NOT delete Firebase's IDB — Firebase manages its own lifecycle,
// and pruning it would break the auth session.
async function clearOwnedIndexedDb() {
  if (typeof indexedDB === 'undefined' || !indexedDB.databases) return;
  try {
    const all = await indexedDB.databases();
    for (const info of all) {
      const name = info.name;
      if (!name) continue;
      // The PVMS app uses 'pvms-video-queue' exclusively. Anything
      // starting with firebase- belongs to Firebase.
      if (name.startsWith('firebase') || name.startsWith('firestore')) continue;
      if (!name.startsWith('pvms')) continue;
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    }
  } catch {
    // Some browsers (older Safari) don't expose indexedDB.databases().
    // Best-effort: ignore. The store is recreated lazily on next load.
  }
}

async function clearCacheStorage() {
  if (typeof caches === 'undefined') return;
  try {
    const keys = await caches.keys();
    for (const k of keys) {
      // Don't blow away Firebase's service-worker caches if any.
      if (k.startsWith('firebase') || k.startsWith('workbox-precache')) continue;
      await caches.delete(k);
    }
  } catch {
    // ignore
  }
}

function clearDocumentCookies() {
  if (!KEEP_SESSION_COOKIES) return;
  if (typeof document === 'undefined') return;
  // Cookies are HttpOnly for the Firebase session token, so JS can't
  // clear them. We only need to clear our own non-HttpOnly flags — by
  // convention PVMS doesn't set any. Best-effort: try clearing any
  // cookie whose name starts with 'pvms_' or 'sess' over every path
  // and domain in document.cookie. Ignored if HttpOnly.
  const cookies = document.cookie ? document.cookie.split(';') : [];
  for (const raw of cookies) {
    const eq = raw.indexOf('=');
    const name = (eq > -1 ? raw.slice(0, eq) : raw).trim();
    if (!name) continue;
    if (
      name.startsWith('pvms_') ||
      name.startsWith('pvms-') ||
      name.startsWith('firebase')
    ) {
      const expires = 'Thu, 01 Jan 1970 00:00:00 GMT';
      document.cookie = `${name}=; Path=/; Expires=${expires}`;
      document.cookie = `${name}=; Path=/; Domain=${location.hostname}; Expires=${expires}`;
    }
  }
}

export interface ClearAllCachesOptions {
  keepFirebaseAuth?: boolean; // default true so signOut() doesn't fight us
  broadcast?: boolean; // default true: tell other tabs
  reason?: PvmsCacheMessage['kind'];
}

export async function clearAllCaches(opts: ClearAllCachesOptions = {}): Promise<void> {
  const reason: PvmsCacheMessage['kind'] = opts.reason || 'logout';
  const keepAuth = opts.keepFirebaseAuth !== false;
  clearLocalStorage(keepAuth);
  clearSessionStorage();
  clearDocumentCookies();
  await Promise.all([
    clearOwnedIndexedDb(),
    clearCacheStorage(),
  ]);
  if (opts.broadcast !== false) {
    broadcastCacheMessage({ kind: reason });
  }
}
