import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openDBMock, state } = vi.hoisted(() => ({
  openDBMock: vi.fn(),
  state: {
    record: undefined as any,
    puts: [] as any[],
    deletes: [] as string[],
  },
}));

vi.mock('idb', () => ({ openDB: openDBMock }));

import {
  claimRecordingForUpload,
  deleteRecording,
  forceRetryRecording,
  markRecordingFailed,
  updateRecordingProgress,
} from '../utils/videoQueue';

const store = {
  get: vi.fn(async (id: string) => state.record?.id === id ? { ...state.record } : undefined),
  put: vi.fn(async (record: any) => {
    state.record = { ...record };
    state.puts.push({ ...record });
  }),
  delete: vi.fn(async (id: string) => {
    state.deletes.push(id);
    if (state.record?.id === id) state.record = undefined;
  }),
};

const db = {
  transaction: vi.fn(() => ({ objectStore: () => store, done: Promise.resolve() })),
  delete: vi.fn(async (_storeName: string, id: string) => {
    state.deletes.push(id);
    if (state.record?.id === id) state.record = undefined;
  }),
};

openDBMock.mockResolvedValue(db);

const baseRecord = () => ({
  id: 'recording-1',
  trackingId: 'SYN-123',
  blob: new Blob(['video-bytes'], { type: 'video/webm' }),
  timestamp: 1_800_000_000_000,
  duration: 5,
  stationId: 'PACK-01',
  packerId: 'packer@example.test',
  status: 'pending' as const,
  retryCount: 0,
  uploadProgress: 0,
});

beforeEach(() => {
  state.record = baseRecord();
  state.puts.length = 0;
  state.deletes.length = 0;
  store.get.mockClear();
  store.put.mockClear();
  store.delete.mockClear();
  db.delete.mockClear();
});

describe('fenced upload queue operations', () => {
  it('does not accept an admin retry when the source recording has no video bytes', async () => {
    state.record = { ...baseRecord(), status: 'failed', blob: undefined };

    await expect(forceRetryRecording('recording-1', 'command-1')).resolves.toBe(false);
    expect(state.puts).toHaveLength(0);
  });

  it('returns a monotonically increasing generation when claiming a recording', async () => {
    await expect(claimRecordingForUpload('recording-1', 1_800_000_000_000)).resolves.toBe(1);
    expect(state.record).toMatchObject({ status: 'uploading', uploadLeaseGeneration: 1 });
  });

  it('refuses progress and failure writes from an older lease generation', async () => {
    state.record = {
      ...baseRecord(),
      status: 'uploading',
      uploadLeaseUntil: Date.now() + 60_000,
      uploadLeaseGeneration: 2,
      uploadProgress: 25,
    };

    await expect(updateRecordingProgress('recording-1', 90, 1)).resolves.toBe(false);
    await expect(markRecordingFailed('recording-1', 'stale error', 1)).resolves.toBe(false);
    expect(state.record).toMatchObject({ status: 'uploading', uploadLeaseGeneration: 2, uploadProgress: 25 });
    expect(state.puts).toHaveLength(0);
  });

  it('refuses to delete local video bytes from an older lease generation', async () => {
    state.record = {
      ...baseRecord(),
      status: 'uploading',
      uploadLeaseUntil: Date.now() + 60_000,
      uploadLeaseGeneration: 2,
    };

    await expect(deleteRecording('recording-1', 1)).resolves.toBe(false);
    expect(state.record?.id).toBe('recording-1');
    expect(state.deletes).toHaveLength(0);
  });
});
