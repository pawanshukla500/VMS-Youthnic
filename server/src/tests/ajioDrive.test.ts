import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { uploadVideoToDrive, driveConfigured } from '../ajio/drive';

function jsonResponse(status: number, payload: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: async () => payload,
  };
}

describe('driveConfigured', () => {
  it('needs the service account plus folder', () => {
    expect(driveConfigured({ AJIO_GDRIVE_SA_JSON: '{}', AJIO_GDRIVE_FOLDER_ID: 'fld' } as any)).not.toBeNull();
    expect(driveConfigured({} as any)).toBeNull();
  });
});

describe('uploadVideoToDrive', () => {
  it('runs session, bytes, share, link in order', async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ajio-')), 'v.mp4');
    fs.writeFileSync(tmp, Buffer.alloc(16, 7));
    try {
      const calls: Array<{ url: string; method: string }> = [];
      const drain = async (init: any) => {
        // The stubbed fetch never reads the file stream; drain it here so
        // the lazily-opened handle cannot race the tmpdir cleanup below.
        const stream = init?.body;
        if (stream && typeof stream.resume === 'function') {
          stream.resume();
          await new Promise<void>((resolve) => {
            stream.on('end', () => resolve());
            stream.on('error', () => resolve());
          });
        }
      };
      const fetchMock = vi.fn(async (url: unknown, init: any) => {
        await drain(init);
        calls.push({ url: String(url), method: init?.method || 'GET' });
        if (String(url).includes('uploadType=resumable')) {
          return jsonResponse(200, {}, { location: 'https://upload.example/session/1' });
        }
        if (String(url).includes('/permissions')) return jsonResponse(200, {});
        if (String(url).includes('/drive/v3/files/') && (init?.method || 'GET') === 'GET') {
          return jsonResponse(200, { id: 'file-1', webViewLink: 'https://drive.google.com/file/d/file-1/view' });
        }
        return jsonResponse(200, { id: 'file-1' });
      });
      const auth = { getAccessToken: async () => 'test-token' };
      const result = await uploadVideoToDrive(
        auth,
        { serviceAccountJson: '{}', folderId: 'folder-9' },
        { filePath: tmp, fileName: 'FN8482808184.mp4', mimeType: 'video/mp4', fileSizeBytes: 16 },
        fetchMock as any
      );
      expect(result).toEqual({ fileId: 'file-1', webViewLink: 'https://drive.google.com/file/d/file-1/view' });
      expect(calls.map((c) => c.method)).toEqual(['POST', 'PUT', 'POST', 'GET']);
      expect(calls[0].url).toContain('uploadType=resumable');
    } finally {
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
  });

  it('retries the byte PUT once on a 5xx', async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ajio-')), 'v.mp4');
    fs.writeFileSync(tmp, Buffer.alloc(8, 1));
    try {
      let puts = 0;
      const fetchMock = vi.fn(async (url: unknown, init: any) => {
        const stream = init?.body;
        if (stream && typeof stream.resume === 'function') {
          stream.resume();
          await new Promise<void>((resolve) => {
            stream.on('end', () => resolve());
            stream.on('error', () => resolve());
          });
        }
        if (String(url).includes('uploadType=resumable')) {
          return jsonResponse(200, {}, { location: 'https://upload.example/session/2' });
        }
        if ((init?.method || 'GET') === 'PUT') {
          puts += 1;
          if (puts === 1) return { status: 500, ok: false, headers: new Headers(), json: async () => ({}) };
          return jsonResponse(200, { id: 'file-2' });
        }
        if (String(url).includes('/permissions')) return jsonResponse(200, {});
        return jsonResponse(200, { id: 'file-2', webViewLink: 'https://drive.google.com/file/d/file-2/view' });
      });
      const auth = { getAccessToken: async () => 'test-token' };
      const result = await uploadVideoToDrive(
        auth,
        { serviceAccountJson: '{}', folderId: 'folder-9' },
        { filePath: tmp, fileName: 'A.mp4', mimeType: 'video/mp4', fileSizeBytes: 8 },
        fetchMock as any
      );
      expect(puts).toBe(2);
      expect(result.fileId).toBe('file-2');
    } finally {
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
  });
});
