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

// Public CDN hosting: installers are ALSO published as GitHub Release assets
// (fast global CDN — the VPS uplink is too slow for 130MB downloads).
// The login-gated /api/downloads/latest 302-redirects here when a release is
// known (auth is still enforced before the redirect); otherwise it streams
// the local file as before.
export interface DesktopReleaseRef {
  version: string;
  file: string;
}

// electron-updater writes latest.yml on every package; its version line is
// the source of truth for which release tag + asset name to link.
export function readLatestReleaseRef(dir: string): DesktopReleaseRef | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8');
  } catch {
    return null;
  }
  const version = text.match(/^version:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1];
  if (!version) return null;
  return { version, file: `PVMS-Packing-Setup-${version}-x64.exe` };
}

export function getDesktopPublicDownloadUrl(dir: string): string | null {
  const repo = (process.env.DESKTOP_GITHUB_REPO || 'pawanshukla500/VMS-Youthnic').replace(/\/+$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const ref = readLatestReleaseRef(dir);
  if (!ref) return null;
  return `https://github.com/${repo}/releases/download/desktop-v${ref.version}/${ref.file}`;
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
