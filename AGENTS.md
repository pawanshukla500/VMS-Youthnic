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