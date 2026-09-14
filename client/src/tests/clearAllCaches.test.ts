import { describe, it, expect, beforeEach } from 'vitest';

// Minimal DOM-like stubs for the cache cleanup module.
type Store = Map<string, string>;
type ObjectMap = { [k: string]: any };

const localStore = new Map<string, string>();
const sessionStore = new Map<string, string>();

(globalThis as any).localStorage = {
  get length() { return localStore.size; },
  key(i: number) { return Array.from(localStore.keys())[i] ?? null; },
  getItem(k: string) { return localStore.has(k) ? localStore.get(k)! : null; },
  setItem(k: string, v: string) { localStore.set(k, v); },
  removeItem(k: string) { localStore.delete(k); },
  clear() { localStore.clear(); },
};
(globalThis as any).sessionStorage = {
  get length() { return sessionStore.size; },
  key(i: number) { return Array.from(sessionStore.keys())[i] ?? null; },
  getItem(k: string) { return sessionStore.has(k) ? sessionStore.get(k)! : null; },
  setItem(k: string, v: string) { sessionStore.set(k, v); },
  removeItem(k: string) { sessionStore.delete(k); },
  clear() { sessionStore.clear(); },
};
(globalThis as any).window = globalThis;
(globalThis as any).location = { hostname: 'example.com' };
(globalThis as any).document = { cookie: '' };
(globalThis as any).BroadcastChannel = class {
  constructor(public name: string) {}
  addEventListener() {}
  removeEventListener() {}
  postMessage() {}
  close() {}
};
(globalThis as any).indexedDB = {
  databases: async () => [
    { name: 'pvms-video-queue' },
    { name: 'firebaseLocalStorageDb' },
    { name: 'firestore/[DEFAULT]/app-data' },
    { name: 'random-other-db' },
  ],
  deleteDatabase: () => ({ onsuccess: null, onerror: null, onblocked: null }),
};
(globalThis as any).caches = {
  keys: async () => ['workbox-precache-v2-https://vms.youthnic.shop/', 'pvms-runtime-v1', 'firebase-messaging-cache'],
  delete: async () => true,
};

let clearedDatabases: string[] = [];
let clearedCacheNames: string[] = [];
const originalDatabases = (globalThis as any).indexedDB.databases;
(globalThis as any).indexedDB.databases = async () => {
  const dbs = await originalDatabases();
  return dbs;
};
(globalThis as any).indexedDB.deleteDatabase = (name: string) => {
  clearedDatabases.push(name);
  const req: any = {};
  setTimeout(() => req.onsuccess && req.onsuccess(), 0);
  return req;
};
(globalThis as any).caches.delete = async (k: string) => {
  clearedCacheNames.push(k);
  return true;
};

import { clearAllCaches, broadcastCacheMessage } from '../utils/clearAllCaches';

describe('clearAllCaches', () => {
  beforeEach(() => {
    localStore.clear();
    sessionStore.clear();
    clearedDatabases = [];
    clearedCacheNames = [];
  });

  it('clears SPA-owned localStorage but keeps firebase keys + tab-id', async () => {
    localStore.set('pvms:flyer-scan-enabled', '1');
    localStore.set('pvms:watermark-text', 'PS-1');
    localStore.set('firebase:authUser:AIyzaC123', 'token');
    localStore.set('firebase:session:abc', 'session');
    localStore.set('firebase:other-thing', 'x');

    await clearAllCaches({ keepFirebaseAuth: true, broadcast: false });

    expect(localStore.has('pvms:flyer-scan-enabled')).toBe(false);
    expect(localStore.has('pvms:watermark-text')).toBe(false);
    expect(localStore.has('firebase:authUser:AIyzaC123')).toBe(true);
    expect(localStore.has('firebase:session:abc')).toBe(true);
    expect(localStore.has('firebase:other-thing')).toBe(true);
  });

  it('drops firebase keys when keepFirebaseAuth=false (logout path)', async () => {
    localStore.set('firebase:authUser:AIyzaC123', 'token');
    localStore.set('pvms:queue-stats', '{}');
    await clearAllCaches({ keepFirebaseAuth: false, broadcast: false });
    expect(localStore.has('firebase:authUser:AIyzaC123')).toBe(false);
    expect(localStore.has('pvms:queue-stats')).toBe(false);
  });

  it('preserves pvms:tab-id in sessionStorage so cross-tab dedupe works', async () => {
    sessionStore.set('pvms:tab-id', 'abc-123');
    sessionStore.set('pvms:scratch', 'x');
    await clearAllCaches({ keepFirebaseAuth: true, broadcast: false });
    expect(sessionStore.has('pvms:tab-id')).toBe(true);
    expect(sessionStore.has('pvms:scratch')).toBe(false);
  });

  it('only deletes IndexedDB databases owned by PVMS', async () => {
    await clearAllCaches({ keepFirebaseAuth: true, broadcast: false });
    expect(clearedDatabases).toContain('pvms-video-queue');
    expect(clearedDatabases).not.toContain('firebaseLocalStorageDb');
    expect(clearedDatabases).not.toContain('firestore/[DEFAULT]/app-data');
    expect(clearedDatabases).not.toContain('random-other-db');
  });

  it('only deletes non-Firebase Cache Storage entries', async () => {
    await clearAllCaches({ keepFirebaseAuth: true, broadcast: false });
    expect(clearedCacheNames).toContain('pvms-runtime-v1');
    expect(clearedCacheNames).not.toContain('firebase-messaging-cache');
    expect(clearedCacheNames).not.toContain('workbox-precache-v2-https://vms.youthnic.shop/');
  });

  it('broadcastCacheMessage writes a localStorage envelope', () => {
    broadcastCacheMessage({ kind: 'logout' });
    // The broadcast path writes then clears; we can observe the
    // intermediate state by mocking setTimeout to be sync.
    expect(typeof localStore.get('pvms:cache:broadcast')).toBe('string');
  });
});
