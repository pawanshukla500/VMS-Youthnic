// Bulletproofing tests: a missed CCTV reply risks an Ajio penalty, so the
// fallback, ledger, and alert paths are pinned by unit tests.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { isGrantError, GMAIL_SCOPES } from '../ajio/gmailApi';
import { GmailMailbox } from '../ajio/mailbox';
import { runAjioWfrJob } from '../ajio/processor';
import {
  buildWfrAlert,
  getWfrHealth,
  openRequestAge,
  recordWfrRun,
  runRecordedAjioWfrJob,
  DEFAULT_AJIO_ALERT_EMAIL,
  wfrAlertRecipients,
  wfrAlertsConfigured,
  wfrPublicError,
  wfrSafetyNetHours,
  wfrSlaHours,
  withAjioWfrLock,
} from '../ajio/watchdog';

const ENV_KEYS = [
  'AJIO_GMAIL_OAUTH_CLIENT_ID',
  'AJIO_GMAIL_OAUTH_CLIENT_SECRET',
  'AJIO_GMAIL_ADDRESS',
  'AJIO_GMAIL_APP_PASSWORD',
  'AJIO_GDRIVE_SA_JSON',
  'AJIO_GDRIVE_FOLDER_ID',
];
const savedEnv = new Map<string, string | undefined>();

function setTestEnv() {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.AJIO_GMAIL_OAUTH_CLIENT_ID = 'test-client-id';
  process.env.AJIO_GMAIL_OAUTH_CLIENT_SECRET = 'test-client-secret';
  process.env.AJIO_GMAIL_ADDRESS = 'seller@mailbox.com';
  process.env.AJIO_GMAIL_APP_PASSWORD = 'app-password-1234';
  process.env.AJIO_GDRIVE_SA_JSON = JSON.stringify({ client_email: 'sa@test.iam.gserviceaccount.com', private_key: 'fake-key' });
  process.env.AJIO_GDRIVE_FOLDER_ID = 'folder-1';
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
}

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv();
});

describe('isGrantError', () => {
  it('matches the raw Google code and the translated message', () => {
    expect(isGrantError(new Error('invalid_grant'))).toBe(true);
    expect(isGrantError(new Error('Gmail grant for a@b was rejected by Google (invalid_grant). Open the Ajio page and click Connect Gmail again'))).toBe(true);
  });

  it('rejects unrelated failures', () => {
    expect(isGrantError(new Error('Drive upload failed (HTTP 500)'))).toBe(false);
    expect(isGrantError(null)).toBe(false);
    expect(isGrantError('timeout of 30000ms exceeded')).toBe(false);
  });
});

describe('watchdog env parsing', () => {
  it('clamps SLA and interval into sane ranges', () => {
    expect(wfrSlaHours({} as any)).toBe(12);
    expect(wfrSlaHours({ AJIO_WFR_SLA_HOURS: '0' } as any)).toBe(1);
    expect(wfrSlaHours({ AJIO_WFR_SLA_HOURS: '999' } as any)).toBe(72);
    expect(wfrSafetyNetHours({} as any)).toBe(6);
    expect(wfrSafetyNetHours({ AJIO_WFR_INTERVAL_HOURS: 'abc' } as any)).toBe(6);
    expect(wfrSafetyNetHours({ AJIO_WFR_INTERVAL_HOURS: '48' } as any)).toBe(24);
  });

  it('prefers AJIO_ALERT_EMAILS, falls back to REPORT_TO_EMAILS, drops junk', () => {
    expect(wfrAlertRecipients({ AJIO_ALERT_EMAILS: 'a@x.com, bad', REPORT_TO_EMAILS: 'b@x.com' } as any)).toEqual(['a@x.com']);
    expect(wfrAlertRecipients({ REPORT_TO_EMAILS: 'b@x.com , junk' } as any)).toEqual(['b@x.com']);
    expect(wfrAlertRecipients({} as any)).toEqual([DEFAULT_AJIO_ALERT_EMAIL]);
  });
});

describe('buildWfrAlert', () => {
  const base = { checked: 3, skipped: 0, matched: 2, uploaded: 2, replied: 2, missing: 1, failed: 0, errors: [] as string[], warnings: [] as string[] };

  it('writes a FAILED subject with the error surfaced', () => {
    const { subject, html } = buildWfrAlert({ status: 'failed', trigger: 'cron', summary: base, error: 'boom' });
    expect(subject).toMatch(/FAILED/);
    expect(html).toContain('boom');
    expect(html).toContain('Replied');
  });

  it('calls out fallback coverage on success', () => {
    const { subject, html } = buildWfrAlert({ status: 'success', trigger: 'safety-net', summary: base, usedFallback: true });
    expect(subject).toMatch(/ATTENTION/);
    expect(html).toMatch(/fallback/i);
    expect(html).toMatch(/Reconnect Gmail/);
  });

  it('escapes error text so a weird mail subject cannot break the email', () => {
    const { html } = buildWfrAlert({
      status: 'failed',
      trigger: 'cron',
      summary: { ...base, errors: ['<script>alert(1)</script>'] },
      error: '<b>bold</b>',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>bold</b>');
  });
});

describe('recordWfrRun', () => {
  it('inserts one ledger row with counters and trigger', async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const pool = { query: async (sql: string, params: unknown[] = []) => { seen.push({ sql, params }); return { rows: [] }; } } as any;
    await recordWfrRun(pool, {
      organizationId: 'org-1',
      trigger: 'cron',
      dryRun: false,
      status: 'failed',
      summary: { checked: 5, skipped: 0, matched: 0, uploaded: 0, replied: 0, missing: 0, failed: 5, errors: [], warnings: [] },
      usedFallback: true,
      error: 'invalid_grant',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].sql).toMatch(/INSERT INTO ajio_wfr_runs/);
    expect(seen[0].params).toEqual(['org-1', 'cron', false, 'failed', 5, 0, 0, 5, true, 'invalid_grant']);
  });
});

describe('getWfrHealth', () => {
  it('flags a failed last run plus an SLA-breaching backlog', async () => {
    const old = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('ajio_wfr_runs') && sql.includes("status = 'success'")) return { rows: [] };
        if (sql.includes('ajio_wfr_runs')) {
          return { rows: [{ status: 'failed', trigger: 'cron', error: 'invalid_grant', used_fallback: false, created_at: new Date().toISOString() }] };
        }
        return { rows: [{ count: '2', oldest: old }] };
      },
    } as any;
    const health = await getWfrHealth(pool, 'org-1', {} as any);
    expect(health.lastRunStatus).toBe('failed');
    expect(health.stale).toBe(true);
    expect(health.pendingCount).toBe(2);
    expect(health.oldestPendingHours).toBeGreaterThan(12);
    expect(health.slaBreached).toBe(true);
  });

  it('is quiet on a fresh successful run with nothing open', async () => {
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("status = 'success'")) return { rows: [{ created_at: new Date().toISOString() }] };
        if (sql.includes('ajio_wfr_runs')) {
          return { rows: [{ status: 'success', trigger: 'cron', error: null, used_fallback: false, created_at: new Date().toISOString() }] };
        }
        return { rows: [{ count: '0', oldest: null }] };
      },
    } as any;
    const health = await getWfrHealth(pool, 'org-1', {} as any);
    expect(health.lastRunStatus).toBe('success');
    expect(health.stale).toBe(false);
    expect(health.slaBreached).toBe(false);
  });
});

describe('OAuth -> App Password fallback', () => {
  function orgPool() {
    return {
      query: async (sql: string) => {
        if (sql.includes('ajio_gmail_tokens')) {
          return {
            rows: [{
              email: 'seller@mailbox.com',
              refresh_token: 'dead-grant',
              access_token: null,
              access_expiry: null,
              scopes: GMAIL_SCOPES.join(' '),
            }],
          };
        }
        if (sql.includes('FROM organizations')) return { rows: [{ id: 'org-1' }] };
        return { rows: [] };
      },
    } as any;
  }

  it('covers the run on the fallback when the OAuth grant is dead', async () => {
    setTestEnv();
    vi.spyOn(OAuth2Client.prototype, 'refreshAccessToken').mockRejectedValue(new Error('invalid_grant'));
    const listSpy = vi.spyOn(GmailMailbox.prototype, 'listCctvRequests').mockResolvedValue([]);
    const summary = await runAjioWfrJob(orgPool(), 'org-1', { dryRun: true, limit: 10 });
    expect(listSpy).toHaveBeenCalled();
    expect(summary.usedFallback).toBe(true);
    expect(summary.warnings.join(' ')).toMatch(/App Password/);
  });

  it('fails loudly when no fallback is configured', async () => {
    setTestEnv();
    delete process.env.AJIO_GMAIL_ADDRESS;
    delete process.env.AJIO_GMAIL_APP_PASSWORD;
    vi.spyOn(OAuth2Client.prototype, 'refreshAccessToken').mockRejectedValue(new Error('invalid_grant'));
    await expect(runAjioWfrJob(orgPool(), 'org-1', { dryRun: true, limit: 10 })).rejects.toThrow(/Connect Gmail again/);
  });
});

describe('openRequestAge', () => {
  it('returns zero when nothing is open', async () => {
    const pool = { query: async () => ({ rows: [{ count: '0', oldest: null }] }) } as any;
    await expect(openRequestAge(pool, 'org-1')).resolves.toEqual({ count: 0, oldestHours: null });
  });
});

describe('withAjioWfrLock (one run at a time across cron, safety net, admin)', () => {
  function lockPool(opts: { locked: boolean; unlockFails?: boolean }) {
    const sql: string[] = [];
    const release = vi.fn();
    const client = {
      query: async (text: string) => {
        sql.push(text);
        if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: opts.locked }] };
        if (text.includes('pg_advisory_unlock')) {
          if (opts.unlockFails) throw new Error('connection terminated');
          return { rows: [{ pg_advisory_unlock: true }] };
        }
        return { rows: [] };
      },
      release,
    };
    return { pool: { connect: async () => client } as any, sql, release };
  }

  it('skips without running when another run holds the lock', async () => {
    const { pool, sql, release } = lockPool({ locked: false });
    const fn = vi.fn(async () => 'ran');
    await expect(withAjioWfrLock(pool, fn)).resolves.toEqual({ ran: false });
    expect(fn).not.toHaveBeenCalled();
    expect(sql.some((s) => s.includes('pg_advisory_unlock'))).toBe(false);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it('runs, then unlocks on the same session and returns the connection', async () => {
    const { pool, sql, release } = lockPool({ locked: true });
    await expect(withAjioWfrLock(pool, async () => 42)).resolves.toEqual({ ran: true, value: 42 });
    expect(sql.filter((s) => s.includes('pg_advisory_unlock'))).toHaveLength(1);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it('still unlocks when the job throws', async () => {
    const { pool, sql } = lockPool({ locked: true });
    await expect(withAjioWfrLock(pool, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(sql.some((s) => s.includes('pg_advisory_unlock'))).toBe(true);
  });

  it('destroys the connection when unlock fails so the lock is never stranded in the pool', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { pool, release } = lockPool({ locked: true, unlockFails: true });
    await expect(withAjioWfrLock(pool, async () => 'ok')).resolves.toEqual({ ran: true, value: 'ok' });
    expect(release).toHaveBeenCalledWith(true);
  });
});

describe('wfrPublicError', () => {
  it('maps a dead grant to 503 with a fixed reconnect message (no mailbox address)', () => {
    const out = wfrPublicError(new Error('Gmail grant for seller@mailbox.com was rejected by Google (invalid_grant). Open the Ajio page and click Connect Gmail again'), 'x');
    expect(out.status).toBe(503);
    expect(out.message).toMatch(/Connect Gmail again/);
    expect(out.message).not.toContain('seller@mailbox.com');
  });

  it('keeps missing-config errors as 503 and hides internals as 500', () => {
    expect(wfrPublicError(new Error('Ajio drive is not configured (AJIO_GDRIVE_SA_JSON, AJIO_GDRIVE_FOLDER_ID)'), 'x').status).toBe(503);
    expect(wfrPublicError(new Error('duplicate key value violates unique constraint "x"'), 'Ajio WFR job failed')).toEqual({
      status: 500,
      message: 'Ajio WFR job failed',
    });
  });
});

describe('alert configuration visibility', () => {
  it('needs both a Resend key and a valid recipient', () => {
    expect(wfrAlertsConfigured({} as any)).toBe(false);
    expect(wfrAlertsConfigured({ RESEND_API_KEY: 're_x' } as any)).toBe(true);
    expect(wfrAlertsConfigured({} as any, 'custom@x.com', 're_custom')).toBe(true);
    expect(wfrAlertsConfigured({ RESEND_API_KEY: 're_x', REPORT_TO_EMAILS: 'ops@x.com' } as any)).toBe(true);
    expect(wfrAlertsConfigured({ RESEND_API_KEY: ' ', AJIO_ALERT_EMAILS: 'ops@x.com' } as any)).toBe(false);
  });

  it('health reports alertsConfigured and a sanitized lastError', async () => {
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("status = 'success'")) return { rows: [] };
        if (sql.includes('ajio_wfr_runs')) {
          return { rows: [{ status: 'failed', trigger: 'cron', error: 'Gmail grant for seller@mailbox.com was rejected by Google (invalid_grant). Open the Ajio page and click Connect Gmail again', used_fallback: false, created_at: new Date().toISOString() }] };
        }
        return { rows: [{ count: '0', oldest: null }] };
      },
    } as any;
    const health = await getWfrHealth(pool, 'org-1', {} as any);
    expect(health.alertsConfigured).toBe(false);
    expect(health.lastError).toMatch(/Connect Gmail again/);
    expect(health.lastError).not.toContain('seller@mailbox.com');
  });
});

describe('runRecordedAjioWfrJob', () => {
  function ledgerPool(extra: (sql: string) => { rows: unknown[] } | null = () => null) {
    const inserts: unknown[][] = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO ajio_wfr_runs')) {
          inserts.push(params);
          return { rows: [] };
        }
        const hit = extra(sql);
        if (hit) return hit;
        if (sql.includes('FROM ajio_wfr_requests')) return { rows: [{ count: '0', oldest: null }] };
        return { rows: [] };
      },
    } as any;
    return { pool, inserts };
  }

  it('records a failed run, alerts, and rethrows', async () => {
    setTestEnv();
    delete process.env.AJIO_GDRIVE_SA_JSON;
    const { pool, inserts } = ledgerPool();
    const alert = vi.fn(async () => undefined);
    await expect(runRecordedAjioWfrJob(pool, { organizationId: 'org-1', trigger: 'cron', alert })).rejects.toThrow(/not configured/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0][3]).toBe('failed');
    expect(alert).toHaveBeenCalledTimes(1);
    expect((alert.mock.calls[0] as any)[0].subject).toMatch(/FAILED/);
  });

  it('never alerts for a dry run, and survives alerts being unconfigured', async () => {
    setTestEnv();
    delete process.env.AJIO_GDRIVE_SA_JSON;
    const { pool, inserts } = ledgerPool();
    const alert = vi.fn(async () => undefined);
    await expect(runRecordedAjioWfrJob(pool, { organizationId: 'org-1', trigger: 'admin', dryRun: true, alert })).rejects.toThrow();
    expect(alert).not.toHaveBeenCalled();
    await expect(runRecordedAjioWfrJob(pool, { organizationId: 'org-1', trigger: 'cron', alert: null })).rejects.toThrow();
    expect(inserts).toHaveLength(2);
  });

  it('a failing alert send never breaks a fallback-covered run', async () => {
    setTestEnv();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(OAuth2Client.prototype, 'refreshAccessToken').mockRejectedValue(new Error('invalid_grant'));
    vi.spyOn(GmailMailbox.prototype, 'listCctvRequests').mockResolvedValue([]);
    const { pool, inserts } = ledgerPool((sql) => {
      if (sql.includes('ajio_gmail_tokens')) {
        return { rows: [{ email: 'seller@mailbox.com', refresh_token: 'dead-grant', access_token: null, access_expiry: null, scopes: GMAIL_SCOPES.join(' ') }] };
      }
      return null;
    });
    const alert = vi.fn(async () => { throw new Error('Resend down'); });
    const recorded = await runRecordedAjioWfrJob(pool, { organizationId: 'org-1', trigger: 'safety-net', alert });
    expect(recorded.status).toBe('success');
    expect(recorded.usedFallback).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(recorded.alertSent).toBe(false);
    expect(inserts[0][8]).toBe(true); // used_fallback recorded
  });
});

describe('WFR replies are never sent twice', () => {
  const MAIL = {
    uid: '101',
    messageId: '<m1@ajio.com>',
    subject: 'CCTV FOOTAGE REQUIRED||INC00112744229||RT228723195||DV00352060',
    from: 'seller.communication@ajio.com',
    toAddrs: ['seller@mailbox.com'],
    ccAddrs: [],
    date: null,
    bodyText: `Incident ID: INC00112744229 Order ID: FN8482808184 Variant: 701963821019 Complaint Type: Wrong Return Reference Value:
RT228723195 Shipment ID: 1241686367 Packing Time:
09-03-2026
11:09:22`,
  };

  function appPasswordOnlyEnv() {
    setTestEnv();
    delete process.env.AJIO_GMAIL_OAUTH_CLIENT_ID;
    delete process.env.AJIO_GMAIL_OAUTH_CLIENT_SECRET;
  }

  it('skips an incident another run finished between the check and the claim', async () => {
    appPasswordOnlyEnv();
    vi.spyOn(GmailMailbox.prototype, 'listCctvRequests').mockResolvedValue([MAIL]);
    const replySpy = vi.spyOn(GmailMailbox.prototype, 'replyAll').mockResolvedValue(null);
    const seen: string[] = [];
    const pool = {
      query: async (sql: string) => {
        seen.push(sql);
        // Seen as a retryable 'failed' row with a reusable Drive link...
        if (sql.includes('SELECT id, status, drive_link, drive_file_id FROM ajio_wfr_requests')) {
          return { rows: [{ id: 'w1', status: 'failed', drive_link: 'https://drive.google.com/file/d/f1/view', drive_file_id: 'f1' }] };
        }
        // ...with a matching video, so only the claim guard stands between
        // this run and a second reply.
        if (sql.includes('FROM recording_sessions')) {
          return { rows: [{ id: 'rs-1', tracking_id: 'RT228723195', order_id: 'FN8482808184', marketplace: 'Ajio', created_at: new Date().toISOString(), has_video: true, storage_path: 'packing-videos/org-1/a.mp4' }] };
        }
        // Claim upsert hits a row that went 'done' meanwhile: the guarded
        // DO UPDATE matches nothing, RETURNING is empty.
        return { rows: [] };
      },
    } as any;
    const summary = await runAjioWfrJob(pool, 'org-1', { limit: 5 });
    expect(replySpy).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(summary.replied).toBe(0);
    const claim = seen.find((s) => s.includes('INSERT INTO ajio_wfr_requests (organization_id, incident_id, order_id'));
    expect(claim).toMatch(/WHERE ajio_wfr_requests\.status <> 'done'/);
    expect(claim).toMatch(/RETURNING id/);
  });

  it("records 'done' (never 'failed') when the reply went out but its bookkeeping failed", async () => {
    appPasswordOnlyEnv();
    vi.spyOn(GmailMailbox.prototype, 'listCctvRequests').mockResolvedValue([MAIL]);
    const replySpy = vi.spyOn(GmailMailbox.prototype, 'replyAll').mockResolvedValue({
      providerMessageId: '<r1@mailbox.com>', threadId: null, toAddrs: ['seller.communication@ajio.com'], subject: 'Re: x', sentAt: new Date(),
    });
    vi.spyOn(GmailMailbox.prototype, 'markReplied').mockResolvedValue(undefined);
    const fallbackWrites: unknown[][] = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('SELECT id, status, drive_link, drive_file_id FROM ajio_wfr_requests')) {
          // Earlier attempt already uploaded: reuse the link, no Storage/Drive.
          return { rows: [{ id: 'w1', status: 'failed', drive_link: 'https://drive.google.com/file/d/f1/view', drive_file_id: 'f1' }] };
        }
        if (sql.includes('INSERT INTO ajio_wfr_requests (organization_id, incident_id, order_id')) return { rows: [{ id: 'w1' }] };
        if (sql.includes('FROM recording_sessions')) {
          return { rows: [{ id: 'rs-1', tracking_id: 'RT228723195', order_id: 'FN8482808184', marketplace: 'Ajio', created_at: new Date().toISOString(), has_video: true, storage_path: 'packing-videos/org-1/a.mp4' }] };
        }
        if (sql.includes("SET status = 'done', recording_session_id")) throw new Error('connection reset');
        if (sql.includes('INSERT INTO ajio_wfr_requests (organization_id, incident_id, status, error')) {
          fallbackWrites.push(params);
          expect(sql).toMatch(/WHERE ajio_wfr_requests\.status <> 'done'/);
          return { rows: [] };
        }
        return { rows: [] };
      },
    } as any;
    const summary = await runAjioWfrJob(pool, 'org-1', { limit: 5 });
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(fallbackWrites).toHaveLength(1);
    expect(fallbackWrites[0][2]).toBe('done');
    expect(String(fallbackWrites[0][3])).toMatch(/Reply sent/);
    expect(fallbackWrites[0][4]).toBeInstanceOf(Date);
    expect(summary.failed).toBe(1);
  });
});
