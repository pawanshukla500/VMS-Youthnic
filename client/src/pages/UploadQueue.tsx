import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  getAllRecordings,
  countOverdue,
  retryRecording,
  reviveRecording,
  RETRY_ATTENTION_THRESHOLD,
} from '../utils/videoQueue';
import { acquireUploadWorker, releaseUploadWorker } from '../utils/uploadWorkerHost';
import { useAuth } from '../context/AuthContext';
import { filterOwnedUploadRecords, filterUnscopedUserUploadRecords, getScopedUploadRecords, getUploadIdentityScopeKey, isUploadScopeCurrent } from '../utils/uploadOwnership';
import { isAdminRole } from '../utils/roles';
import AdminUploadQueuePanel from '../components/AdminUploadQueuePanel';
import { PageHeader, Card, StatusBadge, EmptyState } from '../components/ui';
import toast from 'react-hot-toast';

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

type Recording = {
  id: string;
  trackingId: string;
  status: 'pending' | 'uploading' | 'completed' | 'failed';
  retryCount: number;
  uploadProgress: number;
  blob: Blob;
  timestamp: number;
  duration: number;
  stationId?: string;
  packerId?: string;
  organizationId?: string;
  orderId?: string;
  marketplace?: string;
  error?: string;
};

const POLL_INTERVAL_MS = 3000;

export default function UploadQueue() {
  const { currentUser, organizationId, role } = useAuth();
  const identity = { email: currentUser?.email, organizationId };
  const identityScopeKey = getUploadIdentityScopeKey(currentUser?.uid, identity);
  const identityScopeRef = useRef(identityScopeKey);
  identityScopeRef.current = identityScopeKey;
  const [recordingsData, setRecordingsData] = useState<Recording[]>([]);
  const [unscopedRecordingsData, setUnscopedRecordingsData] = useState<Recording[]>([]);
  const [queueScopeKey, setQueueScopeKey] = useState('');
  const recordings = getScopedUploadRecords(recordingsData, queueScopeKey, identityScopeKey);
  const unscopedRecordings = getScopedUploadRecords(unscopedRecordingsData, queueScopeKey, identityScopeKey);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'active' | 'failed' | 'completed'>('all');
  const [search, setSearch] = useState('');
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [kicking, setKicking] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const setQueueRowsForIdentity = (
    localRows: Recording[],
    userId: string | null | undefined,
    uploadIdentity: { email?: string | null; organizationId?: string | null },
  ) => {
    setRecordingsData(filterOwnedUploadRecords(localRows, uploadIdentity).sort((a, b) => b.timestamp - a.timestamp));
    setUnscopedRecordingsData(
      filterUnscopedUserUploadRecords(localRows, { email: uploadIdentity.email })
        .filter((record) => record.status !== 'completed')
        .sort((a, b) => b.timestamp - a.timestamp),
    );
    setQueueScopeKey(getUploadIdentityScopeKey(userId, uploadIdentity));
  };

  // Keep the same upload worker draining while the operator watches this
  // page (previously uploads paused the moment Packing Station unmounted).
  // Progress events refresh the table live; auth failures refresh the token.
  useEffect(() => {
    if (!currentUser) {
      setRecordingsData([]);
      setUnscopedRecordingsData([]);
      setQueueScopeKey('');
      return;
    }
    let cancelled = false;
    const scopeKey = identityScopeKey;
    const refreshTable = () => {
      void getAllRecordings().then((recs) => {
        if (cancelled || !isUploadScopeCurrent(identityScopeRef.current, scopeKey)) return;
        setQueueRowsForIdentity(recs as Recording[], currentUser.uid, identity);
      });
    };
    const onWorkerMessage = (e: MessageEvent) => {
      const type = (e as MessageEvent & { data?: { type?: string } }).data?.type;
      if (type === 'UPLOAD_SUCCESS' || type === 'UPLOAD_ERROR' || type === 'UPLOAD_PROGRESS') refreshTable();
    };
    const worker = acquireUploadWorker(onWorkerMessage);
    workerRef.current = worker;
    refreshTable();
    return () => {
      cancelled = true;
      releaseUploadWorker(onWorkerMessage);
      if (workerRef.current === worker) workerRef.current = null;
    };
  }, [currentUser, organizationId, identityScopeKey]);



  // Page Visibility aware polling: pause refresh while the tab is hidden so
  // an idle packing PC doesn't burn battery waking up IDB every 3 s.
  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    let onVisible = () => {};

    const scopeKey = identityScopeKey;
    const loadIdentity = identity;
    const loadQueue = async () => {
      const localRows = (await getAllRecordings()) as Recording[];
      if (cancelled || !isUploadScopeCurrent(identityScopeRef.current, scopeKey)) return;
      setQueueRowsForIdentity(localRows, currentUser?.uid, loadIdentity);
      setIsLoading(false);
    };

    const start = () => {
      if (interval != null) return;
      void loadQueue();
      interval = setInterval(loadQueue, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (interval != null) {
        clearInterval(interval);
        interval = null;
      }
    };
    onVisible = () => {
      if (document.hidden) {
        stop();
      } else {
        start();
      }
    };
    start();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [identityScopeKey]);

  // Derived stats
  const stats = useMemo(() => {
    const total = recordings.length;
    const uploading = recordings.filter((r) => r.status === 'uploading').length;
    const pending = recordings.filter((r) => r.status === 'pending').length;
    const failed = recordings.filter((r) => r.status === 'failed').length;
    const completed = recordings.filter((r) => r.status === 'completed').length;
    const needsAttention = recordings.filter((r) => r.status === 'failed' && r.retryCount >= RETRY_ATTENTION_THRESHOLD).length;
    const overdue = countOverdue(recordings.filter((r) => r.status !== 'completed'));
    return { total, uploading, pending, failed, completed, needsAttention, overdue };
  }, [recordings]);

  // Marketplace breakdown chips
  const marketplaceCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of recordings) {
      const key = r.marketplace || 'Unassigned';
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }, [recordings]);

  // Apply filter + search
  const visible = useMemo(() => {
    let rows = recordings;
    if (filter === 'active') rows = rows.filter((r) => r.status === 'pending' || r.status === 'uploading');
    else if (filter === 'failed') rows = rows.filter((r) => r.status === 'failed');
    else if (filter === 'completed') rows = rows.filter((r) => r.status === 'completed');
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) =>
        r.trackingId.toLowerCase().includes(q) ||
        (r.orderId || '').toLowerCase().includes(q) ||
        (r.marketplace || '').toLowerCase().includes(q)
      );
    }
    return rows;
  }, [recordings, filter, search]);

  const setBusy = (id: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id); else next.delete(id);
      return next;
    });
  };

  const kickWorkerNow = async () => {
    if (!currentUser || !workerRef.current) return;
    const user = currentUser;
    const worker = workerRef.current;
    const orgId = organizationId || '';
    const requestedScopeKey = identityScopeKey;
    const token = await user.getIdToken(true);
    if (
      !isUploadScopeCurrent(identityScopeRef.current, requestedScopeKey)
      || currentUser !== user
      || workerRef.current !== worker
      || (organizationId || '') !== orgId
    ) return;
    const payload = { token, orgId, userEmail: user.email || '' };
    worker.postMessage({ type: 'UPDATE_ORG', payload });
    worker.postMessage({ type: 'PROCESS_QUEUE', payload });
  };

  const handleRetry = async (id: string) => {
    const requestedScopeKey = identityScopeKey;
    const userId = currentUser?.uid;
    const requestedIdentity = identity;
    setBusy(id, true);
    try {
      await retryRecording(id);
      const localRows = (await getAllRecordings()) as Recording[];
      if (!isUploadScopeCurrent(identityScopeRef.current, requestedScopeKey)) return;
      setQueueRowsForIdentity(localRows, userId, requestedIdentity);
      await kickWorkerNow();
    } finally {
      setBusy(id, false);
    }
  };


  // Manual push: force a fresh token + org into the worker and kick the drain
  // immediately (oldest first, one by one). For stuck queues that sit at 0%.
  const handleUploadNow = async () => {
    if (!currentUser || !workerRef.current) {
      toast.error('Sign in first — uploads need your login.');
      return;
    }
    setKicking(true);
    try {
      await kickWorkerNow();
      toast.success('Uploads started — oldest first. Keep VMS open.');
    } catch {
      toast.error('Could not start uploads — check internet and retry.');
    } finally {
      setKicking(false);
    }
  };

  const handleRetryAll = async () => {
    if (!window.confirm('Re-queue every failed upload? The local video files will be kept and retried.')) return;
    if (!currentUser) return;
    const requestedScopeKey = identityScopeKey;
    const userId = currentUser.uid;
    const requestedIdentity = identity;
    const failedRows = recordings.filter((record) => record.status === 'failed' && record.retryCount < RETRY_ATTENTION_THRESHOLD);
    const revivedRows = recordings.filter((record) => record.status === 'failed' && record.retryCount >= RETRY_ATTENTION_THRESHOLD);
    for (const record of failedRows) {
      await retryRecording(record.id);
      if (!isUploadScopeCurrent(identityScopeRef.current, requestedScopeKey)) return;
    }
    for (const record of revivedRows) {
      await reviveRecording(record.id);
      if (!isUploadScopeCurrent(identityScopeRef.current, requestedScopeKey)) return;
    }
    const failed = failedRows.length;
    const revived = revivedRows.length;
    if (failed > 0 || revived > 0) {
      const localRows = (await getAllRecordings()) as Recording[];
      if (!isUploadScopeCurrent(identityScopeRef.current, requestedScopeKey)) return;
      setQueueRowsForIdentity(localRows, userId, requestedIdentity);
      await kickWorkerNow().catch(() => undefined);
    }
    window.alert(`${failed} failed uploads re-queued, ${revived} high-retry uploads reset. Oldest uploads go first — keep VMS open on this PC.`);
  };

  const handleRevive = async (id: string) => {
    const requestedScopeKey = identityScopeKey;
    const userId = currentUser?.uid;
    const requestedIdentity = identity;
    setBusy(id, true);
    try {
      await reviveRecording(id);
      const localRows = (await getAllRecordings()) as Recording[];
      if (!isUploadScopeCurrent(identityScopeRef.current, requestedScopeKey)) return;
      setQueueRowsForIdentity(localRows, userId, requestedIdentity);
      await kickWorkerNow();
    } finally {
      setBusy(id, false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-surface-bg">
      <PageHeader
        title="Upload Queue"
        description="Local recordings waiting for upload to Firebase Storage"
        actions={
          <div className="flex items-center gap-3 text-secondary font-body">
            <span className="font-label text-label uppercase tracking-wider">
              {stats.uploading} uploading · {stats.pending} queued · {stats.failed} failed
              {stats.needsAttention > 0 ? ` · ${stats.needsAttention} need attention` : ''}
            </span>
          </div>
        }
      />

      <main className="flex-1 overflow-auto p-gutter space-y-4">
        {isAdminRole(role) && <AdminUploadQueuePanel />}
        {unscopedRecordings.length > 0 && (
          <div role="alert" className="p-4 bg-warning/10 border border-warning/30 text-warning rounded-lg font-medium">
            {unscopedRecordings.length} older local recording{unscopedRecordings.length !== 1 ? 's' : ''} lack a saved organization.
            They are held from upload and admin reporting to prevent cross-organization transfer; their video bytes remain on this device.
            Ask an administrator to review the listed recordings on this original device before resolving them.
            <div className="mt-2 text-sm font-mono">
              {unscopedRecordings.slice(0, 5).map((record) => record.trackingId).join(', ')}
              {unscopedRecordings.length > 5 ? `, and ${unscopedRecordings.length - 5} more` : ''}
            </div>
          </div>
        )}
        {stats.overdue > 0 && (
          <div className="p-4 bg-warning/10 border border-warning/30 text-warning rounded-lg font-medium flex items-center gap-2">
            <span className="material-symbols-outlined">schedule</span>
            {stats.overdue} video{stats.overdue !== 1 ? 's' : ''} waiting over 24h — keep VMS open on this PC (any page uploads); oldest go first.
          </div>
        )}

        {/* Stats header + marketplace breakdown */}
        <Card>
          <div className="flex flex-wrap items-center gap-3 justify-between">
            <div className="flex flex-wrap gap-2 text-sm">
              {Object.keys(marketplaceCounts).sort().map((m) => (
                <button
                  key={m}
                  onClick={() => setSearch(m)}
                  className="px-3 py-1.5 rounded-full bg-surface-container-low text-on-surface-variant hover:bg-surface-container font-label uppercase tracking-wider"
                  title={`Filter to ${m}`}
                >
                  {m} <span className="font-mono ml-1 text-secondary">{marketplaceCounts[m]}</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="search"
                placeholder="Search tracking / order / marketplace"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-64 px-3 py-1.5 rounded-lg border border-border-subtle bg-surface-bg text-body focus:outline-none focus:ring-2 focus:ring-primary"
              />
              {(stats.pending + stats.uploading) > 0 && (
                <button
                  onClick={handleUploadNow}
                  disabled={kicking}
                  className="px-3 py-1.5 rounded-lg bg-success text-white font-label uppercase tracking-wider hover:opacity-90 disabled:opacity-50"
                  title="Push all stuck uploads now — oldest first, one by one"
                >
                  {kicking ? 'Starting…' : 'Upload now'}
                </button>
              )}
              {stats.failed > 0 && (
                <button
                  onClick={handleRetryAll}
                  className="px-3 py-1.5 rounded-lg bg-primary text-white font-label uppercase tracking-wider hover:bg-primary-container"
                >
                  Retry all
                </button>
              )}
            </div>
          </div>

          {/* Filter tabs */}
          <div className="mt-3 flex items-center gap-1 border-b border-border-subtle">
            {(['all', 'active', 'failed', 'completed'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-2 font-label uppercase tracking-wider text-label ${
                  filter === f
                    ? 'border-b-2 border-primary text-primary'
                    : 'text-secondary hover:text-on-surface'
                }`}
              >
                {f}{' '}
                <span className="font-mono text-secondary ml-1">
                  {f === 'all' ? stats.total : f === 'active' ? stats.pending + stats.uploading : f === 'failed' ? stats.failed : stats.completed}
                </span>
              </button>
            ))}
          </div>
        </Card>

        {isLoading ? (
          <div className="p-8 text-secondary font-body">Loading local upload queue...</div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon="cloud_done"
            title={recordings.length === 0 ? 'Queue is empty' : 'No recordings match your filters'}
            hint={recordings.length === 0 ? 'New recordings will appear here automatically.' : 'Try clearing the search or switching tabs.'}
          />
        ) : (
          <Card>
            <table className="w-full text-body">
              <thead>
                <tr className="text-left font-label uppercase tracking-wider text-label text-secondary border-b border-border-subtle">
                  <th className="py-2 pr-4">Tracking</th>
                  <th className="py-2 pr-4">Marketplace</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Progress</th>
                  <th className="py-2 pr-4">Retries</th>
                  <th className="py-2 pr-4">Size</th>
                  <th className="py-2 pr-4">When</th>
                  <th className="py-2 pr-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const needsAttention = r.retryCount >= RETRY_ATTENTION_THRESHOLD;
                  const isBusy = busyIds.has(r.id);
                  return (
                    <tr key={r.id} className="border-b border-border-subtle last:border-0 align-middle">
                      <td className="py-3 pr-4 font-mono text-technical">
                        <div className="font-medium">{r.trackingId}</div>
                        {r.orderId && (
                          <div className="text-secondary text-xs">order: {r.orderId}</div>
                        )}
                      </td>
                      <td className="py-3 pr-4 font-label uppercase tracking-wider text-label text-secondary">
                        {r.marketplace || 'Unassigned'}
                      </td>
                      <td className="py-3 pr-4">
                        <StatusBadge status={r.status} />
                        {r.error && (
                          <div className="text-xs text-error mt-1 line-clamp-2 max-w-xs" title={r.error}>
                            {r.error.slice(0, 200)}
                          </div>
                        )}
                      </td>
                      <td className="py-3 pr-4">
                        {r.status === 'completed' ? (
                          <span className="text-success">100%</span>
                        ) : (
                          <div className="flex items-center gap-2 min-w-[8rem]">
                            <div className="flex-1 h-1.5 bg-surface-container-low rounded">
                              <div className="h-full bg-primary rounded" style={{ width: `${r.uploadProgress}%` }} />
                            </div>
                            <span className="font-mono text-xs text-secondary w-9 text-right">{Math.round(r.uploadProgress)}%</span>
                          </div>
                        )}
                      </td>
                      <td className="py-3 pr-4 font-mono text-secondary">
                        {r.retryCount}{needsAttention ? ' (attention)' : ''}
                      </td>
                      <td className="py-3 pr-4 font-mono text-secondary">
                        {formatBytes(r.blob?.size || 0)}
                      </td>
                      <td className="py-3 pr-4 text-secondary text-xs">
                        {new Date(r.timestamp).toLocaleString()}
                      </td>
                      <td className="py-3 pr-4">
                        <div className="flex items-center justify-end gap-1">
                          {r.status === 'failed' && (
                            <button
                              onClick={() => needsAttention ? handleRevive(r.id) : handleRetry(r.id)}
                              disabled={isBusy}
                              className="px-2 py-1 text-label uppercase tracking-wider rounded bg-primary text-white hover:bg-primary-container disabled:opacity-50"
                              title={needsAttention ? 'Reset retry count and try again; the local video is preserved' : 'Retry this upload now'}
                            >
                              {needsAttention ? 'Reset & retry' : 'Retry'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </main>
    </div>
  );
}