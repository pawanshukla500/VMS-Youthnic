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

  async openScanModal() {
    await this.launchBrowser();
    const currentUrl = this.page.url();

    if (!currentUrl.includes('/orders/pending') && !currentUrl.includes('/fulfillment')) {
      console.log(`[Meesho] Navigating to orders pending page: ${this.config.meeshoOrdersUrl}`);
      await this.page.goto(this.config.meeshoOrdersUrl, { waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(3000);
    }

    // Look for "Scan Barcoded Packets" or "Buy Barcoded Packets" or "Scan & Pack"
    const scanButtonSelectors = [
      'button:has-text("Scan Barcoded Packets")',
      'button:has-text("Scan & Pack")',
      'button:has-text("Buy Barcoded Packets")',
      'button:has-text("Barcoded Packaging")',
      'button:has-text("Barcoded Packets")'
    ];

    let buttonFound = null;
    for (const selector of scanButtonSelectors) {
      const btn = this.page.locator(selector).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        buttonFound = btn;
        console.log(`[Meesho] Found scan button: ${selector}`);
        break;
      }
    }

    if (buttonFound) {
      await buttonFound.click();
      await this.page.waitForTimeout(1500);
    } else {
      console.log('[Meesho] Notice: Scan button not clicked or modal already open.');
    }

    return true;
  }

  async linkPacketPair(trackingId, flyerId) {
    if (!trackingId || !flyerId) {
      return { success: false, remark: 'Missing tracking ID or flyer ID' };
    }

    await this.openScanModal();

    // 1. Locate AWB input
    const awbSelectors = [
      'input[placeholder*="AWB" i]',
      'input#DW5OZxdlm_GQfYE_TbXEB',
      'input[placeholder*="Scan/Type AWB" i]',
      'input[placeholder*="Tracking" i]'
    ];

    let awbInput = null;
    for (const sel of awbSelectors) {
      const loc = this.page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
        awbInput = loc;
        break;
      }
    }

    if (!awbInput) {
      return { success: false, remark: 'Could not find AWB input field on Meesho modal' };
    }

    console.log(`[Scan] Typing AWB: ${trackingId}`);
    await awbInput.click();
    await awbInput.fill('');
    await awbInput.type(trackingId, { delay: this.config.typeDelayMs });
    await this.page.keyboard.press('Enter');
    await this.page.waitForTimeout(this.config.actionDelayMs);

    // 2. Locate Packet ID / Flyer input
    const flyerSelectors = [
      'input[placeholder*="Packet" i]',
      'input#hnNpGSXM7CB4iVLXbs6uf',
      'input[placeholder*="Flyer" i]',
      'input[placeholder*="Scan/type Packet ID" i]'
    ];

    let flyerInput = null;
    for (const sel of flyerSelectors) {
      const loc = this.page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
        flyerInput = loc;
        break;
      }
    }

    if (!flyerInput) {
      return { success: false, remark: 'Could not find Packet ID input field on Meesho modal' };
    }

    console.log(`[Scan] Typing Flyer ID: ${flyerId}`);
    await flyerInput.click();
    await flyerInput.fill('');
    await flyerInput.type(flyerId, { delay: this.config.typeDelayMs });
    await this.page.keyboard.press('Enter');
    await this.page.waitForTimeout(this.config.actionDelayMs);

    // 3. Check for any error toast or success notification on Meesho
    const errorToast = this.page.locator('.toast-error, [role="alert"], .error-message, div:has-text("already used")').first();
    const isErrorVisible = await errorToast.isVisible({ timeout: 1200 }).catch(() => false);

    if (isErrorVisible) {
      const errorText = await errorToast.innerText().catch(() => 'Error on Meesho');
      console.warn(`[Scan] ⚠️ Meesho alert: ${errorText}`);
      return { success: false, remark: errorText.trim().slice(0, 200) };
    }

    console.log(`[Scan] ✅ Successfully paired AWB ${trackingId} <-> Packet ${flyerId}`);
    return { success: true, remark: 'Linked successfully on Meesho' };
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
