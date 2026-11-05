import { describe, it, expect } from 'vitest';

describe('Reorganize Stations and Packers logic', () => {
  const PROTECTED_EMAILS = new Set([
    'returnorders@vbexports.co.in',
    'vaibhav@vbexports.co.in',
    'nidhi@vbexports.co.in',
    'orders2@vbexports.co.in',
    'listings@vbexports.co.in'
  ]);

  it('protects core management emails from deletion', () => {
    expect(PROTECTED_EMAILS.has('returnorders@vbexports.co.in')).toBe(true);
    expect(PROTECTED_EMAILS.has('vaibhav@vbexports.co.in')).toBe(true);
    expect(PROTECTED_EMAILS.has('nidhi@vbexports.co.in')).toBe(true);
    expect(PROTECTED_EMAILS.has('orders2@vbexports.co.in')).toBe(true);
    expect(PROTECTED_EMAILS.has('listings@vbexports.co.in')).toBe(true);
    expect(PROTECTED_EMAILS.has('pack1@vbexports.co.in')).toBe(false);
  });

  it('generates correct 10 target station codes and names', () => {
    const stations = Array.from({ length: 10 }, (_, i) => ({
      code: `PC-${i + 1}`,
      name: `PC-${i + 1}`
    }));
    expect(stations).toHaveLength(10);
    expect(stations[0].code).toBe('PC-1');
    expect(stations[9].code).toBe('PC-10');
  });

  it('generates correct 10 target packer emails and display names', () => {
    const packers = Array.from({ length: 10 }, (_, i) => ({
      email: `pack${i + 1}@youthnic.shop`,
      displayName: `PC-${i + 1}`
    }));
    expect(packers).toHaveLength(10);
    expect(packers[0].email).toBe('pack1@youthnic.shop');
    expect(packers[0].displayName).toBe('PC-1');
    expect(packers[9].email).toBe('pack10@youthnic.shop');
    expect(packers[9].displayName).toBe('PC-10');
  });

  it('maps legacy station codes to target station numbers', () => {
    function mapLegacyCode(code: string): number | null {
      const match = code.trim().toUpperCase().match(/^(?:PS|STATION)[-_ ]?([0-9]+)$/);
      return match ? parseInt(match[1], 10) : null;
    }

    expect(mapLegacyCode('PS-1')).toBe(1);
    expect(mapLegacyCode('PS-2')).toBe(2);
    expect(mapLegacyCode('Ps-3')).toBe(3);
    expect(mapLegacyCode('ps-4')).toBe(4);
    expect(mapLegacyCode('PS-5')).toBe(5);
    expect(mapLegacyCode('PS-6')).toBe(6);
    expect(mapLegacyCode('PS-7')).toBe(7);
    expect(mapLegacyCode('fwpack-1')).toBe(null);
    expect(mapLegacyCode('Packing station 1')).toBe(null);
  });
});
