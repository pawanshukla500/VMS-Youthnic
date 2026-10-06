import React, { useState } from 'react';
import useSWR from 'swr';
import toast from 'react-hot-toast';
import { authFetch } from '../utils/authFetch';
import { getApiBaseUrl } from '../utils/apiBase';
import { PageHeader, Card, CardHeader, StatusBadge, EmptyState } from '../components/ui';

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
  const [unmappedSearch, setUnmappedSearch] = useState('');
  const [unmappedStage, setUnmappedStage] = useState('all');

  const query = new URLSearchParams();
  if (search) query.append('search', search);
  if (marketplace !== 'All Marketplaces') query.append('marketplace', marketplace);

  const { data, error, isLoading, mutate } = useSWR(`${API_URL}/api/admin/order-mappings?${query.toString()}`, fetcher, {
    refreshInterval: 30000
  });

  const mappings = data?.mappings || [];
  const marketplaces = data?.marketplaces || [];

  const unmappedQuery = new URLSearchParams();
  if (unmappedSearch) unmappedQuery.append('search', unmappedSearch);
  if (unmappedStage !== 'all') unmappedQuery.append('stage', unmappedStage);

  const { data: unmappedData, error: unmappedError, isLoading: unmappedLoading, mutate: mutateUnmapped } = useSWR(
    `${API_URL}/api/admin/recordings/unmapped?${unmappedQuery.toString()}`,
    fetcher,
    { refreshInterval: 30000 }
  );
  const unmapped = unmappedData?.recordings || [];

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
      toast.success(
        `Imported ${result.imported} mappings · ${result.updatedRecordings || 0} videos updated` +
        (result.datedOrders ? ` · ${result.datedOrders} order dates` : '') +
        (result.notRenamed ? ` · ${result.notRenamed} Ajio filed without rename` : '')
      );
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
      <PageHeader
        title="Order Imports"
        description="Upload daily marketplace data and review imported tracking mappings."
        actions={
          <button
            type="button"
            onClick={reconcile}
            disabled={isSubmitting}
            className="bg-surface-card border border-border-heavy text-on-surface px-4 py-2 rounded-lg font-medium flex items-center gap-2 hover:bg-surface-container disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-sm">sync</span>
            Reconcile
          </button>
        }
      />

      <main className="flex-1 overflow-y-auto p-gutter space-y-6">
        <Card>
          <CardHeader
            icon="upload_file"
            title="Daily Marketplace Data"
            description="Excel columns supported: Shipment Tracker, Channel Order Id, Channel Name. Ajio uses ExtraInfo as Order ID and renames videos only to FN…/EX… order numbers."
            action={
              <label className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border-heavy bg-surface-bg text-on-surface cursor-pointer hover:bg-surface-container shrink-0">
                <span className="material-symbols-outlined text-sm">upload_file</span>
                Select File
                <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={readCsvFile} className="hidden" />
              </label>
            }
          />
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_220px] gap-4">
              <div className="min-w-0 rounded-lg border border-border-heavy bg-surface-bg overflow-hidden focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
                <div className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle bg-surface-container-lowest">
                  <span className="material-symbols-outlined text-sm text-secondary">description</span>
                  <span className="font-metadata text-metadata text-secondary uppercase tracking-wider">Paste CSV data</span>
                </div>
                <textarea
                  value={csv}
                  onChange={(event) => {
                    setSelectedFile(null);
                    setCsv(event.target.value);
                  }}
                  placeholder={SAMPLE_CSV}
                  className="min-h-[220px] w-full bg-transparent p-4 font-technical text-technical text-on-surface focus:outline-none"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-3">
                {selectedFile && (
                  <div className="rounded-lg bg-surface-container-low border border-border-subtle p-3">
                    <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-1 flex items-center gap-1">
                      <span className="material-symbols-outlined text-sm">attach_file</span>
                      Selected File
                    </p>
                    <p className="text-body-sm text-on-surface break-all">{selectedFile.name}</p>
                    <button
                      type="button"
                      onClick={() => setSelectedFile(null)}
                      className="mt-2 text-primary text-body-sm font-medium hover:underline"
                    >
                      Use pasted CSV instead
                    </button>
                  </div>
                )}
                <label className="block">
                  <span className="font-metadata text-metadata text-secondary uppercase tracking-wider">Source file name</span>
                  <input
                    value={sourceFile}
                    onChange={(event) => setSourceFile(event.target.value)}
                    className="mt-1 w-full bg-surface-bg border border-border-heavy rounded-lg px-3 py-2 text-body-sm text-on-surface focus:outline-none focus:border-primary"
                    placeholder="Source file name"
                  />
                </label>
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
                  <div className="rounded-lg bg-surface-container-low border border-border-subtle p-3 space-y-2">
                    <p className="font-metadata text-metadata text-secondary uppercase tracking-wider">Last Result</p>
                    <div className="flex flex-wrap gap-2">
                      {'imported' in lastResult && <StatusBadge status="uploaded" />}
                      <StatusBadge status="completed" />
                      {lastResult.skipped?.length > 0 && <StatusBadge status="pending" />}
                    </div>
                    <div className="text-body-sm text-on-surface space-y-1">
                      {'imported' in lastResult && <p>Imported: <span className="font-technical">{lastResult.imported}</span></p>}
                      <p>Updated recordings: <span className="font-technical">{lastResult.updatedRecordings || 0}</span></p>
                      {lastResult.datedOrders > 0 && <p>Order dates found: <span className="font-technical">{lastResult.datedOrders}</span></p>}
                      {lastResult.notRenamed > 0 && (
                        <p title="Ajio rows without an FN/EX order number: video filed under Ajio, name unchanged">
                          Ajio filed, not renamed: <span className="font-technical">{lastResult.notRenamed}</span>
                        </p>
                      )}
                      {lastResult.skipped?.length > 0 && <p>Skipped rows: <span className="font-technical">{lastResult.skipped.length}</span></p>}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            icon="receipt_long"
            title="Imported Mappings"
            description="Tracking IDs mapped to marketplace orders."
            action={
              <div className="flex flex-col sm:flex-row gap-2 w-full lg:w-auto">
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
            }
          />
          {isLoading && (
            <div className="p-8 flex items-center gap-2 text-secondary">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              Loading mappings...
            </div>
          )}
          {error && (
            <div className="m-5 p-4 rounded-lg bg-critical/10 text-critical border border-critical/20 flex items-center gap-2">
              <span className="material-symbols-outlined text-sm">error</span>
              {error.message}
            </div>
          )}
          {!isLoading && !error && (
            <div className="overflow-x-auto">
              <table className="w-full text-left min-w-[1080px]">
                <thead className="bg-surface-container-low border-b border-border-subtle">
                  <tr>
                    <th className="p-4 font-metadata text-metadata text-secondary uppercase tracking-wider">Tracking ID</th>
                    <th className="p-4 font-metadata text-metadata text-secondary uppercase tracking-wider">Order ID</th>
                    <th className="p-4 font-metadata text-metadata text-secondary uppercase tracking-wider">Marketplace</th>
                    <th className="p-4 font-metadata text-metadata text-secondary uppercase tracking-wider">Order date</th>
                    <th className="p-4 font-metadata text-metadata text-secondary uppercase tracking-wider">Video</th>
                    <th className="p-4 font-metadata text-metadata text-secondary uppercase tracking-wider">Source</th>
                    <th className="p-4 font-metadata text-metadata text-secondary uppercase tracking-wider">Imported</th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.map((item: any) => (
                    <tr key={`${item.tracking_id}-${item.order_id}`} className="border-b border-border-subtle hover:bg-surface-container-low">
                      <td className="p-4 font-technical text-technical text-on-surface">{item.tracking_id}</td>
                      <td className="p-4 font-technical text-technical text-on-surface">
                        {item.order_id}
                        {item.rename_order === false && (
                          <span
                            className="ml-2 align-middle inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold border bg-warning/10 text-warning border-warning/20"
                            title="Ajio row without an FN/EX order number: the video is filed under Ajio but keeps its name"
                          >
                            NOT RENAMED
                          </span>
                        )}
                      </td>
                      <td className="p-4 whitespace-nowrap"><StatusBadge status={item.marketplace || 'info'} /></td>
                      <td className="p-4 text-body-sm text-on-surface whitespace-nowrap">{item.order_date ? new Date(item.order_date).toLocaleString() : <span className="text-secondary">—</span>}</td>
                      <td className="p-4 text-body-sm whitespace-nowrap">
                        {item.recording_id ? (
                          item.rename_order !== false && item.recording_order_id === item.order_id
                            ? <span className="text-success font-medium" title={item.recorded_at ? `Recorded ${new Date(item.recorded_at).toLocaleString()}` : undefined}>Renamed ✓</span>
                            : <span className="text-on-surface" title="Video found and filed under this marketplace">Filed under {item.marketplace}</span>
                        ) : (
                          <span className="text-secondary">No video yet</span>
                        )}
                      </td>
                      <td className="p-4 text-body-sm text-on-surface max-w-[260px] truncate" title={item.source_file || ''}>{item.source_file || '-'}</td>
                      <td className="p-4 text-body-sm text-secondary whitespace-nowrap">{new Date(item.imported_at).toLocaleString()}</td>
                    </tr>
                  ))}
                  {mappings.length === 0 && (
                    <tr><td colSpan={7} className="p-0"><EmptyState icon="inbox" title="No mappings imported yet" hint="Upload a daily marketplace CSV above to populate this table." /></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            icon="drive_file_rename_outline"
            title="Needs Mapping"
            description="Recordings that never matched an import. Rename them to an order here and the file moves to its marketplace folder."
            action={
              <div className="flex flex-col sm:flex-row gap-2 w-full lg:w-auto">
                <input
                  value={unmappedSearch}
                  onChange={(event) => setUnmappedSearch(event.target.value)}
                  className="bg-surface-bg border border-border-heavy rounded-lg px-3 py-2 text-body-sm text-on-surface focus:outline-none focus:border-primary"
                  placeholder="Search tracking"
                />
                <select
                  value={unmappedStage}
                  onChange={(event) => setUnmappedStage(event.target.value)}
                  className="bg-surface-bg border border-border-heavy rounded-lg px-3 py-2 text-body-sm text-on-surface focus:outline-none focus:border-primary"
                >
                  <option value="all">All stages</option>
                  <option value="unrenamed">Needs rename</option>
                  <option value="renamed">Renamed, not moved</option>
                </select>
              </div>
            }
          />
          {unmappedLoading && (
            <div className="p-8 flex items-center gap-2 text-secondary">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              Loading unmapped recordings...
            </div>
          )}
          {unmappedError && (
            <div className="m-5 p-4 rounded-lg bg-critical/10 text-critical border border-critical/20 flex items-center gap-2">
              <span className="material-symbols-outlined text-sm">error</span>
              {unmappedError.message}
            </div>
          )}
          {!unmappedLoading && !unmappedError && (
            <div className="overflow-x-auto">
              <table className="w-full text-left min-w-[900px]">
                <thead className="bg-surface-container-low border-b border-border-subtle">
                  <tr>
                    <th className="p-4 font-metadata text-metadata text-secondary uppercase tracking-wider">Tracking ID</th>
                    <th className="p-4 font-metadata text-metadata text-secondary uppercase tracking-wider">Recorded</th>
                    <th className="p-4 font-metadata text-metadata text-secondary uppercase tracking-wider">Rename Stage</th>
                    <th className="p-4 font-metadata text-metadata text-secondary uppercase tracking-wider">Move Stage</th>
                    <th className="p-4 font-metadata text-metadata text-secondary uppercase tracking-wider">Set Order + Marketplace</th>
                    <th className="p-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {unmapped.map((item: any) => (
                    <RemapRow key={item.id} item={item} marketplaces={marketplaces} onSaved={() => mutateUnmapped()} />
                  ))}
                  {unmapped.length === 0 && (
                    <tr><td colSpan={6} className="p-0"><EmptyState icon="check_circle" title="Nothing needs mapping" hint="Every recording is matched to an order and filed in its folder." /></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </main>
    </div>
  );
}

function RemapRow({ item, marketplaces, onSaved }: { item: any; marketplaces: any[]; onSaved: () => void }) {
  const [orderId, setOrderId] = useState(item.order_id || '');
  const [marketplace, setMarketplace] = useState(item.marketplace || '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!orderId.trim() || !marketplace.trim()) {
      toast.error('Order ID and marketplace are both required');
      return;
    }
    setSaving(true);
    try {
      const res = await authFetch(`${API_URL}/api/admin/recordings/${item.id}/mapping`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: orderId.trim(), marketplace: marketplace.trim() }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || `Save failed with status ${res.status}`);
      toast.success(result.moved ? 'Renamed and file moved' : 'Renamed (file move pending)');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save mapping');
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr className="border-b border-border-subtle hover:bg-surface-container-low">
      <td className="p-4 font-technical text-technical text-on-surface">{item.tracking_id}</td>
      <td className="p-4 text-body-sm text-secondary">{new Date(item.created_at).toLocaleString()}</td>
      <td className="p-4"><StatusBadge status={item.renamed ? 'completed' : 'pending'} /></td>
      <td className="p-4"><StatusBadge status={item.moved ? 'completed' : 'pending'} /></td>
      <td className="p-4">
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            placeholder="Order ID"
            className="bg-surface-bg border border-border-heavy rounded-lg px-3 py-2 text-body-sm font-technical text-on-surface focus:outline-none focus:border-primary min-w-[140px]"
          />
          <input
            value={marketplace}
            onChange={(e) => setMarketplace(e.target.value)}
            placeholder="Marketplace"
            list="remap-marketplaces"
            className="bg-surface-bg border border-border-heavy rounded-lg px-3 py-2 text-body-sm text-on-surface focus:outline-none focus:border-primary min-w-[140px]"
          />
          <datalist id="remap-marketplaces">
            {(marketplaces || []).map((m: any) => (
              <option key={m.marketplace || m} value={m.marketplace || m} />
            ))}
          </datalist>
        </div>
      </td>
      <td className="p-4 text-right">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="px-4 py-2 bg-primary text-on-primary rounded-lg font-medium text-sm hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </td>
    </tr>
  );
}
