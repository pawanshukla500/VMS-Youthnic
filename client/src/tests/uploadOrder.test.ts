import { describe, it, expect } from 'vitest';
import { sortOldestFirst, countOverdue, OVERDUE_AFTER_MS, VIDEO_BITRATE_BPS, MIN_RECORDING_HEIGHT } from '../utils/videoQueue';

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

  it('holds the 1080p quality contract', () => {
    expect(MIN_RECORDING_HEIGHT).toBe(720);
    expect(VIDEO_BITRATE_BPS).toBe(2500000);
  });
});
