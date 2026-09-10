# PVMS Deployment Notes

## 5-7 Packing PCs

The current architecture is suitable for 5-7 packing PCs because recording, watermarking, and temporary IndexedDB storage happen in the browser. Firebase Storage receives the video file directly from each PC. The backend mostly stores metadata, order mappings, reports, and download authorization.

Recommended backend settings:

```env
PG_POOL_MAX=10
AUTO_PROVISION_USERS=false
```

Keep upload queue retry/backoff enabled on the client. Do not proxy video uploads through the backend unless there is a compliance reason; that would increase server CPU and bandwidth cost.

## Postgres SSL

Production should not use plain Postgres over the public internet.

If Postgres is on the same Hostinger VPS Docker network as the backend, do not expose port `5432` publicly. In that case SSL is less important than keeping database traffic private inside the server.

The backend joins the shared `shared_infra` Docker network and reaches
Postgres by container name, so `DATABASE_URL` must use the internal host
(e.g. `postgresql://user:password@postgres:5432/dbname`). Never point it at
an ephemeral published host port (e.g. `:32774`) — the mapping vanishes when
the Postgres container is recreated and the backend then crash-loops at boot
(healthy old pools can mask this for hours, so the outage only surfaces on
the next deploy). As a safety net, the deploy workflow itself rewrites a
stale `srv*.hstgr.cloud` ephemeral-port host to `postgres:5432` (credentials
pass through byte-identical) and logs which path it took.

If Cloud Run or another external host connects to Hostinger Postgres, enable SSL on Postgres first and set:

```env
PGSSL_MODE=require
```

Stronger option with CA verification:

```env
PGSSL_MODE=verify-full
PGSSL_CA_CERT_PATH=/run/secrets/postgres-ca.crt
```

Do not use `PGSSL_MODE=disable` in production when database traffic crosses the internet.

## Cloud Run Cost Guardrails

To keep Cloud Run under control:

```bash
gcloud run deploy pvms-api \
  --source server \
  --region asia-south1 \
  --cpu 1 \
  --memory 512Mi \
  --concurrency 80 \
  --min-instances 0 \
  --max-instances 2 \
  --no-cpu-throttling=false
```

Use request-based billing, `min-instances=0`, and avoid background CPU work. Keep video uploads direct to Firebase Storage. Use a scheduled HTTP job only for lightweight metadata reconciliation.

Set a Google Cloud budget alert at `$5`, `$8`, and `$10`.

## Hostinger VPS Docker Path

This repo includes:

- `server/Dockerfile`
- `client/Dockerfile`
- `docker-compose.hostinger.yml`
- `caddy/Caddyfile`
- `.github/workflows/deploy-hostinger.yml`

Only Caddy exposes public ports `80` and `443`. Backend and frontend stay private inside Docker. Caddy provides HTTPS, which production camera access requires.

GitHub Actions secrets needed:

```text
HOSTINGER_HOST
HOSTINGER_PORT
HOSTINGER_USER
HOSTINGER_SSH_KEY
HOSTINGER_ENV_FILE
```

`HOSTINGER_ENV_FILE` should contain the full production `.env`, for example:

```env
APP_DOMAIN=your-domain.com
VITE_API_URL=https://your-domain.com
VITE_ORG_ID=default
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_FIREBASE_MEASUREMENT_ID=...
DATABASE_URL=postgresql://user:password@host:5432/dbname
PGSSL_MODE=require
FIREBASE_SERVICE_ACCOUNT_JSON=...
FIREBASE_STORAGE_BUCKET=...
ALLOWED_ORIGINS=https://your-domain.com
ORDER_RECONCILE_SECRET=...
PG_POOL_MAX=10
```

On the VPS, install Docker and the compose plugin once. After that, pushes to `main` deploy automatically.

## Daily packing report email

Set these secrets (or add to `HOSTINGER_ENV_FILE`):

```text
RESEND_API_KEY
REPORT_FROM_EMAIL   # e.g. PVMS Daily Report <reports@pkvm.youthnic.shop>
REPORT_TO_EMAILS    # comma-separated, e.g. admin@youthnic.shop,manager@youthnic.shop
REPORT_JOB_SECRET
```

Verify the sender domain in Resend first, otherwise delivery fails. Then
schedule the job (example: every day 20:00 IST) from any cron host:

```bash
curl -X POST "https://your-domain.com/api/jobs/daily-report" \
  -H "x-report-secret: $REPORT_JOB_SECRET"
```

Test without sending first: append `?dryRun=1` (add `?date=YYYY-MM-DD` to
re-run a past IST day).

## Ajio WFR CCTV replies (daily 1 AM IST)

Reads `seller.communication@ajio.com` CCTV mails, matches each order to its
packing video, uploads the video to the shared Google Drive folder as
`<ORDER_ID>.mp4`, and replies on the thread with the Drive link + template.
Missing videos are recorded, never fabricated. Needs secrets (or
`HOSTINGER_ENV_FILE`):

```text
AJIO_WFR_SECRET
AJIO_GMAIL_ADDRESS
AJIO_GMAIL_APP_PASSWORD
AJIO_GDRIVE_SA_JSON
AJIO_GDRIVE_FOLDER_ID
```

Schedule daily 1 AM IST from any cron host:

```bash
TZ=Asia/Kolkata 0 1 * * * curl -X POST "https://your-domain.com/api/jobs/ajio-wfr" \
  -H "x-cron-secret: $AJIO_WFR_SECRET"
```

Dry run first (parses + matches, uploads nothing, replies to nothing):

```bash
curl -X POST "https://your-domain.com/api/jobs/ajio-wfr?dryRun=1&limit=5" \
  -H "x-cron-secret: $AJIO_WFR_SECRET"
```

## Import retention purge (keeps SQL lean)

Raw upload bytes are nulled right after each import, but mapping rows and
audit logs accumulate. Run nightly after the reconcile job:

```bash
curl -X POST "https://your-domain.com/api/jobs/retention-purge" \
  -H "x-cron-secret: $ORDER_RECONCILE_SECRET"
```

Tune with `MAPPING_RETENTION_DAYS` (default 30) and `AUDIT_RETENTION_DAYS`
(default 90). Preview with `?dryRun=1`.

## OMSGuru cache sync (packing photos + order lines)

Secrets (or `HOSTINGER_ENV_FILE`):

```text
OMSGURU_TOKEN
OMSGURU_CID
OMSGURU_WAREHOUSE_ID
```

The server starts a 30-second warm-up automatically. A lightweight invoice and
open-order-status poll runs every 5 minutes for new tracking IDs, while the full SKU-photo/order
refresh runs every 6 hours. The local order and image cache is intentionally
retained for 24 hours; invoices cover the last 3 days. No operator action is required.
The admin button remains available for an immediate manual refresh:

```bash
curl -X POST "https://your-domain.com/api/jobs/omsguru-sync" \
  -H "x-cron-secret: $ORDER_RECONCILE_SECRET"
```

## Postgres backups (do this on the VPS)

Nothing backs up the database today — a lost VPS disk loses all metadata
(video files survive in Firebase Storage). Run nightly:

```bash
# Nightly pg_dump (keeps 7 days). Run on the VPS via cron:
docker exec <postgres-container> pg_dump -U <user> <dbname> | gzip > /opt/pvms/backups/pvms-$(date +%F).sql.gz
find /opt/pvms/backups -name 'pvms-*.sql.gz' -mtime +7 -delete
```

Copy `/opt/pvms/backups` off the VPS weekly (scp/rsync to an office PC or
object storage). Restore drill quarterly on a scratch database.

## Desktop packing app (Windows installer)

Packing PCs can install the PVMS Packing Station desktop app instead of using
Chrome: identical packing + upload-queue screens, every finished video ALSO
saved to local disk, uploads continue in the background (closing the window
hides to tray), and the app auto-starts with Windows and self-updates.

- The packing page header has a small "Desktop App" download button (hidden
  inside the app itself). It mints a single-use ticket (login required) and
  navigates to it — the server answers with a 302 to the fast Firebase
  Storage CDN, so the browser streams the 130MB file with normal progress.
  Only signed-in staff can mint tickets; the installer itself carries no
  secrets.
- Release: bump `client/package.json` version, then run the `Release desktop
  app` workflow (or push a `desktop-v*` tag). It packages the per-user NSIS
  installer with production `VITE_*` secrets baked in, publishes the `.exe` +
  `latest.yml` (+ `.blockmap`) to Firebase Storage `desktop-releases/`
  (public-read, fast CDN — the primary download path) plus a GitHub Release
  backup, and copies them to `/opt/pvms/downloads` on the VPS (bind-mounted
  into the backend at `/app/downloads`; deliberately outside `/opt/pvms/app`,
  which every deploy wipes, so redeploys keep it; the VPS copy is the
  fallback if the CDN is ever unreachable).
- In-app auto-update polls the Firebase Storage download base
  (`DESKTOP_PUBLISH_URL` baked at package time, e.g.
  `https://storage.googleapis.com/<bucket>/desktop-releases/`). Any web change (including
  layout) reaches installed stations ONLY through a new desktop release: the
  installer bundles the web build, so deploying the website alone never
  updates installed apps. Release flow: bump version → run the workflow →
  stations update silently and install on quit (tray tooltip shows the
  installed version).
- Local dev: `npm run electron:build` once, then `npm run electron:dev`
  (starts Vite + Electron against `http://127.0.0.1:5173/packing`).
- IMPORTANT: release builds MUST have a real `VITE_API_URL` (public backend
  origin) + `VITE_FIREBASE_*` baked in — the packaged app has no page origin
  to fall back to, so empty values show "Server unreachable" on login.
- Manual publish (no CI): run `npm run dist` with prod env set, then copy
  `client/release/*.{exe,yml,blockmap}` to the VPS `downloads/` dir.
- The installer is per-user (no admin rights needed on packing PCs). The
  first SmartScreen warning is expected until a code-signing cert is added.
