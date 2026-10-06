import { describe, it, expect } from 'vitest';
import {
  normalizeClientRole,
  isAdminRole,
  isManagerOrAdminRole,
  defaultPathForRole,
  isAdminOnlyPath,
  isPackerAllowedPath,
} from '../utils/roles';

describe('client role helpers', () => {
  it('normalizes mixed-case roles and fails closed on unknown', () => {
    expect(normalizeClientRole('admin')).toBe('ADMIN');
    expect(normalizeClientRole('Manager')).toBe('MANAGER');
    expect(normalizeClientRole('packer')).toBe('PACKER');
    expect(normalizeClientRole('')).toBeNull();
    expect(normalizeClientRole(null)).toBeNull();
    expect(normalizeClientRole('superuser')).toBeNull();
  });

  it('gates manager vs admin vs packer', () => {
    expect(isAdminRole('ADMIN')).toBe(true);
    expect(isAdminRole('manager')).toBe(false);
    expect(isManagerOrAdminRole('manager')).toBe(true);
    expect(isManagerOrAdminRole('packer')).toBe(false);
    expect(isManagerOrAdminRole(null)).toBe(false);
  });

  it('sends packers to packing and staff to the dashboard', () => {
    expect(defaultPathForRole('ADMIN')).toBe('/');
    expect(defaultPathForRole('manager')).toBe('/');
    expect(defaultPathForRole('PACKER')).toBe('/packing');
    expect(defaultPathForRole(null)).toBe('/packing');
  });

  it('pins which paths each role may open', () => {
    expect(isAdminOnlyPath('/ajio-wfr')).toBe(true);
    expect(isAdminOnlyPath('/settings')).toBe(false);
    expect(isPackerAllowedPath('/packing')).toBe(true);
    expect(isPackerAllowedPath('/upload-queue')).toBe(true);
    expect(isPackerAllowedPath('/videos')).toBe(false);
  });
});
