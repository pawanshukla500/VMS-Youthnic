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
AJIO_GMAIL_OAUTH_CLIENT_ID
AJIO_GMAIL_OAUTH_CLIENT_SECRET
AJIO_TEST_SENDERS
AJIO_GDRIVE_SA_JSON
AJIO_GDRIVE_FOLDER_ID
AJIO_ALERT_EMAILS        # failure/SLA alerts; falls back to REPORT_TO_EMAILS
AJIO_WFR_INTERVAL_HOURS  # safety-net sweep, default 6
AJIO_WFR_SLA_HOURS       # open-request escalation age, default 12
```

Mailbox auth is one-click OAuth on the Ajio page (admin → Connect Gmail,
Internal client — no expiry); the App Password stays as fallback.
The client requests the single `gmail.modify` scope (read + send +
mark-as-read); keep it listed under Data Access, and after any scope change
Disconnect + Connect Gmail again on the Ajio page to re-consent.

How a CCTV mail can never go unanswered (four layers):

1. **VPS host cron, 4x daily** (01:00 / 07:00 / 13:00 / 19:00 IST; the
   entries are UTC, so the VPS clock must stay UTC — the deploy log prints
   it) — owned by the VPS itself, not GitHub Actions. The deploy workflow
   installs `/opt/pvms/ajio-wfr-cron.sh` plus `/etc/cron.d/pvms-ajio-wfr`
   (sources: `scripts/vps/`) on every release (plain overwrite, safe to
   re-run); the script hits the backend container over the Docker network
   (limit 25, secret read from the container env) and logs to
   `/opt/pvms/ajio-wfr-cron.log`. The `Ajio WFR manual run` GitHub workflow
   stays for hand-triggered dry runs only and has no schedule trigger.
2. **In-process safety net** — the backend sweeps every
   `AJIO_WFR_INTERVAL_HOURS` on its own (limit 50) and stands down whenever
   any trigger recently succeeded. A dead cron daemon alone can no longer
   skip a day. Cron, safety net and the admin Run button share one Postgres
   advisory lock: a second run while one is active gets HTTP 409 (the cron
   script logs it as a skip), and a replied (`done`) incident is never
   reopened, so a WFR reply cannot go out twice.
3. **Automatic transport fallback** — if the OAuth grant dies mid-run, the
   job transparently re-runs that org over the App Password transport (IMAP
   read + SMTP reply) instead of failing, and flags `usedFallback` so the
   run still alerts. Keep `AJIO_GMAIL_ADDRESS` + `AJIO_GMAIL_APP_PASSWORD`
   set — they are the spare tyre.
4. **Loud alerting + run ledger** — every invocation lands in
   `ajio_wfr_runs`. Any FAILED run, any fallback run, and any open request
   older than `AJIO_WFR_SLA_HOURS` emails `AJIO_ALERT_EMAILS` (else
   `REPORT_TO_EMAILS`) via Resend immediately. Quiet otherwise. Without
   `RESEND_API_KEY` or a valid recipient, alerts are OFF: the backend logs a
   startup warning and the Ajio page says so. The Ajio page shows a health
   banner (last run, failures, stale grant) from
   `GET /api/admin/ajio-wfr/health`.

Equivalent manual cron from any host:

```bash
TZ=Asia/Kolkata 0 1 * * * curl -X POST "https://your-domain.com/api/jobs/ajio-wfr" \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: $AJIO_WFR_SECRET" \
  -d '{}'
```

Dry run first (parses + matches, uploads nothing, replies to nothing):

```bash
curl -X POST "https://your-domain.com/api/jobs/ajio-wfr?dryRun=1&limit=5" \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: $AJIO_WFR_SECRET" \
  -d '{}'
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

## Order data from Forward Scan (packing marketplace, SKUs, photos)

VMS no longer calls the OMSGuru API for orders. Forward Scan
(`scan.youthnic.shop`) runs on the same VPS and already syncs OMSGuru, so
the backend copies its database instead — zero OMSGuru credits used by VMS.

`docker-compose.hostinger.yml` mounts Forward Scan's data dir
(`/opt/forward-scan/Forward-Scan/data`) at `/forward-scan-data` and defaults
`FORWARD_SCAN_DATABASE_URL` to `sqlite:////forward-scan-data/omsguru_forward_scan.db`,
so nothing has to be configured. Optional overrides (secrets or
`HOSTINGER_ENV_FILE`): `FORWARD_SCAN_DATABASE_URL` (e.g. a `postgresql://`
URL if Forward Scan moves to Postgres), `FORWARD_SCAN_RETENTION_DAYS` (3),
`FORWARD_SCAN_SYNC_INTERVAL_SECONDS` (120), `FORWARD_SCAN_ORG_IDS` (the org
UUID that owns the Forward Scan orders — required once more than one
organization is active, otherwise the copy stays off for safety).

Forward Scan keeps its backups inside the mounted `data/` folder; set its
`BACKUP_MIRROR_DIR` to an off-host location so a VMS compromise can never
reach the only backup copy.

The copy starts 15 s after boot, repeats every 2 minutes, keeps the last 3
days marketplace-wise and purges older rows. Health and per-marketplace
counts: **Synced Orders** page (or `GET /api/admin/forward-scan/status`).
Immediate copy (the old `omsguru-sync` path is an alias):

```bash
curl -X POST "https://your-domain.com/api/jobs/forward-scan-sync" \
  -H "x-cron-secret: $ORDER_RECONCILE_SECRET"
```

`OMSGURU_TOKEN` / `OMSGURU_CID` are now only used by the admin
"Test connection" button.

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
