import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { authFetch } from '../../utils/authFetch';
import { getApiBaseUrl } from '../../utils/apiBase';

const API_URL = getApiBaseUrl();

interface SkuPhotoBulkModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

export function SkuPhotoBulkModal({ onClose, onSuccess }: SkuPhotoBulkModalProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [csvText, setCsvText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [downloadingMissing, setDownloadingMissing] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    imported: number;
    ordersUpdated: number;
    totalRows: number;
    skippedCount: number;
    skipped: Array<{ row: number; sku?: string; reason: string }>;
    batchErrors?: Array<{ batch: number; error: string }>;
  } | null>(null);

  // Helper to trigger streaming file download from API
  const handleDownload = async (endpoint: string, fallbackFilename: string, setLoading: (b: boolean) => void) => {
    setLoading(true);
    const toastId = toast.loading('Preparing CSV download... (this may take a few moments for large files)');
    try {
      const res = await authFetch(`${API_URL}${endpoint}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Download failed with status ${res.status}`);
      }

      // Extract filename from header if present
      const disposition = res.headers.get('Content-Disposition');
      let filename = fallbackFilename;
      if (disposition && disposition.includes('filename=')) {
        const match = disposition.match(/filename="?([^";]+)"?/);
        if (match && match[1]) filename = match[1];
      }

      // Stream directly to disk via showSaveFilePicker if supported to avoid buffering 100k+ rows in memory
      if ('showSaveFilePicker' in window && res.body) {
        try {
          const handle = await (window as any).showSaveFilePicker({
            suggestedName: filename,
            types: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }],
          });
          const writable = await handle.createWritable();
          await res.body.pipeTo(writable);
          toast.success('Download complete!', { id: toastId });
          return;
        } catch (pickerErr: any) {
          if (pickerErr?.name === 'AbortError') {
            toast.dismiss(toastId);
            return;
          }
          // Fall back to standard blob download if canceled or unsupported
        }
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast.success('Download complete!', { id: toastId });
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : 'Download failed', { id: toastId });
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadTemplate = () => {
    const templateContent = 'SKU,Image Link,Title\nBT216-Geomi-Rust_S,https://cdn.example.com/rust.jpg,Geomi Rust Kurta\nBT218-Cat-Pink_M,https://cdn.example.com/pink.jpg,Cat Pink Kurta';
    const blob = new Blob([templateContent], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sku-photos-template.csv';
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile && !csvText.trim()) {
      toast.error('Please select a CSV/Excel file or paste CSV text');
      return;
    }

    setResult(null);
    setIsSubmitting(true);
    const toastId = toast.loading('Processing SKU photos in batches... Updating orders');
    try {
      let requestOptions: RequestInit;

      if (selectedFile) {
        const formData = new FormData();
        formData.append('file', selectedFile);
        requestOptions = { method: 'POST', body: formData };
      } else {
        requestOptions = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csv: csvText, filename: 'pasted-sku-photos.csv' }),
        };
      }

      const res = await authFetch(`${API_URL}/api/sku-images/import`, requestOptions);
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (Array.isArray(data.skipped) && data.skipped.length > 0) {
          setResult({
            ok: false,
            imported: 0,
            ordersUpdated: 0,
            totalRows: data.skipped.length,
            skippedCount: data.skipped.length,
            skipped: data.skipped,
          });
        }
        throw new Error(data.error || `Import failed with status ${res.status}`);
      }

      setResult(data);
      if (data.imported > 0) {
        toast.success(`Imported ${data.imported} photo links · Updated ${data.ordersUpdated} orders`, { id: toastId });
        onSuccess();
      } else {
        toast.error('No photo links were imported', { id: toastId });
      }
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : 'Import failed', { id: toastId });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-start justify-center overflow-y-auto p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Bulk SKU Photos"
    >
      <div className="bg-surface-card rounded-xl border border-border-subtle shadow-xl w-full max-w-2xl my-8 overflow-hidden">
        {/* Header */}
        <div className="p-5 border-b border-border-subtle flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined">photo_library</span>
            </div>
            <div>
              <h3 className="font-headline-2 text-headline-2 text-on-surface">Bulk SKU Photo Links</h3>
              <p className="font-body-sm text-body-sm text-secondary">
                Download catalogue photo links or upload CSV/Excel to replace photo links batch-wise.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-secondary hover:text-on-surface p-1 rounded-lg"
            aria-label="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {/* Export Actions Bar */}
        <div className="p-5 bg-surface-container-low border-b border-border-subtle space-y-3">
          <p className="font-metadata text-metadata text-secondary uppercase tracking-wider">Download Options</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={downloadingAll || isSubmitting}
              onClick={() => handleDownload('/api/sku-images/export', 'sku-photos-all.csv', setDownloadingAll)}
              className="px-3 py-2 rounded-lg text-body-sm font-medium border border-border-heavy bg-surface-card text-on-surface hover:bg-surface-container flex items-center gap-1.5 disabled:opacity-50"
              title="Export all existing SKU photo links to CSV"
            >
              <span className={`material-symbols-outlined text-sm ${downloadingAll ? 'animate-spin' : ''}`}>
                {downloadingAll ? 'progress_activity' : 'download'}
              </span>
              {downloadingAll ? 'Preparing All Photos…' : 'Download All Photos (CSV)'}
            </button>

            <button
              type="button"
              disabled={downloadingMissing || isSubmitting}
              onClick={() => handleDownload('/api/sku-images/export-missing', 'sku-photos-missing.csv', setDownloadingMissing)}
              className="px-3 py-2 rounded-lg text-body-sm font-medium border border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 flex items-center gap-1.5 disabled:opacity-50"
              title="Download SKUs from orders and catalogue that currently lack photo links"
            >
              <span className={`material-symbols-outlined text-sm ${downloadingMissing ? 'animate-spin' : ''}`}>
                {downloadingMissing ? 'progress_activity' : 'image_not_supported'}
              </span>
              {downloadingMissing ? 'Preparing Missing…' : 'Download Missing Photos (CSV)'}
            </button>

            <button
              type="button"
              onClick={handleDownloadTemplate}
              className="px-3 py-2 rounded-lg text-body-sm font-medium border border-border-heavy bg-surface-card text-secondary hover:text-on-surface hover:bg-surface-container flex items-center gap-1.5 ml-auto"
              title="Download a blank sample template"
            >
              <span className="material-symbols-outlined text-sm">description</span>
              Sample Template
            </button>
          </div>
        </div>

        {/* Upload Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-2">
              Upload CSV or Excel file
            </p>
            <p className="text-body-sm text-secondary mb-3">
              Expected columns: <strong className="text-on-surface">SKU</strong>, <strong className="text-on-surface">Image Link</strong>, and optional <strong className="text-on-surface">Title</strong>. Newly uploaded links replace old ones and update existing order thumbnails immediately.
            </p>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onDragEnter={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDragging(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDragging(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (file) {
                  setSelectedFile(file);
                  setCsvText('');
                  setResult(null);
                }
              }}
              className={`border-2 border-dashed rounded-xl p-6 text-center transition-colors bg-surface-bg cursor-pointer ${
                isDragging ? 'border-primary bg-primary/5' : 'border-border-heavy hover:border-primary'
              }`}
            >
              <span className={`material-symbols-outlined text-4xl mb-2 ${isDragging ? 'text-primary' : 'text-secondary'}`}>
                upload_file
              </span>
              <p className="text-body-sm text-on-surface font-medium">
                {selectedFile ? selectedFile.name : isDragging ? 'Drop file here' : 'Choose a file or drag & drop'}
              </p>
              <p className="text-xs text-secondary mt-1">Accepts .csv, .xlsx</p>
              <input
                type="file"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  setSelectedFile(file);
                  if (file) {
                    setCsvText('');
                    setResult(null);
                  }
                }}
                className="mt-3 block mx-auto text-body-sm text-secondary file:mr-4 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-body-sm file:font-medium file:bg-primary file:text-on-primary hover:file:bg-primary/90 cursor-pointer"
              />
            </div>
          </div>

          <div className="space-y-2">
            <details className="text-body-sm text-secondary">
              <summary className="cursor-pointer hover:text-on-surface font-medium py-1">
                Or paste CSV text directly
              </summary>
              <textarea
                value={csvText}
                onChange={(e) => {
                  setCsvText(e.target.value);
                  if (e.target.value.trim()) {
                    setSelectedFile(null);
                    setResult(null);
                  }
                }}
                rows={5}
                className="mt-2 w-full bg-surface-bg border border-border-heavy rounded-lg p-3 font-technical text-technical text-on-surface focus:outline-none focus:border-primary"
                placeholder={'SKU,Image Link,Title\nBT216-Geomi-Rust_S,https://cdn.example.com/rust.jpg,Geomi Rust Kurta'}
              />
            </details>
          </div>

          {/* Results Summary */}
          {result && (
            <div className="rounded-xl border border-border-subtle bg-surface-container-low p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-metadata text-metadata text-secondary uppercase tracking-wider">Upload Result</span>
                <span className={`px-2 py-0.5 rounded text-xs font-semibold border ${
                  result.ok ? 'bg-success/15 text-success border-success/30' : 'bg-critical/15 text-critical border-critical/30'
                }`}>
                  {result.ok ? 'Batch Completed' : 'Import Errors'}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center text-body-sm">
                <div className="p-2 rounded-lg bg-surface-card border border-border-subtle">
                  <p className="text-secondary text-xs">Total Rows</p>
                  <p className="font-technical text-base text-on-surface font-semibold">{result.totalRows}</p>
                </div>
                <div className="p-2 rounded-lg bg-success/10 border border-success/20">
                  <p className="text-success text-xs">Photo Links Saved</p>
                  <p className="font-technical text-base text-success font-semibold">{result.imported}</p>
                </div>
                <div className="p-2 rounded-lg bg-primary/10 border border-primary/20">
                  <p className="text-primary text-xs">Orders Updated</p>
                  <p className="font-technical text-base text-primary font-semibold">{result.ordersUpdated}</p>
                </div>
              </div>

              {result.batchErrors && result.batchErrors.length > 0 && (
                <div className="p-2 rounded-lg bg-critical/10 border border-critical/20 text-xs text-critical">
                  <p className="font-semibold">Batch Errors Encountered:</p>
                  {result.batchErrors.map((be, i) => (
                    <p key={i}>Batch {be.batch}: {be.error}</p>
                  ))}
                </div>
              )}

              {result.skippedCount > 0 && (
                <div className="space-y-1">
                  <p className="text-xs text-warning font-medium">
                    ⚠️ {result.skippedCount} row(s) skipped (invalid URL or color conflict):
                  </p>
                  <div className="max-h-36 overflow-y-auto text-xs bg-surface-bg rounded p-2 border border-border-subtle space-y-1">
                    {result.skipped.map((s, idx) => (
                      <p key={idx} className="text-secondary font-technical">
                        Row {s.row} {s.sku ? `[${s.sku}]` : ''}: <span className="text-critical">{s.reason}</span>
                      </p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="pt-3 border-t border-border-subtle flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 rounded-lg border border-border-heavy bg-surface-card text-on-surface hover:bg-surface-container font-medium text-body-sm"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={isSubmitting || (!selectedFile && !csvText.trim())}
              className="px-5 py-2 rounded-lg bg-primary text-on-primary hover:bg-primary/90 font-medium text-body-sm flex items-center gap-2 disabled:opacity-50"
            >
              <span className={`material-symbols-outlined text-sm ${isSubmitting ? 'animate-spin' : ''}`}>
                {isSubmitting ? 'sync' : 'publish'}
              </span>
              {isSubmitting ? 'Importing Batch…' : 'Import & Replace Links'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
