// External navigation from the packing shell must never open file:,
// javascript:, or data: URLs. HTTPS is the production path; HTTP is
// allowed only for the local Vite dev server.
export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
