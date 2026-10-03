import React, { useState, useEffect } from 'react';
import useSWR, { mutate } from 'swr';
import { authFetch } from '../utils/authFetch';
import { getApiBaseUrl } from '../utils/apiBase';
import toast from 'react-hot-toast';
import { PageHeader, Card, CardHeader, StatusBadge, EmptyState } from '../components/ui';

const API_URL = getApiBaseUrl();

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Failed to load Ajio requests');
  return res.json();
};

const gmailFetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Failed to load Gmail status');
  return res.json();
};

function formatDateTime(value: unknown) {
  if (!value) return '-';
  const d = new Date(value as any);
  if (!Number.isFinite(d.getTime())) return '-';
  // Pinned to India time on every viewer — server stamps UTC, browsers roam.
  return `${d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true })} IST`;
}

export default function AjioWfr() {
  const [statusFilter, setStatusFilter] = useState('All');
  const [runResult, setRunResult] = useState<any | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const listUrl = statusFilter === 'All'
    ? `${API_URL}/api/admin/ajio-wfr`
    : `${API_URL}/api/admin/ajio-wfr?status=${encodeURIComponent(statusFilter.toLowerCase())}`;
  const { data, error, isLoading } = useSWR(listUrl, fetcher, { refreshInterval: 30000 });
  const { data: gmail, mutate: mutateGmail } = useSWR(`${API_URL}/api/admin/ajio-gmail/status`, gmailFetcher);

  // OAuth callback lands back here (?gmail=connected | error): toast once,
  // then clean the URL so refreshes stay quiet.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('gmail');
    if (result === 'connected') {
      toast.success('Gmail connected — the job can now read and reply');
      void mutateGmail();
    } else if (result === 'error') {
      toast.error(`Gmail connect failed (${params.get('reason') || 'unknown'})`);
    }
    if (result) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const connectGmail = async () => {
    try {
      const res = await authFetch(`${API_URL}/api/admin/ajio-gmail/auth-url`);
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || 'Gmail connect failed');
      if (!result.configured) throw new Error('Gmail OAuth is not configured on the server');
      window.location.href = result.url;
    } catch (err: any) {
      toast.error(err instanceof Error ? err.message : 'Gmail connect failed');
    }
  };

  const disconnectGmail = async () => {
    if (!window.confirm('Disconnect Gmail? The daily job will stop until you reconnect.')) return;
    try {
      const res = await authFetch(`${API_URL}/api/admin/ajio-gmail/disconnect`, { method: 'POST' });
      if (!res.ok) throw new Error('Gmail disconnect failed');
      toast.success('Gmail disconnected');
      void mutateGmail();
    } catch (err: any) {
      toast.error(err instanceof Error ? err.message : 'Gmail disconnect failed');
    }
  };

  const summary = data?.summary || {};
  const requests: any[] = data?.requests || [];
  const total = Object.values(summary).reduce((sum: number, n: any) => sum + (Number(n) || 0), 0);

  const runJob = async (dryRun: boolean) => {
    if (!dryRun && !window.confirm('Run the Ajio job live? Matched videos will upload to Drive and replies will be sent.')) return;
    setIsRunning(true);
    setRunResult(null);
    try {
      const res = await authFetch(`${API_URL}/api/admin/ajio-wfr/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun, limit: 10 }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || 'Ajio run failed');
      setRunResult({ dryRun, ...result });
      toast.success(dryRun ? 'Dry run complete' : 'Ajio run complete');
      mutate(listUrl);
    } catch (err: any) {
      toast.error(err instanceof Error ? err.message : 'Ajio run failed');
    } finally {
      setIsRunning(false);
    }
  };

  const summaryCards = [
    { label: 'Pending', value: summary.pending || 0, tone: 'text-warning' },
    { label: 'Replied', value: summary.done || 0, tone: 'text-success' },
    { label: 'Missing video', value: summary.missing || 0, tone: 'text-critical' },
    { label: 'Failed', value: summary.failed || 0, tone: 'text-critical' },
  ];

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-surface-bg">
      <PageHeader
        title="Ajio WFR Requests"
        description={total > 0 ? `${total} CCTV requests` : 'CCTV footage requests from Ajio'}
        actions={
          <>
            {gmail?.connected ? (
              <>
                <span className="text-on-surface font-body-sm text-body-sm flex items-center gap-2 px-2">
                  <span className={`material-symbols-outlined text-sm ${gmail?.needsReconnect ? 'text-warning' : 'text-success'}`}>
                    {gmail?.needsReconnect ? 'warning' : 'mark_email_read'}
                  </span>
                  {gmail?.needsReconnect ? 'Gmail needs reconnect (new permission)' : (gmail.email || 'Gmail connected')}
                </span>
                {gmail?.needsReconnect ? (
                  <button
                    onClick={() => void connectGmail()}
                    className="bg-primary text-on-primary px-4 py-2 rounded-lg font-medium text-sm flex items-center gap-2 hover:bg-primary/90 transition-colors"
                  >
                    <span className="material-symbols-outlined text-sm">mail</span>
                    Reconnect Gmail
                  </button>
                ) : (
                  <button
                    onClick={() => void disconnectGmail()}
                    className="bg-surface-container text-on-surface px-4 py-2 rounded-lg font-medium text-sm flex items-center gap-2 border border-border-subtle hover:bg-surface-container-high transition-colors"
                  >
                    <span className="material-symbols-outlined text-sm">link_off</span>
                    Disconnect
                  </button>
                )}
              </>
            ) : (
              <button
                onClick={() => void connectGmail()}
                className="bg-surface-container text-on-surface px-4 py-2 rounded-lg font-medium text-sm flex items-center gap-2 border border-border-subtle hover:bg-surface-container-high transition-colors"
              >
                <span className="material-symbols-outlined text-sm">mail</span>
                Connect Gmail
              </button>
            )}
            <button
              onClick={() => { void mutate(listUrl); }}
              className="bg-surface-container text-on-surface px-4 py-2 rounded-lg font-medium text-sm flex items-center gap-2 border border-border-subtle hover:bg-surface-container-high transition-colors"
            >
              <span className="material-symbols-outlined text-sm">refresh</span>
              Refresh
            </button>
            <button
              onClick={() => void runJob(true)}
              disabled={isRunning}
              className="bg-surface-container text-on-surface px-4 py-2 rounded-lg font-medium text-sm flex items-center gap-2 border border-border-subtle hover:bg-surface-container-high transition-colors disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-sm">play_circle</span>
              {isRunning ? 'Running…' : 'Dry run'}
            </button>
            <button
              onClick={() => void runJob(false)}
              disabled={isRunning}
              className="bg-primary text-on-primary px-4 py-2 rounded-lg font-medium text-sm flex items-center gap-2 hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-sm">send</span>
              Run now
            </button>
          </>
        }
      />
      <main className="flex-1 p-gutter overflow-auto">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          {summaryCards.map((card) => (
            <Card key={card.label}>
              <div className="p-4">
                <p className="font-metadata text-metadata text-secondary uppercase tracking-wider">{card.label}</p>
                <p className={`font-headline-1 text-headline-1 ${card.tone}`}>{card.value}</p>
              </div>
            </Card>
          ))}
        </div>

        {runResult && (
          <Card>
            <div className="p-4 font-body-sm text-body-sm text-on-surface">
              <p className="font-medium mb-1">
                {runResult.dryRun ? 'Dry run (nothing uploaded, nothing sent)' : 'Live run'} — checked {runResult.checked}, matched {runResult.matched}, uploaded {runResult.uploaded}, replied {runResult.replied}, missing {runResult.missing}, failed {runResult.failed}, skipped {runResult.skipped}
              </p>
              {(runResult.errors || []).length > 0 && (
                <ul className="mt-2 space-y-1 text-critical">
                  {(runResult.errors as string[]).map((e: string, i: number) => (
                    <li key={i} className="truncate" title={e}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        )}

        {isLoading && (
          <Card>
            <EmptyState icon="progress_activity" title="Loading requests..." hint="Reading the CCTV ledger." />
          </Card>
        )}
        {error && (
          <Card className="p-4 border-critical/20 bg-critical/10 text-critical font-body-sm text-body-sm">
            <span className="flex items-center gap-2">
              <span className="material-symbols-outlined text-sm">error</span>
              {error.message}
            </span>
          </Card>
        )}
        {!isLoading && !error && (
          <Card>
            <CardHeader
              icon="forward_to_inbox"
              title="CCTV requests"
              description="Each Ajio mail with its match, video, and reply status"
              action={
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="bg-surface-container-lowest border border-border-subtle rounded-lg px-2 py-1.5 text-sm text-on-surface focus:ring-2 focus:ring-primary focus:outline-none"
                >
                  {['All', 'Pending', 'Done', 'Missing', 'Failed'].map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              }
            />
            {requests.length === 0 ? (
              <EmptyState
                icon="forward_to_inbox"
                title="No requests yet."
                hint="Processed CCTV mails appear here with their status."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse min-w-[1080px]">
                  <thead className="bg-surface-container-low border-b border-border-subtle">
                    <tr>
                      <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Incident</th>
                      <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Order</th>
                      <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Shipment</th>
                      <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Reference</th>
                      <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Packing Time</th>
                      <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Video</th>
                      <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Status</th>
                      <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Requested</th>
                      <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Replied</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.map((row: any) => (
                      <tr key={row.id} className="border-b border-border-subtle last:border-0 hover:bg-surface-container-low transition-colors">
                        <td className="p-4 font-technical text-technical text-on-surface">{row.incident_id}</td>
                        <td className="p-4 font-technical text-technical text-on-surface">{row.order_id || '-'}</td>
                        <td className="p-4 font-technical text-secondary">{row.shipment_id || '-'}</td>
                        <td className="p-4 font-technical text-secondary">{row.reference_value || '-'}</td>
                        <td className="p-4 font-technical text-secondary whitespace-nowrap">{formatDateTime(row.packing_time)}</td>
                        <td className="p-4">
                          {row.drive_link ? (
                            <a href={row.drive_link} target="_blank" rel="noreferrer" className="text-primary hover:underline font-body-sm text-body-sm">Open video</a>
                          ) : (
                            <span className="text-secondary font-body-sm text-body-sm">-</span>
                          )}
                          {row.error && (
                            <div className="text-xs text-critical mt-1 max-w-[220px] truncate" title={row.error}>{row.error}</div>
                          )}
                        </td>
                        <td className="p-4"><StatusBadge status={String(row.status || 'pending')} /></td>
                        <td className="p-4 font-technical text-secondary whitespace-nowrap">{formatDateTime(row.requested_at)}</td>
                        <td className="p-4 font-technical text-secondary">
                          <span className="whitespace-nowrap">{formatDateTime(row.replied_at)}</span>
                          {row.reply_to && (
                            <div
                              className="text-xs font-body-sm max-w-[220px] truncate"
                              title={`To: ${row.reply_to}${row.reply_message_id ? `\nGmail ID: ${row.reply_message_id}` : ''}\nSubject: ${row.reply_subject || '-'}`}
                            >
                              to {row.reply_to}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
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
