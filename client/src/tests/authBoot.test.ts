import { describe, it, expect, vi } from 'vitest';

// AuthContext pulls the Firebase app module (which needs real web config);
// the timeout helper under test never touches it, so keep it unloaded.
vi.mock('../utils/firebase', () => ({ auth: {}, db: {} }));

import { withBootTimeout, AUTH_BOOT_TIMEOUT_MS } from '../context/AuthContext';

describe('withBootTimeout', () => {
  it('passes through a fast value', async () => {
    await expect(withBootTimeout(Promise.resolve('ok'), 'fast')).resolves.toBe('ok');
  });

  it('passes through rejections to the caller', async () => {
    await expect(withBootTimeout(Promise.reject(new Error('boom')), 'rejecting')).rejects.toThrow('boom');
  });

  it('resolves null instead of hanging the boot spinner', async () => {
    const never = new Promise<string>(() => {});
    const start = Date.now();
    await expect(withBootTimeout(never, 'hanging')).resolves.toBeNull();
    // Must give up near the timeout, never wait indefinitely.
    expect(Date.now() - start).toBeLessThan(AUTH_BOOT_TIMEOUT_MS + 5000);
  }, 20000);
});
