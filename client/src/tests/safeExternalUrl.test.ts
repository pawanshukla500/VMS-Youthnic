import { describe, it, expect } from 'vitest';
import { isSafeExternalUrl, isPathInsideDir } from '../../electron/safeUrl';

describe('isSafeExternalUrl', () => {
  it('allows https and local http dev servers', () => {
    expect(isSafeExternalUrl('https://vms.youthnic.shop/packing')).toBe(true);
    expect(isSafeExternalUrl('https://storage.googleapis.com/bucket/file.exe')).toBe(true);
    expect(isSafeExternalUrl('http://127.0.0.1:5173/packing')).toBe(true);
    expect(isSafeExternalUrl('http://localhost:5173/packing')).toBe(true);
  });

  it('rejects file, javascript, data, and remote http', () => {
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('data:text/html,hi')).toBe(false);
    expect(isSafeExternalUrl('http://evil.example/')).toBe(false);
    expect(isSafeExternalUrl('not a url')).toBe(false);
  });
});

describe('isPathInsideDir', () => {
  it('allows files under the dist directory', () => {
    expect(isPathInsideDir('/app/dist', '/app/dist/index.html')).toBe(true);
    expect(isPathInsideDir('/app/dist', '/app/dist/assets/app.js')).toBe(true);
    expect(isPathInsideDir('C:\\app\\dist', 'C:\\app\\dist\\index.html')).toBe(true);
  });

  it('rejects prefix-adjacent and parent paths', () => {
    expect(isPathInsideDir('/app/dist', '/app/dist-evil/index.html')).toBe(false);
    expect(isPathInsideDir('/app/dist', '/app/electron/main.js')).toBe(false);
    expect(isPathInsideDir('/app/dist', '/app/dist/../electron/main.js')).toBe(false);
  });
});
