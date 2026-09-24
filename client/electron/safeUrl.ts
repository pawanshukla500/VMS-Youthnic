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

function posixPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

// Prevent serving files outside the packaged Vite dist (bare startsWith
// on the directory string is bypassable: dist vs dist-evil). Callers should
// path.normalize() first so ".." segments are already collapsed.
export function isPathInsideDir(dir: string, filePath: string): boolean {
  const root = posixPath(dir);
  const resolved = posixPath(filePath);
  if (resolved === root) return true;
  const prefix = `${root}/`;
  if (!resolved.startsWith(prefix)) return false;
  return !resolved.slice(prefix.length).split('/').includes('..');
}
