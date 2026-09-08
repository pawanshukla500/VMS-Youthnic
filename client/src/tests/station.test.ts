import { describe, it, expect } from 'vitest';
import { resolveStationCode, resolveStationName } from '../utils/station';

describe('resolveStationCode', () => {
  it('prefers the server assignment over Firestore', () => {
    expect(resolveStationCode({ id: 'uuid-1', code: 'PACK5', name: 'Packing 5' }, 'OLD-STATION')).toBe('PACK5');
  });

  it('falls back to the legacy Firestore value', () => {
    expect(resolveStationCode(null, 'OLD-STATION')).toBe('OLD-STATION');
    expect(resolveStationCode({ id: 'u', code: '  ' }, 'OLD-STATION')).toBe('OLD-STATION');
  });

  it('returns null when nothing is assigned anywhere', () => {
    expect(resolveStationCode(null, null)).toBeNull();
    expect(resolveStationCode(null, '   ')).toBeNull();
    expect(resolveStationCode(undefined, undefined)).toBeNull();
  });
});

describe('resolveStationName', () => {
  it('reads the server station name', () => {
    expect(resolveStationName({ id: 'u', code: 'PACK5', name: 'Packing 5' })).toBe('Packing 5');
  });

  it('returns null without a usable name', () => {
    expect(resolveStationName(null)).toBeNull();
    expect(resolveStationName({ id: 'u', code: 'PACK5', name: '  ' })).toBeNull();
    expect(resolveStationName({ id: 'u', code: 'PACK5' })).toBeNull();
  });
});
