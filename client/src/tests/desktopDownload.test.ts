import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseDownloadFilename, downloadDesktopInstaller } from '../utils/desktopDownload';
import { authFetch } from '../utils/authFetch';

vi.mock('../utils/authFetch', () => ({ authFetch: vi.fn() }));

const mockedAuthFetch = vi.mocked(authFetch);

afterEach(() => {
  vi.resetAllMocks();
  delete (globalThis as { document?: unknown }).document;
});

function stubDocument(clickSpy: () => void) {
  const anchor = { href: '', download: '', click: clickSpy, remove: () => {} };
  (globalThis as { document?: unknown }).document = {
    createElement: () => anchor,
    body: { appendChild: () => {} },
  };
  return anchor;
}

describe('parseDownloadFilename', () => {
  it('reads plain and RFC5987 filenames', () => {
    expect(parseDownloadFilename('attachment; filename="PVMS-Packing-Setup-1.0.0-x64.exe"', 'fallback.exe'))
      .toBe('PVMS-Packing-Setup-1.0.0-x64.exe');
    expect(parseDownloadFilename("attachment; filename*=UTF-8''PVMS-Setup.exe", 'fallback.exe')).toBe('PVMS-Setup.exe');
  });

  it('rejects traversal and falls back', () => {
    expect(parseDownloadFilename('attachment; filename="../evil.exe"', 'fallback.exe')).toBe('fallback.exe');
    expect(parseDownloadFilename(null, 'fallback.exe')).toBe('fallback.exe');
  });
});

describe('downloadDesktopInstaller', () => {
  it('saves the blob under the server filename', async () => {
    const click = vi.fn();
    const anchor = stubDocument(click);
    mockedAuthFetch.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'Content-Disposition': 'attachment; filename="PVMS-Packing-Setup-1.0.0-x64.exe"' }),
      blob: async () => new Blob(['fake-exe']),
    } as Response);

    const result = await downloadDesktopInstaller();

    expect(result).toEqual({ file: 'PVMS-Packing-Setup-1.0.0-x64.exe' });
    expect(mockedAuthFetch).toHaveBeenCalledTimes(1);
    expect(String(mockedAuthFetch.mock.calls[0][0])).toContain('/api/downloads/latest');
    expect(anchor.download).toBe('PVMS-Packing-Setup-1.0.0-x64.exe');
    expect(anchor.href.startsWith('blob:')).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('explains an unpublished installer', async () => {
    mockedAuthFetch.mockResolvedValue({ status: 404, ok: false, headers: new Headers() } as Response);
    await expect(downloadDesktopInstaller()).rejects.toThrow('No desktop installer published yet');
  });

  it('asks for a fresh sign-in on auth failures', async () => {
    mockedAuthFetch.mockResolvedValue({ status: 401, ok: false, headers: new Headers() } as Response);
    await expect(downloadDesktopInstaller()).rejects.toThrow('Session expired');
  });
});
