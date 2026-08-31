import React from 'react';
import useSWR from 'swr';
import { authFetch } from '../utils/authFetch';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

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
      <header className="bg-surface-container-lowest flex items-center px-gutter py-3 min-h-[64px] border-b border-border-subtle shrink-0">
        <h2 className="font-headline-1 text-headline-1 font-bold text-on-background">Scan History</h2>
      </header>
      <main className="flex-1 overflow-auto p-gutter">
        {isLoading && <div className="p-8 text-secondary">Loading scan history...</div>}
        {error && <div className="p-4 bg-error-container text-on-error-container rounded-lg">{error.message}</div>}
        {!isLoading && !error && (
          <div className="bg-surface-card border border-border-subtle rounded-lg shadow-sm overflow-x-auto">
            <table className="w-full text-left min-w-[900px]">
              <thead className="bg-surface-container-low border-b border-border-subtle">
                <tr>
                  <th className="p-4 font-metadata text-metadata text-secondary">Tracking ID</th>
                  <th className="p-4 font-metadata text-metadata text-secondary">Order ID</th>
                  <th className="p-4 font-metadata text-metadata text-secondary">Marketplace</th>
                  <th className="p-4 font-metadata text-metadata text-secondary">Date</th>
                  <th className="p-4 font-metadata text-metadata text-secondary">Packer</th>
                  <th className="p-4 font-metadata text-metadata text-secondary">Station</th>
                  <th className="p-4 font-metadata text-metadata text-secondary">Duration</th>
                  <th className="p-4 font-metadata text-metadata text-secondary">Upload</th>
                </tr>
              </thead>
              <tbody>
                {scans.map((scan: any) => (
                  <tr key={scan.id} className="border-b border-border-subtle hover:bg-surface-bg">
                    <td className="p-4 font-technical">{scan.tracking_id || 'UNKNOWN'}</td>
                    <td className="p-4 font-technical">{scan.order_id || '-'}</td>
                    <td className="p-4">{scan.marketplace || 'Unassigned'}</td>
                    <td className="p-4">{new Date(scan.created_at).toLocaleString()}</td>
                    <td className="p-4">{scan.packer_name || scan.packer_email || 'Unknown'}</td>
                    <td className="p-4 font-technical">{scan.station_code || 'Unknown'}</td>
                    <td className="p-4 font-technical">{formatDuration(Number(scan.duration_ms || 0))}</td>
                    <td className="p-4">{scan.upload_status || scan.status || 'pending'}</td>
                  </tr>
                ))}
                {scans.length === 0 && (
                  <tr><td colSpan={8} className="p-8 text-center text-secondary">No scans yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
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
