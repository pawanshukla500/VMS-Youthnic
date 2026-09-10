// Google Drive upload for Ajio WFR videos (Service Account).
//
// Why a Service Account and not the Gmail App Password: App Passwords cannot
// touch the Drive API at all. A Service Account (JSON key) with the single
// shared folder shared to its email needs no OAuth consent screen, never
// expires, and can only ever see that one folder (drive.file scope).
import { JWT } from 'google-auth-library';
import fs from 'fs';

export interface DriveConfig {
  serviceAccountJson: string;
  folderId: string;
}

export function driveConfigured(env: NodeJS.ProcessEnv = process.env): DriveConfig | null {
  const serviceAccountJson = (env.AJIO_GDRIVE_SA_JSON || '').trim();
  const folderId = (env.AJIO_GDRIVE_FOLDER_ID || '').trim();
  if (!serviceAccountJson || !folderId) return null;
  return { serviceAccountJson, folderId };
}

export interface DriveAuth {
  getAccessToken(): Promise<string>;
}

export function createServiceAccountAuth(serviceAccountJson: string): DriveAuth {
  const creds = JSON.parse(serviceAccountJson) as { client_email?: string; private_key?: string };
  if (!creds.client_email || !creds.private_key) throw new Error('Service account JSON needs client_email + private_key');
  const client = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  return {
    getAccessToken: async () => {
      const tokens = await client.authorize();
      if (!tokens.access_token) throw new Error('Drive auth failed (no access token)');
      return tokens.access_token;
    },
  };
}

export interface DriveUploadInput {
  filePath: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
}

// Resumable upload via plain REST (deterministic for 100MB+ videos —
// multipart tops out at 5MB, so it is never used here):
// 1. session initiation -> upload URL, 2. single-shot PUT of the bytes,
// 3. share as anyone-with-link reader, 4. read back the webViewLink.
// fetchFn is injectable so the flow is unit-testable without Google.
export async function uploadVideoToDrive(
  auth: DriveAuth,
  config: DriveConfig,
  input: DriveUploadInput,
  fetchFn: typeof fetch = fetch
): Promise<{ fileId: string; webViewLink: string }> {
  const token = await auth.getAccessToken();
  const headers = { Authorization: `Bearer ${token}` };

  const sessionRes = await fetchFn('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': input.mimeType,
      'X-Upload-Content-Length': String(input.fileSizeBytes),
    },
    body: JSON.stringify({ name: input.fileName, parents: [config.folderId], mimeType: input.mimeType }),
  });
  if (!sessionRes.ok) {
    throw new Error(`Drive upload session failed (HTTP ${sessionRes.status})`);
  }
  const sessionUrl = sessionRes.headers.get('location');
  if (!sessionUrl) throw new Error('Drive upload session returned no upload URL');

  const putOnce = () =>
    fetchFn(sessionUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(input.fileSizeBytes),
        'Content-Range': `bytes 0-${input.fileSizeBytes - 1}/${input.fileSizeBytes}`,
      },
      body: fs.createReadStream(input.filePath) as any,
      duplex: 'half',
    } as any);

  let putRes = await putOnce();
  if (putRes.status >= 500) putRes = await putOnce();
  if (!(putRes.status === 200 || putRes.status === 201)) {
    throw new Error(`Drive upload failed (HTTP ${putRes.status})`);
  }
  const created = (await putRes.json().catch(() => null)) as { id?: string } | null;
  const fileId = created?.id;
  if (!fileId) throw new Error('Drive upload returned no file id');

  const permRes = await fetchFn(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  if (!permRes.ok) throw new Error(`Drive share failed (HTTP ${permRes.status})`);

  const metaRes = await fetchFn(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,webViewLink`, {
    headers,
  });
  const meta = (await metaRes.json().catch(() => null)) as { webViewLink?: string } | null;
  if (!meta?.webViewLink) throw new Error('Drive file has no shareable link');
  return { fileId, webViewLink: meta.webViewLink };
}
