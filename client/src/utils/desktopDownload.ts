// Installer availability check for the packing page "Desktop App" button.
//
// /api/downloads/latest requires login and 302-redirects to the fast public
// CDN (GitHub Release asset), so the button does a plain navigation and the
// browser streams the file to disk with normal progress — nothing is buffered
// in memory. This helper only pre-checks availability so the button can toast
// a friendly error instead of downloading an error page.
import { authFetch } from './authFetch';
import { getApiBaseUrl } from './apiBase';

export interface DesktopDownloadInfo {
  available: boolean;
  file?: string;
  version?: string;
}

export async function getDesktopDownloadInfo(): Promise<DesktopDownloadInfo> {
  const res = await authFetch(`${getApiBaseUrl()}/api/downloads/info`);
  if (res.status === 401 || res.status === 403) {
    throw new Error('Session expired — sign in again to download.');
  }
  if (!res.ok) throw new Error(`Download check failed (HTTP ${res.status})`);
  const data = await res.json().catch(() => null);
  if (!data || data.available !== true) return { available: false };
  return {
    available: true,
    file: typeof data.file === 'string' ? data.file : undefined,
    version: typeof data.version === 'string' ? data.version : undefined,
  };
}

export function desktopDownloadUrl(): string {
  return `${getApiBaseUrl()}/api/downloads/latest`;
}
