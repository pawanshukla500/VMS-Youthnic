import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from './ui';
import { useAuth } from '../context/AuthContext';
import { authFetch } from '../utils/authFetch';
import { getApiBaseUrl } from '../utils/apiBase';
import { mergeAdminQueuePage, mergeRefreshedAdminQueueRows, filterAdminUploadQueue, AdminQueueSearchRow } from '../utils/adminUploadQueue';
import { getUploadIdentityScopeKey, isUploadScopeCurrent } from '../utils/uploadOwnership';
import toast from 'react-hot-toast';

interface AdminUploadQueueRow extends AdminQueueSearchRow {
  recording_id: string;
  operator_user_id: string;
  device_id: string;
  packer_name: string;
  packer_email: string | null;
  tracking_id: string;
  order_id: string | null;
  marketplace: string | null;
  status: 'pending' | 'uploading' | 'failed';
  retry_count: number;
  progress_percent: number;
  size_bytes: string | number;
  recorded_at: string;
  last_error: string | null;
  last_attempt_at: string | null;
  last_seen_at: string;
  retry_command_status: 'none' | 'requested' | 'delivered' | 'accepted' | 'unavailable';
  retry_requested_at: string | null;
  retry_command_error: string | null;
  retry_command_active: boolean;
  device_online: boolean;
  is_stuck: boolean;
}

const ADMIN_QUEUE_PAGE_SIZE = 200;

interface AdminQueueSnapshot {
  scopeKey: string;
  rows: AdminUploadQueueRow[];
  nextCursor: string | null;
  hasMore: boolean;
  loadedPages: number;
}

const EMPTY_ADMIN_QUEUE_SNAPSHOT: AdminQueueSnapshot = {
  scopeKey: '',
  rows: [],
  nextCursor: null,
  hasMore: false,
  loadedPages: 0,
};

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function formatSize(value: string | number): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, unit)).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function commandLabel(row: AdminUploadQueueRow): string | null {
  if (row.retry_command_status === 'requested') return 'Admin retry waiting for this device';
  if (row.retry_command_status === 'delivered') return 'Retry command delivered';
  if (row.retry_command_status === 'accepted') {
    return row.retry_command_active
      ? 'Source device acknowledged retry; waiting for upload outcome'
      : 'Retry acknowledgement expired; it can be requested again';
  }
  if (row.retry_command_status === 'unavailable') {
    return row.retry_command_error || 'Local video bytes are not available on the source device';
  }
  return null;
}

export default function AdminUploadQueuePanel() {
  const { currentUser, organizationId } = useAuth();
  const identityScopeKey = getUploadIdentityScopeKey(currentUser?.uid, {
    email: currentUser?.email,
    organizationId,
  });
  const identityScopeRef = useRef(identityScopeKey);
  identityScopeRef.current = identityScopeKey;
  const [queueSnapshot, setQueueSnapshot] = useState<AdminQueueSnapshot>(EMPTY_ADMIN_QUEUE_SNAPSHOT);
  const snapshotMatchesScope = isUploadScopeCurrent(queueSnapshot.scopeKey, identityScopeKey);
  const scopedSnapshot = snapshotMatchesScope ? queueSnapshot : EMPTY_ADMIN_QUEUE_SNAPSHOT;
  const rows = scopedSnapshot.rows;
  const nextCursor = scopedSnapshot.nextCursor;
  const hasMore = scopedSnapshot.hasMore;
  const [search, setSearch] = useState('');
  const [stuckOnly, setStuckOnly] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setLoading(true);
    setLoadError('');
    if (!currentUser) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const requestedScopeKey = identityScopeKey;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await authFetch(`${getApiBaseUrl()}/api/admin/video-upload-queue?limit=${ADMIN_QUEUE_PAGE_SIZE}`);
        const payload = await response.json().catch(() => ({})) as {
          items?: AdminUploadQueueRow[]; error?: string; nextCursor?: string | null; hasMore?: boolean;
        };
        if (!response.ok) throw new Error(payload.error || `Queue request failed (${response.status})`);
        if (!cancelled && isUploadScopeCurrent(identityScopeRef.current, requestedScopeKey)) {
          const firstPage = Array.isArray(payload.items) ? payload.items : [];
          const pageCursor = typeof payload.nextCursor === 'string' ? payload.nextCursor : null;
          setQueueSnapshot((previous) => {
            const previousForScope = previous.scopeKey === requestedScopeKey ? previous : EMPTY_ADMIN_QUEUE_SNAPSHOT;
            const preserveLoadedPages = previousForScope.loadedPages > 1;
            return {
              scopeKey: requestedScopeKey,
              rows: preserveLoadedPages
                ? mergeRefreshedAdminQueueRows(previousForScope.rows, firstPage)
                : firstPage,
              nextCursor: preserveLoadedPages ? previousForScope.nextCursor : pageCursor,
              hasMore: preserveLoadedPages
                ? previousForScope.hasMore && previousForScope.nextCursor !== null
                : Boolean(payload.hasMore && pageCursor),
              loadedPages: preserveLoadedPages ? previousForScope.loadedPages : 1,
            };
          });
          setLoadError('');
          setLoading(false);
        }
      } catch (error) {
        if (!cancelled && isUploadScopeCurrent(identityScopeRef.current, requestedScopeKey)) {
          setLoadError(error instanceof Error ? error.message : 'Could not load organization upload queue');
          setLoading(false);
        }
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [currentUser, organizationId, identityScopeKey]);

  const visibleRows = useMemo(
    () => filterAdminUploadQueue(rows, search, stuckOnly),
    [rows, search, stuckOnly],
  );
  const stuckCount = rows.filter((row) => row.is_stuck).length;
  const onlineCount = rows.filter((row) => row.device_online).length;

  const requestRetry = async (row: AdminUploadQueueRow) => {
    if (!snapshotMatchesScope || busyIds.has(row.recording_id)) return;
    const requestedScopeKey = identityScopeKey;
    setBusyIds((previous) => new Set(previous).add(row.recording_id));
    try {
      const response = await authFetch(
        `${getApiBaseUrl()}/api/admin/video-upload-queue/${encodeURIComponent(row.recording_id)}/retry`,
        { method: 'POST' },
      );
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || `Retry request failed (${response.status})`);
      if (!isUploadScopeCurrent(identityScopeRef.current, requestedScopeKey)) return;
      setQueueSnapshot((previous) => previous.scopeKey !== requestedScopeKey ? previous : {
        ...previous,
        rows: previous.rows.map((item) => item.recording_id === row.recording_id
          ? { ...item, retry_command_status: 'requested', retry_command_active: true }
          : item),
      });
      toast.success(row.device_online
        ? 'Retry request sent to the original device.'
        : 'Retry queued; it will run when the original device reconnects.');
    } catch (error) {
      if (isUploadScopeCurrent(identityScopeRef.current, requestedScopeKey)) {
        toast.error(error instanceof Error ? error.message : 'Could not request a retry');
      }
    } finally {
      setBusyIds((previous) => {
        const next = new Set(previous);
        next.delete(row.recording_id);
        return next;
      });
    }
  };

  const loadMore = async () => {
    if (!currentUser || !snapshotMatchesScope || !hasMore || !nextCursor || loadingMore) return;
    const requestedScopeKey = identityScopeKey;
    const requestedCursor = nextCursor;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: String(ADMIN_QUEUE_PAGE_SIZE), cursor: requestedCursor });
      const response = await authFetch(`${getApiBaseUrl()}/api/admin/video-upload-queue?${params.toString()}`);
      const payload = await response.json().catch(() => ({})) as {
        items?: AdminUploadQueueRow[]; error?: string; nextCursor?: string | null; hasMore?: boolean;
      };
      if (!response.ok) throw new Error(payload.error || `Queue request failed (${response.status})`);
      if (!isUploadScopeCurrent(identityScopeRef.current, requestedScopeKey)) return;
      const pageItems = Array.isArray(payload.items) ? payload.items : [];
      const pageCursor = typeof payload.nextCursor === 'string' ? payload.nextCursor : null;
      setQueueSnapshot((previous) => previous.scopeKey !== requestedScopeKey ? previous : {
        ...previous,
        rows: mergeAdminQueuePage(previous.rows, pageItems),
        nextCursor: pageCursor,
        hasMore: Boolean(payload.hasMore && pageCursor),
        loadedPages: pageItems.length > 0 ? previous.loadedPages + 1 : previous.loadedPages,
      });
      setLoadError('');
    } catch (error) {
      if (isUploadScopeCurrent(identityScopeRef.current, requestedScopeKey)) {
        setLoadError(error instanceof Error ? error.message : 'Could not load older queue rows');
      }
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-headline text-title text-on-surface">Organization upload queue</h2>
          <p className="text-sm text-secondary mt-1">
            {stuckCount} need attention in {rows.length} loaded rows · {onlineCount} source device{onlineCount === 1 ? '' : 's'} recently online
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-secondary">
            <input type="checkbox" checked={stuckOnly} onChange={(event) => setStuckOnly(event.target.checked)} />
            Needs attention only
          </label>
          <input
            type="search"
            placeholder="Search packer, tracking, order"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-64 px-3 py-1.5 rounded-lg border border-border-subtle bg-surface-bg text-body focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      </div>
      <p className="text-xs text-secondary mt-3">
        Queue rows are reported by authenticated source browsers; telemetry contains metadata only and does not prove the local video bytes still exist. Retry commands run on the originating browser, which confirms whether its bytes are available.
      </p>
      {loadError && <div role="alert" className="mt-3 text-sm text-error">{loadError}</div>}
      {loading ? (
        <div className="py-6 text-secondary">Loading organization queue…</div>
      ) : visibleRows.length === 0 ? (
        <div className="py-6 text-secondary">{rows.length === 0 ? 'No uploads are currently reported.' : 'No queue rows match this view.'}</div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[1050px] text-sm">
            <thead>
              <tr className="text-left uppercase tracking-wider text-xs text-secondary border-b border-border-subtle">
                <th className="py-2 pr-4">Packer</th>
                <th className="py-2 pr-4">Shipment</th>
                <th className="py-2 pr-4">Queue state</th>
                <th className="py-2 pr-4">Retries / progress</th>
                <th className="py-2 pr-4">Recorded / last seen</th>
                <th className="py-2 pr-4">Device</th>
                <th className="py-2 pr-4 text-right">Admin action</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const pendingCommand = row.retry_command_active;
                const message = commandLabel(row);
                return (
                  <tr key={row.recording_id} className="border-b border-border-subtle last:border-0 align-top">
                    <td className="py-3 pr-4">
                      <div className="font-medium text-on-surface">{row.packer_name || 'Unknown packer'}</div>
                      <div className="text-xs text-secondary">{row.packer_email || row.operator_user_id}</div>
                    </td>
                    <td className="py-3 pr-4">
                      <div className="font-mono">{row.tracking_id}</div>
                      <div className="text-xs text-secondary">{row.order_id || 'No order'} · {row.marketplace || 'Unassigned'}</div>
                      <div className="text-xs text-secondary">{formatSize(row.size_bytes)}</div>
                    </td>
                    <td className="py-3 pr-4">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs ${row.is_stuck ? 'bg-error/10 text-error' : 'bg-surface-container-low text-secondary'}`}>
                        {row.is_stuck ? 'Needs attention' : row.status}
                      </span>
                      {row.last_error && <div className="mt-1 max-w-xs text-xs text-error" title={row.last_error}>{row.last_error.slice(0, 180)}</div>}
                      {message && <div className="mt-1 max-w-xs text-xs text-secondary" title={message}>{message.slice(0, 180)}</div>}
                    </td>
                    <td className="py-3 pr-4 font-mono">
                      <div>{row.retry_count} retries</div>
                      <div className="text-xs text-secondary">{row.progress_percent}%</div>
                    </td>
                    <td className="py-3 pr-4 text-xs text-secondary">
                      <div>{formatDate(row.recorded_at)}</div>
                      <div>seen {formatDate(row.last_seen_at)}</div>
                      {row.last_attempt_at && <div>attempt {formatDate(row.last_attempt_at)}</div>}
                    </td>
                    <td className="py-3 pr-4">
                      <span className={row.device_online ? 'text-success' : 'text-secondary'}>{row.device_online ? 'Online' : 'Offline'}</span>
                    </td>
                    <td className="py-3 pr-4 text-right">
                      <button
                        onClick={() => void requestRetry(row)}
                        disabled={!row.is_stuck || pendingCommand || busyIds.has(row.recording_id)}
                        className="px-3 py-1.5 rounded-lg bg-primary text-white font-label uppercase tracking-wider hover:bg-primary-container disabled:opacity-50"
                        title={row.device_online ? 'Ask the source browser to retry now' : 'Queue retry for when the source browser reconnects'}
                      >
                        {pendingCommand
                          ? row.retry_command_status === 'accepted' ? 'Retry acknowledged' : 'Retry queued'
                          : busyIds.has(row.recording_id) ? 'Sending…' : 'Request retry'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {hasMore && (
        <div className="mt-4 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="px-4 py-2 rounded-lg border border-border-subtle text-sm text-on-surface hover:bg-surface-container-low disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more uploads'}
          </button>
        </div>
      )}
    </Card>
  );
}
