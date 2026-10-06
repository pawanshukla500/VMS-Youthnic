import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getApiBaseUrl } from '../utils/apiBase';
import logo from '../assets/logo.png';

const API_URL = getApiBaseUrl();

interface SharedVideo {
  url: string;
  mimeType: string;
  video: {
    trackingId: string | null;
    orderId: string | null;
    marketplace: string | null;
    recordedAt: string | null;
    durationSeconds: number | null;
  };
}

// Public page behind "Copy public link" (/share/<token>). No login: it can
// only ever load the one video the link points to.
export default function PublicVideo() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<SharedVideo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/public/videos/${encodeURIComponent(token)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok || typeof body?.url !== 'string') {
        throw new Error(body?.error || 'This video link is not available');
      }
      setData(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This video link is not available');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    document.title = 'Packing video — PVMS';
    void load();
  }, [load]);

  const info = data?.video;
  const details: Array<[string, string | null | undefined]> = [
    ['Tracking ID', info?.trackingId],
    ['Order ID', info?.orderId],
    ['Marketplace', info?.marketplace],
    ['Recorded', info?.recordedAt ? new Date(info.recordedAt).toLocaleString() : null],
    ['Length', info?.durationSeconds ? `${Math.floor(info.durationSeconds / 60)}:${String(info.durationSeconds % 60).padStart(2, '0')} min` : null],
  ];

  return (
    <div className="min-h-screen bg-surface-bg flex flex-col">
      <header className="bg-surface-container-lowest border-b border-border-subtle px-4 sm:px-gutter py-3 flex items-center gap-3">
        <div className="w-9 h-9 bg-primary-fixed rounded flex items-center justify-center shrink-0 overflow-hidden">
          <img src={logo} alt="PVMS" className="w-full h-full object-contain p-1" />
        </div>
        <div className="min-w-0">
          <h1 className="font-headline-2 text-headline-2 text-on-background">Packing video</h1>
          <p className="font-body-sm text-body-sm text-secondary">Shared from the Youthnic packing video system</p>
        </div>
      </header>

      <main className="flex-1 w-full max-w-5xl mx-auto p-4 sm:p-gutter flex flex-col gap-4">
        <div className="w-full aspect-video bg-black rounded-lg overflow-hidden relative shadow-sm">
          {data ? (
            <video
              key={data.url}
              src={data.url}
              controls
              playsInline
              className="w-full h-full object-contain"
              // Signed URLs expire after a few minutes: fetch a fresh one.
              onError={() => void load()}
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white text-center px-6">
              {loading ? (
                <>
                  <span role="status" aria-label="Loading video" className="inline-block w-9 h-9 rounded-full border-4 border-white/80 border-t-transparent animate-spin" />
                  <span>Loading video…</span>
                </>
              ) : (
                <>
                  <p className="font-headline-2 text-headline-2">Video unavailable</p>
                  <p className="font-body-sm text-body-sm text-white/80 max-w-md">{error}</p>
                </>
              )}
            </div>
          )}
        </div>

        {data && (
          <section className="bg-surface-card rounded-lg border border-border-subtle shadow-sm p-4 sm:p-5">
            <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3">
              {details.filter(([, value]) => Boolean(value)).map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="font-metadata text-metadata text-secondary uppercase tracking-wider">{label}</dt>
                  <dd className="font-technical text-body-sm text-on-surface break-all">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <a
                href={data.url}
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 rounded-lg bg-primary text-on-primary font-medium hover:bg-primary/90"
              >
                Open video file
              </a>
              <button
                type="button"
                onClick={() => void load()}
                className="px-4 py-2 rounded-lg border border-border-heavy bg-surface-card text-on-surface font-medium hover:bg-surface-container"
              >
                Reload
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
