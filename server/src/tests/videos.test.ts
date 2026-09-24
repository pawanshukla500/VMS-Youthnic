import { describe, it, expect } from 'vitest';
import { formatDurationHHMMSS, formatVideoRow } from '../videos';

describe('formatDurationHHMMSS', () => {
  it('formats pg BIGINT strings exactly like numbers', () => {
    // node-pg returns BIGINT as string — this exact shape 500'd the Video
    // Library in production (RangeError: Invalid time value).
    expect(formatDurationHHMMSS('23000')).toBe('00:00:23');
    expect(formatDurationHHMMSS(23000)).toBe('00:00:23');
    expect(formatDurationHHMMSS('3600000')).toBe('01:00:00');
    expect(formatDurationHHMMSS(90000000)).toBe('25:00:00');
  });

  it('never throws on null, undefined, or garbage', () => {
    expect(formatDurationHHMMSS(null)).toBe('00:00:00');
    expect(formatDurationHHMMSS(undefined)).toBe('00:00:00');
    expect(formatDurationHHMMSS('')).toBe('00:00:00');
    expect(formatDurationHHMMSS('not-a-number')).toBe('00:00:00');
    expect(formatDurationHHMMSS(-5)).toBe('00:00:00');
  });
});

describe('formatVideoRow', () => {
  const row = {
    id: 'vid-1',
    tracking_id: 'TRACK-1',
    order_id: 'ORD-1',
    marketplace: 'Meesho',
    timestamp: new Date('2026-09-08T08:00:00Z'),
    duration_ms: '23000',
    packer_name: null,
    packer_email: 'packer@shop.com',
    station_code: null,
    station_name: 'Station A',
    upload_status: 'completed',
    storage_path: 'packing-videos/x.mp4',
    flyer_id: 'FLY-9',
    retention_until: null,
    data_retention_until: null,
    review_status: null,
  };

  it('maps a pg-shaped row without throwing', () => {
    expect(formatVideoRow(row)).toMatchObject({
      id: 'vid-1',
      tracking_id: 'TRACK-1',
      order_id: 'ORD-1',
      duration: '00:00:23',
      packer: 'packer@shop.com',
      station: 'Station A',
      status: 'uploaded',
      flyerId: 'FLY-9',
      reviewStatus: 'none',
    });
  });

  it('survives missing duration entirely', () => {
    expect(formatVideoRow({ ...row, duration_ms: undefined }).duration).toBe('00:00:00');
  });

  it('pins date and time to IST regardless of server timezone', () => {
    // 08:00 UTC = 13:30 IST same day.
    const formatted = formatVideoRow(row);
    expect(formatted.date).toBe('08 Sept 2026');
    expect(formatted.time).toContain('1:30');
    expect(formatted.time).toContain('PM');
    expect(formatted.time).toContain('IST');
  });

  it('rolls the date when IST crosses midnight', () => {
    // 18:45 UTC = 00:15 IST next day.
    const formatted = formatVideoRow({ ...row, timestamp: new Date('2026-09-08T18:45:00Z') });
    expect(formatted.date).toBe('09 Sept 2026');
    expect(formatted.time).toContain('12:15');
    expect(formatted.time).toContain('AM');
  });
});
