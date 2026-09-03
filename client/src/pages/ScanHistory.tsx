import React from 'react';
import useSWR from 'swr';
import { authFetch } from '../utils/authFetch';
import { getApiBaseUrl } from '../utils/apiBase';
import { PageHeader, Card, CardHeader, StatusBadge, EmptyState } from '../components/ui';

const API_URL = getApiBaseUrl();

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Failed to load scan history');
  return res.json();
};

export default function ScanHistory() {
  const { data, error, isLoading } = useSWR(`${API_URL}/api/admin/scan-history`, fetcher, {
    refreshInterval: 10000
  });
  const scans = data?.scans || [];

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-surface-bg">
      <PageHeader
        title="Scan History"
        description="Every packer scan, newest first"
        actions={
          !isLoading && !error ? (
            <span className="font-metadata text-metadata text-secondary">{scans.length} scans</span>
          ) : undefined
        }
      />
      <main className="flex-1 overflow-auto p-gutter">
        {isLoading && <div className="p-8 text-secondary">Loading scan history...</div>}
        {error && (
          <div className="flex items-center gap-2 p-4 bg-critical/10 text-critical border border-critical/20 rounded-lg">
            <span className="material-symbols-outlined">error</span>
            <span>{error.message}</span>
          </div>
        )}
        {!isLoading && !error && (
          <Card>
            <CardHeader
              icon="history"
              title="Scan history"
              description="Packer scans across all stations"
            />
            {scans.length === 0 ? (
              <EmptyState
                icon="history"
                title="No scans yet."
                hint="Scans from the packing stations will appear here."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse min-w-[900px]">
                  <thead className="bg-surface-container-low border-b border-border-subtle">
                    <tr>
                      <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Tracking ID</th>
                      <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Order ID</th>
                      <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Marketplace</th>
                      <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Date</th>
                      <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Packer</th>
                      <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Station</th>
                      <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Duration</th>
                      <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Upload</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scans.map((scan: any) => (
                      <tr key={scan.id} className="border-b border-border-subtle hover:bg-surface-bg transition-colors">
                        <td className="p-4 font-technical text-on-surface">{scan.tracking_id || 'UNKNOWN'}</td>
                        <td className="p-4 font-technical text-on-surface">{scan.order_id || '-'}</td>
                        <td className="p-4 text-on-surface">{scan.marketplace || 'Unassigned'}</td>
                        <td className="p-4 text-on-surface">{new Date(scan.created_at).toLocaleString()}</td>
                        <td className="p-4 text-on-surface">{scan.packer_name || scan.packer_email || 'Unknown'}</td>
                        <td className="p-4 font-technical text-on-surface">{scan.station_code || 'Unknown'}</td>
                        <td className="p-4 font-technical text-secondary">{formatDuration(Number(scan.duration_ms || 0))}</td>
                        <td className="p-4">
                          <StatusBadge status={String(scan.upload_status || scan.status || 'pending')} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </main>
    </div>
  );
}

function formatDuration(ms: number) {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
