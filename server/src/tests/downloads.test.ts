import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findLatestInstaller, isPublishableDownloadFile, readLatestReleaseRef, getDesktopPublicDownloadUrl, issueDownloadTicket, consumeDownloadTicket } from '../downloads';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvms-downloads-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeExe(name: string, ageMs: number) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, 'fake-installer');
  const mtime = new Date(Date.now() - ageMs);
  fs.utimesSync(full, mtime, mtime);
}

describe('findLatestInstaller', () => {
  it('returns null when nothing is published', () => {
    expect(findLatestInstaller(dir)).toBeNull();
  });

  it('ignores non-installer files', () => {
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    fs.writeFileSync(path.join(dir, 'latest.yml'), 'version: 1.0.0');
    expect(findLatestInstaller(dir)).toBeNull();
  });

  it('picks the newest exe and parses its version', () => {
    writeExe('PVMS-Packing-Setup-1.0.0-x64.exe', 60_000);
    writeExe('PVMS-Packing-Setup-1.2.3-x64.exe', 1_000);
    const latest = findLatestInstaller(dir);
    expect(latest?.file).toBe('PVMS-Packing-Setup-1.2.3-x64.exe');
    expect(latest?.version).toBe('1.2.3');
    expect(latest?.sizeBytes).toBeGreaterThan(0);
    expect(typeof latest?.updatedAt).toBe('string');
  });

  it('falls back to unknown version for odd filenames', () => {
    writeExe('packing-setup.exe', 0);
    expect(findLatestInstaller(dir)?.version).toBe('unknown');
  });
});

describe('isPublishableDownloadFile', () => {
  it('allows installer artifacts only', () => {
    expect(isPublishableDownloadFile('PVMS-Packing-Setup-1.0.0-x64.exe')).toBe(true);
    expect(isPublishableDownloadFile('latest.yml')).toBe(true);
    expect(isPublishableDownloadFile('PVMS-Packing-Setup-1.0.0-x64.exe.blockmap')).toBe(true);
  });

  it('rejects traversal, dotfiles, and anything else', () => {
    expect(isPublishableDownloadFile('../server.log')).toBe(false);
    expect(isPublishableDownloadFile('sub/dir.exe')).toBe(false);
    expect(isPublishableDownloadFile('.env')).toBe(false);
    expect(isPublishableDownloadFile('notes.txt')).toBe(false);
    expect(isPublishableDownloadFile('')).toBe(false);
    expect(isPublishableDownloadFile(null)).toBe(false);
  });
});

describe('desktop CDN redirect', () => {
  it('builds the Firebase Storage URL from latest.yml', () => {
    process.env.FIREBASE_STORAGE_BUCKET = 'demo-bucket';
    try {
      fs.writeFileSync(path.join(dir, 'latest.yml'), 'version: 1.2.3\nfiles:\n  - url: PVMS-Packing-Setup-1.2.3-x64.exe\n');
      expect(readLatestReleaseRef(dir)).toEqual({ version: '1.2.3', file: 'PVMS-Packing-Setup-1.2.3-x64.exe' });
      expect(getDesktopPublicDownloadUrl(dir)).toBe(
        'https://storage.googleapis.com/demo-bucket/desktop-releases/PVMS-Packing-Setup-1.2.3-x64.exe'
      );
    } finally {
      delete process.env.FIREBASE_STORAGE_BUCKET;
    }
  });

  it('returns null without a feed file', () => {
    expect(readLatestReleaseRef(dir)).toBeNull();
    expect(getDesktopPublicDownloadUrl(dir)).toBeNull();
  });

  it('returns null for a malformed feed or missing bucket', () => {
    fs.writeFileSync(path.join(dir, 'latest.yml'), 'no-version-here: true\n');
    expect(readLatestReleaseRef(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'latest.yml'), 'version: 1.0.0\n');
    delete process.env.FIREBASE_STORAGE_BUCKET;
    expect(getDesktopPublicDownloadUrl(dir)).toBeNull();
  });
});

describe('download tickets', () => {
  it('issues a ticket that consumes exactly once', () => {
    const store = new Map<string, number>();
    const { ticket, expiresIn } = issueDownloadTicket(store, 1000);
    expect(typeof ticket).toBe('string');
    expect(ticket.length).toBeGreaterThan(10);
    expect(expiresIn).toBe(60);
    expect(consumeDownloadTicket(store, ticket, 2000)).toBe(true);
    expect(consumeDownloadTicket(store, ticket, 2000)).toBe(false);
  });

  it('rejects expired, unknown, and malformed tickets', () => {
    const store = new Map<string, number>();
    const { ticket } = issueDownloadTicket(store, 1000, 1000);
    expect(consumeDownloadTicket(store, ticket, 5000)).toBe(false);
    expect(consumeDownloadTicket(store, 'nope', 1500)).toBe(false);
    expect(consumeDownloadTicket(store, '', 1500)).toBe(false);
    expect(consumeDownloadTicket(store, null, 1500)).toBe(false);
  });
});
