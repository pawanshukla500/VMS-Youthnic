import { auth } from './firebase';

export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const currentUser = auth.currentUser;
  
  if (!currentUser) {
    throw new Error('User not authenticated');
  }

  const token = await currentUser.getIdToken();

  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);

  return fetch(url, {
    ...options,
    headers,
  });
}
