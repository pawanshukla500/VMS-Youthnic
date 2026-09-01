import React, { useState } from 'react';
import useSWR from 'swr';
import { authFetch } from '../utils/authFetch';
import toast from 'react-hot-toast';
import { clearQueue } from '../utils/videoQueue';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Failed to load settings');
  return res.json();
};

function DashboardMetric({ title, value, icon, color = 'text-primary' }: { title: string; value: React.ReactNode; icon: string; color?: string }) {
  return (
    <div className="bg-surface-card border border-border-subtle rounded-2xl p-6 shadow-sm hover:shadow-md transition-shadow group flex items-center justify-between">
      <div>
        <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-2">{title}</p>
        <p className={`font-headline-1 text-3xl font-bold ${color}`}>{value}</p>
      </div>
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center opacity-80 group-hover:opacity-100 transition-opacity bg-surface-container ${color}`}>
        <span className="material-symbols-outlined text-2xl">{icon}</span>
      </div>
    </div>
  );
}

export default function Settings() {
  const { data, error, isLoading } = useSWR(`${API_URL}/api/admin/overview`, fetcher, {
    refreshInterval: 30000
  });
  const { data: retentionData, error: retentionError, isLoading: retentionLoading, mutate: mutateRetention } = useSWR(`${API_URL}/api/admin/retention-policies`, fetcher, {
    refreshInterval: 30000
  });

  const handleWipeData = async () => {
    if (!window.confirm('WARNING: You are about to permanently delete all scan records, videos, and order imports from the system. This cannot be undone.\n\nAre you sure you want to proceed?')) {
      return;
    }
    
    // Require user to type CONFIRM to prevent accidental clicks
    const confirmation = window.prompt('Type WIPE to confirm deletion of all data:');
    if (confirmation !== 'WIPE') {
      toast.error('Data wipe cancelled.');
      return;
    }

    try {
      // Clear the backend database
      const res = await authFetch(`${API_URL}/api/admin/clear-data`, {
        method: 'POST'
      });
      if (!res.ok) throw new Error('Failed to wipe data on server');

      // Clear the local indexedDB queue
      await clearQueue();

      toast.success('System data has been completely wiped.');
      
      // Refresh the page or data
      window.location.reload();
    } catch (err) {
      console.error('Failed to wipe data', err);
      toast.error('Failed to wipe system data');
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-surface-bg">
      <header className="bg-surface-container-lowest flex items-center px-gutter py-3 min-h-[64px] border-b border-border-subtle shrink-0">
        <h2 className="font-headline-1 text-headline-1 font-bold text-on-background">Admin Settings</h2>
      </header>
      <main className="flex-1 overflow-y-auto p-gutter space-y-6">
        {isLoading && <div className="p-8 text-secondary">Loading admin overview...</div>}
        {error && <div className="p-4 bg-error-container text-on-error-container rounded-lg">{error.message}</div>}
        {data && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-6">
              <DashboardMetric title="Team Users" value={data.users} icon="group" />
              <DashboardMetric title="Stations" value={`${data.stations.active}/${data.stations.total}`} icon="point_of_sale" />
              <DashboardMetric title="Videos" value={data.videos} icon="video_library" />
              <DashboardMetric title="Order Mappings" value={data.orderMappings} icon="receipt_long" />
              <DashboardMetric title="Marketplaces" value={data.marketplaces} icon="storefront" />
              <DashboardMetric title="Failed Uploads" value={data.failedUploads} icon="error" color="text-critical" />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
              <section className="bg-surface-card border border-border-subtle rounded-2xl shadow-sm overflow-hidden h-max flex flex-col">
                <div className="p-5 border-b border-border-subtle bg-surface-container-lowest flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                    <span className="material-symbols-outlined">hard_drive</span>
                  </div>
                  <h3 className="font-headline-2 text-headline-2 text-on-surface">Storage Usage</h3>
                </div>
                <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-6 bg-surface-bg/50 flex-1">
                  <div>
                    <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-2">Firebase Storage</p>
                    <p className="font-headline-1 text-3xl font-bold text-primary">{data.storage?.firebase?.formatted}</p>
                    <p className="font-metadata text-metadata text-secondary mt-1">{data.storage?.firebase?.fileCount} files</p>
                  </div>
                  <div>
                    <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-2">Database Metadata</p>
                    <p className="font-headline-1 text-3xl font-bold text-on-surface">{data.storage?.databaseFormatted}</p>
                    <p className="font-metadata text-metadata text-secondary mt-1">Recorded asset sizes</p>
                  </div>
                </div>
              </section>

              <section className="bg-surface-card border border-border-subtle rounded-2xl shadow-sm overflow-hidden h-max flex flex-col">
                <div className="p-5 border-b border-border-subtle bg-surface-container-lowest flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                    <span className="material-symbols-outlined">history</span>
                  </div>
                  <h3 className="font-headline-2 text-headline-2 text-on-surface">Recent Activity</h3>
                </div>
                <div className="divide-y divide-border-subtle">
                  {data.recentActivity.length === 0 && <div className="p-5 text-secondary">No activity yet.</div>}
                  {data.recentActivity.map((item: any, index: number) => (
                    <div key={`${item.tracking_id}-${index}`} className="p-4 flex justify-between gap-4">
                      <div>
                        <p className="font-technical text-body-sm text-on-surface">{item.order_id || item.tracking_id || 'UNKNOWN'}</p>
                        <p className="font-metadata text-metadata text-secondary">{item.marketplace || 'Unassigned'}{item.order_id ? ` | Tracking ${item.tracking_id || 'UNKNOWN'}` : ''}</p>
                        <p className="font-metadata text-metadata text-secondary">{new Date(item.created_at).toLocaleString()}</p>
                      </div>
                      <span className="font-metadata text-metadata text-secondary">{item.upload_status || item.status || 'pending'}</span>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            <section className="bg-error-container border border-error/20 rounded-lg shadow-sm overflow-hidden mb-6">
              <div className="p-5 border-b border-error/10 bg-error/5">
                <h3 className="font-headline-2 text-headline-2 text-on-error-container flex items-center gap-2">
                  <span className="material-symbols-outlined text-error">warning</span>
                  Danger Zone
                </h3>
              </div>
              <div className="p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
                <div>
                  <p className="font-body-lg font-bold text-on-error-container">Wipe All System Data</p>
                  <p className="font-body-sm text-on-error-container/80 mt-1">Permanently delete all videos, scan records, order imports, and clear the local upload queue. This will give you a completely fresh start.</p>
                </div>
                <button
                  onClick={handleWipeData}
                  className="px-4 py-2 bg-error text-white font-medium rounded-lg hover:bg-error/90 transition-colors shrink-0 flex items-center gap-2 shadow-sm"
                >
                  <span className="material-symbols-outlined text-sm">delete_forever</span>
                  Wipe Data
                </button>
              </div>
            </section>

            <RetentionPolicies
              rows={retentionData?.policies || []}
              isLoading={retentionLoading}
              error={retentionError}
              onSaved={() => mutateRetention()}
            />
          </>
        )}
      </main>
    </div>
  );
}

function RetentionPolicies({ rows, isLoading, error, onSaved }: { rows: any[]; isLoading: boolean; error: any; onSaved: () => void }) {
  return (
    <section className="bg-surface-card border border-border-subtle rounded-lg shadow-sm overflow-hidden">
      <div className="p-5 border-b border-border-subtle">
        <h3 className="font-headline-2 text-headline-2 text-on-surface">Marketplace Retention</h3>
      </div>
      {isLoading && <div className="p-5 text-secondary">Loading retention policies...</div>}
      {error && <div className="p-4 bg-error-container text-on-error-container">{error.message}</div>}
      {!isLoading && !error && (
        <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[860px]">
            <thead className="bg-surface-container-low border-b border-border-subtle">
              <tr>
                <th className="p-4 font-metadata text-metadata text-secondary">Marketplace</th>
                <th className="p-4 font-metadata text-metadata text-secondary">Videos</th>
                <th className="p-4 font-metadata text-metadata text-secondary">Video Days</th>
                <th className="p-4 font-metadata text-metadata text-secondary">Data Days</th>
                <th className="p-4 font-metadata text-metadata text-secondary">Updated</th>
                <th className="p-4"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <RetentionRow key={row.marketplace} row={row} onSaved={onSaved} />
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="p-8 text-center text-secondary">No marketplaces found yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RetentionRow({ row, onSaved }: { row: any; onSaved: () => void }) {
  const [videoDays, setVideoDays] = useState(row.video_retention_days ?? '');
  const [dataDays, setDataDays] = useState(row.data_retention_days ?? '');
  const [saving, setSaving] = useState(false);

  const savePolicy = async () => {
    setSaving(true);
    try {
      const res = await authFetch(`${API_URL}/api/admin/retention-policies`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketplace: row.marketplace,
          videoRetentionDays: videoDays === '' ? null : Number(videoDays),
          dataRetentionDays: dataDays === '' ? null : Number(dataDays)
        })
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `Save failed with status ${res.status}`);
      toast.success('Retention policy saved');
      onSaved();
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : 'Failed to save policy');
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr className="border-b border-border-subtle hover:bg-surface-bg">
      <td className="p-4 text-on-surface">{row.marketplace}</td>
      <td className="p-4 font-technical text-secondary">{row.videos || row.recordings || 0}</td>
      <td className="p-4">
        <input
          type="number"
          min="1"
          max="3650"
          value={videoDays}
          onChange={(event) => setVideoDays(event.target.value)}
          className="w-28 bg-surface-bg border border-border-heavy rounded px-3 py-2 font-technical text-technical focus:outline-none focus:border-primary"
          placeholder="blank"
        />
      </td>
      <td className="p-4">
        <input
          type="number"
          min="1"
          max="3650"
          value={dataDays}
          onChange={(event) => setDataDays(event.target.value)}
          className="w-28 bg-surface-bg border border-border-heavy rounded px-3 py-2 font-technical text-technical focus:outline-none focus:border-primary"
          placeholder="blank"
        />
      </td>
      <td className="p-4 text-secondary">{row.updated_at ? new Date(row.updated_at).toLocaleString() : '-'}</td>
      <td className="p-4 text-right">
        <button
          type="button"
          onClick={savePolicy}
          disabled={saving}
          className="px-4 py-2 bg-primary text-on-primary rounded-lg font-medium disabled:opacity-50"
        >
          Save
        </button>
      </td>
    </tr>
  );
}
