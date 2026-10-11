import React, { useMemo } from 'react';
import useSWR from 'swr';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  BarChart3,
  Bell,
  LayoutDashboard,
  PackageSearch,
  RefreshCw,
  Settings as SettingsIcon,
  Truck,
  Workflow,
} from 'lucide-react';
import { authFetch } from '../utils/authFetch';
import { getApiBaseUrl } from '../utils/apiBase';
import { PageHeader } from '../components/ui';
import { DashboardOverviewTab } from '../components/dashboard/DashboardOverviewTab';
import { DashboardOrdersTab } from '../components/dashboard/DashboardOrdersTab';
import { DashboardAnalyticsTab } from '../components/dashboard/DashboardAnalyticsTab';
import { DashboardLogisticsTab } from '../components/dashboard/DashboardLogisticsTab';
import { OrderLifecycleTrail } from '../components/orders/OrderLifecycleTrail';

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Network response was not ok');
  return res.json();
};

type DashboardTabKey = 'overview' | 'orders' | 'workflow' | 'analytics' | 'logistics';

export default function Dashboard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const API_URL = getApiBaseUrl();

  const activeTab: DashboardTabKey = (searchParams.get('tab') as DashboardTabKey) || 'overview';

  const setTab = (tab: DashboardTabKey) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (tab === 'overview') {
        next.delete('tab');
      } else {
        next.set('tab', tab);
      }
      return next;
    });
  };

  const { data: stats, error, isLoading, mutate } = useSWR(`${API_URL}/api/stats`, fetcher, {
    refreshInterval: 10_000,
    revalidateOnFocus: true,
  });

  const totalParcels = useMemo(() => {
    if (!stats) return 0;
    return (stats.stationAnalytics || []).reduce((s: number, x: any) => s + x.count, 0);
  }, [stats]);

  const trendData: Array<{ label: string; count: number; fullLabel?: string }> = useMemo(() => {
    if (!stats) return [];
    if (Array.isArray(stats.dailyTrend) && stats.dailyTrend.length > 0) return stats.dailyTrend;
    if (Array.isArray(stats.hourlyTrend)) return stats.hourlyTrend;
    return [];
  }, [stats]);

  const isDailyTrend = Array.isArray(stats?.dailyTrend) && stats.dailyTrend.length > 0;

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-surface-bg">
      <PageHeader
        title="Operations Dashboard"
        description="Live packing performance, dispatch orders, and logistics intelligence"
        actions={
          <>
            <button
              type="button"
              title="Refresh stats"
              onClick={() => void mutate()}
              className="text-on-surface-variant hover:text-primary transition-colors p-1"
            >
              <RefreshCw className="w-4 h-4" aria-hidden />
            </button>
            <div className="h-6 w-px bg-border-subtle mx-1"></div>
            <button
              type="button"
              title="System health"
              onClick={() => navigate('/system-health')}
              className="text-on-surface-variant hover:text-primary transition-colors p-1"
            >
              <Bell className="w-5 h-5" aria-hidden />
            </button>
            <button
              type="button"
              title="Settings"
              onClick={() => navigate('/settings')}
              className="text-on-surface-variant hover:text-primary transition-colors p-1"
            >
              <SettingsIcon className="w-5 h-5" aria-hidden />
            </button>
          </>
        }
      />

      {/* Main Tab Bar */}
      <div className="bg-white border-b border-border-subtle px-gutter pt-2 sticky top-0 z-10 shadow-2xs">
        <div className="flex gap-2 overflow-x-auto no-scrollbar" role="tablist" aria-label="Dashboard views">
          <TabButton
            active={activeTab === 'overview'}
            onClick={() => setTab('overview')}
            icon={<LayoutDashboard className="w-4 h-4" />}
            label="Overview"
          />
          <TabButton
            active={activeTab === 'orders'}
            onClick={() => setTab('orders')}
            icon={<PackageSearch className="w-4 h-4" />}
            label="Orders Hub"
          />
          <TabButton
            active={activeTab === 'workflow'}
            onClick={() => setTab('workflow')}
            icon={<Workflow className="w-4 h-4" />}
            label="Order Workflow Trail"
          />
          <TabButton
            active={activeTab === 'analytics'}
            onClick={() => setTab('analytics')}
            icon={<BarChart3 className="w-4 h-4" />}
            label="Analytics"
          />
          <TabButton
            active={activeTab === 'logistics'}
            onClick={() => setTab('logistics')}
            icon={<Truck className="w-4 h-4" />}
            label="Logistics & Gateways"
          />
        </div>
      </div>

      <main className="flex-1 overflow-y-auto p-gutter space-y-6">
        {isLoading && <DashboardSkeleton />}

        {error && (
          <div className="bg-critical/10 text-critical border border-critical/20 p-4 rounded-xl flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 mt-0.5" />
            <p className="font-body text-body">{error.message || 'Failed to load statistics'}</p>
          </div>
        )}

        {!isLoading && !error && (
          <>
            {activeTab === 'overview' && stats && (
              <DashboardOverviewTab
                stats={stats}
                trendData={trendData}
                isDailyTrend={isDailyTrend}
                totalParcels={totalParcels}
              />
            )}

            {activeTab === 'orders' && <DashboardOrdersTab />}

            {activeTab === 'workflow' && (
              <OrderLifecycleTrail showScenarioWorkbench={true} />
            )}

            {activeTab === 'analytics' && stats && (
              <DashboardAnalyticsTab
                stats={stats}
                trendData={trendData}
                isDailyTrend={isDailyTrend}
                totalParcels={totalParcels}
              />
            )}

            {activeTab === 'logistics' && <DashboardLogisticsTab />}
          </>
        )}
      </main>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`px-4 py-3 rounded-t-xl text-xs font-semibold flex items-center gap-2 border-b-2 transition-all cursor-pointer whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        active
          ? 'border-primary text-primary bg-primary/5 font-bold'
          : 'border-transparent text-secondary hover:text-on-surface hover:bg-surface-container-low'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-surface-card border border-border-subtle rounded-xl h-24" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-surface-card border border-border-subtle rounded-xl h-64 lg:col-span-2" />
        <div className="bg-surface-card border border-border-subtle rounded-xl h-64" />
      </div>
    </div>
  );
}