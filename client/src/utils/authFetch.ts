import { auth } from './firebase';

/**
 * Wrapped fetch that attaches the Firebase ID token to every request and
 * transparently refreshes + retries once when the server reports the cached
 * token has expired (HTTP 401). Without this, every fetch after the 1-hour
 * ID-token expiry silently fails for the rest of the shift.
 *
 * Only one retry is attempted per call to avoid masking real auth failures
 * (revoked token, deleted user, etc.). If the retry also returns 401, the
 * caller's existing 401 handling fires.
 */
export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('User not authenticated');
  }

  const send = async (forceRefresh: boolean): Promise<Response> => {
    const token = await currentUser.getIdToken(forceRefresh);
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(url, { ...options, headers });
  };

  const first = await send(false);
  if (first.status !== 401) return first;

  // Token expired. Force-refresh once and retry; if the retry also 401s,
  // propagate it so the caller's auth-failure UI can react.
  try {
    const retry = await send(true);
    return retry;
  } catch (err) {
    throw err;
  }
}
