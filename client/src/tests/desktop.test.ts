import { describe, it, expect, vi, afterEach } from 'vitest';
import { isDesktopApp, getDesktopApi } from '../utils/desktop';
import {
  mirrorRecordingToDisk,
  pruneDesktopMirror,
  reconcileDesktopMirror,
  setDesktopUploadActive,
} from '../utils/desktopMirror';

function setBridge(bridge: unknown) {
  if (bridge === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = { desktop: bridge };
  }
}

afterEach(() => {
  setBridge(undefined);
  vi.unstubAllGlobals();
});

const meta = {
  trackingId: 'T1',
  stationId: 'S1',
  packerId: 'P1',
  orderId: null,
  marketplace: null,
  timestamp: 1700000000000,
  duration: 12,
  mimeType: 'video/mp4',
};

describe('desktop detection', () => {
  it('is false on the plain web build (no preload bridge)', () => {
    setBridge(undefined);
    expect(isDesktopApp()).toBe(false);
    expect(getDesktopApi()).toBeNull();
  });

  it('is true when the preload bridge exists', () => {
    setBridge({ isDesktop: true });
    expect(isDesktopApp()).toBe(true);
  });
});

describe('desktop mirror (web no-ops)', () => {
  it('mirror resolves false without touching disk', async () => {
    setBridge(undefined);
    await expect(mirrorRecordingToDisk('rec-1', new Blob(['x'], { type: 'video/mp4' }), meta)).resolves.toBe(false);
  });

  it('reconcile resolves zeros on web', async () => {
    setBridge(undefined);
    await expect(reconcileDesktopMirror()).resolves.toEqual({ restored: 0, pruned: 0 });
  });

  it('prune resolves zero on web', async () => {
    setBridge(undefined);
    await expect(pruneDesktopMirror()).resolves.toBe(0);
  });

  it('upload hold is a safe no-op on web', () => {
    setBridge(undefined);
    expect(() => setDesktopUploadActive(true)).not.toThrow();
    expect(() => setDesktopUploadActive(false)).not.toThrow();
  });
});

describe('desktop mirror (bridge)', () => {
  it('saves mp4 bytes with metadata through the bridge', async () => {
    const saveRecording = vi.fn(async (..._args: unknown[]) => ({ path: '/disk/rec-1.mp4', size: 1 }));
    setBridge({ isDesktop: true, saveRecording });
    const ok = await mirrorRecordingToDisk('rec-1', new Blob(['x'], { type: 'video/mp4' }), meta);
    expect(ok).toBe(true);
    expect(saveRecording).toHaveBeenCalledTimes(1);
    const [id, ext, data, sentMeta] = saveRecording.mock.calls[0];
    expect(id).toBe('rec-1');
    expect(ext).toBe('mp4');
    expect(data).toBeInstanceOf(ArrayBuffer);
    expect(sentMeta).toMatchObject({ trackingId: 'T1', mimeType: 'video/mp4' });
  });

  it('never throws the queue when the disk write fails', async () => {
    const saveRecording = vi.fn(async () => {
      throw new Error('disk full');
    });
    setBridge({ isDesktop: true, saveRecording });
    await expect(mirrorRecordingToDisk('rec-1', new Blob(['x']), meta)).resolves.toBe(false);
  });

  it('signals upload activity through the bridge with heartbeats', () => {
    vi.useFakeTimers();
    try {
      const setUploadActive = vi.fn();
      setBridge({ isDesktop: true, setUploadActive });
      setDesktopUploadActive(true);
      expect(setUploadActive).toHaveBeenCalledWith(true);
      vi.advanceTimersByTime(60_000);
      expect(setUploadActive.mock.calls.length).toBeGreaterThan(1);
      setDesktopUploadActive(false);
      expect(setUploadActive).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
