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
            <div className="bg-surface-card border border-border-subtle rounded-lg p-6 shadow-sm flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <p className="font-metadata text-metadata text-secondary uppercase tracking-wider">Overall Status</p>
                <p className={`font-headline-1 text-4xl ${statusTone}`}>{data.status}</p>
              </div>
              <div className="text-right">
                <p className="font-metadata text-metadata text-secondary">Checked</p>
                <p className="font-technical text-body-sm">{new Date(data.checkedAt).toLocaleString()}</p>
                <p className="font-metadata text-metadata text-secondary mt-2">{data.responseMs} ms</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {Object.entries(data.services).map(([name, status]) => (
                <div key={name} className="bg-surface-card border border-border-subtle rounded-lg p-5 shadow-sm">
                  <p className="font-metadata text-metadata text-secondary uppercase tracking-wider">{name}</p>
                  <p className={`font-headline-2 text-headline-2 mt-2 ${status === 'OK' ? 'text-success' : 'text-critical'}`}>{String(status)}</p>
                </div>
              ))}
            </div>

            <div className="bg-surface-card border border-border-subtle rounded-lg p-5 shadow-sm">
              <h3 className="font-headline-2 text-headline-2 mb-4">Storage</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <p className="font-metadata text-metadata text-secondary">Bucket</p>
                  <p className="font-technical text-body-sm break-all">{data.firebaseStorage.bucket || 'Not configured'}</p>
                </div>
                <div>
                  <p className="font-metadata text-metadata text-secondary">Usage</p>
                  <p className="font-headline-2 text-headline-2">{data.firebaseStorage.formatted}</p>
                </div>
                <div>
                  <p className="font-metadata text-metadata text-secondary">Files</p>
                  <p className="font-headline-2 text-headline-2">{data.firebaseStorage.fileCount}</p>
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
