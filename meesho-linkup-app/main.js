const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
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

// Check if user is logged into Meesho by inspecting cookies
async function checkMeeshoLogin() {
  const meeshoSess = getMeeshoSession();
  try {
    const cookies = await meeshoSess.cookies.get({ domain: 'meesho.com' });
    const hasAuth = cookies.some(c => 
      c.name.toLowerCase().includes('token') || 
      c.name.toLowerCase().includes('auth') || 
      c.name.toLowerCase().includes('session') ||
      c.name.toLowerCase().includes('supplier')
    );
    return hasAuth || cookies.length > 5;
  } catch (e) {
    return false;
  }
}

// Automation script to link AWB and Packet ID in Meesho Supplier Hub
async function executeMeeshoPairing(trackingId, flyerId) {
  const worker = getOrCreateWorkerWindow();
  const targetUrl = config.meeshoOrdersUrl;

  const currentUrl = worker.webContents.getURL();
  if (!currentUrl.includes('/fulfillment') && !currentUrl.includes('/orders/pending')) {
    console.log('[Worker] Loading pending orders page:', targetUrl);
    await worker.loadURL(targetUrl);
    await new Promise(r => setTimeout(r, 3500));
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync:status', { syncing: true, message: 'Fetching queue from VMS...' });
    }

    const { items, stats } = await fetchVmsQueue();

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync:stats', stats);
    }

    if (!items || items.length === 0) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync:status', { syncing: false, message: 'Queue is clean (0 pending).' });
      }
      return;
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
      mainWindow.webContents.send('sync:log', {
        time: new Date().toLocaleTimeString(),
        type: 'error',
        message: `Sync Error: ${err.message}`
      });
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

  // Login handler
  ipcMain.handle('meesho:open-login', async () => {
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.focus();
      return;
    }

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

    loginWindow.loadURL('https://supplier.meesho.com/panel/v3/new/root/login');

    loginWindow.webContents.on('did-navigate', async (event, url) => {
      if (url.includes('/home') || url.includes('/orders') || url.includes('/fulfillment')) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('meesho:login-status', { loggedIn: true });
        }
      }
    });

    loginWindow.on('closed', () => {
      loginWindow = null;
    });
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
    return config;
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
