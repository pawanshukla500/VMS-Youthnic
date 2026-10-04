import React, { useState } from 'react';
import useSWR from 'swr';
import toast from 'react-hot-toast';
import { authFetch } from '../utils/authFetch';
import { getApiBaseUrl } from '../utils/apiBase';
import { auth } from '../utils/firebase';
import { PageHeader, Card, CardHeader, StatusBadge, EmptyState } from '../components/ui';

const API_URL = getApiBaseUrl();

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Failed to load Meesho flyer queue');
  return res.json();
};

export default function MeeshoFlyerLinkup() {
  const [statusFilter, setStatusFilter] = useState<'PENDING' | 'LINKED' | 'FAILED' | 'ALL'>('PENDING');
  const [searchTerm, setSearchTerm] = useState('');
  const [isFixingSwapped, setIsFixingSwapped] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [showHelperModal, setShowHelperModal] = useState(false);
  const [showCredsModal, setShowCredsModal] = useState(false);

  const { data, error, isLoading, mutate } = useSWR(
    `${API_URL}/api/meesho/flyer-queue?status=${statusFilter}`,
    fetcher,
    { refreshInterval: 8000 }
  );

  const items: any[] = data?.items || [];
  const stats = data?.stats || { totalScans: 0, pendingCount: 0, linkedCount: 0, failedCount: 0 };

  const filteredItems = items.filter((item) => {
    if (!searchTerm.trim()) return true;
    const term = searchTerm.toLowerCase();
    return (
      item.trackingId?.toLowerCase().includes(term) ||
      item.flyerId?.toLowerCase().includes(term) ||
      item.orderId?.toLowerCase().includes(term)
    );
  });

  const handleFixSwapped = async () => {
    if (!window.confirm('This will find all records where the Flyer ID (TP...) was accidentally scanned into Tracking ID, and swap them with the courier AWB (VL.../SF...). Proceed?')) {
      return;
    }
    setIsFixingSwapped(true);
    try {
      const res = await authFetch(`${API_URL}/api/meesho/flyer-queue/fix-swapped`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Failed to fix swapped records');
      const json = await res.json();
      toast.success(`Successfully repaired ${json.fixedCount} swapped barcode pairs!`);
      void mutate();
    } catch (err: any) {
      toast.error(err.message || 'Error repairing swapped barcodes');
    } finally {
      setIsFixingSwapped(false);
    }
  };

  const handleExportCsv = async () => {
    setIsExporting(true);
    try {
      const res = await authFetch(`${API_URL}/api/meesho/flyer-queue/export?status=${statusFilter}`);
      if (!res.ok) throw new Error('Failed to export CSV');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `meesho-flyer-scans-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success('Meesho Flyer CSV downloaded');
    } catch (err: any) {
      toast.error(err.message || 'Export failed');
    } finally {
      setIsExporting(false);
    }
  };

  const handleMarkStatus = async (item: any, newStatus: 'LINKED' | 'FAILED' | 'PENDING') => {
    try {
      const res = await authFetch(`${API_URL}/api/meesho/flyer-queue/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            {
              id: item.id,
              trackingId: item.trackingId,
              flyerId: item.flyerId,
              status: newStatus,
              remark: newStatus === 'LINKED' ? 'Marked linked manually' : 'Marked failed',
            },
          ],
        }),
      });
      if (!res.ok) throw new Error('Failed to update status');
      toast.success(`Marked as ${newStatus}`);
      void mutate();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update');
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-surface-bg">
      <PageHeader
        title="Meesho Flyer Link-up"
        description="Sync Transparent Packaging (TP...) barcodes with courier AWBs for Meesho Scan & Pack"
        actions={
          <div className="flex items-center gap-2">
            <a
              href="https://github.com/pawanshukla500/VMS-Youthnic/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-body-sm font-semibold transition-colors shadow-sm"
              title="Download installable Windows desktop app for auto-sync & CSV upload"
            >
              <span className="material-symbols-outlined text-sm">download_for_offline</span>
              Download App (.exe)
            </a>
            <button
              onClick={() => setShowHelperModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-container text-on-surface border border-outline-variant text-body-sm font-medium transition-colors"
            >
              <span className="material-symbols-outlined text-sm">help_outline</span>
              App Guide
            </button>
            <button
              onClick={() => setShowCredsModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 text-body-sm font-medium transition-colors"
              title="Save Meesho login Email & Password in database for 1-click companion app login"
            >
              <span className="material-symbols-outlined text-sm">key</span>
              Login Credentials
            </button>
            <button
              onClick={handleFixSwapped}
              disabled={isFixingSwapped}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-warning/10 hover:bg-warning/20 text-warning border border-warning/30 text-body-sm font-medium transition-colors disabled:opacity-50"
              title="Automatically swap records where TP was scanned as Tracking ID"
            >
              <span className="material-symbols-outlined text-sm">swap_horiz</span>
              Fix Swapped Scans
            </button>
            <button
              onClick={handleExportCsv}
              disabled={isExporting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary hover:bg-primary-hover text-white text-body-sm font-medium transition-colors disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-sm">download</span>
              Export Meesho CSV
            </button>
          </div>
        }
      />

      <main className="flex-1 overflow-auto p-gutter space-y-gutter">
        {/* Metric Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-surface-card rounded-lg border border-border-subtle p-4 shadow-sm">
            <p className="font-metadata text-metadata text-secondary uppercase tracking-wider">Total Scanned</p>
            <h3 className="font-headline-1 text-2xl font-bold text-on-surface mt-1">{stats.totalScans}</h3>
            <p className="font-body-sm text-xs text-secondary mt-1">Meesho parcels with flyer packet</p>
          </div>

          <div
            onClick={() => setStatusFilter('PENDING')}
            className={`cursor-pointer rounded-lg border p-4 shadow-sm transition-all ${
              statusFilter === 'PENDING'
                ? 'bg-warning/10 border-warning/40 ring-1 ring-warning/30'
                : 'bg-surface-card border-border-subtle hover:border-warning/30'
            }`}
          >
            <div className="flex justify-between items-center">
              <p className="font-metadata text-metadata text-warning uppercase tracking-wider font-semibold">Pending Link-up</p>
              <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
            </div>
            <h3 className="font-headline-1 text-2xl font-bold text-warning mt-1">{stats.pendingCount}</h3>
            <p className="font-body-sm text-xs text-secondary mt-1">Ready for Meesho Scan & Pack</p>
          </div>

          <div
            onClick={() => setStatusFilter('LINKED')}
            className={`cursor-pointer rounded-lg border p-4 shadow-sm transition-all ${
              statusFilter === 'LINKED'
                ? 'bg-success/10 border-success/40 ring-1 ring-success/30'
                : 'bg-surface-card border-border-subtle hover:border-success/30'
            }`}
          >
            <p className="font-metadata text-metadata text-success uppercase tracking-wider font-semibold">Linked on Meesho</p>
            <h3 className="font-headline-1 text-2xl font-bold text-success mt-1">{stats.linkedCount}</h3>
            <p className="font-body-sm text-xs text-secondary mt-1">Successfully synced packet IDs</p>
          </div>

          <div
            onClick={() => setStatusFilter('FAILED')}
            className={`cursor-pointer rounded-lg border p-4 shadow-sm transition-all ${
              statusFilter === 'FAILED'
                ? 'bg-critical/10 border-critical/40 ring-1 ring-critical/30'
                : 'bg-surface-card border-border-subtle hover:border-critical/30'
            }`}
          >
            <p className="font-metadata text-metadata text-critical uppercase tracking-wider font-semibold">Failed / Issues</p>
            <h3 className="font-headline-1 text-2xl font-bold text-critical mt-1">{stats.failedCount}</h3>
            <p className="font-body-sm text-xs text-secondary mt-1">Rejected or mismatched barcodes</p>
          </div>
        </div>

        {/* Filter Bar & Search */}
        <div className="flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-3">
          <div className="inline-flex rounded-lg bg-surface-container-low p-1 border border-border-subtle">
            {(['PENDING', 'LINKED', 'FAILED', 'ALL'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setStatusFilter(tab)}
                className={`px-3 py-1.5 rounded-md text-body-sm font-medium transition-colors ${
                  statusFilter === tab
                    ? 'bg-surface-card text-on-surface shadow-sm font-bold'
                    : 'text-secondary hover:text-on-surface'
                }`}
              >
                {tab === 'PENDING' ? 'Pending' : tab === 'LINKED' ? 'Linked' : tab === 'FAILED' ? 'Failed' : 'All Scans'}
              </button>
            ))}
          </div>

          <div className="relative min-w-[280px]">
            <input
              type="text"
              placeholder="Search Tracking ID or Flyer ID..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-surface-container border border-outline-variant rounded-lg text-body-sm text-on-surface placeholder:text-secondary focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <span className="material-symbols-outlined absolute left-2.5 top-2.5 text-secondary text-sm">search</span>
          </div>
        </div>

        {/* Queue Table */}
        <Card>
          <CardHeader
            icon="local_mall"
            title={`Meesho Flyer Queue (${filteredItems.length})`}
            description="Coupled Courier Tracking AWBs and Flyer Packet IDs"
          />

          {isLoading ? (
            <div className="p-8 text-secondary text-center">Loading flyer link-up queue...</div>
          ) : error ? (
            <div className="p-6 text-critical text-center">Error loading flyer queue: {error.message}</div>
          ) : filteredItems.length === 0 ? (
            <EmptyState
              icon="inventory_2"
              title="No records found in this view"
              hint="When packers scan Meesho parcels with flyer packets enabled, they will appear here in real-time."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[950px]">
                <thead className="bg-surface-container-low border-b border-border-subtle">
                  <tr>
                    <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Tracking ID (AWB)</th>
                    <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Flyer Packet ID</th>
                    <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Order ID</th>
                    <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Scanned At</th>
                    <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Station / Packer</th>
                    <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Link Status</th>
                    <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((item) => (
                    <tr key={item.id} className="border-b border-border-subtle hover:bg-surface-container-low/50 transition-colors">
                      <td className="p-4 font-technical font-medium text-on-surface">
                        <span className="px-2 py-0.5 rounded bg-surface-container font-mono text-sm border border-outline-variant/60">
                          {item.trackingId}
                        </span>
                      </td>
                      <td className="p-4 font-technical font-bold text-amber-400">
                        <span className="px-2 py-0.5 rounded bg-amber-500/10 font-mono text-sm border border-amber-500/30">
                          {item.flyerId}
                        </span>
                      </td>
                      <td className="p-4 font-technical text-secondary text-sm">{item.orderId || '—'}</td>
                      <td className="p-4 text-secondary text-sm">
                        {new Date(item.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true })}
                      </td>
                      <td className="p-4 text-secondary text-sm">
                        <div>{item.stationCode || 'Station'}</div>
                        <div className="text-xs text-secondary/70">{item.packerName || 'Packer'}</div>
                      </td>
                      <td className="p-4">
                        <StatusBadge status={item.status === 'LINKED' ? 'completed' : item.status === 'FAILED' ? 'failed' : 'pending'} />
                        {item.remark && <p className="text-[11px] text-secondary mt-1 max-w-[180px] truncate" title={item.remark}>{item.remark}</p>}
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-1.5">
                          {item.status !== 'LINKED' ? (
                            <button
                              onClick={() => handleMarkStatus(item, 'LINKED')}
                              title="Mark as linked on Meesho"
                              className="px-2.5 py-1 rounded text-xs font-semibold bg-success/10 text-success hover:bg-success/20 border border-success/30 transition-colors"
                            >
                              Mark Linked
                            </button>
                          ) : (
                            <button
                              onClick={() => handleMarkStatus(item, 'PENDING')}
                              title="Reset back to pending"
                              className="px-2 py-1 rounded text-xs text-secondary hover:text-on-surface hover:bg-surface-container transition-colors"
                            >
                              Reset
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </main>

      {/* Automation App Guide Modal */}
      {showHelperModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-surface-card border border-border-subtle rounded-xl max-w-2xl w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-border-subtle pb-3">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-2xl">desktop_windows</span>
                <h3 className="font-headline-1 text-lg font-bold text-on-surface">Meesho Flyer Link-up Desktop Application</h3>
              </div>
              <button
                onClick={() => setShowHelperModal(false)}
                className="text-secondary hover:text-on-surface p-1 rounded-lg"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="space-y-4 font-body-sm text-body-sm text-secondary">
              <div className="p-3 bg-primary/10 border border-primary/20 rounded-lg text-primary text-xs">
                <strong>🛡️ Why use the dedicated Windows Desktop App?</strong>
                <p className="mt-1">
                  Meesho supplier portal uses Cloudflare bot defense &amp; OTP verification on login. The desktop application runs on your local PC with a persistent user profile (<code className="bg-primary/20 px-1 rounded">persist:meesho_partition</code>). You log in with your normal credentials once, and all sessions and cookies are remembered securely with <strong>zero CAPTCHA/OTP interruptions</strong>.
                </p>
              </div>

              <div>
                <h4 className="font-bold text-on-surface mb-2">Available Operational Modes:</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="p-3 rounded-lg bg-surface-container border border-border-subtle space-y-1.5">
                    <div className="flex items-center gap-1.5 text-on-surface font-semibold text-xs">
                      <span className="material-symbols-outlined text-emerald-400 text-sm">sync</span>
                      Mode 1: Real-Time Auto-Sync
                    </div>
                    <p className="text-[12px] text-secondary">
                      Monitors this VMS server in real-time. Whenever a packer scans a courier AWB + TP flyer barcode, the app automatically types it into Meesho&apos;s &quot;Scan Barcoded Packets&quot; and marks it as linked.
                    </p>
                  </div>

                  <div className="p-3 rounded-lg bg-surface-container border border-border-subtle space-y-1.5">
                    <div className="flex items-center gap-1.5 text-on-surface font-semibold text-xs">
                      <span className="material-symbols-outlined text-amber-400 text-sm">upload_file</span>
                      Mode 2: CSV File Upload
                    </div>
                    <p className="text-[12px] text-secondary">
                      Upload an exported CSV or Excel scan file. The app reads every tracking &amp; flyer pair sequentially and pushes them into Meesho with live visual progress and error recovery.
                    </p>
                  </div>
                </div>
              </div>

              <div className="p-3.5 bg-surface-container-high rounded-xl border border-outline-variant flex flex-col sm:flex-row items-center justify-between gap-3">
                <div>
                  <h5 className="font-bold text-on-surface text-sm">Download Windows Installer (.exe)</h5>
                  <p className="text-xs text-secondary mt-0.5">Version 1.0.0 (x64) • Packaged with auto-update capability</p>
                </div>
                <a
                  href="https://github.com/pawanshukla500/VMS-Youthnic/releases"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-semibold text-xs transition-colors flex items-center gap-1.5 shadow-sm whitespace-nowrap"
                >
                  <span className="material-symbols-outlined text-sm">download</span>
                  Download from GitHub
                </a>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setShowHelperModal(false)}
                className="px-4 py-2 bg-primary text-white rounded-lg font-medium hover:bg-primary-hover text-sm transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Meesho Credentials Modal */}
      {showCredsModal && (
        <MeeshoCredentialsModal onClose={() => setShowCredsModal(false)} />
      )}
    </div>
  );
}

function MeeshoCredentialsModal({ onClose }: { onClose: () => void }) {
  const { data, mutate } = useSWR(`${API_URL}/api/meesho/settings`, fetcher, {
    revalidateOnFocus: false
  });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [supplierHubUrl, setSupplierHubUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [primed, setPrimed] = useState(false);

  if (data && !primed) {
    setPrimed(true);
    setUsername(data.username || '');
    setSupplierHubUrl(data.supplierHubUrl || 'https://supplier.meesho.com/panel/v3/new/root/login');
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await authFetch(`${API_URL}/api/meesho/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          ...(password ? { password: password.trim() } : {}),
          supplierHubUrl: supplierHubUrl.trim()
        })
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || `Failed with status ${res.status}`);
      setPassword('');
      toast.success('Meesho login credentials saved in database!');
      mutate();
      onClose();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save credentials');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-surface-card border border-border-subtle rounded-xl max-w-lg w-full p-6 shadow-2xl space-y-4">
        <div className="flex items-center justify-between border-b border-border-subtle pb-3">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-amber-500 text-2xl">key</span>
            <div>
              <h3 className="font-headline-1 text-lg font-bold text-on-surface">Meesho Login Credentials</h3>
              <p className="text-xs text-secondary">Stored in VMS database for 1-click companion app login</p>
            </div>
          </div>
          <button onClick={onClose} className="text-secondary hover:text-on-surface p-1 rounded-lg">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <form onSubmit={handleSave} className="space-y-3.5">
          <div>
            <label className="block text-xs font-semibold text-on-surface mb-1">Meesho Login Email / Mobile</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. seller@youthnic.com or 9876543210"
              className="w-full bg-surface-container border border-outline-variant rounded-lg p-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
              required
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-semibold text-on-surface">Meesho Password</label>
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="text-xs text-primary hover:underline"
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={data?.hasPassword ? '•••••••• (Saved in DB - leave blank to keep)' : 'Enter password'}
              className="w-full bg-surface-container border border-outline-variant rounded-lg p-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-on-surface mb-1">Supplier Hub Login URL</label>
            <input
              type="text"
              value={supplierHubUrl}
              onChange={(e) => setSupplierHubUrl(e.target.value)}
              placeholder="https://supplier.meesho.com/panel/v3/new/root/login"
              className="w-full bg-surface-container border border-outline-variant rounded-lg p-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          <div className="p-3 rounded-lg bg-surface-container border border-outline-variant text-xs text-secondary">
            ℹ️ <strong>Automatic Login:</strong> When you click &quot;Login&quot; in the desktop companion app, it automatically fetches these credentials from VMS and types them into Meesho. You never need to enter them again!
          </div>

          <div className="flex items-center justify-between p-3 rounded-lg bg-surface-container border border-outline-variant">
            <div>
              <span className="text-xs font-semibold text-on-surface block">Desktop Companion App</span>
              <span className="text-xs text-secondary">Connect installed desktop app in 1 click</span>
            </div>
            <button
              type="button"
              onClick={async () => {
                try {
                  const token = await auth.currentUser?.getIdToken();
                  if (!token) throw new Error('Not logged in');
                  const target = `vms-companion://connect?url=${encodeURIComponent(window.location.origin)}&token=${encodeURIComponent(token)}`;
                  window.location.href = target;
                  void navigator.clipboard?.writeText(token);
                  toast.success('Opened desktop app and copied token to clipboard!');
                } catch (e: any) {
                  toast.error(e.message || 'Could not connect app');
                }
              }}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-colors"
            >
              <span className="material-symbols-outlined text-xs">link</span>
              1-Click Connect App
            </button>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-outline-variant text-sm text-secondary hover:text-on-surface transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-semibold hover:bg-primary-hover transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Credentials'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

