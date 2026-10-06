#!/usr/bin/env bash
# Nightly Ajio WFR trigger — runs ON the Hostinger VPS (host cron entry in
# /etc/cron.d/pvms-ajio-wfr, both installed by the deploy workflow), hitting
# the backend container over the Docker network. GitHub Actions is NOT
# involved in the scheduled runs (that workflow is manual-dispatch only).
# Limit 25 per tick: wide enough to drain a backlog after an outage, small
# enough to stay inside Gmail/Drive rate budgets (the safety net uses 50).
set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

LOG_FILE="/opt/pvms/ajio-wfr-cron.log"

# Writes the log file itself (stdout too, for hand runs); the cron entry
# sends stdout to /dev/null so lines are not logged twice.
log() {
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') ajio-wfr: $*" | tee -a "$LOG_FILE"
}

CID="$(docker ps -q --filter 'label=com.docker.compose.service=backend' --filter 'label=com.docker.compose.project=app' 2>/dev/null | head -n 1)"
if [ -z "$CID" ]; then
  log "ERROR backend container not running"
  exit 1
fi

# The secret is read INSIDE the container (compose passes AJIO_WFR_SECRET
# from /opt/pvms/app/.env) — never on the host command line, where `ps`
# would show it to every local user. HTTP 409 = another run (safety net or
# admin button) holds the lock and is covering this tick: a skip, not a
# failure.
JS='const s=process.env.AJIO_WFR_SECRET||"";if(!s){console.error("AJIO_WFR_SECRET missing in the backend container env");process.exit(1)}fetch("http://127.0.0.1:8080/api/jobs/ajio-wfr?limit=25",{method:"POST",headers:{"Content-Type":"application/json","x-cron-secret":s},body:"{}",signal:AbortSignal.timeout(280000)}).then(async(r)=>{const t=await r.text();console.log("HTTP "+r.status+" "+t.slice(0,2000));process.exit(r.status===200||r.status===409?0:1)}).catch((e)=>{console.error("trigger failed: "+((e&&e.message)||e));process.exit(1)})'

OUT="$(docker exec "$CID" node --eval "$JS" 2>&1)"
CODE=$?
log "$OUT"
if [ "$CODE" -ne 0 ]; then
  log "ERROR job failed (exit $CODE)"
fi

# Keep the log bounded (~last 2000 lines).
tail -n 2000 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE"
exit "$CODE"
