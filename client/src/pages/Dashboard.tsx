import React from 'react';
import useSWR from 'swr';
import { authFetch } from '../utils/authFetch';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useNavigate } from 'react-router-dom';

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Network response was not ok');
  return res.json();
};

export default function Dashboard() {
  const navigate = useNavigate();
  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
  
  // SWR automatically handles caching, revalidation, and loading states!
  const { data: stats, error, isLoading } = useSWR(`${API_URL}/api/stats`, fetcher, {
    refreshInterval: 10000, // Poll every 10s for real-time updates
    revalidateOnFocus: true
  });

  return (
    <div className="flex-1 flex flex-col min-h-screen relative bg-surface-bg">
      {/* TopNavBar */}
      <header className="bg-surface-container-lowest flex justify-between items-center gap-3 px-gutter py-3 min-h-[64px] border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-6 min-w-0">
          <h2 className="font-headline-1 text-headline-1 font-bold text-on-background">System Overview</h2>
        </div>
        <div className="flex items-center gap-4">
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
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-gutter space-y-6">
        
        {isLoading && (
          <div className="flex items-center justify-center p-12">
            <span className="material-symbols-outlined animate-spin text-primary text-5xl">progress_activity</span>
          </div>
        )}

        {error && (
          <div className="bg-error-container text-on-error-container p-4 rounded-lg flex items-start gap-3">
            <span className="material-symbols-outlined text-error">error</span>
            <p className="font-body-sm text-body-sm">{error.message || 'Failed to load statistics'}</p>
          </div>
        )}

        {!isLoading && !error && stats && (
          <div className="animate-fade-in-up">
            {/* Summary Cards Section (Glassmorphism) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 gap-4 xl:gap-6">
              {[
                { title: 'Recordings Today', value: stats.recordingsToday, icon: 'videocam', color: 'text-primary' },
                { title: 'Avg Duration', value: `${stats.averageDuration}s`, icon: 'timer', color: 'text-primary' },
                { title: 'Videos Uploaded', value: stats.videosUploaded, icon: 'cloud_done', color: 'text-success' },
                { title: 'Pending Uploads', value: stats.pendingUploads, icon: 'cloud_upload', color: 'text-warning' },
                { title: 'Failed Uploads', value: stats.failedUploads, icon: 'error', color: 'text-critical', border: 'border-l-4 border-l-critical' },
                { title: 'Active Stations', value: stats.activeStations, icon: 'dns', color: 'text-primary' },
              ].map((card, idx) => (
                <div key={idx} className={`bg-white/60 backdrop-blur-md shadow-sm border border-white/20 rounded-lg p-5 flex flex-col justify-between min-h-32 cursor-default ${card.border || ''}`}>
                  <div className="flex items-start justify-between">
                    <span className="font-body-sm text-body-sm text-secondary font-medium">{card.title}</span>
                    <span className={`material-symbols-outlined ${card.color}`}>{card.icon}</span>
                  </div>
                  <div className="font-display-id text-display-id text-on-background">{card.value}</div>
                </div>
              ))}
            </div>

            {/* Productivity Analytics Section */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-8">
              
              {/* Chart */}
              <div className="bg-white/60 backdrop-blur-md shadow-sm border border-white/20 rounded-lg overflow-hidden p-6">
                <h3 className="font-headline-2 text-headline-2 mb-6">Parcels by Station</h3>
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
                    <div className="w-full h-full flex flex-col items-center justify-center text-secondary">
                      <span className="material-symbols-outlined text-5xl mb-2 opacity-50">bar_chart</span>
                      <p>No activity yet</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Table */}
              <div className="bg-white/60 backdrop-blur-md shadow-sm border border-white/20 rounded-lg overflow-hidden">
                <div className="p-card-padding border-b border-border-subtle/50 flex justify-between items-center">
                  <h3 className="font-headline-2 text-headline-2">Station Performance</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-surface-container-low/50 border-b border-border-subtle/50">
                        <th className="py-3 px-card-padding font-metadata text-metadata text-secondary font-semibold">Station ID</th>
                        <th className="py-3 px-card-padding font-metadata text-metadata text-secondary font-semibold">Total Parcels</th>
                        <th className="py-3 px-card-padding font-metadata text-metadata text-secondary font-semibold">Avg Time/Parcel</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.stationAnalytics.map((stat: any, index: number) => (
                        <tr key={index} className="border-b border-border-subtle/50 hover:bg-white/80 transition-colors h-[50px]">
                          <td className="py-2 px-card-padding font-headline-2 text-headline-2 text-on-background flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-primary inline-block"></span>
                            {stat.station_id}
                          </td>
                          <td className="py-2 px-card-padding font-body-sm text-body-sm">{stat.count}</td>
                          <td className="py-2 px-card-padding font-technical text-technical text-secondary">{parseFloat(stat.avg).toFixed(1)}s</td>
                        </tr>
                      ))}
                      {stats.stationAnalytics.length === 0 && (
                        <tr>
                          <td colSpan={3} className="py-12 px-card-padding text-center">
                            <div className="flex flex-col items-center justify-center text-secondary">
                              <span className="material-symbols-outlined text-4xl mb-3 opacity-50">inbox</span>
                              <p className="font-body-sm text-body-sm">No productivity data available yet.</p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
