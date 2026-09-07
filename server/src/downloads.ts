// Desktop installer publishing: the packing page "Desktop App" button points
// at /api/downloads/latest, which serves the newest Windows installer dropped
// into DESKTOP_DOWNLOAD_DIR (default <server-cwd>/downloads).
import fs from 'fs';
import path from 'path';

export interface InstallerInfo {
  file: string;
  version: string;
  sizeBytes: number;
  updatedAt: string;
}

export function getDesktopDownloadDir(): string {
  const dir = process.env.DESKTOP_DOWNLOAD_DIR || path.join(process.cwd(), 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Newest *.exe by mtime wins so re-publishing is just "drop the new file".
// Version is parsed from PVMS-Packing-Setup-<version>[-arch].exe names.
export function findLatestInstaller(dir: string): InstallerInfo | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { info: InstallerInfo; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.exe')) continue;
    const full = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!best || stat.mtimeMs > best.mtimeMs) {
      // Strip the .exe + arch tag (PVMS-Packing-Setup-1.2.3-x64.exe) before
      // parsing so "-x64.exe" can never leak into the version string.
      const base = entry.name
        .replace(/\.exe$/i, '')
        .replace(/-(x64|arm64|ia32)$/i, '');
      const versionMatch = base.match(/(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)$/);
      best = {
        mtimeMs: stat.mtimeMs,
        info: {
          file: entry.name,
          version: versionMatch ? versionMatch[1] : 'unknown',
          sizeBytes: stat.size,
          updatedAt: new Date(stat.mtimeMs).toISOString(),
        },
      };
    }
  }
  return best?.info ?? null;
}

// Allowlist for the public auto-update feed (/api/downloads/files/:file):
// only installer artifacts, never dotfiles, never paths. The updater's
// generic provider reads latest.yml from the same directory.
export function isPublishableDownloadFile(name: unknown): boolean {
  if (typeof name !== 'string' || !name) return false;
  if (path.basename(name) !== name) return false;
  if (name.startsWith('.')) return false;
  const lower = name.toLowerCase();
  return lower.endsWith('.exe') || lower === 'latest.yml' || lower.endsWith('.blockmap');
}
