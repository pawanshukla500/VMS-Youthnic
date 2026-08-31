import React, { useEffect, useState } from 'react';
import { getAllRecordings } from '../utils/videoQueue';

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export default function UploadQueue() {
  const [recordings, setRecordings] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const loadQueue = async () => {
      const records = await getAllRecordings();
      if (!cancelled) {
        setRecordings(records.sort((a: any, b: any) => b.timestamp - a.timestamp));
        setIsLoading(false);
      }
    };

    loadQueue();
    const interval = window.setInterval(loadQueue, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-surface-bg">
      <header className="bg-surface-container-lowest flex items-center px-gutter py-3 min-h-[64px] border-b border-border-subtle shrink-0">
        <h2 className="font-headline-1 text-headline-1 font-bold text-on-background">Upload Queue</h2>
      </header>
      <main className="flex-1 overflow-auto p-gutter">
        {isLoading && <div className="p-8 text-secondary">Loading local upload queue...</div>}
        {!isLoading && (
          <div className="bg-surface-card rounded-lg border border-border-subtle shadow-sm overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[920px]">
              <thead className="bg-surface-container-low border-b border-border-subtle">
                <tr>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Tracking ID</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Order ID</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Marketplace</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">File Size</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Status</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Progress</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Retries</th>
                </tr>
              </thead>
              <tbody>
                {recordings.map(record => {
                  const progress = Math.min(100, Math.max(0, Math.round(Number(record.uploadProgress) || 0)));
                  return (
                    <tr key={record.id} className="border-b border-border-subtle hover:bg-surface-bg transition-colors">
                      <td className="p-4 font-technical text-on-surface">{record.trackingId || 'UNKNOWN'}</td>
                      <td className="p-4 font-technical text-on-surface">{record.orderId || '-'}</td>
                      <td className="p-4 text-on-surface">{record.marketplace || 'Unassigned'}</td>
                      <td className="p-4 font-technical text-secondary">{formatBytes(record.blob?.size || 0)}</td>
                      <td className="p-4">
                        <span className={`px-2 py-1 rounded text-xs font-bold border ${
                          record.status === 'completed'
                            ? 'bg-success/10 text-success border-success/20'
                            : record.status === 'failed'
                              ? 'bg-critical/10 text-critical border-critical/20'
                              : 'bg-warning/10 text-warning border-warning/20'
                        }`}>
                          {String(record.status || 'pending').toUpperCase()}
                        </span>
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-3">
                          <div className="h-2 w-32 bg-surface-container-high rounded-full overflow-hidden">
                            <div className="h-full bg-primary transition-all duration-300" style={{ width: `${progress}%` }} />
                          </div>
                          <span className="font-technical text-metadata text-secondary">{progress}%</span>
                        </div>
                      </td>
                      <td className="p-4 font-technical text-secondary">{record.retryCount || 0}</td>
                    </tr>
                  );
                })}
                {recordings.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-secondary">No local recordings waiting for upload.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
