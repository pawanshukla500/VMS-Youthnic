import { describe, it, expect, vi, afterEach } from 'vitest';
import { requestDesktopDownloadTicket, desktopDownloadFileUrl, getDesktopDownloadInfo } from '../utils/desktopDownload';
import { authFetch } from '../utils/authFetch';

vi.mock('../utils/authFetch', () => ({ authFetch: vi.fn() }));

const mockedAuthFetch = vi.mocked(authFetch);

afterEach(() => {
  vi.resetAllMocks();
});

function okJson(payload: unknown, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => payload } as Response;
}

describe('requestDesktopDownloadTicket', () => {
  it('mints a ticket via an authenticated POST', async () => {
    mockedAuthFetch.mockResolvedValue(okJson({ ticket: 'abc-123', expiresIn: 60 }));
    const result = await requestDesktopDownloadTicket();
    expect(result).toEqual({ ticket: 'abc-123', expiresIn: 60 });
    const [url, init] = mockedAuthFetch.mock.calls[0];
    expect(String(url)).toContain('/api/downloads/ticket');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('explains an unpublished installer', async () => {
    mockedAuthFetch.mockResolvedValue({ status: 404, ok: false } as Response);
    await expect(requestDesktopDownloadTicket()).rejects.toThrow('No desktop installer published yet');
  });

  it('asks for a fresh sign-in on auth failures', async () => {
    mockedAuthFetch.mockResolvedValue({ status: 401, ok: false } as Response);
    await expect(requestDesktopDownloadTicket()).rejects.toThrow('Session expired');
  });
});

describe('desktopDownloadFileUrl', () => {
  it('carries the ticket as a query param', () => {
    const url = desktopDownloadFileUrl('abc-123');
    expect(url).toContain('/api/downloads/file?t=abc-123');
  });
});

describe('getDesktopDownloadInfo', () => {
  it('reports an available installer', async () => {
    mockedAuthFetch.mockResolvedValue(okJson({ available: true, file: 'PVMS-Packing-Setup-1.0.0-x64.exe', version: '1.0.0' }));
    await expect(getDesktopDownloadInfo()).resolves.toEqual({
      available: true,
      file: 'PVMS-Packing-Setup-1.0.0-x64.exe',
      version: '1.0.0',
    });
  });

  it('reports unavailable when nothing is published', async () => {
    mockedAuthFetch.mockResolvedValue(okJson({ available: false }));
    await expect(getDesktopDownloadInfo()).resolves.toEqual({ available: false });
  });
});
