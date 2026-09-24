export type AppRole = 'ADMIN' | 'MANAGER' | 'PACKER';

export function normalizeClientRole(role: unknown): AppRole | null {
  if (typeof role !== 'string' || !role.trim()) return null;
  const upper = role.trim().toUpperCase();
  if (upper === 'ADMIN') return 'ADMIN';
  if (upper === 'MANAGER') return 'MANAGER';
  if (upper === 'PACKER') return 'PACKER';
  return null;
}

export function isAdminRole(role: unknown): boolean {
  return normalizeClientRole(role) === 'ADMIN';
}

export function isManagerOrAdminRole(role: unknown): boolean {
  const normalized = normalizeClientRole(role);
  return normalized === 'ADMIN' || normalized === 'MANAGER';
}

export function defaultPathForRole(role: unknown): string {
  return isManagerOrAdminRole(role) ? '/' : '/packing';
}

// Admin-only pages stay off the manager/packer shells even if someone
// types the URL. Server still 403s; this avoids a broken empty screen.
export function isAdminOnlyPath(pathname: string): boolean {
  return pathname === '/ajio-wfr';
}

export function isPackerAllowedPath(pathname: string): boolean {
  return pathname === '/packing' || pathname === '/upload-queue';
}
