import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openDBMock, state } = vi.hoisted(() => ({
  openDBMock: vi.fn(),
  state: {
    records: [] as any[],
    updates: [] as any[],
  },
}));

vi.mock('idb', () => ({ openDB: openDBMock }));

import { autoResumeFailedRecordings } from '../utils/videoQueue';

function createMockCursor(records: any[]) {
  let index = 0;
  return {
    get value() {
      return records[index];
    },
    update: vi.fn(async (newVal: any) => {
      records[index] = { ...newVal };
      state.updates.push({ ...newVal });
    }),
    continue: vi.fn(async () => {
      index++;
      return index < records.length ? cursor : null;
    }),
  };
  const cursor = {
    get value() {
      return records[index];
    },
    update: vi.fn(async (newVal: any) => {
      records[index] = { ...newVal };
      state.updates.push({ ...newVal });
    }),
    continue: vi.fn(async () => {
      index++;
      return index < records.length ? cursor : null;
    }),
  };
  return cursor;
}

const store = {
  openCursor: vi.fn(async () => {
    if (state.records.length === 0) return null;
    return createMockCursor(state.records);
  }),
};

const db = {
  transaction: vi.fn(() => ({ objectStore: () => store, done: Promise.resolve() })),
};

openDBMock.mockResolvedValue(db);

describe('autoResumeFailedRecordings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.records = [];
    state.updates = [];
  });

  it('resumes failed recordings for matching user and organization', async () => {
    state.records = [
      {
        id: 'rec-1',
        trackingId: 'TRK001',
        packerId: 'packer@test.com',
        organizationId: 'org-1',
        status: 'failed',
        retryCount: 8,
        nextRetryAt: Date.now() + 3_600_000,
        uploadProgress: 45,
        error: 'Network connection failed',
      },
    ];

    const resumedCount = await autoResumeFailedRecordings('packer@test.com', 'org-1');

    expect(resumedCount).toBe(1);
    expect(state.records[0].status).toBe('pending');
    expect(state.records[0].retryCount).toBe(0);
    expect(state.records[0].uploadProgress).toBe(0);
    expect(state.records[0].nextRetryAt).toBeUndefined();
    expect(state.records[0].error).toBeUndefined();
  });

  it('resumes stuck uploading recordings whose lease expired', async () => {
    state.records = [
      {
        id: 'rec-stuck',
        trackingId: 'TRK002',
        packerId: 'packer@test.com',
        organizationId: 'org-1',
        status: 'uploading',
        uploadLeaseUntil: Date.now() - 50_000, // expired 50 seconds ago
        uploadProgress: 60,
      },
    ];

    const resumedCount = await autoResumeFailedRecordings('packer@test.com', 'org-1');

    expect(resumedCount).toBe(1);
    expect(state.records[0].status).toBe('pending');
    expect(state.records[0].retryCount).toBe(0);
    expect(state.records[0].uploadLeaseUntil).toBeUndefined();
  });

  it('preserves multi-tenant boundaries by skipping records from other organizations', async () => {
    state.records = [
      {
        id: 'rec-other-org',
        trackingId: 'TRK003',
        packerId: 'packer@test.com',
        organizationId: 'org-other',
        status: 'failed',
        retryCount: 3,
      },
    ];

    const resumedCount = await autoResumeFailedRecordings('packer@test.com', 'org-1');

    expect(resumedCount).toBe(0);
    expect(state.records[0].status).toBe('failed');
    expect(state.updates).toHaveLength(0);
  });

  it('preserves operator scoping by skipping records from other packers', async () => {
    state.records = [
      {
        id: 'rec-other-user',
        trackingId: 'TRK004',
        packerId: 'other-packer@test.com',
        organizationId: 'org-1',
        status: 'failed',
        retryCount: 2,
      },
    ];

    const resumedCount = await autoResumeFailedRecordings('packer@test.com', 'org-1');

    expect(resumedCount).toBe(0);
    expect(state.records[0].status).toBe('failed');
  });

  it('adopts unscoped user-owned recordings and sets organizationId', async () => {
    state.records = [
      {
        id: 'rec-unscoped',
        trackingId: 'TRK005',
        packerId: 'packer@test.com',
        organizationId: undefined,
        status: 'failed',
        retryCount: 5,
      },
    ];

    const resumedCount = await autoResumeFailedRecordings('packer@test.com', 'org-1');

    expect(resumedCount).toBe(1);
    expect(state.records[0].status).toBe('pending');
    expect(state.records[0].organizationId).toBe('org-1');
  });

  it('does not touch active uploading recordings within a valid lease', async () => {
    state.records = [
      {
        id: 'rec-active',
        trackingId: 'TRK006',
        packerId: 'packer@test.com',
        organizationId: 'org-1',
        status: 'uploading',
        uploadLeaseUntil: Date.now() + 300_000, // active lease
        uploadProgress: 50,
      },
    ];

    const resumedCount = await autoResumeFailedRecordings('packer@test.com', 'org-1');

    expect(resumedCount).toBe(0);
    expect(state.records[0].status).toBe('uploading');
  });
});
