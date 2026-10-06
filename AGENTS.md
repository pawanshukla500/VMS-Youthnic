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
| `PG_POOL_MAX` | Connection pool size (default 10) |
| `FORWARD_SCAN_DATABASE_URL` | Forward Scan DB to copy orders from (compose default `sqlite:////forward-scan-data/omsguru_forward_scan.db`; `postgresql://` also accepted) |
| `FORWARD_SCAN_RETENTION_DAYS` | Days of orders kept by AWB date (default 3) |
| `FORWARD_SCAN_SYNC_INTERVAL_SECONDS` | Copy interval, 30..3600 (default 120) |
| `FORWARD_SCAN_EXCLUDE_MARKETPLACES` | Marketplaces NOT copied (default `Flipkart,Myntra Youthnic,Myntra PPMP`; matches marketplace or Forward Scan channel type; `none` = copy all). Their copied rows are purged; manual rows kept |
| `FORWARD_SCAN_ORG_IDS` | CSV of org UUIDs that receive the copy. Empty = the single active org; with several active orgs the copy stays OFF until this is set (fail closed) |

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

## Recording quality
- Target 1080p, floor 720p (`MIN_RECORDING_HEIGHT`), 2.5 Mbps
  (`VIDEO_BITRATE_BPS` in `client/src/utils/videoQueue.ts`). Video-only,
  no audio by policy (constraints + watermarker both audio-free). Client
  sends actual output dims; server falls back to 1920x1080.

## Order data: Forward Scan copy (no OMSGuru calls from VMS)
- VMS does NOT sync from OMSGuru any more (no auto-sync, no per-scan live
  lookups, no photo bootstrap). Forward Scan (`scan.youthnic.shop`, same
  VPS, SQLite at `/opt/forward-scan/Forward-Scan/data`, mounted into the
  backend at `/forward-scan-data`) already syncs OMSGuru; VMS copies its
  `oms_orders` + `channels` + `sku_photos` read-only every 2 min into
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

## Meesho flyer scan (packing page)
- Org switch `meesho_settings.auto_flyer_scan` (default ON; Meesho Flyer
  page card, `PUT /api/meesho/auto-flyer-scan`, manager+). Packers get it via
  `GET /api/me` -> `packing.autoFlyerScan`. ON = switch armed at standby, ON
  for Meesho parcels, OFF for other known marketplaces; manual switch only
  for unknown parcels (`flyerToggleState`). OFF = old manual behaviour.
- Companion app (`meesho-linkup-app`, v1.0.4+): re-stores Meesho's
  session-only cookies with a 30-day expiry (persist partition keeps them),
  registers "start with Windows" (`--autostart`, minimized), verifies the
  saved session on launch, re-logins with VMS-stored credentials only when
  expired, opens the login window only for OTP, and resumes Auto-Sync when
  `autoSyncEnabled` was on. Release: tag `meesho-vX.Y.Z` (workflow) and bump
  `MEESHO_LINKUP_VERSION` in server/src/index.ts.

## Public video links
- "Copy public link" (Video Library) -> `POST /api/videos/:id/share`
  (manager+, one live token per video, 256-bit base64url) ->
  `https://<app>/share/<token>`. The SPA route `/share/:token` is outside the
  login layout and calls `GET /api/public/videos/:token` (no auth, 60/min,
  no-store): returns only a 10-min signed URL + tracking/order/marketplace/
  recorded time. `DELETE /api/videos/:id/share` revokes; deleting a video
  cascades its links. Nothing else in VMS is public.

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

## Database Schema (key tables)
- `organizations`, `users`, `organization_members` (role: ADMIN/PACKER)
- `stations` (warehouse + code), `recording_sessions`, `video_assets`
- `marketplace_order_mappings` (tracking_id → order_id + marketplace)
- `marketplace_retention_policies` (video/data retention days per marketplace)
- `marketplace_orders` (Forward Scan copy + manual orders, 3 days, one row per AWB, `is_meesho`, `manual_override`)
- `sku_images` (SKU photo links; `source` = forward-scan | manual | omsguru legacy), `forward_scan_sync_state` (per-org health + photo cursor)
- `omsguru_order_cache`, `omsguru_sku_photos`, `omsguru_poll_state` (legacy, no longer written), `omsguru_settings`
- `audit_logs`, `order_import_batches`

## Deployment
- Hostinger VPS with Traefik + Let's Encrypt
- `docker-compose.hostinger.yml` defines backend (port 8080) + frontend (nginx port 80)
- Domain: `vms.youthnic.shop`
- Backend exposed at `/api/*` and `/health/*`, frontend at `/`
