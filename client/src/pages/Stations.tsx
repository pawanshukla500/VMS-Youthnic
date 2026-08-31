import React from 'react';
import useSWR from 'swr';
import { authFetch } from '../utils/authFetch';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Failed to load stations');
  return res.json();
};

export default function Stations() {
  const { data, error, isLoading } = useSWR(`${API_URL}/api/admin/stations`, fetcher, {
    refreshInterval: 30000
  });
  const stations = data?.stations || [];

  return (
    <div className="flex-1 flex flex-col min-h-screen relative bg-surface-bg">
      <header className="bg-surface-container-lowest flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 px-gutter py-3 min-h-[64px] border-b border-border-subtle shrink-0">
        <h2 className="font-headline-1 text-headline-1 font-bold text-on-background">Stations Management</h2>
        <span className="font-metadata text-metadata text-secondary">{stations.length} stations</span>
      </header>
      <main className="flex-1 p-gutter overflow-auto relative">
        {isLoading && <div className="p-8 text-secondary">Loading stations...</div>}
        {error && <div className="p-4 bg-error-container text-on-error-container rounded-lg">{error.message}</div>}
        {!isLoading && !error && (
          <div className="bg-surface-card rounded-lg border border-border-subtle shadow-sm overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[800px]">
              <thead className="bg-surface-container-low border-b border-border-subtle">
                <tr>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Station ID</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Name</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Location</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Recordings</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Status</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Last Recording</th>
                </tr>
              </thead>
              <tbody>
                {stations.map((station: any) => (
                  <tr key={station.id} className="border-b border-border-subtle hover:bg-surface-bg transition-colors">
                    <td className="p-4 text-on-surface font-technical">{station.code}</td>
                    <td className="p-4 text-on-surface">{station.name}</td>
                    <td className="p-4 text-on-surface">{station.location || 'Unknown'}</td>
                    <td className="p-4 font-technical">{station.recordings}</td>
                    <td className="p-4">
                      <span className={`px-2 py-1 rounded text-xs font-bold border ${station.active ? 'bg-success/10 text-success border-success/20' : 'bg-surface-variant text-on-surface-variant border-border-heavy'}`}>
                        {station.active ? 'ONLINE' : 'OFFLINE'}
                      </span>
                    </td>
                    <td className="p-4 text-secondary">{station.last_recording_at ? new Date(station.last_recording_at).toLocaleString() : 'No recordings'}</td>
                  </tr>
                ))}
                {stations.length === 0 && (
                  <tr><td colSpan={6} className="p-8 text-center text-secondary">No stations found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
