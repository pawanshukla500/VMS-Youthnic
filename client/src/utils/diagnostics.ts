// On-device diagnostics for the Settings page log terminal.
//
// Why this exists: packing PCs fail uploads in ways the admin cannot see
// (wrong API base baked into the build, backend unreachable, Firebase
// misconfigured, records stuck failed). This collects everything into one
// copyable log so the failure reason is visible without devtools.
//
// Firebase/videoQueue modules are imported lazily so this file stays
// side-effect free and unit-testable in node.

import { getApiBaseUrl } from './apiBase';

export type DiagnosticLevel = 'info' | 'ok' | 'warn' | 'fail';

export interface DiagnosticLine {
  time: string;
  level: DiagnosticLevel;
  message: string;
}

export interface QueueSummary {
  total: number;
  pending: number;
  uploading: number;
  failed: number;
  completed: number;
}

export function nowTime(): string {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

export function formatDiagnosticLine(line: DiagnosticLine): string {
  return `[${line.time}] ${line.level.toUpperCase().padEnd(4)} ${line.message}`;
}

export function summarizeQueue(records: Array<{ status?: string }>): QueueSummary {
  const summary: QueueSummary = { total: records.length, pending: 0, uploading: 0, failed: 0, completed: 0 };
  for (const record of records) {
    const status = String(record?.status || 'pending');
    if (status === 'pending') summary.pending += 1;
    else if (status === 'uploading') summary.uploading += 1;
    else if (status === 'failed') summary.failed += 1;
    else if (status === 'completed') summary.completed += 1;
    else summary.pending += 1;
  }
  return summary;
}

export function buildDiagnosticReport(lines: DiagnosticLine[]): string {
  const header = `VMS diagnostics ${new Date().toISOString()}`;
  return [header, ...lines.map(formatDiagnosticLine)].join('\n');
}

async function timedFetch(url: string, timeoutMs = 10000): Promise<{ ok: boolean; status: number; ms: number; body: string }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, ms: Date.now() - started, body: body.slice(0, 200) };
  } finally {
    window.clearTimeout(timer);
  }
}

export async function runDiagnostics(): Promise<DiagnosticLine[]> {
  const lines: DiagnosticLine[] = [];
  const push = (level: DiagnosticLevel, message: string) => {
    lines.push({ time: nowTime(), level, message });
  };

  // 1. Environment: what backend will this build talk to?
  const apiBase = getApiBaseUrl();
  push('info', `API base in use: ${apiBase}`);
  push('info', `Page origin: ${window.location.origin}`);
  push(navigator.onLine ? 'ok' : 'fail', `Browser online: ${navigator.onLine}`);
  push('info', `User agent: ${navigator.userAgent}`);

  // 2. Firebase client config presence (booleans only, never secret values).
  const env = (import.meta as any)?.env || {};
  const present = (v: unknown) => Boolean(typeof v === 'string' && v.trim());
  push(present(env.VITE_FIREBASE_API_KEY) ? 'ok' : 'fail', `Firebase apiKey configured: ${present(env.VITE_FIREBASE_API_KEY)}`);
  push(present(env.VITE_FIREBASE_PROJECT_ID) ? 'ok' : 'fail', `Firebase projectId configured: ${present(env.VITE_FIREBASE_PROJECT_ID)}`);
  push(present(env.VITE_FIREBASE_STORAGE_BUCKET) ? 'ok' : 'fail', `Firebase storageBucket configured: ${present(env.VITE_FIREBASE_STORAGE_BUCKET)}`);

  // 3. Auth state (lazy import keeps this module side-effect free for tests).
  try {
    const { auth } = await import('./firebase');
    await auth.authStateReady().catch(() => undefined);
    const user = auth.currentUser;
    push(user ? 'ok' : 'fail', user ? `Firebase user signed in: ${user.email || user.uid}` : 'Firebase user: NOT signed in');
  } catch (err) {
    push('fail', `Firebase init/auth check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Backend reachability (no auth needed for health endpoints).
  for (const path of ['/health/live', '/health/ready']) {
    try {
      const res = await timedFetch(`${apiBase}${path}`);
      push(res.ok ? 'ok' : 'fail', `GET ${path} -> HTTP ${res.status} in ${res.ms}ms${res.ok ? '' : ` body=${res.body}`}`);
    } catch (err) {
      push('fail', `GET ${path} -> unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 5. Local upload queue from IndexedDB, including exact failure reasons.
  try {
    const { getAllRecordings } = await import('./videoQueue');
    const records = await getAllRecordings();
    const summary = summarizeQueue(records);
    push(summary.failed === 0 ? 'ok' : 'warn',
      `Upload queue: total=${summary.total} pending=${summary.pending} uploading=${summary.uploading} failed=${summary.failed}`);
    const failed = records
      .filter((r: any) => r?.status === 'failed')
      .sort((a: any, b: any) => (b?.timestamp || 0) - (a?.timestamp || 0))
      .slice(0, 10);
    for (const record of failed) {
      push('fail', `failed id=${String(record.id).slice(0, 8)} tracking=${record.trackingId || 'UNKNOWN'} retries=${record.retryCount || 0} error=${String(record.error || 'unknown').slice(0, 300)}`);
    }
    if (summary.failed > failed.length) {
      push('warn', `...and ${summary.failed - failed.length} more failed records (see Upload Queue page)`);
    }
  } catch (err) {
    push('fail', `Upload queue read failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 6. Browser storage headroom (recordings pile up when uploads stall).
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      const quota = est.quota || 0;
      const usage = est.usage || 0;
      const freeMb = Math.max(0, Math.round((quota - usage) / 1024 / 1024));
      push(freeMb < 500 ? 'warn' : 'ok', `Browser storage free: ~${freeMb}MB (quota=${Math.round(quota / 1024 / 1024)}MB)`);
    } else {
      push('warn', 'Browser storage estimate unavailable');
    }
  } catch (err) {
    push('warn', `Storage estimate failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return lines;
}
