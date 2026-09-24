import React from 'react';
import useSWR from 'swr';
import { authFetch } from '../utils/authFetch';
import { getApiBaseUrl } from '../utils/apiBase';
import { PageHeader, Card, CardHeader, StatusBadge } from '../components/ui';

const API_URL = getApiBaseUrl();

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
      <PageHeader title="System Health" description="Live service status and storage metrics" />
      <main className="flex-1 overflow-y-auto p-gutter space-y-6">
        {isLoading && (
          <div className="space-y-6" aria-busy="true">
            <Card>
              <div className="p-6 animate-pulse">
                <div className="h-3 w-40 rounded bg-surface-container mb-4"></div>
                <div className="h-9 w-32 rounded bg-surface-container"></div>
              </div>
            </Card>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[0, 1, 2, 3].map((i) => (
                <Card key={i}>
                  <div className="p-5 animate-pulse">
                    <div className="h-3 w-1/2 rounded bg-surface-container mb-4"></div>
                    <div className="h-6 w-20 rounded bg-surface-container"></div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}
        {error && (
          <div className="p-4 bg-critical/10 text-critical border border-critical/20 rounded-lg flex items-start gap-2">
            <span className="material-symbols-outlined">error</span>
            <p className="font-body-sm text-body-sm">{error.message}</p>
          </div>
        )}
        {data && (
          <>
            <Card>
              <div className="p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 relative overflow-hidden">
                <div className={`absolute top-0 left-0 w-1 h-full ${data.status === 'OK' ? 'bg-success' : 'bg-warning'}`}></div>
                <div>
                  <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-1">Overall System Status</p>
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className={`material-symbols-outlined text-4xl ${statusTone}`}>
                      {data.status === 'OK' ? 'check_circle' : 'warning'}
                    </span>
                    <p className={`font-headline-1 text-4xl font-bold ${statusTone}`}>{data.status}</p>
                    <StatusBadge status={data.status} pulse={data.status === 'OK'} />
                  </div>
                </div>
                <div className="sm:text-right">
                  <p className="font-metadata text-metadata text-secondary mb-1">Last Checked</p>
                  <p className="font-technical text-body-sm font-medium text-on-surface">{new Date(data.checkedAt).toLocaleString()}</p>
                  <p className="font-metadata text-metadata text-secondary mt-1 flex items-center sm:justify-end gap-1">
                    <span className="material-symbols-outlined text-[14px]">timer</span>
                    {data.responseMs} ms
                  </p>
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader icon="settings_system_daydream" title="Services" description="Live status per dependency" />
              <div className="p-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  {Object.entries(data.services).map(([name, status]) => {
                    const isOk = status === 'OK';
                    const iconMap: Record<string, string> = {
                      api: 'api',
                      database: 'database',
                      authentication: 'vpn_key',
                      firebaseStorage: 'cloud_done'
                    };
                    return (
                      <div key={name} className="bg-surface-container border border-border-subtle rounded-xl p-4 flex flex-col gap-3">
                        <div className="flex justify-between items-start gap-2">
                          <p className="font-metadata text-metadata text-secondary uppercase tracking-wider">{name.replace(/([A-Z])/g, ' $1').trim()}</p>
                          <span className={`material-symbols-outlined ${isOk ? 'text-success' : 'text-critical'}`}>
                            {iconMap[name] || 'settings_system_daydream'}
                          </span>
                        </div>
                        <StatusBadge status={String(status)} pulse={isOk} />
                      </div>
                    );
                  })}
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader icon="hard_drive" title="Storage Metrics" description="Firebase bucket usage" />
              <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-8">
                <div>
                  <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-2">Primary Bucket</p>
                  <p className="font-technical text-body-lg text-on-surface break-all bg-surface-container rounded-lg p-2 border border-border-subtle inline-block">
                    {data.firebaseStorage?.bucket || data.storage?.firebase?.bucket || 'Not configured'}
                  </p>
                </div>
                <div>
                  <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-2">Storage Usage</p>
                  <p className="font-headline-1 text-3xl font-bold text-primary">
                    {data.firebaseStorage?.formatted || data.storage?.firebase?.formatted || '0 B'}
                  </p>
                </div>
                <div>
                  <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-2">Total Files</p>
                  <p className="font-headline-1 text-3xl font-bold text-on-surface">
                    {data.firebaseStorage?.fileCount ?? data.storage?.firebase?.fileCount ?? 0}
                  </p>
                </div>
              </div>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
