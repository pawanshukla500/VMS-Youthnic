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

The server starts a 30-second warm-up automatically. A lightweight invoice
poll runs every 2 minutes for new tracking IDs, while the full SKU-photo/order
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
