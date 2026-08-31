import React from 'react';
import useSWR from 'swr';
import { authFetch } from '../utils/authFetch';
import toast from 'react-hot-toast';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

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
            <ReportTable title="Upload Status" rows={data.uploadStatus} labelKey="upload_status" valueKey="count" />
            <ReportTable title="Station Performance" rows={data.stationPerformance} labelKey="station" valueKey="count" />
            <ReportTable title="Marketplace Performance" rows={data.marketplacePerformance} labelKey="marketplace" valueKey="count" />
            <ReportTable title="Review Status" rows={data.reviewStatus} labelKey="review_status" valueKey="count" />
          </>
        )}
      </main>
    </div>
  );
}

function ReportTable({ title, rows, labelKey, valueKey }: { title: string; rows: any[]; labelKey: string; valueKey: string }) {
  return (
    <section className="bg-surface-card border border-border-subtle rounded-lg shadow-sm overflow-hidden h-max">
      <div className="p-5 border-b border-border-subtle">
        <h3 className="font-headline-2 text-headline-2">{title}</h3>
      </div>
      <div className="divide-y divide-border-subtle">
        {rows.length === 0 && <div className="p-5 text-secondary">No data.</div>}
        {rows.map((row, index) => (
          <div key={index} className="p-4 flex justify-between gap-4">
            <span className="text-on-surface">{row[labelKey] || 'none'}</span>
            <span className="font-technical text-primary">{row[valueKey]}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
