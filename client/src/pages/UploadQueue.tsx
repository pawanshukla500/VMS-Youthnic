import React, { useEffect, useMemo, useState } from 'react';
import {
  getAllRecordings,
  countOverdue,
  retryRecording,
  retryAllFailed,
  markRecordingDead,
  deleteRecording,
  DEAD_RETRY_THRESHOLD,
} from '../utils/videoQueue';
import { PageHeader, Card, StatusBadge, EmptyState } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { kickUploadQueue } from '../utils/uploadWorkerClient';

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
  orderId?: string;
  marketplace?: string;
  error?: string;
};

const POLL_INTERVAL_MS = 3000;

export default function UploadQueue() {
  const { currentUser } = useAuth();
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'active' | 'failed' | 'completed'>('all');
  const [search, setSearch] = useState('');
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  // Page Visibility aware polling: pause refresh while the tab is hidden so
  // an idle packing PC doesn't burn battery waking up IDB every 3 s.
  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    let onVisible = () => {};

    const loadQueue = async () => {
      const records = (await getAllRecordings()) as Recording[];
      if (!cancelled) {
        setRecordings(records.sort((a, b) => b.timestamp - a.timestamp));
        setIsLoading(false);
      }
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
  }, []);

  // Derived stats
  const stats = useMemo(() => {
    const total = recordings.length;
    const uploading = recordings.filter((r) => r.status === 'uploading').length;
    const pending = recordings.filter((r) => r.status === 'pending').length;
    const failed = recordings.filter((r) => r.status === 'failed').length;
    const completed = recordings.filter((r) => r.status === 'completed').length;
    const dead = recordings.filter((r) => r.status === 'failed' && r.retryCount >= DEAD_RETRY_THRESHOLD).length;
    const overdue = countOverdue(recordings.filter((r) => r.status !== 'completed'));
    return { total, uploading, pending, failed, completed, dead, overdue };
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

  const handleRetry = async (id: string) => {
    setBusy(id, true);
    try {
      await retryRecording(id);
      kickUploadQueue(currentUser ? await currentUser.getIdToken() : undefined);
      const refreshed = (await getAllRecordings()) as Recording[];
      setRecordings(refreshed.sort((a, b) => b.timestamp - a.timestamp));
    } finally {
      setBusy(id, false);
    }
  };

  const handleMarkDead = async (id: string) => {
    setBusy(id, true);
    try {
      await markRecordingDead(id, 'Marked dead by operator');
      const refreshed = (await getAllRecordings()) as Recording[];
      setRecordings(refreshed.sort((a, b) => b.timestamp - a.timestamp));
    } finally {
      setBusy(id, false);
    }
  };

  const handleDiscard = async (id: string) => {
    if (!window.confirm('Discard this upload? The local recording will be deleted and cannot be recovered.')) return;
    setBusy(id, true);
    try {
      await deleteRecording(id);
      setRecordings((prev) => prev.filter((r) => r.id !== id));
    } finally {
      setBusy(id, false);
    }
  };

  const handleRetryAll = async () => {
    if (!window.confirm('Re-queue every failed upload that has not been marked dead?')) return;
    const count = await retryAllFailed();
    if (count > 0) kickUploadQueue(currentUser ? await currentUser.getIdToken() : undefined);
    if (count > 0) {
      const refreshed = (await getAllRecordings()) as Recording[];
      setRecordings(refreshed.sort((a, b) => b.timestamp - a.timestamp));
    }
    window.alert(`${count} recording${count === 1 ? '' : 's'} re-queued.`);
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
              {stats.dead > 0 ? ` · ${stats.dead} dead` : ''}
            </span>
          </div>
        }
      />

      <main className="flex-1 overflow-auto p-gutter space-y-4">
        {stats.overdue > 0 && (
          <div className="p-4 bg-warning/10 border border-warning/30 text-warning rounded-lg font-medium flex items-center gap-2">
            <span className="material-symbols-outlined">schedule</span>
            {stats.overdue} video{stats.overdue !== 1 ? 's' : ''} waiting over 24h — keep this PC online; oldest uploads go first.
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
                  const isDead = r.retryCount >= DEAD_RETRY_THRESHOLD;
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
                        <StatusBadge status={isDead ? 'dead' : r.status} />
                        {r.error && !isDead && (
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
                        {r.retryCount}{isDead ? ' (dead)' : ''}
                      </td>
                      <td className="py-3 pr-4 font-mono text-secondary">
                        {formatBytes(r.blob?.size || 0)}
                      </td>
                      <td className="py-3 pr-4 text-secondary text-xs">
                        {new Date(r.timestamp).toLocaleString()}
                      </td>
                      <td className="py-3 pr-4">
                        <div className="flex items-center justify-end gap-1">
                          {r.status === 'failed' && !isDead && (
                            <button
                              onClick={() => handleRetry(r.id)}
                              disabled={isBusy}
                              className="px-2 py-1 text-label uppercase tracking-wider rounded bg-primary text-white hover:bg-primary-container disabled:opacity-50"
                            >
                              Retry
                            </button>
                          )}
                          {!isDead && (
                            <button
                              onClick={() => handleMarkDead(r.id)}
                              disabled={isBusy}
                              className="px-2 py-1 text-label uppercase tracking-wider rounded bg-surface-container-low text-on-surface-variant hover:bg-surface-container disabled:opacity-50"
                              title="Mark as dead (skip future retries; admin intervention required)"
                            >
                              Mark dead
                            </button>
                          )}
                          <button
                            onClick={() => handleDiscard(r.id)}
                            disabled={isBusy}
                            className="px-2 py-1 text-label uppercase tracking-wider rounded bg-error/10 text-error hover:bg-error/20 disabled:opacity-50"
                          >
                            Discard
                          </button>
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