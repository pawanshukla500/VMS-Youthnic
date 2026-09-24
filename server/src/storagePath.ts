// Metadata may only point at this org's Firebase prefix.
// `packing-videos/default/` is a dev fallback for VITE_ORG_ID=default.
// Production rejects it so tenants cannot share one storage namespace.
export function isAcceptableStoragePath(
  storagePath: unknown,
  orgId: string,
  options?: { allowSharedDefault?: boolean }
): boolean {
  if (typeof storagePath !== 'string' || storagePath.includes('..')) return false;
  if (storagePath.startsWith(`packing-videos/${orgId}/`)) return true;
  const allowSharedDefault = options?.allowSharedDefault ?? process.env.NODE_ENV !== 'production';
  return allowSharedDefault && storagePath.startsWith('packing-videos/default/');
}
