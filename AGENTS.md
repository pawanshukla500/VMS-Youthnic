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
| `PG_POOL_MAX` | Connection pool size (default 10) |

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
- `ADMIN` = full access; `MANAGER` = everything except user control
  (`/api/admin/users*`) and system settings (retention PUT, wipe,
  station create/delete); `PACKER` = operational pages only.
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

## OMSGuru (server-side only)
- Token + client ID stay on the backend (`OMSGuru_TOKEN`/`OMSGuru_CID`);
  never put them in `VITE_*` (bundles are public, payloads carry buyer
  PII, rate budget is shared). Packing page reads one call:
  `GET /api/order-context/resolve?trackingId=`.
- OMSGuru sync runs automatically 30s after server startup and every 6h
  (override with `OMSGURU_AUTO_SYNC_INTERVAL_HOURS`); the protected
  `POST /api/jobs/omsguru-sync` endpoint remains available for an immediate
  refresh. It refreshes SKU photos + recent order lines and needs
  `OMSGURU_WAREHOUSE_ID` for invoices.
  Creds resolve per-org from `omsguru_settings` (admin UI, rotatable)
  with env fallback; token is masked (`••••1234`) everywhere outside DB.
- Lookup chain: AWB matched in invoices → `sub_order_id` → order details
  → `sku_code` → listing `img_url`. No AWB-direct endpoint exists.
- `order_details?sub_order_id=` does NOT filter reliably (returns
  unrelated/empty sets) — never build on it; scan invoice pages instead.
- Stored trackers often carry courier suffixes (`372329858366 ( ATS )`);
  matching is suffix-tolerant (`trackerMatches`), prefix-only never matches.
- OMSGuru has NO ExtraInfo/FN/EX field — Ajio renames come only from the
  CSV ExtraInfo column; API-side Ajio key is the dotted `channel_sub_order_id`.
- Ajio renders from OMSGuru like every marketplace but is NEVER renamed
  by it (`usesSubOrderIdentity` is Meesho-only); Meesho identity prefers
  the first item `subOrderId`.
- Channel company IDs: Amazon Flex 16778, Flipkart 17040, Meesho 17970,
  Myntra PPMP 18116/51680, Amazon FBA 22475, Ajio Api 59585. Invoices and
  `list_channel_listings` accept `channel_id` to scope queries.
- Resolve (`GET /api/order-context/resolve`) is cache-first: fresh rows
  served as-is; stale/missing rows trigger a bounded live invoice lookup
  (warehouses CSV, ≤3 pages each, ~10-call cap, 8s deadline) with 1h
  negative / 24h positive caching; order and photo cache rows are served
  and retained for 24h; empty photo tables kick a background listings
  bootstrap. Pre-invoice orders carry no tracker — those AWBs can never
  match. Admin can probe with `POST /api/admin/omsguru-test`.

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
- `audit_logs`, `order_import_batches`

## Deployment
- Hostinger VPS with Traefik + Let's Encrypt
- `docker-compose.hostinger.yml` defines backend (port 8080) + frontend (nginx port 80)
- Domain: `vms.youthnic.shop`
- Backend exposed at `/api/*` and `/health/*`, frontend at `/`
