import React, { useEffect, useState } from 'react';
import { getAllRecordings, countOverdue } from '../utils/videoQueue';
import { PageHeader, Card, CardHeader, StatusBadge, EmptyState } from '../components/ui';

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
      <PageHeader
        title="Upload Queue"
        description="Local recordings waiting for upload"
        actions={
          <span className="font-metadata text-metadata text-secondary">{recordings.length} recordings</span>
        }
      />
      <main className="flex-1 overflow-auto p-gutter">
        {(() => {
          const overdue = countOverdue(recordings.filter(r => r.status !== 'completed'));
          return overdue > 0 ? (
            <div className="mb-4 p-4 bg-warning/10 border border-warning/30 text-warning rounded-lg font-medium flex items-center gap-2">
              <span className="material-symbols-outlined">schedule</span>
              {overdue} video{overdue !== 1 ? 's' : ''} waiting over 24h — keep this PC online; oldest uploads go first.
            </div>
          ) : null;
        })()}
        {isLoading && <div className="p-8 text-secondary">Loading local upload queue...</div>}
        {!isLoading && (
          <Card>
            <CardHeader
              icon="cloud_upload"
              title="Upload queue"
              description="Newest recordings first"
            />
            {recordings.length === 0 ? (
              <EmptyState
                icon="cloud_upload"
                title="No local recordings waiting for upload."
                hint="Finished uploads clear from this queue automatically."
              />
            ) : (
              <div className="overflow-x-auto">
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
                            <StatusBadge
                              status={String(record.status || 'pending')}
                              pulse={record.status === 'uploading' || record.status === 'pending'}
                            />
                            {record.error && (
                              <div className="text-xs text-critical mt-1 max-w-[200px] truncate" title={record.error}>
                                {record.error}
                              </div>
                            )}
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
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </main>
    </div>
  );
}
