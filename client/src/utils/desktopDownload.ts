// Authenticated installer download for the packing page "Desktop App" button.
//
// /api/downloads/latest requires login (Bearer token), so the file is fetched
// as a blob and saved via a temporary object URL — the browser still shows a
// normal download. The auto-update feed (/api/downloads/files/*) stays public
// because the updater runs without a user session; those bytes carry no secrets.
import { authFetch } from './authFetch';
import { getApiBaseUrl } from './apiBase';

export function parseDownloadFilename(contentDisposition: string | null, fallback: string): string {
  if (contentDisposition) {
    const match = contentDisposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    const name = (match?.[1] || '').trim();
    if (name && !name.includes('/') && !name.includes('\\') && !name.includes('..')) return name;
  }
  return fallback;
}

export async function downloadDesktopInstaller(): Promise<{ file: string }> {
  const res = await authFetch(`${getApiBaseUrl()}/api/downloads/latest`);
  if (res.status === 404) {
    throw new Error('No desktop installer published yet — ask your admin to run a desktop release.');
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('Session expired — sign in again to download.');
  }
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const file = parseDownloadFilename(res.headers.get('Content-Disposition'), 'PVMS-Packing-Setup.exe');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return { file };
}
