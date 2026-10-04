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

// Automation script to link AWB and Packet ID in Meesho Supplier Hub
async function executeMeeshoPairing(trackingId, flyerId) {
  const worker = getOrCreateWorkerWindow();
  const targetUrl = config.meeshoOrdersUrl;

  let currentUrl = worker.webContents.getURL();
  if (currentUrl.includes('/login') || currentUrl.includes('/root')) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync:log', {
        time: new Date().toLocaleTimeString(),
        type: 'warning',
        message: '⚠️ Meesho session/cookies expired! Automatically logging in again with saved credentials...'
      });
    }
    const loggedIn = await performAutoLogin(worker);
    if (!loggedIn) {
      return { success: false, error: 'Meesho session expired and automatic login could not complete.' };
    }
    currentUrl = worker.webContents.getURL();
  }

  if (!currentUrl.includes('/fulfillment') && !currentUrl.includes('/orders/pending')) {
    console.log('[Worker] Loading pending orders page:', targetUrl);
    await worker.loadURL(targetUrl);
    await new Promise(r => setTimeout(r, 3500));
    currentUrl = worker.webContents.getURL();

    if (currentUrl.includes('/login') || currentUrl.includes('/root')) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync:log', {
          time: new Date().toLocaleTimeString(),
          type: 'warning',
          message: '⚠️ Redirected to Meesho login. Auto-authenticating with saved credentials...'
        });
      }
      const loggedIn = await performAutoLogin(worker);
      if (!loggedIn) {
        return { success: false, error: 'Redirected to Meesho login and credentials failed.' };
      }
      await worker.loadURL(targetUrl);
      await new Promise(r => setTimeout(r, 3500));
    }
  }

  // Inject script to click Scan button if needed, type AWB, type Flyer ID, and submit
  const injectionResult = await worker.webContents.executeJavaScript(`
    (async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));

      // Helper to set input value natively in React apps so synthetic onChange triggers reliably
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
        try {
          el.style.outline = '2px solid #f59e0b';
        } catch (_) {}
      }

      // 1. Check if scan modal is open, or click the scan button
      const findAwbInput = () => {
        return document.getElementById('DW5OZxdlm_GQfYE_TbXEB') ||
               document.querySelector('input[placeholder*="AWB" i]') || 
               document.querySelector('input[placeholder*="Tracking" i]') ||
               document.querySelector('input[placeholder*="Barcode" i]');
      };

      let awbInput = findAwbInput();

      if (!awbInput) {
        // Find scan button: "Scan Barcoded Packets" or "Scan & Pack"
        const buttons = Array.from(document.querySelectorAll('button'));
        const scanBtn = buttons.find(b => {
          const txt = (b.innerText || '').toLowerCase();
          return txt.includes('scan barcoded packets') || 
                 txt.includes('scan & pack') || 
                 txt.includes('barcoded packets');
        });

        if (scanBtn) {
          scanBtn.click();
          await wait(1800);
        }
      }

      awbInput = findAwbInput();

      // Fallback: If modal is open, inspect inputs inside modal/dialog container
      if (!awbInput) {
        const dialog = document.querySelector('[role="dialog"], [aria-modal="true"], div[class*="modal" i], div[class*="popup" i]');
        if (dialog) {
          const textInputs = Array.from(dialog.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"])'));
          if (textInputs.length >= 1) awbInput = textInputs[0];
        }
      }

      if (!awbInput) {
        return { success: false, error: 'Could not find AWB input field on Meesho modal' };
      }

      // Fill AWB
      setNativeInputValue(awbInput, '${trackingId}');
      awbInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      awbInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      await wait(${config.actionDelayMs || 1000});

      // Find Flyer input
      const findFlyerInput = () => {
        return document.getElementById('hnNpGSXM7CB4iVLXbs6uf') ||
               document.querySelector('input[placeholder*="Packet" i]') || 
               document.querySelector('input[placeholder*="Flyer" i]') ||
               document.querySelector('input[placeholder*="Bag" i]');
      };

      let flyerInput = findFlyerInput();

      // Fallback: Second input in modal
      if (!flyerInput) {
        const dialog = document.querySelector('[role="dialog"], [aria-modal="true"], div[class*="modal" i], div[class*="popup" i]');
        if (dialog) {
          const textInputs = Array.from(dialog.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"])'));
          if (textInputs.length >= 2) flyerInput = textInputs[1];
        }
      }

      if (!flyerInput) {
        return { success: false, error: 'Could not find Packet/Flyer ID input field on Meesho modal' };
      }

      // Fill Flyer ID
      setNativeInputValue(flyerInput, '${flyerId}');
      flyerInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      flyerInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      await wait(${config.actionDelayMs || 1000});

      // Check for submit button if enter is not enough
      const submitBtn = Array.from(document.querySelectorAll('button')).find(b => {
        const t = (b.innerText || '').trim().toLowerCase();
        return t === 'submit' || t === 'add' || t === 'done' || t === 'pack';
      });
      if (submitBtn) {
        submitBtn.click();
        await wait(600);
      }

      // Check for errors on page/toast
      const errorEl = document.querySelector('.toast-error, [role="alert"], div[class*="error" i], div:has(> span[class*="error" i])');
      if (errorEl && errorEl.innerText && errorEl.innerText.trim().length > 0) {
        return { success: false, error: errorEl.innerText.trim() };
      }

      return { success: true };
    })()
  `);

  return injectionResult;
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
