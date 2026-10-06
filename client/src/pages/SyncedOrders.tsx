import React, { useState } from 'react';
import useSWR from 'swr';
import toast from 'react-hot-toast';
import { authFetch } from '../utils/authFetch';
import { getApiBaseUrl } from '../utils/apiBase';
import { PageHeader, Card, CardHeader, EmptyState, SafeImage } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { isAdminRole } from '../utils/roles';
import {
  buildManualOrderPayload,
  draftFromOrder,
  EMPTY_ITEM,
  formatRelativeTime,
  isValidImageLink,
  ManualOrderDraft,
  withMarketplace,
} from '../utils/syncedOrders';

const API_URL = getApiBaseUrl();
const PAGE_SIZE = 50;

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Failed to load synced orders');
  return body;
};

const INPUT = 'w-full bg-surface-bg border border-border-heavy rounded-lg px-3 py-2 text-body-sm text-on-surface focus:outline-none focus:border-primary';
const BUTTON = 'px-4 py-2 rounded-lg font-medium flex items-center gap-2 disabled:opacity-50';

function MarketplaceBadge({ marketplace, isMeesho }: { marketplace: string | null; isMeesho: boolean }) {
  return (
    <span className={`inline-flex items-center px-2 py-1 rounded text-[11px] font-bold tracking-wide border ${isMeesho
      ? 'bg-amber-500/15 text-amber-600 border-amber-500/30'
      : marketplace ? 'bg-primary/10 text-primary border-primary/20' : 'bg-surface-variant text-on-surface-variant border-outline-variant'}`}
    >
      {(marketplace || 'Unassigned').toUpperCase()}
    </span>
  );
}

function StatusPill({ status, group }: { status: string | null; group: string | null }) {
  if (!status && !group) return <span className="text-secondary">—</span>;
  const blocked = group === 'CANCELLED' || group === 'RETURN' || group === 'PARTIAL_CANCEL';
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-semibold border ${blocked
      ? 'bg-critical/10 text-critical border-critical/20'
      : 'bg-surface-container text-on-surface-variant border-border-subtle'}`}
    >
      {status || group}
    </span>
  );
}

export default function SyncedOrders() {
  const { role } = useAuth();
  // Manual copy runs are admin-only (server-enforced); it runs every 2 min anyway.
  const canSync = isAdminRole(role);
  const [search, setSearch] = useState('');
  const [marketplace, setMarketplace] = useState('all');
  const [manualOnly, setManualOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState<{ draft: ManualOrderDraft; existing: any | null } | null>(null);

  const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (search.trim()) query.set('search', search.trim());
  if (marketplace !== 'all') query.set('marketplace', marketplace);
  if (manualOnly) query.set('source', 'manual');

  const { data: status, mutate: mutateStatus } = useSWR(`${API_URL}/api/admin/forward-scan/status`, fetcher, { refreshInterval: 30000 });
  const { data, error, isLoading, mutate } = useSWR(`${API_URL}/api/synced-orders?${query.toString()}`, fetcher, { refreshInterval: 30000 });

  const orders: any[] = data?.orders || [];
  const total = Number(data?.total || 0);
  const marketplaces: any[] = status?.marketplaces || [];

  const refreshAll = () => {
    void mutate();
    void mutateStatus();
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const res = await authFetch(`${API_URL}/api/admin/forward-scan/sync`, { method: 'POST' });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || `Sync failed with status ${res.status}`);
      toast.success(`Forward Scan: ${result.ordersRead} orders in window, ${result.ordersWritten} updated, ${result.photosWritten} photos`);
      refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const pickMarketplace = (value: string) => {
    setMarketplace(value);
    setOffset(0);
  };

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-surface-bg">
      <PageHeader
        title="Synced Orders"
        description={`Marketplace-wise orders copied from Forward Scan (last ${status?.retentionDays || 3} days). Correct SKUs and photo links by hand when needed.`}
        actions={
          <>
            <button
              type="button"
              onClick={() => setEditing({ draft: draftFromOrder(null), existing: null })}
              className={`${BUTTON} bg-surface-card border border-border-heavy text-on-surface hover:bg-surface-container`}
            >
              <span className="material-symbols-outlined text-sm">add</span>
              Add order
            </button>
            {canSync && (
              <button
                type="button"
                onClick={syncNow}
                disabled={syncing || status?.configured === false || status?.receivesCopy === false}
                className={`${BUTTON} bg-primary text-on-primary hover:bg-primary/90`}
              >
                <span className={`material-symbols-outlined text-sm ${syncing ? 'animate-spin' : ''}`}>sync</span>
                {syncing ? 'Syncing…' : 'Sync now'}
              </button>
            )}
          </>
        }
      />

      <main className="flex-1 overflow-y-auto p-gutter space-y-6">
        <ForwardScanStatusCard status={status} />
        <SkuPhotoSyncCard canRun={canSync} />

        <Card>
          <CardHeader
            icon="storefront"
            title="Orders by marketplace"
            description="Meesho orders switch the packing-page flyer scan ON automatically; every other marketplace switches it OFF."
            action={
              <div className="flex flex-col sm:flex-row gap-2 w-full lg:w-auto">
                <input
                  value={search}
                  onChange={(event) => { setSearch(event.target.value); setOffset(0); }}
                  className={`${INPUT} sm:min-w-[260px]`}
                  placeholder="Search AWB, order ID or SKU"
                />
                <label className="flex items-center gap-2 text-body-sm text-on-surface whitespace-nowrap px-2">
                  <input type="checkbox" checked={manualOnly} onChange={(event) => { setManualOnly(event.target.checked); setOffset(0); }} />
                  Manual only
                </label>
              </div>
            }
          />
          <div className="px-5 pt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => pickMarketplace('all')}
              className={`px-3 py-1.5 rounded-full text-body-sm border ${marketplace === 'all' ? 'bg-primary text-on-primary border-primary' : 'bg-surface-bg text-on-surface border-border-heavy hover:bg-surface-container'}`}
            >
              All · {status?.totalOrders ?? '…'}
            </button>
            {marketplaces.map((item) => (
              <button
                key={item.marketplace}
                type="button"
                onClick={() => pickMarketplace(item.marketplace)}
                className={`px-3 py-1.5 rounded-full text-body-sm border flex items-center gap-1.5 ${marketplace === item.marketplace
                  ? 'bg-primary text-on-primary border-primary'
                  : item.isMeesho
                    ? 'bg-amber-500/10 text-amber-700 border-amber-500/30 hover:bg-amber-500/20'
                    : 'bg-surface-bg text-on-surface border-border-heavy hover:bg-surface-container'}`}
              >
                {item.isMeesho && <span className="material-symbols-outlined text-[16px]">local_mall</span>}
                {item.marketplace} · {item.orders}
                {item.manual > 0 && <span className="text-[11px] opacity-80">({item.manual} manual)</span>}
              </button>
            ))}
          </div>

          {isLoading && (
            <div className="p-8 flex items-center gap-2 text-secondary">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              Loading orders...
            </div>
          )}
          {error && (
            <div className="m-5 p-4 rounded-lg bg-critical/10 text-critical border border-critical/20 flex items-center gap-2">
              <span className="material-symbols-outlined text-sm">error</span>
              {error.message}
            </div>
          )}
          {!isLoading && !error && (
            <div className="overflow-x-auto mt-4">
              <table className="w-full text-left min-w-[960px]">
                <thead className="bg-surface-container-low border-y border-border-subtle">
                  <tr>
                    <th className="p-4 font-metadata text-metadata text-secondary uppercase tracking-wider">Tracking ID</th>
                    <th className="p-4 font-metadata text-metadata text-secondary uppercase tracking-wider">Marketplace</th>
                    <th className="p-4 font-metadata text-metadata text-secondary uppercase tracking-wider">Order ID</th>
                    <th className="p-4 font-metadata text-metadata text-secondary uppercase tracking-wider">SKUs</th>
                    <th className="p-4 font-metadata text-metadata text-secondary uppercase tracking-wider">OMS status</th>
                    <th className="p-4 font-metadata text-metadata text-secondary uppercase tracking-wider">AWB generated</th>
                    <th className="p-4 font-metadata text-metadata text-secondary uppercase tracking-wider text-right">Edit</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.tracking_id} className="border-b border-border-subtle hover:bg-surface-container-low align-top">
                      <td className="p-4">
                        <p className="font-technical text-technical text-on-surface">{order.tracking_id}</p>
                        <p className="font-metadata text-metadata text-secondary">{order.shipping_company || ''}</p>
                      </td>
                      <td className="p-4">
                        <MarketplaceBadge marketplace={order.marketplace} isMeesho={order.is_meesho} />
                        {order.channel_name && order.channel_name !== order.marketplace && (
                          <p className="font-metadata text-metadata text-secondary mt-1">{order.channel_name}</p>
                        )}
                      </td>
                      <td className="p-4 font-technical text-technical text-on-surface">
                        <span className="block max-w-[220px] whitespace-nowrap truncate" title={order.order_id || ''}>{order.order_id || '—'}</span>
                      </td>
                      <td className="p-4">
                        <div className="flex flex-col gap-1.5">
                          {order.items.length === 0 && <span className="text-body-sm text-secondary">No SKU lines</span>}
                          {order.items.slice(0, 4).map((item: any, index: number) => (
                            <div key={`${item.sku}-${index}`} className="flex items-center gap-2 min-w-0">
                              <SafeImage
                                src={item.imageUrl}
                                alt={item.title || item.sku}
                                fallbackIcon="package_2"
                                className="w-9 h-9 rounded object-cover border border-border-subtle shrink-0 text-base"
                              />
                              <span className="font-technical text-[12px] text-on-surface truncate" title={item.title || item.sku}>
                                {item.sku} <span className="text-secondary">×{item.quantity}</span>
                              </span>
                            </div>
                          ))}
                          {order.items.length > 4 && <span className="text-[12px] text-secondary">+{order.items.length - 4} more</span>}
                        </div>
                      </td>
                      <td className="p-4"><StatusPill status={order.status} group={order.status_group} /></td>
                      <td className="p-4 text-body-sm text-secondary whitespace-nowrap">
                        {order.awb_generated_at ? new Date(order.awb_generated_at).toLocaleString() : '—'}
                      </td>
                      <td className="p-4 text-right">
                        <div className="flex flex-col items-end gap-1">
                          {order.isManual && (
                            <span className="px-2 py-0.5 rounded text-[11px] font-bold border bg-warning/10 text-warning border-warning/20">
                              {order.source === 'manual' ? 'MANUAL' : 'EDITED'}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => setEditing({ draft: draftFromOrder(order), existing: order })}
                            className="text-primary text-body-sm font-medium hover:underline flex items-center gap-1"
                          >
                            <span className="material-symbols-outlined text-sm">edit</span>
                            Edit
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {orders.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-0">
                        <EmptyState
                          icon="inventory_2"
                          title="No synced orders"
                          hint={status?.configured === false
                            ? 'FORWARD_SCAN_DATABASE_URL is not set on the server.'
                            : 'Orders appear here as Forward Scan generates AWBs. Use Sync now to copy immediately.'}
                        />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {total > PAGE_SIZE && (
            <div className="p-4 flex items-center justify-between text-body-sm text-secondary">
              <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}</span>
              <div className="flex gap-2">
                <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} className={`${BUTTON} border border-border-heavy bg-surface-card text-on-surface`}>Previous</button>
                <button type="button" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)} className={`${BUTTON} border border-border-heavy bg-surface-card text-on-surface`}>Next</button>
              </div>
            </div>
          )}
        </Card>

        <SkuImagesCard onChanged={refreshAll} />
      </main>

      {editing && (
        <OrderEditor
          initial={editing.draft}
          existing={editing.existing}
          knownMarketplaces={marketplaces.map((m) => m.marketplace).filter((m) => m !== 'Unassigned')}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refreshAll(); }}
        />
      )}
    </div>
  );
}

function ForwardScanStatusCard({ status }: { status: any }) {
  if (!status) return null;
  const healthy = status.configured && status.receivesCopy && !status.lastError && status.lastSuccessAt;
  return (
    <Card>
      <div className="p-5 flex flex-col lg:flex-row lg:items-center gap-4 justify-between">
        <div className="flex items-start gap-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${healthy ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
            <span className="material-symbols-outlined">{healthy ? 'cloud_done' : 'cloud_off'}</span>
          </div>
          <div>
            <h3 className="font-headline-2 text-headline-2 text-on-surface">Forward Scan order copy</h3>
            <p className="font-body-sm text-body-sm text-secondary">
              {status.configured
                ? `Source: ${status.source} · every ${Math.round(status.intervalSeconds / 60) || 1} min · no OMSGuru API calls`
                : 'Not configured — set FORWARD_SCAN_DATABASE_URL on the server.'}
            </p>
            {status.configured && !status.receivesCopy && status.notReceivingReason && (
              <p className="font-body-sm text-body-sm text-warning mt-1">Copy is off for this organization: {status.notReceivingReason}</p>
            )}
            {status.lastError && (
              <p className="font-body-sm text-body-sm text-critical mt-1">Last error: {status.lastError}</p>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-body-sm">
          <div><p className="font-metadata text-metadata text-secondary uppercase">Last copy</p><p className="text-on-surface">{formatRelativeTime(status.lastSuccessAt)}</p></div>
          <div><p className="font-metadata text-metadata text-secondary uppercase">Orders kept</p><p className="text-on-surface">{status.totalOrders}</p></div>
          <div><p className="font-metadata text-metadata text-secondary uppercase">Last run</p><p className="text-on-surface">{status.lastOrdersWritten} updated · {status.lastPurged} purged</p></div>
          <div><p className="font-metadata text-metadata text-secondary uppercase">SKU photos</p><p className="text-on-surface">{(status.skuImages?.['forward-scan'] || 0) + (status.skuImages?.omsguru || 0)} synced · {status.skuImages?.manual || 0} manual</p></div>
        </div>
      </div>
    </Card>
  );
}

function formatIstTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// Nightly OMSGuru SKU photo sync (orders still come from Forward Scan).
function SkuPhotoSyncCard({ canRun }: { canRun: boolean }) {
  const { data: sync, mutate } = useSWR(`${API_URL}/api/admin/sku-images/sync-status`, fetcher, { refreshInterval: 30000 });
  const [starting, setStarting] = useState(false);
  if (!sync) return null;

  const channels: any[] = sync.channels || [];
  const lastRun = (sync.runs || [])[0] || null;
  const done = channels.filter((c) => c.passCompletedAt).length;
  const coverage = sync.orderSkus || { total: 0, exact: 0, withStyle: 0 };
  const pct = (n: number) => (coverage.total ? Math.round((n / coverage.total) * 100) : 0);
  const healthy = sync.enabled && sync.configured && (!lastRun || lastRun.status !== 'error');

  const runNow = async () => {
    setStarting(true);
    try {
      const res = await authFetch(`${API_URL}/api/admin/sku-images/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes: 15 }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Could not start (status ${res.status})`);
      toast.success(`SKU photo sync started for up to ${body.minutes} min`);
      void mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the sync');
    } finally {
      setStarting(false);
    }
  };

  return (
    <Card>
      <div className="p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center gap-4 justify-between">
          <div className="flex items-start gap-3">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${healthy ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
              <span className="material-symbols-outlined">{sync.running ? 'sync' : 'photo_library'}</span>
            </div>
            <div>
              <h3 className="font-headline-2 text-headline-2 text-on-surface">Nightly SKU photo sync</h3>
              <p className="font-body-sm text-body-sm text-secondary">
                {!sync.enabled
                  ? 'Off (SKU_IMAGE_SYNC_ENABLED=false).'
                  : !sync.configured
                    ? 'OMSGuru token / client ID missing on the server.'
                    : `OMSGuru listings every night at ${String(sync.hourIst).padStart(2, '0')}:00 IST for up to ${sync.maxMinutes} min · keeps ${sync.reserve} of every 60 calls for Forward Scan · no order calls`}
              </p>
              {sync.running && (
                <p className="font-body-sm text-body-sm text-primary mt-1">Running now ({sync.running.trigger}) · ends by {formatIstTime(sync.running.deadlineAt)}</p>
              )}
              {lastRun?.error && (
                <p className="font-body-sm text-body-sm text-critical mt-1">Last run error: {lastRun.error}</p>
              )}
            </div>
          </div>
          {canRun && (
            <button
              type="button"
              onClick={runNow}
              disabled={starting || Boolean(sync.running) || !sync.configured || sync.receivesSync === false}
              className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold bg-surface-card border border-border-heavy text-on-surface hover:bg-surface-container disabled:opacity-50 disabled:cursor-not-allowed"
              title="Runs up to 15 minutes now with the same budget limits as the nightly run"
            >
              <span className={`material-symbols-outlined text-sm ${sync.running ? 'animate-spin' : ''}`}>sync</span>
              {sync.running ? 'Running…' : starting ? 'Starting…' : 'Run now (15 min)'}
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-body-sm">
          <div>
            <p className="font-metadata text-metadata text-secondary uppercase">Order SKUs with photo</p>
            <p className="text-on-surface">
              {coverage.exact} / {coverage.total} exact ({pct(coverage.exact)}%)
            </p>
            <p className="font-metadata text-metadata text-secondary">{coverage.withStyle} incl. other size ({pct(coverage.withStyle)}%)</p>
          </div>
          <div>
            <p className="font-metadata text-metadata text-secondary uppercase">Catalogue</p>
            <p className="text-on-surface">{Number(sync.listings || 0).toLocaleString('en-IN')} listings stored</p>
            <p className="font-metadata text-metadata text-secondary">{Number(sync.skuImages?.omsguru || 0).toLocaleString('en-IN')} SKU photo links</p>
          </div>
          <div>
            <p className="font-metadata text-metadata text-secondary uppercase">First full pass</p>
            <p className="text-on-surface">
              {channels.length === 0 ? 'Starts tonight' : sync.firstPassComplete ? 'Complete — nightly top-ups only' : `${done} / ${channels.length} channels done`}
            </p>
          </div>
          <div>
            <p className="font-metadata text-metadata text-secondary uppercase">Last run · next</p>
            <p className="text-on-surface">
              {lastRun ? `${formatRelativeTime(lastRun.finishedAt || lastRun.startedAt)} · ${lastRun.listingsStored} listings, ${lastRun.imagesWritten} photos` : 'never'}
            </p>
            <p className="font-metadata text-metadata text-secondary">Next: {formatIstTime(sync.nextRunAt)}</p>
          </div>
        </div>

        {channels.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {channels.map((c) => (
              <span
                key={c.channelId}
                title={c.passCompletedAt ? `Full pass done ${formatIstTime(c.passCompletedAt)}` : `${c.pagesRead} pages read so far`}
                className={`px-2 py-1 rounded text-[11px] font-semibold border ${c.passCompletedAt ? 'bg-success/10 border-success/30 text-success' : 'bg-surface-container border-border-subtle text-on-surface-variant'}`}
              >
                {c.channelName || c.channelId} · {Number(c.listings || 0).toLocaleString('en-IN')}{c.passCompletedAt ? ' ✓' : '…'}
              </span>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function OrderEditor({
  initial,
  existing,
  knownMarketplaces,
  onClose,
  onSaved,
}: {
  initial: ManualOrderDraft;
  existing: any | null;
  knownMarketplaces: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<ManualOrderDraft>(initial);
  const [saving, setSaving] = useState(false);

  const setItem = (index: number, patch: Partial<ManualOrderDraft['items'][number]>) => {
    setDraft((prev) => ({ ...prev, items: prev.items.map((item, i) => (i === index ? { ...item, ...patch } : item)) }));
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const { payload, error } = buildManualOrderPayload(draft);
    if (!payload) {
      toast.error(error || 'Check the form');
      return;
    }
    setSaving(true);
    try {
      const res = await authFetch(`${API_URL}/api/synced-orders`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || `Save failed with status ${res.status}`);
      toast.success(result.imagesSaved ? `Order saved · ${result.imagesSaved} SKU photo link(s) saved` : 'Order saved');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const revert = async () => {
    if (!existing) return;
    const message = existing.source === 'manual'
      ? 'Delete this hand-entered order?'
      : 'Throw away the manual changes and use the Forward Scan data again?';
    if (!window.confirm(message)) return;
    setSaving(true);
    try {
      const res = await authFetch(`${API_URL}/api/synced-orders/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackingId: existing.tracking_id }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || `Revert failed with status ${res.status}`);
      toast.success(result.deletedManual
        ? 'Manual order deleted'
        : result.refreshed
          ? 'Back to Forward Scan data'
          : 'Manual flag removed — Forward Scan no longer has this AWB, so the old lines stay until it expires');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Revert failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-start justify-center overflow-y-auto p-4" role="dialog" aria-modal="true" aria-label="Edit synced order">
      <form onSubmit={save} className="bg-surface-card rounded-xl border border-border-subtle shadow-xl w-full max-w-3xl my-8">
        <div className="p-5 border-b border-border-subtle flex items-center justify-between">
          <div>
            <h3 className="font-headline-2 text-headline-2 text-on-surface">{existing ? 'Edit order' : 'Add order by hand'}</h3>
            <p className="font-body-sm text-body-sm text-secondary">
              Saved changes are marked manual — the Forward Scan copy will not overwrite them. Like every synced order, they are kept for 3 days after the last change.
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-secondary hover:text-on-surface" aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="p-5 grid grid-cols-1 md:grid-cols-3 gap-4">
          <label className="block">
            <span className="font-metadata text-metadata text-secondary uppercase tracking-wider">Tracking ID (AWB)</span>
            <input
              value={draft.trackingId}
              onChange={(e) => setDraft({ ...draft, trackingId: e.target.value })}
              readOnly={Boolean(existing)}
              className={`${INPUT} mt-1 font-technical ${existing ? 'opacity-70' : ''}`}
              placeholder="e.g. VL0085600380655"
              required
            />
          </label>
          <label className="block">
            <span className="font-metadata text-metadata text-secondary uppercase tracking-wider">Marketplace</span>
            <input
              value={draft.marketplace}
              onChange={(e) => setDraft(withMarketplace(draft, e.target.value))}
              list="synced-marketplaces"
              className={`${INPUT} mt-1`}
              placeholder="e.g. Meesho"
            />
            <datalist id="synced-marketplaces">
              {knownMarketplaces.map((m) => <option key={m} value={m} />)}
            </datalist>
          </label>
          <label className="block">
            <span className="font-metadata text-metadata text-secondary uppercase tracking-wider">Order ID</span>
            <input
              value={draft.orderId}
              onChange={(e) => setDraft({ ...draft, orderId: e.target.value })}
              className={`${INPUT} mt-1 font-technical`}
              placeholder="Meesho: sub-order id"
            />
          </label>
          <label className={`flex items-center gap-2 text-body-sm text-on-surface md:col-span-3 ${draft.marketplace.trim() ? 'opacity-70' : ''}`}>
            <input
              type="checkbox"
              checked={draft.isMeesho}
              disabled={Boolean(draft.marketplace.trim())}
              onChange={(e) => setDraft({ ...draft, isMeesho: e.target.checked })}
            />
            Meesho order (flyer bag scan required on the packing page)
            {draft.marketplace.trim() && <span className="text-secondary">— set from the marketplace</span>}
          </label>
        </div>

        <div className="px-5 pb-2">
          <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-2">SKU lines</p>
          <div className="space-y-3">
            {draft.items.map((item, index) => {
              const badLink = !isValidImageLink(item.imageUrl);
              return (
                <div key={index} className="grid grid-cols-[56px_1fr] gap-3 items-start rounded-lg border border-border-subtle p-3">
                  <SafeImage
                    src={!badLink && item.imageUrl.trim() ? item.imageUrl.trim() : null}
                    alt={item.title || item.sku || 'SKU photo'}
                    fallbackIcon="image"
                    className="w-14 h-14 rounded object-cover border border-border-subtle text-xl"
                  />
                  <div className="grid grid-cols-1 md:grid-cols-[1.2fr_1.4fr_80px] gap-2">
                    <input value={item.sku} onChange={(e) => setItem(index, { sku: e.target.value })} className={`${INPUT} font-technical`} placeholder="SKU" />
                    <input value={item.title} onChange={(e) => setItem(index, { title: e.target.value })} className={INPUT} placeholder="Title (optional)" />
                    <input value={item.quantity} onChange={(e) => setItem(index, { quantity: e.target.value })} className={INPUT} inputMode="numeric" placeholder="Qty" aria-label="Quantity" />
                    <div className="md:col-span-3 flex gap-2">
                      <input
                        value={item.imageUrl}
                        onChange={(e) => setItem(index, { imageUrl: e.target.value })}
                        className={`${INPUT} ${badLink ? 'border-critical focus:border-critical' : ''}`}
                        placeholder="Photo link https://… (optional)"
                        aria-invalid={badLink}
                      />
                      <button
                        type="button"
                        onClick={() => setDraft((prev) => ({ ...prev, items: prev.items.length > 1 ? prev.items.filter((_, i) => i !== index) : [{ ...EMPTY_ITEM }] }))}
                        className="text-secondary hover:text-critical px-2"
                        aria-label="Remove SKU line"
                      >
                        <span className="material-symbols-outlined">delete</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setDraft((prev) => ({ ...prev, items: [...prev.items, { ...EMPTY_ITEM }] }))}
            className="mt-3 text-primary text-body-sm font-medium hover:underline flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-sm">add</span>
            Add SKU line
          </button>
          <label className="mt-3 flex items-center gap-2 text-body-sm text-on-surface">
            <input type="checkbox" checked={draft.rememberImages} onChange={(e) => setDraft({ ...draft, rememberImages: e.target.checked })} />
            Also use photo links I change here for the same SKUs on other orders
          </label>
        </div>

        <div className="p-5 border-t border-border-subtle flex flex-wrap items-center justify-between gap-2 mt-4">
          <div>
            {existing?.isManual && (
              <button type="button" onClick={revert} disabled={saving} className={`${BUTTON} border border-critical/30 text-critical hover:bg-critical/10`}>
                <span className="material-symbols-outlined text-sm">undo</span>
                {existing.source === 'manual' ? 'Delete manual order' : 'Use Forward Scan data again'}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className={`${BUTTON} border border-border-heavy bg-surface-card text-on-surface`}>Cancel</button>
            <button type="submit" disabled={saving} className={`${BUTTON} bg-primary text-on-primary hover:bg-primary/90`}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function SkuImagesCard({ onChanged }: { onChanged: () => void }) {
  const [search, setSearch] = useState('');
  const [manualOnly, setManualOnly] = useState(true);
  const [sku, setSku] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);

  const query = new URLSearchParams({ limit: '30' });
  if (search.trim()) query.set('search', search.trim());
  if (manualOnly) query.set('source', 'manual');
  const { data, error, mutate } = useSWR(`${API_URL}/api/sku-images?${query.toString()}`, fetcher);
  const images: any[] = data?.images || [];

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!sku.trim()) return toast.error('SKU is required');
    if (!imageUrl.trim() || !isValidImageLink(imageUrl)) return toast.error('Photo link must start with http:// or https://');
    setSaving(true);
    try {
      const res = await authFetch(`${API_URL}/api/sku-images`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: sku.trim(), imageUrl: imageUrl.trim(), title: title.trim() || null }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || `Save failed with status ${res.status}`);
      toast.success(`Photo link saved for ${result.sku}`);
      setSku('');
      setImageUrl('');
      setTitle('');
      void mutate();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (skuValue: string) => {
    if (!window.confirm(`Remove the manual photo link for ${skuValue}? The Forward Scan photo (if any) shows again.`)) return;
    try {
      const res = await authFetch(`${API_URL}/api/sku-images?sku=${encodeURIComponent(skuValue)}`, { method: 'DELETE' });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || `Delete failed with status ${res.status}`);
      toast.success('Manual photo link removed');
      void mutate();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  return (
    <Card>
      <CardHeader
        icon="image"
        title="SKU photo links"
        description="A manual link always wins over the synced catalogue photo on the packing page."
        action={
          <div className="flex flex-col sm:flex-row gap-2 w-full lg:w-auto">
            <input value={search} onChange={(e) => setSearch(e.target.value)} className={`${INPUT} sm:min-w-[220px]`} placeholder="Search SKU or title" />
            <label className="flex items-center gap-2 text-body-sm text-on-surface whitespace-nowrap px-2">
              <input type="checkbox" checked={manualOnly} onChange={(e) => setManualOnly(e.target.checked)} />
              Manual only
            </label>
          </div>
        }
      />
      <form onSubmit={save} className="p-5 grid grid-cols-1 md:grid-cols-[1fr_2fr_1fr_auto] gap-2 border-b border-border-subtle">
        <input value={sku} onChange={(e) => setSku(e.target.value)} className={`${INPUT} font-technical`} placeholder="SKU" />
        <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} className={INPUT} placeholder="Photo link https://…" />
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT} placeholder="Title (optional)" />
        <button type="submit" disabled={saving} className={`${BUTTON} bg-primary text-on-primary hover:bg-primary/90 justify-center`}>
          <span className="material-symbols-outlined text-sm">save</span>
          Save link
        </button>
      </form>
      {error && <div className="m-5 p-4 rounded-lg bg-critical/10 text-critical border border-critical/20">{error.message}</div>}
      <div className="p-5 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {images.map((image) => (
          <div key={`${image.sku_key}-${image.source}`} className="flex items-center gap-3 rounded-lg border border-border-subtle p-2">
            <SafeImage src={image.image_url} alt={image.title || image.sku} fallbackIcon="image_not_supported" className="w-14 h-14 rounded object-cover border border-border-subtle shrink-0 text-xl" />
            <div className="min-w-0 flex-1">
              <p className="font-technical text-[12px] text-on-surface truncate" title={image.sku}>{image.sku}</p>
              <p className="text-[12px] text-secondary truncate" title={image.title || ''}>{image.title || image.marketplace || '—'}</p>
              <span className={`inline-flex mt-1 px-1.5 py-0.5 rounded text-[10px] font-bold border ${image.source === 'manual' ? 'bg-warning/10 text-warning border-warning/20' : 'bg-surface-container text-on-surface-variant border-border-subtle'}`}>
                {image.source === 'manual' ? 'MANUAL' : image.source === 'forward-scan' ? 'FORWARD SCAN' : 'OMSGURU (OLD)'}
              </span>
            </div>
            {image.source === 'manual' && (
              <button type="button" onClick={() => remove(image.sku)} className="text-secondary hover:text-critical" aria-label={`Remove manual photo link for ${image.sku}`}>
                <span className="material-symbols-outlined">delete</span>
              </button>
            )}
          </div>
        ))}
        {images.length === 0 && !error && (
          <p className="text-body-sm text-secondary col-span-full">
            {manualOnly ? 'No manual photo links yet — add one above.' : 'No SKU photos match.'}
          </p>
        )}
      </div>
    </Card>
  );
}
