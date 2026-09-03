import { describe, it, expect, vi, afterEach } from 'vitest';
import { getApiBaseUrl, normalizeApiBaseUrl } from '../utils/apiBase';

afterEach(() => {
  vi.unstubAllEnvs();
  (globalThis as any).location = undefined;
});

describe('normalizeApiBaseUrl', () => {
  it('trims whitespace and trailing slashes', () => {
    expect(normalizeApiBaseUrl('  https://vms.youthnic.shop///  ')).toBe('https://vms.youthnic.shop');
  });

  it('returns null for empty/missing values', () => {
    expect(normalizeApiBaseUrl('')).toBeNull();
    expect(normalizeApiBaseUrl('   ')).toBeNull();
    expect(normalizeApiBaseUrl(undefined)).toBeNull();
    expect(normalizeApiBaseUrl(null)).toBeNull();
  });
});

describe('getApiBaseUrl', () => {
  it('prefers VITE_API_URL when configured', () => {
    vi.stubEnv('VITE_API_URL', 'https://vms.youthnic.shop/');
    expect(getApiBaseUrl()).toBe('https://vms.youthnic.shop');
  });

  it('falls back to page origin in production (the Hostinger case)', () => {
    vi.stubEnv('VITE_API_URL', '');
    (globalThis as any).location = {
      origin: 'https://vms.youthnic.shop',
      protocol: 'https:',
      hostname: 'vms.youthnic.shop',
      port: '',
    };
    expect(getApiBaseUrl()).toBe('https://vms.youthnic.shop');
  });

  it('maps Vite dev server port 5173 to backend :8080', () => {
    vi.stubEnv('VITE_API_URL', '');
    (globalThis as any).location = {
      origin: 'http://localhost:5173',
      protocol: 'http:',
      hostname: 'localhost',
      port: '5173',
    };
    expect(getApiBaseUrl()).toBe('http://localhost:8080');
  });

  it('falls back to localhost backend when nothing is available', () => {
    vi.stubEnv('VITE_API_URL', '');
    expect(getApiBaseUrl()).toBe('http://localhost:8080');
  });
});
