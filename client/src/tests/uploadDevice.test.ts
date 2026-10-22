import { describe, expect, it } from 'vitest';
import { createUploadAttemptToken, getOrCreateUploadDeviceId } from '../utils/uploadDevice';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

const UUID = '1678d80c-1234-4abc-8def-1234567890ab';

describe('upload device identity', () => {
  it('creates an opaque UUID token for each server-fenced upload attempt', () => {
    expect(createUploadAttemptToken(() => UUID)).toBe(UUID);
    expect(() => createUploadAttemptToken(() => 'not-a-uuid')).toThrow('Upload attempt token generator returned an invalid UUID');
  });

  it('persists and reuses one valid id across worker/page mounts', () => {
    const storage = memoryStorage();
    const createId = () => UUID;
    expect(getOrCreateUploadDeviceId(storage, createId)).toBe(UUID);
    expect(getOrCreateUploadDeviceId(storage, () => { throw new Error('must reuse id'); })).toBe(UUID);
  });

  it('persists in session storage when local storage is unavailable so commands survive reloads', () => {
    const unavailableStorage = {
      getItem: () => { throw new Error('storage blocked'); },
      setItem: () => { throw new Error('storage blocked'); },
    };
    const sessionStorage = memoryStorage();
    expect(getOrCreateUploadDeviceId(unavailableStorage, () => UUID, sessionStorage)).toBe(UUID);
    expect(sessionStorage.getItem('vms.uploadDeviceId')).toBe(UUID);
    expect(getOrCreateUploadDeviceId(unavailableStorage, () => { throw new Error('must reuse id'); }, sessionStorage)).toBe(UUID);
  });

  it('replaces a malformed stored id with a new UUID', () => {
    const storage = memoryStorage();
    storage.setItem('vms.uploadDeviceId', 'not-a-uuid');
    expect(getOrCreateUploadDeviceId(storage, () => UUID)).toBe(UUID);
  });
});
