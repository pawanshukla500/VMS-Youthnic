import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Camera,
  CheckCircle2,
  Clock,
  ExternalLink,
  Package,
  TrendingUp,
  UploadCloud,
  Users as UsersIcon,
  Video,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { Card, EmptyState } from '../ui';
import { CarrierBadge, MarketplaceLogoBadge } from '../LogisticsBadges';

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

const MARKETPLACE_PALETTE = ['#003d9b', '#7b2600', '#0c56d0', '#515f74', '#10B981', '#F59E0B', '#EF4444', '#8b5cf6'];

interface DashboardOverviewTabProps {
  stats: any;
  trendData: Array<{ label: string; count: number; fullLabel?: string }>;
  isDailyTrend: boolean;
  totalParcels: number;
}

export function DashboardOverviewTab({
  stats,
  trendData,
  isDailyTrend,
  totalParcels,
}: DashboardOverviewTabProps) {
  const trendTotal = useMemo(() => trendData.reduce((s, x: any) => s + (Number(x.count) || 0), 0), [trendData]);
  const trendAvg = trendData.length > 0 ? (trendTotal / trendData.length).toFixed(1) : '0';

  const activeStationsList = (stats?.stationStatus || []).filter((s: any) => s.status !== 'idle');
  const idleStationsList = (stats?.stationStatus || []).filter((s: any) => s.status === 'idle');

  return (
    <div className="space-y-6">
      {/* Hero Stat Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <HeroStat
          icon={<Camera className="w-5 h-5" />}
          label="Recordings today"
          value={stats.recordingsToday ?? 0}
          accent="bg-primary text-white"
          subtitle="Packings completed today"
        />
        <HeroStat
          icon={<UploadCloud className="w-5 h-5" />}
          label="Videos uploaded"
          value={stats.videosUploaded ?? 0}
          accent="bg-success text-white"
          subtitle="Backed up to cloud storage"
        />
        <HeroStat
          icon={<AlertTriangle className="w-5 h-5" />}
          label="Failed uploads"
          value={stats.failedUploads ?? 0}
          accent={Number(stats.failedUploads) > 0 ? 'bg-critical text-white' : 'bg-surface-container text-on-surface-variant'}
          subtitle={Number(stats.failedUploads) > 0 ? 'Requires attention in queue' : 'Healthy upload pipeline'}
        />
        <HeroStat
          icon={<Clock className="w-5 h-5" />}
          label="Avg duration"
          value={`${stats.averageDuration ?? 0}s`}
          accent="bg-tertiary text-white"
          subtitle="Per packing session cycle"
        />
      </div>

      {/* Activity + Stations Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <SectionHeader
            icon={<TrendingUp className="w-4 h-4" />}
            title={isDailyTrend ? 'Packing Volume — Last 30 Days' : 'Packing Velocity — Last 24 Hours'}
            hint={isDailyTrend ? `${trendTotal} total · ${trendAvg}/day avg` : `${trendTotal} total`}
          />
          <div className="h-64 w-full px-2 pb-3">
            {trendData.some((h: any) => h.count > 0) ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendData} margin={{ top: 12, right: 16, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="packingsTrendOverview" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#003d9b" stopOpacity={0.32} />
                      <stop offset="100%" stopColor="#003d9b" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
                  <XAxis
                    dataKey="label"
                    axisLine={false}
                    tickLine={false}
                    interval={Math.max(1, Math.floor(trendData.length / 8))}
                    tick={{ fill: '#737685', fontSize: 11 }}
                    tickMargin={8}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    allowDecimals={false}
                    tick={{ fill: '#737685', fontSize: 11 }}
                    width={40}
                  />
                  <Tooltip
                    cursor={{ stroke: '#003d9b', strokeDasharray: '4 4' }}
                    content={<TrendTooltip />}
                  />
                  <Area
                    type="monotone"
                    dataKey="count"
                    name="Packings"
                    stroke="#003d9b"
                    strokeWidth={2.5}
                    fill="url(#packingsTrendOverview)"
                    dot={false}
                    activeDot={{ r: 5, fill: '#003d9b', stroke: '#fff', strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState
                icon="schedule"
                title={isDailyTrend ? 'No packings in the last 30 days' : 'No packings in the last 24h'}
                hint="Daily activity will appear here once stations start recording."
              />
            )}
          </div>
        </Card>

        <Card className="flex flex-col">
          <SectionHeader
            icon={<Activity className="w-4 h-4" />}
            title="Packing Stations Live"
            hint={`${activeStationsList.length} active · ${idleStationsList.length} idle`}
          />
          <div className="p-4 space-y-2 flex-1 max-h-64 overflow-y-auto">
            {(stats.stationStatus || []).length === 0 && (
              <EmptyState icon="dns" title="No stations configured" hint="Add a station on the Stations page to get started." />
            )}
            {(stats.stationStatus || []).map((s: any) => (
              <div
                key={s.id}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-surface-container-low transition-colors border border-transparent hover:border-border-subtle"
              >
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ background: STATUS_COLOR[s.status] || '#94A3B8' }}
                  title={`Status: ${s.status}`}
                />
                <span className="font-mono text-label uppercase tracking-wider font-semibold text-on-surface">
                  {s.code}
                </span>
                <span className="font-body text-xs text-secondary truncate flex-1" title={s.name || ''}>
                  {s.name || <span className="text-on-surface-variant italic">Unnamed station</span>}
                </span>
                <span className="text-xs font-mono font-medium px-2 py-0.5 rounded bg-surface-container text-on-surface whitespace-nowrap">
                  {s.packings_today > 0 ? `${s.packings_today} today` : 'idle'}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Station Volume + Marketplaces Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <SectionHeader
            icon={<BarChart3 className="w-4 h-4" />}
            title="Parcels by Station"
            hint={`${(stats.stationAnalytics || []).length} stations · ${totalParcels} total parcels`}
          />
          <div className="h-72 w-full p-2">
            {(stats.stationAnalytics || []).length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.stationAnalytics} margin={{ top: 12, right: 16, left: -10, bottom: 0 }}>
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
                    contentStyle={{ borderRadius: 8, border: '1px solid #E2E8F0', boxShadow: '0 4px 6px rgba(0,0,0,0.06)' }}
                    labelFormatter={(_label: any, payload: any) => {
                      const item = payload && payload[0] && payload[0].payload;
                      return item ? `${item.station_code} · ${item.station_name}` : '';
                    }}
                  />
                  <Bar dataKey="count" radius={[6, 6, 0, 0]} barSize={38}>
                    {(stats.stationAnalytics || []).map((_: any, i: number) => (
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
            hint={`${(stats.marketplaceAnalytics || []).length} channels`}
          />
          <div className="p-5 space-y-4">
            {(stats.marketplaceAnalytics || []).length === 0 && (
              <EmptyState icon="storefront" title="No marketplace data" hint="Marketplace breakdown will appear here once recordings include channel info." />
            )}
            {(stats.marketplaceAnalytics || []).slice(0, 6).map((m: any, i: number) => {
              const pct = totalParcels > 0 ? Math.round((m.count / totalParcels) * 100) : 0;
              return (
                <div key={m.marketplace} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <MarketplaceLogoBadge marketplace={m.marketplace} size="xs" />
                    <span className="font-mono text-xs text-secondary font-medium">
                      {m.count} ({pct}%)
                    </span>
                  </div>
                  <div className="h-2 bg-surface-container rounded-full overflow-hidden">
                    <div
                      className="h-2 rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.max(4, pct)}%`,
                        background: MARKETPLACE_PALETTE[i % MARKETPLACE_PALETTE.length],
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {/* Top Packers + Recent Activity with Brandfetch Logistics Badges */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card>
          <SectionHeader
            icon={<UsersIcon className="w-4 h-4" />}
            title="Top Packers This Week"
            hint="Last 7 days"
          />
          <div className="p-3 space-y-1">
            {(stats.packerLeaderboard || []).length === 0 && (
              <EmptyState icon="group" title="No packers yet" hint="Once packers sign in and record, the leaderboard appears here." />
            )}
            {(stats.packerLeaderboard || []).map((p: any, i: number) => (
              <div
                key={p.user_id || i}
                className="flex items-center gap-3 px-3 py-2.5 hover:bg-surface-container-low transition-colors rounded-lg border border-transparent hover:border-border-subtle"
              >
                <span
                  className="w-7 h-7 rounded-full flex items-center justify-center font-label text-xs uppercase tracking-wider font-bold text-white shrink-0"
                  style={{ background: MARKETPLACE_PALETTE[i % MARKETPLACE_PALETTE.length] }}
                >
                  {i + 1}
                </span>
                <span className="font-body text-sm font-medium text-on-surface flex-1 truncate">{p.packer_name}</span>
                <span className="font-mono text-xs text-secondary whitespace-nowrap bg-surface-container px-2 py-0.5 rounded">
                  {p.count} parcels · {p.avg_duration_seconds}s avg
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <SectionHeader
            icon={<Video className="w-4 h-4" />}
            title="Recent Activity Feed"
            hint="Live dispatch streams"
            actions={
              <Link to="/scan-history" className="font-label text-xs uppercase tracking-wider font-bold text-primary hover:underline flex items-center gap-1">
                View All <ExternalLink className="w-3 h-3" />
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
                  <tr className="bg-surface-container-lowest border-b border-border-subtle text-secondary font-label uppercase tracking-wider text-[11px]">
                    <th className="py-2.5 px-4">Tracking AWB & Courier</th>
                    <th className="py-2.5 px-4">Station</th>
                    <th className="py-2.5 px-4">Marketplace</th>
                    <th className="py-2.5 px-4">Packer</th>
                    <th className="py-2.5 px-4">Duration</th>
                    <th className="py-2.5 px-4">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle/80">
                  {stats.recentActivity.map((r: any) => (
                    <tr
                      key={r.id}
                      className="hover:bg-surface-container-low transition-colors"
                    >
                      <td className="py-2.5 px-4">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-on-surface">{r.tracking_id}</span>
                          <CarrierBadge trackingId={r.tracking_id} size="xs" />
                        </div>
                      </td>
                      <td className="py-2.5 px-4 font-label text-xs uppercase tracking-wider font-semibold text-secondary">
                        {r.station_code}
                      </td>
                      <td className="py-2.5 px-4">
                        <MarketplaceLogoBadge marketplace={r.marketplace} size="xs" />
                      </td>
                      <td className="py-2.5 px-4 font-body text-xs text-on-surface truncate max-w-[10rem]" title={r.packer_name}>
                        {r.packer_name}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-xs text-secondary">
                        {r.duration_seconds}s
                      </td>
                      <td className="py-2.5 px-4 font-body text-xs text-secondary whitespace-nowrap">
                        {relativeTime(r.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

function TrendTooltip({ active, payload, label }: any) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload || {};
  return (
    <div className="bg-white rounded-lg px-3 py-2 shadow-md border border-border-subtle">
      <div className="font-label text-xs uppercase tracking-wider text-secondary">
        {point.fullLabel || label}
      </div>
      <div className="font-display text-lg font-bold text-on-surface">
        {payload[0]?.value ?? 0}{' '}
        <span className="font-body text-xs font-normal text-secondary">packings</span>
      </div>
    </div>
  );
}

function HeroStat({
  icon,
  label,
  value,
  accent,
  subtitle,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  accent: string;
  subtitle?: string;
}) {
  return (
    <div className="bg-white border border-border-subtle rounded-2xl p-4 sm:p-5 shadow-xs hover:border-primary/40 transition-all flex flex-col justify-between">
      <div className="flex items-center gap-3.5 mb-2">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${accent}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <div className="font-label text-xs uppercase tracking-wider text-secondary font-medium">{label}</div>
          <div className="font-display text-2xl font-bold text-on-surface truncate tracking-tight">{value}</div>
        </div>
      </div>
      {subtitle && <p className="text-[11px] text-secondary truncate mt-1">{subtitle}</p>}
    </div>
  );
}

function SectionHeader({
  icon,
  title,
  hint,
  actions,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="px-5 py-3.5 flex items-center justify-between gap-3 border-b border-border-subtle">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-primary">{icon}</span>
        <h3 className="font-headline text-base font-bold text-on-surface truncate">{title}</h3>
        {hint && (
          <span className="hidden sm:inline font-label text-xs uppercase tracking-wider text-secondary font-medium">
            {hint}
          </span>
        )}
      </div>
      {actions}
    </div>
  );
}
