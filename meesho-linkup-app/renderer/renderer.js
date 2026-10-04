document.addEventListener('DOMContentLoaded', async () => {
  const api = window.meeshoApi;

  // Tabs
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const target = document.getElementById(btn.dataset.tab);
      if (target) target.classList.add('active');
    });
  });

  // UI Elements
  const meeshoPill = document.getElementById('meesho-status-pill');
  const meeshoText = document.getElementById('meesho-status-text');
  const btnLoginMeesho = document.getElementById('btn-login-meesho');

  const syncPill = document.getElementById('sync-status-pill');
  const syncText = document.getElementById('sync-status-text');

  const previewPill = document.getElementById('preview-status-pill');
  const previewText = document.getElementById('preview-status-text');
  const btnTogglePreview = document.getElementById('btn-toggle-preview');
  const btnBannerPreview = document.getElementById('btn-banner-preview');

  const statPending = document.getElementById('stat-pending');
  const statLinked = document.getElementById('stat-linked');
  const statTotal = document.getElementById('stat-total');
  const statFailed = document.getElementById('stat-failed');

  const btnToggleAuto = document.getElementById('btn-toggle-auto');
  const btnSyncOnce = document.getElementById('btn-sync-once');
  const btnClearLog = document.getElementById('btn-clear-log');
  const activityLog = document.getElementById('activity-log');

  // File UI
  const btnBrowseFile = document.getElementById('btn-browse-file');
  const fileDropArea = document.getElementById('drop-area');
  const fileDetails = document.getElementById('file-details');
  const fileName = document.getElementById('file-name');
  const fileRowCount = document.getElementById('file-row-count');
  const btnStartFileSync = document.getElementById('btn-start-file-sync');
  const fileProgressBar = document.getElementById('file-progress-bar');
  const fileProgressText = document.getElementById('file-progress-text');
  const fileProgressContainer = document.getElementById('file-progress-container');
  const csvTableBody = document.getElementById('csv-table-body');

  // Settings
  const settingVmsUrl = document.getElementById('setting-vms-url');
  const settingAuthToken = document.getElementById('setting-auth-token');
  const settingMeeshoUrl = document.getElementById('setting-meesho-url');
  const settingPollInterval = document.getElementById('setting-poll-interval');
  const settingActionDelay = document.getElementById('setting-action-delay');
  const settingShowBrowser = document.getElementById('setting-show-browser');
  const btnSaveSettings = document.getElementById('btn-save-settings');

  const credsPill = document.getElementById('creds-status-pill');
  const credsText = document.getElementById('creds-status-text');
  const btnConnectVms = document.getElementById('btn-connect-vms');
  const modalVmsConnect = document.getElementById('modal-vms-connect');
  const btnCloseVmsModal = document.getElementById('btn-close-vms-modal');
  const btnOpenVmsPairBrowser = document.getElementById('btn-open-vms-pair-browser');
  const inputManualToken = document.getElementById('input-manual-token');
  const btnSubmitManualToken = document.getElementById('btn-submit-manual-token');

  const settingsCredsTitle = document.getElementById('settings-creds-title');
  const settingsCredsInfo = document.getElementById('settings-creds-info');
  const btnRefreshCreds = document.getElementById('btn-refresh-creds');

  let isAutoRunning = false;
  let loadedCsvItems = [];

  function appendLog(line, type = 'normal') {
    const el = document.createElement('div');
    el.className = `log-line ${type}`;
    el.textContent = line;
    activityLog.appendChild(el);
    activityLog.scrollTop = activityLog.scrollHeight;
  }

  function updateVmsStatusUi(status) {
    if (status && status.connected) {
      if (credsPill) credsPill.className = 'status-pill status-connected';
      if (credsText) credsText.textContent = status.statusText || 'VMS DB: Connected';
      if (btnConnectVms) btnConnectVms.style.display = 'none';
    } else {
      if (credsPill) credsPill.className = 'status-pill status-idle';
      if (credsText) credsText.textContent = status?.statusText || 'VMS DB: Not Connected';
      if (btnConnectVms) btnConnectVms.style.display = 'inline-block';
    }
  }

  async function checkVmsStatus() {
    try {
      if (api.checkVmsStatus) {
        const status = await api.checkVmsStatus();
        updateVmsStatusUi(status);
      }
      await checkCredentialsStatus();
    } catch (e) {
      updateVmsStatusUi({ connected: false, statusText: 'VMS DB: Error' });
    }
  }

  if (api.onVmsStatus) {
    api.onVmsStatus((status) => {
      updateVmsStatusUi(status);
      void checkCredentialsStatus();
    });
  }

  if (btnConnectVms) {
    btnConnectVms.addEventListener('click', () => {
      if (modalVmsConnect) modalVmsConnect.style.display = 'flex';
    });
  }

  if (btnCloseVmsModal) {
    btnCloseVmsModal.addEventListener('click', () => {
      if (modalVmsConnect) modalVmsConnect.style.display = 'none';
    });
  }

  if (btnOpenVmsPairBrowser) {
    btnOpenVmsPairBrowser.addEventListener('click', async () => {
      appendLog('[VMS] Opening default browser to authorize companion app...', 'info');
      await api.openPairBrowser();
    });
  }

  if (btnSubmitManualToken) {
    btnSubmitManualToken.addEventListener('click', async () => {
      const val = (inputManualToken?.value || '').trim();
      if (!val) {
        alert('Please enter a valid pairing key');
        return;
      }
      appendLog('[VMS] Saving pairing key and verifying connection...', 'info');
      await api.saveVmsToken(val);
      if (modalVmsConnect) modalVmsConnect.style.display = 'none';
      await checkVmsStatus();
    });
  }

  async function checkCredentialsStatus() {
    try {
      const creds = await api.getCredentialsStatus();
      if (creds && creds.configured) {
        if (settingsCredsTitle) settingsCredsTitle.textContent = `Auto-Login Ready (${creds.username})`;
        if (settingsCredsInfo) settingsCredsInfo.textContent = `Credentials loaded from VMS database. ID & password will auto-fill on Meesho login.`;
      } else {
        if (settingsCredsTitle) settingsCredsTitle.textContent = 'No Credentials in VMS DB';
        if (settingsCredsInfo) settingsCredsInfo.textContent = creds?.error ? `Could not reach VMS: ${creds.error}` : 'Configure Email & Password in VMS Settings > Meesho Integration for 1-click login.';
      }
    } catch (e) {}
  }

  if (btnRefreshCreds) {
    btnRefreshCreds.addEventListener('click', async () => {
      appendLog('[VMS] Checking database connection & credentials...', 'info');
      await checkVmsStatus();
    });
  }

  // 1. Initial State & Config
  try {
    const cfg = await api.getConfig();
    if (cfg) {
      settingVmsUrl.value = cfg.vmsApiUrl || '';
      settingAuthToken.value = cfg.authToken || '';
      settingMeeshoUrl.value = cfg.meeshoOrdersUrl || '';
      settingPollInterval.value = cfg.pollIntervalSeconds || 30;
      settingActionDelay.value = cfg.actionDelayMs || 1000;
      settingShowBrowser.checked = Boolean(cfg.showBrowser);
    }
  } catch (e) {}

  if (api.onConfigUpdated) {
    api.onConfigUpdated((newCfg) => {
      if (newCfg) {
        if (newCfg.vmsApiUrl) settingVmsUrl.value = newCfg.vmsApiUrl;
        if (newCfg.authToken) settingAuthToken.value = newCfg.authToken;
        void checkVmsStatus();
      }
    });
  }

  // Check login & credentials
  const isLogged = await api.checkStatus();
  updateMeeshoLoginUI(isLogged);
  void checkVmsStatus();

  function updateMeeshoLoginUI(loggedIn) {
    if (loggedIn) {
      meeshoPill.className = 'status-pill status-connected';
      meeshoText.textContent = 'Meesho: Connected';
      btnLoginMeesho.style.display = 'none';
    } else {
      meeshoPill.className = 'status-pill status-disconnected';
      meeshoText.textContent = 'Meesho: Login Required';
      btnLoginMeesho.style.display = 'inline-block';
    }
  }

  btnLoginMeesho.addEventListener('click', () => {
    api.openLogin();
  });

  api.onLoginStatus((data) => {
    updateMeeshoLoginUI(data.loggedIn);
    appendLog(`[Auth] Meesho session connected successfully!`, 'success');
  });

  // Live Preview UI handlers
  function updatePreviewUI(visible) {
    if (visible) {
      if (previewPill) previewPill.className = 'status-pill status-preview-on';
      if (previewText) previewText.textContent = 'Preview: Active';
      if (btnTogglePreview) btnTogglePreview.innerHTML = '<span class="material-symbols-outlined text-xs">visibility_off</span><span>Hide View</span>';
      if (btnBannerPreview) btnBannerPreview.innerHTML = '<span class="material-symbols-outlined">visibility_off</span><span>Hide Live Preview</span>';
      if (settingShowBrowser) settingShowBrowser.checked = true;
    } else {
      if (previewPill) previewPill.className = 'status-pill status-idle';
      if (previewText) previewText.textContent = 'Preview: Hidden';
      if (btnTogglePreview) btnTogglePreview.innerHTML = '<span class="material-symbols-outlined text-xs">visibility</span><span>Live View</span>';
      if (btnBannerPreview) btnBannerPreview.innerHTML = '<span class="material-symbols-outlined">visibility</span><span>Open Live Preview</span>';
      if (settingShowBrowser) settingShowBrowser.checked = false;
    }
  }

  if (btnTogglePreview) {
    btnTogglePreview.addEventListener('click', async () => {
      const res = await api.togglePreview();
      updatePreviewUI(res?.visible);
      appendLog(`[Preview] Live Meesho window ${res?.visible ? 'opened' : 'hidden'}.`, 'info');
    });
  }

  if (btnBannerPreview) {
    btnBannerPreview.addEventListener('click', async () => {
      const res = await api.togglePreview();
      updatePreviewUI(res?.visible);
      appendLog(`[Preview] Live Meesho window ${res?.visible ? 'opened' : 'hidden'}.`, 'info');
    });
  }

  api.onPreviewStatus((data) => {
    updatePreviewUI(data?.visible);
  });

  try {
    const previewState = await api.getPreviewState();
    updatePreviewUI(previewState?.visible);
  } catch (_) {}

  // 2. Real-time Auto-Sync Controls
  btnToggleAuto.addEventListener('click', async () => {
    if (!isAutoRunning) {
      isAutoRunning = true;
      btnToggleAuto.className = 'btn btn-secondary';
      btnToggleAuto.innerHTML = `<span class="material-symbols-outlined">pause</span> Pause Auto-Sync`;
      syncPill.className = 'status-pill status-running';
      syncText.textContent = 'Auto-Sync: Running';
      appendLog('[Auto-Sync] Started background queue listener.', 'info');
      await api.startAutoSync();
    } else {
      isAutoRunning = false;
      btnToggleAuto.className = 'btn btn-primary';
      btnToggleAuto.innerHTML = `<span class="material-symbols-outlined">play_arrow</span> Start Auto-Sync`;
      syncPill.className = 'status-pill status-idle';
      syncText.textContent = 'Auto-Sync: Stopped';
      appendLog('[Auto-Sync] Paused background listener.', 'normal');
      await api.stopAutoSync();
    }
  });

  btnSyncOnce.addEventListener('click', async () => {
    appendLog('[Sync] Triggering one-time check...', 'info');
    await api.triggerSyncNow();
  });

  btnClearLog.addEventListener('click', () => {
    activityLog.innerHTML = '<div class="log-line text-secondary">[Log cleared]</div>';
  });

  api.onSyncStats((stats) => {
    if (!stats) return;
    statPending.textContent = stats.pendingCount || 0;
    statLinked.textContent = stats.linkedCount || 0;
    statTotal.textContent = stats.totalScans || 0;
    statFailed.textContent = stats.failedCount || 0;
  });

  api.onSyncStatus((status) => {
    if (status.message) {
      appendLog(`[Status] ${status.message}`);
    }
  });

  api.onSyncLog((log) => {
    appendLog(`[${log.time}] ${log.message}`, log.type);
  });

  // 3. File Upload Mode
  btnBrowseFile.addEventListener('click', async () => {
    const fileResult = await api.selectCsvFile();
    if (!fileResult || !fileResult.items) return;

    loadedCsvItems = fileResult.items;
    fileName.textContent = fileResult.filePath.split(/[\\/]/).pop();
    fileRowCount.textContent = `${loadedCsvItems.length} rows loaded`;
    fileDropArea.classList.add('hidden');
    fileDetails.classList.remove('hidden');

    // Render table
    csvTableBody.innerHTML = '';
    loadedCsvItems.forEach((item, index) => {
      const tr = document.createElement('tr');
      tr.id = `row-${index}`;
      tr.innerHTML = `
        <td>${index + 1}</td>
        <td><code>${item.trackingId}</code></td>
        <td><strong class="text-warning">${item.flyerId}</strong></td>
        <td><span class="badge" id="badge-${index}">Ready</span></td>
        <td id="remark-${index}" class="text-secondary">—</td>
      `;
      csvTableBody.appendChild(tr);
    });
  });

  btnStartFileSync.addEventListener('click', async () => {
    if (loadedCsvItems.length === 0) return;

    btnStartFileSync.disabled = true;
    fileProgressContainer.classList.remove('hidden');

    api.onFileProgress((data) => {
      const pct = Math.round(((data.index + 1) / data.total) * 100);
      fileProgressBar.style.width = `${pct}%`;
      fileProgressText.textContent = `${data.index + 1} / ${data.total} processed (${pct}%)`;

      const badge = document.getElementById(`badge-${data.index}`);
      const remark = document.getElementById(`remark-${data.index}`);
      if (badge && remark) {
        if (data.success) {
          badge.className = 'badge text-success';
          badge.textContent = 'Linked';
          remark.textContent = 'Success';
        } else {
          badge.className = 'badge text-critical';
          badge.textContent = 'Failed';
          remark.textContent = data.error || 'Failed';
        }
      }
    });

    const res = await api.processBatch(loadedCsvItems);
    btnStartFileSync.disabled = false;
    alert(`File batch finished!\nSuccessfully linked: ${res.successCount} of ${res.total}`);
  });

  // 4. Save Settings
  btnSaveSettings.addEventListener('click', async () => {
    const newCfg = {
      vmsApiUrl: settingVmsUrl.value.trim(),
      authToken: settingAuthToken.value.trim(),
      meeshoOrdersUrl: settingMeeshoUrl.value.trim(),
      pollIntervalSeconds: Number(settingPollInterval.value) || 30,
      actionDelayMs: Number(settingActionDelay.value) || 1000,
      showBrowser: settingShowBrowser.checked
    };
    await api.saveConfig(newCfg);
    await checkCredentialsStatus();
    alert('Settings saved successfully!');
  });
});
