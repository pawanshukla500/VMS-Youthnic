import { describe, it, expect, vi, afterEach } from 'vitest';
import { getDesktopDownloadInfo, desktopDownloadUrl } from '../utils/desktopDownload';
import { authFetch } from '../utils/authFetch';

vi.mock('../utils/authFetch', () => ({ authFetch: vi.fn() }));

const mockedAuthFetch = vi.mocked(authFetch);

afterEach(() => {
  vi.resetAllMocks();
});

function okJson(payload: unknown) {
  return { status: 200, ok: true, json: async () => payload } as Response;
}

describe('getDesktopDownloadInfo', () => {
  it('reports an available installer with file and version', async () => {
    mockedAuthFetch.mockResolvedValue(okJson({ available: true, file: 'PVMS-Packing-Setup-1.0.0-x64.exe', version: '1.0.0' }));
    const info = await getDesktopDownloadInfo();
    expect(info).toEqual({ available: true, file: 'PVMS-Packing-Setup-1.0.0-x64.exe', version: '1.0.0' });
    expect(String(mockedAuthFetch.mock.calls[0][0])).toContain('/api/downloads/info');
  });

  it('reports unavailable when nothing is published', async () => {
    mockedAuthFetch.mockResolvedValue(okJson({ available: false }));
    await expect(getDesktopDownloadInfo()).resolves.toEqual({ available: false });
  });

  it('asks for a fresh sign-in on auth failures', async () => {
    mockedAuthFetch.mockResolvedValue({ status: 401, ok: false } as Response);
    await expect(getDesktopDownloadInfo()).rejects.toThrow('Session expired');
  });
});

describe('desktopDownloadUrl', () => {
  it('points at the login-gated latest endpoint', () => {
    expect(desktopDownloadUrl()).toContain('/api/downloads/latest');
  });
});
