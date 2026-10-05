const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

class MeeshoAutomator {
  constructor(config = {}) {
    this.config = {
      vmsApiUrl: config.vmsApiUrl || 'https://vms.youthnic.shop',
      authToken: config.authToken || '',
      meeshoOrdersUrl: config.meeshoOrdersUrl || 'https://supplier.meesho.com/panel/v3/new/fulfillment/yqcue/orders/pending',
      typeDelayMs: config.typeDelayMs || 40,
      actionDelayMs: config.actionDelayMs || 1000,
      headless: config.headless !== undefined ? config.headless : false,
      useRealChrome: config.useRealChrome !== undefined ? config.useRealChrome : true,
      userDataDir: path.join(__dirname, 'meesho_profile')
    };
    this.browserContext = null;
    this.page = null;
  }

  async launchBrowser() {
    if (this.browserContext) return this.page;

    console.log(`[Browser] Launching browser with profile: ${this.config.userDataDir}`);
    const launchOptions = {
      headless: this.config.headless,
      viewport: { width: 1280, height: 800 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-infobars'
      ]
    };

    if (this.config.useRealChrome) {
      try {
        launchOptions.channel = 'chrome';
      } catch (e) {
        console.log('[Browser] System Chrome not detected, using Chromium');
      }
    }

    this.browserContext = await chromium.launchPersistentContext(this.config.userDataDir, launchOptions);
    const pages = this.browserContext.pages();
    this.page = pages.length > 0 ? pages[0] : await this.browserContext.newPage();
    return this.page;
  }

  async closeBrowser() {
    if (this.browserContext) {
      await this.browserContext.close();
      this.browserContext = null;
      this.page = null;
    }
  }

  async ensureLoggedIn() {
    await this.launchBrowser();
    console.log('[Meesho] Navigating to Meesho Supplier Panel...');
    await this.page.goto('https://supplier.meesho.com/panel/v3/new/root/login', { waitUntil: 'domcontentloaded' });

    // Check if already logged in (redirected to dashboard or /orders)
    await this.page.waitForTimeout(2500);
    const currentUrl = this.page.url();
    if (currentUrl.includes('/home') || currentUrl.includes('/orders') || currentUrl.includes('/fulfillment')) {
      console.log('✅ Already logged into Meesho supplier account!');
      return true;
    }

    console.log('\n======================================================');
    console.log('👉 Please complete your login on the Meesho browser window.');
    console.log('   (Enter email/mobile, password, and OTP if asked).');
    console.log('   The tool will automatically resume once logged in!');
    console.log('======================================================\n');

    // Wait until URL changes away from /login
    await this.page.waitForFunction(
      () => !window.location.href.includes('/root/login') && !window.location.href.includes('login'),
      { timeout: 300000 } // 5 minutes
    );

    console.log('✅ Successfully authenticated with Meesho!');
    return true;
  }

  deriveScanNowUrl(fromUrl) {
    const src = fromUrl && fromUrl.startsWith('http') ? fromUrl : this.config.meeshoOrdersUrl;
    if (src.includes('/scan-now')) return src.split('?')[0];
    if (src.includes('/orders/pending')) return src.replace('/orders/pending', '/scan-now').split('?')[0];
    const m = src.match(/(.*\/fulfillment\/[^\/\?#]+)/);
    if (m) return `${m[1]}/scan-now`;
    return src;
  }

  // Verified flow (Oct 2026): pending page button "Scan Barcoded Packets"
  // navigates to the full scan-now page (NOT a modal). Never click
  // "Buy Barcoded Packets" — that opens the purchase flow.
  async openScanModal() {
    await this.launchBrowser();
    const currentUrl = this.page.url();

    if (currentUrl.includes('/scan-now')) {
      return true;
    }

    if (!currentUrl.includes('/orders/pending') && !currentUrl.includes('/fulfillment')) {
      console.log(`[Meesho] Navigating to orders pending page: ${this.config.meeshoOrdersUrl}`);
      await this.page.goto(this.config.meeshoOrdersUrl, { waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(3000);
    }

    // Click ONLY the exact scan entry-point button.
    const scanBtn = this.page.getByRole('button', { name: /Scan Barcoded Packets/i }).first();
    if (await scanBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      console.log('[Meesho] Found "Scan Barcoded Packets" button, clicking...');
      await scanBtn.click();
      try {
        await this.page.waitForURL(/scan-now/, { timeout: 10000 });
      } catch (_) {
        await this.page.waitForTimeout(2500);
      }
    }

    if (!this.page.url().includes('/scan-now')) {
      const scanNowUrl = this.deriveScanNowUrl(this.page.url());
      if (scanNowUrl.includes('/scan-now')) {
        console.log(`[Meesho] Loading scan-now page directly: ${scanNowUrl}`);
        await this.page.goto(scanNowUrl, { waitUntil: 'domcontentloaded' });
        await this.page.waitForTimeout(3000);
      }
    }

    return true;
  }

  async linkPacketPair(trackingId, flyerId) {
    const cleanTracking = String(trackingId || '').trim();
    const cleanFlyer = String(flyerId || '').trim();
    if (!cleanTracking || !cleanFlyer) {
      return { success: false, remark: 'Missing tracking ID or flyer ID' };
    }

    await this.openScanModal();

    // 1. Step 1 AWB input — placeholder "Scan/Type AWB Number".
    // Element IDs are React-generated per load, so match by placeholder only.
    const awbInput = this.page.getByPlaceholder(/AWB/i).first();
    if (!(await awbInput.isVisible({ timeout: 8000 }).catch(() => false))) {
      return { success: false, remark: 'Step 1 AWB input not found on scan-now page' };
    }

    console.log(`[Scan] Typing AWB: ${cleanTracking}`);
    await awbInput.click();
    await awbInput.fill(cleanTracking);
    await this.page.keyboard.press('Enter');
    await this.page.waitForTimeout(this.config.actionDelayMs);

    // 2. Step 2 Packet ID input — placeholder "Packet ID". Enabled only after a valid AWB.
    const flyerInput = this.page.getByPlaceholder(/Packet ID/i).first();
    if (!(await flyerInput.isVisible({ timeout: 8000 }).catch(() => false))) {
      return { success: false, remark: `Step 2 Packet ID input not found after entering AWB ${cleanTracking}` };
    }
    if (await flyerInput.isDisabled().catch(() => false)) {
      const bodyText = await this.page.locator('body').innerText().catch(() => '');
      return { success: false, remark: `Meesho did not accept AWB ${cleanTracking} (Step 2 stayed disabled). ${bodyText.slice(0, 200)}` };
    }

    console.log(`[Scan] Typing Flyer ID: ${cleanFlyer}`);
    await flyerInput.click();
    await flyerInput.fill(cleanFlyer);
    await this.page.keyboard.press('Enter');
    await this.page.waitForTimeout(this.config.actionDelayMs);

    // 3. Submit (enables only after both steps) -> green toast
    // "Packet ID <id> is linked successfully".
    const submitBtn = this.page.getByRole('button', { name: /^Submit$/i }).first();
    if (!(await submitBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
      return { success: false, remark: `Submit button not found after entering Packet ID ${cleanFlyer}` };
    }
    if (await submitBtn.isDisabled().catch(() => false)) {
      const bodyText = await this.page.locator('body').innerText().catch(() => '');
      return { success: false, remark: `Submit stayed disabled for AWB ${cleanTracking} + Packet ${cleanFlyer}. ${bodyText.slice(0, 200)}` };
    }
    await submitBtn.click();
    await this.page.waitForTimeout(2800);

    const bodyText = await this.page.locator('body').innerText().catch(() => '');
    const okMatch = bodyText.match(/Packet ID\s+(\S+)\s+is linked successfully/i);
    if (okMatch || /is linked successfully/i.test(bodyText)) {
      console.log(`[Scan] ✅ Successfully paired AWB ${cleanTracking} <-> Packet ${cleanFlyer}`);
      return { success: true, remark: `Packet ID ${okMatch ? okMatch[1] : cleanFlyer} is linked successfully` };
    }

    const errMatch = bodyText.match(/(already\s+(used|linked)[^\n]{0,120}|invalid[^\n]{0,120}|not\s+found[^\n]{0,120}|incorrect[^\n]{0,120}|mismatch[^\n]{0,120}|failed[^\n]{0,120})/i);
    if (errMatch) {
      console.warn(`[Scan] ⚠️ Meesho alert: ${errMatch[1].trim()}`);
      return { success: false, remark: errMatch[1].trim().slice(0, 300) };
    }

    return { success: false, remark: `No success confirmation from Meesho for AWB ${cleanTracking} + Packet ${cleanFlyer}. Page said: ${bodyText.slice(0, 300)}` };
  }

  async fetchPendingVmsQueue() {
    const url = `${this.config.vmsApiUrl}/api/meesho/flyer-queue?status=PENDING&limit=50`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.config.authToken) {
      headers['Authorization'] = `Bearer ${this.config.authToken}`;
    }

    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      const data = await res.json();
      return data.items || [];
    } catch (err) {
      console.error(`[VMS Queue] Failed to fetch queue:`, err.message);
      return [];
    }
  }

  async updateVmsStatus(id, trackingId, flyerId, status, remark) {
    const url = `${this.config.vmsApiUrl}/api/meesho/flyer-queue/link`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.config.authToken) {
      headers['Authorization'] = `Bearer ${this.config.authToken}`;
    }

    try {
      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          items: [{ id, trackingId, flyerId, status, remark }]
        })
      });
    } catch (err) {
      console.error(`[VMS Queue] Failed to update status:`, err.message);
    }
  }

  async runSyncLoop() {
    await this.ensureLoggedIn();

    console.log('\n[Sync] Starting real-time sync with VMS database queue...');
    const items = await this.fetchPendingVmsQueue();

    if (items.length === 0) {
      console.log('[Sync] No pending Meesho flyer scans in queue right now.');
      return 0;
    }

    console.log(`[Sync] Found ${items.length} pending scans to link on Meesho.`);
    let processed = 0;

    for (const item of items) {
      console.log(`\n------------------------------------------------------`);
      console.log(`Processing [${processed + 1}/${items.length}]`);
      console.log(`AWB:   ${item.trackingId}`);
      console.log(`Flyer: ${item.flyerId}`);

      const result = await this.linkPacketPair(item.trackingId, item.flyerId);

      const status = result.success ? 'LINKED' : 'FAILED';
      await this.updateVmsStatus(item.id, item.trackingId, item.flyerId, status, result.remark);
      processed++;

      // Small breather between consecutive parcels
      await new Promise(r => setTimeout(r, 1200));
    }

    console.log(`\n🎉 Completed batch of ${processed} scans.`);
    return processed;
  }
}

module.exports = { MeeshoAutomator };
