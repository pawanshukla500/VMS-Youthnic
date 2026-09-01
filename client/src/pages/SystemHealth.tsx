import React from 'react';
import useSWR from 'swr';
import { authFetch } from '../utils/authFetch';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Failed to load system health');
  return res.json();
};

export default function SystemHealth() {
  const { data, error, isLoading } = useSWR(`${API_URL}/api/admin/system-health`, fetcher, {
    refreshInterval: 15000
  });

  const statusTone = data?.status === 'OK' ? 'text-success' : 'text-warning';

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-surface-bg">
      <header className="bg-surface-container-lowest flex items-center px-gutter py-3 min-h-[64px] border-b border-border-subtle shrink-0">
        <h2 className="font-headline-1 text-headline-1 font-bold text-on-background">System Health</h2>
      </header>
      <main className="flex-1 overflow-y-auto p-gutter space-y-6">
        {isLoading && <div className="p-8 text-secondary">Checking services...</div>}
        {error && <div className="p-4 bg-error-container text-on-error-container rounded-lg">{error.message}</div>}
        {data && (
          <>
            <div className="bg-surface-card border border-border-subtle rounded-2xl p-6 shadow-sm flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 relative overflow-hidden">
              <div className="absolute top-0 left-0 w-1 h-full bg-success"></div>
              <div>
                <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-1">Overall System Status</p>
                <div className="flex items-center gap-2">
                  <span className={`material-symbols-outlined text-4xl ${statusTone}`}>
                    {data.status === 'OK' ? 'check_circle' : 'warning'}
                  </span>
                  <p className={`font-headline-1 text-4xl font-bold ${statusTone}`}>{data.status}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="font-metadata text-metadata text-secondary mb-1">Last Checked</p>
                <p className="font-technical text-body-sm font-medium text-on-surface">{new Date(data.checkedAt).toLocaleString()}</p>
                <p className="font-metadata text-metadata text-secondary mt-1 flex items-center justify-end gap-1">
                  <span className="material-symbols-outlined text-[14px]">timer</span>
                  {data.responseMs} ms
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {Object.entries(data.services).map(([name, status]) => {
                const isOk = status === 'OK';
                const iconMap: Record<string, string> = {
                  api: 'api',
                  database: 'database',
                  authentication: 'vpn_key',
                  firebaseStorage: 'cloud_done'
                };
                return (
                  <div key={name} className="bg-surface-card border border-border-subtle rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow group flex flex-col justify-between min-h-[120px]">
                    <div className="flex justify-between items-start">
                      <p className="font-metadata text-metadata text-secondary uppercase tracking-wider">{name.replace(/([A-Z])/g, ' $1').trim()}</p>
                      <span className={`material-symbols-outlined opacity-50 group-hover:opacity-100 transition-opacity ${isOk ? 'text-success' : 'text-critical'}`}>
                        {iconMap[name] || 'settings_system_daydream'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-4">
                      <div className={`w-2 h-2 rounded-full ${isOk ? 'bg-success animate-pulse' : 'bg-critical'}`}></div>
                      <p className={`font-headline-2 text-headline-2 ${isOk ? 'text-success' : 'text-critical'}`}>{String(status)}</p>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="bg-surface-card border border-border-subtle rounded-xl shadow-sm overflow-hidden">
              <div className="p-5 border-b border-border-subtle bg-surface-container-lowest flex items-center gap-2">
                <span className="material-symbols-outlined text-primary">hard_drive</span>
                <h3 className="font-headline-2 text-headline-2 text-on-surface">Storage Metrics</h3>
              </div>
              <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-8">
                <div>
                  <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-2">Primary Bucket</p>
                  <p className="font-technical text-body-lg text-on-surface break-all bg-surface-container rounded-lg p-2 border border-outline-variant inline-block">
                    {data.storage?.firebase?.bucket || 'Not configured'}
                  </p>
                </div>
                <div>
                  <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-2">Storage Usage</p>
                  <p className="font-headline-1 text-3xl font-bold text-primary">{data.storage?.firebase?.formatted}</p>
                </div>
                <div>
                  <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-2">Total Files</p>
                  <p className="font-headline-1 text-3xl font-bold text-on-surface">{data.storage?.firebase?.fileCount}</p>
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
