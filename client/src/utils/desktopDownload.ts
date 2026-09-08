// Ticketed installer download for the packing page "Desktop App" button.
//
// A plain browser navigation cannot send the login token (that's why opening
// /latest directly 401s), and buffering the 130MB file in memory hangs the
// page — so the button mints a single-use 60s ticket (login-gated) and
// navigates with it. The server answers with the fast CDN redirect and the
// browser streams the file with normal progress.
import { authFetch } from './authFetch';
import { getApiBaseUrl } from './apiBase';

export async function requestDesktopDownloadTicket(): Promise<{ ticket: string; expiresIn: number }> {
  const res = await authFetch(`${getApiBaseUrl()}/api/downloads/ticket`, { method: 'POST' });
  if (res.status === 404) {
    throw new Error('No desktop installer published yet — ask your admin to run a desktop release.');
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('Session expired — sign in again to download.');
  }
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const data = await res.json().catch(() => null);
  if (!data || typeof data.ticket !== 'string' || !data.ticket) {
    throw new Error('Download failed — please retry.');
  }
  return { ticket: data.ticket, expiresIn: Number(data.expiresIn) || 60 };
}

export function desktopDownloadFileUrl(ticket: string): string {
  return `${getApiBaseUrl()}/api/downloads/file?t=${encodeURIComponent(ticket)}`;
}

export async function getDesktopDownloadInfo(): Promise<{ available: boolean; file?: string; version?: string }> {
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
