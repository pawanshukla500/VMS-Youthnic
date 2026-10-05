# Meesho Flyer Link-up Desktop Application

Official Windows desktop companion application for **VMS-Youthnic**.

Automatically pairs **Courier Tracking AWBs (VL..., SF..., Delhivery)** with **Meesho Transparent Packaging Flyer Bag IDs (TP...)** directly inside the Meesho Supplier Hub (`https://supplier.meesho.com`).

---

## 📥 Download & Installation

The application is **100% self-contained**: it bundles its own embedded Chromium browser engine, Node.js runtime, and all offline assets. **No external dependencies, Python, Node.js, or Chrome installations are required on the host PC.**

### Direct Download Options:
1. **Full Windows Setup Installer (`Meesho-Flyer-Linkup-Setup-1.0.2-x64.exe`)**:
   - Creates Windows Desktop shortcut and Start Menu entry.
   - Recommended for dedicated packing and dispatch stations.
2. **Single-File Portable Executable (`Meesho-Flyer-Linkup-Portable-1.0.2-x64.exe`)**:
   - Zero installation or admin permissions needed — just double-click to run directly from anywhere (including USB drives).

Both files are available directly from:
- **VMS Web Dashboard**: Click **Download App (.exe)** on the **Meesho Flyer Link-up** page.
- **Direct VMS Endpoint**: `https://vms.youthnic.shop/api/downloads/meesho-linkup` (or `?portable=true`)
- **GitHub Releases**: `https://github.com/pawanshukla500/VMS-Youthnic/releases/tag/meesho-v1.0.2`

### Build Locally from Source (Optional)
```bash
cd meesho-linkup-app
npm install
npm run dist:all    # Builds both NSIS Setup and Portable .exe
```
The executables will be generated inside `meesho-linkup-app/release/`.

---

## 🌟 Application Features & Usage

When you open the app, you will see a clean dashboard with two primary modes:

### 1. 🔑 Connect Your Meesho Account (One-Time Setup)
- Click the **Login** button on the top right status bar.
- A secure window opens to `https://supplier.meesho.com/panel/v3/new/root/login`.
- Log in with your email/mobile and password. (Complete OTP if prompted).
- Once logged in, the app securely remembers your session cookies in a persistent local profile.
- **Why this is 100% reliable**: Because it runs on your office computer with your normal internet IP, Meesho **never** triggers Cloudflare bot bans or CAPTCHA blocks!

---

### 2. ⚡ Mode A: Automatic Real-Time Sync (Live Queue)
Use this during operational hours while packing stations are packing:
1. Ensure your **VMS Server URL** is set in Settings (e.g. `https://vms.youthnic.shop`).
2. Click **Start Auto-Sync**.
3. The app monitors your VMS packing queue in real time:
   - As packers scan parcels and flyer bags, they appear in the queue.
   - The app automatically navigates to Meesho's **Scan Barcoded Packets** popup, types the courier AWB, types the Packet ID, and presses Enter.
   - Upon confirmation, it marks the parcel as `LINKED` in your VMS database with live timestamps.
4. Watch the live activity log stream in real time!

---

### 3. 📁 Mode B: CSV File Upload (Batch Processing)
Use this if you prefer to batch-process scans from an exported file:
1. Export your scanned pairs from the VMS Web Dashboard (**PVMS -> Meesho Flyer -> Export Meesho CSV**), or prepare a spreadsheet with columns:
   `Tracking ID, Flyer ID`
2. Switch to the **CSV File Upload** tab.
3. Click **Browse CSV File** or drag & drop your file.
4. The app parses the file and previews all AWB <-> Packet ID rows in a table.
5. Click **Start Process & Sync**.
6. A live progress bar tracks the synchronization, showing real-time success checkmarks and status for every row.

---

### 4. 👁️ Live Preview Mode (Visual Proof & Verification)
Never wonder what the automation is doing behind the scenes:
- Click the **Live View** button in the top navigation bar or the **Open Live Preview** button in the dashboard.
- The dedicated Chromium browser window opens on screen, navigated to your Meesho seller hub.
- During both **Auto-Sync** and **CSV File Upload**, you can watch the cursor focus each field, type the AWB, type the packet ID, and verify the confirmation toast live before your eyes.
- Supports side-by-side docking so you can have the companion control dashboard on one side and the live portal on the other.

---

## ⚙️ Configuration & Settings

Under the **Settings** tab:
- **VMS Server API Base URL**: `https://vms.youthnic.shop`
- **VMS Auth Token**: (Optional) if using token authentication.
- **Meesho Pending Orders URL**: `https://supplier.meesho.com/panel/v3/new/fulfillment/yqcue/orders/pending`
- **Auto-Sync Check Interval**: Frequency in seconds to check for new scans (Default: 30s).
- **Barcode Action Delay**: Delay between typing AWB and Flyer ID in milliseconds (Default: 1000ms).
- **Show Meesho Chromium Browser Window**: Toggle on to watch the automation type the barcodes live on screen in real time.

---

## 🚀 GitHub Actions Release Workflow

The repository includes an automated CI/CD workflow at [`.github/workflows/meesho-linkup-release.yml`](file:///.github/workflows/meesho-linkup-release.yml):
- **To create a release automatically**:
  Push a Git tag:
  ```bash
  git tag meesho-v1.0.0
  git push origin meesho-v1.0.0
  ```
- **Or trigger manually**:
  Go to **GitHub -> Actions -> "Release Meesho Flyer Link-up App" -> Run workflow**.
  GitHub will compile the Windows `.exe` installer and attach it directly to the GitHub Release.
