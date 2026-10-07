// Meesho flyer link-up switch (admin): ON / OFF, or skip just today.
// Flyer bags are ALWAYS saved with the video against the tracking id; this
// only decides whether the companion app links them on Meesho.
import { useState } from 'react';
import useSWR from 'swr';
import toast from 'react-hot-toast';
import { authFetch } from '../utils/authFetch';
import { getApiBaseUrl } from '../utils/apiBase';

const API_URL = getApiBaseUrl();

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Failed to load the flyer link-up setting');
  return body;
};

export interface FlyerLinkupState {
  enabled: boolean;
  skipDate: string | null;
  skippedToday: boolean;
  active: boolean;
  today: string;
  changedAt: string | null;
}

function prettyDay(day: string | null | undefined): string {
  if (!day) return '';
  const date = new Date(`${day}T00:00:00+05:30`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
}

export function linkupSummary(state: FlyerLinkupState | null | undefined): { tone: 'on' | 'off' | 'skip'; title: string; detail: string } {
  if (!state) return { tone: 'on', title: 'Loading…', detail: '' };
  if (!state.enabled) {
    return {
      tone: 'off',
      title: 'Flyer link-up is OFF',
      detail: 'Flyer bags are still scanned and saved with each video against its tracking ID, but they are NOT linked on Meesho. Scans made while OFF stay "Not linked" (you can still queue one by hand on the Meesho Flyer page).',
    };
  }
  if (state.skippedToday) {
    return {
      tone: 'skip',
      title: `Link-up skipped for today (${prettyDay(state.today)})`,
      detail: "Today's flyer bags are saved with the videos but not linked on Meesho. Link-up turns back on by itself tomorrow.",
    };
  }
  return {
    tone: 'on',
    title: 'Flyer link-up is ON',
    detail: 'The Meesho companion app links each saved flyer bag to its tracking ID on Meesho.',
  };
}

export function FlyerLinkupCard({ canEdit, onChanged }: { canEdit: boolean; onChanged?: () => void }) {
  const { data, error, mutate } = useSWR<FlyerLinkupState>(`${API_URL}/api/meesho/flyer-linkup`, fetcher, {
    refreshInterval: 60_000,
  });
  const [busy, setBusy] = useState(false);
  const summary = linkupSummary(data);

  const change = async (body: { enabled?: boolean; skipToday?: boolean }) => {
    setBusy(true);
    try {
      const res = await authFetch(`${API_URL}/api/meesho/flyer-linkup`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || `Failed with status ${res.status}`);
      if (body.skipToday === true) {
        toast.success(`Link-up skipped for today${result.skipped ? ` (${result.skipped} waiting flyer${result.skipped === 1 ? '' : 's'} held)` : ''}. Flyers are still saved with the videos.`);
      } else if (body.skipToday === false) {
        toast.success(`Link-up resumed for today${result.requeued ? ` (${result.requeued} flyer${result.requeued === 1 ? '' : 's'} back in the queue)` : ''}.`);
      } else if (body.enabled === false) {
        toast.success('Flyer link-up OFF: flyers are saved with the videos only.');
      } else {
        toast.success('Flyer link-up ON: the companion app links new flyer bags on Meesho.');
      }
      await mutate();
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save the flyer link-up setting');
    } finally {
      setBusy(false);
    }
  };

  const toneClass = summary.tone === 'on'
    ? 'bg-success/5 border-success/30'
    : summary.tone === 'skip'
      ? 'bg-amber-500/5 border-amber-500/30'
      : 'bg-critical/5 border-critical/30';
  const iconClass = summary.tone === 'on' ? 'text-success' : summary.tone === 'skip' ? 'text-amber-700' : 'text-critical';
  const enabled = data ? data.enabled : true;

  return (
    <section className={`rounded-lg border p-4 shadow-sm flex flex-col lg:flex-row lg:items-center justify-between gap-4 ${toneClass}`} aria-live="polite">
      <div className="flex items-start gap-3 min-w-0">
        <span className={`material-symbols-outlined text-2xl ${iconClass}`} aria-hidden="true">
          {summary.tone === 'on' ? 'link' : summary.tone === 'skip' ? 'event_busy' : 'link_off'}
        </span>
        <div className="min-w-0">
          <p className="font-headline-2 text-base font-semibold text-on-surface">{error ? 'Flyer link-up' : summary.title}</p>
          <p className="font-body-sm text-body-sm text-secondary">
            {error ? 'Could not load the link-up setting.' : summary.detail}
          </p>
          {!canEdit && data && (
            <p className="font-metadata text-metadata text-secondary mt-1">Only an admin can change this (Settings).</p>
          )}
        </div>
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-3 shrink-0">
          {enabled && (
            <button
              type="button"
              onClick={() => change({ skipToday: !data?.skippedToday })}
              disabled={busy || !data}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold border disabled:opacity-50 disabled:cursor-not-allowed ${
                data?.skippedToday
                  ? 'bg-surface-card border-border-heavy text-on-surface hover:bg-surface-container'
                  : 'bg-amber-500/10 border-amber-500/40 text-amber-800 hover:bg-amber-500/20'
              }`}
              title={data?.skippedToday ? "Send today's held flyers to Meesho again" : "Save today's flyers with the videos without linking them on Meesho"}
            >
              <span className="material-symbols-outlined text-sm" aria-hidden="true">{data?.skippedToday ? 'play_arrow' : 'event_busy'}</span>
              {data?.skippedToday ? 'Resume today' : 'Skip today'}
            </button>
          )}
          <div className="flex items-center gap-2">
            <span className="font-body-sm text-body-sm text-on-surface font-medium">{enabled ? 'Link-up ON' : 'Link-up OFF'}</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label="Meesho flyer link-up"
              onClick={() => change({ enabled: !enabled })}
              disabled={busy || !data}
              className={`relative w-12 h-7 rounded-full transition-colors disabled:opacity-50 ${enabled ? 'bg-success' : 'bg-surface-container-high border border-outline-variant'}`}
            >
              <span className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow transition-all ${enabled ? 'left-6' : 'left-1'}`} />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
