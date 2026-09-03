// Single source of truth for the backend API base URL.
//
// Why this exists: `VITE_API_URL` is baked in at build time. Localhost builds
// have it set, but production builds (Hostinger via docker-compose build args)
// have shipped with it empty or with `http://localhost:8080`, which is the
// packing PC itself — not the VPS. That makes every `/api/*` call (including
// the video-metadata POST that completes an upload) fail only after deploy.
//
// Rules:
// - Prefer VITE_API_URL when set (trimmed, trailing slashes removed).
// - Otherwise fall back to the page origin, because Traefik routes `/api/*`
//   on the same domain to the backend. Exception: the Vite dev server
//   (default port 5173) serves the frontend while the API runs on :8080.

export function normalizeApiBaseUrl(value: unknown): string | null {
  const cleaned = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  return cleaned || null;
}

export function getApiBaseUrl(): string {
  const configured = normalizeApiBaseUrl(
    (import.meta as any)?.env?.VITE_API_URL
  );
  if (configured) return configured;

  const loc = (globalThis as any)?.location;
  if (loc?.origin && typeof loc.origin === 'string') {
    // Vite dev server: frontend on :5173, API on :8080 of the same host.
    if (loc.port === '5173' && typeof loc.hostname === 'string') {
      return `${loc.protocol}//${loc.hostname}:8080`;
    }
    return String(loc.origin).replace(/\/+$/, '');
  }

  return 'http://localhost:8080';
}
