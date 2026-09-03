import React from 'react';
import useSWR from 'swr';
import { authFetch } from '../utils/authFetch';
import { getApiBaseUrl } from '../utils/apiBase';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useNavigate } from 'react-router-dom';
import { PageHeader, Card, CardHeader, StatCard, EmptyState } from '../components/ui';

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Network response was not ok');
  return res.json();
};

export default function Dashboard() {
  const navigate = useNavigate();
  const API_URL = getApiBaseUrl();

  // SWR automatically handles caching, revalidation, and loading states!
  const { data: stats, error, isLoading } = useSWR(`${API_URL}/api/stats`, fetcher, {
    refreshInterval: 10000, // Poll every 10s for real-time updates
    revalidateOnFocus: true
  });

  return (
    <div className="flex-1 flex flex-col min-h-screen relative bg-surface-bg">
      <PageHeader
        title="System Overview"
        description="Live packing performance across stations"
        actions={
          <>
            <div className="h-6 w-px bg-border-subtle mx-2"></div>
            <button
              type="button"
              title="System health"
              onClick={() => navigate('/system-health')}
              className="text-on-surface-variant hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined">notifications</span>
            </button>
            <button
              type="button"
              title="Admin settings"
              onClick={() => navigate('/settings')}
              className="text-on-surface-variant hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined">account_circle</span>
            </button>
          </>
        }
      />

      <main className="flex-1 overflow-y-auto p-gutter space-y-6">

        {isLoading && (
          <div className="space-y-6" aria-busy="true">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 gap-4 xl:gap-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="bg-surface-card border border-border-subtle rounded-2xl p-6 shadow-sm animate-pulse">
                  <div className="h-3 w-2/3 rounded bg-surface-container mb-4"></div>
                  <div className="h-8 w-1/2 rounded bg-surface-container"></div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {[0, 1].map((i) => (
                <div key={i} className="bg-surface-card border border-border-subtle rounded-lg h-80 animate-pulse"></div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="bg-critical/10 text-critical border border-critical/20 p-4 rounded-lg flex items-start gap-3">
            <span className="material-symbols-outlined">error</span>
            <p className="font-body-sm text-body-sm">{error.message || 'Failed to load statistics'}</p>
          </div>
        )}

        {!isLoading && !error && stats && (
          <div className="animate-fade-in-up">
            {/* Summary Cards Section */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 gap-4 xl:gap-6">
              <StatCard title="Recordings Today" value={stats.recordingsToday} icon="videocam" color="text-primary" />
              <StatCard title="Avg Duration" value={`${stats.averageDuration}s`} icon="timer" color="text-primary" />
              <StatCard title="Videos Uploaded" value={stats.videosUploaded} icon="cloud_done" color="text-success" />
              <StatCard title="Pending Uploads" value={stats.pendingUploads} icon="cloud_upload" color="text-warning" />
              <StatCard title="Failed Uploads" value={stats.failedUploads} icon="error" color="text-critical" />
              <StatCard title="Active Stations" value={stats.activeStations} icon="dns" color="text-primary" />
            </div>

            {/* Productivity Analytics Section */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-8">

              {/* Chart */}
              <Card>
                <CardHeader icon="bar_chart" title="Parcels by Station" description="Parcel counts per station" />
                <div className="p-5">
                  <div className="h-64 w-full">
                    {stats.stationAnalytics.length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={stats.stationAnalytics} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
                          <XAxis dataKey="station_id" axisLine={false} tickLine={false} tick={{ fill: '#737685', fontSize: 12 }} />
                          <YAxis axisLine={false} tickLine={false} tick={{ fill: '#737685', fontSize: 12 }} />
                          <Tooltip cursor={{ fill: 'rgba(0,0,0,0.05)' }} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }} />
                          <Bar dataKey="count" fill="#0052cc" radius={[4, 4, 0, 0]} barSize={40} />
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <EmptyState icon="bar_chart" title="No activity yet" hint="Parcel counts will appear here once stations start recording." />
                    )}
                  </div>
                </div>
              </Card>

              {/* Table */}
              <Card>
                <CardHeader icon="table_chart" title="Station Performance" description="Throughput per station" />
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-surface-container-lowest border-b border-border-subtle">
                        <th className="py-3 px-5 font-metadata text-metadata text-secondary font-semibold">Station ID</th>
                        <th className="py-3 px-5 font-metadata text-metadata text-secondary font-semibold">Total Parcels</th>
                        <th className="py-3 px-5 font-metadata text-metadata text-secondary font-semibold">Avg Time/Parcel</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.stationAnalytics.map((stat: any, index: number) => (
                        <tr key={index} className="border-b border-border-subtle hover:bg-surface-container transition-colors h-[50px]">
                          <td className="py-2 px-5 font-headline-2 text-headline-2 text-on-background">
                            <span className="inline-flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full bg-primary inline-block"></span>
                              {stat.station_id}
                            </span>
                          </td>
                          <td className="py-2 px-5 font-body-sm text-body-sm">{stat.count}</td>
                          <td className="py-2 px-5 font-technical text-technical text-secondary">{parseFloat(stat.avg).toFixed(1)}s</td>
                        </tr>
                      ))}
                      {stats.stationAnalytics.length === 0 && (
                        <tr>
                          <td colSpan={3}>
                            <EmptyState icon="inbox" title="No productivity data available yet." hint="Station performance rows will appear here once activity is recorded." />
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
