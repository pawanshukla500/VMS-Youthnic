import React, { useState } from 'react';
import useSWR from 'swr';
import toast from 'react-hot-toast';
import { authFetch } from '../utils/authFetch';
import { getApiBaseUrl } from '../utils/apiBase';

const API_URL = getApiBaseUrl();
const SAMPLE_CSV = 'Shipment Tracker,Channel Order Id,Channel Name\n`13372336870292,`408-2081172-2601919,VB EXPORT - Cocoblu';

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Failed to load order mappings');
  return res.json();
};

export default function OrderImports() {
  const [csv, setCsv] = useState('');
  const [sourceFile, setSourceFile] = useState('daily-marketplace-orders.csv');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [search, setSearch] = useState('');
  const [marketplace, setMarketplace] = useState('All Marketplaces');
  const [lastResult, setLastResult] = useState<any>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const query = new URLSearchParams();
  if (search) query.append('search', search);
  if (marketplace !== 'All Marketplaces') query.append('marketplace', marketplace);

  const { data, error, isLoading, mutate } = useSWR(`${API_URL}/api/admin/order-mappings?${query.toString()}`, fetcher, {
    refreshInterval: 30000
  });

  const mappings = data?.mappings || [];
  const marketplaces = data?.marketplaces || [];

  const importCsv = async () => {
    if (!selectedFile && !csv.trim()) {
      toast.error('CSV data is required');
      return;
    }

    setIsSubmitting(true);
    try {
      const requestOptions: RequestInit = selectedFile
        ? (() => {
            const formData = new FormData();
            formData.append('file', selectedFile);
            return { method: 'POST', body: formData };
          })()
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ csv, sourceFile })
          };

      const res = await authFetch(`${API_URL}/api/admin/order-mappings/import`, requestOptions);
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `Import failed with status ${res.status}`);
      setLastResult(result);
      await mutate();
      toast.success(`Imported ${result.imported} mappings`);
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const reconcile = async () => {
    setIsSubmitting(true);
    try {
      const res = await authFetch(`${API_URL}/api/admin/order-mappings/reconcile`, { method: 'POST' });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `Reconcile failed with status ${res.status}`);
      setLastResult(result);
      await mutate();
      toast.success(`Updated ${result.updatedRecordings} recordings`);
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : 'Reconcile failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const readCsvFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
    setSourceFile(file.name);
    if (file.name.toLowerCase().endsWith('.csv') || file.type === 'text/csv') {
      setCsv(await file.text());
    } else {
      setCsv('');
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-surface-bg">
      <header className="bg-surface-container-lowest flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 px-gutter py-3 min-h-[64px] border-b border-border-subtle shrink-0">
        <h2 className="font-headline-1 text-headline-1 font-bold text-on-background">Order Imports</h2>
        <button
          type="button"
          onClick={reconcile}
          disabled={isSubmitting}
          className="bg-surface-card border border-border-heavy text-on-surface px-4 py-2 rounded-lg font-medium flex items-center gap-2 hover:bg-surface-variant disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-sm">sync</span>
          Reconcile
        </button>
      </header>

      <main className="flex-1 overflow-y-auto p-gutter space-y-6">
        <section className="bg-surface-card border border-border-subtle rounded-lg shadow-sm overflow-hidden">
          <div className="p-5 border-b border-border-subtle flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div>
              <h3 className="font-headline-2 text-headline-2 text-on-surface">Daily Marketplace Data</h3>
              <p className="font-body-sm text-body-sm text-secondary">Excel columns supported: Shipment Tracker, Channel Order Id, Channel Name. Ajio uses ExtraInfo as Order ID.</p>
            </div>
            <label className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border-heavy bg-surface-bg text-on-surface cursor-pointer hover:bg-surface-variant">
              <span className="material-symbols-outlined text-sm">upload_file</span>
              Select File
              <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={readCsvFile} className="hidden" />
            </label>
          </div>
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_220px] gap-4">
              <textarea
                value={csv}
                onChange={(event) => {
                  setSelectedFile(null);
                  setCsv(event.target.value);
                }}
                placeholder={SAMPLE_CSV}
                className="min-h-[220px] w-full bg-surface-bg border border-border-heavy rounded-lg p-4 font-technical text-technical text-on-surface focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                spellCheck={false}
              />
              <div className="space-y-3">
                {selectedFile && (
                  <div className="rounded-lg bg-surface-bg border border-border-subtle p-3 text-body-sm">
                    <p className="font-metadata text-metadata text-secondary mb-1">Selected File</p>
                    <p className="text-on-surface break-all">{selectedFile.name}</p>
                    <button
                      type="button"
                      onClick={() => setSelectedFile(null)}
                      className="mt-2 text-primary text-sm font-medium hover:underline"
                    >
                      Use pasted CSV instead
                    </button>
                  </div>
                )}
                <input
                  value={sourceFile}
                  onChange={(event) => setSourceFile(event.target.value)}
                  className="w-full bg-surface-bg border border-border-heavy rounded-lg px-3 py-2 text-body-sm text-on-surface focus:outline-none focus:border-primary"
                  placeholder="Source file name"
                />
                <button
                  type="button"
                  onClick={importCsv}
                  disabled={isSubmitting}
                  className="w-full bg-primary text-on-primary px-4 py-2 rounded-lg font-medium flex items-center justify-center gap-2 hover:bg-primary/90 disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-sm">publish</span>
                  Import Data
                </button>
                {lastResult && (
                  <div className="rounded-lg bg-surface-bg border border-border-subtle p-3 text-body-sm">
                    <p className="font-metadata text-metadata text-secondary mb-2">Last Result</p>
                    {'imported' in lastResult && <p>Imported: <span className="font-technical">{lastResult.imported}</span></p>}
                    <p>Updated recordings: <span className="font-technical">{lastResult.updatedRecordings || 0}</span></p>
                    {lastResult.skipped?.length > 0 && <p>Skipped rows: <span className="font-technical">{lastResult.skipped.length}</span></p>}
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="bg-surface-card border border-border-subtle rounded-lg shadow-sm overflow-hidden">
          <div className="p-5 border-b border-border-subtle flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <h3 className="font-headline-2 text-headline-2 text-on-surface">Imported Mappings</h3>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="bg-surface-bg border border-border-heavy rounded-lg px-3 py-2 text-body-sm text-on-surface focus:outline-none focus:border-primary"
                placeholder="Search tracking or order"
              />
              <select
                value={marketplace}
                onChange={(event) => setMarketplace(event.target.value)}
                className="bg-surface-bg border border-border-heavy rounded-lg px-3 py-2 text-body-sm text-on-surface focus:outline-none focus:border-primary"
              >
                <option>All Marketplaces</option>
                {marketplaces.map((item: any) => (
                  <option key={item.marketplace}>{item.marketplace}</option>
                ))}
              </select>
            </div>
          </div>
          {isLoading && <div className="p-8 text-secondary">Loading mappings...</div>}
          {error && <div className="p-4 bg-error-container text-on-error-container">{error.message}</div>}
          {!isLoading && !error && (
            <div className="overflow-x-auto">
              <table className="w-full text-left min-w-[820px]">
                <thead className="bg-surface-container-low border-b border-border-subtle">
                  <tr>
                    <th className="p-4 font-metadata text-metadata text-secondary">Tracking ID</th>
                    <th className="p-4 font-metadata text-metadata text-secondary">Order ID</th>
                    <th className="p-4 font-metadata text-metadata text-secondary">Marketplace</th>
                    <th className="p-4 font-metadata text-metadata text-secondary">Source</th>
                    <th className="p-4 font-metadata text-metadata text-secondary">Imported</th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.map((item: any) => (
                    <tr key={`${item.tracking_id}-${item.order_id}`} className="border-b border-border-subtle hover:bg-surface-bg">
                      <td className="p-4 font-technical">{item.tracking_id}</td>
                      <td className="p-4 font-technical">{item.order_id}</td>
                      <td className="p-4">{item.marketplace}</td>
                      <td className="p-4">{item.source_file || '-'}</td>
                      <td className="p-4">{new Date(item.imported_at).toLocaleString()}</td>
                    </tr>
                  ))}
                  {mappings.length === 0 && (
                    <tr><td colSpan={5} className="p-8 text-center text-secondary">No mappings imported yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
