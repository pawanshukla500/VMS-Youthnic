# VMS-Youthnic - Agent Instructions

## Project Structure
- **Monorepo** with two packages:
  - `server/` - Fastify + TypeScript API (PostgreSQL, Firebase Admin)
  - `client/` - React + Vite + TypeScript SPA (Firebase Auth, Tailwind)

## Key Commands

### Server (run from `server/`)
```bash
npm run dev       # ts-node src/index.ts (dev)
npm run build     # tsc -> dist/
npm run start     # node dist/index.js (prod)
npm run migrate   # ts-node src/db/migrate.ts
npm test          # vitest (src/tests/**/*.test.ts)
```

### Client (run from `client/`)
```bash
npm run dev       # vite dev server
npm run build     # tsc && vite build
npm run preview   # vite preview
npm run electron:build  # tsc -p electron/tsconfig.json -> electron-dist/
npm run electron:dev    # vite + Electron shell against /packing (dev)
npm run dist      # build + package Windows NSIS installer -> release/
```

### Docker (from root)
```bash
docker-compose -f docker-compose.hostinger.yml up --build
```

## Architecture Notes

- **Auth**: Firebase Auth (client) → Firebase Admin verifyIdToken (server) → PostgreSQL `organization_members` for multi-tenant scoping
- **Auth middleware** at `server/src/middleware/auth.ts` attaches `{uid, user_id, organization_id, role}` to request
- **All protected routes** require `Authorization: Bearer <firebase-id-token>`
- **Multi-tenancy**: Every query filters by `organization_id` from auth context
- **Video storage**: Firebase Storage (`packing-videos/` prefix), metadata in PostgreSQL `video_assets`
- **Desktop app** (`client/electron/`): thin Electron shell around the same Vite build (packers only). Finished videos are mirrored to OS user-data disk via preload IPC (`desktopMirror.ts`); uploads still run through the same IndexedDB queue + worker. Installer served from `GET /api/downloads/latest` (login-gated, 302 to the Firebase Storage CDN); updater feed is the Firebase `desktop-releases/` base (VPS `/api/downloads/files/*` mirrors it); publish via `Release desktop app` workflow.
- **Database migrations**: Run via `migrate.ts` (creates tables + indexes), also auto-runs `ensureRuntimeTables()` on server start

## Environment Variables

### Server (required)
| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase Admin service account (JSON string) |
| `FIREBASE_STORAGE_BUCKET` | Firebase Storage bucket name |
| `ORDER_RECONCILE_SECRET` | Secret for cron job endpoint |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins |
| `AUTO_PROVISION_USERS` | Set `true` to auto-create org/user on first login (dev only) |
| `DESKTOP_DOWNLOAD_DIR` | Dir of published desktop installers (default `<cwd>/downloads`) |
| `AJIO_WFR_SECRET` | Secret for the Ajio WFR CCTV job endpoint |
| `AJIO_GMAIL_ADDRESS` / `AJIO_GMAIL_APP_PASSWORD` | Mailbox + App Password fallback that receives Ajio CCTV mails |
| `AJIO_GMAIL_OAUTH_CLIENT_ID` / `AJIO_GMAIL_OAUTH_CLIENT_SECRET` | Gmail OAuth client (one-click connect on Ajio page, preferred over App Password) |
| `AJIO_TEST_SENDERS` | CSV of extra accepted mail senders for trials (empty = Ajio only) |
| `AJIO_GDRIVE_SA_JSON` / `AJIO_GDRIVE_FOLDER_ID` | Service Account key + shared Drive folder for WFR video links |
| `AJIO_ALERT_EMAILS` | Failure/fallback/SLA-breach recipients (fallback `REPORT_TO_EMAILS`) — a missed CCTV reply risks an Ajio penalty, so every failed WFR run emails at once |
| `AJIO_WFR_INTERVAL_HOURS` / `AJIO_WFR_SLA_HOURS` | Safety-net sweep interval (default 6) / open-request escalation age in hours (default 12) |
| `PG_POOL_MAX` | Connection pool size (default 10) |
| `FORWARD_SCAN_DATABASE_URL` | Forward Scan DB to copy orders from (compose default `sqlite:////forward-scan-data/omsguru_forward_scan.db`; `postgresql://` also accepted) |
| `FORWARD_SCAN_RETENTION_DAYS` | Days of orders kept by AWB date (default 3) |
| `FORWARD_SCAN_SYNC_INTERVAL_SECONDS` | Copy interval, 30..3600 (default 300 = every 5 min) |
| `FORWARD_SCAN_EXCLUDE_MARKETPLACES` | Marketplaces NOT copied (default `Flipkart,Myntra Youthnic,Myntra PPMP`; matches marketplace or Forward Scan channel type; `none` = copy all). Their copied rows are purged; manual rows kept |
| `FORWARD_SCAN_ORG_IDS` | CSV of org UUIDs that receive the copy. Empty = the single active org; with several active orgs the copy stays OFF until this is set (fail closed) |
| `SKU_IMAGE_SYNC_ENABLED` / `SKU_IMAGE_SYNC_HOUR_IST` / `SKU_IMAGE_SYNC_MAX_MINUTES` | Nightly OMSGuru SKU photo sync on/off (default on), start hour IST (default 2), max run length (default 60) |
| `SKU_IMAGE_SYNC_RESERVE` / `SKU_IMAGE_SYNC_FULL_REFRESH_DAYS` | Calls of every 60/5 min left for Forward Scan (default 25) / days before a full re-walk (default 30, 0 = never) |

### Client (build-time via Vite `VITE_*` prefix)
| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | Backend API base URL |
| `VITE_ORG_ID` | Organization ID (fallback) |
| `VITE_FIREBASE_*` | Firebase Web SDK config |

## Testing
- **Server**: `npm test` runs vitest on `src/tests/**/*.test.ts` (currently 4 tests for auth middleware)
- **Client**: vitest configured but no tests yet (`client/src/tests/stress.test.ts` exists)

## Roles
- `ADMIN` = full access; `MANAGER` = everything except core controls:
  user deletes, non-packer roles, retention PUT, wipe, station delete,
  OMSGuru settings/sync. Managers CAN list users, create PACKER accounts,
  reset packer passwords, link stations, and create stations (server
  enforces via `effectiveCreateRole`/`canResetPassword` — never trust UI).
  `PACKER` = operational pages only.
- Helpers in `server/src/middleware/auth.ts`: `isAdmin`,
  `isManagerOrAdmin`, `normalizeRole` (uppercase). Never compare
  `user.role` to a literal — DB values mix cases by write path.

## Daily report email
- `POST /api/jobs/daily-report` (secret `REPORT_JOB_SECRET` via
  `x-report-secret` or Bearer; `?date=YYYY-MM-DD` IST day, `?dryRun=1`
  skips sending). Sends packed-today stats via Resend.
- Requires `RESEND_API_KEY` + `REPORT_TO_EMAILS`; sender domain
  (`REPORT_FROM_EMAIL`, default `reports@pkvm.youthnic.shop`) must be
  verified in Resend first. Schedule with cron (see DEPLOYMENT.md).

## Ajio WFR (CCTV replies)
- Triggers: VPS host cron 4x daily (`scripts/vps/`, installed by deploy),
  in-process safety net, admin Run button; the GitHub workflow is manual
  only. Every trigger MUST go through `withAjioWfrLock` (409 when busy) and
  `runRecordedAjioWfrJob` (ledger `ajio_wfr_runs` + Resend alerts).
- A reply must never be sent twice: `ajio_wfr_requests.status = 'done'` is
  sticky (guarded upserts), and a sent reply is recorded `done` even when
  its bookkeeping fails. Mail listing has no read-state filter — the ledger
  is the only dedupe.

## Recording quality
- Target 1080p (camera chain 1080p -> 720p -> any; no 1440p: it doubled
  software-encode work and many webcams run 2K at ~15 fps), floor 720p
  (`MIN_RECORDING_HEIGHT`); bitrate from `pickRecordingBitrate` (videoQueue).
  Video-only, no audio by policy. Client sends actual output dims; server
  falls back to 1920x1080.
- Watermark pipeline (`client/src/utils/canvasWatermarker.ts`): NEVER go
  back to a requestAnimationFrame canvas + `captureStream(30)` — it repeated
  / skipped camera frames (25% duplicates in a real video = stutter) and
  froze whenever the main thread was busy or the window hidden. Order:
  'worker' (MediaStreamTrackProcessor -> `recordingCompositor.worker.ts`
  OffscreenCanvas -> MediaStreamTrackGenerator, camera timestamps kept) >
  'video-frame' (requestVideoFrameCallback + captureStream(0) +
  requestFrame) > 'animation-frame' (legacy). One session per recording
  (`startSession()` -> `stop()` returns frame stats); a per-recording clone
  of the camera track, so the preview is never touched. Bench (fake 30 fps
  camera, 1080p): worker = 30 fps / 0% repeats even with both cores
  saturated; legacy = 15-19 fps / 7-23% repeats under load.
- Chunks: one IndexedDB record per 2-second chunk (`recording_chunks`, DB
  v4, key [sessionId, seq]); `active_recording` holds metadata only. The old
  read-rewrite-the-whole-array append cost 63 ms per chunk after ~10 min
  (O(n^2) disk I/O); now ~0.4 ms flat. `getRecordingChunks` also reads
  legacy in-record chunks (crash recovery of pre-v4 sessions).
- A finished video is saved in the background (`finalizeQueue`), so the
  next parcel starts recording immediately; a page closed mid-save is
  recovered from its chunks on the next load (beforeunload guard covers it).
  Save and crash recovery share a Web Lock per recording id (recovery only
  takes free sessions); the flyer id is written to the active row as soon
  as it is scanned, so recovered videos keep it.
- A recorder that stops without `stopRecording` (camera unplugged, worker
  gave up after 15 undrawable frames / 1.5 s / lost GPU context) resets the
  page to "not recording" with an error beep + toast; the camera track's
  `ended` event flips the camera card to error. The worker path is dropped
  for the main-thread fallback only after 2 failures in a row and is
  pre-warmed when the camera is ready. IndexedDB v4 open: `blocked` ->
  "close other VMS tabs" toast, `blocking` -> step aside, 8 s timeout so a
  scan never hangs.
- Frame stats (`RecordingStats`: camera/output fps, dropped, camera gaps,
  compose ms, mode) travel with the upload -> `recording_sessions.recording_stats`
  (sanitized, `server/src/recordingStats.ts`); laggy videos log
  `[recording] laggy video …`; System Health shows "Recording quality (24 h)".

## Scanned ids (packing page)
- Tracking AND flyer ids are stored in CAPITALS everywhere
  (`normalizeScannedId`, upload worker, server `normalizeScanId`, Order
  Imports); startup backfills older lowercase rows (collision-safe for
  `marketplace_order_mappings`). Order ids keep their case.
- Wrong-scan guard (`classifyScan`): codes with characters other than
  A-Z / 0-9 / '-', shorter than 8, longer than 40 or with fewer than 5 digits
  are rejected with `WrongScanAlert` (3 s, error beep) and change nothing.
  Flyer mode only rejects that junk (any other code is still accepted as a
  flyer bag, as before).

## Order data: Forward Scan copy (no OMSGuru order calls from VMS)
- VMS does NOT sync orders from OMSGuru any more (no auto-sync, no per-scan
  live lookups). Only SKU photos come from OMSGuru, nightly (next section). Forward Scan (`scan.youthnic.shop`, same
  VPS, SQLite at `/opt/forward-scan/Forward-Scan/data`, mounted into the
  backend at `/forward-scan-data`) already syncs OMSGuru; VMS copies its
  `oms_orders` + `channels` + `sku_photos` read-only every 5 min into
  `marketplace_orders` / `sku_images` (`server/src/forwardScan/`).
- Window: last `FORWARD_SCAN_RETENTION_DAYS` (3) by AWB date; older rows are
  purged each run. Only rows whose sha1 changed are written. Buyer PII is
  never copied. A scan-time miss reads that one AWB straight from the
  Forward Scan DB (`copyOneForwardScanOrder`, still zero API calls).
- Marketplace naming = right side of the channel label ("Tulip Prints -
  Meesho" -> "Meesho"), same as `normalizeMarketplace`; `channel_marketplace`
  keeps Forward Scan's `channels.marketplace`; `is_meesho` drives the
  packing-page flyer switch (ON for Meesho, OFF for every other known
  marketplace, manual switch only for unknown parcels).
- Order identity: Meesho = first sub-order id; others = channel order id.
  `recordingOrderId` never renames Ajio recordings (ExtraInfo flow only).
- Ajio renames: ONLY via the Order Imports upload and ONLY to Ajio customer
  order numbers (`isAjioRenameOrderId`: letters+digits, e.g. FN6042808575,
  EX...). Other Ajio rows get `marketplace_order_mappings.rename_order =
  FALSE`: acknowledged (video filed under Ajio, `order_date` stamped from the
  copy/Forward Scan) but never renamed — every apply path (import, admin
  reconcile, cron reconcile, upload-worker resolve, video metadata) honors it.
- Flipkart / Myntra are not copied; the packing page treats `FMP…`/`MYS…`/
  `MYE…` AWBs as known non-Meesho (`isKnownNonMeeshoTracking`) so the flyer
  switch still turns OFF for them.
  `/api/order-mappings/resolve` and video metadata fall back to the copy
  when no Order Imports row exists, so videos get marketplace + order id.
- Manual fixes: Synced Orders page (`/synced-orders`, manager+).
  `PUT /api/synced-orders` sets `manual_override` (copy never overwrites),
  `POST /api/synced-orders/revert` undoes it. Manual SKU photo links are
  separate `sku_images` rows (`source='manual'`) and always win over the
  line image and the Forward Scan catalogue photo.
- `POST /api/jobs/forward-scan-sync` (alias `/api/jobs/omsguru-sync`,
  `ORDER_RECONCILE_SECRET`) and `POST /api/admin/forward-scan/sync`
  (admin-only, job rate limit) run a copy now;
  `GET /api/admin/forward-scan/status` shows health per org.
- Tenancy: Forward Scan is ONE business. `pickTargetOrganizations` decides
  who receives it (pinned via `FORWARD_SCAN_ORG_IDS`, else the single active
  org, else nobody); timer, admin button and scan-time misses all use it.
- Tracking ids over 128 chars are never looked up (the courier-suffix
  regex is quadratic on junk input); normalizers cap input too.
- Purge = older than the window by `GREATEST(awb_generated_at, updated_at)`,
  so scan-time copies of old AWBs and manual rows live 3 days from last change.
- WAL: the mount must stay writable (SQLite readers need `-shm`); the file
  is opened `readonly` + `query_only`. Connections are per run, never held.

## Nightly SKU photos (OMSGuru listings, `server/src/omsguru/skuImage*.ts`)
- Why: Forward Scan's photo job reads only 10 listing pages per channel,
  and pages are ASCENDING by id, so it never reaches new styles (Oct 2026:
  5 of 1,124 order SKUs had a photo). VMS walks every page of every active
  channel (incl. Flipkart/Myntra/FBA: their `sku_name` usually IS the master
  SKU) in turns of 20 pages, with a cursor per channel
  (`omsguru_listing_sync_state`); once a pass completes, nights read only new
  listings; a full re-walk every `SKU_IMAGE_SYNC_FULL_REFRESH_DAYS`.
- Schedule: in-process at `SKU_IMAGE_SYNC_HOUR_IST`:00 IST for
  `SKU_IMAGE_SYNC_MAX_MINUTES`; a restart inside the window catches up.
  One flight shared by the timer, `POST /api/jobs/sku-image-sync`
  (`ORDER_RECONCILE_SECRET`, 202/409) and `POST /api/admin/sku-images/sync`
  (admin, 15 min default). Status: `GET /api/admin/sku-images/sync-status`
  (manager+, Synced Orders card). Ledger: `sku_image_sync_runs`.
- Budget: calls spaced `minCallIntervalMs(reserve)` (~8.6 s at 25, so the
  reserve holds even without rate headers), plus a wait for the window reset
  whenever `X-OMS-Remaining <= SKU_IMAGE_SYNC_RESERVE` (`omsguruRateSnapshot`).
  The client makes 1 attempt per call here; throttling pauses 60 s. The
  first full catalogue can take a few nights.
- Failure isolation: a channel error is stored on its cursor row
  (`last_error`) and only that channel is skipped for the night; auth
  errors stop the run. Rows Postgres rejects are skipped one by one (text is
  cleaned of NUL / lone surrogates first); a page where every row fails
  stops the run. Only an EMPTY page ends a pass (short pages do not).
- Matching: order lines carry the master SKU (invoice `sku_code`); listings
  carry the channel SKU (`sku_name` = invoice `listing_sku`). Raw listings
  live in `omsguru_listings`; `REBUILD_SKU_IMAGES_SQL` writes one
  `sku_images` row (`source='omsguru'`) per key: own name > name without
  channel tags (`_AI`, `_AI1`, `_N`, `_NEW`, `_INF`) > names of listings with
  the same `oms_sku_id` (2XL/XXL, Ajio names; groups of 2-50 listings
  only, placeholder ids are ignored). Linear rebuild, only new/changed rows
  are written, 120 s statement timeout.
- Scan-time lookup (`resolveItemImages`): manual > line image > forward-scan
  > omsguru, then same style + colour in another size
  (`regexp_replace(sku_key, '_[^_]*$', '')`, expression index) flagged
  `imageMatch: 'style'` ("Photo shows another size"). URLs are stored, not
  image bytes (they are marketplace CDN links).

## Multi-item pop-up (packing page)
- When the scanned parcel has more than one unit (several SKUs, or one SKU
  x2 on one or more lines), `MultiItemAlert` shows every SKU with photo and
  count for `MULTI_ITEM_ALERT_MS` (3 s) plus a two-note chime, once per
  parcel. It never takes focus (scanner keeps typing into the scan input);
  tap / Esc / next scan close it. Grouping: `summarizeParcel`. Grid ticks
  are per line index (one SKU can sit on two lines).

## Meesho flyer scan (packing page)
- Org switch `meesho_settings.auto_flyer_scan` (default ON; Meesho Flyer
  page card, `PUT /api/meesho/auto-flyer-scan`, manager+). Packers get it via
  `GET /api/me` -> `packing.autoFlyerScan`. ON = switch armed at standby, ON
  for Meesho parcels, OFF for other known marketplaces; manual switch only
  for unknown parcels (`flyerToggleState`). OFF = old manual behaviour.
- Flyer link-up switch (Settings, admin; status also on the Meesho Flyer
  page): `meesho_settings.flyer_linkup_enabled` + `flyer_linkup_skip_date`
  (IST day), `GET/PUT /api/meesho/flyer-linkup` (PUT admin-only, audited).
  Flyer bags are ALWAYS saved with the video; the switch only stops the
  companion from linking them. OFF: new flyer scans are saved as `SKIPPED`
  (never sent; already-waiting PENDING ones go out once ON again). Skip
  today: today's PENDING + new scans of that IST day become `SKIPPED` with
  `recording_sessions.flyer_link_skipped_day`; "Resume today" re-queues only
  those; the skip ends by itself the next day. While inactive the companion's
  `GET /api/meesho/flyer-queue` returns no items (+ `linkup` state). Applied
  at save time by `holdFlyerIfLinkupOff` (recording's IST day). Managers can
  re-queue a single SKIPPED flyer ("Queue link-up").
- Companion app (`meesho-linkup-app`, v1.0.4+): re-stores Meesho's
  session-only cookies with a 30-day expiry (persist partition keeps them),
  registers "start with Windows" (`--autostart`, minimized), verifies the
  saved session on launch, re-logins with VMS-stored credentials only when
  expired, opens the login window only for OTP, and resumes Auto-Sync when
  `autoSyncEnabled` was on. Release: tag `meesho-vX.Y.Z` (workflow) and bump
  `MEESHO_LINKUP_VERSION` in server/src/index.ts.
- Companion tokens (`vms_comp_…`) authenticate with role `COMPANION`
  (never ADMIN) and the middleware allowlist (`companionRouteAllowed`) only
  lets them reach companion-auth/check, credentials, flyer-queue GET and
  flyer-queue/link POST. `/api/meesho/credentials` (plaintext seller login)
  = companion or ADMIN only; companion-token GET/regenerate = manager+.

## Public video links
- "Copy public link" (Video Library) -> `POST /api/videos/:id/share`
  (manager+, one live token per video, 256-bit base64url) ->
  `https://<app>/share/<token>`. The SPA route `/share/:token` is outside the
  login layout and calls `GET /api/public/videos/:token` (no auth, 60/min,
  no-store): returns only a 10-min signed URL + tracking/order/marketplace/
  recorded time. `DELETE /api/videos/:id/share` revokes (a signed URL
  already handed out still works for its <=10 min); deleting a video
  cascades its links. nginx serves `/share/` with `X-Robots-Tag: noindex`.
  Nothing else in VMS is public.

## Fonts / icons
- Inter + Material Symbols are self-hosted (`client/src/assets/fonts`, via
  `index.css` @font-face, hashed into /assets). Icons are 1em boxes hidden
  until `document.fonts` loads them (`html.icons-ready`, main.tsx) — raw
  ligature names must never show. Only JetBrains Mono uses Google Fonts.

## OMSGuru (server-side only)
- Token + client ID stay on the backend (`OMSGuru_TOKEN`/`OMSGuru_CID`);
  never put them in `VITE_*` (bundles are public, payloads carry buyer
  PII, rate budget is shared). VMS only uses them for the admin
  "Test connection" probe now; the `omsguru/` client + sync modules are
  kept (tested) but no longer scheduled or called per scan.
  Creds resolve per-org from `omsguru_settings` (admin UI, rotatable)
  with env fallback; token is masked (`••••1234`) everywhere outside DB.
- Lookup chain: AWB matched in invoices → `sub_order_id` → order details
  → `sku_code` → listing `img_url`. No AWB-direct endpoint exists.
- **List pagination is ASCENDING by internal id (proven live Sep 2026):
  `last_id=0` starts at the OLDEST row in the window, never the newest.**
  Never assume page 1 is recent — use short trailing windows (scan) or
  persisted `omsguru_poll_state` cursors (poll) to reach new rows.
- Invoices accept NO `warehouse_id` (= all warehouses, one stream);
  orders accept NO `status_id` (= all statuses, one stream per warehouse).
  Both proven live despite stricter Swagger markings.
- `order_details?sub_order_id=` does NOT filter reliably (returns
  unrelated/empty sets) — never build on it; `order_details?id=` (numeric
  OMSGuru id) is exact.
- Invoice/order rows carry NO status fields; item rows carry `status`.
  Trackers arrive bare in the API (UI adds `( courier )` suffixes for
  display); matching stays suffix-tolerant anyway.
- Throttling arrives as HTTP 429 AND as HTTP 200 + `{error:-4,message:
  "API Throttled"}` — the client backs off on both (GAS lesson).
- `GET /order_api/warehouses` lists all warehouses (50+; e.g. 6688 =
  "DEFAULT 33299"). Status polling covers the configured CSV only;
  invoices cover everything post-invoice.
- Ajio renders from OMSGuru like every marketplace but is NEVER renamed
  by it (`usesSubOrderIdentity` is Meesho-only); Meesho identity prefers
  the first item `subOrderId`.
- Channel company IDs: Amazon Flex 16778, Flipkart 17040, Meesho 17970,
  Myntra PPMP 18116/51680, Amazon FBA 22475, Ajio Api 59585. Invoices and
  orders use `channel_id`; `list_channel_listings` uses the documented
  `channel_company_id`.
- Resolve (`GET /api/order-context/resolve`) no longer calls OMSGuru: it
  reads Order Imports mappings, then `marketplace_orders` (Forward Scan
  copy), then one direct Forward Scan DB read for a miss. Pre-invoice
  orders carry no tracker — those AWBs can never match. Admin can probe
  OMSGuru with `POST /api/admin/omsguru-test` (also reports warehouse count).

## Common Gotchas
- **`VITE_API_URL` is build-time**: an empty value or `localhost` in a production
  build breaks all `/api/*` calls (including video-metadata POST) only after
  deploy. Client falls back to page origin via `client/src/utils/apiBase.ts`;
  compose/workflow default it to `https://$APP_DOMAIN`.
- **`ALLOWED_ORIGINS` must include the public frontend origin** in prod
  (e.g. `https://vms.youthnic.shop`), else browser metadata POSTs fail CORS.
  Server trims entries and logs effective origins on startup.
- **Server `ensureRuntimeTables()`** runs on startup - adds columns/tables if missing (idempotent)
- **Firebase Admin init** supports both service account JSON and ADC; bucket name falls back to `${project_id}.firebasestorage.app`
- **Order mapping reconcile** endpoint (`/api/jobs/order-mappings/reconcile`) requires `ORDER_RECONCILE_SECRET` via header `x-cron-secret` or `Authorization: Bearer`
- **Video upload** uses 500MB multipart limit (`@fastify/multipart`)
- **Client build** injects env vars at build time via Vite `define` - must rebuild for changes
- **Docker**: Traefik labels for routing; backend healthcheck on `/health/live`
  (logged at warn only). Measured idle (Oct 2026): backend ~0% CPU / ~50 MB,
  frontend ~3 MB; the VPS's big consumer is the separate Forward-Scan app.
  Guard rails, not squeeze: backend 1 GB / 1.5 CPU, heap
  `--max-old-space-size=640` (ExcelJS loads whole Order Imports workbooks),
  frontend 64 MB / 0.5 CPU, `init: true`,
  30 s stop grace. Do NOT add scale-to-zero / sleep: in-process schedules
  and packers' first scans need the API awake, and idle Node costs nothing.
  `server/src/monitoring.ts` samples event-loop p99 + RSS every minute
  (`[monitor]` warnings, System Health "Server resources"); `vps-check`
  workflow prints docker stats, OOM kills and log sizes.

## Database Schema (key tables)
- `organizations`, `users`, `organization_members` (role: ADMIN/PACKER)
- `stations` (warehouse + code), `recording_sessions`, `video_assets`
- `marketplace_order_mappings` (tracking_id → order_id + marketplace)
- `marketplace_retention_policies` (video/data retention days per marketplace)
- `marketplace_orders` (Forward Scan copy + manual orders, 3 days, one row per AWB, `is_meesho`, `manual_override`)
- `sku_images` (SKU photo links; `source` = forward-scan | manual | omsguru), `forward_scan_sync_state` (per-org health + photo cursor)
- `omsguru_listings` (nightly listing copy), `omsguru_listing_sync_state` (cursor per channel), `sku_image_sync_runs` (run ledger)
- `omsguru_order_cache`, `omsguru_sku_photos`, `omsguru_poll_state` (legacy, no longer written), `omsguru_settings`
- `audit_logs`, `order_import_batches`

## Deployment
- Hostinger VPS with Traefik + Let's Encrypt
- `docker-compose.hostinger.yml` defines backend (port 8080) + frontend (nginx port 80)
- Domain: `vms.youthnic.shop`
- Backend exposed at `/api/*` and `/health/*`, frontend at `/`
