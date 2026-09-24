// PVMS Packing Station — Electron main process.
//
// Thin native shell around the SAME Vite React build as the web app.
// Recording, queueing, and uploading all run unchanged in the renderer
// (Chromium), so packing behaviour stays identical. The shell adds:
//   - local disk mirror IPC (videos survive browser-storage eviction)
//   - close-to-tray so uploads keep running in the background
//   - OS sleep hold while recording/uploading
//   - auto-launch at login, single instance, auto-update
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, powerSaveBlocker, shell, protocol } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'node:path';
import fs from 'node:fs';
import { isSafeExternalUrl, isPathInsideDir } from './safeUrl';

const APP_SCHEME = 'app';
const APP_HOST = 'localhost';
const APP_USER_MODEL_ID = 'shop.youthnic.pvms.packing';
// Renderer dev server (must match `npm run electron:dev` in package.json).
const DEV_URL = process.env.ELECTRON_DEV_URL || 'http://127.0.0.1:5173/packing';

// Custom protocol must be privileged BEFORE app.ready() so BrowserRouter
// routes, module workers, and fetch() all work from app:// URLs.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, allowServiceWorkers: false },
  },
]);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// Disk mirror store
// ---------------------------------------------------------------------------

// Videos mirrored to disk live under the OS user-data dir (NOT the browser
// profile), so a browser storage eviction can never lose a packing video.
function recordingsDir(): string {
  const dir = path.join(app.getPath('userData'), 'pvms-recordings');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Recording ids are uuids, but never trust the renderer for path building.
function sanitizeRecordingId(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  return clean || null;
}

function registerMirrorIpc() {
  // Write via .tmp + atomic rename so a crash can never leave a half-written
  // video that a later reconcile would mistake for a complete recording.
  ipcMain.handle('desktop:save-recording', async (_event, payload) => {
    const id = sanitizeRecordingId(payload?.id);
    const ext = payload?.ext === 'mp4' ? 'mp4' : 'webm';
    const data = payload?.data;
    if (!id || !(data instanceof ArrayBuffer) || data.byteLength === 0) {
      throw new Error('Invalid recording payload');
    }
    const dir = recordingsDir();
    const tmpPath = path.join(dir, `${id}.tmp`);
    const finalPath = path.join(dir, `${id}.${ext}`);
    const metaPath = path.join(dir, `${id}.json`);
    await fs.promises.writeFile(tmpPath, Buffer.from(data));
    await fs.promises.writeFile(
      metaPath,
      JSON.stringify({ ...(payload?.meta ?? {}), ext, size: data.byteLength, savedAt: new Date().toISOString() })
    );
    await fs.promises.rename(tmpPath, finalPath);
    return { path: finalPath, size: data.byteLength };
  });

  ipcMain.handle('desktop:read-recording', async (_event, payload) => {
    const id = sanitizeRecordingId(payload?.id);
    if (!id) throw new Error('Invalid recording id');
    const dir = recordingsDir();
    const match = (await fs.promises.readdir(dir)).find((f) => f === `${id}.mp4` || f === `${id}.webm`);
    if (!match) throw new Error('Recording not found on disk');
    const buf = await fs.promises.readFile(path.join(dir, match));
    let meta: Record<string, unknown> | null = null;
    try {
      meta = JSON.parse(await fs.promises.readFile(path.join(dir, `${id}.json`), 'utf8'));
    } catch {
      meta = null;
    }
    const exact = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return { id, ext: match.endsWith('.mp4') ? 'mp4' : 'webm', data: exact, meta };
  });

  ipcMain.handle('desktop:list-recordings', async () => {
    const dir = recordingsDir();
    const files = await fs.promises.readdir(dir);
    const entries = [];
    for (const file of files) {
      if (!file.endsWith('.mp4') && !file.endsWith('.webm')) continue;
      const id = file.replace(/\.(mp4|webm)$/, '');
      try {
        const stat = await fs.promises.stat(path.join(dir, file));
        let meta: Record<string, unknown> | null = null;
        try {
          meta = JSON.parse(await fs.promises.readFile(path.join(dir, `${id}.json`), 'utf8'));
        } catch {
          meta = null;
        }
        entries.push({ id, ext: file.endsWith('.mp4') ? 'mp4' : 'webm', size: stat.size, mtimeMs: stat.mtimeMs, meta });
      } catch {
        // File vanished mid-list; ignore.
      }
    }
    return entries;
  });

  ipcMain.handle('desktop:delete-recording', async (_event, payload) => {
    const id = sanitizeRecordingId(payload?.id);
    if (!id) throw new Error('Invalid recording id');
    const dir = recordingsDir();
    for (const name of [`${id}.mp4`, `${id}.webm`, `${id}.json`, `${id}.tmp`]) {
      try {
        await fs.promises.unlink(path.join(dir, name));
      } catch {
        // Already gone — fine.
      }
    }
    return { deleted: true };
  });

  ipcMain.handle('desktop:get-version', () => app.getVersion());
}

// ---------------------------------------------------------------------------
// Background-upload support: sleep hold + tray
// ---------------------------------------------------------------------------

let sleepBlockerId: number | null = null;
let lastUploadHeartbeat = 0;

function registerUploadHoldIpc() {
  ipcMain.on('desktop:upload-hold', (_event, payload) => {
    if (payload?.active !== true) return;
    lastUploadHeartbeat = Date.now();
    if (sleepBlockerId === null) {
      sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
  });

  // The renderer heartbeats every ~25s while work is pending; if it goes
  // quiet (page idle, renderer crashed) the hold releases by itself.
  setInterval(() => {
    if (sleepBlockerId !== null && Date.now() - lastUploadHeartbeat > 75_000) {
      try {
        powerSaveBlocker.stop(sleepBlockerId);
      } catch {
        // Already stopped.
      }
      sleepBlockerId = null;
    }
  }, 30_000);
}

// ---------------------------------------------------------------------------
// App protocol (serve the packaged Vite build with SPA fallback)
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function registerAppProtocol() {
  const distDir = path.join(__dirname, '..', 'dist');
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/' || pathname === '') pathname = '/index.html';
      let filePath = path.normalize(path.join(distDir, pathname));
      if (!isPathInsideDir(distDir, filePath)) return new Response('Forbidden', { status: 403 });
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
      } catch {
        filePath = path.join(distDir, 'index.html'); // SPA fallback for routes
      }
      if (!isPathInsideDir(distDir, filePath)) return new Response('Forbidden', { status: 403 });
      const data = await fs.promises.readFile(filePath);
      const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { headers: { 'Content-Type': mime } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// ---------------------------------------------------------------------------
// Window / tray
// ---------------------------------------------------------------------------

function trayIconPath(): string {
  // Tray + window icons ship with the app (build/ is generated from the repo
  // logo by `npm run electron:icon`). The white tile keeps the black mark
  // readable on any light/dark theme.
  const candidates = [
    path.join(__dirname, '..', 'build', 'tray.png'),
    path.join(__dirname, '..', 'src', 'assets', 'logo.png'),
    path.join(process.resourcesPath, 'build', 'tray.png'),
    path.join(process.resourcesPath, 'logo.png'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Try next.
    }
  }
  return '';
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const iconPath = trayIconPath();
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip(`PVMS Packing Station v${app.getVersion()} — uploads run in the background`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Packing Station', click: () => showWindow() },
      { type: 'separator' },
      {
        label: 'Quit (pending uploads stop)',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('click', () => showWindow());
}

function createWindow() {
  const iconPath = trayIconPath();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'PVMS Packing Station',
    backgroundColor: '#0b0e13',
    autoHideMenuBar: true,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Hidden/minimized windows must keep uploading — never throttle them.
      backgroundThrottling: false,
    },
  });

  // Packing PCs open straight on the packing page (same route as the web app).
  if (!app.isPackaged) {
    mainWindow.loadURL(DEV_URL);
    if (process.env.ELECTRON_DEVTOOLS === '1') mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadURL(`${APP_SCHEME}://${APP_HOST}/packing`);
    if (process.argv.includes('--kiosk')) mainWindow.setKiosk(true);
  }

  // External links (installer download, support pages) open in the real
  // browser — never navigate the app window away.
  const openExternally = (url: string) => {
    if (url.startsWith(`${APP_SCHEME}://`) || url.startsWith('http://127.0.0.1:5173') || url.startsWith('http://localhost:5173')) {
      return false;
    }
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return true;
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => ({ action: openExternally(url) ? 'deny' : 'allow' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (openExternally(url)) event.preventDefault();
  });

  // Close hides to tray so background uploads continue; quit from the tray.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

// Camera for recording. The app is video-only by policy and never requests
// microphone access; everything else (notifications, etc.) stays denied.
function registerPermissions() {
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((_webContents: unknown, permission: string, callback: (allow: boolean) => void) => {
    callback(permission === 'media');
  });
  try {
    session.defaultSession.setPermissionCheckHandler((_webContents: unknown, permission: string) => permission === 'media');
  } catch {
    // Older handler signature — request handler above is enough.
  }
}

function configureAutoLaunch() {
  try {
    const marker = path.join(app.getPath('userData'), 'autostart.configured');
    if (!fs.existsSync(marker)) {
      app.setLoginItemSettings({ openAtLogin: true, name: 'PVMS Packing Station' });
      fs.writeFileSync(marker, new Date().toISOString());
    }
  } catch (err) {
    console.warn('Auto-launch setup skipped:', err instanceof Error ? err.message : err);
  }
}

async function setupAutoUpdater() {
  if (!app.isPackaged) return;
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    const check = () => {
      autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
        console.warn('Auto-update check skipped:', err instanceof Error ? err.message : err);
      });
    };
    setTimeout(check, 30_000);
    setInterval(check, 6 * 3600 * 1000);
  } catch (err) {
    console.warn('Auto-update disabled:', err instanceof Error ? err.message : err);
  }
}

// Reserved for a future system-browser SSO handoff (pvms://auth?...).
function registerDeepLink() {
  try {
    if (!app.isDefaultProtocolClient('pvms')) app.setAsDefaultProtocolClient('pvms');
  } catch (err) {
    console.warn('Protocol registration skipped:', err instanceof Error ? err.message : err);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());

  void app.whenReady().then(async () => {
    app.setAppUserModelId(APP_USER_MODEL_ID);
    registerAppProtocol();
    registerMirrorIpc();
    registerUploadHoldIpc();
    registerPermissions();
    createWindow();
    createTray();
    configureAutoLaunch();
    registerDeepLink();
    await setupAutoUpdater();
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('window-all-closed', () => {
    // Tray keeps the app alive for background uploads; quit explicitly.
    if (process.platform === 'darwin') app.quit();
  });
}
