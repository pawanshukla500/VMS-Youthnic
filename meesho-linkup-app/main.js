const { app, BrowserWindow, ipcMain, dialog, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let meeshoWorkerWindow = null;
let loginWindow = null;
let autoSyncTimer = null;
let isSyncing = false;

// Persistent configuration
const configFilePath = path.join(app.getPath('userData'), 'meesho_linkup_config.json');
let config = {
  vmsApiUrl: 'https://vms.youthnic.shop',
  authToken: '',
  orgName: '',
  meeshoOrdersUrl: 'https://supplier.meesho.com/panel/v3/new/fulfillment/yqcue/orders/pending',
  pollIntervalSeconds: 30,
  actionDelayMs: 1000,
  showBrowser: false
};

function loadConfig() {
  try {
    if (fs.existsSync(configFilePath)) {
      const data = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
      config = { ...config, ...data };
    }
  } catch (e) {
    console.warn('Could not read saved config, using defaults');
  }
}

function saveConfig(newConfig) {
  try {
    config = { ...config, ...newConfig };
    fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save config:', e);
  }
}

// Register custom protocol for 1-click VMS configuration
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('vms-companion', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('vms-companion');
}

async function checkAndBroadcastVmsStatus() {
  if (!config.authToken) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vms:status', {
        connected: false,
        statusText: 'VMS DB: Not Connected',
        orgName: ''
      });
    }
    return { connected: false, statusText: 'VMS DB: Not Connected', orgName: '' };
  }

  try {
    const res = await fetch(`${config.vmsApiUrl}/api/meesho/companion-auth/check`, {
      headers: {
        'Authorization': `Bearer ${config.authToken}`
      }
    });

    if (res.ok) {
      const data = await res.json();
      const orgName = data.orgName || config.orgName || 'Connected';
      if (data.orgName && data.orgName !== config.orgName) {
        saveConfig({ orgName: data.orgName });
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('vms:status', {
          connected: true,
          statusText: `VMS DB: ${orgName}`,
          orgName
        });
      }
      return { connected: true, statusText: `VMS DB: ${orgName}`, orgName };
    } else {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('vms:status', {
          connected: false,
          statusText: 'VMS DB: Unauthorized',
          orgName: ''
        });
      }
      return { connected: false, statusText: 'VMS DB: Unauthorized', orgName: '' };
    }
  } catch (err) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vms:status', {
        connected: false,
        statusText: 'VMS DB: Offline',
        orgName: ''
      });
    }
    return { connected: false, statusText: 'VMS DB: Offline', orgName: '' };
  }
}

function handleProtocolUrl(urlStr) {
  if (!urlStr || !urlStr.startsWith('vms-companion://')) return;
  try {
    const rawUrl = urlStr.replace(/^vms-companion:\/\/\??/, 'http://dummy.local/?');
    const parsed = new URL(rawUrl);
    const vmsUrl = parsed.searchParams.get('url');
    const token = parsed.searchParams.get('token');
    const org = parsed.searchParams.get('org');
    const updates = {};
    if (vmsUrl) updates.vmsApiUrl = decodeURIComponent(vmsUrl);
    if (token) updates.authToken = decodeURIComponent(token);
    if (org) updates.orgName = decodeURIComponent(org);
    if (Object.keys(updates).length > 0) {
      saveConfig(updates);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('config:updated', config);
        mainWindow.webContents.send('sync:log', {
          time: new Date().toLocaleTimeString(),
          type: 'success',
          message: `🔗 Authorized VMS access (${config.orgName || 'Active Organization'})! Permanent companion token connected.`
        });
      }
      void checkAndBroadcastVmsStatus();
    }
  } catch (e) {
    console.error('Failed to parse protocol url:', e);
  }
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const url = commandLine.find(arg => arg.startsWith('vms-companion://'));
    if (url) handleProtocolUrl(url);
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleProtocolUrl(url);
});

function getMeeshoSession() {
  return session.fromPartition('persist:meesho_partition');
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 650,
    title: 'Meesho Flyer Link-up - VMS Companion',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (autoSyncTimer) clearInterval(autoSyncTimer);
    if (meeshoWorkerWindow && !meeshoWorkerWindow.isDestroyed()) {
      meeshoWorkerWindow.destroy();
    }
  });
}

function getOrCreateWorkerWindow(forceShow = false) {
  if (meeshoWorkerWindow && !meeshoWorkerWindow.isDestroyed()) {
    if (forceShow && !meeshoWorkerWindow.isVisible()) {
      meeshoWorkerWindow.show();
      meeshoWorkerWindow.focus();
    }
    return meeshoWorkerWindow;
  }

  meeshoWorkerWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: forceShow || config.showBrowser,
    title: 'Meesho Automation Worker (Live Preview)',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      session: getMeeshoSession(),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  meeshoWorkerWindow.on('show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('preview:status', { visible: true });
    }
  });

  meeshoWorkerWindow.on('hide', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('preview:status', { visible: false });
    }
  });

  meeshoWorkerWindow.on('close', (e) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      e.preventDefault();
      meeshoWorkerWindow.hide();
      mainWindow.webContents.send('preview:status', { visible: false });
    }
  });

  return meeshoWorkerWindow;
}

// Check if user is logged into Meesho by inspecting worker URL and cookies
async function checkMeeshoLogin() {
  if (meeshoWorkerWindow && !meeshoWorkerWindow.isDestroyed()) {
    const curUrl = meeshoWorkerWindow.webContents.getURL();
    if (curUrl && (curUrl.includes('/login') || curUrl.includes('/root'))) {
      return false;
    }
    if (curUrl && (curUrl.includes('/orders') || curUrl.includes('/fulfillment') || curUrl.includes('/home'))) {
      return true;
    }
  }

  const meeshoSess = getMeeshoSession();
  try {
    const cookies = await meeshoSess.cookies.get({ domain: 'meesho.com' });
    const nowSec = Date.now() / 1000;
    const authCookies = cookies.filter(c => {
      const n = c.name.toLowerCase();
      const isAuthName = n.includes('token') || n.includes('auth') || n.includes('session') || n.includes('supplier_id');
      const notExpired = !c.expirationDate || c.expirationDate > nowSec;
      return isAuthName && notExpired;
    });
    return authCookies.length > 0;
  } catch (e) {
    return false;
  }
}

// Fetch Meesho login credentials from VMS database
async function fetchMeeshoCredentialsFromVms() {
  const url = `${config.vmsApiUrl}/api/meesho/credentials`;
  const headers = { 'Content-Type': 'application/json' };
  if (config.authToken) {
    headers['Authorization'] = `Bearer ${config.authToken}`;
  }

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.warn(`[VMS] Could not fetch credentials: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data;
  } catch (err) {
    console.warn('[VMS] Fetch credentials failed:', err.message);
    return null;
  }
}

// Auto-fill Meesho credentials from VMS database into login window
async function injectMeeshoAutoLogin(targetWindow, creds) {
  if (!targetWindow || targetWindow.isDestroyed()) return;
  if (!creds || !creds.configured || !creds.username || !creds.password) return;

  const escapedUsername = JSON.stringify(creds.username);
  const escapedPassword = JSON.stringify(creds.password);

  const script = `
    (async () => {
      if (window.__vms_autologin_running) return;
      window.__vms_autologin_running = true;

      const USERNAME = ${escapedUsername};
      const PASSWORD = ${escapedPassword};

      const wait = (ms) => new Promise(r => setTimeout(r, ms));

      function showVmsBanner(text, isSuccess = true) {
        let banner = document.getElementById('vms-autologin-banner');
        if (!banner) {
          banner = document.createElement('div');
          banner.id = 'vms-autologin-banner';
          banner.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999999;padding:10px 22px;border-radius:8px;font-family:system-ui,-apple-system,sans-serif;font-size:13px;font-weight:600;box-shadow:0 6px 18px rgba(0,0,0,0.2);display:flex;align-items:center;gap:10px;pointer-events:none;transition:opacity 0.4s ease;';
          document.body.appendChild(banner);
        }
        banner.style.background = isSuccess ? '#059669' : '#d97706';
        banner.style.color = '#ffffff';
        banner.textContent = text;
        banner.style.opacity = '1';
      }

      function setNativeInputValue(el, val) {
        if (!el) return;
        el.focus();
        const valueSetter = Object.getOwnPropertyDescriptor(el, 'value')?.set;
        const prototype = Object.getPrototypeOf(el);
        const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
          prototypeValueSetter.call(el, val);
        } else if (valueSetter) {
          valueSetter.call(el, val);
        } else {
          el.value = val;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }

      showVmsBanner('⚡ VMS Database: Auto-filling login credentials...', false);

      let attempts = 0;
      const maxAttempts = 30; // 15 seconds

      while (attempts < maxAttempts) {
        const curPath = (window.location.pathname || '').toLowerCase();
        if (curPath.includes('/home') || curPath.includes('/orders') || curPath.includes('/fulfillment')) {
          showVmsBanner('✅ Meesho logged in successfully!', true);
          window.__vms_autologin_running = false;
          return { success: true };
        }

        const allInputs = Array.from(document.querySelectorAll('input:not([type="hidden"])'));
        const passwordInput = allInputs.find(i => (i.type || '').toLowerCase() === 'password');

        let usernameInput = allInputs.find(input => {
          if (input === passwordInput) return false;
          const type = (input.type || '').toLowerCase();
          const name = (input.name || '').toLowerCase();
          const placeholder = (input.placeholder || '').toLowerCase();
          const id = (input.id || '').toLowerCase();
          return type === 'email' || type === 'tel' ||
                 name.includes('email') || name.includes('phone') || name.includes('user') ||
                 placeholder.includes('email') || placeholder.includes('phone') || placeholder.includes('mobile') ||
                 id.includes('email') || id.includes('phone');
        });

        if (!usernameInput) {
          usernameInput = allInputs.find(input => {
            if (input === passwordInput) return false;
            const parent = input.parentElement;
            if (!parent) return false;
            const text = (parent.innerText || '').toLowerCase();
            return text.includes('email') || text.includes('phone') || text.includes('mobile') || text.includes('user');
          });
        }

        if (!usernameInput && passwordInput) {
          usernameInput = allInputs.find(i => i !== passwordInput && (i.type || '').toLowerCase() !== 'password');
        }

        if (usernameInput && passwordInput) {
          showVmsBanner('⚡ VMS Auto-Login: Filling ' + USERNAME + '...', true);

          setNativeInputValue(usernameInput, USERNAME);
          usernameInput.style.outline = '2px solid #10b981';
          await wait(300);

          setNativeInputValue(passwordInput, PASSWORD);
          passwordInput.style.outline = '2px solid #10b981';
          await wait(350);

          const buttons = Array.from(document.querySelectorAll('button'));
          let submitBtn = buttons.find(b => {
            const t = (b.innerText || '').trim().toLowerCase();
            const type = (b.type || '').toLowerCase();
            return type === 'submit' || t === 'login' || t === 'log in' || t === 'sign in' || t === 'continue' || t === 'submit';
          });

          if (!submitBtn) {
            submitBtn = document.querySelector('button[type="submit"]');
          }

          if (submitBtn) {
            showVmsBanner('🚀 VMS Auto-Login: Submitting credentials...', true);
            await wait(400);
            submitBtn.click();
          } else {
            passwordInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            passwordInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          }

          showVmsBanner('✅ Credentials submitted! If OTP is required, enter it on screen.', true);
          setTimeout(() => {
            const b = document.getElementById('vms-autologin-banner');
            if (b) b.style.opacity = '0';
          }, 6000);

          window.__vms_autologin_running = false;
          return { success: true };
        }

        attempts++;
        await wait(500);
      }

      showVmsBanner('ℹ️ Login inputs not detected. You can type credentials manually.', false);
      window.__vms_autologin_running = false;
      return { success: false };
    })()
  `;

  try {
    await targetWindow.webContents.executeJavaScript(script);
  } catch (err) {
    console.warn('[Auto-Login] Script execution error:', err.message);
  }
}

async function performAutoLogin(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) return false;

  let creds = null;
  try {
    creds = await fetchMeeshoCredentialsFromVms();
  } catch (e) {
    console.warn('[VMS] Fetch credentials error:', e);
  }

  if (!creds || !creds.configured || !creds.username || !creds.password) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync:log', {
        time: new Date().toLocaleTimeString(),
        type: 'warning',
        message: '⚠️ Meesho login credentials not found in VMS database. Please enter them in VMS Settings > Login Credentials.'
      });
    }
    return false;
  }

  const loginUrl = creds.supplierHubUrl || 'https://supplier.meesho.com/panel/v3/new/root/login';
  const curUrl = targetWindow.webContents.getURL();
  if (!curUrl.includes('/login') && !curUrl.includes('/root')) {
    await targetWindow.loadURL(loginUrl);
    await new Promise(r => setTimeout(r, 2500));
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync:log', {
      time: new Date().toLocaleTimeString(),
      type: 'info',
      message: `🔐 Auto-logging into Meesho with saved credentials (${creds.username})...`
    });
  }

  await injectMeeshoAutoLogin(targetWindow, creds);

  // Poll for navigation confirmation or OTP detection
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 600));
    if (!targetWindow || targetWindow.isDestroyed()) return false;

    const url = targetWindow.webContents.getURL();
    if (url.includes('/orders') || url.includes('/fulfillment') || url.includes('/home')) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('meesho:login-status', { loggedIn: true });
        mainWindow.webContents.send('sync:log', {
          time: new Date().toLocaleTimeString(),
          type: 'success',
          message: '✅ Automatically authenticated into Meesho Supplier Hub! Session & cookies stored.'
        });
      }
      return true;
    }

    // Check if OTP input is present
    const isOtp = await targetWindow.webContents.executeJavaScript(`
      Boolean(document.querySelector('input[type="tel"], input[placeholder*="OTP" i], input[name*="otp" i]'))
    `).catch(() => false);

    if (isOtp) {
      targetWindow.show();
      targetWindow.focus();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync:log', {
          time: new Date().toLocaleTimeString(),
          type: 'warning',
          message: '📱 Meesho requested an SMS OTP. Please enter the OTP on the visible window.'
        });
      }
      break;
    }
  }

  return false;
}

async function openMeeshoLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }

  let creds = null;
  try {
    creds = await fetchMeeshoCredentialsFromVms();
  } catch (e) {
    console.warn('[VMS] Could not fetch credentials:', e);
  }

  const targetUrl = creds?.supplierHubUrl || 'https://supplier.meesho.com/panel/v3/new/root/login';

  loginWindow = new BrowserWindow({
    width: 950,
    height: 750,
    title: 'Login to Meesho Supplier Hub',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      session: getMeeshoSession(),
      contextIsolation: true
    }
  });

  if (creds && creds.configured) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync:log', {
        time: new Date().toLocaleTimeString(),
        type: 'info',
        message: `🔐 Fetched Meesho credentials (${creds.username}) from VMS database. Auto-filling login form...`
      });
    }
  } else {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync:log', {
        time: new Date().toLocaleTimeString(),
        type: 'info',
        message: 'ℹ️ Meesho credentials not yet configured in VMS Settings. Opening login window for manual entry...'
      });
    }
  }

  loginWindow.loadURL(targetUrl);

  const tryAutoLogin = () => {
    if (creds && creds.configured && loginWindow && !loginWindow.isDestroyed()) {
      injectMeeshoAutoLogin(loginWindow, creds);
    }
  };

  loginWindow.webContents.on('did-finish-load', tryAutoLogin);
  loginWindow.webContents.on('dom-ready', tryAutoLogin);

  loginWindow.webContents.on('did-navigate', async (event, url) => {
    if (url.includes('/home') || url.includes('/orders') || url.includes('/fulfillment')) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('meesho:login-status', { loggedIn: true });
        mainWindow.webContents.send('sync:log', {
          time: new Date().toLocaleTimeString(),
          type: 'success',
          message: '✅ Meesho Supplier Hub authenticated successfully!'
        });
      }
    } else if (url.includes('/login') || url.includes('/root')) {
      tryAutoLogin();
    }
  });

  loginWindow.on('closed', () => {
    loginWindow = null;
  });
}

// Derive the /scan-now URL for the current supplier (supplier id like yqcue is dynamic).
// Pending: .../fulfillment/<supplierId>/orders/pending  ->  .../fulfillment/<supplierId>/scan-now
function deriveScanNowUrl(fromUrl, fallbackPendingUrl) {
  const src = fromUrl && fromUrl.startsWith('http') ? fromUrl : (fallbackPendingUrl || '');
  if (!src) return '';
  if (src.includes('/scan-now')) return src.split('?')[0];
  if (src.includes('/orders/pending')) return src.replace('/orders/pending', '/scan-now').split('?')[0];
  const m = src.match(/(.*\/fulfillment\/[^\/\?#]+)/);
  if (m) return `${m[1]}/scan-now`;
  return src;
}

function derivePendingUrl(fromUrl, fallbackPendingUrl) {
  const src = fromUrl && fromUrl.startsWith('http') ? fromUrl : (fallbackPendingUrl || '');
  if (!src) return fallbackPendingUrl || '';
  if (src.includes('/orders/pending')) return src.split('?')[0];
  if (src.includes('/scan-now')) return src.replace('/scan-now', '/orders/pending').split('?')[0];
  return fallbackPendingUrl || src;
}

function logToRenderer(type, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync:log', {
      time: new Date().toLocaleTimeString(),
      type,
      message
    });
  }
}

// Automation script to link AWB and Packet ID in Meesho Supplier Hub.
// Verified flow (Oct 2026):
//   1. Login -> .../fulfillment/<supplierId>/orders/pending
//   2. Click EXACT button "Scan Barcoded Packets" (NOT "Buy Barcoded Packets")
//   3. Navigates to .../fulfillment/<supplierId>/scan-now (full page, not a modal)
//   4. Step 1 input placeholder "Scan/Type AWB Number": type tracking AWB + press Enter
//      -> Step 2 enables.
//   5. Step 2 input placeholder "Scan/type Packet ID": type flyer Packet ID + press Enter
//      -> Submit button enables (purple).
//   6. Click Submit -> green toast "Packet ID <id> is linked successfully", fields clear.
async function executeMeeshoPairing(trackingId, flyerId) {
  const cleanTracking = String(trackingId || '').trim();
  const cleanFlyer = String(flyerId || '').trim();
  if (!cleanTracking || !cleanFlyer) {
    return { success: false, error: 'Missing tracking ID or flyer ID' };
  }

  const worker = getOrCreateWorkerWindow();
  const pendingUrl = config.meeshoOrdersUrl;
  const actionDelay = Number(config.actionDelayMs) || 1000;

  const ensureLoggedInOrThrow = async () => {
    let currentUrl = worker.webContents.getURL();
    if (currentUrl.includes('/login') || currentUrl.includes('/root')) {
      logToRenderer('warning', '⚠️ Meesho session/cookies expired! Automatically logging in again with saved credentials...');
      const loggedIn = await performAutoLogin(worker);
      if (!loggedIn) {
        throw new Error('Meesho session expired and automatic login could not complete.');
      }
    }
  };

  try {
    await ensureLoggedInOrThrow();

    let currentUrl = worker.webContents.getURL();

    // If we are nowhere near the fulfillment hub, go to pending orders first.
    if (!currentUrl.includes('/fulfillment') && !currentUrl.includes('/scan-now') && !currentUrl.includes('/orders/pending')) {
      console.log('[Worker] Loading pending orders page:', pendingUrl);
      await worker.loadURL(pendingUrl);
      await new Promise(r => setTimeout(r, 3500));
      await ensureLoggedInOrThrow();
      // After login the hub may land on /home — go back to pending explicitly.
      currentUrl = worker.webContents.getURL();
      if (!currentUrl.includes('/orders/pending') && !currentUrl.includes('/scan-now')) {
        await worker.loadURL(derivePendingUrl(currentUrl, pendingUrl));
        await new Promise(r => setTimeout(r, 3500));
        await ensureLoggedInOrThrow();
        currentUrl = worker.webContents.getURL();
      }
    }

    // If we are on the pending page (not yet on scan-now), click the
    // "Scan Barcoded Packets" button and wait for navigation to /scan-now.
    if (!currentUrl.includes('/scan-now')) {
      const clicked = await worker.webContents.executeJavaScript(`
        (() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          // IMPORTANT: match ONLY the scan entry-point. "Buy Barcoded Packets"
          // goes to the purchase flow and must never be clicked here.
          const scanBtn = buttons.find(b => {
            const txt = ((b.innerText || b.textContent) || '').trim().toLowerCase();
            return txt === 'scan barcoded packets' || txt.includes('scan barcoded packets');
          });
          if (!scanBtn) {
            const avail = buttons.map(b => ((b.innerText || b.textContent) || '').trim().slice(0, 40)).filter(Boolean).slice(0, 12);
            return { clicked: false, avail };
          }
          scanBtn.scrollIntoView({ block: 'center' });
          scanBtn.click();
          return { clicked: true };
        })()
      `).catch(() => ({ clicked: false }));

      if (clicked && clicked.clicked) {
        logToRenderer('info', '🖱️ Clicked "Scan Barcoded Packets", waiting for scan page...');
        // Wait up to ~10s for the SPA navigation to /scan-now
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 500));
          const u = worker.webContents.getURL();
          if (u.includes('/scan-now')) break;
          if (u.includes('/login') || u.includes('/root')) break;
        }
      }

      currentUrl = worker.webContents.getURL();
      await ensureLoggedInOrThrow();
      currentUrl = worker.webContents.getURL();

      // Fallback: direct navigation to /scan-now (supplier id derived from URL).
      // This covers cases where the button is hidden behind a menu/viewport.
      if (!currentUrl.includes('/scan-now')) {
        const scanNowUrl = deriveScanNowUrl(currentUrl, pendingUrl);
        if (scanNowUrl && scanNowUrl.includes('/scan-now')) {
          console.log('[Worker] Loading scan-now page directly:', scanNowUrl);
          await worker.loadURL(scanNowUrl);
          await new Promise(r => setTimeout(r, 3500));
          await ensureLoggedInOrThrow();
        }
      }
    }

    currentUrl = worker.webContents.getURL();
    if (!currentUrl.includes('/scan-now')) {
      return { success: false, error: `Could not reach Meesho scan page (stuck at ${currentUrl || 'blank'}). Click "Scan Barcoded Packets" manually once, then retry.` };
    }

    // Inject pairing script on the scan-now page. Element IDs on this page are
    // React-generated per load (e.g. CI-h19nObjJ5kv1MBvmkM), so NEVER match by
    // id — locate Step 1 / Step 2 strictly by placeholder text.
    const safeTracking = JSON.stringify(cleanTracking);
    const safeFlyer = JSON.stringify(cleanFlyer);
    const injectionResult = await worker.webContents.executeJavaScript(`
      (async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const TRACKING = ${safeTracking};
        const FLYER = ${safeFlyer};
        const ACTION_DELAY = ${actionDelay};

        // React-compatible setter so onChange fires reliably.
        function setNativeInputValue(el, val) {
          if (!el) return;
          el.focus();
          try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
          const valueSetter = Object.getOwnPropertyDescriptor(el, 'value')?.set;
          const prototype = Object.getPrototypeOf(el);
          const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
            prototypeValueSetter.call(el, val);
          } else if (valueSetter) {
            valueSetter.call(el, val);
          } else {
            el.value = val;
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          try { el.style.outline = '2px solid #f59e0b'; } catch (_) {}
        }

        function pressEnter(el) {
          if (!el) return;
          const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
          el.dispatchEvent(new KeyboardEvent('keydown', opts));
          el.dispatchEvent(new KeyboardEvent('keypress', opts));
          el.dispatchEvent(new KeyboardEvent('keyup', opts));
        }

        // Step 1: AWB input — placeholder "Scan/Type AWB Number"
        const findAwbInput = () => {
          return document.querySelector('input[placeholder*="AWB" i]')
              || Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).find(i => ((i.placeholder || '') + ' ' + (i.getAttribute('aria-label') || '')).toLowerCase().includes('awb'))
              || null;
        };

        // Step 2: Packet input — placeholder "Packet ID" / "Scan/type Packet ID"
        const findPacketInput = () => {
          return document.querySelector('input[placeholder*="Packet ID" i]')
              || Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).find(i => ((i.placeholder || '') + ' ' + (i.getAttribute('aria-label') || '')).toLowerCase().includes('packet')))
              || null;
        };

        const findSubmitBtn = () => {
          return Array.from(document.querySelectorAll('button')).find(b => ((b.innerText || b.textContent) || '').trim().toLowerCase() === 'submit') || null;
        };

        const pageText = () => (document.body ? document.body.innerText : '') || '';
        const toastText = () => {
          const toast = document.querySelector('[data-testid*="toast" i], [class*="toast" i], [class*="snackbar" i], [role="status"], [role="alert"]');
          return ((toast && toast.innerText) || '') + ' \\n' + pageText();
        };

        let awbInput = findAwbInput();
        if (!awbInput) {
          const inputs = Array.from(document.querySelectorAll('input')).map(i => ({ ph: i.placeholder, id: i.id, type: i.type })).slice(0, 8);
          return { success: false, error: 'Step 1 AWB input not found on scan-now page', debugInputs: inputs, url: window.location.href };
        }

        // Fill AWB (Step 1) + Enter -> Step 2 should enable.
        try { awbInput.click(); } catch (_) {}
        // Clear any previous value first (post-success Meesho clears, but be safe).
        setNativeInputValue(awbInput, '');
        await wait(150);
        setNativeInputValue(awbInput, TRACKING);
        await wait(250);
        pressEnter(awbInput);
        await wait(ACTION_DELAY);

        // Re-query Step 2 AFTER Step 1 (Meesho enables it only after a valid AWB).
        let packetInput = findPacketInput();
        let waited = 0;
        while (packetInput && packetInput.disabled && waited < 5000) {
          await wait(500);
          waited += 500;
          packetInput = findPacketInput();
        }
        if (!packetInput) {
          return { success: false, error: 'Step 2 Packet ID input not found after entering AWB ' + TRACKING };
        }
        if (packetInput.disabled) {
          const t = toastText().slice(0, 300);
          return { success: false, error: 'Meesho did not accept AWB ' + TRACKING + ' (Step 2 stayed disabled). ' + t };
        }

        // Fill Packet ID (Step 2) + Enter.
        try { packetInput.click(); } catch (_) {}
        setNativeInputValue(packetInput, '');
        await wait(150);
        setNativeInputValue(packetInput, FLYER);
        await wait(250);
        pressEnter(packetInput);
        await wait(ACTION_DELAY);

        // Submit must become enabled (purple). Click it explicitly.
        let submitBtn = findSubmitBtn();
        waited = 0;
        while (submitBtn && submitBtn.disabled && waited < 5000) {
          await wait(500);
          waited += 500;
          submitBtn = findSubmitBtn();
        }
        if (!submitBtn) {
          return { success: false, error: 'Submit button not found after entering Packet ID ' + FLYER };
        }
        if (submitBtn.disabled || submitBtn.getAttribute('aria-disabled') === 'true') {
          const t = toastText().slice(0, 300);
          return { success: false, error: 'Submit stayed disabled for AWB ' + TRACKING + ' + Packet ' + FLYER + '. ' + t };
        }
        submitBtn.click();
        await wait(2800);

        // Success proof: green toast "Packet ID <id> is linked successfully".
        const full = toastText();
        const okMatch = full.match(/Packet ID\\s+(\\S+)\\s+is linked successfully/i);
        if (okMatch) {
          return { success: true, confirmedPacketId: okMatch[1] };
        }
        // Some builds toast only the packet id line; fall back to generic phrase.
        if (/is linked successfully/i.test(full) || /linked successfully/i.test(full)) {
          return { success: true };
        }
        // Explicit failure signals.
        const errMatch = full.match(/(already\\s+(used|linked)[^\\n]{0,120}|invalid[^\\n]{0,120}|not\\s+found[^\\n]{0,120}|incorrect[^\\n]{0,120}|mismatch[^\\n]{0,120}|failed[^\\n]{0,120}|error[^\\n]{0,120})/i);
        if (errMatch) {
          return { success: false, error: errMatch[1].trim().slice(0, 300) };
        }
        // Inputs clear on success (see verified screenshot) — treat cleared
        // inputs + no error as success; otherwise report ambiguous.
        const awbNow = (findAwbInput()?.value || '').trim();
        const pktNow = (findPacketInput()?.value || '').trim();
        if (!awbNow && !pktNow) {
          return { success: true };
        }
        return { success: false, error: 'No success confirmation from Meesho for AWB ' + TRACKING + ' + Packet ' + FLYER + '. Page said: ' + full.slice(0, 300) };
      })()
    `);

    return injectionResult || { success: false, error: 'Automation returned no result' };
  } catch (err) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
}

// Fetch pending items from VMS server
async function fetchVmsQueue() {
  const url = `${config.vmsApiUrl}/api/meesho/flyer-queue?status=PENDING&limit=100`;
  const headers = { 'Content-Type': 'application/json' };
  if (config.authToken) {
    headers['Authorization'] = `Bearer ${config.authToken}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return await res.json();
}

// Update VMS server with result
async function reportVmsResult(items) {
  const url = `${config.vmsApiUrl}/api/meesho/flyer-queue/link`;
  const headers = { 'Content-Type': 'application/json' };
  if (config.authToken) {
    headers['Authorization'] = `Bearer ${config.authToken}`;
  }

  await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ items })
  });
}

// One sync pass
async function runSyncPass() {
  if (isSyncing) return;
  isSyncing = true;

  try {
    if (!config.authToken) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync:status', { syncing: false, message: 'VMS DB not connected.' });
        mainWindow.webContents.send('vms:status', { connected: false, statusText: 'VMS DB: Not Connected' });
        mainWindow.webContents.send('sync:log', {
          time: new Date().toLocaleTimeString(),
          type: 'warning',
          message: '⚠️ VMS DB not authorized. Click "Connect" on the top bar or "Pair Desktop App" in your VMS web browser.'
        });
      }
      return;
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync:status', { syncing: true, message: 'Fetching queue from VMS...' });
    }

    const { items, stats } = await fetchVmsQueue();

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync:stats', stats);
      mainWindow.webContents.send('vms:status', {
        connected: true,
        statusText: `VMS DB: ${config.orgName || 'Connected'}`
      });
    }

    if (!items || items.length === 0) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync:status', { syncing: false, message: 'Queue is clean (0 pending).' });
      }
      return;
    }

    // Verify Meesho session before attempting automated barcode entry
    const isLogged = await checkMeeshoLogin();
    if (!isLogged) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync:log', {
          time: new Date().toLocaleTimeString(),
          type: 'info',
          message: '🔐 Not logged into Meesho. Attempting automatic login with VMS credentials...'
        });
      }
      const worker = getOrCreateWorkerWindow();
      const autoOk = await performAutoLogin(worker);
      if (!autoOk) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sync:log', {
            time: new Date().toLocaleTimeString(),
            type: 'warning',
            message: '⚠️ Auto-login did not complete. Opening login window for verification/OTP...'
          });
        }
        await openMeeshoLoginWindow();
        return;
      }
    }

    let processed = 0;
    for (const item of items) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync:log', {
          time: new Date().toLocaleTimeString(),
          type: 'info',
          message: `Pairing AWB ${item.trackingId} <-> Packet ${item.flyerId}...`
        });
      }

      let result;
      try {
        result = await executeMeeshoPairing(item.trackingId, item.flyerId);
      } catch (err) {
        result = { success: false, error: err.message };
      }

      const status = result.success ? 'LINKED' : 'FAILED';
      const remark = result.success ? 'Linked via Desktop App' : (result.error || 'Automation error');

      await reportVmsResult([{
        id: item.id,
        trackingId: item.trackingId,
        flyerId: item.flyerId,
        status,
        remark
      }]);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync:log', {
          time: new Date().toLocaleTimeString(),
          type: result.success ? 'success' : 'error',
          message: result.success
            ? `✅ Linked: AWB ${item.trackingId} <-> Packet ${item.flyerId}`
            : `❌ Failed: AWB ${item.trackingId} (${remark})`
        });
      }

      processed++;
      await new Promise(r => setTimeout(r, 1200));
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync:status', { syncing: false, message: `Completed batch of ${processed} items.` });
    }
  } catch (err) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const is401 = err.message && err.message.includes('401');
      if (is401) {
        mainWindow.webContents.send('vms:status', { connected: false, statusText: 'VMS DB: Unauthorized' });
        mainWindow.webContents.send('sync:log', {
          time: new Date().toLocaleTimeString(),
          type: 'error',
          message: '❌ VMS Authorization Error (401): Please pair your companion app using "Connect" on the top bar.'
        });
      } else {
        mainWindow.webContents.send('sync:log', {
          time: new Date().toLocaleTimeString(),
          type: 'error',
          message: `Sync Error: ${err.message}`
        });
      }
      mainWindow.webContents.send('sync:status', { syncing: false, message: `Error: ${err.message}` });
    }
  } finally {
    isSyncing = false;
  }
}

// Register IPC handlers
app.whenReady().then(() => {
  loadConfig();
  createMainWindow();

  // Initial check of VMS connection
  setTimeout(() => {
    void checkAndBroadcastVmsStatus();
  }, 1000);

  // Check if opened via vms-companion:// protocol argument on launch
  const initialUrl = process.argv.find(arg => arg && arg.startsWith('vms-companion://'));
  if (initialUrl) {
    handleProtocolUrl(initialUrl);
  }

  // Login handler
  ipcMain.handle('meesho:open-login', async () => {
    await openMeeshoLoginWindow();
    return true;
  });

  ipcMain.handle('meesho:get-credentials-status', async () => {
    try {
      const creds = await fetchMeeshoCredentialsFromVms();
      if (!creds) {
        return { configured: false, username: '', error: 'Could not connect to VMS' };
      }
      return {
        configured: Boolean(creds.configured),
        username: creds.username || '',
        supplierHubUrl: creds.supplierHubUrl || 'https://supplier.meesho.com/panel/v3/new/root/login'
      };
    } catch (e) {
      return { configured: false, username: '', error: e.message };
    }
  });

  ipcMain.handle('meesho:check-status', async () => {
    return await checkMeeshoLogin();
  });

  // Sync handlers
  ipcMain.handle('sync:trigger-now', async () => {
    void runSyncPass();
    return true;
  });

  ipcMain.handle('sync:start-auto', async () => {
    if (autoSyncTimer) clearInterval(autoSyncTimer);
    void runSyncPass();
    const intervalMs = (Number(config.pollIntervalSeconds) || 30) * 1000;
    autoSyncTimer = setInterval(() => {
      void runSyncPass();
    }, intervalMs);
    return true;
  });

  ipcMain.handle('sync:stop-auto', async () => {
    if (autoSyncTimer) {
      clearInterval(autoSyncTimer);
      autoSyncTimer = null;
    }
    return true;
  });

  // CSV File Upload handlers
  ipcMain.handle('file:select-csv', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Meesho Scanned CSV File',
      filters: [{ name: 'CSV Files', extensions: ['csv', 'txt'] }],
      properties: ['openFile']
    });

    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return null;
    }

    const filePath = res.filePaths[0];
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);

    const items = [];
    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split(',').map(p => p.trim().replace(/^"|"$/g, ''));
      if (i === 0 && (parts[0].toLowerCase().includes('tracking') || parts[1]?.toLowerCase().includes('flyer'))) {
        continue; // skip header
      }
      if (parts[0] && parts[1]) {
        items.push({
          trackingId: parts[0],
          flyerId: parts[1],
          status: 'PENDING'
        });
      }
    }

    return { filePath, count: items.length, items };
  });

  ipcMain.handle('file:process-batch', async (event, items) => {
    if (!Array.isArray(items) || items.length === 0) return { successCount: 0 };

    let successCount = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      mainWindow.webContents.send('sync:log', {
        time: new Date().toLocaleTimeString(),
        type: 'info',
        message: `[File Sync ${i + 1}/${items.length}] AWB ${item.trackingId} <-> Packet ${item.flyerId}...`
      });

      let res;
      try {
        res = await executeMeeshoPairing(item.trackingId, item.flyerId);
      } catch (e) {
        res = { success: false, error: e.message };
      }

      if (res.success) successCount++;

      mainWindow.webContents.send('file:progress', {
        index: i,
        total: items.length,
        item,
        success: res.success,
        error: res.error
      });

      mainWindow.webContents.send('sync:log', {
        time: new Date().toLocaleTimeString(),
        type: res.success ? 'success' : 'error',
        message: res.success
          ? `✅ Paired: ${item.trackingId}`
          : `❌ Failed: ${item.trackingId} (${res.error || 'Error'})`
      });

      await new Promise(r => setTimeout(r, 1200));
    }

    return { successCount, total: items.length };
  });

  // Live Preview handlers
  ipcMain.handle('preview:toggle', async () => {
    const worker = getOrCreateWorkerWindow(false);
    if (worker.isVisible()) {
      worker.hide();
      return { visible: false };
    } else {
      const cur = worker.webContents.getURL();
      if (!cur || cur === 'about:blank') {
        void worker.loadURL(config.meeshoOrdersUrl);
      }
      worker.show();
      worker.focus();
      return { visible: true };
    }
  });

  ipcMain.handle('preview:get-state', async () => {
    return { visible: meeshoWorkerWindow ? meeshoWorkerWindow.isVisible() : false };
  });

  // Config handlers
  ipcMain.handle('config:get', () => config);
  ipcMain.handle('config:save', (event, newConfig) => {
    saveConfig(newConfig);
    if (meeshoWorkerWindow && !meeshoWorkerWindow.isDestroyed()) {
      if (config.showBrowser) meeshoWorkerWindow.show();
      else meeshoWorkerWindow.hide();
    }
    void checkAndBroadcastVmsStatus();
    return config;
  });

  // VMS Auth & Pairing handlers
  ipcMain.handle('vms:check-status', async () => {
    return await checkAndBroadcastVmsStatus();
  });

  ipcMain.handle('vms:open-pair-browser', async () => {
    const pairUrl = `${config.vmsApiUrl}/meesho-flyer?pair=1`;
    await shell.openExternal(pairUrl);
    return true;
  });

  ipcMain.handle('vms:save-token', async (event, token) => {
    saveConfig({ authToken: token });
    return await checkAndBroadcastVmsStatus();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
