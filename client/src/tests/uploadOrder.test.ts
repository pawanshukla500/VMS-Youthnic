import { describe, it, expect } from 'vitest';
import { sortOldestFirst, countOverdue, OVERDUE_AFTER_MS, VIDEO_BITRATE_BPS, MIN_RECORDING_HEIGHT, pickRecordingBitrate } from '../utils/videoQueue';

describe('upload guarantee ordering', () => {
  it('uploads oldest recordings first after an outage', () => {
    const records = [{ timestamp: 300 }, { timestamp: 100 }, { timestamp: 200 }];
    expect(sortOldestFirst(records).map((r) => r.timestamp)).toEqual([100, 200, 300]);
    // Does not mutate the input order.
    expect(records[0].timestamp).toBe(300);
  });

  it('flags recordings waiting over 24h as overdue', () => {
    const now = Date.now();
    const records = [
      { timestamp: now - OVERDUE_AFTER_MS - 1000 },
      { timestamp: now - 1000 },
    ];
    expect(countOverdue(records, now)).toBe(1);
    expect(countOverdue([], now)).toBe(0);
  });

  it('holds the recording quality contract', () => {
    expect(MIN_RECORDING_HEIGHT).toBe(720);
    // Legacy alias still resolves to a sensible default.
    expect(VIDEO_BITRATE_BPS).toBeGreaterThanOrEqual(1_000_000);
    // PR-13: adaptive bitrate table
    expect(pickRecordingBitrate(2560, 1440)).toBe(4_000_000); // 2K
    expect(pickRecordingBitrate(1920, 1080)).toBe(4_000_000); // 1080p
    expect(pickRecordingBitrate(1280, 720)).toBe(2_000_000); // 720p floor
    expect(pickRecordingBitrate(640, 360)).toBe(1_150_000); // below floor
  });
});
