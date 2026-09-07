import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findLatestInstaller, isPublishableDownloadFile } from '../downloads';

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
