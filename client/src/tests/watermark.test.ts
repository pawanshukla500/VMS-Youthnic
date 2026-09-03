import { describe, it, expect } from 'vitest';
import { buildWatermarkLines } from '../utils/canvasWatermarker';

describe('buildWatermarkLines', () => {
  it('prints the station name on line 2, never the operator email', () => {
    const [line1, line2] = buildWatermarkLines({
      stationId: 'PACK-01',
      stationName: 'Packing Station 1',
      trackingId: '9999',
      time: '03 Sept, 14:00:00',
    });
    expect(line1).toContain('PACK-01');
    expect(line1).toContain('9999');
    expect(line2).toContain('Packing Station 1');
    expect(line2).not.toContain('@');
  });

  it('falls back to the station code when unnamed', () => {
    const [, line2] = buildWatermarkLines({
      stationId: 'UNKNOWN',
      stationName: null,
      trackingId: 'IDLE',
      time: 't',
    });
    expect(line2).toContain('UNKNOWN');
  });

  it('shows IDLE without a tracking id', () => {
    const [line1] = buildWatermarkLines({ stationId: 'S', trackingId: '', time: 't' });
    expect(line1).toContain('IDLE');
  });
});
