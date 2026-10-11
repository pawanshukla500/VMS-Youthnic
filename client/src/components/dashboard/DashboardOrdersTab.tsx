import React, { useState, useMemo } from 'react';
import useSWR from 'swr';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  Filter,
  Layers,
  Package,
  PackageCheck,
  PackageOpen,
  RefreshCw,
  Search,
  ShoppingBag,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { authFetch } from '../../utils/authFetch';
import { getApiBaseUrl } from '../../utils/apiBase';
import { Card, EmptyState, SafeImage } from '../ui';
import { CarrierBadge, MarketplaceLogoBadge } from '../LogisticsBadges';
import { CARRIER_REGISTRY, detectCarrier } from '../../utils/logisticsLogos';
import { useAuth } from '../../context/AuthContext';
import { isAdminRole } from '../../utils/roles';

const API_URL = getApiBaseUrl();
const PAGE_SIZE = 30;

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Failed to load synced orders');
  return body;
};

export function DashboardOrdersTab() {
  const { role } = useAuth();
  const canSync = isAdminRole(role);

  // Sub-tabs for order status filtering
  const [subTab, setSubTab] = useState<'all' | 'packed' | 'pending' | 'flyer' | 'issues'>('all');
  const [search, setSearch] = useState('');
  const [carrierFilter, setCarrierFilter] = useState('all');
  const [marketplaceFilter, setMarketplaceFilter] = useState('all');
  const [offset, setOffset] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<any | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedOrder) {
        setSelectedOrder(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedOrder]);

  const query = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (search.trim()) query.set('search', search.trim());
  if (marketplaceFilter !== 'all') query.set('marketplace', marketplaceFilter);

  const { data: status, mutate: mutateStatus } = useSWR(
    `${API_URL}/api/admin/forward-scan/status`,
    fetcher,
    { refreshInterval: 30000 }
  );

  const { data, error, isLoading, mutate } = useSWR(
    `${API_URL}/api/synced-orders?${query.toString()}`,
    fetcher,
    { refreshInterval: 20000 }
  );

  const rawOrders: any[] = data?.orders || [];
  const totalCount = Number(data?.total || 0);

  // Client-side filtering across sub-tabs and courier filter
  const filteredOrders = useMemo(() => {
    return rawOrders.filter((order) => {
      // Sub-tab filtering
      if (subTab === 'packed') {
        const isPacked = Boolean(order.packed_at || order.has_video || order.status === 'PACKED');
        if (!isPacked) return false;
      } else if (subTab === 'pending') {
        const isPacked = Boolean(order.packed_at || order.has_video || order.status === 'PACKED');
        const isCancelled = order.status_group === 'CANCELLED' || order.status === 'CANCELLED';
        if (isPacked || isCancelled) return false;
      } else if (subTab === 'flyer') {
        if (!order.flyer_id && !/^TP/i.test(order.tracking_id || '')) return false;
      } else if (subTab === 'issues') {
        const isIssue =
          order.status_group === 'CANCELLED' ||
          order.status_group === 'RETURN' ||
          order.status_group === 'PARTIAL_CANCEL' ||
          order.status === 'CANCELLED';
        if (!isIssue) return false;
      }

      // Carrier filter
      if (carrierFilter !== 'all') {
        const detected = detectCarrier(order.tracking_id);
        if (detected?.code.toLowerCase() !== carrierFilter.toLowerCase()) return false;
      }

      return true;
    });
  }, [rawOrders, subTab, carrierFilter]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      const res = await authFetch(`${API_URL}/api/admin/forward-scan/sync`, { method: 'POST' });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || `Sync failed with status ${res.status}`);
      toast.success(
        `Forward Scan: ${result.ordersRead} orders found, ${result.ordersWritten} updated, ${result.photosWritten} photos cached.`
      );
      void mutate();
      void mutateStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Top Controls & Status Bar */}
      <div className="bg-white border border-border-subtle rounded-2xl p-5 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="font-headline text-lg font-bold text-on-surface">Orders Central Hub</h2>
          <p className="text-secondary text-xs mt-0.5">
            Synchronized orders from Forward Scan database · Retaining last{' '}
            <span className="font-semibold text-primary">{status?.retentionDays || 3} days</span> of dispatches
          </p>
        </div>

        <div className="flex items-center gap-2 self-start md:self-auto">
          {canSync && (
            <button
              type="button"
              onClick={syncNow}
              disabled={syncing}
              className="px-3.5 py-2 rounded-lg bg-primary text-white font-medium text-xs flex items-center gap-2 hover:bg-primary/90 transition-all shadow-xs disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing...' : 'Sync Forward Scan'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void mutate()}
            className="px-3 py-2 rounded-lg bg-surface-container-low text-on-surface hover:bg-surface-container border border-border-heavy text-xs font-medium flex items-center gap-1.5 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5 text-secondary" />
            Refresh
          </button>
        </div>
      </div>

      {/* Sub-Tabs: All / Packed / Pending / Flyer / Issues */}
      <div className="border-b border-border-subtle flex flex-wrap gap-2" role="tablist" aria-label="Order status sub-tabs">
        <OrderTabButton
          label="All Orders"
          icon={<Layers className="w-4 h-4" />}
          count={totalCount}
          active={subTab === 'all'}
          onClick={() => {
            setSubTab('all');
            setOffset(0);
          }}
        />
        <OrderTabButton
          label="Packed / Recorded"
          icon={<PackageCheck className="w-4 h-4" />}
          active={subTab === 'packed'}
          onClick={() => {
            setSubTab('packed');
            setOffset(0);
          }}
        />
        <OrderTabButton
          label="Pending Queue"
          icon={<PackageOpen className="w-4 h-4" />}
          active={subTab === 'pending'}
          onClick={() => {
            setSubTab('pending');
            setOffset(0);
          }}
        />
        <OrderTabButton
          label="Meesho Flyer Linked"
          icon={<ShoppingBag className="w-4 h-4" />}
          active={subTab === 'flyer'}
          onClick={() => {
            setSubTab('flyer');
            setOffset(0);
          }}
        />
        <OrderTabButton
          label="Cancelled & Issues"
          icon={<AlertTriangle className="w-4 h-4" />}
          active={subTab === 'issues'}
          onClick={() => {
            setSubTab('issues');
            setOffset(0);
          }}
        />
      </div>

      {/* Search and Filters Bar */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center">
        <div className="md:col-span-5 relative">
          <Search className="w-4 h-4 text-secondary absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search tracking AWB, order ID, or SKU..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
            className="w-full pl-10 pr-4 py-2 bg-white border border-border-heavy rounded-xl text-xs text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all shadow-xs"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-secondary hover:text-on-surface"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Carrier Filter */}
        <div className="md:col-span-4 flex items-center gap-1.5">
          <label className="text-xs font-semibold text-secondary shrink-0">Courier:</label>
          <select
            value={carrierFilter}
            onChange={(e) => setCarrierFilter(e.target.value)}
            className="w-full bg-white border border-border-heavy rounded-xl px-3 py-2 text-xs text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all shadow-2xs"
          >
            <option value="all">All Couriers & Logistics</option>
            {Object.values(CARRIER_REGISTRY).map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({c.code})
              </option>
            ))}
          </select>
        </div>

        {/* Marketplace Filter */}
        <div className="md:col-span-3 flex items-center gap-1.5">
          <label className="text-xs font-semibold text-secondary shrink-0">Marketplace:</label>
          <select
            value={marketplaceFilter}
            onChange={(e) => {
              setMarketplaceFilter(e.target.value);
              setOffset(0);
            }}
            className="w-full bg-white border border-border-heavy rounded-xl px-3 py-2 text-xs text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all shadow-2xs"
          >
            <option value="all">All Marketplaces</option>
            <option value="Meesho">Meesho</option>
            <option value="AJIO">AJIO</option>
            <option value="Shopify">Shopify</option>
            <option value="Flipkart">Flipkart</option>
            <option value="Amazon">Amazon</option>
          </select>
        </div>
      </div>

      {/* Orders Table Card */}
      <Card className="overflow-hidden">
        {isLoading && (
          <div className="p-12 flex flex-col items-center justify-center gap-3 text-secondary">
            <RefreshCw className="w-6 h-6 animate-spin text-primary" />
            <p className="text-xs font-medium">Loading synchronized orders...</p>
          </div>
        )}

        {error && (
          <div className="p-6 bg-critical/5 text-critical border-b border-critical/20 flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 shrink-0" />
            <p className="text-xs">{error.message || 'Error loading orders'}</p>
          </div>
        )}

        {!isLoading && !error && filteredOrders.length === 0 && (
          <div className="p-10">
            <EmptyState
              icon="inventory_2"
              title="No orders found"
              hint={
                search || carrierFilter !== 'all' || marketplaceFilter !== 'all'
                  ? 'Try clearing the search or changing the courier and marketplace filters.'
                  : 'Orders will appear here once Forward Scan copies recent dispatches.'
              }
            />
          </div>
        )}

        {!isLoading && !error && filteredOrders.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-surface-container-lowest border-b border-border-subtle text-secondary font-label uppercase tracking-wider text-[11px]">
                  <th className="py-3 px-4">Marketplace & Order #</th>
                  <th className="py-3 px-4">Courier AWB & Partner</th>
                  <th className="py-3 px-4">Flyer Packet ID</th>
                  <th className="py-3 px-4">Items & SKUs</th>
                  <th className="py-3 px-4">Order Status</th>
                  <th className="py-3 px-4">Packing State</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle/70 text-xs">
                {filteredOrders.map((order) => {
                  const isCancelled =
                    order.status_group === 'CANCELLED' ||
                    order.status === 'CANCELLED' ||
                    order.status_group === 'RETURN';
                  const isPacked = Boolean(order.packed_at || order.has_video || order.status === 'PACKED');
                  const items: any[] = Array.isArray(order.items) ? order.items : [];

                  return (
                    <tr
                      key={order.id || order.order_id || order.tracking_id}
                      className="hover:bg-surface-container-low/70 transition-colors"
                    >
                      {/* Marketplace & Order # */}
                      <td className="py-3 px-4">
                        <div className="space-y-1">
                          <MarketplaceLogoBadge marketplace={order.marketplace} size="xs" />
                          <div className="font-mono font-semibold text-on-surface">
                            {order.order_number || order.order_id || '—'}
                          </div>
                          <div className="text-[10px] text-secondary">
                            {order.created_at ? new Date(order.created_at).toLocaleDateString() : '—'}
                          </div>
                        </div>
                      </td>

                      {/* Courier AWB & Brandfetch Badge */}
                      <td className="py-3 px-4">
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono font-bold text-on-surface text-xs">
                              {order.tracking_id || '—'}
                            </span>
                            {order.tracking_id && (
                              <button
                                type="button"
                                title="Copy tracking AWB"
                                onClick={() => copyToClipboard(order.tracking_id, order.id)}
                                className="text-secondary hover:text-primary transition-colors"
                              >
                                {copiedId === order.id ? (
                                  <Check className="w-3.5 h-3.5 text-success" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                            )}
                          </div>
                          <CarrierBadge trackingId={order.tracking_id} size="xs" />
                        </div>
                      </td>

                      {/* Flyer ID */}
                      <td className="py-3 px-4">
                        {order.flyer_id ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono font-semibold text-[11px] bg-amber-500/10 text-amber-700 border border-amber-500/20">
                            <ShoppingBag className="w-3 h-3" />
                            {order.flyer_id}
                          </span>
                        ) : (
                          <span className="text-secondary text-xs italic">—</span>
                        )}
                      </td>

                      {/* Items */}
                      <td className="py-3 px-4">
                        <div className="space-y-1.5 max-w-xs">
                          {items.length === 0 ? (
                            <span className="text-secondary italic text-xs">No items</span>
                          ) : (
                            items.slice(0, 2).map((item, idx) => (
                              <div key={idx} className="flex items-center gap-2">
                                {item.image_url ? (
                                  <div className="w-7 h-7 rounded border border-border-subtle overflow-hidden shrink-0 bg-surface-container-low">
                                    <SafeImage
                                      src={item.image_url}
                                      alt={item.sku || 'Product'}
                                      className="w-full h-full object-cover"
                                    />
                                  </div>
                                ) : (
                                  <div className="w-7 h-7 rounded border border-border-subtle flex items-center justify-center shrink-0 bg-surface-container-low text-secondary text-[10px]">
                                    <Package className="w-3.5 h-3.5" />
                                  </div>
                                )}
                                <div className="truncate text-xs">
                                  <span className="font-mono font-semibold text-on-surface">
                                    {item.sku || 'SKU'}
                                  </span>
                                  <span className="text-secondary ml-1.5">×{item.quantity || 1}</span>
                                </div>
                              </div>
                            ))
                          )}
                          {items.length > 2 && (
                            <span className="text-[10px] text-secondary font-medium block">
                              +{items.length - 2} more item(s)
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Status */}
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded text-[11px] font-semibold border ${
                            isCancelled
                              ? 'bg-critical/10 text-critical border-critical/20'
                              : 'bg-surface-container text-on-surface-variant border-border-subtle'
                          }`}
                        >
                          {order.status || order.status_group || 'CONFIRMED'}
                        </span>
                      </td>

                      {/* Packing State */}
                      <td className="py-3 px-4">
                        {isPacked ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-success/10 text-success border border-success/20">
                            <CheckCircle2 className="w-3 h-3" />
                            Packed
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-surface-container text-secondary border border-border-subtle">
                            <PackageOpen className="w-3 h-3" />
                            Ready
                          </span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => setSelectedOrder(order)}
                          className="px-2.5 py-1 rounded bg-surface-container-low hover:bg-surface-container text-primary font-medium text-xs inline-flex items-center gap-1 transition-colors border border-border-subtle"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          Details
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Bar */}
        <div className="p-4 bg-white border-t border-border-subtle flex items-center justify-between text-xs text-secondary">
          <div>
            Showing <span className="font-semibold text-on-surface">{filteredOrders.length}</span> order(s) ·{' '}
            Total records: <span className="font-semibold text-on-surface">{totalCount}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
              className="px-3 py-1.5 rounded-lg border border-border-heavy bg-white text-on-surface hover:bg-surface-container disabled:opacity-40 transition-colors"
            >
              Previous
            </button>
            <span className="font-mono text-on-surface">
              Page {Math.floor(offset / PAGE_SIZE) + 1}
            </span>
            <button
              type="button"
              disabled={offset + PAGE_SIZE >= totalCount}
              onClick={() => setOffset((prev) => prev + PAGE_SIZE)}
              className="px-3 py-1.5 rounded-lg border border-border-heavy bg-white text-on-surface hover:bg-surface-container disabled:opacity-40 transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      </Card>

      {/* Order Details Drawer Modal */}
      {selectedOrder && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-xl border border-border-subtle animate-in fade-in zoom-in-95 duration-150">
            <div className="p-5 border-b border-border-subtle flex items-center justify-between bg-surface-container-lowest">
              <div className="flex items-center gap-3">
                <MarketplaceLogoBadge marketplace={selectedOrder.marketplace} size="sm" />
                <h3 className="font-headline font-bold text-lg text-on-surface">
                  Order #{selectedOrder.order_number || selectedOrder.order_id}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedOrder(null)}
                className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-surface-container text-secondary transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-6">
              {/* Courier & AWB block */}
              <div className="bg-surface-container-low rounded-xl p-4 border border-border-subtle grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-[11px] font-semibold text-secondary uppercase tracking-wider block mb-1">
                    Courier Partner & AWB
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-sm text-on-surface">
                      {selectedOrder.tracking_id}
                    </span>
                    <CarrierBadge trackingId={selectedOrder.tracking_id} size="sm" />
                  </div>
                </div>

                {selectedOrder.flyer_id && (
                  <div>
                    <label className="text-[11px] font-semibold text-secondary uppercase tracking-wider block mb-1">
                      Meesho Flyer Barcode
                    </label>
                    <span className="font-mono font-bold text-sm text-amber-700 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20 inline-block">
                      {selectedOrder.flyer_id}
                    </span>
                  </div>
                )}
              </div>

              {/* Items List */}
              <div>
                <h4 className="font-headline font-bold text-sm text-on-surface mb-3">
                  Parcel Contents ({selectedOrder.items?.length || 0} items)
                </h4>
                <div className="space-y-3">
                  {(selectedOrder.items || []).map((item: any, idx: number) => (
                    <div
                      key={idx}
                      className="flex items-center gap-4 p-3 rounded-xl border border-border-subtle bg-white hover:border-primary/30 transition-all"
                    >
                      {item.image_url ? (
                        <div className="w-14 h-14 rounded-lg border border-border-subtle overflow-hidden shrink-0 bg-surface-container-low">
                          <SafeImage
                            src={item.image_url}
                            alt={item.sku}
                            className="w-full h-full object-cover"
                          />
                        </div>
                      ) : (
                        <div className="w-14 h-14 rounded-lg border border-border-subtle flex items-center justify-center shrink-0 bg-surface-container-low text-secondary">
                          <Package className="w-6 h-6" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-mono font-bold text-sm text-on-surface truncate">
                          {item.sku}
                        </div>
                        <p className="text-secondary text-xs truncate mt-0.5">
                          {item.title || 'Product item'}
                        </p>
                      </div>
                      <div className="font-mono text-sm font-semibold text-on-surface px-3 py-1 rounded bg-surface-container">
                        × {item.quantity || 1}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Metadata */}
              <div className="text-xs text-secondary space-y-1.5 border-t border-border-subtle pt-4">
                <div className="flex justify-between">
                  <span>Source:</span>
                  <span className="font-mono text-on-surface font-medium">
                    {selectedOrder.source || 'Forward Scan VPS'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Created Timestamp:</span>
                  <span className="font-mono text-on-surface">
                    {selectedOrder.created_at ? new Date(selectedOrder.created_at).toLocaleString() : '—'}
                  </span>
                </div>
              </div>
            </div>

            <div className="p-4 border-t border-border-subtle bg-surface-container-lowest flex justify-end">
              <button
                type="button"
                onClick={() => setSelectedOrder(null)}
                className="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface font-medium text-xs transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OrderTabButton({
  label,
  icon,
  count,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`px-4 py-2.5 rounded-t-xl text-xs font-semibold flex items-center gap-2 border-b-2 transition-all cursor-pointer ${
        active
          ? 'border-primary text-primary bg-primary/5 font-bold'
          : 'border-transparent text-secondary hover:text-on-surface hover:bg-surface-container-low'
      }`}
    >
      {icon}
      <span>{label}</span>
      {typeof count === 'number' && (
        <span
          className={`px-2 py-0.5 rounded-full text-[10px] font-mono ${
            active ? 'bg-primary text-white' : 'bg-surface-container text-secondary'
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}
