export const UPLOAD_DEVICE_ID_STORAGE_KEY = 'vms.uploadDeviceId';
const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

type DeviceIdStorage = Pick<Storage, 'getItem' | 'setItem'>;

function createSecureUuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Secure random UUID generation is unavailable in this browser');
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createUploadAttemptToken(createId: () => string = createSecureUuid): string {
  const token = createId();
  if (!UUID_RE.test(token)) throw new Error('Upload attempt token generator returned an invalid UUID');
  return token;
}

let sessionFallbackId: string | undefined;

/** Stable browser-profile id, shared by upload-worker initializers across tabs. */
export function getOrCreateUploadDeviceId(
  storage?: DeviceIdStorage,
  createId: () => string = createSecureUuid,
  fallbackStorage?: DeviceIdStorage,
): string {
  const candidates: DeviceIdStorage[] = [];
  if (storage) candidates.push(storage);
  else if (typeof window !== 'undefined') {
    try { candidates.push(window.localStorage); } catch { /* restricted local storage */ }
  }
  if (fallbackStorage) candidates.push(fallbackStorage);
  else if (typeof window !== 'undefined') {
    try { candidates.push(window.sessionStorage); } catch { /* restricted session storage */ }
  }

  const uniqueCandidates = [...new Set(candidates)];
  for (const candidate of uniqueCandidates) {
    try {
      const existing = candidate.getItem(UPLOAD_DEVICE_ID_STORAGE_KEY);
      if (existing && UUID_RE.test(existing)) return existing;
    } catch {
      // Try the next durable browser storage tier.
    }
  }

  const created = createId();
  if (!UUID_RE.test(created)) throw new Error('Upload device id generator returned an invalid UUID');
  for (const candidate of uniqueCandidates) {
    try {
      candidate.setItem(UPLOAD_DEVICE_ID_STORAGE_KEY, created);
      return created;
    } catch {
      // Try the next durable browser storage tier.
    }
  }
  sessionFallbackId ||= created;
  return sessionFallbackId;
}
