const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meeshoApi', {
  // Meesho Auth
  openLogin: () => ipcRenderer.invoke('meesho:open-login'),
  checkStatus: () => ipcRenderer.invoke('meesho:check-status'),
  onLoginStatus: (callback) => {
    ipcRenderer.on('meesho:login-status', (event, data) => callback(data));
  },

  // Real-time Queue Sync
  triggerSyncNow: () => ipcRenderer.invoke('sync:trigger-now'),
  startAutoSync: () => ipcRenderer.invoke('sync:start-auto'),
  stopAutoSync: () => ipcRenderer.invoke('sync:stop-auto'),
  getAutoState: () => ipcRenderer.invoke('sync:get-auto-state'),
  onAutoState: (callback) => {
    ipcRenderer.on('sync:auto-state', (event, data) => callback(data));
  },
  onSyncStatus: (callback) => {
    ipcRenderer.on('sync:status', (event, data) => callback(data));
  },
  onSyncStats: (callback) => {
    ipcRenderer.on('sync:stats', (event, data) => callback(data));
  },
  onSyncLog: (callback) => {
    ipcRenderer.on('sync:log', (event, data) => callback(data));
  },

  // CSV File Processing
  selectCsvFile: () => ipcRenderer.invoke('file:select-csv'),
  processBatch: (items) => ipcRenderer.invoke('file:process-batch', items),
  onFileProgress: (callback) => {
    ipcRenderer.on('file:progress', (event, data) => callback(data));
  },

  // Live Preview Window
  togglePreview: () => ipcRenderer.invoke('preview:toggle'),
  getPreviewState: () => ipcRenderer.invoke('preview:get-state'),
  onPreviewStatus: (callback) => {
    ipcRenderer.on('preview:status', (event, data) => callback(data));
  },

  // Configuration
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  getCredentialsStatus: () => ipcRenderer.invoke('meesho:get-credentials-status'),
  onConfigUpdated: (callback) => {
    ipcRenderer.on('config:updated', (event, data) => callback(data));
  },

  // VMS Auth & Pairing
  checkVmsStatus: () => ipcRenderer.invoke('vms:check-status'),
  openPairBrowser: () => ipcRenderer.invoke('vms:open-pair-browser'),
  saveVmsToken: (token) => ipcRenderer.invoke('vms:save-token', token),
  onVmsStatus: (callback) => {
    ipcRenderer.on('vms:status', (event, data) => callback(data));
  }
});
