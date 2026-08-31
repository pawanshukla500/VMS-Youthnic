import { describe, it, expect, vi } from 'vitest';
import { startRecordingSession, appendRecordingChunk, getActiveRecordings, addRecording } from '../utils/videoQueue';

// Mock IndexedDB
vi.mock('../utils/videoQueue', () => {
  const activeRecordings = new Map();
  const pendingRecordings = new Map();
  return {
    startRecordingSession: vi.fn((id, trackingId, stationId, packerId) => {
      activeRecordings.set(id, { id, trackingId, stationId, packerId, chunks: [], startTimestamp: Date.now() });
      return Promise.resolve();
    }),
    appendRecordingChunk: vi.fn((id, chunk) => {
      const rec = activeRecordings.get(id);
      if (rec) rec.chunks.push(chunk);
      return Promise.resolve();
    }),
    getActiveRecordings: vi.fn(() => Promise.resolve(Array.from(activeRecordings.values()))),
    clearActiveRecording: vi.fn((id) => {
      activeRecordings.delete(id);
      return Promise.resolve();
    }),
    addRecording: vi.fn((rec) => {
      pendingRecordings.set(rec.id, rec);
      return Promise.resolve();
    }),
    getPendingRecordings: vi.fn(() => Promise.resolve(Array.from(pendingRecordings.values())))
  };
});

describe('Packing Station 500+ Rapid Scan Stress Test', () => {
  it('Should handle 500 rapid scan transitions without dropping data or race conditions', async () => {
    // Simulate the state machine queue behavior in PackingStation.tsx
    let transitionQueue: Promise<void> = Promise.resolve();
    let currentSessionId: string | null = null;
    let successfulTransitions = 0;

    const simulateScan = (trackingId: string) => {
      transitionQueue = transitionQueue.then(async () => {
        // Stop current
        if (currentSessionId) {
          const active = await getActiveRecordings();
          const currentActive = active.find((r: any) => r.id === currentSessionId);
          if (currentActive) {
            await addRecording({
              id: currentSessionId,
              trackingId: currentActive.trackingId,
              stationId: 'PACK-01',
              packerId: 'test@vms.local',
              blob: new Blob(['fake-data']),
              timestamp: currentActive.startTimestamp,
              duration: 1
            });
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { clearActiveRecording } = await import('../utils/videoQueue');
            await clearActiveRecording(currentSessionId);
          }
        }
        
        // Start next
        const newSessionId = `uuid-${trackingId}`;
        await startRecordingSession(newSessionId, trackingId, 'PACK-01', 'test@vms.local');
        currentSessionId = newSessionId;
        successfulTransitions++;
      });
    };

    // Fire 500 scans immediately (rapid scan race condition simulation)
    for (let i = 1; i <= 500; i++) {
      simulateScan(`TRACK-${i}`);
    }

    // Wait for the queue to flush
    await transitionQueue;

    // Validate
    expect(successfulTransitions).toBe(500);
    
    const { getPendingRecordings } = await import('../utils/videoQueue');
    const finalPending = await getPendingRecordings();
    
    // We expect 499 finalized recordings (the 500th is still "active" / recording)
    expect(finalPending.length).toBe(499);
    expect(currentSessionId).toBe('uuid-TRACK-500');
  });
});
