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
      // Link-up starts from this scan day (YYYY-MM-DD); older backlog excluded.
      queueSince: /^\d{4}-\d{2}-\d{2}$/.test(config.queueSince || '') ? config.queueSince : '2026-10-05',
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

    // All interaction runs inside page.evaluate: Meesho shows modal dialogs
    // (proven live: "Order cancelled") whose backdrop intercepts Playwright's
    // actionability clicks, while in-page clicks keep working. Toast-first
    // verdicts apply: Enter in the Packet field usually auto-submits, so a
    // grey Submit + success toast + cleared fields IS a success.
    const verdict = await this.page.evaluate(async ({ awb, pkt, delay }) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const bodyText = () => (document.body ? document.body.innerText : '');
      const findDialog = () => document.querySelector('[role="dialog"], [aria-modal="true"]');
      const dialogBtn = () => {
        const dlg = findDialog();
        if (!dlg) return null;
        return Array.from(dlg.querySelectorAll('button')).find((b) =>
          /^(okay|ok|close|done|got it|continue)$/i.test(((b.innerText || b.textContent) || '').trim())) || null;
      };
      const toastHit = () => {
        const t = bodyText();
        const m = t.match(/Packet ID\s+(\S+)\s+is linked successfully/i);
        if (m) return m[0];
        if (/is linked successfully/i.test(t)) return 'linked successfully';
        return null;
      };
      const setVal = (el, v) => {
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
        if (setter) setter.call(el, v); else el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const enter = (el) => {
        const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent('keydown', o));
        el.dispatchEvent(new KeyboardEvent('keypress', o));
        el.dispatchEvent(new KeyboardEvent('keyup', o));
      };
      for (let k = 0; k < 3; k++) {
        const b = dialogBtn();
        if (!b) break;
        if (k === 0 && /cancel/i.test((findDialog().innerText || ''))) break;
        b.click(); await wait(1000);
      }
      const awbInput = document.querySelector('input[placeholder*="AWB" i]');
      if (!awbInput) return { ok: false, detail: 'Step 1 AWB input not found on scan-now page' };
      setVal(awbInput, ''); await wait(150);
      setVal(awbInput, awb); await wait(250);
      enter(awbInput); await wait(delay);
      let dlg = findDialog();
      if (dlg && /cancel/i.test(dlg.innerText || '')) {
        const msg = (dlg.innerText || '').replace(/\s+/g, ' ').slice(0, 220);
        const b = dialogBtn(); if (b) b.click();
        return { ok: false, detail: 'ORDER_CANCELLED: ' + msg };
      }
      const pktInput = document.querySelector('input[placeholder*="Packet ID" i]');
      if (!pktInput) return { ok: false, detail: `Step 2 Packet ID input not found after entering AWB ${awb}` };
      if (pktInput.disabled) return { ok: false, detail: `AWB rejected (Step 2 disabled). ${bodyText().slice(0, 200)}` };
      setVal(pktInput, ''); await wait(150);
      setVal(pktInput, pkt); await wait(250);
      enter(pktInput); await wait(3000);
      let hit = toastHit();
      if (hit) return { ok: true, detail: hit };
      dlg = findDialog();
      if (dlg && /cancel/i.test(dlg.innerText || '')) {
        const msg = (dlg.innerText || '').replace(/\s+/g, ' ').slice(0, 220);
        const b = dialogBtn(); if (b) b.click();
        return { ok: false, detail: 'ORDER_CANCELLED: ' + msg };
      }
      const submit = Array.from(document.querySelectorAll('button'))
        .find((b) => ((b.innerText || b.textContent) || '').trim().toLowerCase() === 'submit');
      if (submit && !submit.disabled) {
        submit.click(); await wait(3000);
        hit = toastHit();
        if (hit) return { ok: true, detail: hit };
      } else {
        hit = toastHit();
        if (hit) return { ok: true, detail: hit };
      }
      const err = bodyText().match(/(already\s+(used|linked)[^\n]{0,120}|invalid[^\n]{0,120}|not\s+found[^\n]{0,120}|incorrect[^\n]{0,120}|mismatch[^\n]{0,120}|failed[^\n]{0,120})/i);
      if (err) return { ok: false, detail: err[1].trim().slice(0, 300) };
      return { ok: false, detail: `no-confirm. Page tail: ${bodyText().slice(-300)}` };
    }, { awb: cleanTracking, pkt: cleanFlyer, delay: this.config.actionDelayMs || 1200 }).catch((e) => ({ ok: false, detail: 'EXCEPTION: ' + e.message }));

    if (verdict.ok) {
      console.log(`[Scan] ✅ Successfully paired AWB ${cleanTracking} <-> Packet ${cleanFlyer}`);
      return { success: true, remark: verdict.detail };
    }
    console.warn(`[Scan] ⚠️ ${verdict.detail}`);
    return { success: false, remark: String(verdict.detail || 'No success confirmation from Meesho').slice(0, 300) };
  }

  async fetchPendingVmsQueue() {
    const url = `${this.config.vmsApiUrl}/api/meesho/flyer-queue?status=PENDING&limit=50&from=${encodeURIComponent(this.config.queueSince)}`;
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

    console.log(`\n[Sync] Starting real-time sync with VMS database queue (since ${this.config.queueSince})...`);
    const rawItems = await this.fetchPendingVmsQueue();

    // Second guard: skip anything scanned before the cutoff day.
    const cutoffMs = new Date(`${this.config.queueSince}T00:00:00Z`).getTime();
    const items = (rawItems || []).filter((it) => {
      const ts = it && it.createdAt ? new Date(it.createdAt).getTime() : NaN;
      return Number.isNaN(ts) || ts >= cutoffMs;
    });
    if (items.length < (rawItems || []).length) {
      console.log(`[Sync] Skipped ${(rawItems || []).length - items.length} scan(s) older than ${this.config.queueSince}.`);
    }

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

      // Same-pair re-scan (message echoes our AWB) counts as done. A packet
      // consumed by another order stays FAILED — never false-LINKED.
      const awbEcho = String(item.trackingId || '').trim();
      const alreadyDone = !result.success && /already/i.test(result.remark || '') && awbEcho && String(result.remark || '').includes(awbEcho);
      const alreadyUsedElsewhere = !result.success && !alreadyDone && /already\s+(linked|used)/i.test(result.remark || '');
      const status = (result.success || alreadyDone) ? 'LINKED' : 'FAILED';
      const remark = alreadyDone
        ? `Already linked on Meesho (${result.remark})`
        : (alreadyUsedElsewhere
          ? `Packet already used by another order — rescan ${awbEcho || 'AWB'} with a fresh packet (${result.remark})`
          : result.remark);
      await this.updateVmsStatus(item.id, item.trackingId, item.flyerId, status, remark);
      processed++;

      // Small breather between consecutive parcels
      await new Promise(r => setTimeout(r, 1200));
    }

    console.log(`\n🎉 Completed batch of ${processed} scans.`);
    return processed;
  }
}

module.exports = { MeeshoAutomator };
