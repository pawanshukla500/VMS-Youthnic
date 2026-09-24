import React from 'react';
import useSWR from 'swr';
import { authFetch } from '../utils/authFetch';
import { getApiBaseUrl } from '../utils/apiBase';
import toast from 'react-hot-toast';
import { PageHeader, Card, CardHeader, StatusBadge, EmptyState } from '../components/ui';

const API_URL = getApiBaseUrl();

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Failed to load reports');
  return res.json();
};

export default function Reports() {
  const { data, error, isLoading } = useSWR(`${API_URL}/api/admin/reports`, fetcher);

  const exportCsv = async () => {
    try {
      const res = await authFetch(`${API_URL}/api/videos/report`);
      if (!res.ok) throw new Error(`Export failed with ${res.status}`);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'vms-videos.xlsx';
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success('Report downloaded');
    } catch (err) {
      console.error(err);
      toast.error('Failed to export report');
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-surface-bg">
      <PageHeader
        title="Reports"
        description="Upload, station, marketplace, and review breakdowns."
        actions={
          <button onClick={exportCsv} className="bg-primary text-on-primary px-4 py-2 rounded-lg font-medium flex items-center gap-2 hover:bg-primary/90">
            <span className="material-symbols-outlined text-sm">download</span>
            Export Excel
          </button>
        }
      />
      <main className="flex-1 overflow-y-auto p-gutter">
        {isLoading && (
          <div className="flex items-center gap-2 text-secondary">
            <span className="material-symbols-outlined animate-spin">progress_activity</span>
            Loading reports...
          </div>
        )}
        {error && (
          <div className="p-4 rounded-lg bg-critical/10 text-critical border border-critical/20 flex items-center gap-2">
            <span className="material-symbols-outlined text-sm">error</span>
            {error.message}
          </div>
        )}
        {data && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 content-start">
            <ReportTable title="Upload Status" rows={data.uploadStatus} labelKey="upload_status" valueKey="count" icon="cloud_upload" />
            <ReportTable title="Station Performance" rows={data.stationPerformance} labelKey="station" valueKey="count" icon="point_of_sale" />
            <ReportTable title="Marketplace Performance" rows={data.marketplacePerformance} labelKey="marketplace" valueKey="count" icon="storefront" />
            <ReportTable title="Review Status" rows={data.reviewStatus} labelKey="review_status" valueKey="count" icon="fact_check" />
          </div>
        )}
      </main>
    </div>
  );
}

function ReportTable({ title, rows, labelKey, valueKey, icon }: { title: string; rows: any[]; labelKey: string; valueKey: string; icon: string }) {
  return (
    <Card className="h-max flex flex-col">
      <CardHeader icon={icon} title={title} description={`${rows.length} group${rows.length === 1 ? '' : 's'}`} />
      <div className="flex-1">
        {rows.length === 0 ? (
          <EmptyState icon="hourglass_empty" title={`No data for ${title.toLowerCase()}`} hint="New uploads will appear here once recordings are processed." />
        ) : (
          <div className="divide-y divide-border-subtle">
            {rows.map((row, index) => (
              <div key={index} className="p-4 flex items-center justify-between gap-4 hover:bg-surface-container-low transition-colors">
                <StatusBadge status={String(row[labelKey] || 'unassigned')} />
                <span className="font-technical text-technical text-primary bg-primary/10 px-3 py-1 rounded-full font-bold shrink-0">
                  {row[valueKey]}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
