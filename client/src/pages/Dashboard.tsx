import React, { useMemo } from 'react';
import useSWR from 'swr';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  Camera,
  CheckCircle2,
  Clock,
  UploadCloud,
  Hourglass,
  Package,
  Settings as SettingsIcon,
  TrendingUp,
  Users as UsersIcon,
  Video,
} from 'lucide-react';
import { authFetch } from '../utils/authFetch';
import { getApiBaseUrl } from '../utils/apiBase';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  Cell,
} from 'recharts';
import { PageHeader, Card, EmptyState } from '../components/ui';

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Network response was not ok');
  return res.json();
};

function formatMarketplace(m: string) {
  return m && m.length > 0 ? m : 'Unassigned';
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const seconds = Math.floor((Date.now() - t) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleString();
}

const STATUS_COLOR: Record<string, string> = {
  active: '#10B981',
  slow: '#F59E0B',
  idle: '#94A3B8',
  completed: '#10B981',
  uploaded: '#10B981',
  pending: '#0c56d0',
  failed: '#EF4444',
  uploading: '#0c56d0',
};
const MARKETPLACE_PALETTE = ['#0052cc', '#7b2600', '#003d9b', '#515f74', '#0c56d0', '#10B981', '#F59E0B', '#EF4444'];

export default function Dashboard() {
  const navigate = useNavigate();
  const API_URL = getApiBaseUrl();

  const { data: stats, error, isLoading } = useSWR(`${API_URL}/api/stats`, fetcher, {
    refreshInterval: 10_000,
    revalidateOnFocus: true,
  });

  const totalParcels = useMemo(() => {
    if (!stats) return 0;
    return (stats.stationAnalytics || []).reduce((s: number, x: any) => s + x.count, 0);
  }, [stats]);

  const activeStationsList = (stats?.stationStatus || []).filter((s: any) => s.status !== 'idle');
  const idleStationsList = (stats?.stationStatus || []).filter((s: any) => s.status === 'idle');

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-surface-bg">
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
              <Bell className="w-5 h-5" aria-hidden />
            </button>
            <button
              type="button"
              title="Settings"
              onClick={() => navigate('/settings')}
              className="text-on-surface-variant hover:text-primary transition-colors"
            >
              <SettingsIcon className="w-5 h-5" aria-hidden />
            </button>
          </>
        }
      />

      <main className="flex-1 overflow-y-auto p-gutter space-y-6">
        {isLoading && <DashboardSkeleton />}

        {error && (
          <div className="bg-critical/10 text-critical border border-critical/20 p-4 rounded-lg flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 mt-0.5" />
            <p className="font-body text-body">{error.message || 'Failed to load statistics'}</p>
          </div>
        )}

        {!isLoading && !error && stats && (
          <>
            {/* Hero stat row */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <HeroStat
                icon={<Camera className="w-5 h-5" />}
                label="Recordings today"
                value={stats.recordingsToday}
                accent="bg-primary text-white"
              />
              <HeroStat
                icon={<UploadCloud className="w-5 h-5" />}
                label="Videos uploaded"
                value={stats.videosUploaded}
                accent="bg-success text-white"
              />
              <HeroStat
                icon={<AlertTriangle className="w-5 h-5" />}
                label="Failed uploads"
                value={stats.failedUploads}
                accent={Number(stats.failedUploads) > 0 ? 'bg-critical text-white' : 'bg-surface-container text-on-surface-variant'}
              />
              <HeroStat
                icon={<Clock className="w-5 h-5" />}
                label="Avg duration"
                value={`${stats.averageDuration}s`}
                accent="bg-tertiary text-white"
              />
            </div>

            {/* Activity + Trend row */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <Card className="lg:col-span-2">
                <SectionHeader
                  icon={<TrendingUp className="w-4 h-4" />}
                  title="Packings — last 24 hours"
                  hint={`${totalParcels} total`}
                />
                <div className="h-56 w-full px-2 pb-2">
                  {stats.hourlyTrend.some((h: any) => h.count > 0) ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={stats.hourlyTrend} margin={{ top: 10, right: 16, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
                        <XAxis dataKey="label" axisLine={false} tickLine={false} interval={3} tick={{ fill: '#737685', fontSize: 11 }} />
                        <YAxis axisLine={false} tickLine={false} tick={{ fill: '#737685', fontSize: 11 }} />
                        <Tooltip cursor={{ stroke: '#0052cc' }} contentStyle={{ borderRadius: 8, border: 'none', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }} />
                        <Line type="monotone" dataKey="count" stroke="#0052cc" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <EmptyState icon="schedule" title="No packings in the last 24h" hint="Hourly activity will appear here once stations start recording." />
                  )}
                </div>
              </Card>

              <Card>
                <SectionHeader
                  icon={<Activity className="w-4 h-4" />}
                  title="Stations live"
                  hint={`${activeStationsList.length} active · ${idleStationsList.length} idle`}
                />
                <div className="px-5 pb-5 space-y-2 max-h-56 overflow-y-auto">
                  {(stats.stationStatus || []).length === 0 && (
                    <EmptyState icon="dns" title="No stations configured" hint="Add a station on the Stations page to get started." />
                  )}
                  {(stats.stationStatus || []).map((s: any) => (
                    <div key={s.id} className="flex items-center gap-3 py-1">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: STATUS_COLOR[s.status] || '#94A3B8' }} />
                      <span className="font-mono text-label uppercase tracking-wider text-on-surface">{s.code}</span>
                      <span className="font-body text-body text-secondary truncate flex-1" title={s.name || ''}>
                        {s.name || <span className="text-on-surface-variant">no name</span>}
                      </span>
                      <span className="text-xs text-secondary font-label uppercase tracking-wider whitespace-nowrap">
                        {s.packings_today > 0 ? `${s.packings_today} today` : 'idle'}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>

            {/* Parcels by station + Marketplace + Packer leaderboard */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <Card className="lg:col-span-2">
                <SectionHeader
                  icon={<BarChart3 className="w-4 h-4" />}
                  title="Parcels by station"
                  hint={`${stats.stationAnalytics.length} stations · ${totalParcels} parcels`}
                />
                <div className="h-72 w-full p-2">
                  {stats.stationAnalytics.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={stats.stationAnalytics} margin={{ top: 10, right: 16, left: -10, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
                        <XAxis
                          dataKey="station_code"
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: '#737685', fontSize: 12 }}
                        />
                        <YAxis axisLine={false} tickLine={false} tick={{ fill: '#737685', fontSize: 12 }} />
                        <Tooltip
                          cursor={{ fill: 'rgba(0,0,0,0.04)' }}
                          contentStyle={{ borderRadius: 8, border: 'none', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}
                          labelFormatter={(_label: any, payload: any) => {
                            const item = payload && payload[0] && payload[0].payload;
                            return item ? `${item.station_code} · ${item.station_name}` : '';
                          }}
                        />
                        <Bar dataKey="count" radius={[6, 6, 0, 0]} barSize={42}>
                          {stats.stationAnalytics.map((_: any, i: number) => (
                            <Cell key={i} fill={MARKETPLACE_PALETTE[i % MARKETPLACE_PALETTE.length]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <EmptyState icon="bar_chart" title="No activity yet" hint="Parcel counts will appear here once stations start recording." />
                  )}
                </div>
              </Card>

              <Card>
                <SectionHeader
                  icon={<Package className="w-4 h-4" />}
                  title="Marketplaces"
                  hint={`${stats.marketplaceAnalytics.length} channels`}
                />
                <div className="p-5 space-y-3">
                  {stats.marketplaceAnalytics.length === 0 && (
                    <EmptyState icon="storefront" title="No marketplace data" hint="Marketplace breakdown will appear here once recordings include channel info." />
                  )}
                  {stats.marketplaceAnalytics.slice(0, 6).map((m: any, i: number) => {
                    const pct = totalParcels > 0 ? Math.round((m.count / totalParcels) * 100) : 0;
                    return (
                      <div key={m.marketplace} className="space-y-1">
                        <div className="flex items-baseline justify-between">
                          <span className="font-label text-label uppercase tracking-wider text-on-surface">{formatMarketplace(m.marketplace)}</span>
                          <span className="font-mono text-xs text-secondary">{m.count} · {pct}%</span>
                        </div>
                        <div className="h-2 bg-surface-container-low rounded">
                          <div
                            className="h-2 rounded"
                            style={{ width: `${pct}%`, background: MARKETPLACE_PALETTE[i % MARKETPLACE_PALETTE.length] }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            </div>

            {/* Packer leaderboard + Recent activity */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <Card>
                <SectionHeader
                  icon={<UsersIcon className="w-4 h-4" />}
                  title="Top packers this week"
                  hint="Last 7 days"
                />
                <div className="px-2 pb-3">
                  {(stats.packerLeaderboard || []).length === 0 && (
                    <EmptyState icon="group" title="No packers yet" hint="Once packers sign in and record, the leaderboard appears here." />
                  )}
                  {(stats.packerLeaderboard || []).map((p: any, i: number) => (
                    <div key={p.user_id || i} className="flex items-center gap-3 px-3 py-2 hover:bg-surface-container transition-colors rounded">
                      <span
                        className="w-7 h-7 rounded-full flex items-center justify-center font-label text-label uppercase tracking-wider text-white"
                        style={{ background: MARKETPLACE_PALETTE[i % MARKETPLACE_PALETTE.length] }}
                      >
                        {i + 1}
                      </span>
                      <span className="font-body text-body flex-1 truncate">{p.packer_name}</span>
                      <span className="font-mono text-technical text-secondary whitespace-nowrap">
                        {p.count} · {p.avg_duration_seconds}s
                      </span>
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="lg:col-span-2">
                <SectionHeader
                  icon={<Video className="w-4 h-4" />}
                  title="Recent activity"
                  hint="Last 8 recordings"
                  actions={
                    <Link to="/scan-history" className="font-label text-label uppercase tracking-wider text-primary hover:text-primary-container">
                      View all →
                    </Link>
                  }
                />
                <div className="overflow-x-auto">
                  {(stats.recentActivity || []).length === 0 ? (
                    <div className="p-5">
                      <EmptyState icon="history" title="No recent activity" hint="Recordings will appear here in real time." />
                    </div>
                  ) : (
                    <table className="w-full text-left">
                      <thead>
                        <tr className="bg-surface-container-lowest border-b border-border-subtle text-secondary font-label uppercase tracking-wider text-label">
                          <th className="py-2 px-5">Tracking</th>
                          <th className="py-2 px-5">Station</th>
                          <th className="py-2 px-5">Marketplace</th>
                          <th className="py-2 px-5">Packer</th>
                          <th className="py-2 px-5">Duration</th>
                          <th className="py-2 px-5">When</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats.recentActivity.map((r: any) => (
                          <tr key={r.id} className="border-b border-border-subtle last:border-0 hover:bg-surface-container transition-colors">
                            <td className="py-2 px-5 font-mono text-technical">{r.tracking_id}</td>
                            <td className="py-2 px-5 font-label text-label uppercase tracking-wider">{r.station_code}</td>
                            <td className="py-2 px-5 font-label text-label uppercase tracking-wider text-secondary">{formatMarketplace(r.marketplace)}</td>
                            <td className="py-2 px-5 font-body text-body truncate max-w-[12rem]" title={r.packer_name}>{r.packer_name}</td>
                            <td className="py-2 px-5 font-mono text-technical text-secondary">{r.duration_seconds}s</td>
                            <td className="py-2 px-5 font-body text-body text-secondary">{relativeTime(r.created_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </Card>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function HeroStat({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string | number; accent: string }) {
  return (
    <div className="bg-surface-card border border-border-subtle rounded-2xl p-5 shadow-sm flex items-center gap-4">
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${accent}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="font-label text-label uppercase tracking-wider text-secondary">{label}</div>
        <div className="font-display text-display-2 text-on-surface truncate">{value}</div>
      </div>
    </div>
  );
}

function SectionHeader({ icon, title, hint, actions }: { icon: React.ReactNode; title: string; hint?: string; actions?: React.ReactNode }) {
  return (
    <div className="px-5 py-4 flex items-center justify-between gap-3 border-b border-border-subtle">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-primary">{icon}</span>
        <h3 className="font-headline text-headline-2 text-on-surface truncate">{title}</h3>
        {hint && <span className="hidden sm:inline font-label text-label uppercase tracking-wider text-secondary">{hint}</span>}
      </div>
      {actions}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-surface-card border border-border-subtle rounded-2xl h-24" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-surface-card border border-border-subtle rounded-2xl h-64 lg:col-span-2" />
        <div className="bg-surface-card border border-border-subtle rounded-2xl h-64" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-surface-card border border-border-subtle rounded-2xl h-72 lg:col-span-2" />
        <div className="bg-surface-card border border-border-subtle rounded-2xl h-72" />
      </div>
    </div>
  );
}