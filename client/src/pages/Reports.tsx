import React from 'react';
import useSWR from 'swr';
import { authFetch } from '../utils/authFetch';
import { getApiBaseUrl } from '../utils/apiBase';
import toast from 'react-hot-toast';

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
      a.download = 'vms_report.csv';
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
      <header className="bg-surface-container-lowest flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 px-gutter py-3 min-h-[64px] border-b border-border-subtle shrink-0">
        <h2 className="font-headline-1 text-headline-1 font-bold text-on-background">Reports</h2>
        <button onClick={exportCsv} className="bg-primary text-on-primary px-4 py-2 rounded-lg font-medium flex items-center gap-2">
          <span className="material-symbols-outlined text-sm">download</span>
          Export CSV
        </button>
      </header>
      <main className="flex-1 overflow-y-auto p-gutter grid grid-cols-1 xl:grid-cols-3 gap-6 content-start">
        {isLoading && <div className="text-secondary">Loading reports...</div>}
        {error && <div className="p-4 bg-error-container text-on-error-container rounded-lg">{error.message}</div>}
        {data && (
          <>
            <ReportTable title="Upload Status" rows={data.uploadStatus} labelKey="upload_status" valueKey="count" icon="cloud_upload" />
            <ReportTable title="Station Performance" rows={data.stationPerformance} labelKey="station" valueKey="count" icon="point_of_sale" />
            <ReportTable title="Marketplace Performance" rows={data.marketplacePerformance} labelKey="marketplace" valueKey="count" icon="storefront" />
            <ReportTable title="Review Status" rows={data.reviewStatus} labelKey="review_status" valueKey="count" icon="fact_check" />
          </>
        )}
      </main>
    </div>
  );
}

function ReportTable({ title, rows, labelKey, valueKey, icon }: { title: string; rows: any[]; labelKey: string; valueKey: string; icon: string }) {
  return (
    <section className="bg-surface-card border border-border-subtle rounded-xl shadow-sm overflow-hidden h-max flex flex-col">
      <div className="p-5 border-b border-border-subtle bg-surface-container-lowest flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
          <span className="material-symbols-outlined">{icon}</span>
        </div>
        <h3 className="font-headline-2 text-headline-2 text-on-surface">{title}</h3>
      </div>
      <div className="flex-1 bg-surface-bg/50">
        {rows.length === 0 ? (
          <div className="p-8 flex flex-col items-center justify-center text-secondary h-full min-h-[160px]">
            <span className="material-symbols-outlined text-4xl mb-2 opacity-20">hourglass_empty</span>
            <p className="font-metadata">No data available for {title.toLowerCase()}</p>
          </div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {rows.map((row, index) => (
              <div key={index} className="p-4 flex items-center justify-between gap-4 hover:bg-surface-container transition-colors">
                <span className="text-on-surface font-medium capitalize">{row[labelKey] || 'Unassigned'}</span>
                <span className="font-technical text-primary bg-primary/10 px-3 py-1 rounded-full text-sm font-bold">
                  {row[valueKey]}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
