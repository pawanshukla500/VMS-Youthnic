import React from 'react';
import useSWR from 'swr';
import { authFetch } from '../utils/authFetch';
import { getApiBaseUrl } from '../utils/apiBase';
import { PageHeader, Card, CardHeader, StatusBadge } from '../components/ui';

const API_URL = getApiBaseUrl();

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Failed to load system health');
  return res.json();
};

export default function SystemHealth() {
  const { data, error, isLoading } = useSWR(`${API_URL}/api/admin/system-health`, fetcher, {
    refreshInterval: 15000
  });

  const statusTone = data?.status === 'OK' ? 'text-success' : 'text-warning';

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-surface-bg">
      <PageHeader title="System Health" description="Live service status and storage metrics" />
      <main className="flex-1 overflow-y-auto p-gutter space-y-6">
        {isLoading && (
          <div className="space-y-6" aria-busy="true">
            <Card>
              <div className="p-6 animate-pulse">
                <div className="h-3 w-40 rounded bg-surface-container mb-4"></div>
                <div className="h-9 w-32 rounded bg-surface-container"></div>
              </div>
            </Card>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[0, 1, 2, 3].map((i) => (
                <Card key={i}>
                  <div className="p-5 animate-pulse">
                    <div className="h-3 w-1/2 rounded bg-surface-container mb-4"></div>
                    <div className="h-6 w-20 rounded bg-surface-container"></div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}
        {error && (
          <div className="p-4 bg-critical/10 text-critical border border-critical/20 rounded-lg flex items-start gap-2">
            <span className="material-symbols-outlined">error</span>
            <p className="font-body-sm text-body-sm">{error.message}</p>
          </div>
        )}
        {data && (
          <>
            <Card>
              <div className="p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 relative overflow-hidden">
                <div className={`absolute top-0 left-0 w-1 h-full ${data.status === 'OK' ? 'bg-success' : 'bg-warning'}`}></div>
                <div>
                  <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-1">Overall System Status</p>
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className={`material-symbols-outlined text-4xl ${statusTone}`}>
                      {data.status === 'OK' ? 'check_circle' : 'warning'}
                    </span>
                    <p className={`font-headline-1 text-4xl font-bold ${statusTone}`}>{data.status}</p>
                    <StatusBadge status={data.status} pulse={data.status === 'OK'} />
                  </div>
                </div>
                <div className="sm:text-right">
                  <p className="font-metadata text-metadata text-secondary mb-1">Last Checked</p>
                  <p className="font-technical text-body-sm font-medium text-on-surface">{new Date(data.checkedAt).toLocaleString()}</p>
                  <p className="font-metadata text-metadata text-secondary mt-1 flex items-center sm:justify-end gap-1">
                    <span className="material-symbols-outlined text-[14px]">timer</span>
                    {data.responseMs} ms
                  </p>
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader icon="settings_system_daydream" title="Services" description="Live status per dependency" />
              <div className="p-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  {Object.entries(data.services).map(([name, status]) => {
                    const isOk = status === 'OK';
                    const iconMap: Record<string, string> = {
                      api: 'api',
                      database: 'database',
                      authentication: 'vpn_key',
                      firebaseStorage: 'cloud_done'
                    };
                    return (
                      <div key={name} className="bg-surface-container border border-border-subtle rounded-xl p-4 flex flex-col gap-3">
                        <div className="flex justify-between items-start gap-2">
                          <p className="font-metadata text-metadata text-secondary uppercase tracking-wider">{name.replace(/([A-Z])/g, ' $1').trim()}</p>
                          <span className={`material-symbols-outlined ${isOk ? 'text-success' : 'text-critical'}`}>
                            {iconMap[name] || 'settings_system_daydream'}
                          </span>
                        </div>
                        <StatusBadge status={String(status)} pulse={isOk} />
                      </div>
                    );
                  })}
                </div>
              </div>
            </Card>

            <RecordingQualityCard quality={data.recordingQuality} />
            <ServerResourcesCard server={data.server} />

            <Card>
              <CardHeader icon="mail" title="Admin Email Alerts" description="Resend delivery status" />
              <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
                {([
                  { label: 'Daily report', on: data.emailAlerts?.dailyReport },
                  { label: 'Failure alerts', on: data.emailAlerts?.failureAlerts },
                ] as const).map((row) => (
                  <div key={row.label} className="bg-surface-container border border-border-subtle rounded-xl p-4 flex flex-col gap-3">
                    <div className="flex justify-between items-start gap-2">
                      <p className="font-metadata text-metadata text-secondary uppercase tracking-wider">{row.label}</p>
                      <span className={`material-symbols-outlined ${row.on ? 'text-success' : 'text-critical'}`}>
                        mail
                      </span>
                    </div>
                    <StatusBadge status={row.on ? 'ON' : 'OFF'} pulse={!!row.on} />
                    {!row.on && (
                      <p className="text-xs text-secondary">Off — set RESEND_API_KEY and REPORT_TO_EMAILS on the server, then redeploy.</p>
                    )}
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <CardHeader icon="hard_drive" title="Storage Metrics" description="Firebase bucket usage" />
              <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-8">
                <div>
                  <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-2">Primary Bucket</p>
                  <p className="font-technical text-body-lg text-on-surface break-all bg-surface-container rounded-lg p-2 border border-border-subtle inline-block">
                    {data.firebaseStorage?.bucket || 'Not configured'}
                  </p>
                </div>
                <div>
                  <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-2">Storage Usage</p>
                  <p className="font-headline-1 text-3xl font-bold text-primary">{data.firebaseStorage?.formatted || '—'}</p>
                </div>
                <div>
                  <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-2">Total Files</p>
                  <p className="font-headline-1 text-3xl font-bold text-on-surface">{data.firebaseStorage?.fileCount ?? '—'}</p>
                </div>
              </div>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}

function Metric({ label, value, hint, tone = 'text-on-surface' }: { label: string; value: React.ReactNode; hint?: string; tone?: string }) {
  return (
    <div>
      <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-1">{label}</p>
      <p className={`font-headline-2 text-headline-2 font-bold ${tone}`}>{value}</p>
      {hint && <p className="font-metadata text-metadata text-secondary mt-0.5">{hint}</p>}
    </div>
  );
}

// Smoothness of the last 24 h of recordings (frame stats sent with uploads).
function RecordingQualityCard({ quality }: { quality: any }) {
  if (!quality) return null;
  const videos = Number(quality.videos || 0);
  const laggy = Number(quality.laggy || 0);
  const frames = Number(quality.frames || 0);
  const dropped = Number(quality.droppedFrames || 0);
  const dropPct = frames + dropped > 0 ? Math.round((dropped / (frames + dropped)) * 1000) / 10 : 0;
  return (
    <Card>
      <CardHeader icon="videocam" title="Recording quality (24 h)" description="Frame timing reported by the packing stations" />
      <div className="p-6 grid grid-cols-2 lg:grid-cols-5 gap-6">
        {videos === 0 ? (
          <p className="col-span-full font-body-sm text-body-sm text-secondary">
            No measured recordings yet — stations report this after updating to the new recorder.
          </p>
        ) : (
          <>
            <Metric label="Videos measured" value={videos} hint={`${quality.workerMode || 0} on the smooth (worker) recorder`} />
            <Metric label="Laggy videos" value={laggy} tone={laggy > 0 ? 'text-warning' : 'text-success'} hint={videos ? `${Math.round((laggy / videos) * 100)}% of measured` : undefined} />
            <Metric label="Dropped frames" value={`${dropPct}%`} tone={dropPct > 2 ? 'text-warning' : 'text-success'} hint={`${dropped.toLocaleString()} of ${(frames + dropped).toLocaleString()}`} />
            <Metric label="Camera fps (avg)" value={quality.avgCameraFps ?? '—'} tone={quality.avgCameraFps !== null && quality.avgCameraFps < 20 ? 'text-warning' : 'text-on-surface'} hint="Low light makes webcams slow down" />
            <Metric label="Worst camera stall" value={quality.worstGapMs !== null ? `${Math.round(quality.worstGapMs)} ms` : '—'} hint={quality.avgP95ComposeMs !== null ? `watermark p95 ${quality.avgP95ComposeMs} ms/frame` : undefined} />
          </>
        )}
      </div>
    </Card>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// API process health (sampled once a minute on the server).
function ServerResourcesCard({ server }: { server: any }) {
  if (!server) return null;
  return (
    <Card>
      <CardHeader icon="memory" title="Server resources" description="Backend process, sampled every minute" />
      <div className="p-6 grid grid-cols-2 lg:grid-cols-4 gap-6">
        <Metric label="Memory (RSS)" value={`${server.rssMb} MB`} hint={`peak ${server.peakRssMb} MB · heap ${server.heapUsedMb}/${server.heapTotalMb} MB`} tone={server.rssMb > 450 ? 'text-warning' : 'text-on-surface'} />
        <Metric label="Event-loop delay p99" value={`${server.eventLoopP99Ms} ms`} hint={`peak ${server.peakEventLoopP99Ms} ms · max ${server.eventLoopMaxMs} ms`} tone={server.eventLoopP99Ms > 200 ? 'text-warning' : 'text-on-surface'} />
        <Metric label="Uptime" value={formatUptime(Number(server.uptimeSeconds || 0))} />
        <Metric label="Sampled" value={server.sampledAt ? new Date(server.sampledAt).toLocaleTimeString() : '—'} />
      </div>
    </Card>
  );
}
